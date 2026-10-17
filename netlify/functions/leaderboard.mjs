// The Daily Challenge leaderboard: one board per day, each player's best score.
// Stored with Netlify Blobs (one JSON entry per day), so there's no other service or account.
// GET  /api/leaderboard?date=YYYY-MM-DD&me=<player id>   -> today's top 25, how many played, and your rank
// POST /api/leaderboard  {date, id, name, score, stars, lv} -> saves your score if it beats your best
import { getStore } from "@netlify/blobs";

const HEAD = { "content-type": "application/json", "cache-control": "no-store", "access-control-allow-origin": "*", "access-control-allow-methods": "GET, POST, OPTIONS", "access-control-allow-headers": "content-type" };
const reply = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: HEAD });
const DAY = /^\d{4}-\d{2}-\d{2}$/, ID = /^[a-z0-9]{12,40}$/i, LEVELS = ["rookie", "pro", "allstar"];
const TOP = 25, MAX_PLAYERS = 5000, MAX_SCORE = 2000;
const RUDE = /(fuck|shit|cunt|nigg|fag|bitch|whore|slut|rape|nazi|hitler|kike|spic|chink|retard|penis|vagina|porn)/i;
const cleanName = s => String(s || "").normalize("NFKC").replace(/[^\p{L}\p{N} ._'-]/gu, "").replace(/\s+/g, " ").trim().slice(0, 16);
// the game uses the player's own calendar date, so allow a day either side of UTC
const dayOK = d => { const t = Date.parse(d + "T12:00:00Z"); return !isNaN(t) && Math.abs(t - Date.now()) < 40 * 3600 * 1000; };

function board(entries, me) {
  const all = Object.entries(entries).map(([id, e]) => ({ id, ...e })).sort((a, b) => b.s - a.s || a.at - b.at);
  const at = me ? all.findIndex(e => e.id === me) : -1;
  return {
    count: all.length,
    top: all.slice(0, TOP).map(e => ({ n: e.n, s: e.s, st: e.st, lv: e.lv, me: e.id === me })),
    rank: at + 1,
    you: at >= 0 ? { n: all[at].n, s: all[at].s, st: all[at].st, lv: all[at].lv } : null,
  };
}

export default async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: HEAD });
  const store = getStore({ name: "daily-leaderboard", consistency: "strong" });
  if (req.method === "GET") {
    const q = new URL(req.url).searchParams, date = q.get("date") || "", me = q.get("me") || "";
    if (!DAY.test(date)) return reply({ error: "Bad date." }, 400);
    const cur = await store.get(date, { type: "json" });
    return reply({ date, ...board((cur && cur.entries) || {}, ID.test(me) ? me : "") });
  }
  if (req.method === "POST") {
    const raw = await req.text();
    if (raw.length > 2000) return reply({ error: "Too big." }, 400);
    let b; try { b = JSON.parse(raw); } catch (e) { return reply({ error: "Bad request." }, 400); }
    const date = String(b.date || ""), id = String(b.id || ""), name = cleanName(b.name), score = Math.round(Number(b.score)), stars = Math.round(Number(b.stars)), lv = LEVELS.includes(b.lv) ? b.lv : "pro";
    if (!DAY.test(date) || !dayOK(date)) return reply({ error: "That isn't today's challenge." }, 400);
    if (!ID.test(id)) return reply({ error: "Bad player." }, 400);
    if (name.length < 2) return reply({ error: "Pick a name with at least 2 letters." }, 400);
    if (RUDE.test(name.replace(/[^a-z]/gi, ""))) return reply({ error: "Pick a different name." }, 400);
    if (!(score > 0 && score <= MAX_SCORE) || !(stars >= 1 && stars <= 3)) return reply({ error: "Bad score." }, 400);
    for (let i = 0; i < 15; i++) {
      if (i) await new Promise(r => setTimeout(r, 15 + Math.random() * 60 * i)); // someone else saved first: wait a moment, read again
      const cur = await store.getWithMetadata(date, { type: "json" });
      const entries = (cur && cur.data && cur.data.entries) || {}, old = entries[id];
      if (old && old.s >= score) {
        if (old.n === name) return reply({ date, best: false, ...board(entries, id) });
        entries[id] = { ...old, n: name }; // a new name keeps the best score
      } else {
        if (!old && Object.keys(entries).length >= MAX_PLAYERS) return reply({ error: "Today's board is full." }, 503);
        entries[id] = { n: name, s: score, st: stars, lv, at: Date.now() };
      }
      const res = cur ? await store.setJSON(date, { entries }, { onlyIfMatch: cur.etag }) : await store.setJSON(date, { entries }, { onlyIfNew: true });
      if (res.modified) return reply({ date, best: !old || old.s < score, ...board(entries, id) });
    }
    return reply({ error: "The leaderboard is busy. Try again." }, 503);
  }
  return reply({ error: "Method not allowed." }, 405);
};

export const config = { path: "/api/leaderboard" };
