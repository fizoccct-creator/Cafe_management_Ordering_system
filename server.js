'use strict';
/* CafeFlow server. Runs either
   - on a computer in the café:  node server.js        (data in ./data, devices on the café Wi-Fi), or
   - in the cloud (e.g. Render): DATABASE_URL=postgres://…  (data in Postgres, reachable from anywhere).
   Serves the staff app and the customer QR ordering page, and keeps every device in sync live.

   Environment variables (all optional):
     PORT          port to listen on (default 8080)
     DATABASE_URL  Postgres connection string → use Postgres instead of local files
     DATA_DIR      folder for local files (default ./data)
     PUBLIC_URL    public address used in QR codes, e.g. https://mycafe.onrender.com
                   (Render's RENDER_EXTERNAL_URL is used automatically)
     STAFF_PIN     first staff PIN (4–8 digits) when no PIN exists yet; otherwise a random one is made
     TRUST_PROXY   set to 1 behind a hosting proxy (automatic on Render) */
const http = require('http');
const os = require('os');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { applyOp, seed, uid } = require('./shared.js');
const { createStore } = require('./storage.js');

const PORT = Number(process.env.PORT) || 8080;
const ROOT = __dirname;
const PUBLIC_URL = (process.env.PUBLIC_URL || process.env.RENDER_EXTERNAL_URL || '').replace(/\/+$/, '');
const TRUST_PROXY = process.env.TRUST_PROXY ? process.env.TRUST_PROXY !== '0' : !!process.env.RENDER;
const HTTPS = PUBLIC_URL.startsWith('https://');
const KEEP_DAYS = 90;      // order history kept on the server
const CLIENT_HOURS = 36;   // order history sent to staff devices (they only show today)
const MAX_TABLES = 200;
const OPS = new Set(['addOrder', 'status', 'line', 'avail', 'menu', 'settings', 'replace']);
const COOKIE = 'cf_staff';

const store = createStore();
let db = null;      // { ver, recentOps, state }
let config = null;  // { salt, pinHash, tokens, qrSecret }

/* ---------- Saving (debounced, one write at a time, retried on failure) ---------- */
let dirty = { all: false, orders: new Set(), pruneBefore: 0 };
let saveTimer = null, saving = Promise.resolve(), saveFailures = 0;
function markDirty(op) {
  if (!op) return;
  if (op.t === 'replace') dirty.all = true;
  else if (op.t === 'addOrder') dirty.orders.add(op.order.id);
  else if (op.t === 'status' || op.t === 'line') dirty.orders.add(op.id);
  // menu / settings / avail live in the meta row, which every save writes
}
function persist(delay = 200) { clearTimeout(saveTimer); saveTimer = setTimeout(flush, delay); }
function flush() {
  clearTimeout(saveTimer); saveTimer = null;
  const snap = dirty;
  dirty = { all: false, orders: new Set(), pruneBefore: 0 };
  saving = saving.then(() => store.save(db, snap)).then(() => {
    if (saveFailures) console.log('  Saved again after a storage error.');
    saveFailures = 0;
  }).catch(e => {
    saveFailures++;
    console.error(`  Could not save (${e.message}). Retrying…`);
    dirty.all = dirty.all || snap.all; // put the changes back and try again soon
    snap.orders.forEach(id => dirty.orders.add(id));
    dirty.pruneBefore = Math.max(dirty.pruneBefore, snap.pruneBefore);
    persist(Math.min(30000, 2000 * saveFailures));
  });
  return saving;
}
const saveConfig = () => store.saveConfig(config).catch(e => console.error('  Could not save settings:', e.message));

function prune() {
  const cut = Date.now() - KEEP_DAYS * 864e5;
  const before = db.state.orders.length;
  db.state.orders = db.state.orders.filter(o => o.createdAt > cut);
  if (db.state.orders.length !== before) { dirty.pruneBefore = cut; persist(); }
}

/* ---------- Staff PIN + QR signing ---------- */
const sha = s => crypto.createHash('sha256').update(s).digest('hex');
const hashPin = (pin, salt) => crypto.scryptSync(String(pin), salt, 32).toString('hex');
function pinRecord(pin) { const salt = crypto.randomBytes(16).toString('hex'); return { salt, pinHash: hashPin(pin, salt) }; }
function checkPin(pin) {
  const a = Buffer.from(hashPin(String(pin || ''), config.salt), 'hex'), b = Buffer.from(config.pinHash, 'hex');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}
function cookieToken(req) {
  const m = (req.headers.cookie || '').match(new RegExp(`(?:^|;\\s*)${COOKIE}=([a-f0-9]{48})`));
  return m ? m[1] : null;
}
const isStaff = req => { const t = cookieToken(req); return !!t && config.tokens.includes(sha(t)); };
const isHttps = req => HTTPS || (TRUST_PROXY && req.headers['x-forwarded-proto'] === 'https');
const cookie = (req, value, maxAge) => `${COOKIE}=${value}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${maxAge}${isHttps(req) ? '; Secure' : ''}`;

// Each table's QR code carries a key, so nobody can order for a table they never scanned.
const qrKey = table => crypto.createHmac('sha256', config.qrSecret).update(String(table)).digest('base64url').slice(0, 12);
const qrKeyOk = (table, key) => {
  const a = Buffer.from(qrKey(table)), b = Buffer.from(String(key || ''));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
};
function qrKeys() {
  const keys = { take: qrKey('take') };
  for (let t = 1; t <= MAX_TABLES; t++) keys[t] = qrKey(t);
  return keys;
}

/* ---------- Rate limits ---------- */
const hits = new Map();
function limited(key, max, ms) {
  const now = Date.now(), list = (hits.get(key) || []).filter(t => now - t < ms);
  list.push(now); hits.set(key, list);
  return list.length > max;
}
setInterval(() => hits.clear(), 3600e3).unref();
function ip(req) {
  if (TRUST_PROXY) { // the hosting proxy appends the real client address last
    const list = String(req.headers['x-forwarded-for'] || '').split(',').map(s => s.trim()).filter(Boolean);
    if (list.length) return list[list.length - 1];
  }
  return req.socket.remoteAddress || '?';
}

/* ---------- Helpers ---------- */
const lanUrls = () => Object.values(os.networkInterfaces()).flat()
  .filter(i => i && i.family === 'IPv4' && !i.internal).map(i => `http://${i.address}:${PORT}`);
const appUrls = () => PUBLIC_URL ? [PUBLIC_URL] : lanUrls();
const clip = (v, n) => String(v ?? '').trim().slice(0, n);
const lineTotal = l => (l.price + l.mods.reduce((a, m) => a + m.price, 0)) * l.qty;
const httpErr = (code, message) => Object.assign(new Error(message), { code });
function clientView() {
  const cut = Date.now() - CLIENT_HOURS * 3600e3;
  return { ...db.state, orders: db.state.orders.filter(o => o.createdAt > cut || ['pending', 'new', 'prep', 'ready'].includes(o.status)) };
}

/* ---------- Live updates (Server-Sent Events) ---------- */
const clients = new Set();
const sse = (res, event, data) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
const broadcast = (event, data) => { for (const c of clients) sse(c, event, data); };
setInterval(() => { for (const c of clients) c.write(': ping\n\n'); }, 20000).unref();

/* Apply one change, bump the version, save, and tell every staff device. */
function commit(op) {
  op.at = Date.now(); // server clock is the single source of time
  applyOp(db.state, op);
  db.ver++;
  db.recentOps.push(op.opId);
  if (db.recentOps.length > 300) db.recentOps.splice(0, db.recentOps.length - 300);
  markDirty(op);
  persist();
  if (op.t === 'replace') broadcast('reload', { ver: db.ver });
  else broadcast('op', { ver: db.ver, now: Date.now(), op });
}

/* ---------- HTTP plumbing ---------- */
const json = (res, code, data, headers = {}) => { res.writeHead(code, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...headers }); res.end(JSON.stringify(data)); };
const readBody = (req, limit) => new Promise((resolve, reject) => {
  let size = 0; const chunks = [];
  req.on('data', c => { size += c.length; if (size > limit) { reject(httpErr(413, 'Too large')); req.destroy(); } else chunks.push(c); });
  req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
  req.on('error', reject);
});
async function readJson(req, limit = 10e6) {
  try { return JSON.parse(await readBody(req, limit)); } catch (e) { throw e.code ? e : httpErr(400, 'Invalid JSON'); }
}

/* ---------- Staff API ---------- */
function validate(op) {
  if (!op || !OPS.has(op.t) || typeof op.opId !== 'string' || op.opId.length > 64) return 'Bad change';
  if (op.t === 'addOrder' && !(op.order && typeof op.order.id === 'string' && Array.isArray(op.order.lines) && op.order.lines.length)) return 'Bad order';
  if (op.t === 'replace' && !(op.state && op.state.settings && Array.isArray(op.state.items) && Array.isArray(op.state.orders))) return 'Bad backup';
  return null;
}
async function handleOp(req, res) {
  const op = await readJson(req);
  const err = validate(op);
  if (err) return json(res, 400, { error: err });
  if (db.recentOps.includes(op.opId)) return json(res, 200, { ok: true, dup: true, ver: db.ver }); // a retry of something already applied
  if (op.t === 'addOrder') delete op.order.num; // server hands out order numbers
  try { commit(op); } catch (e) { return json(res, 400, { error: e.message }); }
  json(res, 200, { ok: true, ver: db.ver, num: op.order ? op.order.num : undefined });
}
async function handleLogin(req, res) {
  if (limited('login:' + ip(req), 8, 5 * 60e3)) return json(res, 429, { error: 'Too many tries. Wait 5 minutes.' });
  const { pin } = await readJson(req, 1e3);
  if (!checkPin(pin)) return json(res, 401, { error: 'Wrong PIN' });
  const token = crypto.randomBytes(24).toString('hex');
  config.tokens.push(sha(token));
  if (config.tokens.length > 100) config.tokens.splice(0, config.tokens.length - 100);
  await saveConfig();
  json(res, 200, { ok: true }, { 'Set-Cookie': cookie(req, token, 31536000) });
}
async function handleLogout(req, res) {
  const t = cookieToken(req);
  if (t) { config.tokens = config.tokens.filter(x => x !== sha(t)); await saveConfig(); }
  json(res, 200, { ok: true }, { 'Set-Cookie': cookie(req, '', 0) });
}
async function handlePin(req, res) {
  const { pin } = await readJson(req, 1e3);
  if (!/^\d{4,8}$/.test(String(pin || ''))) return json(res, 400, { error: 'PIN must be 4–8 digits' });
  Object.assign(config, pinRecord(pin));
  config.tokens = [sha(cookieToken(req))]; // signs out every other device
  await saveConfig();
  json(res, 200, { ok: true });
}
async function handleQrRotate(req, res) {
  config.qrSecret = crypto.randomBytes(16).toString('hex'); // every printed QR code stops working
  await saveConfig();
  json(res, 200, { ok: true, qrKeys: qrKeys() });
}

/* ---------- Customer (QR) API — public, so everything is checked here ---------- */
function publicMenu(url) {
  const s = db.state.settings;
  const t = url.searchParams.get('t') || '';
  return {
    cafeName: s.cafeName, currency: s.currency, tables: s.tables, qrEnabled: s.qrEnabled !== false,
    tableOk: qrKeyOk(t, url.searchParams.get('k')),
    categories: db.state.categories, groups: db.state.groups,
    items: db.state.items.map(({ id, name, catId, price, available, groups }) => ({ id, name, catId, price, available, groups })),
  };
}
function buildCustomerOrder(b) {
  const s = db.state.settings;
  if (s.qrEnabled === false) throw httpErr(403, 'Ordering by QR code is paused. Please order at the counter.');
  const take = b.table === 'take';
  const n = parseInt(b.table, 10);
  if (!take && !(String(n) === String(b.table) && n >= 1 && n <= s.tables)) throw httpErr(400, 'Unknown table. Please scan the QR code on your table again.');
  if (!qrKeyOk(b.table, b.key)) throw httpErr(403, 'This QR code is no longer valid. Please ask our staff.');
  if (!Array.isArray(b.lines) || !b.lines.length) throw httpErr(400, 'Your order is empty');
  if (b.lines.length > 30) throw httpErr(400, 'That is a big order! Please order at the counter.');
  const lines = b.lines.map(l => {
    const it = db.state.items.find(i => i.id === (l && l.itemId));
    if (!it) throw httpErr(409, 'An item in your order is no longer on the menu');
    if (!it.available) throw httpErr(409, `Sorry, ${it.name} has just sold out`);
    const chosen = new Set(Array.isArray(l.options) ? l.options : []);
    const mods = [];
    for (const gid of it.groups) { // prices always come from the menu, never from the phone
      const g = db.state.groups.find(x => x.id === gid);
      if (!g || !g.options.length) continue;
      let picks = g.options.filter(o => chosen.has(o.id));
      if (!g.multi) picks = picks.length ? [picks[0]] : [g.options[0]];
      picks.forEach(o => mods.push({ group: g.name, name: o.name, price: o.price }));
    }
    const qty = Math.min(20, Math.max(1, parseInt(l.qty, 10) || 1));
    return { itemId: it.id, name: it.name, price: it.price, station: it.station, qty, mods, note: clip(l.note, 80), done: false };
  });
  return {
    id: uid() + uid() + uid(), type: take ? 'take' : 'dine', table: take ? '' : String(n),
    customer: take ? clip(b.customer, 30) : '', note: clip(b.note, 120), lines,
    source: 'qr', status: s.qrApproval === false ? 'new' : 'pending',
  };
}
async function handleCustomerOrder(req, res) {
  const b = await readJson(req, 50e3);
  // Per phone and table: shared mobile-network addresses can't block a whole café.
  if (limited(`order:${ip(req)}:${clip(b && b.table, 8)}`, 6, 10 * 60e3)) return json(res, 429, { error: 'Too many orders from this phone. Please ask our staff.' });
  const order = buildCustomerOrder(b || {});
  commit({ t: 'addOrder', opId: 'qr-' + order.id, order });
  json(res, 200, { ok: true, id: order.id, num: order.num });
}
function customerOrderStatus(id, res) {
  const o = db.state.orders.find(x => x.id === id);
  if (!o) return json(res, 404, { error: 'Order not found' });
  json(res, 200, {
    num: o.num, status: o.status, type: o.type, table: o.table, createdAt: o.createdAt,
    total: o.lines.reduce((a, l) => a + lineTotal(l), 0), currency: db.state.settings.currency,
    lines: o.lines.map(l => ({ name: l.name, qty: l.qty, mods: l.mods.map(m => m.name) })),
  });
}

/* ---------- Static files ---------- */
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.webmanifest': 'application/manifest+json', '.png': 'image/png' };
const PUBLIC = new Set(['/index.html', '/order.html', '/app.js', '/customer.js', '/shared.js', '/styles.css', '/sw.js', '/manifest.webmanifest',
  '/icons/icon-192.png', '/icons/icon-512.png', '/icons/logo-blue.png', '/icons/logo-white.png']);
function serveStatic(p, res) {
  if (p === '/') p = '/index.html';
  if (!PUBLIC.has(p)) { res.writeHead(404); return res.end('Not found'); }
  fs.readFile(path.join(ROOT, p), (err, buf) => {
    if (err) { res.writeHead(404); return res.end('Not found'); }
    res.writeHead(200, { 'Content-Type': TYPES[path.extname(p)], 'Cache-Control': 'no-cache' });
    res.end(buf);
  });
}

/* ---------- Routes ---------- */
const STAFF_ONLY = new Set(['/api/state', '/api/events', '/api/op', '/api/backup', '/api/pin', '/api/qr-rotate']);

async function route(req, res) {
  const url = new URL(req.url, 'http://local');
  const p = url.pathname, m = req.method;
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'same-origin');
  if (isHttps(req)) res.setHeader('Strict-Transport-Security', 'max-age=15552000');

  if (p === '/healthz') { res.writeHead(200, { 'Content-Type': 'text/plain' }); return res.end('ok'); }
  if (p === '/api/public/menu' && m === 'GET') return json(res, 200, publicMenu(url));
  if (p === '/api/public/order' && m === 'POST') return handleCustomerOrder(req, res);
  if (p.startsWith('/api/public/order/') && m === 'GET') return customerOrderStatus(p.slice('/api/public/order/'.length), res);
  if (p === '/api/login' && m === 'POST') return handleLogin(req, res);
  if (p === '/api/logout' && m === 'POST') return handleLogout(req, res);

  if (STAFF_ONLY.has(p) && !isStaff(req)) return json(res, 401, { error: 'Staff PIN required' });

  if (p === '/api/state' && m === 'GET') {
    return json(res, 200, { ver: db.ver, now: Date.now(), recentOps: db.recentOps, urls: appUrls(), cloud: !!PUBLIC_URL, qrKeys: qrKeys(), state: clientView() });
  }
  if (p === '/api/events' && m === 'GET') {
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
    res.write('retry: 2000\n\n');
    clients.add(res);
    sse(res, 'hello', { ver: db.ver, now: Date.now() });
    broadcast('presence', { devices: clients.size });
    req.on('close', () => { clients.delete(res); broadcast('presence', { devices: clients.size }); });
    return;
  }
  if (p === '/api/op' && m === 'POST') return handleOp(req, res);
  if (p === '/api/pin' && m === 'POST') return handlePin(req, res);
  if (p === '/api/qr-rotate' && m === 'POST') return handleQrRotate(req, res);
  if (p === '/api/backup' && m === 'GET') {
    res.writeHead(200, { 'Content-Type': 'application/json', 'Content-Disposition': `attachment; filename="cafeflow-backup-${new Date().toISOString().slice(0, 10)}.json"` });
    return res.end(JSON.stringify(db.state, null, 2));
  }
  if (m === 'GET') return serveStatic(p, res);
  res.writeHead(405); res.end();
}

/* ---------- Start ---------- */
async function start() {
  const loaded = await store.load();
  db = loaded.db && loaded.db.state && Array.isArray(loaded.db.state.orders) ? loaded.db : null;
  if (!db) { db = { ver: 0, recentOps: [], state: seed() }; dirty.all = true; persist(0); }
  db.recentOps = db.recentOps || [];

  config = loaded.config;
  let firstPin = null;
  if (!config || !config.pinHash) {
    const envPin = /^\d{4,8}$/.test(process.env.STAFF_PIN || '') ? process.env.STAFF_PIN : null;
    firstPin = envPin ? 'from STAFF_PIN' : String(crypto.randomInt(0, 1e6)).padStart(6, '0');
    config = { ...pinRecord(envPin || firstPin), tokens: [] };
  }
  config.tokens = config.tokens || [];
  if (!config.qrSecret) config.qrSecret = crypto.randomBytes(16).toString('hex');
  await store.saveConfig(config);

  prune();
  setInterval(prune, 6 * 3600e3).unref();

  const server = http.createServer((req, res) => {
    route(req, res).catch(e => { if (!res.headersSent) json(res, e.code || 500, { error: e.code ? e.message : 'Server error' }); });
  });
  server.listen(PORT, '0.0.0.0', () => {
    console.log('\n  CafeFlow server is running.\n');
    console.log(`  Storage: ${store.describe}`);
    if (PUBLIC_URL) console.log(`  Public address: ${PUBLIC_URL}`);
    else {
      console.log(`  Staff app, this computer:   http://localhost:${PORT}`);
      for (const u of lanUrls()) console.log(`  Staff app, other devices:   ${u}`);
    }
    if (firstPin === 'from STAFF_PIN') console.log('\n  Staff PIN: set from STAFF_PIN (change it in Settings → Staff PIN)');
    else if (firstPin) console.log(`\n  Staff PIN: ${firstPin}   (change it in Settings → Staff PIN)`);
    else console.log('\n  Staff PIN: already set. Forgot it? See README → "Forgot the staff PIN".');
    console.log('  Print table QR codes from Settings → QR ordering.\n');
  });

  // Hosts stop the server on deploys and restarts: write pending changes first.
  const shutdown = async sig => {
    console.log(`  ${sig}: saving and stopping…`);
    server.close();
    for (const c of clients) c.end();
    try { if (saveTimer || dirty.all || dirty.orders.size) await flush(); await saving; } catch { /* logged */ }
    await store.close();
    process.exit(0);
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

start().catch(e => { console.error('\n  CafeFlow could not start:', e.message, '\n'); process.exit(1); });
