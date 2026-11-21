'use strict';
/* CafeFlow café server — run on one computer in the café:  node server.js
   Serves the staff app and the customer QR ordering page to every device on the
   same Wi-Fi, and keeps them in sync live. No dependencies.
   Data: data/cafeflow.json   Staff PIN + sign-ins: data/config.json */
const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { applyOp, seed, uid } = require('./shared.js');

const PORT = Number(process.env.PORT) || 8080;
const ROOT = __dirname;
const DATA_DIR = path.join(ROOT, 'data');
const DATA = path.join(DATA_DIR, 'cafeflow.json');
const CONFIG = path.join(DATA_DIR, 'config.json');
const KEEP_DAYS = 90;      // order history kept on the server
const CLIENT_HOURS = 36;   // order history sent to staff devices (they only show today)
const OPS = new Set(['addOrder', 'status', 'line', 'avail', 'menu', 'settings', 'replace']);
const COOKIE = 'cf_staff';

/* ---------- Storage ---------- */
function loadDb() {
  try {
    const d = JSON.parse(fs.readFileSync(DATA, 'utf8'));
    if (d.state && Array.isArray(d.state.orders)) return d;
  } catch { /* first run */ }
  return { ver: 0, recentOps: [], state: seed() };
}
const db = loadDb();
function prune() { const cut = Date.now() - KEEP_DAYS * 864e5; db.state.orders = db.state.orders.filter(o => o.createdAt > cut); }
prune();
setInterval(prune, 6 * 3600e3);

function writeNow() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(DATA + '.tmp', JSON.stringify(db));
  fs.renameSync(DATA + '.tmp', DATA); // atomic swap so a crash never leaves a half-written file
}
let saveTimer = null;
function persist() { clearTimeout(saveTimer); saveTimer = setTimeout(() => { saveTimer = null; writeNow(); }, 200); }
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => { if (saveTimer) writeNow(); process.exit(0); });

/* ---------- Staff PIN ---------- */
const sha = s => crypto.createHash('sha256').update(s).digest('hex');
const hashPin = (pin, salt) => crypto.scryptSync(String(pin), salt, 32).toString('hex');
function pinRecord(pin) { const salt = crypto.randomBytes(16).toString('hex'); return { salt, pinHash: hashPin(pin, salt) }; }
function saveConfig() { fs.mkdirSync(DATA_DIR, { recursive: true }); fs.writeFileSync(CONFIG, JSON.stringify(config, null, 2)); }
let config = null;
try { config = JSON.parse(fs.readFileSync(CONFIG, 'utf8')); } catch { /* first run */ }
let firstPin = null;
if (!config || !config.pinHash) {
  firstPin = String(crypto.randomInt(0, 1e6)).padStart(6, '0');
  config = { ...pinRecord(firstPin), tokens: [] };
  saveConfig();
}
function checkPin(pin) {
  const a = Buffer.from(hashPin(String(pin || ''), config.salt), 'hex'), b = Buffer.from(config.pinHash, 'hex');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}
function cookieToken(req) {
  const m = (req.headers.cookie || '').match(new RegExp(`(?:^|;\\s*)${COOKIE}=([a-f0-9]{48})`));
  return m ? m[1] : null;
}
const isStaff = req => { const t = cookieToken(req); return !!t && config.tokens.includes(sha(t)); };

/* ---------- Rate limits ---------- */
const hits = new Map();
function limited(key, max, ms) {
  const now = Date.now(), list = (hits.get(key) || []).filter(t => now - t < ms);
  list.push(now); hits.set(key, list);
  return list.length > max;
}
setInterval(() => hits.clear(), 3600e3);
const ip = req => req.socket.remoteAddress || '?';

/* ---------- Helpers ---------- */
const lanUrls = () => Object.values(os.networkInterfaces()).flat()
  .filter(i => i && i.family === 'IPv4' && !i.internal).map(i => `http://${i.address}:${PORT}`);
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
setInterval(() => { for (const c of clients) c.write(': ping\n\n'); }, 20000);

/* Apply one change, bump the version, save, and tell every staff device. */
function commit(op) {
  op.at = Date.now(); // server clock is the single source of time
  applyOp(db.state, op);
  db.ver++;
  db.recentOps.push(op.opId);
  if (db.recentOps.length > 500) db.recentOps.splice(0, db.recentOps.length - 500);
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
  saveConfig();
  json(res, 200, { ok: true }, { 'Set-Cookie': `${COOKIE}=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=31536000` });
}
function handleLogout(req, res) {
  const t = cookieToken(req);
  if (t) { config.tokens = config.tokens.filter(x => x !== sha(t)); saveConfig(); }
  json(res, 200, { ok: true }, { 'Set-Cookie': `${COOKIE}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0` });
}
async function handlePin(req, res) {
  const { pin } = await readJson(req, 1e3);
  if (!/^\d{4,8}$/.test(String(pin || ''))) return json(res, 400, { error: 'PIN must be 4–8 digits' });
  Object.assign(config, pinRecord(pin));
  config.tokens = [sha(cookieToken(req))]; // signs out every other device
  saveConfig();
  json(res, 200, { ok: true });
}

/* ---------- Customer (QR) API — public, so everything is checked here ---------- */
function publicMenu() {
  const s = db.state.settings;
  return {
    cafeName: s.cafeName, currency: s.currency, tables: s.tables, qrEnabled: s.qrEnabled !== false,
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
  if (limited('order:' + ip(req), 6, 10 * 60e3)) return json(res, 429, { error: 'Too many orders from this phone. Please ask our staff.' });
  const order = buildCustomerOrder(await readJson(req, 50e3));
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
const STAFF_ONLY = new Set(['/api/state', '/api/events', '/api/op', '/api/backup', '/api/pin']);

async function route(req, res) {
  const p = new URL(req.url, 'http://local').pathname;
  const m = req.method;

  if (p === '/api/public/menu' && m === 'GET') return json(res, 200, publicMenu());
  if (p === '/api/public/order' && m === 'POST') return handleCustomerOrder(req, res);
  if (p.startsWith('/api/public/order/') && m === 'GET') return customerOrderStatus(p.slice('/api/public/order/'.length), res);
  if (p === '/api/login' && m === 'POST') return handleLogin(req, res);
  if (p === '/api/logout' && m === 'POST') return handleLogout(req, res);

  if (STAFF_ONLY.has(p) && !isStaff(req)) return json(res, 401, { error: 'Staff PIN required' });

  if (p === '/api/state' && m === 'GET') {
    return json(res, 200, { ver: db.ver, now: Date.now(), recentOps: db.recentOps, urls: lanUrls(), state: clientView() });
  }
  if (p === '/api/events' && m === 'GET') {
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', Connection: 'keep-alive' });
    res.write('retry: 2000\n\n');
    clients.add(res);
    sse(res, 'hello', { ver: db.ver, now: Date.now() });
    broadcast('presence', { devices: clients.size });
    req.on('close', () => { clients.delete(res); broadcast('presence', { devices: clients.size }); });
    return;
  }
  if (p === '/api/op' && m === 'POST') return handleOp(req, res);
  if (p === '/api/pin' && m === 'POST') return handlePin(req, res);
  if (p === '/api/backup' && m === 'GET') {
    res.writeHead(200, { 'Content-Type': 'application/json', 'Content-Disposition': `attachment; filename="cafeflow-backup-${new Date().toISOString().slice(0, 10)}.json"` });
    return res.end(JSON.stringify(db.state, null, 2));
  }
  if (m === 'GET') return serveStatic(p, res);
  res.writeHead(405); res.end();
}

const server = http.createServer((req, res) => {
  route(req, res).catch(e => { if (!res.headersSent) json(res, e.code || 500, { error: e.code ? e.message : 'Server error' }); });
});

server.listen(PORT, '0.0.0.0', () => {
  console.log('\n  CafeFlow server is running.\n');
  console.log(`  Staff app, this computer:   http://localhost:${PORT}`);
  for (const u of lanUrls()) console.log(`  Staff app, other devices:   ${u}`);
  console.log(firstPin
    ? `\n  Staff PIN: ${firstPin}   (change it in Settings → Staff PIN)`
    : '\n  Staff PIN: set. Forgot it? Stop the server, delete data/config.json and start again for a new one.');
  console.log(`  Print table QR codes from Settings → QR ordering.\n  Data folder: ${DATA_DIR}\n  Press Ctrl+C to stop.\n`);
});
