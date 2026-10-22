// Online games: two people play a quick game over the internet, each managing their own team.
// The server keeps only the ordered list of moves for each game (a "room", found by a 4-character code). Both players'
// games start from the same dice seed and replay the same moves in the same order, so they stay in step. Anyone else
// with the code can watch. Rooms live in Netlify Blobs and are cleared a few days after the last move.
//
// POST /api/online {op:"create", name, team, mode}       -> {code, tok, side:1, seed, mode}   (whoever invites is home)
// POST /api/online {op:"join", code, name, team}          -> {tok, side:0, ...room}             (or {full:true})
// POST /api/online {op:"send", code, tok, e, since}       -> {i, ...room with the moves after `since`}
// GET  /api/online?code=ABCD&since=N&wait=7&tok=...       -> the room and its moves after N (waits up to `wait` seconds for new ones)
// Quick match ("Play now"): POST {op:"qfind", name, mode, gv, teams:{red, blue}} -> {match:true, tok, side:0, ...room} or {wait:true, id, tok, n}
//   POST {op:"qwait", id, tok, mode, gv} -> {match:true, code, tok, side:1} | {wait:true, n} | {gone:true};  POST {op:"qleave", ...}
//   GET /api/online?mq=1&gv=2 -> how many people are looking for a game right now
// The server's monthly allowance (../lib/usage.mjs): when it runs low, new games are turned away first, then all
// online play; those answers say {paused:true, retry: ms} so the game stops asking for a few hours.
import { getStore } from "@netlify/blobs";
import { count, level, share, REST_MSG, RETRY } from "../lib/usage.mjs";

const HEAD = { "content-type": "application/json", "cache-control": "no-store", "access-control-allow-origin": "*", "access-control-allow-methods": "GET, POST, OPTIONS", "access-control-allow-headers": "content-type" };
const reply = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: HEAD });
const CODE_CH = "BCDFGHJKMNPQRSTVWXZ23456789"; // no vowels (no words), nothing that looks like another character
const CODE = /^([BCDFGHJKMNPQRSTVWXZ2-9]{4}|L[A-Z0-9-]{6,56})$/, LCODE = /^[BCDFGHJKMNPQRSTVWXZ2-9]{4}$/, TOK = /^[a-f0-9]{24}$/, PID = /^[a-z0-9]{16}$/;
const KINDS = new Set(["roll", "card", "dh", "ab", "ans", "say", "go", "leave"]);
const MODES = new Set(["sim", "arcade"]);
const ABS = /^[A-Z]{3}$/, CARDS = /^[A-Z]{2,3}$/;
const MAX_LOG = 6000, TTL = 4 * 24 * 3600 * 1000, SEEN_EVERY = 15000;
// the game's rules version (gv): both screens play every move on their own, so they must play by the same rules.
// Games from before Oct 2026 send none (1). 2: twenty player abilities.
const GV = b => Number.isInteger(b.gv) && b.gv > 0 && b.gv < 1000 ? b.gv : 1;
const VER_MSG = "This game was started on a different version of Floodlight Baseball. You both need the newest version: refresh the page (or update the app) and try again.";
const RUDE = /(fuck|shit|cunt|nigg|fag|bitch|whore|slut|rape|nazi|hitler|kike|spic|chink|retard|penis|vagina|porn)/i;
const store = () => getStore({ name: "online-games", consistency: "strong" });
const lstore = () => getStore({ name: "online-leagues", consistency: "strong" });
const rand = n => { const a = new Uint8Array(n); crypto.getRandomValues(a); return a; };
const token = () => [...rand(12)].map(b => b.toString(16).padStart(2, "0")).join("");
const newCode = () => [...rand(4)].map(b => CODE_CH[b % CODE_CH.length]).join("");
const sleep = ms => new Promise(r => setTimeout(r, ms));
const cleanStr = (s, max) => String(s || "").normalize("NFKC").replace(/[^\p{L}\p{N} .'’-]/gu, "").replace(/\s+/g, " ").trim().slice(0, max);

// a team as the game plays it (see gameTeam() in the game): names, scoreboard abbreviation, color, batting order, abilities
function cleanTeam(t, league) {
  if (!t || typeof t !== "object" || JSON.stringify(t).length > 9000) return null;
  const id = league ? (/^[a-z0-9]{1,8}$/.test(t.id || "") ? t.id : null) : (t.id === "red" || t.id === "blue" ? t.id : null), name = cleanStr(t.name, 28), abbr = String(t.abbr || "").toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 4);
  if (!id || name.length < 1 || abbr.length < 1 || RUDE.test(name.replace(/[^a-z]/gi, ""))) return null;
  const color = league ? (/^#[0-9a-f]{6}$/i.test(t.color || "") ? t.color : "#888888") : id === "red" ? "#d9493f" : "#5b8fe8"; // quick games: the two decks keep their colors, so the teams never look alike
  const logo = /^[a-z0-9]{1,16}$/.test(t.logo || "") ? t.logo : null;
  if (!Array.isArray(t.lineup) || t.lineup.length !== 9) return null;
  const lineup = t.lineup.map(n => cleanStr(n, 22));
  if (lineup.some(n => n.length < 1 || RUDE.test(n.replace(/[^a-z]/gi, ""))) || new Set(lineup.map(n => n.toLowerCase())).size !== 9) return null;
  const ab = {}, info = {};
  t.lineup.forEach((raw, i) => {
    const n = lineup[i], a = (t.ab || {})[raw], r = (t.info || {})[raw] || {};
    ab[n] = ABS.test(a) ? a : null;
    const o = { ab: ABS.test(r.ab) ? r.ab : ab[n], n: Math.max(0, Math.min(99, Math.round(+r.n || 0))) };
    for (const k of ["f", "hi", "dk", "jp"]) if (r[k]) o[k] = 1;
    if (r.pic) { const p = cleanStr(r.pic, 30); if (p) o.pic = p; }
    info[n] = o;
  });
  const lr = {}; // lr: a franchise that plays without action cards or designated hitters (its league settings)
  if (t.lr && typeof t.lr === "object") for (const k of ["cards", "dh"]) if (t.lr[k] === false) lr[k] = false;
  return Object.assign({ id, name, abbr, color, logo, lineup, ab, info }, Object.keys(lr).length ? { lr } : {});
}
// one move from a player: only the fields each kind needs, small
function cleanMove(e) {
  if (!e || typeof e !== "object" || !KINDS.has(e.k)) return null;
  const o = { k: e.k };
  if (Number.isInteger(e.at) && e.at >= 0 && e.at < 1e6) o.at = e.at;
  if (Number.isInteger(e.g) && e.g >= 0 && e.g < 1000) o.g = e.g;
  if (e.as === 0 || e.as === 1) o.as = e.as; // a league game against a computer club: the player sends the computer's rolls too
  if (e.k === "card") { if (!CARDS.test(e.id) || (e.t !== 0 && e.t !== 1)) return null; o.id = e.id; o.t = e.t; }
  if (e.k === "dh") { if (e.t !== 0 && e.t !== 1) return null; o.t = e.t; }
  if (e.k === "ab") { const a = e.a || {}; if (!ABS.test(a.k)) return null; o.a = { k: a.k, name: cleanStr(a.name, 22) }; if (Number.isInteger(a.from) && a.from >= 0 && a.from <= 2) o.a.from = a.from; }
  if (e.k === "ans") { o.v = !!e.v; if (Number.isInteger(e.q) && e.q > 0 && e.q < 1e6) o.q = e.q; }
  if (e.k === "say") { if (!(Number.isInteger(e.m) && e.m >= 0 && e.m < 20)) return null; o.m = e.m; }
  return o;
}
const pub = R => R.p.map(x => x && { name: x.name, pid: x.pid || "" }); // pid: a player's public id, so records follow a person even if they change their name
function roomOut(R, since, full) {
  const out = { code: R.code, now: Date.now(), n: R.log.length, mode: R.mode, seed: R.seed, p: pub(R), seen: R.seen, log: R.log.slice(Math.max(0, since || 0)) };
  if (full) out.teams = R.p.map(x => x && x.team);
  if (R.kind) Object.assign(out, { kind: R.kind, cpu: R.cpu, lvl: R.lvl, label: R.label, fkind: R.fkind, lg: R.lg });
  return out;
}
const expired = R => !R || !!R.dead || Date.now() - (R.upd || R.at || 0) > TTL;
const sideOf = (R, tok) => R.p.findIndex(x => x && x.tok === tok);

// clear out games nobody has touched for a while (a few at a time)
async function sweep(S) {
  const { blobs } = await S.list(); let n = 0;
  for (const b of blobs || []) {
    if (n++ > 60) break;
    const m = await S.getMetadata(b.key);
    if (m && m.metadata && m.metadata.upd && Date.now() - m.metadata.upd > TTL * 2) await S.delete(b.key);
  }
}
// read-modify-write with a retry when someone else wrote first
async function update(S, code, fn) {
  for (let i = 0; i < 20; i++) {
    if (i) await sleep(10 + Math.random() * 40 * i);
    const cur = await S.getWithMetadata(code, { type: "json" });
    if (!cur || !cur.data || expired(cur.data)) return { error: "No game with that code. Check it, or start a new one.", status: 404 };
    const R = cur.data, res = fn(R);
    if (res && res.error) return res;
    if (res && res.noWrite) return { R, res };
    R.upd = Date.now();
    const w = await S.setJSON(code, R, { onlyIfMatch: cur.etag, metadata: { n: R.log.length, upd: R.upd } });
    if (w.modified) return { R, res };
  }
  return { error: "The game server is busy. Try again.", status: 503 };
}

export default async (req, context) => {
  const t0 = Date.now();
  try { return await handle(req); }
  finally { count(t0, context); }
};
// the answer when online play is resting: shaped so that older copies of the game stop asking too
// (they stop polling a game on 404, stop looking for a quick match on 400, and give up on a move on other 4xx)
const rest = (status, more) => reply({ error: REST_MSG, paused: true, retry: RETRY, ...(more || {}) }, status);
async function handle(req) {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: HEAD });
  const S = store(), lv = await level();
  if (req.method === "GET") {
    const q = new URL(req.url).searchParams;
    if (lv >= 1 && q.get("mq")) return rest(200, { sim: 0, arcade: 0, hour: 0 });
    if (lv >= 2) return rest(q.get("lg") ? 503 : 404); // (an online franchise: older copies would forget it on a 404, so they just try again later)
  }
  if (req.method === "GET" && new URL(req.url).searchParams.get("lg")) return leagueGet(new URL(req.url).searchParams);
  if (req.method === "GET" && new URL(req.url).searchParams.get("mq")) return quickCount(new URL(req.url).searchParams);
  if (req.method === "GET") {
    const q = new URL(req.url).searchParams, code = String(q.get("code") || "").toUpperCase(), since = Math.max(0, parseInt(q.get("since") || "0", 10) || 0);
    const wait = Math.max(0, Math.min(7, parseFloat(q.get("wait") || "0") || 0)), tok = String(q.get("tok") || "");
    if (!CODE.test(code)) return reply({ error: "That code should be 4 letters and numbers." }, 400);
    const end = Date.now() + wait * 1000;
    for (;;) {
      const m = await S.getMetadata(code);
      if (!m) return reply({ error: "No game with that code. Check it, or start a new one." }, 404);
      const n = m.metadata && Number.isInteger(m.metadata.n) ? m.metadata.n : 1e9;
      if (n > since || Date.now() >= end) break;
      await sleep(350);
    }
    let R = await S.get(code, { type: "json" });
    if (expired(R)) return reply({ error: "That game has ended. Start a new one." }, 404);
    // a player's own check-ins say they're still connected (written at most every 15 seconds)
    const s = TOK.test(tok) ? sideOf(R, tok) : -1;
    if (s >= 0 && Date.now() - ((R.seen || [])[s] || 0) > SEEN_EVERY) {
      const u = await update(S, code, X => { X.seen = X.seen || [0, 0]; X.seen[s] = Date.now(); });
      if (u.R) R = u.R;
    }
    return reply(roomOut(R, since, since === 0 || q.get("full") === "1"));
  }
  if (req.method !== "POST") return reply({ error: "Method not allowed." }, 405);
  const raw = await req.text();
  if (raw.length > 4000000) return reply({ error: "Too big." }, 400);
  let b; try { b = JSON.parse(raw); } catch (e) { return reply({ error: "Bad request." }, 400); }
  if (!/^lg/.test(String(b.op)) && raw.length > 12000) return reply({ error: "Too big." }, 400);
  if (lv >= 1) { // resting: no new games (and at level 2 nothing at all, except stepping out of the quick-match line)
    const op = String(b.op);
    if (op === "qwait") return rest(200, { gone: true });
    if (op === "qfind") return rest(400);
    if (op !== "qleave" && (lv >= 2 || ["create", "join", "lgcreate", "lgjoin"].includes(op))) return rest(429);
    if (op === "lgroom" && !(await store().getMetadata("L" + String(b.code || "").toUpperCase() + "-" + String(b.key || "").toUpperCase().replace(/[^A-Z0-9-]/g, "").slice(0, 40)))) return rest(429);
  }
  if (/^lg/.test(String(b.op))) return league(b);
  if (/^q(find|wait|leave)$/.test(String(b.op))) return quick(b);

  if (b.op === "create") {
    const name = cleanStr(b.name, 16), team = cleanTeam(b.team), mode = MODES.has(b.mode) ? b.mode : "sim", pid = PID.test(b.pid || "") ? b.pid : "";
    if (name.length < 1 || RUDE.test(name.replace(/[^a-z]/gi, ""))) return reply({ error: "Pick a different name." }, 400);
    if (!team) return reply({ error: "Something's wrong with your team. Check the names and try again." }, 400);
    const now = Date.now(), tok = token();
    const R = { v: 1, code: "", at: now, upd: now, seed: new Uint32Array(rand(4).buffer)[0], mode, host: 1, p: [null, { name, team, tok, pid }], log: [], seen: [0, now], gv: GV(b) };
    for (let i = 0; i < 12; i++) {
      const code = newCode(); R.code = code;
      const old = await S.getWithMetadata(code, { type: "json" });
      const w = old ? (expired(old.data) ? await S.setJSON(code, R, { onlyIfMatch: old.etag, metadata: { n: 0, upd: now } }) : { modified: false })
        : await S.setJSON(code, R, { onlyIfNew: true, metadata: { n: 0, upd: now } });
      if (w.modified) { if (Math.random() < 0.1) await sweep(S).catch(() => {}); return reply({ code, tok, side: 1, seed: R.seed, mode }); }
    }
    return reply({ error: "Couldn't make a game code. Try again." }, 503);
  }

  const code = String(b.code || "").toUpperCase();
  if (!CODE.test(code)) return reply({ error: "That code should be 4 letters and numbers." }, 400);

  if (b.op === "join") {
    const name = cleanStr(b.name, 16), team = cleanTeam(b.team), cid = /^[a-z0-9]{16}$/.test(b.cid || "") ? b.cid : "", pid = PID.test(b.pid || "") ? b.pid : "";
    if (name.length < 1 || RUDE.test(name.replace(/[^a-z]/gi, ""))) return reply({ error: "Pick a different name." }, 400);
    if (!team) return reply({ error: "Something's wrong with your team. Check the names and try again." }, 400);
    let tok = token();
    const u = await update(S, code, R => {
      if (R.p[0] && cid && R.p[0].cid === cid) { tok = R.p[0].tok; return { again: true, noWrite: true }; } // the same device joining again (its first reply got lost)
      if (R.p[0]) return { full: true, noWrite: true };
      if ((R.gv || 1) !== GV(b)) return { error: VER_MSG, status: 409 };
      const H = R.p[1].team;
      if (team.id === H.id) return { error: "Both teams have the same deck. Update the game and try again.", status: 409 };
      const taken = new Set(H.lineup.map(n => n.toLowerCase()));
      const dup = team.lineup.find(n => taken.has(n.toLowerCase()));
      if (dup) return { error: `Both teams have a player named ${dup}. Rename yours and try again.`, status: 409 };
      if (team.abbr === H.abbr) team.abbr = (team.abbr.slice(0, 3) + "2");
      R.p[0] = { name, team, tok, cid, pid }; R.seen = R.seen || [0, 0]; R.seen[0] = Date.now();
      R.log.push({ i: R.log.length, s: 0, k: "join", g: 0 });
    });
    if (u.error) return reply({ error: u.error }, u.status || 400);
    if (u.res && u.res.full) return reply({ full: true, ...roomOut(u.R, 0, true), log: [] });
    return reply({ tok, side: 0, ...roomOut(u.R, 0, true) });
  }

  if (b.op === "cancel") { // the host calls off a game nobody has joined yet
    const tok = String(b.tok || "");
    const u = await update(S, code, R => { if (sideOf(R, tok) !== 1) return { error: "Not your game.", status: 403 }; if (R.p[0]) return { error: "Your opponent already joined.", status: 409 }; R.dead = true; });
    if (u.error) return reply({ error: u.error }, u.status || 400);
    return reply({ ok: true });
  }

  if (b.op === "team") { // the host changes their team (names, batting order) while waiting for the other player
    const tok = String(b.tok || ""), team = cleanTeam(b.team);
    if (!team || team.id !== "red") return reply({ error: "Something's wrong with your team. Check the names and try again." }, 400);
    const u = await update(S, code, R => { if (sideOf(R, tok) !== 1) return { error: "Not your game.", status: 403 }; if (R.p[0]) return { error: "Your opponent already joined, so your team is set for this game.", status: 409 }; R.p[1].team = team; });
    if (u.error) return reply({ error: u.error }, u.status || 400);
    return reply({ ok: true });
  }

  if (b.op === "send") {
    const tok = String(b.tok || ""), e = cleanMove(b.e), since = Math.max(0, parseInt(b.since, 10) || 0);
    if (!TOK.test(tok)) return reply({ error: "Not your game." }, 403);
    if (!e) return reply({ error: "Bad move." }, 400);
    const as = e.as; delete e.as; // (taken out once, before the write that may be retried)
    let at = -1;
    const u = await update(S, code, R => {
      const s = sideOf(R, tok); if (s < 0) return { error: "Not your game.", status: 403 };
      if (!R.p[0]) return { error: "Your opponent hasn't joined yet.", status: 409 };
      if (R.log.length >= MAX_LOG) return { error: "This game is full. Start a new one.", status: 409 };
      at = R.log.length; R.log.push({ i: at, s: as != null && R.cpu && R.cpu[as] ? as : s, ...e }); R.seen = R.seen || [0, 0]; R.seen[s] = Date.now();
    });
    if (u.error) return reply({ error: u.error }, u.status || 400);
    return reply({ i: at, ...roomOut(u.R, since, false) });
  }
  return reply({ error: "Bad request." }, 400);
};

/* ---------- online franchises ("leagues") ----------
   A league is a franchise that up to four people share, each running a club. The whole franchise (the same save the
   game keeps on a device, gzipped) lives here with a version number; whoever plays the last game of a day finishes
   the day on their device and sends the new save. Members, and the league games being played right now (so others
   can watch), are kept beside it. League games are ordinary online rooms (codes starting with L), one per game. */
const MAXM = 4;
const lgOut = (L, ver) => ({ code: L.code, now: Date.now(), ver: L.ver, mver: L.mver, members: L.members.map(m => ({ name: m.name, pid: m.pid, club: m.club, seen: m.seen || 0, ready: m.ready || 0 })), live: L.live || {}, res: L.res || {}, ...(L.ver > ver ? { F: L.F } : {}) });
const KEY = /^[A-Z0-9-]{3,40}$/;
const lgMember = (L, tok) => TOK.test(tok || "") ? L.members.find(m => m.tok === tok) : null;
async function lgUpdate(S, code, fn) {
  for (let i = 0; i < 20; i++) {
    if (i) await sleep(10 + Math.random() * 40 * i);
    const cur = await S.getWithMetadata(code, { type: "json" });
    if (!cur || !cur.data) return { error: "No online franchise with that code.", status: 404 };
    const L = cur.data, res = fn(L);
    if (res && res.error) return res;
    if (res && res.noWrite) return { L, res };
    L.upd = Date.now();
    const w = await S.setJSON(code, L, { onlyIfMatch: cur.etag, metadata: { ver: L.ver, mver: L.mver, upd: L.upd } });
    if (w.modified) return { L, res };
  }
  return { error: "The game server is busy. Try again.", status: 503 };
}
async function leagueGet(q) {
  const S = lstore(), code = String(q.get("lg") || "").toUpperCase(), ver = parseInt(q.get("ver") || "0", 10) || 0, mver = parseInt(q.get("mver") || "0", 10) || 0;
  const wait = Math.max(0, Math.min(7, parseFloat(q.get("wait") || "0") || 0)), tok = String(q.get("tok") || "");
  if (!LCODE.test(code)) return reply({ error: "That code should be 4 letters and numbers." }, 400);
  const end = Date.now() + wait * 1000;
  for (;;) {
    const m = await S.getMetadata(code);
    if (!m) return reply({ error: "No online franchise with that code." }, 404);
    const md = m.metadata || {};
    if (!(Number.isInteger(md.ver) && Number.isInteger(md.mver)) || md.ver > ver || md.mver > mver || Date.now() >= end) break;
    await sleep(400);
  }
  let L = await S.get(code, { type: "json" });
  if (!L) return reply({ error: "No online franchise with that code." }, 404);
  const me = lgMember(L, tok);
  if (me && Date.now() - (me.seen || 0) > 20000) { const u = await lgUpdate(S, code, X => { const m = lgMember(X, tok); if (m) m.seen = Date.now(); else return { noWrite: true }; }); if (u.L) L = u.L; }
  return reply(lgOut(L, ver));
}
async function league(b) {
  const S = lstore(), op = b.op, name = cleanStr(b.name, 16), pid = PID.test(b.pid || "") ? b.pid : "", cid = /^[a-z0-9]{16}$/.test(b.cid || "") ? b.cid : "";
  const club = /^[a-z0-9]{1,8}$/.test(b.club || "") ? b.club : "", Fs = typeof b.F === "string" && b.F.length < 3900000 ? b.F : null;
  if (op === "lgcreate") {
    if (name.length < 1 || RUDE.test(name.replace(/[^a-z]/gi, ""))) return reply({ error: "Pick a different name." }, 400);
    if (!club || !Fs) return reply({ error: "Bad franchise." }, 400);
    const now = Date.now(), tok = token(), L = { v: 1, code: "", at: now, upd: now, ver: 1, mver: 1, F: Fs, members: [{ name, pid, cid, club, tok, seen: now }], live: {} };
    for (let i = 0; i < 12; i++) {
      const code = newCode(); L.code = code;
      const w = await S.setJSON(code, L, { onlyIfNew: true, metadata: { ver: 1, mver: 1, upd: now } });
      if (w.modified) return reply({ code, tok, ver: 1, mver: 1 });
    }
    return reply({ error: "Couldn't make a code. Try again." }, 503);
  }
  const code = String(b.code || "").toUpperCase(), tok = String(b.tok || "");
  if (!LCODE.test(code)) return reply({ error: "That code should be 4 letters and numbers." }, 400);
  if (op === "lgjoin") {
    if (name.length < 1 || RUDE.test(name.replace(/[^a-z]/gi, ""))) return reply({ error: "Pick a different name." }, 400);
    if (!club) return reply({ error: "Pick a club." }, 400);
    let mine = "";
    const u = await lgUpdate(S, code, L => {
      const again = cid && L.members.find(m => m.cid === cid);
      if (again) { mine = again.tok; return { noWrite: true }; }
      if (L.members.length >= MAXM) return { error: `This franchise already has ${MAXM} players.`, status: 409 };
      if (L.members.some(m => m.club === club)) return { error: "Someone already runs that club. Pick another one.", status: 409 };
      mine = token(); L.members.push({ name, pid, cid, club, tok: mine, seen: Date.now() }); L.mver++;
    });
    if (u.error) return reply({ error: u.error }, u.status || 400);
    return reply({ tok: mine, ...lgOut(u.L, 0) });
  }
  if (op === "lgput") { // a new franchise save: only on top of the version it was made from
    if (!Fs) return reply({ error: "Bad franchise." }, 400);
    const base = parseInt(b.base, 10) || 0;
    const done = Array.isArray(b.done) ? b.done.filter(k => KEY.test(k)).slice(0, 40) : [];
    const u = await lgUpdate(S, code, L => { if (!lgMember(L, tok)) return { error: "Not your franchise.", status: 403 }; if (L.ver !== base) return { error: "conflict", status: 409 }; L.F = Fs; L.ver++;
      if (done.length && L.res) { for (const k of done) delete L.res[k]; L.mver++; } });
    if (u.error) return reply({ error: u.error, conflict: u.error === "conflict" }, u.status || 400);
    return reply({ ver: u.L.ver, mver: u.L.mver });
  }
  if (op === "lglive") { // a member's league game in progress (so the others can watch), or done
    const room = typeof b.room === "string" && CODE.test(b.room) ? b.room : "";
    const u = await lgUpdate(S, code, L => { const m = lgMember(L, tok); if (!m) return { error: "Not your franchise.", status: 403 }; L.live = L.live || {};
      if (room) L.live[m.club] = { room, opp: cleanStr(b.opp, 28), home: !!b.home, label: cleanStr(b.label, 60), at: Date.now() }; else delete L.live[m.club]; L.mver++; });
    if (u.error) return reply({ error: u.error }, u.status || 400);
    return reply({ ok: true, ...lgOut(u.L, 1e9) });
  }
  if (op === "lgres") { // a finished league game (or one simulated on someone's device): the first result for a game counts
    const key = String(b.key || ""), r = b.r && typeof b.r === "object" ? b.r : null;
    if (!KEY.test(key) || !r || JSON.stringify(r).length > 80000) return reply({ error: "Bad result." }, 400);
    const u = await lgUpdate(S, code, L => { const m = lgMember(L, tok); if (!m) return { error: "Not your franchise.", status: 403 };
      L.res = L.res || {}; if (L.res[key]) return { noWrite: true, dup: true };
      L.res[key] = { r, by: m.club, at: Date.now() };
      const ks = Object.keys(L.res); if (ks.length > 60) ks.sort((x, y) => L.res[x].at - L.res[y].at).slice(0, ks.length - 60).forEach(k => delete L.res[k]);
      const rc = "L" + code + "-" + key; for (const c of Object.keys(L.live || {})) if (L.live[c].room === rc) delete L.live[c];
      L.mver++; });
    if (u.error) return reply({ error: u.error }, u.status || 400);
    return reply({ ok: true, dup: !!(u.res && u.res.dup), ...lgOut(u.L, 1e9) });
  }
  if (op === "lgready") { // ready for next season (or not)
    const season = Math.max(0, Math.min(9999, parseInt(b.season, 10) || 0));
    const u = await lgUpdate(S, code, L => { const m = lgMember(L, tok); if (!m) return { error: "Not your franchise.", status: 403 }; m.ready = season; L.mver++; });
    if (u.error) return reply({ error: u.error }, u.status || 400);
    return reply({ ok: true, ...lgOut(u.L, 1e9) });
  }
  if (op === "lgleave") {
    const u = await lgUpdate(S, code, L => { const i = L.members.findIndex(m => m.tok === tok); if (i < 0) return { error: "Not your franchise.", status: 403 }; const c = L.members[i].club; L.members.splice(i, 1); if (L.live) delete L.live[c]; L.mver++; });
    if (u.error) return reply({ error: u.error }, u.status || 400);
    return reply({ ok: true });
  }
  if (op === "lgroom") { // the online room for one league game: made by whoever gets there first, joined by the other player
    const key = String(b.key || "").toUpperCase().replace(/[^A-Z0-9-]/g, "").slice(0, 40), side = b.side === 0 || b.side === 1 ? b.side : -1; // (the same key as the resting check above)
    const L = await S.get(code, { type: "json" }), m = L && lgMember(L, tok);
    if (!m) return reply({ error: "Not your franchise." }, 403);
    if (!key || side < 0) return reply({ error: "Bad game." }, 400);
    const rc = "L" + code + "-" + key, RS = store(), team = cleanTeam(b.team, true), other = b.other ? cleanTeam(b.other, true) : null;
    const cpu = Array.isArray(b.cpu) ? [!!b.cpu[0], !!b.cpu[1]] : [false, false];
    if (!team) return reply({ error: "Something's wrong with your team." }, 400);
    if (cpu[1 - side] && !other) return reply({ error: "Something's wrong with the other team." }, 400);
    const now = Date.now();
    if (!(await RS.getMetadata(rc))) {
      const R = { v: 1, code: rc, at: now, upd: now, seed: new Uint32Array(rand(4).buffer)[0], mode: "sim", host: side, p: [null, null], log: [], seen: [0, 0], kind: "lg", lg: code, cpu, lvl: ["rookie", "pro", "allstar"].includes(b.lvl) ? b.lvl : "pro", label: cleanStr(b.label, 60), fkind: b.fkind === "po" ? "po" : "reg", gv: GV(b) };
      if (cpu[1 - side]) R.p[1 - side] = { name: other.name, team: other, cpu: true };
      await RS.setJSON(rc, R, { onlyIfNew: true, metadata: { n: 0, upd: now } });
    }
    let mineTok = "";
    const u = await update(RS, rc, R => {
      const cur = R.p[side];
      if (cur && cur.cpu) return { error: "That side is the computer's.", status: 409 };
      if ((R.gv || 1) !== GV(b)) return { error: VER_MSG, status: 409 };
      if (cur) { if (cur.pid === m.pid || (cid && cur.cid === cid)) { mineTok = cur.tok; return { noWrite: true }; } return { error: "Someone else is playing that side.", status: 409 }; }
      mineTok = token(); R.p[side] = { name: m.name, team, tok: mineTok, pid: m.pid, cid };
      R.seen = R.seen || [0, 0]; R.seen[side] = now;
      if (R.p[0] && R.p[1] && !R.log.some(e => e.k === "join")) R.log.push({ i: R.log.length, s: side, k: "join", g: 0 });
    });
    if (u.error) return reply({ error: u.error }, u.status || 400);
    return reply({ tok: mineTok, side, ...roomOut(u.R, 0, true) });
  }
  return reply({ error: "Bad request." }, 400);
}

/* ---------- quick match ("Play now"): play whoever else is looking for a game right now ----------
   One waiting line for each set of rules (Simulation or Arcade) and game version. Someone who finds nobody waiting joins
   the line and checks in every few seconds (more often at first, less often as the wait goes on). The next person to
   look is matched with whoever has waited longest, and the server opens a room for the two of them: the one who waited
   is the home team (RED deck), the newcomer the away team (BLUE deck), each with the team and names from their own
   device. Anyone who stops checking in (closed the page, lost signal) drops out of the line.
   (Copies of the game from before Nov 2026 check in with a long poll: the server holds their check-in up to 5 seconds.
   Newer ones send cv:2 and get an answer right away, which uses far less of the server's allowance.) */
const mstore = () => getStore({ name: "online-match", consistency: "strong" });
const QFRESH = 30000, QMATCHED = 120000, QWAIT = 5000;
const qKey = (mode, gv) => `mq-${mode}-${gv}`;
const qLive = (Q, now) => Q.t.filter(x => !x.m && now - x.seen < QFRESH).length;
async function qUpdate(MS, key, fn) {
  for (let i = 0; i < 25; i++) {
    if (i) await sleep(10 + Math.random() * 40 * i);
    const cur = await MS.getWithMetadata(key, { type: "json" });
    const Q = cur && cur.data && Array.isArray(cur.data.t) ? cur.data : { t: [] }, now = Date.now();
    Q.t = Q.t.filter(x => x.m ? now - x.m.at < QMATCHED : now - x.seen < QFRESH); // people who left, and matches nobody picked up
    const res = fn(Q, now);
    if (res && res.error) return res;
    if (res && res.noWrite) return { Q, res };
    const w = cur ? await MS.setJSON(key, Q, { onlyIfMatch: cur.etag }) : await MS.setJSON(key, Q, { onlyIfNew: true });
    if (w.modified) return { Q, res };
  }
  return { error: "The game server is busy. Try again.", status: 503 };
}
// the away team, with any name the home team already uses changed a little (the box score keys on names)
function qAway(t, home) {
  const taken = new Set(home.lineup.map(n => n.toLowerCase())), lineup = [], ab = {}, info = {};
  for (const n of t.lineup) { let m = n, k = 1; while (taken.has(m.toLowerCase())) m = `${n.slice(0, 19)} ${++k}`; taken.add(m.toLowerCase()); lineup.push(m); ab[m] = t.ab[n]; info[m] = t.info[n]; }
  const name = t.name.toLowerCase() === home.name.toLowerCase() ? `${t.name.slice(0, 25)} 2` : t.name, abbr = t.abbr === home.abbr ? t.abbr.slice(0, 3) + "2" : t.abbr;
  return { ...t, name, abbr, lineup, ab, info };
}
async function quick(b) {
  const S = store(), MS = mstore(), op = b.op, mode = MODES.has(b.mode) ? b.mode : "sim", gv = GV(b), key = qKey(mode, gv);
  const id = String(b.id || ""), tok = String(b.tok || "");
  if (op === "qfind") {
    const name = cleanStr(b.name, 16), pid = PID.test(b.pid || "") ? b.pid : "", cid = /^[a-z0-9]{16}$/.test(b.cid || "") ? b.cid : "";
    if (name.length < 1 || RUDE.test(name.replace(/[^a-z]/gi, ""))) return reply({ error: "Pick a different name." }, 400);
    const T = b.teams && typeof b.teams === "object" ? b.teams : {}, red = cleanTeam(T.red), blue = cleanTeam(T.blue);
    if (!red || red.id !== "red" || !blue || blue.id !== "blue") return reply({ error: "Something's wrong with your team. Check the names and try again." }, 400);
    let code = ""; // the room for the game, if there's someone to play: a code nobody is using
    for (let i = 0; i < 12 && !code; i++) { const c = newCode(); if (!(await S.getMetadata(c))) code = c; }
    if (!code) return reply({ error: "Couldn't start a game. Try again." }, 503);
    const myId = token(), myTok = token(), hostTok = token();
    const u = await qUpdate(MS, key, (Q, now) => {
      Q.t = Q.t.filter(x => x.m || !(cid && x.cid === cid && now - x.seen > 20000)); // this device looking again: an old place in line it stopped checking on goes
      const o = Q.t.find(x => !x.m && (!pid || x.pid !== pid) && (!cid || x.cid !== cid)); // whoever has waited longest (never yourself)
      if (!o) { Q.t.push({ id: myId, tok: myTok, name, pid, cid, red, at: now, seen: now }); return { wait: true }; }
      o.m = { code, tok: hostTok, at: now, opp: name };
      Q.r = (Q.r || []).filter(t => now - t < 3600000).concat(now); // games started in the last hour
      return { match: { id: o.id, name: o.name, pid: o.pid, cid: o.cid, red: o.red } };
    });
    if (u.error) return reply({ error: u.error }, u.status || 400);
    if (u.res.wait) return reply({ wait: true, id: myId, tok: myTok, ...(await qCounts(MS, mode, gv, u.Q)) });
    const o = u.res.match, now = Date.now();
    const R = { v: 1, code, at: now, upd: now, seed: new Uint32Array(rand(4).buffer)[0], mode, host: 1, gv, qm: 1,
      p: [{ name, team: qAway(blue, o.red), tok: myTok, pid, cid }, { name: o.name, team: o.red, tok: hostTok, pid: o.pid, cid: o.cid }],
      log: [{ i: 0, s: 0, k: "join", g: 0 }], seen: [now, 0] }; // (the home team's check-in says they've arrived)
    const w = await S.setJSON(code, R, { onlyIfNew: true, metadata: { n: 1, upd: now } });
    if (!w.modified) { // someone took the code a moment ago: the other player goes back in line, and this one looks again
      await qUpdate(MS, key, Q => { const x = Q.t.find(t => t.id === o.id); if (!x) return { noWrite: true }; delete x.m; x.seen = Date.now(); });
      return reply({ error: "Couldn't start the game. Trying again…", retry: true }, 503);
    }
    return reply({ match: true, tok: myTok, side: 0, ...roomOut(R, 0, true) });
  }
  if (!TOK.test(id) || !TOK.test(tok)) return reply({ error: "Bad request." }, 400);
  if (op === "qwait" && b.cv >= 2) { // still looking: a quick check-in (the game checks in again a few seconds later)
    const v = await qUpdate(MS, key, (Q, now) => {
      const y = Q.t.find(t => t.id === id && t.tok === tok);
      if (!y) return { noWrite: true, gone: true };
      if (y.m) { Q.t = Q.t.filter(t => t !== y); return { match: y.m }; }
      y.seen = now;
    });
    if (v.error) return reply({ error: v.error }, v.status || 400);
    if (v.res && v.res.gone) return reply({ gone: true });
    if (v.res && v.res.match) { const m = v.res.match; return reply({ match: true, code: m.code, tok: m.tok, side: 1, opp: m.opp }); }
    return reply({ wait: true, ...(await qCounts(MS, mode, gv, v.Q)) });
  }
  if (op === "qwait") { // (older copies of the game) still looking: waits here up to a few seconds for a match
    const end = Date.now() + QWAIT; let first = true;
    for (;;) {
      const Q = (await MS.get(key, { type: "json" })) || { t: [] }, now = Date.now(), x = (Q.t || []).find(t => t.id === id && t.tok === tok);
      if (!x || (!x.m && now - x.seen > QFRESH)) return reply({ gone: true });
      if (x.m) { await qUpdate(MS, key, Q2 => { Q2.t = Q2.t.filter(t => t.id !== id); }); return reply({ match: true, code: x.m.code, tok: x.m.tok, side: 1, opp: x.m.opp }); }
      if (first && now - x.seen > 2000) { // the check-in
        first = false;
        const v = await qUpdate(MS, key, Q2 => { const y = Q2.t.find(t => t.id === id && t.tok === tok); if (!y) return { noWrite: true, gone: true }; if (y.m) return { noWrite: true }; y.seen = Date.now(); });
        if (v.res && v.res.gone) return reply({ gone: true });
        continue; // (look again right away: a match may have come in)
      }
      first = false;
      if (now >= end) return reply({ wait: true, n: Math.max(0, qLive(Q, now) - 1) });
      await sleep(450);
    }
  }
  if (op === "qleave") { // stops looking; if a match came in at that very moment, the other player hears they left
    let m = null;
    await qUpdate(MS, key, Q => { const x = Q.t.find(t => t.id === id && t.tok === tok); if (!x) return { noWrite: true }; m = x.m || null; Q.t = Q.t.filter(t => t !== x); });
    if (m) await update(S, m.code, R => { R.log.push({ i: R.log.length, s: 1, k: "leave", g: 0 }); }).catch(() => {});
    return reply({ ok: true });
  }
  return reply({ error: "Bad request." }, 400);
}
// for someone in line: how many others are looking with the same rules, with the other rules, and games in the last hour
async function qCounts(MS, mode, gv, Q) {
  const now = Date.now(), other = mode === "sim" ? "arcade" : "sim", O = (await MS.get(qKey(other, gv), { type: "json" })) || { t: [] };
  const hour = [...(Q.r || []), ...(O.r || [])].filter(t => now - t < 3600000).length;
  return { n: Math.max(0, qLive(Q, now) - 1), other: qLive({ t: O.t || [] }, now), hour };
}
// how many people are looking for a game right now, and how many quick-match games started in the last hour
async function quickCount(q) {
  const MS = mstore(), gv = GV({ gv: parseInt(q.get("gv") || "1", 10) }), now = Date.now(), out = { hour: 0 };
  for (const m of MODES) { const Q = (await MS.get(qKey(m, gv), { type: "json" })) || { t: [] }; out[m] = qLive({ t: Q.t || [] }, now); out.hour += (Q.r || []).filter(t => now - t < 3600000).length; }
  out.allowance = await share().catch(() => null); // how much of the server's monthly allowance this month has used
  return reply(out);
}

export const config = { path: "/api/online" };
