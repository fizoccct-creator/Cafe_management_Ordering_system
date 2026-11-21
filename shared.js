/* Shared by the browser app and server.js: demo seed data and applyOp, the ONLY function
   that changes state. Every change is an "op" so all devices apply exactly the same edits. */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.CafeShared = api;
})(typeof self !== 'undefined' ? self : this, function () {
  const uid = () => Math.random().toString(36).slice(2, 10);
  const copy = o => JSON.parse(JSON.stringify(o));

  function seed() {
    const g = (name, multi, opts) => ({ id: uid(), name, multi, options: opts.map(([n, p = 0]) => ({ id: uid(), name: n, price: p })) });
    const size = g('Size', false, [['Regular'], ['Large', 1]]);
    const temp = g('Temperature', false, [['Hot'], ['Iced', 0.5]]);
    const milk = g('Milk', false, [['Full cream'], ['Oat', 0.8], ['Almond', 0.8], ['Skim']]);
    const sweet = g('Sweetness', false, [['Normal'], ['Less sweet'], ['No sugar']]);
    const extra = g('Extras', true, [['Extra shot', 1], ['Vanilla syrup', 0.5], ['Caramel syrup', 0.5]]);
    const serve = g('Serve', false, [['Warmed'], ['As is']]);
    const cats = ['Coffee', 'Non-coffee', 'Food'].map(name => ({ id: uid(), name }));
    const [cof, non, food] = cats;
    const it = (name, cat, price, station, groups) => ({ id: uid(), name, catId: cat.id, price, station, available: true, groups: groups.map(x => x.id) });
    return {
      v: 1,
      settings: { cafeName: 'My Café', currency: '$', tables: 12, warnMins: 8, lateMins: 15, qrEnabled: true, qrApproval: true, theme: 'dekad', numDay: '', nextNum: 1 },
      categories: cats,
      groups: [size, temp, milk, sweet, extra, serve],
      items: [
        it('Espresso', cof, 3, 'bar', [extra]),
        it('Americano', cof, 3.5, 'bar', [size, temp, sweet, extra]),
        it('Latte', cof, 4.5, 'bar', [size, temp, milk, sweet, extra]),
        it('Cappuccino', cof, 4.5, 'bar', [size, milk, sweet, extra]),
        it('Flat White', cof, 4.5, 'bar', [milk, extra]),
        it('Mocha', cof, 5, 'bar', [size, temp, milk, sweet, extra]),
        it('Matcha Latte', non, 5, 'bar', [size, temp, milk, sweet]),
        it('Chocolate', non, 4.5, 'bar', [size, temp, milk, sweet]),
        it('Iced Lemon Tea', non, 3.5, 'bar', [sweet]),
        it('Butter Croissant', food, 3.5, 'kitchen', [serve]),
        it('Banana Bread', food, 3, 'kitchen', [serve]),
        it('Club Sandwich', food, 8.5, 'kitchen', []),
      ],
      orders: [],
    };
  }

  const EDITABLE = ['cafeName', 'currency', 'tables', 'warnMins', 'lateMins', 'qrEnabled', 'qrApproval', 'theme'];
  const THEMES = ['dekad', 'electric']; // look of every screen; see themes/

  // Mutates S. For addOrder it also writes the assigned number back onto op.order.num.
  function applyOp(S, op) {
    const find = id => S.orders.find(o => o.id === id);
    switch (op.t) {
      case 'addOrder': {
        if (find(op.order.id)) return; // already applied (idempotent)
        const s = S.settings, day = new Date(op.at).toDateString();
        if (s.numDay !== day) { s.numDay = day; s.nextNum = 1; } // numbers restart each day
        if (op.order.num == null) op.order.num = s.nextNum;
        s.nextNum = Math.max(s.nextNum, op.order.num + 1);
        const o = copy(op.order);
        o.status = o.status === 'pending' ? 'pending' : 'new'; // QR orders may wait for staff approval
        o.createdAt = op.at; o.times = { [o.status]: op.at };
        S.orders.push(o);
        return;
      }
      case 'status': { const o = find(op.id); if (o) { o.status = op.status; (o.times = o.times || {})[op.status] = op.at; } return; }
      case 'line': { const o = find(op.id); const l = o && o.lines[op.i]; if (l) l.done = !!op.done; return; }
      case 'avail': { const it = S.items.find(i => i.id === op.id); if (it) it.available = !!op.available; return; }
      case 'menu': for (const k of ['categories', 'groups', 'items']) if (Array.isArray(op[k])) S[k] = copy(op[k]); return;
      case 'settings':
        for (const k of EDITABLE) if (op.settings && k in op.settings && (k !== 'theme' || THEMES.includes(op.settings[k]))) S.settings[k] = op.settings[k];
        return;
      case 'replace': { const n = copy(op.state); Object.keys(S).forEach(k => delete S[k]); Object.assign(S, n); return; }
      default: throw new Error('Unknown change type: ' + op.t);
    }
  }

  return { uid, seed, applyOp, THEMES };
});
