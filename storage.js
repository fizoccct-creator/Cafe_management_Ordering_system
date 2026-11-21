'use strict';
/* Where the café server keeps its data.
   - DATABASE_URL set (cloud, e.g. Neon Postgres): menu/settings in one row, one row per order,
     so each change writes only what changed.
   - Otherwise (café computer): JSON files in DATA_DIR (default ./data). */
const fs = require('fs');
const path = require('path');

function fileStore(dir) {
  const DATA = path.join(dir, 'cafeflow.json');
  const CONFIG = path.join(dir, 'config.json');
  const read = f => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return null; } };
  const write = (f, obj) => {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(f + '.tmp', JSON.stringify(obj));
    fs.renameSync(f + '.tmp', f); // atomic swap: a crash never leaves a half-written file
  };
  return {
    describe: `files in ${dir}`,
    async load() { return { db: read(DATA), config: read(CONFIG) }; },
    async save(db) { write(DATA, db); }, // a café's data is small: rewrite the whole file
    async saveConfig(config) { write(CONFIG, config); },
    async close() {},
  };
}

function pgStore(url) {
  const { Pool } = require('pg');
  const pool = new Pool({ connectionString: url, max: 3, idleTimeoutMillis: 30000, connectionTimeoutMillis: 15000 });
  pool.on('error', e => console.error('  Database connection dropped:', e.message)); // pool reconnects on next query
  const UPSERT_KV = `INSERT INTO cafeflow_kv (key, value, updated_at) VALUES ($1, $2, now())
                     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`;
  const UPSERT_ORDER = `INSERT INTO cafeflow_orders (id, created_at, data) VALUES ($1, $2, $3)
                        ON CONFLICT (id) DO UPDATE SET data = EXCLUDED.data`;
  const json = v => JSON.stringify(v); // pass jsonb as text so arrays aren't turned into Postgres arrays

  async function tx(fn) {
    const c = await pool.connect();
    try { await c.query('BEGIN'); await fn(c); await c.query('COMMIT'); }
    catch (e) { await c.query('ROLLBACK').catch(() => {}); throw e; }
    finally { c.release(); }
  }

  return {
    describe: 'Postgres (DATABASE_URL)',
    async load() {
      await pool.query(`CREATE TABLE IF NOT EXISTS cafeflow_kv (key text PRIMARY KEY, value jsonb NOT NULL, updated_at timestamptz NOT NULL DEFAULT now())`);
      await pool.query(`CREATE TABLE IF NOT EXISTS cafeflow_orders (id text PRIMARY KEY, created_at bigint NOT NULL, data jsonb NOT NULL)`);
      await pool.query(`CREATE INDEX IF NOT EXISTS cafeflow_orders_created ON cafeflow_orders (created_at)`);
      const kv = Object.fromEntries((await pool.query('SELECT key, value FROM cafeflow_kv')).rows.map(r => [r.key, r.value]));
      if (!kv.meta) return { db: null, config: kv.config || null };
      const orders = (await pool.query('SELECT data FROM cafeflow_orders ORDER BY created_at')).rows.map(r => r.data);
      const { ver, recentOps, state } = kv.meta;
      return { db: { ver, recentOps, state: { ...state, orders } }, config: kv.config || null };
    },
    // dirty = { all, orders: Set<orderId>, pruneBefore }
    async save(db, dirty) {
      const { orders, ...rest } = db.state;
      await tx(async c => {
        await c.query(UPSERT_KV, ['meta', json({ ver: db.ver, recentOps: db.recentOps, state: rest })]);
        if (dirty.all) await c.query('DELETE FROM cafeflow_orders');
        else if (dirty.pruneBefore) await c.query('DELETE FROM cafeflow_orders WHERE created_at < $1', [dirty.pruneBefore]);
        const list = dirty.all ? orders : orders.filter(o => dirty.orders.has(o.id));
        for (const o of list) await c.query(UPSERT_ORDER, [o.id, o.createdAt, json(o)]);
      });
    },
    async saveConfig(config) { await pool.query(UPSERT_KV, ['config', json(config)]); },
    async close() { await pool.end().catch(() => {}); },
  };
}

module.exports = {
  createStore() {
    return process.env.DATABASE_URL
      ? pgStore(process.env.DATABASE_URL)
      : fileStore(process.env.DATA_DIR || path.join(__dirname, 'data'));
  },
};
