// Captures real CafeFlow demo screens for the explainer videos (headless Chrome over the
// DevTools protocol, no dependencies). Walks the demo from a clean start: staff order #1 at
// Table 3, guest order #2 at Table 5, approve, kitchen Start / Ready. Writes PNGs (2x) plus
// coords.json (tap positions, CSS px of a 1280x800 staff / 390x844 guest viewport).
//
//   1. Serve this repo:   python -m http.server 8096 --bind 127.0.0.1
//   2. Capture:           node tools/video/capture-demo.mjs <outDir> [baseUrl]
//
// File names match design/video/*/index.html (assets/ui/<name>.png). Chrome path: CHROME_PATH env.
import { spawn } from 'node:child_process';
import { writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const OUT = process.argv[2];
if (!OUT) { console.error('Usage: node tools/video/capture-demo.mjs <outDir> [baseUrl]'); process.exit(1); }
mkdirSync(OUT, { recursive: true });
const BASE = process.argv[3] || 'http://127.0.0.1:8096';
const PORT = 9341;
const CHROME = process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const profile = join(tmpdir(), 'cafeflow-capture-' + Date.now());
const chrome = spawn(CHROME, ['--headless=new', `--remote-debugging-port=${PORT}`, `--user-data-dir=${profile}`, '--hide-scrollbars', '--force-color-profile=srgb', '--no-first-run', 'about:blank'], { stdio: 'ignore' });
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function json(path, method = 'GET') {
  for (let i = 0; i < 50; i++) {
    try { const r = await fetch(`http://127.0.0.1:${PORT}${path}`, { method }); return await r.json(); } catch { await sleep(200); }
  }
  throw new Error('chrome not reachable');
}

class Page {
  static async open(w, h) {
    const t = await json('/json/new?about:blank', 'PUT');
    const p = new Page(); p.ws = new WebSocket(t.webSocketDebuggerUrl); p.id = 0; p.wait = new Map();
    await new Promise(r => p.ws.addEventListener('open', r));
    p.ws.addEventListener('message', e => { const m = JSON.parse(e.data); if (m.id && p.wait.has(m.id)) { p.wait.get(m.id)(m); p.wait.delete(m.id); } });
    await p.send('Page.enable'); await p.send('Runtime.enable');
    await p.send('Emulation.setDeviceMetricsOverride', { width: w, height: h, deviceScaleFactor: 2, mobile: w < 600 });
    await p.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: 'light' }] });
    return p;
  }
  send(method, params = {}) {
    const id = ++this.id;
    return new Promise((res, rej) => { this.wait.set(id, m => m.error ? rej(new Error(method + ': ' + m.error.message)) : res(m.result)); this.ws.send(JSON.stringify({ id, method, params })); });
  }
  async go(url, ms = 1500) { await this.send('Page.navigate', { url: BASE + url }); await sleep(ms); }
  async js(expr) {
    const r = await this.send('Runtime.evaluate', { expression: `(async()=>{${expr}})()`, awaitPromise: true, returnByValue: true });
    if (r.exceptionDetails) throw new Error('JS: ' + (r.exceptionDetails.exception?.description || r.exceptionDetails.text));
    return r.result.value;
  }
  async shot(name, clipSel) {
    const params = { format: 'png', captureBeyondViewport: false };
    if (clipSel) {
      const find = clipSel.startsWith('JS:') ? clipSel.slice(3) : `document.querySelector(${JSON.stringify(clipSel)})`;
      const b = await this.js(`const r=(${find}).getBoundingClientRect();return {x:r.x,y:r.y,width:r.width,height:r.height}`);
      params.clip = { x: b.x - 2, y: b.y - 2, width: b.width + 4, height: b.height + 4, scale: 1 };
      params.captureBeyondViewport = true;
    }
    const { data } = await this.send('Page.captureScreenshot', params);
    writeFileSync(join(OUT, name + '.png'), Buffer.from(data, 'base64'));
    console.log('saved', name);
  }
}

const click = (sel, text) => `{ const el=[...document.querySelectorAll(${JSON.stringify(sel)})].find(x=>${text ? `x.textContent.trim()===${JSON.stringify(text)} || x.textContent.includes(${JSON.stringify(text)}) && ${JSON.stringify(text)}.length>2` : 'true'}); if(!el) throw new Error('missing ${sel} ${text || ''}'); el.click(); }`;
const coords = {};
async function rect(page, key, sel, text) {
  coords[key] = await page.js(`const el=[...document.querySelectorAll(${JSON.stringify(sel)})].find(x=>${text ? `x.textContent.trim()===${JSON.stringify(text)} || x.textContent.includes(${JSON.stringify(text)}) && ${JSON.stringify(text)}.length>2` : 'true'}); if(!el) throw new Error('rect missing ${'$'}{sel}'); const r=el.getBoundingClientRect(); return {x:Math.round(r.x),y:Math.round(r.y),w:Math.round(r.width),h:Math.round(r.height)}`);
}
// The demo strip is for live visitors; hide it in captures.
const hideBar = `document.querySelectorAll('.demo-bar').forEach(b=>b.remove());`;

try {
  await json('/json/version');
  const staff = await Page.open(1280, 800);
  // Clean start
  await staff.go('/demo.html', 1200);
  await staff.js(`CafeDemo.reset(false); return CafeDemo.state().orders.length`);

  // Staff: order #1 at Table 3
  await staff.go('/demo-app.html#pos', 1800); await staff.js(hideBar);
  await staff.shot('s01_pos_empty');
  await rect(staff,'pos_tbl3','.tbl','3'); await rect(staff,'pos_latte','.item','Latte');
  await staff.js(click('.tbl', '3') + ` await new Promise(r=>setTimeout(r,200));` + click('.item', 'Latte'));
  await sleep(600);
  await staff.shot('s02_latte_options');
  await rect(staff,'pos_add','#addBtn');
  await staff.js(click('#addBtn'));
  await sleep(500);
  await staff.shot('s03_pos_cart');
  await rect(staff,'pos_send','button','Send to kitchen');
  await staff.js(click('button', 'Send to kitchen'));
  await sleep(500);
  await staff.shot('s04_pos_sent');

  // QR card for Table 5 (staff QR sheet)
  await staff.go('/demo-app.html#qr', 3500); await staff.js(hideBar);
  await staff.js(`const c=[...document.querySelectorAll('.qrcard')].find(x=>x.querySelector('.qr-table').textContent.trim()==='Table 5'); c.id='t5card'; c.querySelector('.qr-url').remove(); c.scrollIntoView({block:'center'});`);
  await sleep(600);
  await staff.shot('s05_qr_table5', '#t5card');

  // Guest: order #2 at Table 5
  const guest = await Page.open(390, 844);
  await guest.go('/demo-order.html?t=5', 2000); await guest.js(hideBar);
  await guest.shot('g01_menu');
  await rect(guest,'g_latte','.c-item','Latte');
  await guest.js(click('.c-item', 'Latte'));
  await sleep(600);
  await guest.shot('g02_latte_sheet');
  await rect(guest,'g_add','#addBtn');
  await guest.js(click('#addBtn'));
  await sleep(3400); // let the "Added" toast fade
  await guest.shot('g03_menu_cart');
  await guest.js(click('.c-bar'));
  await sleep(500);
  await guest.shot('g04_your_order');
  await guest.js(click('button', 'Place order'));
  await sleep(1500);
  await guest.shot('g05_order_sent');

  // Staff: approve #2
  await staff.go('/demo-app.html#orders', 1800); await staff.js(hideBar);
  await staff.shot('s06_orders_approval');
  await staff.shot('s06b_approval_card', '.approve');
  await rect(staff,'approve_card','.approve'); await rect(staff,'approve_btn','button','Accept');
  await staff.js(click('button', 'Accept'));
  await sleep(800);
  await staff.shot('s07_orders_after');

  // Kitchen board with #1 and #2 new
  await staff.go('/demo-app.html#kitchen', 1800); await staff.js(hideBar);
  await staff.shot('s08_kitchen_new');
  const nums = await staff.js(`return [...document.querySelectorAll('.ticket')].map(t=>t.querySelector('.onum').textContent)`);
  for (let i = 0; i < nums.length; i++) await staff.shot('s09_ticket_' + nums[i].replace('#', 'n'), `JS:[...document.querySelectorAll('.ticket')][${i}]`);

  // Guest sees accepted
  await sleep(4800);
  await guest.shot('g06_accepted');

  // Kitchen: start both -> preparing, then ready
  await staff.js(`for (let k=0;k<2;k++){ const b=[...document.querySelectorAll('.ticket button')].find(x=>/Start/.test(x.textContent)); if(b){b.click(); await new Promise(r=>setTimeout(r,300));} }`);
  await sleep(600); await staff.shot('s10_kitchen_prep');
  for (let i = 0; i < 2; i++) await staff.shot('s10_ticket_prep_' + i, `JS:[...document.querySelectorAll('.ticket')][${i}]`);
  await staff.js(`for (let k=0;k<2;k++){ const b=[...document.querySelectorAll('.ticket button')].find(x=>/Mark ready/.test(x.textContent)); if(b){b.click(); await new Promise(r=>setTimeout(r,300));} }`);
  await sleep(600); await staff.shot('s11_kitchen_ready');
  for (let i = 0; i < 2; i++) await staff.shot('s11_ticket_ready_' + i, `JS:[...document.querySelectorAll('.ticket')][${i}]`);
  await sleep(4800);
  await guest.shot('g07_ready');
  writeFileSync(join(OUT, 'coords.json'), JSON.stringify(coords, null, 1));
  console.log('orders', await staff.js(`return CafeDemo.state().orders.map(o=>'#'+o.num+' '+o.status+' '+(o.table||o.type))`));
} finally {
  chrome.kill();
}
