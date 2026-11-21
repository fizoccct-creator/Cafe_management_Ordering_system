'use strict';
/* CafeFlow café server — run on one computer in the café:  node server.js
   Serves the app to every device on the same Wi-Fi and keeps them in sync live.
   No dependencies. Data is saved to data/cafeflow.json. */
const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { applyOp, seed } = require('./shared.js');

const PORT = Number(process.env.PORT) || 8080;
const ROOT = __dirname;
const DATA_DIR = path.join(ROOT, 'data');
const DATA = path.join(DATA_DIR, 'cafeflow.json');
const KEEP_DAYS = 90;      // order history kept on the server
const CLIENT_HOURS = 36;   // order history sent to devices (they only show today)
const OPS = new Set(['addOrder', 'status', 'line', 'avail', 'menu', 'settings', 'replace']);

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

const lanUrls = () => Object.values(os.networkInterfaces()).flat()
  .filter(i => i && i.family === 'IPv4' && !i.internal).map(i => `http://${i.address}:${PORT}`);

function clientView() {
  const cut = Date.now() - CLIENT_HOURS * 3600e3;
  return { ...db.state, orders: db.state.orders.filter(o => o.createdAt > cut || ['new', 'prep', 'ready'].includes(o.status)) };
}

/* ---------- Live updates (Server-Sent Events) ---------- */
const clients = new Set();
const sse = (res, event, data) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
const broadcast = (event, data) => { for (const c of clients) sse(c, event, data); };
setInterval(() => { for (const c of clients) c.write(': ping\n\n'); }, 20000);

/* ---------- HTTP ---------- */
const json = (res, code, data) => { res.writeHead(code, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(data)); };
const readBody = req => new Promise((resolve, reject) => {
  let size = 0; const chunks = [];
  req.on('data', c => { size += c.length; if (size > 10e6) { reject(new Error('Too large')); req.destroy(); } else chunks.push(c); });
  req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
  req.on('error', reject);
});

function validate(op) {
  if (!op || !OPS.has(op.t) || typeof op.opId !== 'string' || op.opId.length > 64) return 'Bad change';
  if (op.t === 'addOrder' && !(op.order && typeof op.order.id === 'string' && Array.isArray(op.order.lines) && op.order.lines.length)) return 'Bad order';
  if (op.t === 'replace' && !(op.state && op.state.settings && Array.isArray(op.state.items) && Array.isArray(op.state.orders))) return 'Bad backup';
  return null;
}

async function handleOp(req, res) {
  let op;
  try { op = JSON.parse(await readBody(req)); } catch { return json(res, 400, { error: 'Invalid JSON' }); }
  const err = validate(op);
  if (err) return json(res, 400, { error: err });
  if (db.recentOps.includes(op.opId)) return json(res, 200, { ok: true, dup: true, ver: db.ver }); // a retry of something already applied
  op.at = Date.now();                       // server clock is the single source of time
  if (op.t === 'addOrder') delete op.order.num; // server hands out order numbers
  try { applyOp(db.state, op); } catch (e) { return json(res, 400, { error: e.message }); }
  db.ver++;
  db.recentOps.push(op.opId);
  if (db.recentOps.length > 500) db.recentOps.splice(0, db.recentOps.length - 500);
  persist();
  if (op.t === 'replace') broadcast('reload', { ver: db.ver });
  else broadcast('op', { ver: db.ver, now: Date.now(), op });
  json(res, 200, { ok: true, ver: db.ver, num: op.order ? op.order.num : undefined });
}

const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.webmanifest': 'application/manifest+json', '.png': 'image/png' };
const PUBLIC = new Set(['/index.html', '/app.js', '/shared.js', '/styles.css', '/sw.js', '/manifest.webmanifest', '/icons/icon-192.png', '/icons/icon-512.png']);
function serveStatic(p, res) {
  if (p === '/') p = '/index.html';
  if (!PUBLIC.has(p)) { res.writeHead(404); return res.end('Not found'); }
  fs.readFile(path.join(ROOT, p), (err, buf) => {
    if (err) { res.writeHead(404); return res.end('Not found'); }
    res.writeHead(200, { 'Content-Type': TYPES[path.extname(p)], 'Cache-Control': 'no-cache' });
    res.end(buf);
  });
}

const server = http.createServer((req, res) => {
  const p = new URL(req.url, 'http://local').pathname;
  if (p === '/api/state' && req.method === 'GET') {
    return json(res, 200, { ver: db.ver, now: Date.now(), recentOps: db.recentOps, urls: lanUrls(), state: clientView() });
  }
  if (p === '/api/events' && req.method === 'GET') {
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', Connection: 'keep-alive' });
    res.write('retry: 2000\n\n');
    clients.add(res);
    sse(res, 'hello', { ver: db.ver, now: Date.now() });
    broadcast('presence', { devices: clients.size });
    req.on('close', () => { clients.delete(res); broadcast('presence', { devices: clients.size }); });
    return;
  }
  if (p === '/api/op' && req.method === 'POST') return handleOp(req, res);
  if (p === '/api/backup' && req.method === 'GET') {
    res.writeHead(200, { 'Content-Type': 'application/json', 'Content-Disposition': `attachment; filename="cafeflow-backup-${new Date().toISOString().slice(0, 10)}.json"` });
    return res.end(JSON.stringify(db.state, null, 2));
  }
  if (req.method === 'GET') return serveStatic(p, res);
  res.writeHead(405); res.end();
});

server.listen(PORT, '0.0.0.0', () => {
  console.log('\n  CafeFlow server is running.\n');
  console.log(`  On this computer:   http://localhost:${PORT}`);
  for (const u of lanUrls()) console.log(`  On other devices:   ${u}`);
  console.log(`\n  Data file: ${DATA}\n  Press Ctrl+C to stop.\n`);
});
