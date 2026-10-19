// Cloudflare Worker for the live translator.
// GET /           -> serves the translator page (fetched from GitHub, so page updates need no redeploy here)
// POST /translate  -> sends one fragment to Claude using the ANTHROPIC_API_KEY secret, guarded by the APP_PIN secret
// POST /transcribe -> turns a short WAV clip into text with Whisper on Workers AI (used on iPhone / Safari)
//
// Secrets to add in Settings -> Variables and Secrets: ANTHROPIC_API_KEY, APP_PIN
// wrangler.toml also needs the Workers AI binding:  [ai]  binding = "AI"

const PAGE_URL = "https://raw.githubusercontent.com/qrom66/jadwali-legal/main/translator/index.html";
const MODEL = "claude-haiku-5-5";
const MAX_CHARS = 6000;
const WHISPER = "@cf/openai/whisper-large-v3-turbo";
const MAX_AUDIO_B64 = 1_500_000;   // about 30 s of 16 kHz mono WAV

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === "/translate" && request.method === "POST") return translate(request, env);
    if (url.pathname === "/transcribe" && request.method === "POST") return transcribe(request, env);
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

async function transcribe(request, env) {
  let body;
  try { body = await request.json(); } catch { return json({ error: "bad_request" }, 400); }
  const { pin, audio, language } = body || {};
  if (!env.APP_PIN || !env.AI) return json({ error: "not_configured" }, 500);
  if (typeof pin !== "string" || pin !== env.APP_PIN) return json({ error: "bad_pin" }, 401);
  if (typeof audio !== "string" || audio.length > MAX_AUDIO_B64) return json({ error: "bad_request" }, 400);
  try {
    const out = await env.AI.run(WHISPER, { audio, language: language === "ar" ? "ar" : "en", vad_filter: true });
    return json({ text: (out && out.text) || "" });
  } catch (e) {
    return json({ error: "whisper_error", message: String(e && e.message || e) }, 502);
  }
}
