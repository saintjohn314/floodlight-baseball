// Short save codes: the game uploads its (already compressed) save code, gets back a 6-character code,
// and any device can trade that code back for the save. Stored with Netlify Blobs, so there's no other service or account.
import { getStore } from "@netlify/blobs";
import { count, level, RETRY } from "../lib/usage.mjs"; // the server's monthly allowance (see that file)

const ABC = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // no O/0 or I/1, so codes are easy to read and type
const MAX = 2_000_000;
const HEAD = { "content-type": "application/json", "cache-control": "no-store", "access-control-allow-origin": "*", "access-control-allow-methods": "GET, POST, OPTIONS", "access-control-allow-headers": "content-type" };
const reply = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: HEAD });
const newCode = () => Array.from(crypto.getRandomValues(new Uint8Array(6)), b => ABC[b % 32]).join("");

export default async (req, context) => {
  const t0 = Date.now();
  try { return await handle(req); }
  finally { count(t0, context); }
};
async function handle(req) {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: HEAD });
  if ((await level()) >= 3) return reply({ error: "Save codes are taking a break to stay within the game server's monthly allowance. Use a save file instead, or try again tomorrow.", paused: true, retry: RETRY }, 429);
  const store = getStore("saves");
  if (req.method === "POST") {
    const save = (await req.text()).trim();
    if (save.length > MAX || !/^FDL[01]-[A-Za-z0-9_-]+$/.test(save)) return reply({ error: "That isn't a Floodlight save." }, 400);
    for (let i = 0; i < 8; i++) {
      const code = newCode();
      if ((await store.get(code)) === null) { await store.set(code, save, { metadata: { at: Date.now() } }); return reply({ code }); }
    }
    return reply({ error: "Try again in a moment." }, 503);
  }
  if (req.method === "GET") {
    const code = (new URL(req.url).searchParams.get("code") || "").toUpperCase().replace(/[^A-Z0-9]/g, "");
    if (!/^[A-Z0-9]{6}$/.test(code)) return reply({ error: "Save codes are 6 characters." }, 400);
    const save = await store.get(code);
    return save === null ? reply({ error: "No save with that code." }, 404) : reply({ save });
  }
  return reply({ error: "Method not allowed." }, 405);
}

export const config = { path: "/api/save" };
