// The announcer's voice for every browser and phone: the game sends a line of commentary, this function
// returns it spoken by a Microsoft neural voice (Azure Speech, free tier) as an MP3.
// Each line is synthesized once and kept in Netlify Blobs, so replays and repeats cost nothing.
// Set AZURE_SPEECH_KEY and AZURE_SPEECH_REGION in Netlify (Site configuration -> Environment variables).
// Optional: TTS_VOICE (default en-US-ChristopherNeural).
import { getStore } from "@netlify/blobs";

const VOICE = process.env.TTS_VOICE || "en-US-ChristopherNeural";
const MAX = 600;
const CORS = { "access-control-allow-origin": "*", "access-control-allow-methods": "GET, POST, OPTIONS", "access-control-allow-headers": "content-type" };
const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { ...CORS, "content-type": "application/json", "cache-control": "no-store" } });
const mp3 = (buf) => new Response(buf, { status: 200, headers: { ...CORS, "content-type": "audio/mpeg", "cache-control": "public, max-age=31536000, immutable" } });
const esc = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&apos;");
const hash = async (s) => Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s))), (b) => b.toString(16).padStart(2, "0")).join("");

export default async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });
  const key = process.env.AZURE_SPEECH_KEY, region = process.env.AZURE_SPEECH_REGION;
  const url = new URL(req.url);
  if (url.searchParams.has("probe")) return json({ ok: !!(key && region), voice: VOICE });
  if (!key || !region) return json({ error: "The broadcast voice isn't set up on this site." }, 501);
  let text = req.method === "POST" ? ((await req.json().catch(() => ({}))).text) : url.searchParams.get("t");
  text = String(text || "").replace(/\s+/g, " ").trim();
  if (!text || text.length > MAX) return json({ error: "Bad line." }, 400);
  const id = await hash(VOICE + "|" + text);
  const store = getStore("tts");
  const hit = await store.get(id, { type: "arrayBuffer" }).catch(() => null);
  if (hit) return mp3(hit);
  const ssml = `<speak version="1.0" xmlns="http://www.w3.org/2001/10/synthesis" xml:lang="en-US"><voice name="${VOICE}">${esc(text)}</voice></speak>`;
  const r = await fetch(`https://${region}.tts.speech.microsoft.com/cognitiveservices/v1`, {
    method: "POST",
    headers: { "Ocp-Apim-Subscription-Key": key, "Content-Type": "application/ssml+xml", "X-Microsoft-OutputFormat": "audio-24khz-48kbitrate-mono-mp3", "User-Agent": "floodlight-baseball" },
    body: ssml,
  });
  if (!r.ok) return json({ error: `Voice service said ${r.status}.` }, r.status === 429 ? 429 : 502);
  const buf = await r.arrayBuffer();
  await store.set(id, buf).catch(() => {});
  return mp3(buf);
};

export const config = { path: "/api/tts" };
