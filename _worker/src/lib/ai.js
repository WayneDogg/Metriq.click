// Optional AI write-up. Runs only when ANTHROPIC_API_KEY is set; otherwise the
// results page falls back to the rule-based fixes, so the tool never breaks.
const SYSTEM = `You write the personalized summary on METRIQ's Agent-Ready Scanner results page.
METRIQ is Wayne Shirreffs' acquisition strategy firm for the AI-native economy. Personal AI agents
(from Meta, OpenAI, Anthropic, Perplexity and others) now research, compare and buy on behalf of people.
A business wins those orders by being clear, readable and easy for a machine to transact with.

You get the scan results for one business website plus a snippet of its homepage text.
Write to the business owner as "you". Tone: a seasoned direct response marketer talking to an operator.
Plain, direct, a little blunt, never hypey. Short sentences. No em dashes. No jargon like "leverage",
"unlock", "seamless", "robust". Do not invent facts that aren't in the data. Refer to what their site
actually sells when the homepage text makes that clear.

Return ONLY valid JSON with this shape:
{"headline": "one sentence, max 14 words, the single biggest takeaway for this site",
 "summary": "2-3 sentences on how an AI agent would experience this site today",
 "fixes": [{"title": "short imperative, max 8 words", "why": "1-2 sentences specific to this site"}]}
Give exactly 3 fixes, highest impact first, drawn from the checks that did not pass.
If everything passed, give 3 ways to stay ahead instead.`;

export async function aiWriteup(result, env = {}) {
  const key = env.ANTHROPIC_API_KEY;
  if (!key) return null;
  const payload = {
    site: result.host,
    score: result.score,
    tier: result.tier,
    checks: result.checks.map(({ label, status, found }) => ({ label, status, found })),
    homepage: result.context,
  };
  try {
    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      signal: AbortSignal.timeout(20000),
      headers: {
        "content-type": "application/json",
        "x-api-key": key,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: env.ANTHROPIC_MODEL || "claude-haiku-4-5-20251001",
        max_tokens: 800,
        system: SYSTEM,
        messages: [{ role: "user", content: JSON.stringify(payload) }],
      }),
    });
    if (!res.ok) {
      console.error("AI write-up failed", res.status, (await res.text()).slice(0, 300));
      return null;
    }
    const data = await res.json();
    const raw = (data.content || []).map((b) => b.text || "").join("");
    const json = JSON.parse(raw.slice(raw.indexOf("{"), raw.lastIndexOf("}") + 1));
    if (!json.headline || !Array.isArray(json.fixes)) return null;
    const clean = (s) => String(s || "").replace(/\s*[—–]\s*/g, ", ").trim();
    return {
      headline: clean(json.headline),
      summary: clean(json.summary),
      fixes: json.fixes.slice(0, 3).map((f) => ({ title: clean(f.title), why: clean(f.why) })),
    };
  } catch (e) {
    console.error("AI write-up error", e?.message);
    return null;
  }
}

// Used when AI is off or fails: the 3 checks that lost the most points.
export function ruleFixes(result) {
  return result.checks
    .filter((c) => c.status !== "pass")
    .sort((a, b) => b.max - b.points - (a.max - a.points))
    .slice(0, 3)
    .map((c) => ({ title: c.label, why: c.fix }));
}
