'use strict';

/**
 * TrackStat v2 — zero-dependency server for the Anime Adventures tracker.
 *
 * Keep the original public contract so the existing Lua loader keeps working:
 *   POST /api/report   { key, pc, user, userId, place, flat, items, meta }
 *   GET  /api/state
 *   GET  /main.lua     (returns main.lua with the public URL baked in)
 *   POST /api/delete
 *
 * Extra hardening in v2:
 *   - per-field last-good merging (a single 0 can no longer wipe a balance)
 *   - transient-zero strike counter (3 consecutive zeroes required)
 *   - validated item counts, no stale-profile overwrite from the Lua side
 *   - server-side metric computation (one source of truth for the dashboard)
 *   - atomic JSON persistence, stable KEY via env, history snapshots
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ROOT = __dirname;
const DATA_DIR = String(process.env.DATA_DIR || ROOT);
const DB_FILE = path.join(DATA_DIR, 'data.json');
const LUA_FILE = path.join(ROOT, 'main.lua');
const HTML_FILE = path.join(ROOT, 'index.html');

const VERSION = '2.0.0';
const PORT = Number(process.env.PORT || 3000);
const HOST = process.env.HOST || '0.0.0.0';
const FIXED_KEY = String(process.env.KEY || process.env.TRACKSTAT_KEY || '').trim();
const ONLINE_MS = Number(process.env.ONLINE_MS || 120000);
const HISTORY_LIMIT = Number(process.env.HISTORY_LIMIT || 120);
const MAX_BODY = 8 * 1024 * 1024;
const ZERO_STRIKES = 3;

const LOBBY_PLACES = new Set(
  [8304191830].concat(String(process.env.LOBBY_PLACES || '').split(',').map((x) => Number(x.trim())).filter(Boolean))
);

// --- Lưu trữ bền vững (tuỳ chọn) -----------------------------------------
// Render free-tier có filesystem tạm: data.json có thể mất khi restart.
// Đặt 1 trong 2 cấu hình sau để tự động sync ra kho lưu trữ ngoài:
//   A) Upstash Redis REST: UPSTASH_REDIS_REST_URL + UPSTASH_REDIS_REST_TOKEN
//   B) JSON REST (Firebase/JSONBin/...): DATA_URL (+ DATA_TOKEN, DATA_HEADER, DATA_METHOD)
const UPSTASH_URL = String(process.env.UPSTASH_REDIS_REST_URL || '').trim();
const UPSTASH_TOKEN = String(process.env.UPSTASH_REDIS_REST_TOKEN || '').trim();
const DATA_URL = String(process.env.DATA_URL || '').trim();
const DATA_TOKEN = String(process.env.DATA_TOKEN || '').trim();
const DATA_HEADER = String(process.env.DATA_HEADER || 'Authorization').trim();
const DATA_METHOD = String(process.env.DATA_METHOD || 'PUT').toUpperCase();
const DATA_KEY = String(process.env.DATA_KEY || 'trackstat:db').trim();
const DATA_SAVE_MS = Math.max(5000, Number(process.env.DATA_SAVE_MS || 15000));
const REMOTE_MODE = UPSTASH_URL && UPSTASH_TOKEN ? 'upstash' : (DATA_URL ? 'json' : 'none');

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, x-api-key',
  'Access-Control-Max-Age': '86400',
};

/* ------------------------------------------------------------------ */
/* helpers                                                             */
/* ------------------------------------------------------------------ */

const now = () => Date.now();
const isObj = (v) => Boolean(v) && typeof v === 'object' && !Array.isArray(v);
const isNum = (v) => typeof v === 'number' && Number.isFinite(v);
const clamp = (n, a, b) => Math.min(b, Math.max(a, n));
const short = (v, n = 80) => String(v == null ? '' : v).slice(0, n);

function json(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
    ...CORS,
  });
  res.end(body);
}

function text(res, status, body, type = 'text/plain') {
  const data = String(body);
  res.writeHead(status, {
    'Content-Type': type + '; charset=utf-8',
    'Content-Length': Buffer.byteLength(data),
    'Cache-Control': 'no-store',
    ...CORS,
  });
  res.end(data);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY) {
        reject(Object.assign(new Error('Payload quá lớn'), { statusCode: 413 }));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

async function readJson(req) {
  const raw = await readBody(req);
  if (!raw.trim()) return {};
  try {
    const parsed = JSON.parse(raw);
    return isObj(parsed) ? parsed : {};
  } catch (_) {
    return {};
  }
}

/* ------------------------------------------------------------------ */
/* persistence                                                         */
/* ------------------------------------------------------------------ */

let db = { version: 2, createdAt: now(), key: '', accounts: {} };
let saveTimer = null;
let loadedKey = '';
let remoteDirty = false;
let remoteSaving = false;
let remoteStatus = REMOTE_MODE === 'none' ? 'disabled' : 'idle';
let lastRemoteSave = 0;
let remoteTimer = null;
let keyPersistent = false;

function normalizeDb(parsed) {
  if (!isObj(parsed)) return null;
  let obj = parsed;
  if (isObj(obj.data)) obj = obj.data;
  if (isObj(obj.record)) obj = obj.record;
  if (isObj(obj.result)) {
    if (typeof obj.result === 'string') {
      try { obj = JSON.parse(obj.result); } catch (_) { return null; }
    } else obj = obj.result;
  }
  if (!isObj(obj)) return null;
  return {
    version: 2,
    createdAt: obj.createdAt || now(),
    key: String(obj.key || ''),
    accounts: isObj(obj.accounts) ? obj.accounts : {},
  };
}

function readLocalDb() {
  try {
    if (!fs.existsSync(DB_FILE)) return null;
    return normalizeDb(JSON.parse(fs.readFileSync(DB_FILE, 'utf8')));
  } catch (err) {
    console.error('[db] Không đọc được data.json:', err.message);
    try {
      const backup = DB_FILE + '.broken-' + Date.now();
      fs.copyFileSync(DB_FILE, backup);
      console.error('[db] Đã sao lưu bản lỗi:', backup);
    } catch (_) {}
    return null;
  }
}

function authHeader() {
  if (!DATA_TOKEN) return {};
  const value = /authorization/i.test(DATA_HEADER) ? 'Bearer ' + DATA_TOKEN : DATA_TOKEN;
  return { [DATA_HEADER]: value };
}

async function remoteGet() {
  if (REMOTE_MODE === 'upstash') {
    const res = await fetch(UPSTASH_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + UPSTASH_TOKEN },
      body: JSON.stringify(['GET', DATA_KEY]),
    });
    if (!res.ok) throw new Error('Upstash GET HTTP ' + res.status);
    const out = await res.json();
    return typeof out.result === 'string' ? JSON.parse(out.result) : out.result;
  }
  const res = await fetch(DATA_URL, { method: 'GET', headers: authHeader() });
  if (!res.ok) throw new Error('Remote GET HTTP ' + res.status);
  const raw = await res.text();
  if (!raw.trim() || raw.trim() === 'null') return null;
  return JSON.parse(raw);
}

async function remoteSet() {
  const payload = JSON.stringify(db);
  if (REMOTE_MODE === 'upstash') {
    const res = await fetch(UPSTASH_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + UPSTASH_TOKEN },
      body: JSON.stringify(['SET', DATA_KEY, payload]),
    });
    if (!res.ok) throw new Error('Upstash SET HTTP ' + res.status + ' ' + (await res.text()).slice(0, 120));
    return;
  }
  const res = await fetch(DATA_URL, {
    method: DATA_METHOD,
    headers: { 'Content-Type': 'application/json', ...authHeader() },
    body: payload,
  });
  if (!res.ok) throw new Error('Remote ' + DATA_METHOD + ' HTTP ' + res.status + ' ' + (await res.text()).slice(0, 120));
}

function saveLocalNow() {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    const tmp = DB_FILE + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(db));
    try { fs.renameSync(tmp, DB_FILE); }
    catch (_) { fs.writeFileSync(DB_FILE, JSON.stringify(db)); try { fs.unlinkSync(tmp); } catch (__) {} }
  } catch (err) {
    console.error('[db] Không ghi được data.json:', err.message);
  }
}

async function saveRemoteNow(force) {
  if (REMOTE_MODE === 'none' || remoteSaving || (!remoteDirty && !force)) return false;
  remoteSaving = true;
  try {
    await remoteSet();
    remoteDirty = false;
    remoteStatus = 'ok';
    lastRemoteSave = now();
    return true;
  } catch (err) {
    remoteStatus = 'error';
    console.error('[remote] Không lưu được:', err.message);
    return false;
  } finally {
    remoteSaving = false;
  }
}

function scheduleSave() {
  if (saveTimer) return;
  saveTimer = setTimeout(() => { saveTimer = null; saveLocalNow(); }, 200);
  if (REMOTE_MODE !== 'none') remoteDirty = true;
}

function startRemoteTimer() {
  if (REMOTE_MODE === 'none') return;
  remoteTimer = setInterval(() => { saveRemoteNow(false); }, DATA_SAVE_MS);
}

function storageInfo() {
  return {
    mode: REMOTE_MODE === 'none' ? 'local' : REMOTE_MODE,
    enabled: REMOTE_MODE !== 'none',
    status: remoteStatus,
    lastSave: lastRemoteSave || null,
    intervalMs: REMOTE_MODE === 'none' ? null : DATA_SAVE_MS,
    pending: remoteDirty,
  };
}

async function initDb() {
  const local = readLocalDb();
  let remote = null;

  if (REMOTE_MODE !== 'none') {
    try {
      remote = normalizeDb(await remoteGet());
      remoteStatus = remote ? 'ok' : 'idle';
      if (remote) console.log('[remote] Đã tải dữ liệu từ kho lưu trữ đám mây.');
    } catch (err) {
      remoteStatus = 'error';
      console.error('[remote] Không tải được, dùng data.json local:', err.message);
    }
  }

  const localAccounts = local ? Object.keys(local.accounts).length : 0;
  const remoteAccounts = remote ? Object.keys(remote.accounts).length : 0;
  if (remote && (remoteAccounts > 0 || (localAccounts === 0 && remote.key))) db = remote;
  else if (local) db = local;
  else if (remote) db = remote;

  loadedKey = db.key;
  if (FIXED_KEY) db.key = FIXED_KEY;
  if (!db.key) db.key = crypto.randomUUID();
  keyPersistent = Boolean(FIXED_KEY) || Boolean(loadedKey) || REMOTE_MODE !== 'none';
  remoteDirty = REMOTE_MODE !== 'none';
  scheduleSave();
  startRemoteTimer();
}

/* ------------------------------------------------------------------ */
/* metric definitions — dashboard and ingest share these               */
/* ------------------------------------------------------------------ */

const METRICS = [
  { key: 'level', label: 'Level', icon: '⭐', exact: ['Profile.Level', '_stats.level', '_stats.Level', 'Profile.level', 'Profile.player_level', 'Profile.level_data.level'], max: 5000 },
  { key: 'gems', label: 'Gems', icon: '💎', exact: ['Profile.gem_amount', '_stats.gem_amount', 'Profile.gems', '_stats.gems'] },
  { key: 'gold', label: 'Gold', icon: '🪙', exact: ['Profile.gold_amount', '_stats.gold_amount', 'Profile.gold', '_stats.gold', 'Profile.coins'] },
  { key: 'pearls', label: 'Summer Pearls', icon: '🦪', test: (k) => /pearl/i.test(k) && !/limited/i.test(k) },
  { key: 'rerolls', label: 'Reroll', icon: '🎲', test: (k) => /^reroll_stat|reroll.*stat|^_stats\.reroll$/i.test(k) },
  { key: 'rerollTokens', label: 'Token Reroll', icon: '🔁', test: (k) => /trait_reroll_tokens|reroll.*token|reroll.*ticket/i.test(k) },
  { key: 'starRemnant', label: 'Star Remnant', icon: '✨', test: (k) => /star.*remnant/i.test(k) && !/limit/i.test(k) },
  { key: 'starRemnantLimited', label: 'Star Remnant (L)', icon: '🌟', test: (k) => /(limit.*star.*remnant|star.*remnant.*limit)/i.test(k) },
];

function contextOf(place, meta) {
  if (isObj(meta) && typeof meta.inLobby === 'boolean') return meta.inLobby ? 'lobby' : 'match';
  const id = Number(place) || 0;
  return LOBBY_PLACES.has(id) ? 'lobby' : 'match';
}

function pickMetric(account, def) {
  const flat = isObj(account.flat) ? account.flat : {};
  const items = isObj(account.items) ? account.items : {};
  const candidates = [];

  if (Array.isArray(def.exact)) {
    for (const key of def.exact) {
      if (isNum(flat[key])) candidates.push({ value: flat[key], source: key });
    }
  }
  if (typeof def.test === 'function') {
    for (const [key, value] of Object.entries(flat)) {
      if (isNum(value) && def.test(key)) candidates.push({ value, source: key });
    }
    for (const [key, value] of Object.entries(items)) {
      if (isNum(value) && def.test(key)) candidates.push({ value, source: 'Item.' + key });
    }
  }

  let best = null;
  for (const c of candidates) {
    if (c.value < 0) continue;
    if (def.max && c.value > def.max) continue;
    if (!best || c.value > best.value) best = c;
  }
  return best || { value: 0, source: null };
}

function computeMetrics(account) {
  const metrics = {};
  const sources = {};
  for (const def of METRICS) {
    const picked = pickMetric(account, def);
    metrics[def.key] = picked.value;
    if (picked.source) sources[def.key] = picked.source;
  }
  const items = isObj(account.items) ? account.items : {};
  metrics.itemKinds = Object.keys(items).length;
  metrics.itemTotal = Object.values(items).reduce((sum, v) => sum + (isNum(v) ? v : 0), 0);
  metrics.values = Object.keys(isObj(account.flat) ? account.flat : {}).length;
  return { metrics, sources };
}

/* ------------------------------------------------------------------ */
/* ingest merging — the core of the "wrong level / random 0" fix        */
/* ------------------------------------------------------------------ */

function mergeFlat(prevFlat, incoming, strikes) {
  const out = { ...(isObj(prevFlat) ? prevFlat : {}) };
  const nextStrikes = { ...(isObj(strikes) ? strikes : {}) };
  let changed = false;

  for (const [rawKey, rawValue] of Object.entries(isObj(incoming) ? incoming : {})) {
    const key = short(rawKey, 120);
    if (!key) continue;

    if (typeof rawValue === 'boolean') {
      if (out[key] !== rawValue) changed = true;
      out[key] = rawValue;
      nextStrikes[key] = 0;
      continue;
    }
    if (typeof rawValue === 'string') {
      const s = rawValue.trim();
      if (!s) continue;
      if (/^0+$/.test(s) && isNum(out[key]) && out[key] > 0) {
        nextStrikes[key] = (nextStrikes[key] || 0) + 1;
        if (nextStrikes[key] < ZERO_STRIKES) continue;
      } else {
        nextStrikes[key] = 0;
      }
      if (out[key] !== s) changed = true;
      out[key] = s;
      continue;
    }
    if (!isNum(rawValue)) continue;
    if (rawValue < 0 || rawValue === Infinity || rawValue === -Infinity) continue;
    // Level vô lý (do quét nhầm field/hàm) không được ghi đè bản đã kiểm chứng.
    if (/level/i.test(key) && (rawValue < 1 || rawValue > 5000)) continue;

    if (rawValue === 0 && isNum(out[key]) && out[key] > 0) {
      nextStrikes[key] = (nextStrikes[key] || 0) + 1;
      if (nextStrikes[key] < ZERO_STRIKES) continue;
    } else if (rawValue !== 0) {
      nextStrikes[key] = 0;
    }

    if (out[key] !== rawValue) changed = true;
    out[key] = rawValue;
  }

  return { flat: out, strikes: nextStrikes, changed };
}

function mergeItems(prevItems, incoming) {
  const out = { ...(isObj(prevItems) ? prevItems : {}) };
  if (!isObj(incoming) || !Object.keys(incoming).length) return { items: out, changed: false };
  let changed = false;
  for (const [rawKey, rawValue] of Object.entries(incoming)) {
    const key = short(rawKey, 120);
    const n = Number(rawValue);
    if (!key || !Number.isFinite(n) || n < 0) continue;
    // Một item về 0 trong lúc teleport không được xoá bản đã lưu.
    if (n === 0 && isNum(out[key]) && out[key] > 0) continue;
    if (out[key] !== n) changed = true;
    out[key] = n;
  }
  return { items: out, changed };
}

function pushHistory(account, metrics, at) {
  const list = Array.isArray(account.history) ? account.history.slice() : [];
  list.push({
    t: at,
    level: metrics.level,
    gems: metrics.gems,
    pearls: metrics.pearls,
    star: metrics.starRemnant,
    starL: metrics.starRemnantLimited,
    items: metrics.itemKinds,
    ctx: account.context,
  });
  while (list.length > HISTORY_LIMIT) list.shift();
  account.history = list;
}

function publicAccount(account) {
  const { metrics, sources } = computeMetrics(account);
  return {
    user: account.user,
    userId: account.userId || null,
    pc: account.pc || 'NO-PC',
    place: account.place || null,
    first: account.first,
    seen: account.seen,
    updates: account.updates || 0,
    context: account.context || 'unknown',
    online: now() - (account.seen || 0) < ONLINE_MS,
    flat: account.flat || {},
    items: account.items || {},
    metrics,
    sources,
    lastGoodAt: account.lastGoodAt || account.first,
    lastItemAt: account.lastItemAt || account.first,
    zeroStrikes: account.zeroStrikes || {},
    history: Array.isArray(account.history) ? account.history.slice(-40) : [],
  };
}

/* ------------------------------------------------------------------ */
/* routes                                                              */
/* ------------------------------------------------------------------ */

async function handleReport(req, res, query) {
  const body = await readJson(req);
  const keyOk = body.key === db.key || String(req.headers['x-api-key'] || '') === db.key;
  if (!keyOk || !body.user) {
    return json(res, 401, { ok: 0, error: !body.user ? 'Thiếu tên tài khoản' : 'Sai key — copy key mới từ server/Render logs' });
  }

  const user = short(body.user, 80);
  const at = now();
  const context = contextOf(body.place, body.meta);
  const existing = isObj(db.accounts[user]) ? db.accounts[user] : null;
  const account = existing || {
    user, first: at, flat: {}, items: {}, strikes: {}, history: [], updates: 0,
  };

  const flatResult = mergeFlat(account.flat, body.flat, account.strikes);
  const itemResult = mergeItems(account.items, body.items);

  account.user = user;
  account.userId = body.userId || account.userId || null;
  account.pc = short(body.pc || 'NO-PC', 60);
  account.place = body.place || null;
  account.context = context;
  account.seen = at;
  account.flat = flatResult.flat;
  account.strikes = flatResult.strikes;
  account.items = itemResult.items;
  account.updates = (account.updates || 0) + 1;
  if (flatResult.changed) account.lastGoodAt = at;
  if (itemResult.changed) account.lastItemAt = at;

  const metrics = computeMetrics(account).metrics;
  pushHistory(account, metrics, at);
  db.accounts[user] = account;
  scheduleSave();

  return json(res, 200, {
    ok: 1,
    serverTime: at,
    revision: account.updates,
    context,
    needFull: Object.keys(account.items).length === 0,
    keyPersistent,
  });
}

function serverUrlFrom(req) {
  const host = String(req.headers['x-forwarded-host'] || req.headers.host || 'localhost:' + PORT).split(',')[0].trim();
  const forward = String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim();
  const proto = forward || (/onrender\.com|railway\.app|fly\.dev/i.test(host) ? 'https' : 'http');
  return proto + '://' + host;
}

function aggregate(accounts) {
  const out = { accounts: accounts.length, online: 0, pcs: {}, metrics: {}, itemKinds: 0 };
  for (const def of METRICS) out.metrics[def.key] = { total: 0, with: 0, max: 0 };
  for (const a of accounts) {
    if (a.online) out.online += 1;
    out.pcs[a.pc] = (out.pcs[a.pc] || 0) + 1;
    out.itemKinds += a.metrics.itemKinds || 0;
    for (const def of METRICS) {
      const v = a.metrics[def.key] || 0;
      const slot = out.metrics[def.key];
      slot.total += v;
      slot.max = Math.max(slot.max, v);
      if (v > 0) slot.with += 1;
    }
  }
  return out;
}

function handleApi(req, res, url) {
  const p = url.pathname.replace(/\/+$/, '') || '/';

  if (p === '/api/report' && req.method === 'POST') return handleReport(req, res, url);

  if (p === '/api/state' && req.method === 'GET') {
    const accounts = Object.values(db.accounts)
      .map(publicAccount)
      .sort((a, b) => b.seen - a.seen);
    return json(res, 200, {
      now: now(),
      version: VERSION,
      keyPersistent,
      storage: storageInfo(),
      onlineMs: ONLINE_MS,
      metrics: METRICS.map((m) => ({ key: m.key, label: m.label, icon: m.icon })),
      stats: aggregate(accounts),
      accounts,
    });
  }

  if (p === '/api/health' && req.method === 'GET') {
    return json(res, 200, {
      ok: true,
      version: VERSION,
      time: now(),
      accounts: Object.keys(db.accounts).length,
      keyPersistent,
      storage: storageInfo(),
      uptimeMs: now() - STARTED_AT,
    });
  }

  if (p === '/api/save' && (req.method === 'POST' || req.method === 'GET')) {
    return saveRemoteNow(true).then((ok) => json(res, ok ? 200 : 503, {
      ok,
      storage: storageInfo(),
    }));
  }

  if (p === '/api/export' && req.method === 'GET') {
    const data = JSON.stringify(db, null, 2);
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    res.writeHead(200, {
      'Content-Type': 'application/json; charset=utf-8',
      'Content-Disposition': `attachment; filename="trackstat-${stamp}.json"`,
      'Content-Length': Buffer.byteLength(data),
      ...CORS,
    });
    return res.end(data);
  }

  if (p === '/api/delete' && req.method === 'POST') {
    return readJson(req).then((body) => {
      const users = Array.isArray(body.users) ? body.users : [];
      for (const u of users) delete db.accounts[String(u)];
      scheduleSave();
      return json(res, 200, { ok: 1, deleted: users.length });
    });
  }

  return json(res, 404, { ok: 0, error: 'API không tồn tại' });
}

const STARTED_AT = now();

const server = http.createServer((req, res) => {
  let url;
  try { url = new URL(req.url, 'http://' + (req.headers.host || 'localhost')); }
  catch (_) { return text(res, 400, 'Bad request'); }

  if (req.method === 'OPTIONS') {
    res.writeHead(204, CORS);
    return res.end();
  }

  if (url.pathname.startsWith('/api/')) {
    return Promise.resolve(handleApi(req, res, url)).catch((err) => {
      console.error('[api]', err);
      if (!res.headersSent) json(res, 500, { ok: 0, error: err.message });
      else res.end();
    });
  }

  if (url.pathname === '/main.lua' || url.pathname === '/script/main.lua') {
    try {
      const source = fs.readFileSync(LUA_FILE, 'utf8')
        .replace(/%%SERVER_URL%%/g, serverUrlFrom(req));
      return text(res, 200, source, 'text/plain');
    } catch (err) {
      return text(res, 500, 'Không đọc được main.lua: ' + err.message);
    }
  }

  if (url.pathname === '/' || url.pathname === '/index.html') {
    try { return text(res, 200, fs.readFileSync(HTML_FILE, 'utf8'), 'text/html'); }
    catch (err) { return text(res, 500, 'Không đọc được index.html: ' + err.message); }
  }

  return text(res, 404, 'Not found');
});

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') console.error(`\n[!] Port ${PORT} đang được dùng. Đổi PORT=rồi khởi động lại.\n`);
  else console.error('[server]', err);
  process.exit(1);
});

async function start() {
  await initDb();
  server.listen(PORT, HOST, () => {
    const st = storageInfo();
    console.log('\n  TrackStat v' + VERSION + ' đang chạy');
    console.log('  Dashboard : http://localhost:' + PORT);
    console.log('  Lua       : http://localhost:' + PORT + '/main.lua');
    console.log('  API       : http://localhost:' + PORT + '/api/state');
    console.log('  Lưu trữ   : ' + (st.enabled
      ? st.mode + ' (' + st.status + ', sync mỗi ' + Math.round(st.intervalMs / 1000) + 's)'
      : 'data.json local'));
    console.log('  KEY       : ' + db.key);
    if (!keyPersistent) {
      console.log('  [!] KEY chưa được cố định. Trên Render hãy đặt biến môi trường KEY');
      console.log('      nếu không key sẽ đổi mỗi khi app restart.');
    }
    console.log('');
  });
}

async function shutdown() {
  clearTimeout(saveTimer);
  if (remoteTimer) clearInterval(remoteTimer);
  saveLocalNow();
  if (REMOTE_MODE !== 'none') {
    try { await Promise.race([saveRemoteNow(true), new Promise((r) => setTimeout(r, 1500))]); }
    catch (_) {}
  }
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 1800);
}
process.on('SIGINT', () => { shutdown(); });
process.on('SIGTERM', () => { shutdown(); });
process.on('uncaughtException', (err) => { console.error('[uncaught]', err); saveLocalNow(); });

start().catch((err) => { console.error('[start]', err); process.exit(1); });
