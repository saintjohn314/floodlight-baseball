// The server's monthly allowance, and a safety cap so online play can never use it all up.
// On Netlify's free plan this site gets 125,000 function requests and 100 hours of function run time a month, and going
// over pauses every site on the account, not just this one. So every function here counts its own requests and run
// time (in Netlify Blobs, one total per day), and online play rests before the total gets close:
//   level 1 "rest": no new online games (games already going can finish)
//   level 2 "stop": no online play at all
//   level 3 "last": the Daily Challenge leaderboard and save codes stop too
// Netlify's allowance resets on the first day of each month (UTC), and so does this count.
// Each server instance adds up its own requests and writes them in small batches (every few requests, or 10 seconds).
import { getStore } from "@netlify/blobs";

const KEY = "roll", KEEP = 40, DAY = 86400000, HOUR = 3600000; // (daily totals are kept 40 days)
const env = (typeof process !== "undefined" && process.env && process.env.FDL_LIMITS || "").split(",").map(Number); // (tests only)
// [requests, run time in ms] this month
export const LIM = env.length === 3 && env.every(n => n > 0)
  ? { rest: [env[0], 1e12], stop: [env[1], 1e12], last: [env[2], 1e12] }
  : { rest: [100000, 80 * HOUR], stop: [112000, 88 * HOUR], last: [119000, 95 * HOUR] };
const SEED = env.length === 3 ? [0, 0] : [10000, 4 * HOUR]; // use from before the counter started (22 Oct 2026; Netlify showed 2,700 requests), counted on its first day
const OVERHEAD = 40; // ms per request Netlify counts beyond what the code can time (starting up, sending the answer)
export const REST_MSG = "Online play is taking a break for a few hours, to stay within the game server's monthly allowance. Everything else in the game works as usual.";
export const RETRY = 6 * HOUR; // how long a device waits before asking again

const store = () => getStore({ name: "usage", consistency: "strong" });
const today = (t = Date.now()) => new Date(t).toISOString().slice(0, 10);
const sleep = ms => new Promise(r => setTimeout(r, ms));
let pend = [0, 0], flushedAt = 0, sum = null, sumAt = 0, writing = null, logged = 0; // (a new instance writes its first request right away)

function total(doc, now) { // this month (UTC)
  const from = today(now).slice(0, 8) + "01"; let n = 0, ms = 0;
  for (const [d, v] of Object.entries((doc && doc.days) || {})) if (d >= from) { n += v[0] || 0; ms += v[1] || 0; }
  return [n, ms];
}
function flush() {
  if (writing || !pend[0]) return writing;
  const add = pend; pend = [0, 0]; flushedAt = Date.now();
  writing = (async () => {
    const S = store();
    for (let i = 0; i < 8; i++) {
      if (i) await sleep(15 + Math.random() * 40 * i);
      const cur = await S.getWithMetadata(KEY, { type: "json" }), now = Date.now(), d = today(now);
      const doc = cur && cur.data && cur.data.days ? cur.data : { days: {} };
      if (!cur) doc.days[d] = SEED.slice();
      const v = doc.days[d] || [0, 0]; v[0] += add[0]; v[1] += add[1]; doc.days[d] = v;
      for (const k of Object.keys(doc.days)) if (k < today(now - KEEP * DAY)) delete doc.days[k];
      const w = cur ? await S.setJSON(KEY, doc, { onlyIfMatch: cur.etag }) : await S.setJSON(KEY, doc, { onlyIfNew: true });
      if (w && w.modified) { sum = total(doc, now); sumAt = now; return; }
    }
    throw new Error("busy");
  })().catch(() => { pend[0] += add[0]; pend[1] += add[1]; }).finally(() => { writing = null; });
  return writing;
}
// call when a request is done: counts it, and now and then writes the counts (after the answer has gone, if the
// platform allows it)
export function count(t0, ctx) {
  pend[0]++; pend[1] += Date.now() - t0 + OVERHEAD;
  if (pend[0] >= 4 || Date.now() - flushedAt > 10000) {
    const p = flush();
    if (p && ctx && typeof ctx.waitUntil === "function") ctx.waitUntil(p);
  }
}
// 0 fine, 1 rest (no new online games), 2 stop (no online play), 3 last (no server features at all)
export async function level() {
  if (globalThis.__FDL_LEVEL != null) return globalThis.__FDL_LEVEL; // (the local test server can set it)
  const now = Date.now();
  if (!sum || now - sumAt > 60000) {
    try {
      const doc = await store().get(KEY, { type: "json" }); sum = doc ? total(doc, now) : SEED.slice(); sumAt = now;
      if (now - logged > 600000) { logged = now; console.log(`usage this month: ${sum[0]} requests, ${(sum[1] / HOUR).toFixed(1)} hours of run time`); } // (in the function log)
    }
    catch (e) { if (!sum) return 0; } // can't read the count right now: carry on rather than turn everyone away
  }
  const n = sum[0] + pend[0], ms = sum[1] + pend[1], over = k => n >= LIM[k][0] || ms >= LIM[k][1];
  return over("last") ? 3 : over("stop") ? 2 : over("rest") ? 1 : 0;
}
// how much of the plan's monthly allowance this month has used (shown with the quick-match counts, so anyone can check)
export async function share() {
  await level(); const n = sum[0] + pend[0], h = (sum[1] + pend[1]) / HOUR;
  return { requests: n, hours: +h.toFixed(1), percent: Math.round(100 * Math.max(n / 125000, h / 100)) };
}
// how much is used (for the daily clean-up's log, and tests)
export async function used() { await flush(); const doc = await store().get(KEY, { type: "json" }); return { month: total(doc, Date.now()), days: doc ? doc.days : {} }; }
