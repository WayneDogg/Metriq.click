// Fetches a public web page from the server without letting anyone use the
// scanner to reach private networks (localhost, cloud metadata, office LANs).
// Runs on Cloudflare Workers. Cloudflare itself refuses Worker requests to
// private networks, and we also reject private IP addresses typed in directly.
let allowPrivate = false;
export function configure(opts = {}) { allowPrivate = !!opts.allowPrivate; }

const isIPv4 = (h) => /^\d{1,3}(\.\d{1,3}){3}$/.test(h);
const isIPv6 = (h) => h.includes(":");

const UA =
  "Mozilla/5.0 (compatible; METRIQ-AgentReady/1.0; +https://metriq.click/agent-ready/)";
const MAX_BYTES = 2_500_000;
const MAX_REDIRECTS = 5;

function isPrivateIp(ip) {
  if (isIPv4(ip)) {
    const [a, b] = ip.split(".").map(Number);
    return (
      a === 0 || a === 10 || a === 127 ||
      (a === 100 && b >= 64 && b <= 127) || // carrier NAT
      (a === 169 && b === 254) || // link-local / cloud metadata
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 198 && (b === 18 || b === 19)) ||
      a >= 224
    );
  }
  const v = ip.toLowerCase();
  if (v.startsWith("::ffff:")) return isPrivateIp(v.slice(7));
  return (
    v === "::" || v === "::1" ||
    v.startsWith("fc") || v.startsWith("fd") || // unique local
    v.startsWith("fe8") || v.startsWith("fe9") || v.startsWith("fea") || v.startsWith("feb")
  );
}

export class ScanError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

export function normalizeUrl(input) {
  let raw = String(input || "").trim();
  if (!raw) throw new ScanError("bad_url", "Enter your website address.");
  if (!/^https?:\/\//i.test(raw)) raw = "https://" + raw;
  let u;
  try {
    u = new URL(raw);
  } catch {
    throw new ScanError("bad_url", "That doesn't look like a website address.");
  }
  if (!["http:", "https:"].includes(u.protocol) || u.username || u.password)
    throw new ScanError("bad_url", "That doesn't look like a website address.");
  if (u.port && !["80", "443"].includes(u.port) && !allowPrivate)
    throw new ScanError("bad_url", "Only standard web addresses can be scanned.");
  if (!u.hostname.includes(".") && !allowPrivate)
    throw new ScanError("bad_url", "Include the full domain, like yourcompany.com.");
  u.hash = "";
  return u;
}

async function assertPublic(u) {
  if (allowPrivate) return; // local testing only
  const h = u.hostname.replace(/^\[|\]$/g, "").toLowerCase();
  if (h === "localhost" || h.endsWith(".localhost") || h.endsWith(".internal") || h.endsWith(".local") ||
      ((isIPv4(h) || isIPv6(h)) && isPrivateIp(h)))
    throw new ScanError("bad_url", "That address can't be scanned.");
}

async function readCapped(res) {
  const reader = res.body?.getReader();
  if (!reader) return "";
  const chunks = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.length;
    chunks.push(value);
    if (total > MAX_BYTES) {
      await reader.cancel();
      break;
    }
  }
  const all = new Uint8Array(Math.min(total, MAX_BYTES + 65536));
  let off = 0;
  for (const c of chunks) { if (off >= all.length) break; all.set(c.subarray(0, all.length - off), off); off += c.length; }
  return new TextDecoder("utf-8").decode(all.subarray(0, Math.min(off, all.length)));
}

// Returns { ok, status, url, text, contentType, ms } and never throws for HTTP errors.
export async function fetchPage(input, { timeoutMs = 9000 } = {}) {
  let u = typeof input === "string" ? normalizeUrl(input) : input;
  const started = Date.now();
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    await assertPublic(u);
    let res;
    try {
      res = await fetch(u, {
        redirect: "manual",
        signal: AbortSignal.timeout(timeoutMs),
        headers: {
          "user-agent": UA,
          accept: "text/html,application/xhtml+xml,text/plain;q=0.9,*/*;q=0.5",
          "accept-language": "en-US,en;q=0.9",
        },
      });
    } catch (e) {
      const timedOut = e?.name === "TimeoutError" || e?.name === "AbortError";
      return { ok: false, status: 0, url: u.href, text: "", contentType: "", ms: Date.now() - started, error: timedOut ? "timeout" : "network" };
    }
    if ([301, 302, 303, 307, 308].includes(res.status)) {
      const loc = res.headers.get("location");
      if (!loc) break;
      u = new URL(loc, u);
      if (!["http:", "https:"].includes(u.protocol)) break;
      continue;
    }
    const contentType = res.headers.get("content-type") || "";
    const text = /text|html|xml|json/i.test(contentType) || !contentType ? await readCapped(res) : "";
    return { ok: res.ok, status: res.status, url: u.href, text, contentType, ms: Date.now() - started, headers: res.headers };
  }
  return { ok: false, status: 0, url: u.href, text: "", contentType: "", ms: Date.now() - started, error: "redirects" };
}
