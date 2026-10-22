// Once a day: deletes online games nobody has touched for over a week (the privacy policy says they go about a week
// after the last move), and writes to the function log how much of the server's monthly allowance this month has used
// (see ../lib/usage.mjs).
import { getStore } from "@netlify/blobs";
import { count, used } from "../lib/usage.mjs";

const OLD = 8 * 24 * 3600 * 1000, BUDGET = 20000; // (scheduled functions get 30 seconds)

export default async (req, context) => {
  const t0 = Date.now(); let looked = 0, deleted = 0;
  try {
    const S = getStore({ name: "online-games", consistency: "strong" });
    outer: for await (const page of S.list({ paginate: true })) {
      const keys = (page.blobs || []).map(b => b.key);
      for (let i = 0; i < keys.length; i += 10) {
        if (Date.now() - t0 > BUDGET) break outer;
        await Promise.all(keys.slice(i, i + 10).map(async k => {
          looked++;
          const m = await S.getMetadata(k), upd = m && m.metadata && m.metadata.upd;
          if (upd && Date.now() - upd > OLD) { await S.delete(k); deleted++; }
        }));
      }
    }
  } catch (e) { console.log("cleanup:", String(e)); }
  try { const u = await used(); console.log(`cleanup: looked at ${looked} games, deleted ${deleted}. This month: ${u.month[0]} requests, ${(u.month[1] / 3600000).toFixed(1)} hours of run time.`); }
  catch (e) { console.log("cleanup: couldn't read usage", String(e)); }
  count(t0, context);
  return new Response("ok");
};

export const config = { schedule: "@daily" };
