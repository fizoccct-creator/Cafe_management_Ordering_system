'use strict';
/* CafeFlow demo mode: the whole café runs in this browser, with no server.
   The staff app (demo-app.html) and the guest page (demo-order.html) share one demo café stored
   under "cafeflow-demo.*" in localStorage, so it never touches real café data.
   This file stands in for the server's /api/ routes and fills the café with sample orders.
   Load it after shared.js and before app.js / customer.js. */
(function () {
  const NS = window.CAFE_NS = 'cafeflow-demo';
  const KEY = NS + '.v1';
  const { seed, applyOp, uid } = window.CafeShared;

  const read = () => { try { const s = JSON.parse(localStorage.getItem(KEY)); return s && s.v ? s : null; } catch { return null; } };
  const write = s => { try { localStorage.setItem(KEY, JSON.stringify(s)); } catch { /* private mode */ } };

  /* The demo opens on a café that is ready but has no orders yet (order numbers start at #1),
     so a walkthrough can begin from the first staff or guest order.
     fresh(true) adds a café mid-morning instead: orders served, some in the kitchen, one waiting for approval. */
  const VERSION = 2; // bump when the starting data changes, so returning visitors start over
  function fresh(withSamples = false) {
    const s = seed();
    s.settings.cafeName = 'Dekad Demo Café';
    s.settings.theme = 'electric';
    if (!withSamples) return s;
    const item = n => s.items.find(i => i.name === n);
    const opt = (g, o) => { const grp = s.groups.find(x => x.name === g), op = grp.options.find(x => x.name === o); return { group: grp.name, name: op.name, price: op.price }; };
    const line = (n, qty, mods = [], note = '') => { const it = item(n); return { itemId: it.id, name: it.name, price: it.price, station: it.station, qty, mods, note, done: false }; };
    const now = Date.now(), min = 60e3;
    const sample = [ // minutes ago, type, table, name, lines, statuses after "new", source
      [95, 'dine', '3', '', [line('Latte', 2, [opt('Milk', 'Oat')]), line('Banana Bread', 1)], ['prep', 'ready', 'done']],
      [82, 'take', '', 'Aisha', [line('Americano', 1, [opt('Temperature', 'Iced')])], ['prep', 'ready', 'done']],
      [64, 'dine', '7', '', [line('Cappuccino', 1), line('Butter Croissant', 2, [opt('Serve', 'Warmed')])], ['prep', 'ready', 'done'], 'qr'],
      [47, 'dine', '1', '', [line('Mocha', 1, [opt('Size', 'Large')])], ['prep', 'ready', 'done']],
      [36, 'take', '', 'Ben', [line('Matcha Latte', 1, [opt('Sweetness', 'Less sweet')])], ['prep', 'ready', 'done'], 'qr'],
      [19, 'dine', '4', '', [line('Club Sandwich', 1), line('Iced Lemon Tea', 1)], ['prep', 'ready']],
      [11, 'dine', '9', '', [line('Flat White', 2), line('Banana Bread', 1, [], 'Cut in half please')], ['prep'], 'qr'],
      [5, 'take', '', 'Mei', [line('Chocolate', 1, [opt('Temperature', 'Iced')])], ['prep']],
      [2, 'dine', '2', '', [line('Espresso', 2)], []],
      [1, 'dine', '6', '', [line('Latte', 1, [opt('Size', 'Large'), opt('Milk', 'Almond')]), line('Butter Croissant', 1, [opt('Serve', 'Warmed')])], null, 'qr'],
    ];
    for (const [ago, type, table, customer, lines, flow, source] of sample) {
      const at = now - ago * min, id = uid() + uid();
      applyOp(s, { t: 'addOrder', at, order: { id, type, table, customer, note: '', lines, source, status: flow ? 'new' : 'pending' } });
      (flow || []).forEach((st, k) => applyOp(s, { t: 'status', id, status: st, at: Math.min(now - 30e3, at + (k + 1) * 4 * min) }));
    }
    return s;
  }
  const version = () => { try { return Number(localStorage.getItem(NS + '.version')); } catch { return 0; } };
  function reset(withSamples = false) {
    try { Object.keys(localStorage).filter(k => k.startsWith(NS + '.')).forEach(k => localStorage.removeItem(k)); } catch { /* ignore */ }
    write(fresh(withSamples));
    try { localStorage.setItem(NS + '.version', String(VERSION)); } catch { /* ignore */ }
  }
  function state() {
    let s = version() === VERSION ? read() : null;
    if (!s) { reset(); s = read() || fresh(); }
    return s;
  }
  window.CafeDemo = { state, reset, fresh };
  state();

  /* ---------- Stand-in for the server's /api/ routes ---------- */
  class HttpErr extends Error { constructor(status, msg) { super(msg); this.status = status; } }
  const clip = (v, n) => String(v == null ? '' : v).trim().slice(0, n);
  const lineTotal = l => (l.price + l.mods.reduce((a, m) => a + m.price, 0)) * l.qty;

  function publicMenu() {
    const s = state(), st = s.settings;
    return {
      cafeName: st.cafeName, currency: st.currency, theme: st.theme || 'electric', tables: st.tables, qrEnabled: st.qrEnabled !== false, tableOk: true,
      categories: s.categories, groups: s.groups,
      items: s.items.map(({ id, name, catId, price, available, groups }) => ({ id, name, catId, price, available, groups })),
    };
  }
  function placeOrder(b) { // same checks and repricing as server.js
    const s = state(), st = s.settings;
    if (st.qrEnabled === false) throw new HttpErr(403, 'Ordering by QR code is paused. Please order at the counter.');
    const take = b.table === 'take', n = parseInt(b.table, 10);
    if (!take && !(String(n) === String(b.table) && n >= 1 && n <= st.tables)) throw new HttpErr(400, 'Unknown table.');
    if (!Array.isArray(b.lines) || !b.lines.length) throw new HttpErr(400, 'Your order is empty');
    const lines = b.lines.map(l => {
      const it = s.items.find(i => i.id === l.itemId);
      if (!it) throw new HttpErr(409, 'An item in your order is no longer on the menu');
      if (!it.available) throw new HttpErr(409, `Sorry, ${it.name} has just sold out`);
      const chosen = new Set(l.options || []), mods = [];
      for (const gid of it.groups) {
        const g = s.groups.find(x => x.id === gid);
        if (!g || !g.options.length) continue;
        let picks = g.options.filter(o => chosen.has(o.id));
        if (!g.multi) picks = picks.length ? [picks[0]] : [g.options[0]];
        picks.forEach(o => mods.push({ group: g.name, name: o.name, price: o.price }));
      }
      return { itemId: it.id, name: it.name, price: it.price, station: it.station, qty: Math.min(20, Math.max(1, parseInt(l.qty, 10) || 1)), mods, note: clip(l.note, 80), done: false };
    });
    const order = { id: uid() + uid() + uid(), type: take ? 'take' : 'dine', table: take ? '' : String(n), customer: take ? clip(b.customer, 30) : '',
      note: clip(b.note, 120), lines, source: 'qr', status: st.qrApproval === false ? 'new' : 'pending' };
    const op = { t: 'addOrder', at: Date.now(), order };
    applyOp(s, op); write(s); // the staff app in another tab sees this through the "storage" event
    return { ok: true, id: order.id, num: op.order.num };
  }
  function orderStatus(id) {
    const s = state(), o = s.orders.find(x => x.id === id);
    if (!o) throw new HttpErr(404, 'Order not found');
    return { num: o.num, status: o.status, type: o.type, table: o.table, createdAt: o.createdAt, currency: s.settings.currency,
      total: o.lines.reduce((a, l) => a + lineTotal(l), 0), lines: o.lines.map(l => ({ name: l.name, qty: l.qty, mods: l.mods.map(m => m.name) })) };
  }

  const realFetch = window.fetch.bind(window);
  const reply = (status, body) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
  window.fetch = async function (input, init = {}) {
    const url = new URL(typeof input === 'string' ? input : input.url, location.href);
    const at = url.pathname.indexOf('/api/');
    if (url.origin !== location.origin || at < 0) return realFetch(input, init);
    const p = url.pathname.slice(at), method = String(init.method || 'GET').toUpperCase();
    try {
      if (p === '/api/public/menu') return reply(200, publicMenu());
      if (p === '/api/public/order' && method === 'POST') return reply(200, placeOrder(JSON.parse(init.body || '{}')));
      if (p.startsWith('/api/public/order/')) return reply(200, orderStatus(decodeURIComponent(p.slice('/api/public/order/'.length))));
    } catch (e) { return reply(e.status || 400, { error: e.message }); }
    throw new TypeError('Demo mode has no server'); // staff app stays in this-browser mode
  };

  /* ---------- Walkthrough video (media/walkthrough.mp4, recorded with tools/video/record-walkthrough.mjs) ----------
     Tour page: a small player in the bottom-right corner. App pages: a "Watch the walkthrough" link in the demo strip.
     Both open the full video in a dialog. */
  const VIDEO = 'media/walkthrough.mp4', POSTER = 'media/walkthrough.jpg';
  const X = '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M18 6 6 18"/><path d="m6 6 12 12"/></svg>';
  const PLAY = '<svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor" aria-hidden="true"><path d="M8 5.5v13a1 1 0 0 0 1.5.86l10.5-6.5a1 1 0 0 0 0-1.72L9.5 4.64A1 1 0 0 0 8 5.5Z"/></svg>';
  function styles() {
    if (document.getElementById('wt-style')) return;
    const s = document.createElement('style'); s.id = 'wt-style';
    s.textContent = `
      .wt-corner { position: fixed; right: 20px; bottom: 20px; z-index: 60; width: 280px; background: #fff; color: #1F1B16; border-radius: 14px; box-shadow: 0 1px 2px rgba(31,27,22,.08), 0 12px 32px rgba(31,27,22,.16); overflow: hidden; font: 14px/1.4 Poppins, system-ui, sans-serif; }
      .wt-thumb { display: block; position: relative; width: 100%; padding: 0; border: 0; background: #F6F3EC; cursor: pointer; aspect-ratio: 16 / 9; }
      .wt-thumb video { display: block; width: 100%; height: 100%; object-fit: cover; }
      .wt-play { position: absolute; left: 12px; bottom: 12px; width: 36px; height: 36px; border-radius: 50%; display: grid; place-items: center; background: #1F5EFF; color: #fff; box-shadow: 0 2px 8px rgba(0,0,0,.2); }
      .wt-meta { display: flex; align-items: center; gap: 8px; padding: 10px 12px; }
      .wt-meta b { font-weight: 500; flex: 1; }
      .wt-meta span { color: #7B7266; font-size: 12px; }
      .wt-hide { width: 28px; height: 28px; border: 0; border-radius: 8px; background: transparent; color: #7B7266; display: grid; place-items: center; cursor: pointer; }
      .wt-hide:hover { background: #EFEAE1; }
      .wt-dlg { width: min(960px, calc(100vw - 32px)); padding: 0; border: 0; border-radius: 16px; background: #1F1B16; overflow: hidden; }
      .wt-dlg::backdrop { background: rgba(20, 16, 12, .6); }
      .wt-dlg video { display: block; width: 100%; height: auto; }
      .wt-x { position: absolute; top: 10px; right: 10px; z-index: 1; width: 36px; height: 36px; border: 0; border-radius: 10px; display: grid; place-items: center; background: rgba(255,255,255,.9); color: #1F1B16; cursor: pointer; }
      @media (max-width: 600px) { .wt-corner { width: 188px; right: 12px; bottom: 12px; } .wt-meta span { display: none; } }
      @media (prefers-reduced-motion: reduce) { .wt-thumb video { display: none; } .wt-thumb { background: #F6F3EC url(${POSTER}) center / cover; } }
    `;
    document.head.appendChild(s);
  }
  function openWalkthrough() {
    styles();
    let d = document.getElementById('wt-dlg');
    if (!d) {
      d = document.createElement('dialog'); d.id = 'wt-dlg'; d.className = 'wt-dlg'; d.setAttribute('aria-label', 'CafeFlow walkthrough video');
      d.innerHTML = `<button type="button" class="wt-x" aria-label="Close">${X}</button><video src="${VIDEO}" poster="${POSTER}" controls playsinline preload="metadata"></video>`;
      document.body.appendChild(d);
      d.querySelector('.wt-x').onclick = () => d.close();
      d.addEventListener('click', e => { if (e.target === d) d.close(); });
      d.addEventListener('close', () => d.querySelector('video').pause());
    }
    d.showModal();
    const v = d.querySelector('video'); v.currentTime = 0; v.play().catch(() => {});
  }
  window.CafeDemo.openWalkthrough = openWalkthrough;
  function cornerPlayer() {
    try { if (localStorage.getItem(NS + '.wt-hidden')) return; } catch { /* ignore */ }
    styles();
    const c = document.createElement('div'); c.className = 'wt-corner';
    c.innerHTML = `<button type="button" class="wt-thumb" aria-label="Play the 40-second walkthrough video"><video src="${VIDEO}" poster="${POSTER}" muted autoplay loop playsinline preload="auto"></video><span class="wt-play">${PLAY}</span></button>
      <div class="wt-meta"><b>Watch the walkthrough</b><span>0:40</span><button type="button" class="wt-hide" aria-label="Hide the walkthrough">${X}</button></div>`;
    c.querySelector('.wt-thumb').onclick = openWalkthrough;
    c.querySelector('.wt-hide').onclick = () => { c.remove(); try { localStorage.setItem(NS + '.wt-hidden', '1'); } catch { /* ignore */ } };
    document.body.appendChild(c);
  }

  /* ---------- Demo strip at the top of each page (not inside the tour's embedded screens) ---------- */
  document.addEventListener('DOMContentLoaded', () => {
    if (window.top !== window) return;
    if (document.body.dataset.demoBar === 'off') { if (document.body.dataset.walkthrough !== 'off') cornerPlayer(); return; }
    const bar = document.createElement('div');
    bar.className = 'demo-bar';
    bar.innerHTML = '<span>Demo café · everything stays in this browser</span><a href="demo.html">Back to the tour</a><button type="button" data-wt>Watch the walkthrough</button><button type="button" data-r="0">Start over</button><button type="button" data-r="1">Fill with sample orders</button>';
    bar.querySelectorAll('button[data-r]').forEach(b => { b.onclick = () => { reset(b.dataset.r === '1'); location.reload(); }; });
    bar.querySelector('[data-wt]').onclick = openWalkthrough;
    document.body.prepend(bar);
  });
})();
