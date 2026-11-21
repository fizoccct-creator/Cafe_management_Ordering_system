'use strict';
/* CafeFlow — café ordering.
   Standalone: data lives in this browser.  Served by server.js: every device on the café
   network shares one live state, and changes made while offline are queued and sent later. */

const { applyOp, seed, uid } = window.CafeShared;
const KEY = 'cafeflow.v1';      // standalone data
const SKEY = 'cafeflow.server'; // server mode: cached state + unsent changes
const $ = (s, r = document) => r.querySelector(s);
const clone = o => JSON.parse(JSON.stringify(o));
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const dayKey = (t = Date.now()) => new Date(t).toDateString();
const clock = t => new Date(t).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
const clampInt = (v, lo, hi, d) => { const n = parseInt(v, 10); return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : d; };
const ACTIVE = ['new', 'prep', 'ready'];
const FLOW = ['new', 'prep', 'ready', 'done'];
const LABEL = { new: 'New', prep: 'Preparing', ready: 'Ready', done: 'Completed', cancelled: 'Cancelled' };

/* ---------- Sync state ---------- */
const SYNC = { mode: 'local', base: null, ver: 0, outbox: [], online: false, skew: 0, devices: 0, urls: [], flushing: false, retry: null, acks: {} };
const now = () => Date.now() + SYNC.skew; // server-aligned clock so ticket timers agree on every device
const mins = t => Math.max(0, Math.floor((now() - t) / 60000));

function load() {
  let s = null;
  try { s = JSON.parse(localStorage.getItem(KEY)); } catch { /* ignore */ }
  if (!s || !s.v) s = seed();
  const cutoff = Date.now() - 30 * 864e5; // keep 30 days of order history
  s.orders = s.orders.filter(o => o.createdAt > cutoff);
  return s;
}
function save() { try { localStorage.setItem(KEY, JSON.stringify(S)); } catch { toast('Could not save on this device'); } }
function saveCache() { try { localStorage.setItem(SKEY, JSON.stringify({ base: SYNC.base, ver: SYNC.ver, outbox: SYNC.outbox })); } catch { /* ignore */ } }

let cached = null;
try { cached = JSON.parse(localStorage.getItem(SKEY)); } catch { /* ignore */ }
let S = cached && cached.base ? clone(cached.base) : load();
const UI = { view: 'pos', cat: 'all', q: '', cart: [], type: 'dine', table: '', customer: '', note: '', showCart: false, station: 'all', ofilter: 'active', sound: false };
let installPrompt = null;

/* Every change goes through commit(): applied here immediately, and sent to the server if there is one. */
function commit(op, onAck) {
  op.opId = uid() + uid();
  op.at = now();
  if (SYNC.mode === 'local') { applyOp(S, op); save(); render(); if (onAck) onAck({ num: op.order && op.order.num }); return; }
  SYNC.outbox.push(op);
  if (onAck) SYNC.acks[op.opId] = onAck;
  applyOp(S, clone(op));
  saveCache(); render(); flush();
}

function rebuild() { // visible state = last server state + my changes the server hasn't confirmed yet
  S = clone(SYNC.base);
  SYNC.outbox.forEach(op => applyOp(S, clone(op)));
  saveCache(); render();
}
function adopt(d) {
  SYNC.base = d.state; SYNC.ver = d.ver; SYNC.skew = d.now - Date.now();
  if (d.urls) SYNC.urls = d.urls;
  const seen = new Set(d.recentOps || []);
  SYNC.outbox = SYNC.outbox.filter(op => !seen.has(op.opId));
  SYNC.outbox.forEach(op => { op.sent = false; }); // server doesn't have these: send again
  rebuild(); flush();
}
async function fetchState() {
  try { const r = await fetch('api/state', { cache: 'no-store' }); if (r.ok) adopt(await r.json()); } catch { /* offline */ }
}
async function flush() {
  if (SYNC.flushing || SYNC.mode !== 'server') return;
  SYNC.flushing = true; clearTimeout(SYNC.retry);
  try {
    for (const op of SYNC.outbox) {
      if (op.sent) continue;
      const r = await fetch('api/op', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(op) });
      if (r.status >= 400 && r.status < 500) { // rejected: drop it rather than retry forever
        SYNC.outbox = SYNC.outbox.filter(x => x !== op);
        toast('A change was rejected by the server'); rebuild(); continue;
      }
      if (!r.ok) throw new Error('server error');
      const res = await r.json();
      op.sent = true; SYNC.online = true;
      const cb = SYNC.acks[op.opId];
      if (cb) { delete SYNC.acks[op.opId]; cb(res); }
    }
  } catch {
    SYNC.online = false;
    SYNC.retry = setTimeout(flush, 3000);
  }
  SYNC.flushing = false; saveCache(); syncBadge();
  if (SYNC.online && SYNC.outbox.some(o => !o.sent)) flush(); // changes made while we were sending
}
function connect() {
  const es = new EventSource('api/events');
  es.addEventListener('hello', e => {
    const d = JSON.parse(e.data);
    SYNC.online = true; SYNC.skew = d.now - Date.now();
    if (d.ver !== SYNC.ver) fetchState(); else flush();
    syncBadge();
  });
  es.addEventListener('presence', e => { SYNC.devices = JSON.parse(e.data).devices; syncBadge(); });
  es.addEventListener('reload', fetchState);
  es.addEventListener('op', e => {
    const d = JSON.parse(e.data);
    SYNC.skew = d.now - Date.now();
    if (d.ver !== SYNC.ver + 1) return fetchState(); // missed something: resync fully
    applyOp(SYNC.base, d.op); SYNC.ver = d.ver;
    const before = SYNC.outbox.length;
    SYNC.outbox = SYNC.outbox.filter(op => op.opId !== d.op.opId);
    if (before === SYNC.outbox.length && d.op.t === 'addOrder' && UI.sound) beep(); // new order from another device
    rebuild();
  });
  es.onerror = () => { SYNC.online = false; syncBadge(); };
}
async function boot() {
  try {
    const r = await fetch('api/state', { cache: 'no-store' });
    if (!r.ok) throw new Error('no server');
    const d = await r.json();
    SYNC.mode = 'server';
    if (cached) SYNC.outbox = cached.outbox || [];
    adopt(d); connect();
  } catch {
    if (cached && cached.base) { // this device belongs to a café server that is unreachable right now
      Object.assign(SYNC, { mode: 'server', base: cached.base, ver: cached.ver, outbox: cached.outbox || [] });
      rebuild(); connect(); flush();
    }
  }
}
function syncBadge() {
  const el = $('#sync');
  if (SYNC.mode !== 'server') { el.hidden = true; return; }
  const pend = SYNC.outbox.filter(o => !o.sent).length;
  el.hidden = false;
  el.classList.toggle('off', !SYNC.online);
  el.textContent = SYNC.online ? `Live · ${SYNC.devices} device${SYNC.devices === 1 ? '' : 's'}` : `Offline${pend ? ` · ${pend} waiting` : ''}`;
  el.title = SYNC.online ? 'Connected to the café server' : 'Not connected — changes are kept and sent when the connection is back';
}

/* ---------- Helpers ---------- */
const money = n => S.settings.currency + (Math.round(n * 100) / 100).toFixed(2);
const lineTotal = l => (l.price + l.mods.reduce((a, m) => a + m.price, 0)) * l.qty;
const orderTotal = o => o.lines.reduce((a, l) => a + lineTotal(l), 0);
const findOrder = id => S.orders.find(o => o.id === id);
const who = o => o.type === 'dine' ? `Table ${esc(o.table)}` : `Takeaway${o.customer ? ' · ' + esc(o.customer) : ''}`;
const modsText = l => l.mods.length ? `<div class="mods">${l.mods.map(m => esc(m.name)).join(' · ')}</div>` : '';
const nextLabel = o => ({ new: 'Start', prep: 'Mark ready', ready: o.type === 'dine' ? 'Served' : 'Picked up' })[o.status];
const lineKey = l => [l.itemId, l.mods.map(m => m.name).join('|'), l.note].join('#');
const lineOf = (it, mods, note, qty) => ({ itemId: it.id, name: it.name, price: it.price, station: it.station, mods, note, qty });

/* ---------- Views ---------- */
function vPos() {
  const n = UI.cart.reduce((a, l) => a + l.qty, 0), tot = UI.cart.reduce((a, l) => a + lineTotal(l), 0);
  const chip = (id, label) => `<button class="chip ${UI.cat === id ? 'on' : ''}" data-act="cat" data-id="${id}">${esc(label)}</button>`;
  return `<div class="pos ${UI.showCart ? 'show-cart' : ''}">
    <section class="menu-pane">
      <input id="q" class="input" type="search" placeholder="Search menu…" value="${esc(UI.q)}" aria-label="Search menu">
      <div class="chips">${chip('all', 'All')}${S.categories.map(c => chip(c.id, c.name)).join('')}</div>
      <div id="grid" class="grid">${gridHTML()}</div>
    </section>
    <aside class="cart" aria-label="Current order">${cartHTML(tot)}</aside>
    <button class="cartbar" data-act="showCart" ${n ? '' : 'hidden'}><span>View order · ${n} item${n === 1 ? '' : 's'}</span><span>${money(tot)}</span></button>
  </div>`;
}
function gridHTML() {
  const q = UI.q.trim().toLowerCase();
  const list = S.items.filter(i => (UI.cat === 'all' || i.catId === UI.cat) && (!q || i.name.toLowerCase().includes(q)));
  if (!list.length) return '<p class="empty">No items found.</p>';
  return list.map(i => `<button class="item" data-act="pick" data-id="${i.id}" ${i.available ? '' : 'disabled'}>
    <span class="item-name">${esc(i.name)}</span><span class="item-price">${i.available ? money(i.price) : 'Sold out'}</span></button>`).join('');
}
function cartHTML(tot) {
  const busy = new Set(S.orders.filter(o => o.type === 'dine' && ACTIVE.includes(o.status)).map(o => o.table));
  const tables = Array.from({ length: S.settings.tables }, (_, k) => String(k + 1));
  const canSend = UI.cart.length && (UI.type === 'take' || UI.table);
  const where = UI.type === 'dine'
    ? `<div class="lbl">Table${UI.table ? ` <span class="muted">· ${esc(UI.table)} selected</span>` : ''}</div>
       <div class="tables">${tables.map(t => `<button class="tbl ${UI.table === t ? 'on' : ''} ${busy.has(t) ? 'busy' : ''}" data-act="table" data-id="${t}" title="${busy.has(t) ? 'Has an open order' : ''}">${t}</button>`).join('')}</div>`
    : `<label class="lbl">Customer name (optional)<input id="cust" class="input" value="${esc(UI.customer)}" placeholder="Called out when ready"></label>`;
  return `<div class="cart-head"><h2>Current order</h2><button class="icon-btn only-narrow" data-act="hideCart" aria-label="Close order">✕</button></div>
    <div class="seg">${[['dine', 'Dine-in'], ['take', 'Takeaway']].map(([t, l]) => `<button class="${UI.type === t ? 'on' : ''}" data-act="type" data-id="${t}">${l}</button>`).join('')}</div>
    ${where}
    <div class="lines">${UI.cart.length ? UI.cart.map(lineHTML).join('') : '<p class="empty">Tap an item to add it.</p>'}</div>
    <textarea id="onote" class="input" rows="2" placeholder="Order note (e.g. serve drinks first)" aria-label="Order note">${esc(UI.note)}</textarea>
    <div class="total"><span>Total</span><b>${money(tot)}</b></div>
    <div class="row"><button class="btn ghost" data-act="clearCart" ${UI.cart.length ? '' : 'disabled'}>Clear</button>
      <button class="btn primary grow" data-act="send" ${canSend ? '' : 'disabled'}>${UI.cart.length && !canSend ? 'Pick a table' : 'Send to kitchen'}</button></div>`;
}
function lineHTML(l, i) {
  return `<div class="line"><div class="grow"><div class="line-name">${esc(l.name)}</div>${modsText(l)}${l.note ? `<div class="line-note">“${esc(l.note)}”</div>` : ''}</div>
    <div class="qty"><button data-act="dec" data-i="${i}" aria-label="Fewer">−</button><span>${l.qty}</span><button data-act="inc" data-i="${i}" aria-label="More">+</button></div>
    <div class="line-price">${money(lineTotal(l))}</div></div>`;
}

function vKitchen() {
  const st = UI.station;
  const act = S.orders.filter(o => ACTIVE.includes(o.status)).sort((a, b) => a.createdAt - b.createdAt);
  const col = s => {
    const list = act.filter(o => o.status === s).map(o => ticket(o, st)).filter(Boolean);
    return `<section class="kcol k-${s}"><h2>${LABEL[s]}<span class="count">${list.length}</span></h2>${list.join('') || '<p class="empty">Nothing here</p>'}</section>`;
  };
  return `<div class="toolbar"><div class="chips">${[['all', 'All stations'], ['bar', 'Bar · drinks'], ['kitchen', 'Kitchen · food']].map(([id, l]) => `<button class="chip ${st === id ? 'on' : ''}" data-act="station" data-id="${id}">${l}</button>`).join('')}</div>
    <button class="btn ghost sm" data-act="sound">${UI.sound ? '🔔 Sound on' : '🔕 Sound off'}</button></div>
    <div class="kboard">${col('new')}${col('prep')}${col('ready')}</div>`;
}
function ticket(o, st) {
  const lines = o.lines.map((l, i) => [l, i]).filter(([l]) => st === 'all' || (l.station || 'bar') === st);
  if (!lines.length) return '';
  const m = mins(o.createdAt);
  const age = o.status === 'ready' ? '' : m >= S.settings.lateMins ? 'late' : m >= S.settings.warnMins ? 'warn' : '';
  return `<article class="ticket ${age}"><header><b class="onum">#${o.num}</b><span class="who">${who(o)}</span><span class="age" title="Ordered at ${clock(o.createdAt)}">${m} min</span></header>
    <ul>${lines.map(([l, i]) => `<li class="${l.done ? 'done' : ''}" data-act="tline" data-o="${o.id}" data-i="${i}" title="Tap to tick off"><b>${l.qty}×</b> ${esc(l.name)}${modsText(l)}${l.note ? `<div class="line-note">“${esc(l.note)}”</div>` : ''}</li>`).join('')}</ul>
    ${o.note ? `<p class="onote">📝 ${esc(o.note)}</p>` : ''}
    <footer>${o.status !== 'new' ? `<button class="btn ghost sm" data-act="back" data-o="${o.id}" aria-label="Move back a step">↩</button>` : ''}<button class="btn primary grow" data-act="adv" data-o="${o.id}">${nextLabel(o)}</button></footer></article>`;
}

function vOrders() {
  const today = dayKey(now());
  const tod = S.orders.filter(o => dayKey(o.createdAt) === today);
  const valid = tod.filter(o => o.status !== 'cancelled');
  const itemsMade = valid.reduce((a, o) => a + o.lines.reduce((b, l) => b + l.qty, 0), 0);
  const value = valid.reduce((a, o) => a + orderTotal(o), 0);
  const prepped = valid.filter(o => o.times && o.times.ready);
  const avg = prepped.length ? Math.round(prepped.reduce((a, o) => a + (o.times.ready - o.createdAt), 0) / prepped.length / 60000) : null;
  const top = {};
  valid.forEach(o => o.lines.forEach(l => { top[l.name] = (top[l.name] || 0) + l.qty; }));
  const topList = Object.entries(top).sort((a, b) => b[1] - a[1]).slice(0, 5);
  const match = (o, f) => f === 'active' ? ACTIVE.includes(o.status) : o.status === f;
  const f = UI.ofilter;
  const list = tod.filter(o => match(o, f)).sort((a, b) => b.createdAt - a.createdAt);
  const stat = (k, v) => `<div class="stat"><div class="muted sm">${k}</div><div class="stat-v">${v}</div></div>`;
  return `<div class="stats">${stat('Orders today', valid.length)}${stat('Items made', itemsMade)}${stat('Order value', money(value))}${stat('Avg. time to ready', avg === null ? '—' : avg + ' min')}</div>
    <div class="orders-wrap">
      <section class="card"><div class="card-head"><h2>Today's orders</h2>
        <div class="seg sm">${[['active', 'Active'], ['done', 'Completed'], ['cancelled', 'Cancelled']].map(([id, l]) => `<button class="${f === id ? 'on' : ''}" data-act="ofilter" data-id="${id}">${l} <span class="muted">${tod.filter(o => match(o, id)).length}</span></button>`).join('')}</div></div>
        ${list.map(orow).join('') || '<p class="empty">No orders here yet.</p>'}</section>
      <section class="card"><div class="card-head"><h2>Top items today</h2></div>${topList.length ? `<ol class="toplist">${topList.map(([n, q]) => `<li><span>${esc(n)}</span><b>${q}</b></li>`).join('')}</ol>` : '<p class="empty">Nothing ordered yet.</p>'}</section>
    </div>`;
}
function orow(o) {
  const acts = ACTIVE.includes(o.status)
    ? `<button class="btn ghost sm danger" data-act="cancel" data-o="${o.id}">Cancel</button><button class="btn primary sm" data-act="adv" data-o="${o.id}">${nextLabel(o)}</button>`
    : o.status === 'cancelled' ? `<button class="btn ghost sm" data-act="restore" data-o="${o.id}">Restore</button>` : '';
  return `<div class="orow"><div class="orow-main"><div><b>#${o.num}</b> <span class="muted">${clock(o.createdAt)} · ${who(o)}</span> <span class="pill s-${o.status}">${LABEL[o.status]}</span></div>
    <div class="muted sm clip">${o.lines.map(l => `${l.qty}× ${esc(l.name)}`).join(', ')}</div></div>
    <b class="orow-total">${money(orderTotal(o))}</b><div class="orow-acts">${acts}</div></div>`;
}

function vMenu() {
  const items = S.categories.map(c => {
    const its = S.items.filter(i => i.catId === c.id);
    return `<h3 class="cat-h">${esc(c.name)} · ${its.length}</h3>${its.map(i => `<div class="mrow">
      <div class="grow"><div>${esc(i.name)}</div><div class="muted sm">${money(i.price)} · ${i.station === 'kitchen' ? 'Kitchen' : 'Bar'}${i.groups.length ? ` · ${i.groups.length} option group${i.groups.length > 1 ? 's' : ''}` : ''}${i.available ? '' : ' · <b style="color:var(--danger)">Sold out</b>'}</div></div>
      <label class="switch" title="Available to order"><input type="checkbox" data-act="avail" data-id="${i.id}" ${i.available ? 'checked' : ''} aria-label="${esc(i.name)} available"><span></span></label>
      <button class="btn ghost sm" data-act="editItem" data-id="${i.id}">Edit</button></div>`).join('') || '<p class="empty">No items in this category</p>'}`;
  }).join('');
  const cats = S.categories.map((c, i) => `<div class="mrow"><div class="grow">${esc(c.name)}</div>
    <button class="icon-btn" data-act="moveCat" data-id="${c.id}" data-dir="-1" ${i === 0 ? 'disabled' : ''} aria-label="Move up">↑</button>
    <button class="icon-btn" data-act="moveCat" data-id="${c.id}" data-dir="1" ${i === S.categories.length - 1 ? 'disabled' : ''} aria-label="Move down">↓</button>
    <button class="btn ghost sm" data-act="renameCat" data-id="${c.id}">Rename</button>
    <button class="btn ghost sm danger" data-act="delCat" data-id="${c.id}">Delete</button></div>`).join('');
  const groups = S.groups.map(g => `<div class="mrow"><div class="grow"><div>${esc(g.name)} ${g.multi ? '<span class="pill">pick any</span>' : ''}</div>
    <div class="muted sm clip">${g.options.map(o => esc(o.name) + (o.price ? ' +' + money(o.price) : '')).join(' · ')}</div></div>
    <button class="btn ghost sm" data-act="editGroup" data-id="${g.id}">Edit</button></div>`).join('');
  return `<div class="menu-admin">
    <section class="card"><div class="card-head"><h2>Menu items</h2><button class="btn primary sm" data-act="newItem">+ Add item</button></div>
      <p class="muted sm" style="margin:0">Use the switch to mark an item sold out — it greys out on every order screen instantly.</p>${items}</section>
    <div class="stack">
      <section class="card"><div class="card-head"><h2>Categories</h2><button class="btn ghost sm" data-act="newCat">+ Add</button></div>${cats || '<p class="empty">No categories</p>'}</section>
      <section class="card"><div class="card-head"><h2>Option groups</h2><button class="btn ghost sm" data-act="newGroup">+ Add</button></div>
        <p class="muted sm" style="margin:0 0 6px">Size, milk, sweetness, extras… attach them to items.</p>${groups || '<p class="empty">No option groups</p>'}</section>
    </div></div>`;
}

function vSettings() {
  const s = S.settings, server = SYNC.mode === 'server';
  const devices = server
    ? `<section class="card"><h2>Connect devices</h2>
        <p class="muted">Every tablet, phone or PC on the café Wi-Fi can open CafeFlow at:</p>
        ${SYNC.urls.length ? SYNC.urls.map(u => `<p><code class="addr">${esc(u)}</code></p>`).join('') : '<p class="muted">(Address shown in the server window.)</p>'}
        <p class="muted sm">Use one device as the counter (Order) and another as the kitchen screen (Kitchen). Everything updates live. On a phone or tablet, use the browser's <b>Add to Home Screen</b> to get an app icon.</p></section>`
    : `<section class="card"><h2>This device only</h2>
        <p class="muted">CafeFlow is running standalone, so orders stay in this browser. To share orders between the counter and the kitchen on different devices, start the café server (<code>node server.js</code>) and open the address it shows.</p></section>`;
  return `<div class="settings">
    <section class="card"><h2>Café</h2><form id="setForm" class="stack">
      <label class="lbl">Café name<input class="input" name="cafeName" value="${esc(s.cafeName)}"></label>
      <div class="row"><label class="lbl grow">Currency symbol<input class="input" name="currency" value="${esc(s.currency)}" maxlength="4"></label>
        <label class="lbl grow">Number of tables<input class="input" name="tables" type="number" min="0" max="200" value="${s.tables}"></label></div>
      <div class="row"><label class="lbl grow">Ticket turns amber after (min)<input class="input" name="warnMins" type="number" min="1" max="120" value="${s.warnMins}"></label>
        <label class="lbl grow">Ticket turns red after (min)<input class="input" name="lateMins" type="number" min="2" max="240" value="${s.lateMins}"></label></div>
      <button class="btn primary">Save settings</button></form></section>
    ${devices}
    <section class="card"><h2>Install</h2>
      <p class="muted">Android/Chrome/Edge: use the button or the browser menu → <b>Install app</b>. iPad/iPhone: Safari → Share → <b>Add to Home Screen</b>.</p>
      <button class="btn primary" data-act="install" ${installPrompt ? '' : 'hidden'}>Install app</button></section>
    <section class="card"><h2>Backup</h2>
      <p class="muted">${server ? 'Data is stored on the café server (data/cafeflow.json). Export downloads the menu and full order history.' : 'Menu and orders are stored on this device only. Export a backup regularly.'}</p>
      <div class="row"><button class="btn" data-act="export">Export backup</button>
        <label class="btn">Import backup<input type="file" id="importFile" accept="application/json,.json" hidden></label></div></section>
    <section class="card about"><h2>About</h2>
      <picture><source srcset="icons/logo-white.png" media="(prefers-color-scheme: dark)"><img src="icons/logo-blue.png" alt="dekad. teknologies" width="200" height="62"></picture>
      <p class="muted" style="margin:0">CafeFlow — café ordering system by Dekad Teknologies.</p>
      <div class="dots" aria-hidden="true"><i></i><i></i><i></i><i></i><i></i></div></section>
    <section class="card"><h2>Reset</h2><p class="muted">Replace everything with the demo menu and delete all orders${server ? ' — on every device' : ''}.</p>
      <button class="btn danger" data-act="reset">Reset to demo data</button></section>
  </div>`;
}

/* ---------- Dialogs ---------- */
const D = $('#dlg');
D.addEventListener('click', e => { if (e.target === D) D.close(); });
function dlg(html, mount) {
  D.innerHTML = `<div class="dlg-in"><button class="dlg-x icon-btn" type="button" aria-label="Close">✕</button>${html}</div>`;
  $('.dlg-x', D).onclick = () => D.close();
  D.showModal();
  if (mount) mount(D);
}

function openItem(it) {
  const groups = it.groups.map(id => S.groups.find(g => g.id === id)).filter(Boolean);
  let qty = 1;
  dlg(`<form class="sheet" id="itemForm">
    <header class="sheet-head"><h3>${esc(it.name)}</h3><span class="muted">${money(it.price)}</span></header>
    ${groups.map(g => `<fieldset><legend>${esc(g.name)}${g.multi ? ' <small>· choose any</small>' : ''}</legend><div class="opts">${g.options.map((o, k) => `<label class="opt"><input type="${g.multi ? 'checkbox' : 'radio'}" name="g_${g.id}" value="${o.id}" ${!g.multi && k === 0 ? 'checked' : ''}><span>${esc(o.name)}${o.price ? ` <small>+${money(o.price)}</small>` : ''}</span></label>`).join('')}</div></fieldset>`).join('')}
    <fieldset><legend>Note for barista / kitchen</legend><input name="note" class="input" maxlength="80" placeholder="e.g. extra hot, no ice"></fieldset>
    <div class="row"><div class="qty big"><button type="button" data-q="-1" aria-label="Fewer">−</button><span id="mq">1</span><button type="button" data-q="1" aria-label="More">+</button></div>
      <button class="btn primary grow" id="addBtn">Add · ${money(it.price)}</button></div></form>`, d => {
    const f = $('#itemForm', d);
    const read = () => {
      const fd = new FormData(f), mods = [];
      groups.forEach(g => fd.getAll('g_' + g.id).forEach(oid => { const o = g.options.find(x => x.id === oid); if (o) mods.push({ group: g.name, name: o.name, price: o.price }); }));
      return { mods, note: String(fd.get('note') || '').trim() };
    };
    const upd = () => { $('#mq', d).textContent = qty; $('#addBtn', d).textContent = `Add · ${money(lineTotal({ price: it.price, mods: read().mods, qty }))}`; };
    f.addEventListener('change', upd);
    f.addEventListener('click', e => { const b = e.target.closest('[data-q]'); if (b) { qty = Math.max(1, qty + Number(b.dataset.q)); upd(); } });
    f.addEventListener('submit', e => { e.preventDefault(); const { mods, note } = read(); D.close(); addLine(lineOf(it, mods, note, qty)); });
    $('#addBtn', d).focus();
  });
}

function editItem(id) {
  if (!S.categories.length) return toast('Add a category first');
  const it = id ? S.items.find(i => i.id === id) : { name: '', catId: UI.cat !== 'all' ? UI.cat : S.categories[0].id, price: '', station: 'bar', available: true, groups: [] };
  if (!it) return;
  dlg(`<form class="sheet" id="iForm"><header class="sheet-head"><h3>${id ? 'Edit item' : 'New item'}</h3></header>
    <label class="lbl">Name<input class="input" name="name" required maxlength="40" value="${esc(it.name)}"></label>
    <div class="row"><label class="lbl grow">Category<select class="input" name="cat">${S.categories.map(c => `<option value="${c.id}" ${c.id === it.catId ? 'selected' : ''}>${esc(c.name)}</option>`).join('')}</select></label>
      <label class="lbl grow">Price<input class="input" name="price" type="number" step="0.01" min="0" required value="${it.price}"></label></div>
    <label class="lbl">Prepared at<select class="input" name="station"><option value="bar">Bar (drinks)</option><option value="kitchen" ${it.station === 'kitchen' ? 'selected' : ''}>Kitchen (food)</option></select></label>
    <fieldset><legend>Option groups</legend><div class="opts">${S.groups.map(g => `<label class="opt"><input type="checkbox" name="groups" value="${g.id}" ${it.groups.includes(g.id) ? 'checked' : ''}><span>${esc(g.name)}</span></label>`).join('') || '<span class="muted">None yet</span>'}</div></fieldset>
    <label class="opt inline"><input type="checkbox" name="available" ${it.available ? 'checked' : ''}><span>Available to order</span></label>
    <div class="row">${id ? '<button type="button" class="btn ghost danger" id="del">Delete</button>' : ''}<button class="btn primary grow">Save</button></div></form>`, d => {
    const f = $('#iForm', d);
    f.addEventListener('submit', e => {
      e.preventDefault();
      const fd = new FormData(f);
      const data = { name: String(fd.get('name')).trim(), catId: fd.get('cat'), price: Math.max(0, Number(fd.get('price')) || 0), station: fd.get('station'), available: fd.get('available') === 'on', groups: fd.getAll('groups') };
      if (!data.name) return;
      const items = id ? S.items.map(i => i.id === id ? { ...i, ...data } : i) : [...S.items, { id: uid(), ...data }];
      D.close(); commit({ t: 'menu', items }); toast(`${data.name} saved`);
    });
    const del = $('#del', d);
    if (del) del.onclick = () => { if (confirm(`Delete ${it.name}?`)) { D.close(); commit({ t: 'menu', items: S.items.filter(i => i.id !== id) }); } };
  });
}

function editGroup(id) {
  const g = id ? S.groups.find(x => x.id === id) : { name: '', multi: false, options: [] };
  if (!g) return;
  const row = (o = { id: uid(), name: '', price: 0 }) => `<div class="optrow" data-oid="${o.id}"><input class="input grow" placeholder="Option name" value="${esc(o.name)}" aria-label="Option name"><input class="input price" type="number" step="0.01" min="0" value="${o.price || ''}" placeholder="+0.00" aria-label="Extra price"><button type="button" class="icon-btn" data-rm aria-label="Remove option">✕</button></div>`;
  dlg(`<form class="sheet" id="gForm"><header class="sheet-head"><h3>${id ? 'Edit option group' : 'New option group'}</h3></header>
    <label class="lbl">Group name<input class="input" name="name" required maxlength="30" value="${esc(g.name)}" placeholder="e.g. Milk"></label>
    <label class="opt inline"><input type="checkbox" name="multi" ${g.multi ? 'checked' : ''}><span>Customers can pick more than one (e.g. extras)</span></label>
    <p class="muted sm" style="margin:0">Single-choice groups pre-select the first option, so put the default first. Price is the extra charge.</p>
    <div id="optRows" class="stack">${(g.options.length ? g.options : [undefined, undefined]).map(o => row(o)).join('')}</div>
    <button type="button" class="btn ghost sm" id="addOpt">+ Add option</button>
    <div class="row">${id ? '<button type="button" class="btn ghost danger" id="del">Delete</button>' : ''}<button class="btn primary grow">Save</button></div></form>`, d => {
    const f = $('#gForm', d), rows = $('#optRows', d);
    $('#addOpt', d).onclick = () => { rows.insertAdjacentHTML('beforeend', row()); rows.lastElementChild.querySelector('input').focus(); };
    rows.addEventListener('click', e => { const b = e.target.closest('[data-rm]'); if (b) b.closest('.optrow').remove(); });
    f.addEventListener('submit', e => {
      e.preventDefault();
      const options = [...rows.querySelectorAll('.optrow')].map(r => { const [n, p] = r.querySelectorAll('input'); return { id: r.dataset.oid, name: n.value.trim(), price: Math.max(0, Number(p.value) || 0) }; }).filter(o => o.name);
      if (!options.length) return toast('Add at least one option');
      const fd = new FormData(f);
      const data = { name: String(fd.get('name')).trim(), multi: fd.get('multi') === 'on', options };
      const groups = id ? S.groups.map(x => x.id === id ? { ...x, ...data } : x) : [...S.groups, { id: uid(), ...data }];
      D.close(); commit({ t: 'menu', groups });
    });
    const del = $('#del', d);
    if (del) del.onclick = () => {
      if (!confirm(`Delete "${g.name}"? It will be removed from all items.`)) return;
      D.close();
      commit({ t: 'menu', groups: S.groups.filter(x => x.id !== id), items: S.items.map(i => ({ ...i, groups: i.groups.filter(x => x !== id) })) });
    };
  });
}

/* ---------- Actions ---------- */
function addLine(l) {
  const k = lineKey(l), ex = UI.cart.find(x => lineKey(x) === k);
  if (ex) ex.qty += l.qty; else UI.cart.push(l);
  render();
}
function send() {
  if (!UI.cart.length) return;
  if (UI.type === 'dine' && !UI.table) return toast('Pick a table first');
  const order = {
    id: uid() + uid(), type: UI.type, table: UI.type === 'dine' ? UI.table : '', customer: UI.type === 'take' ? UI.customer.trim() : '',
    note: UI.note.trim(), lines: UI.cart.map(l => ({ ...l, done: false })),
  };
  Object.assign(UI, { cart: [], table: '', customer: '', note: '', showCart: false });
  commit({ t: 'addOrder', order }, res => toast(res.num ? `Order #${res.num} sent to kitchen` : 'Order sent to kitchen'));
  if (SYNC.mode === 'server' && !SYNC.online) toast('Saved — it will reach the kitchen when the connection is back');
}
function move(id, step) {
  const o = findOrder(id); if (!o) return;
  const n = FLOW[FLOW.indexOf(o.status) + step];
  if (n) commit({ t: 'status', id, status: n });
}
function exportData() {
  const a = document.createElement('a');
  if (SYNC.mode === 'server') { a.href = 'api/backup'; a.click(); return; }
  a.href = URL.createObjectURL(new Blob([JSON.stringify(S, null, 2)], { type: 'application/json' }));
  a.download = `cafeflow-backup-${new Date().toISOString().slice(0, 10)}.json`;
  a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}
let actx;
function beep() {
  try {
    actx = actx || new AudioContext();
    const o = actx.createOscillator(), g = actx.createGain(), t = actx.currentTime;
    o.frequency.value = 880; g.gain.setValueAtTime(0.2, t); g.gain.exponentialRampToValueAtTime(0.001, t + 0.5);
    o.connect(g).connect(actx.destination); o.start(t); o.stop(t + 0.5);
  } catch { /* audio not available */ }
}

const ACTIONS = {
  cat: d => { UI.cat = d.id; render(); },
  pick: d => { const it = S.items.find(i => i.id === d.id); if (it) it.groups.length ? openItem(it) : addLine(lineOf(it, [], '', 1)); },
  inc: d => { UI.cart[d.i].qty++; render(); },
  dec: d => { const l = UI.cart[d.i]; if (--l.qty <= 0) UI.cart.splice(Number(d.i), 1); render(); },
  type: d => { UI.type = d.id; render(); },
  table: d => { UI.table = UI.table === d.id ? '' : d.id; render(); },
  clearCart: () => { if (confirm('Clear this order?')) { UI.cart = []; render(); } },
  send,
  showCart: () => { UI.showCart = true; render(); },
  hideCart: () => { UI.showCart = false; render(); },
  station: d => { UI.station = d.id; render(); },
  sound: () => { UI.sound = !UI.sound; if (UI.sound) beep(); render(); },
  adv: d => move(d.o, 1),
  back: d => move(d.o, -1),
  tline: d => { const o = findOrder(d.o), i = Number(d.i); if (o && o.lines[i]) commit({ t: 'line', id: o.id, i, done: !o.lines[i].done }); },
  cancel: d => { const o = findOrder(d.o); if (o && confirm(`Cancel order #${o.num}?`)) commit({ t: 'status', id: o.id, status: 'cancelled' }); },
  restore: d => commit({ t: 'status', id: d.o, status: 'new' }),
  ofilter: d => { UI.ofilter = d.id; render(); },
  avail: (d, el) => { const it = S.items.find(i => i.id === d.id); if (!it) return; commit({ t: 'avail', id: it.id, available: el.checked }); toast(`${it.name} ${el.checked ? 'is available again' : 'marked sold out'}`); },
  newItem: () => editItem(null),
  editItem: d => editItem(d.id),
  newCat: () => { const n = prompt('New category name'); if (n && n.trim()) commit({ t: 'menu', categories: [...S.categories, { id: uid(), name: n.trim() }] }); },
  renameCat: d => { const c = S.categories.find(x => x.id === d.id); const n = c && prompt('Rename category', c.name); if (n && n.trim()) commit({ t: 'menu', categories: S.categories.map(x => x.id === d.id ? { ...x, name: n.trim() } : x) }); },
  delCat: d => {
    if (S.items.some(i => i.catId === d.id)) return toast('Move or delete its items first');
    if (UI.cat === d.id) UI.cat = 'all';
    commit({ t: 'menu', categories: S.categories.filter(c => c.id !== d.id) });
  },
  moveCat: d => {
    const a = [...S.categories], i = a.findIndex(c => c.id === d.id), j = i + Number(d.dir);
    if (i < 0 || j < 0 || j >= a.length) return;
    [a[i], a[j]] = [a[j], a[i]]; commit({ t: 'menu', categories: a });
  },
  newGroup: () => editGroup(null),
  editGroup: d => editGroup(d.id),
  install: async () => { if (!installPrompt) return; installPrompt.prompt(); await installPrompt.userChoice; installPrompt = null; render(); },
  export: exportData,
  reset: () => {
    if (!confirm(`Replace the menu and delete ALL orders${SYNC.mode === 'server' ? ' on every device' : ''}?`)) return;
    UI.cart = []; UI.cat = 'all'; commit({ t: 'replace', state: seed() }); toast('Reset to demo data');
  },
};

document.addEventListener('click', e => {
  const el = e.target.closest('[data-act]');
  if (!el || el.closest('dialog')) return;
  const fn = ACTIONS[el.dataset.act];
  if (fn) fn(el.dataset, el);
});
document.addEventListener('input', e => {
  const t = e.target;
  if (t.id === 'q') { UI.q = t.value; $('#grid').innerHTML = gridHTML(); }
  else if (t.id === 'cust') UI.customer = t.value;
  else if (t.id === 'onote') UI.note = t.value;
});
document.addEventListener('submit', e => {
  if (e.target.id !== 'setForm') return;
  e.preventDefault();
  const f = new FormData(e.target);
  const warnMins = clampInt(f.get('warnMins'), 1, 120, 8);
  commit({ t: 'settings', settings: {
    cafeName: String(f.get('cafeName') || '').trim() || 'My Café',
    currency: String(f.get('currency') || '').trim(),
    tables: clampInt(f.get('tables'), 0, 200, 12),
    warnMins,
    lateMins: Math.max(warnMins + 1, clampInt(f.get('lateMins'), 2, 240, 15)),
  } });
  toast('Settings saved');
});
document.addEventListener('change', async e => {
  if (e.target.id !== 'importFile') return;
  const file = e.target.files[0]; if (!file) return;
  try {
    const data = JSON.parse(await file.text());
    if (!data.v || !Array.isArray(data.items) || !Array.isArray(data.orders) || !data.settings) throw new Error('bad');
    if (confirm('Replace all data with this backup?')) { commit({ t: 'replace', state: data }); toast('Backup restored'); }
  } catch { toast('That file is not a CafeFlow backup'); }
  e.target.value = '';
});

/* Standalone mode: another tab on this device changed the data (e.g. a kitchen window). */
window.addEventListener('storage', e => {
  if (SYNC.mode !== 'local' || e.key !== KEY || !e.newValue) return;
  const before = S.orders.filter(o => o.status === 'new').length;
  try { S = JSON.parse(e.newValue); } catch { return; }
  if (UI.sound && S.orders.filter(o => o.status === 'new').length > before) beep();
  render();
});
window.addEventListener('beforeinstallprompt', e => { e.preventDefault(); installPrompt = e; if (UI.view === 'settings') render(); });

/* ---------- Render + boot ---------- */
const T = Object.assign(document.createElement('div'), { id: 'toast' });
T.setAttribute('role', 'status');
let tt;
function toast(msg) {
  (D.open ? D : document.body).appendChild(T); // inside the dialog's top layer when one is open
  T.textContent = msg; T.classList.add('show');
  clearTimeout(tt); tt = setTimeout(() => T.classList.remove('show'), 2400);
}

const VIEWS = { pos: vPos, kitchen: vKitchen, orders: vOrders, menu: vMenu, settings: vSettings };
function render() {
  // Live updates from other devices re-render often: keep the cursor where the user is typing.
  const a = document.activeElement;
  const fid = a && a.id && $('#main').contains(a) ? a.id : null;
  const sel = fid && typeof a.selectionStart === 'number' ? [a.selectionStart, a.selectionEnd] : null;
  $('#brand-name').textContent = S.settings.cafeName;
  document.querySelectorAll('.nav a').forEach(el => el.classList.toggle('on', el.dataset.view === UI.view));
  const live = S.orders.filter(o => o.status === 'new' || o.status === 'prep').length;
  const b = $('#kbadge'); b.textContent = live; b.hidden = !live;
  $('#main').innerHTML = VIEWS[UI.view]();
  syncBadge();
  if (fid) {
    const n = document.getElementById(fid);
    if (n) { n.focus({ preventScroll: true }); if (sel) try { n.setSelectionRange(sel[0], sel[1]); } catch { /* not a text field */ } }
  }
}
function route() {
  const v = location.hash.slice(1);
  UI.view = VIEWS[v] ? v : 'pos'; UI.showCart = false;
  render(); window.scrollTo(0, 0);
}
window.addEventListener('hashchange', route);
route();
boot();
setInterval(() => { if ((UI.view === 'kitchen' || UI.view === 'orders') && !D.open) render(); }, 15000); // keep ticket timers fresh

if ('serviceWorker' in navigator && window.isSecureContext) navigator.serviceWorker.register('sw.js').catch(() => {});
