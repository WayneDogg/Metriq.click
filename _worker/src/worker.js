// Cloudflare Worker: the engine behind metriq.click/agent-ready/scan/
//   POST /agent-ready/api/scan    {url} -> scan results
//   GET  /agent-ready/api/config        -> booking link
// The pages themselves are static files in this repo, served by the main site.
import { analyze, ScanError } from "./lib/analyze.js";
import { aiWriteup, ruleFixes } from "./lib/ai.js";
import { configure } from "./lib/fetch-safe.js";

const ALLOWED_ORIGINS = ["https://metriq.click", "https://www.metriq.click"];
let corsOrigin = ALLOWED_ORIGINS[0];
const json = (data, status = 200, extra = {}) =>
  new Response(JSON.stringify(data), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8", "cache-control": "no-store", "x-robots-tag": "noindex",
      "access-control-allow-origin": corsOrigin, "access-control-allow-headers": "content-type",
      "access-control-allow-methods": "GET, POST, OPTIONS", vary: "origin", ...extra,
    },
  });

// Best-effort limit per Worker instance. Add a Cloudflare rate limiting rule
// for real protection (see README).
const hits = new Map();
function limited(ip, perHour) {
  const now = Date.now();
  const list = (hits.get(ip) || []).filter((t) => now - t < 3600_000);
  list.push(now);
  hits.set(ip, list);
  if (hits.size > 5000) hits.clear();
  return list.length > perHour;
}

async function handleScan(request, env) {
  if (request.method !== "POST") return json({ error: { code: "method", message: "Use POST." } }, 405, { allow: "POST" });
  const ip = request.headers.get("cf-connecting-ip") || "unknown";
  if (limited(ip, Number(env.SCAN_LIMIT_PER_HOUR || 20)))
    return json({ error: { code: "rate_limited", message: "That's a lot of scans. Give it an hour and try again." } }, 429);

  let body = {};
  try { body = await request.json(); } catch { /* handled as bad_url below */ }
  try {
    const result = await analyze(body?.url);
    const ai = await aiWriteup(result, env);
    const { context, ...publicResult } = result;
    console.log(JSON.stringify({ event: "scan", host: result.host, score: result.score, tier: result.tier, ai: !!ai }));
    return json({ ...publicResult, ai, fixes: ai?.fixes || ruleFixes(result) });
  } catch (e) {
    if (e instanceof ScanError) {
      console.log(JSON.stringify({ event: "scan_error", code: e.code, input: String(body?.url || "").slice(0, 120) }));
      return json({ error: { code: e.code, message: e.message } }, e.code === "bad_url" ? 400 : 422);
    }
    console.error("scan failed", e?.stack || e);
    return json({ error: { code: "server", message: "Something broke on our end. Try again in a minute." } }, 500);
  }
}

export default {
  async fetch(request, env) {
    configure({ allowPrivate: env.ALLOW_PRIVATE_HOSTS === "1" });
    const origin = request.headers.get("origin");
    corsOrigin = origin && ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0];
    const url = new URL(request.url);
    const path = url.pathname.replace(/\/+$/, "").replace(/^\/agent-ready/, "") || "/";
    if (request.method === "OPTIONS") return json({ ok: true });

    if (path === "/api/scan") return handleScan(request, env);
    if (path === "/api/config")
      return json({ bookingUrl: env.BOOKING_URL || "https://www.linkedin.com/in/wayneshirreffs/" }, 200, { "cache-control": "public, max-age=300" });

    return json({ error: { code: "not_found", message: "Not found." } }, 404);
  },
};
