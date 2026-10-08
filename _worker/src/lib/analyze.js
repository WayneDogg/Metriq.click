// Rule-based Agent-Ready checks. Every check reports what it actually found
// on the site, so the results page never shows a claim the scan can't back up.
import { load as cheerioLoad } from "cheerio/slim";
import { fetchPage, normalizeUrl, ScanError } from "./fetch-safe.js";

const PRICE_RE = /(?:[$€£]\s?\d[\d,]*(?:\.\d{1,2})?(?:\s?\/\s?(?:mo|month|yr|year|hr|hour))?|\b\d[\d,]*(?:\.\d{2})?\s?(?:USD|dollars)\b)/gi;
const GATE_RE = /\b(call (?:us )?for (?:a )?(?:quote|pricing|price)|contact (?:us|sales) (?:for|to get) (?:pricing|a quote|a price)|request (?:a )?(?:quote|pricing)|get (?:a )?(?:free )?quote|pricing (?:available )?(?:upon|on) request|talk to sales|book a demo|schedule a demo|request a demo)\b/gi;

const LINK_KINDS = {
  pricing: /(pricing|price|plans|packages|rates|menu|cost)/i,
  policy: /(return|refund|cancel|shipping|exchange|warranty|guarantee)/i,
  terms: /(terms|policies|policy)/i,
  faq: /(faq|frequently|questions|help-?center|support\b|\/help\b)/i,
  reviews: /(review|testimonial|case-stud|success-stor)/i,
  action: /(cart|checkout|shop\b|\/shop|buy|book|schedule|appointment|order|get-?started|sign-?up|start|subscribe|reserve|enroll|quote-?tool)/i,
};

const BUSINESS_TYPES = /^(organization|corporation|localbusiness|.*store|.*business|.*service|professionalservice|medicalbusiness|homeandconstructionbusiness|restaurant|.*shop|hairsalon|barbershop|beautysalon|dentist|legalservice|accountingservice|financialservice|automotivebusiness|lodgingbusiness|healthandbeautybusiness)$/i;
const COMMERCE_TYPES = /^(product|productgroup|offer|aggregateoffer|service|offercatalog|menu|softwareapplication|course|event)$/i;

const AGENT_BOTS = {
  "ChatGPT-User": "user", "OAI-SearchBot": "search", "Claude-User": "user", "Claude-SearchBot": "search",
  "PerplexityBot": "search", "Perplexity-User": "user",
  "GPTBot": "training", "ClaudeBot": "training", "Google-Extended": "training", "CCBot": "training", "Applebot-Extended": "training",
};

// Space out tags so "Pricing</a><p>Call" doesn't read as one word.
const load = (html) => cheerioLoad(html.replace(/</g, " <"));

function visibleText($) {
  const c = $.root().clone();
  c.find("script,style,noscript,svg,template,iframe").remove();
  return c.find("body").text().replace(/\s+/g, " ").trim() || c.text().replace(/\s+/g, " ").trim();
}

function jsonLdTypes($) {
  const types = [];
  const nodes = [];
  $('script[type="application/ld+json"]').each((_, el) => {
    try {
      const data = JSON.parse($(el).contents().text());
      const walk = (n) => {
        if (!n || typeof n !== "object") return;
        if (Array.isArray(n)) return n.forEach(walk);
        if (n["@type"]) {
          [].concat(n["@type"]).forEach((t) => types.push(String(t)));
          nodes.push(n);
        }
        if (n["@graph"]) walk(n["@graph"]);
        for (const k of ["offers", "mainEntity", "review", "aggregateRating", "itemListElement", "hasOfferCatalog"]) walk(n[k]);
      };
      walk(data);
    } catch { /* malformed JSON-LD is common; ignore it */ }
  });
  $("[itemtype]").each((_, el) => {
    const t = ($(el).attr("itemtype") || "").split("/").pop();
    if (t) types.push(t);
  });
  return { types: [...new Set(types)], nodes };
}

function collectLinks($, base) {
  const out = [];
  const host = base.hostname.replace(/^www\./, "");
  $("a[href]").each((_, el) => {
    const href = $(el).attr("href") || "";
    if (/^(mailto|tel|javascript|#)/i.test(href)) return;
    let u;
    try { u = new URL(href, base); } catch { return; }
    const text = $(el).text().replace(/\s+/g, " ").trim().slice(0, 80);
    const internal = u.hostname.replace(/^www\./, "") === host;
    out.push({ url: u.href, path: u.pathname + u.search, text, internal });
  });
  return out;
}

function findLink(links, kind, { internalOnly = true } = {}) {
  const re = LINK_KINDS[kind];
  return links.find((l) => (!internalOnly || l.internal) && (re.test(l.path) || re.test(l.text)));
}

function parseRobots(txt) {
  const groups = [];
  let cur = null, lastWasAgent = false;
  for (const raw of txt.split(/\r?\n/)) {
    const line = raw.replace(/#.*/, "").trim();
    const m = line.match(/^([A-Za-z-]+)\s*:\s*(.*)$/);
    if (!m) continue;
    const key = m[1].toLowerCase(), val = m[2].trim();
    if (key === "user-agent") {
      if (!lastWasAgent || !cur) { cur = { agents: [], rules: [] }; groups.push(cur); }
      cur.agents.push(val.toLowerCase());
      lastWasAgent = true;
    } else {
      lastWasAgent = false;
      if (cur && (key === "allow" || key === "disallow")) cur.rules.push({ type: key, path: val });
    }
  }
  return groups;
}

function blocksRoot(groups, bot) {
  const b = bot.toLowerCase();
  const specific = groups.filter((g) => g.agents.some((a) => a !== "*" && b.includes(a)));
  const applicable = specific.length ? specific : groups.filter((g) => g.agents.includes("*"));
  const rules = applicable.flatMap((g) => g.rules);
  const disallowAll = rules.some((r) => r.type === "disallow" && (r.path === "/" || r.path === "/*"));
  const allowRoot = rules.some((r) => r.type === "allow" && (r.path === "/" || r.path === "/*" || r.path === "/$"));
  return disallowAll && !allowRoot;
}

const check = (id, label, max, status, found, fix) => ({
  id, label, max, status, found, fix,
  points: status === "pass" ? max : status === "partial" ? Math.round(max / 2) : 0,
});

export async function analyze(input) {
  const start = normalizeUrl(input);
  const home = await fetchPage(start);
  if (!home.ok || !home.text) {
    const challenge = /just a moment|cf-chl|captcha|access denied|attention required/i.test(home.text || "");
    if (home.status === 403 || home.status === 429 || home.status === 503 || challenge)
      throw new ScanError("blocked", "Your site turned our scanner away at the door. That usually means a firewall or bot shield is also turning away the AI agents your customers send. That's finding #1.");
    if (home.error === "timeout") throw new ScanError("timeout", "Your site took too long to respond. Agents give up fast too.");
    throw new ScanError("unreachable", `We couldn't load ${start.hostname} (status ${home.status || "no response"}). Check the address and try again.`);
  }

  const base = new URL(home.url);
  const $ = load(home.text);
  const text = visibleText($);
  const links = collectLinks($, base);
  const ld = jsonLdTypes($);

  // Pull the pages an agent would check next.
  const pricingLink = findLink(links, "pricing");
  const targets = {
    pricing: pricingLink && !/contact|quote|call/i.test(pricingLink.text + pricingLink.path) ? pricingLink : null,
    policy: findLink(links, "policy") || findLink(links, "terms"),
    faq: findLink(links, "faq"),
  };
  const origin = base.origin;
  const [robots, llms, ...sub] = await Promise.all([
    fetchPage(new URL("/robots.txt", origin), { timeoutMs: 6000 }).catch(() => null),
    fetchPage(new URL("/llms.txt", origin), { timeoutMs: 6000 }).catch(() => null),
    ...Object.values(targets).map((t) => (t ? fetchPage(new URL(t.url), { timeoutMs: 7000 }).catch(() => null) : null)),
  ]);
  const subPages = {};
  Object.keys(targets).forEach((k, i) => {
    const r = sub[i];
    if (r && r.ok && r.text) {
      const $$ = load(r.text);
      subPages[k] = { url: r.url, text: visibleText($$), ld: jsonLdTypes($$) };
    }
  });

  const allTypes = [...new Set([...ld.types, ...Object.values(subPages).flatMap((p) => p.ld.types)])];
  const lowerTypes = allTypes.map((t) => t.toLowerCase());
  const has = (re) => lowerTypes.some((t) => re.test(t));
  const checks = [];

  // 1. Pricing
  {
    const homePrices = text.match(PRICE_RE) || [];
    const pricePagePrices = subPages.pricing ? subPages.pricing.text.match(PRICE_RE) || [] : [];
    const schemaPrice = ld.nodes.some((n) => n.price || n.lowPrice || n.offers?.price) || $('meta[property="product:price:amount"]').length > 0;
    const gates = [...new Set([...(text.match(GATE_RE) || []), ...((subPages.pricing?.text.match(GATE_RE)) || [])].map((s) => s.toLowerCase()))];
    const found = homePrices.length + pricePagePrices.length;
    if (found >= 1 || schemaPrice)
      checks.push(check("pricing", "Pricing is visible in plain numbers", 14, gates.length ? "partial" : "pass",
        `Found ${found} price${found === 1 ? "" : "s"} an agent can read${pricePagePrices.length ? " on your pricing page" : " on your homepage"}${schemaPrice ? ", plus price data in your page code" : ""}.${gates.length ? ` But we also saw "${gates[0]}", which sends agents to a dead end.` : ""}`,
        gates.length ? `Keep the prices, and replace "${gates[0]}" with a self-serve next step wherever you can.` : "Keep it up. Make sure every main offer has a price, not just one."));
    else if (targets.pricing)
      checks.push(check("pricing", "Pricing is visible in plain numbers", 14, "partial",
        `You have a pricing link ("${targets.pricing.text || targets.pricing.path}"), but we couldn't read any actual prices on it.${gates.length ? ` We saw "${gates[0]}".` : " The numbers may load with JavaScript or live in an image."}`,
        "Put real numbers on the page as plain text. Even a starting-at price beats nothing."));
    else
      checks.push(check("pricing", "Pricing is visible in plain numbers", 14, "fail",
        gates.length ? `No prices found. Instead we saw "${gates[0]}". An agent can't call you, so it compares the competitors who show a number.` : "We couldn't find a single price or a pricing page.",
        "Add a pricing page, or at least starting-at prices on your main offers."));
  }

  // 2. Return / refund / cancellation policy
  {
    const t = targets.policy, p = subPages.policy;
    if (t && p && p.text.length > 400 && LINK_KINDS.policy.test(t.path + " " + t.text))
      checks.push(check("policy", "Return, refund & cancellation terms are easy to find", 10, "pass",
        `Found your "${t.text || t.path}" page and it has real content on it.`, "Make sure it reads in plain English, not legalese."));
    else if (t)
      checks.push(check("policy", "Return, refund & cancellation terms are easy to find", 10, "partial",
        `The closest thing we found is "${t.text || t.path}"${p ? "" : ", and we couldn't load it"}. ${LINK_KINDS.policy.test(t.path + " " + t.text) ? "" : "Agents look for returns, refunds or cancellation specifically."}`,
        "Give returns, refunds and cancellation 1 plain-language page and link it in your footer."));
    else
      checks.push(check("policy", "Return, refund & cancellation terms are easy to find", 10, "fail",
        "No returns, refund, cancellation or terms link anywhere on your homepage.", "Add a plain-language policy page and link it in your footer. Agents check this before they buy for someone."));
  }

  // 3. Clear offer
  {
    const title = $("title").first().text().trim();
    const desc = ($('meta[name="description"]').attr("content") || "").trim();
    const h1s = $("h1").map((_, el) => $(el).text().replace(/\s+/g, " ").trim()).get().filter(Boolean);
    const okTitle = title.length >= 10 && title.length <= 80;
    const okDesc = desc.length >= 50;
    const okH1 = h1s.length >= 1;
    const n = [okTitle, okDesc, okH1].filter(Boolean).length;
    const missing = [!okTitle && "a clear page title", !okDesc && "a meta description", !okH1 && "a main headline (H1)"].filter(Boolean);
    checks.push(check("clarity", "Your homepage says what you sell, plainly", 10, n === 3 ? "pass" : n === 2 ? "partial" : "fail",
      `${okH1 ? `Main headline: "${h1s[0].slice(0, 90)}".` : "No main headline (H1) on the page."} ${okDesc ? "Meta description is set." : "No usable meta description."}`,
      missing.length ? `Add ${missing.join(" and ")}. Then check that your headline says what you sell & who it's for, not a slogan.` : "Read your headline cold. If a stranger can't tell what you sell & who it's for, rewrite it."));
  }

  // 4. Structured data
  {
    const valuable = allTypes.filter((t) => BUSINESS_TYPES.test(t) || COMMERCE_TYPES.test(t) || /^(faqpage|review|aggregaterating)$/i.test(t));
    const status = valuable.length >= 2 ? "pass" : valuable.length === 1 || allTypes.length ? "partial" : "fail";
    checks.push(check("schema", "Key pages carry structured data", 12, status,
      allTypes.length ? `Found these data types in your page code: ${allTypes.slice(0, 8).join(", ")}.` : "No structured data (schema markup) found at all.",
      status === "pass" ? "Good. Add Product/Offer or Service data to every offer page if you haven't." : "Add schema markup for your business, your offers (Product/Offer or Service) and your FAQ. Most platforms do this with a plugin or app."));
  }

  // 5. Readable without JavaScript
  {
    const len = text.length;
    const shell = $("#root, #__next, #app, [data-reactroot]").length > 0;
    const status = len >= 1500 ? "pass" : len >= 600 ? "partial" : "fail";
    checks.push(check("readable", "Your content loads as text, not just JavaScript", 12, status,
      `An agent reading your raw page gets about ${len.toLocaleString()} characters of text${status === "fail" && shell ? ". The page looks like an app shell that fills in with JavaScript" : ""}.`,
      status === "pass" ? "Nothing to fix here." : "Make sure your key content is server-rendered. Many agents read the raw page and won't wait for scripts to run."));
  }

  // 6. Self-serve path
  {
    const actions = links.filter((l) => LINK_KINDS.action.test(l.path) || LINK_KINDS.action.test(l.text));
    const gates = [...new Set((text.match(GATE_RE) || []).map((s) => s.toLowerCase()))];
    const status = actions.length && !gates.length ? "pass" : actions.length ? "partial" : gates.length ? "fail" : "partial";
    const ex = actions.slice(0, 3).map((a) => `"${a.text || a.path}"`).join(", ");
    checks.push(check("selfserve", "Someone can buy or book without a phone call", 10, status,
      actions.length ? `Found self-serve actions like ${ex}.${gates.length ? ` We also found "${gates[0]}", a step agents route around.` : ""}` : gates.length ? `The main next step is "${gates[0]}". There's no way to buy or book on your own.` : "We couldn't find a buy, book, order or sign-up path from your homepage.",
      status === "pass" ? "Keep the path short. Every extra form field is friction." : "Give people (and their agents) a way to buy, book or start without talking to anyone first."));
  }

  // 7. AI agents allowed in robots.txt
  {
    const txt = robots && robots.ok ? robots.text : "";
    const groups = txt ? parseRobots(txt) : [];
    const blocked = Object.keys(AGENT_BOTS).filter((b) => groups.length && blocksRoot(groups, b));
    const blockedUser = blocked.filter((b) => AGENT_BOTS[b] !== "training");
    const status = blockedUser.length ? "fail" : blocked.length ? "partial" : "pass";
    checks.push(check("robots", "AI agents are allowed in the door", 12, status,
      !txt ? "No robots.txt file, so agents are allowed by default." : blocked.length ? `Your robots.txt blocks: ${blocked.join(", ")}.` : "Your robots.txt lets the major AI agents in.",
      blockedUser.length ? "You're blocking the agents that shop and search for real customers. Remove those blocks unless you have a legal reason." : blocked.length ? "You only block AI training crawlers, which is a fair call. Customer-facing agents can still get in." : "Nothing to fix here."));
  }

  // 8. FAQ
  {
    const faqSchema = has(/^faqpage$/);
    const faqQs = subPages.faq ? (subPages.faq.text.match(/\?/g) || []).length : 0;
    const homeQs = (text.match(/\b(how|what|do|does|can|is|are|when|where|why)\b[^?.!]{8,120}\?/gi) || []).length;
    const status = faqSchema || faqQs >= 4 ? "pass" : targets.faq || homeQs >= 3 ? "partial" : "fail";
    checks.push(check("faq", "An FAQ answers the boring questions", 7, status,
      faqSchema ? "Found FAQ structured data. Agents can read your Q&A directly." : faqQs >= 4 ? `Your FAQ page answers about ${faqQs} questions.` : targets.faq ? `Found a "${targets.faq.text || targets.faq.path}" link, but not much Q&A we could read.` : homeQs >= 3 ? "A few questions on the homepage, but no dedicated FAQ." : "No FAQ found.",
      status === "pass" ? "Make sure it covers shipping, timelines, warranty, contract length and service area." : "Build an FAQ with the boring stuff: shipping, timelines, warranty, minimums, contract length, service area. That's exactly what agents are sent to find."));
  }

  // 9. Reviews / proof as text
  {
    const schemaReviews = has(/^(review|aggregaterating)$/);
    const textProof = /\b(reviews?|testimonials?|rated|stars?|case stud(y|ies)|clients say|customers say)\b/i.test(text);
    const reviewLink = findLink(links, "reviews", { internalOnly: false });
    const status = schemaReviews ? "pass" : textProof || reviewLink ? "partial" : "fail";
    checks.push(check("proof", "Reviews & proof are readable text", 7, status,
      schemaReviews ? "Found review or rating data in your page code." : textProof ? "We see review or testimonial language, but no rating data a machine can read." : reviewLink ? `There's a "${reviewLink.text || reviewLink.path}" link, but no proof on the page itself.` : "We couldn't find any reviews or testimonials as text.",
      schemaReviews ? "Nothing to fix here." : "Put real reviews on the page as text (not baked into images or videos) and add rating markup."));
  }

  // 10. Business info
  {
    const bizNode = ld.nodes.find((n) => [].concat(n["@type"]).some((t) => BUSINESS_TYPES.test(String(t))));
    const rich = bizNode && bizNode.name && (bizNode.telephone || bizNode.address || bizNode.contactPoint || bizNode.sameAs);
    const phoneOrAddr = /(\(?\d{3}\)?[\s.-]\d{3}[\s.-]\d{4})|(\d{2,5}\s+\w+(\s\w+)*\s(st|street|ave|avenue|rd|road|blvd|boulevard|dr|drive|way|ln|lane)\b)/i.test(text);
    const status = rich ? "pass" : bizNode || phoneOrAddr ? "partial" : "fail";
    checks.push(check("business", "Business details are machine-readable", 6, status,
      rich ? `Your page code names the business ("${String(bizNode.name).slice(0, 60)}") with contact details.` : bizNode ? "Your page code names the business but leaves out contact details." : phoneOrAddr ? "Your contact details are on the page as text, but not in structured data." : "We couldn't find your business details in a form an agent can read.",
      rich ? "Make sure these match your Google profile and directories exactly." : "Add Organization or LocalBusiness data with your name, phone, address and social profiles. Then make it match everywhere else you're listed."));
  }

  const score = checks.reduce((s, c) => s + c.points, 0);
  const tier = score >= 71 ? "ready" : score >= 41 ? "findable" : "invisible";
  return {
    url: base.href,
    host: base.hostname.replace(/^www\./, ""),
    scannedAt: new Date().toISOString(),
    score,
    tier,
    checks,
    extras: {
      llmsTxt: !!(llms && llms.ok && llms.text && !/<html/i.test(llms.text.slice(0, 500))),
      pagesRead: 1 + Object.keys(subPages).length,
    },
    context: {
      title: $("title").first().text().trim().slice(0, 200),
      description: ($('meta[name="description"]').attr("content") || "").slice(0, 300),
      h1: $("h1").first().text().replace(/\s+/g, " ").trim().slice(0, 200),
      text: text.slice(0, 2500),
    },
  };
}

export { ScanError };
