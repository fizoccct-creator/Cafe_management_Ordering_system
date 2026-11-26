// Records the demo walkthrough video (real demo, scripted clicks) with headless Chrome.
//
//   1. Serve this repo:  python -m http.server 8096 --bind 127.0.0.1
//   2. Record:           node tools/video/record-walkthrough.mjs <out.mp4> [baseUrl]
//
// Needs Chrome (CHROME_PATH env to override) and ffmpeg on PATH. The stage page is
// tools/video/walkthrough.html; steps and captions are in STEPS below.
import { spawn, execFileSync } from 'node:child_process';
import { writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';

const OUT = process.argv[2];
if (!OUT) { console.error('Usage: node tools/video/record-walkthrough.mjs <out.mp4> [baseUrl]'); process.exit(1); }
const BASE = process.argv[3] || 'http://127.0.0.1:8096';
const PORT = 9343;
const CHROME = process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const work = join(tmpdir(), 'cafeflow-walkthrough-' + Date.now());
const framesDir = join(work, 'frames'); mkdirSync(framesDir, { recursive: true });
const chrome = spawn(CHROME, ['--headless=new', `--remote-debugging-port=${PORT}`, `--user-data-dir=${join(work, 'profile')}`, '--hide-scrollbars', '--force-color-profile=srgb', '--no-first-run', '--autoplay-policy=no-user-gesture-required', 'about:blank'], { stdio: 'ignore' });
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function json(path, method = 'GET') {
  for (let i = 0; i < 50; i++) { try { const r = await fetch(`http://127.0.0.1:${PORT}${path}`, { method }); return await r.json(); } catch { await sleep(200); } }
  throw new Error('chrome not reachable');
}

const STEPS = [
  // [caption, step label, actions (run in the stage page), pause after in ms]
  ['From the first order to served', '', [], 2600],
  ['Staff take an order at the counter', '1 / 5', [
    "await tap('staff', '.tbl', '3')", 'await sleep(700)',
    "await tap('staff', '.item', 'Latte')", 'await sleep(1100)',
    "await tap('staff', '#addBtn')", 'await sleep(900)',
    "await tap('staff', 'button', 'Send to kitchen')"], 2200],
  ['A guest at Table 5 orders from their phone, no app needed', '2 / 5', [
    "await tap('guest', '.c-item', 'Latte')", 'await sleep(1100)',
    "await tap('guest', '#addBtn')", 'await sleep(1000)',
    "await tap('guest', '.c-bar')", 'await sleep(1100)',
    "await tap('guest', 'button', 'Place order')"], 2600],
  ['Staff approve the QR order', '3 / 5', [
    "go('staff', '#orders')", 'await sleep(1400)',
    "await tap('staff', 'button', 'Accept and send to kitchen')"], 1800],
  ['The kitchen starts and finishes both orders', '4 / 5', [
    "go('staff', '#kitchen')", 'await sleep(1400)',
    "await tap('staff', 'button', 'Start')", 'await sleep(900)',
    "await tap('staff', 'button', 'Start')", 'await sleep(1200)',
    "await tap('staff', 'button', 'Mark ready')", 'await sleep(900)',
    "await tap('staff', 'button', 'Mark ready')"], 1500],
  ['The guest sees their order is ready', '5 / 5', [
    'for (let i = 0; i < 30 && !/Ready/.test((findEl("guest", ".c-status h2") || {}).textContent || ""); i++) await sleep(300)'], 2600],
  ['', '', ['ending()'], 3600],
];

let ws, id = 0; const wait = new Map(); const frames = [];
const send = (method, params = {}) => new Promise((res, rej) => { const i = ++id; wait.set(i, m => m.error ? rej(new Error(method + ': ' + m.error.message)) : res(m.result)); ws.send(JSON.stringify({ id: i, method, params })); });
const js = async expr => {
  const r = await send('Runtime.evaluate', { expression: `(async()=>{const sleep=ms=>new Promise(r=>setTimeout(r,ms));${expr}})()`, awaitPromise: true, returnByValue: true });
  if (r.exceptionDetails) throw new Error('JS: ' + (r.exceptionDetails.exception?.description || r.exceptionDetails.text));
  return r.result.value;
};

try {
  await json('/json/version');
  const t = await json('/json/new?about:blank', 'PUT');
  ws = new WebSocket(t.webSocketDebuggerUrl);
  await new Promise(r => ws.addEventListener('open', r));
  ws.addEventListener('message', e => {
    const m = JSON.parse(e.data);
    if (m.id && wait.has(m.id)) { wait.get(m.id)(m); wait.delete(m.id); return; }
    if (m.method === 'Page.screencastFrame') {
      const n = frames.length;
      const file = join(framesDir, `f${String(n).padStart(5, '0')}.jpg`);
      writeFileSync(file, Buffer.from(m.params.data, 'base64'));
      frames.push({ file, t: m.params.metadata.timestamp });
      ws.send(JSON.stringify({ id: ++id, method: 'Page.screencastFrameAck', params: { sessionId: m.params.sessionId } }));
    }
  });
  await send('Page.enable'); await send('Runtime.enable');
  await send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 720, deviceScaleFactor: 1.5, mobile: false });
  await send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: 'light' }] });
  await send('Page.navigate', { url: BASE + '/tools/video/walkthrough.html' });
  await sleep(3500); // fonts + both demo pages
  await js("document.getElementById('staff').contentDocument.querySelector('.item') || (()=>{throw new Error('staff app not ready')})()");
  await send('Page.startScreencast', { format: 'jpeg', quality: 92, maxWidth: 1920, maxHeight: 1080, everyNthFrame: 1 });
  await sleep(400);
  for (const [cap, step, actions, pause] of STEPS) {
    if (cap) await js(`caption(${JSON.stringify(cap)}, ${JSON.stringify(step)})`);
    await sleep(cap ? 900 : 0);
    for (const a of actions) await js(a);
    await sleep(pause);
  }
  const tEnd = Date.now() / 1000;
  await send('Page.stopScreencast');
  // concat list with real frame durations -> constant 30 fps
  const lines = [];
  for (let i = 0; i < frames.length; i++) {
    const next = i + 1 < frames.length ? frames[i + 1].t : Math.max(frames[i].t + 0.5, frames[i].t + (tEnd - frames[i].t));
    lines.push(`file '${frames[i].file.replace(/\\/g, '/')}'`, `duration ${Math.max(0.001, next - frames[i].t).toFixed(4)}`);
  }
  lines.push(`file '${frames[frames.length - 1].file.replace(/\\/g, '/')}'`);
  const list = join(work, 'frames.txt'); writeFileSync(list, lines.join('\n'));
  execFileSync('ffmpeg', ['-y', '-v', 'error', '-f', 'concat', '-safe', '0', '-i', list, '-vf', 'fps=30,scale=1920:1080:flags=lanczos,format=yuv420p', '-c:v', 'libx264', '-preset', 'slow', '-crf', '24', '-movflags', '+faststart', resolve(OUT)], { stdio: 'inherit' });
  console.log(`frames ${frames.length}, length ${(tEnd - frames[0].t).toFixed(1)}s -> ${resolve(OUT)}`);
} finally {
  try { ws && ws.close(); } catch { /* ignore */ }
  chrome.kill();
  await sleep(500);
  try { rmSync(work, { recursive: true, force: true }); } catch { /* profile may still be locked */ }
}
