'use strict';
/* CafeFlow customer ordering page — opened by scanning a table QR code:
   order.html?t=5 (table 5) or order.html?t=take (takeaway). Talks only to /api/public/*. */

const $ = (s, r = document) => r.querySelector(s);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const T = (new URLSearchParams(location.search).get('t') || '').trim().toLowerCase();
const TAKE = T === 'take';
const K = (new URLSearchParams(location.search).get('k') || '').trim(); // table key from the QR code
const KEY = 'cafeflow.my-orders';
const C = { menu: null, cat: 'all', cart: [], view: 'menu', orderId: null, order: null, name: '', note: '', busy: false, offline: false };
const D = $('#dlg');
let pollTimer = null;

const money = n => (C.menu ? C.menu.currency : '') + (Math.round(n * 100) / 100).toFixed(2);
const lineTotal = l => (l.price + l.mods.reduce((a, m) => a + m.price, 0)) * l.qty;
const cartTotal = () => C.cart.reduce((a, l) => a + lineTotal(l), 0);
const cartCount = () => C.cart.reduce((a, l) => a + l.qty, 0);
const validTable = () => TAKE || (/^\d+$/.test(T) && +T >= 1 && +T <= C.menu.tables);
const lineKey = l => [l.itemId, l.mods.map(m => m.id).join('|'), l.note].join('#');

function myOrders() {
  try { return (JSON.parse(localStorage.getItem(KEY)) || []).filter(o => Date.now() - o.at < 12 * 3600e3); } catch { return []; }
}
function remember(id) {
  const list = [{ id, at: Date.now(), t: T }, ...myOrders()].slice(0, 10);
  try { localStorage.setItem(KEY, JSON.stringify(list)); } catch { /* private mode */ }
}

let tt;
const Tst = Object.assign(document.createElement('div'), { id: 'toast' });
Tst.setAttribute('role', 'status');
function toast(msg) {
  (D.open ? D : document.body).appendChild(Tst);
  Tst.textContent = msg; Tst.classList.add('show');
  clearTimeout(tt); tt = setTimeout(() => Tst.classList.remove('show'), 3200);
}

async function loadMenu() {
  const r = await fetch(`api/public/menu?t=${encodeURIComponent(T)}&k=${encodeURIComponent(K)}`, { cache: 'no-store' });
  if (!r.ok) throw new Error('menu');
  C.menu = await r.json(); C.offline = false;
  document.title = `${C.menu.cafeName} · Order`;
}

/* ---------- Views ---------- */
const msg = (title, text, btn = '') => `<div class="c-msg"><h2>${title}</h2><p class="muted">${text}</p>${btn}</div>`;

function vMenu() {
  const recent = myOrders().find(o => o.t === T);
  const cats = C.menu.categories.filter(c => C.menu.items.some(i => i.catId === c.id));
  const chip = (id, label) => `<button class="chip ${C.cat === id ? 'on' : ''}" data-act="cat" data-id="${id}">${esc(label)}</button>`;
  const shown = C.cat === 'all' ? cats : cats.filter(c => c.id === C.cat);
  const n = cartCount();
  return `${recent ? `<button class="banner" data-act="status" data-id="${recent.id}">📋 See your order status</button>` : ''}
    <div class="chips c-chips">${chip('all', 'All')}${cats.map(c => chip(c.id, c.name)).join('')}</div>
    ${shown.map(c => `<h3 class="cat-h">${esc(c.name)}</h3><div class="c-list">${C.menu.items.filter(i => i.catId === c.id).map(i => `
      <button class="c-item" data-act="pick" data-id="${i.id}" ${i.available ? '' : 'disabled'}>
        <span class="c-item-name">${esc(i.name)}</span><span class="c-item-price">${i.available ? money(i.price) : 'Sold out'}</span><span class="c-add" aria-hidden="true">+</span>
      </button>`).join('')}</div>`).join('')}
    <div class="c-spacer"></div>
    ${n ? `<button class="c-bar" data-act="cart"><span>View order · ${n} item${n === 1 ? '' : 's'}</span><span>${money(cartTotal())}</span></button>` : ''}`;
}

function vCart() {
  return `<div class="c-cart">
    <div class="row"><button class="btn ghost sm" data-act="back">← Menu</button><h2 class="grow">Your order</h2></div>
    <div class="card"><div class="lines">${C.cart.map((l, i) => `<div class="line"><div class="grow"><div class="line-name">${esc(l.name)}</div>
      ${l.mods.length ? `<div class="mods">${l.mods.map(m => esc(m.name)).join(' · ')}</div>` : ''}${l.note ? `<div class="line-note">“${esc(l.note)}”</div>` : ''}</div>
      <div class="qty"><button data-act="dec" data-i="${i}" aria-label="Fewer">−</button><span>${l.qty}</span><button data-act="inc" data-i="${i}" aria-label="More">+</button></div>
      <div class="line-price">${money(lineTotal(l))}</div></div>`).join('')}</div>
      <div class="total"><span>Total</span><b>${money(cartTotal())}</b></div></div>
    ${TAKE ? `<label class="lbl">Your name<input id="c-name" class="input" maxlength="30" autocomplete="given-name" value="${esc(C.name)}" placeholder="So we can call you when it's ready"></label>` : ''}
    <label class="lbl">Anything we should know? (optional)<textarea id="c-note" class="input" rows="2" maxlength="120" placeholder="e.g. allergies, bring drinks first">${esc(C.note)}</textarea></label>
    <p class="muted sm" style="margin:0">💳 You pay at the counter. Prices are confirmed by the café.</p>
    <button class="btn primary c-wide" data-act="place" ${C.busy ? 'disabled' : ''}>${C.busy ? 'Sending…' : `Place order · ${money(cartTotal())}`}</button>
  </div>`;
}

function vStatus() {
  const o = C.order;
  if (!o) return '<p class="empty">Loading your order…</p>';
  const dine = o.type === 'dine';
  const head = {
    pending: ['Order sent', 'Waiting for the café to confirm it…'],
    new: ['Order accepted', "You're in the queue."],
    prep: ['Being prepared', "Won't be long!"],
    ready: dine ? ['Ready!', 'Your order is on its way to your table.'] : ['Ready for pickup!', 'Please collect it at the counter.'],
    done: [dine ? 'Served' : 'Picked up', 'Enjoy! 😊'],
    cancelled: ['Order cancelled', 'Please speak to our staff.'],
  }[o.status] || ['Order', ''];
  const flow = ['pending', 'new', 'prep', 'ready', 'done'], at = flow.indexOf(o.status);
  const steps = [['Sent', 0], ['Accepted', 1], ['Preparing', 2], ['Ready', 3]];
  return `<div class="c-status st-${o.status}">
    <div class="muted sm">${dine ? `Table ${esc(o.table)}` : 'Takeaway'} · Order number</div>
    <div class="c-num">#${o.num}</div>
    <h2>${head[0]}</h2><p class="muted" style="margin:4px 0 0">${head[1]}</p>
    ${o.status !== 'cancelled' ? `<ol class="c-steps">${steps.map(([l, i]) => `<li class="${at >= i ? 'on' : ''}">${l}</li>`).join('')}</ol>` : ''}
    <div class="card c-sum">${o.lines.map(l => `<div class="line"><b>${l.qty}×</b><div class="grow">${esc(l.name)}${l.mods.length ? `<div class="mods">${l.mods.map(esc).join(' · ')}</div>` : ''}</div></div>`).join('')}
      <div class="total"><span>Total</span><b>${money(o.total)}</b></div><p class="muted sm" style="margin:6px 0 0">Pay at the counter.</p></div>
    <button class="btn primary c-wide" data-act="more">Order something else</button>
    ${C.offline ? '<p class="muted sm">Reconnecting…</p>' : ''}
  </div>`;
}

function render() {
  const app = $('#app');
  if (!C.menu) {
    app.innerHTML = msg("Can't reach the café", "Make sure you're connected to the café's Wi-Fi, then try again.", '<button class="btn primary" data-act="retry">Try again</button>');
    return;
  }
  $('#c-cafe').textContent = C.menu.cafeName;
  const w = $('#c-where'); w.hidden = !validTable(); w.textContent = TAKE ? 'Takeaway' : `Table ${T}`;
  if (!validTable()) { app.innerHTML = msg('Scan the QR code on your table', 'This link is missing a valid table number.'); return; }
  if (C.view === 'status') { app.innerHTML = vStatus(); return; }
  if (!C.menu.tableOk) { app.innerHTML = msg('This QR code has expired', 'Please ask our staff for a new one, or order at the counter.'); return; }
  if (!C.menu.qrEnabled) { app.innerHTML = msg('Ordering by QR is paused', 'Please order at the counter. Sorry for the trouble!'); return; }
  if (C.view === 'cart' && !C.cart.length) C.view = 'menu';
  app.innerHTML = C.view === 'cart' ? vCart() : vMenu();
}

/* ---------- Item options ---------- */
function openItem(it) {
  const groups = it.groups.map(id => C.menu.groups.find(g => g.id === id)).filter(g => g && g.options.length);
  let qty = 1;
  D.innerHTML = `<div class="dlg-in"><button class="dlg-x icon-btn" type="button" aria-label="Close">✕</button><form class="sheet" id="itemForm">
    <header class="sheet-head"><h3>${esc(it.name)}</h3><span class="muted">${money(it.price)}</span></header>
    ${groups.map(g => `<fieldset><legend>${esc(g.name)}${g.multi ? ' <small>· choose any</small>' : ''}</legend><div class="opts">${g.options.map((o, k) => `<label class="opt"><input type="${g.multi ? 'checkbox' : 'radio'}" name="g_${g.id}" value="${o.id}" ${!g.multi && k === 0 ? 'checked' : ''}><span>${esc(o.name)}${o.price ? ` <small>+${money(o.price)}</small>` : ''}</span></label>`).join('')}</div></fieldset>`).join('')}
    <fieldset><legend>Special request</legend><input name="note" class="input" maxlength="80" placeholder="e.g. extra hot, no ice"></fieldset>
    <div class="row"><div class="qty big"><button type="button" data-q="-1" aria-label="Fewer">−</button><span id="mq">1</span><button type="button" data-q="1" aria-label="More">+</button></div>
      <button class="btn primary grow" id="addBtn">Add · ${money(it.price)}</button></div></form></div>`;
  const f = $('#itemForm', D);
  const read = () => {
    const fd = new FormData(f), mods = [];
    groups.forEach(g => fd.getAll('g_' + g.id).forEach(oid => { const o = g.options.find(x => x.id === oid); if (o) mods.push({ id: o.id, name: o.name, price: o.price }); }));
    return { mods, note: String(fd.get('note') || '').trim() };
  };
  const upd = () => { $('#mq', D).textContent = qty; $('#addBtn', D).textContent = `Add · ${money(lineTotal({ price: it.price, mods: read().mods, qty }))}`; };
  $('.dlg-x', D).onclick = () => D.close();
  f.addEventListener('change', upd);
  f.addEventListener('click', e => { const b = e.target.closest('[data-q]'); if (b) { qty = Math.max(1, Math.min(20, qty + Number(b.dataset.q))); upd(); } });
  f.addEventListener('submit', e => {
    e.preventDefault();
    const { mods, note } = read();
    const line = { itemId: it.id, name: it.name, price: it.price, mods, note, qty };
    const ex = C.cart.find(x => lineKey(x) === lineKey(line));
    if (ex) ex.qty = Math.min(20, ex.qty + qty); else C.cart.push(line);
    D.close(); render(); toast(`Added ${qty}× ${it.name}`);
  });
  D.showModal();
}
D.addEventListener('click', e => { if (e.target === D) D.close(); });

/* ---------- Ordering + status ---------- */
async function place() {
  if (C.busy || !C.cart.length) return;
  C.busy = true; render();
  try {
    const r = await fetch('api/public/order', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ table: T, key: K, customer: C.name, note: C.note, lines: C.cart.map(l => ({ itemId: l.itemId, qty: l.qty, options: l.mods.map(m => m.id), note: l.note })) }),
    });
    const d = await r.json().catch(() => ({}));
    if (!r.ok) {
      toast(d.error || 'Could not send your order. Please try again.');
      if (r.status === 409) await loadMenu().catch(() => {});
      return;
    }
    remember(d.id);
    C.cart = []; C.note = '';
    showStatus(d.id);
  } catch {
    toast("No connection. Check you're on the café Wi-Fi and try again.");
  } finally {
    C.busy = false; render();
  }
}
function showStatus(id) {
  C.view = 'status'; C.orderId = id; C.order = null;
  render(); window.scrollTo(0, 0); poll();
}
async function poll() {
  clearTimeout(pollTimer);
  if (C.view !== 'status') return;
  const id = C.orderId;
  try {
    const r = await fetch('api/public/order/' + encodeURIComponent(id), { cache: 'no-store' });
    if (r.status === 404) { C.view = 'menu'; render(); return; }
    const o = await r.json();
    if (id !== C.orderId) return;
    if (C.order && C.order.status !== 'ready' && o.status === 'ready' && navigator.vibrate) navigator.vibrate([200, 100, 200]);
    C.order = o; C.offline = false;
  } catch { C.offline = true; }
  render();
  if (!C.order || !['done', 'cancelled'].includes(C.order.status)) pollTimer = setTimeout(poll, C.offline ? 6000 : 4000);
}

const ACTIONS = {
  retry: () => init(),
  cat: d => { C.cat = d.id; render(); },
  pick: d => { const it = C.menu.items.find(i => i.id === d.id); if (it && it.available) openItem(it); },
  cart: () => { C.view = 'cart'; render(); window.scrollTo(0, 0); },
  back: () => { C.view = 'menu'; render(); },
  inc: d => { const l = C.cart[d.i]; l.qty = Math.min(20, l.qty + 1); render(); },
  dec: d => { const l = C.cart[d.i]; if (--l.qty <= 0) C.cart.splice(Number(d.i), 1); render(); },
  place,
  status: d => showStatus(d.id),
  more: () => { clearTimeout(pollTimer); C.view = 'menu'; render(); window.scrollTo(0, 0); },
};
document.addEventListener('click', e => {
  const el = e.target.closest('[data-act]');
  if (!el || el.closest('dialog')) return;
  const fn = ACTIONS[el.dataset.act];
  if (fn) fn(el.dataset, el);
});
document.addEventListener('input', e => {
  if (e.target.id === 'c-name') C.name = e.target.value;
  else if (e.target.id === 'c-note') C.note = e.target.value;
});

async function init() {
  try { await loadMenu(); } catch { C.menu = null; }
  render();
}
init();
// Keep sold-out items and opening state fresh while browsing.
setInterval(() => { if (C.view === 'menu' && !D.open) loadMenu().then(render).catch(() => {}); }, 60000);
