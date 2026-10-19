// Cloudflare Worker for the live translator.
// GET /           -> serves the translator page (fetched from GitHub, so page updates need no redeploy here)
// POST /translate -> sends one fragment to Claude using the ANTHROPIC_API_KEY secret, guarded by the APP_PIN secret
//
// Secrets to add in Settings -> Variables and Secrets: ANTHROPIC_API_KEY, APP_PIN

const PAGE_URL = "https://raw.githubusercontent.com/qrom66/jadwali-legal/main/translator/index.html";
const MODEL = "claude-haiku-5-5";
const MAX_CHARS = 6000;

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === "/translate" && request.method === "POST") return translate(request, env);
    if (url.pathname === "/" || url.pathname === "/index.html") return page();
    return new Response("Not found", { status: 404 });
  },
};

async function page() {
  const r = await fetch(PAGE_URL, { cf: { cacheTtl: 60, cacheEverything: true } });
  if (!r.ok) return new Response("Could not load the page, try again in a minute.", { status: 502 });
  const html = (await r.text()).replace("<head>", '<head><script>window.TRANSLATE_PROXY = "/translate";</script>');
  return new Response(html, { headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-cache" } });
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json" } });
}

async function translate(request, env) {
  let body;
  try { body = await request.json(); } catch { return json({ error: "bad_request" }, 400); }
  const { pin, system, content } = body || {};
  if (!env.APP_PIN || !env.ANTHROPIC_API_KEY) return json({ error: "not_configured" }, 500);
  if (typeof pin !== "string" || pin !== env.APP_PIN) return json({ error: "bad_pin" }, 401);
  if (typeof system !== "string" || typeof content !== "string" || system.length + content.length > MAX_CHARS)
    return json({ error: "bad_request" }, 400);

  const r = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "x-api-key": env.ANTHROPIC_API_KEY,
      "anthropic-version": "2023-06-01",
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: 2000,
      thinking: { type: "adaptive" },
      output_config: { effort: "low" },
      system,
      messages: [{ role: "user", content }],
    }),
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) return json({ error: "claude_error", status: r.status, message: data?.error?.message || "" }, r.status === 401 ? 502 : r.status);
  const text = (data.content || []).filter(b => b.type === "text").map(b => b.text).join("").trim();
  if (!text) return json({ error: "empty" }, 502);
  return json({ text });
}
