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

  /* A café mid-morning: some orders served, some in the kitchen, one QR order waiting for approval. */
  function fresh() {
    const s = seed();
    s.settings.cafeName = 'Dekad Demo Café';
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
  function state() { let s = read(); if (!s) { s = fresh(); write(s); } return s; }
  function reset() {
    try { Object.keys(localStorage).filter(k => k.startsWith(NS + '.')).forEach(k => localStorage.removeItem(k)); } catch { /* ignore */ }
    write(fresh());
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
      cafeName: st.cafeName, currency: st.currency, tables: st.tables, qrEnabled: st.qrEnabled !== false, tableOk: true,
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

  /* ---------- Demo strip at the top of each page (not inside the tour's embedded screens) ---------- */
  document.addEventListener('DOMContentLoaded', () => {
    if (window.top !== window || document.body.dataset.demoBar === 'off') return;
    const bar = document.createElement('div');
    bar.className = 'demo-bar';
    bar.innerHTML = '<span>Demo café · everything stays in this browser</span><a href="demo.html">Back to the tour</a><button type="button">Reset demo</button>';
    bar.querySelector('button').onclick = () => { reset(); location.reload(); };
    document.body.prepend(bar);
  });
})();
