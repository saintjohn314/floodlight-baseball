// Online games: two people play a quick game over the internet, each managing their own team.
// The server keeps only the ordered list of moves for each game (a "room", found by a 4-character code). Both players'
// games start from the same dice seed and replay the same moves in the same order, so they stay in step. Anyone else
// with the code can watch. Rooms live in Netlify Blobs and are cleared a few days after the last move.
//
// POST /api/online {op:"create", name, team, mode}       -> {code, tok, side:1, seed, mode}   (whoever invites is home)
// POST /api/online {op:"join", code, name, team}          -> {tok, side:0, ...room}             (or {full:true})
// POST /api/online {op:"send", code, tok, e, since}       -> {i, ...room with the moves after `since`}
// GET  /api/online?code=ABCD&since=N&wait=7&tok=...       -> the room and its moves after N (waits up to `wait` seconds for new ones)
import { getStore } from "@netlify/blobs";

const HEAD = { "content-type": "application/json", "cache-control": "no-store", "access-control-allow-origin": "*", "access-control-allow-methods": "GET, POST, OPTIONS", "access-control-allow-headers": "content-type" };
const reply = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: HEAD });
const CODE_CH = "BCDFGHJKMNPQRSTVWXZ23456789"; // no vowels (no words), nothing that looks like another character
const CODE = /^([BCDFGHJKMNPQRSTVWXZ2-9]{4}|L[A-Z0-9-]{6,56})$/, LCODE = /^[BCDFGHJKMNPQRSTVWXZ2-9]{4}$/, TOK = /^[a-f0-9]{24}$/, PID = /^[a-z0-9]{16}$/;
const KINDS = new Set(["roll", "card", "dh", "ab", "ans", "say", "go", "leave"]);
const MODES = new Set(["sim", "arcade"]);
const ABS = /^[A-Z]{3}$/, CARDS = /^[A-Z]{2,3}$/;
const MAX_LOG = 6000, TTL = 4 * 24 * 3600 * 1000, SEEN_EVERY = 15000;
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
  return { id, name, abbr, color, logo, lineup, ab, info };
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

export default async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: HEAD });
  const S = store();
  if (req.method === "GET" && new URL(req.url).searchParams.get("lg")) return leagueGet(new URL(req.url).searchParams);
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
  if (/^lg/.test(String(b.op))) return league(b);

  if (b.op === "create") {
    const name = cleanStr(b.name, 16), team = cleanTeam(b.team), mode = MODES.has(b.mode) ? b.mode : "sim", pid = PID.test(b.pid || "") ? b.pid : "";
    if (name.length < 1 || RUDE.test(name.replace(/[^a-z]/gi, ""))) return reply({ error: "Pick a different name." }, 400);
    if (!team) return reply({ error: "Something's wrong with your team. Check the names and try again." }, 400);
    const now = Date.now(), tok = token();
    const R = { v: 1, code: "", at: now, upd: now, seed: new Uint32Array(rand(4).buffer)[0], mode, host: 1, p: [null, { name, team, tok, pid }], log: [], seen: [0, now] };
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
    const key = String(b.key || "").toUpperCase().replace(/[^A-Z0-9-]/g, "").slice(0, 40), side = b.side === 0 || b.side === 1 ? b.side : -1;
    const L = await S.get(code, { type: "json" }), m = L && lgMember(L, tok);
    if (!m) return reply({ error: "Not your franchise." }, 403);
    if (!key || side < 0) return reply({ error: "Bad game." }, 400);
    const rc = "L" + code + "-" + key, RS = store(), team = cleanTeam(b.team, true), other = b.other ? cleanTeam(b.other, true) : null;
    const cpu = Array.isArray(b.cpu) ? [!!b.cpu[0], !!b.cpu[1]] : [false, false];
    if (!team) return reply({ error: "Something's wrong with your team." }, 400);
    if (cpu[1 - side] && !other) return reply({ error: "Something's wrong with the other team." }, 400);
    const now = Date.now();
    if (!(await RS.getMetadata(rc))) {
      const R = { v: 1, code: rc, at: now, upd: now, seed: new Uint32Array(rand(4).buffer)[0], mode: "sim", host: side, p: [null, null], log: [], seen: [0, 0], kind: "lg", lg: code, cpu, lvl: ["rookie", "pro", "allstar"].includes(b.lvl) ? b.lvl : "pro", label: cleanStr(b.label, 60), fkind: b.fkind === "po" ? "po" : "reg" };
      if (cpu[1 - side]) R.p[1 - side] = { name: other.name, team: other, cpu: true };
      await RS.setJSON(rc, R, { onlyIfNew: true, metadata: { n: 0, upd: now } });
    }
    let mineTok = "";
    const u = await update(RS, rc, R => {
      const cur = R.p[side];
      if (cur && cur.cpu) return { error: "That side is the computer's.", status: 409 };
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

export const config = { path: "/api/online" };
