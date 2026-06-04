import initSqlJs from 'sql.js';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

const DB_PATH = join(tmpdir(), 'paywall.db');

let db;
async function getDb() {
  if (db) return db;
  const SQL = await initSqlJs();
  try { db = new SQL.Database(readFileSync(DB_PATH)); }
  catch(e) { db = new SQL.Database(); }
  db.run('CREATE TABLE IF NOT EXISTS passwords (id INTEGER PRIMARY KEY AUTOINCREMENT, code TEXT NOT NULL UNIQUE, label TEXT DEFAULT "", used INTEGER DEFAULT 0, used_at TEXT, created_at TEXT)');
  saveDb();
  return db;
}
function saveDb() {
  try { writeFileSync(DB_PATH, Buffer.from(db.export())); } catch(e) {}
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();

  const { path } = req.query;
  const action = Array.isArray(path) ? path[0] : path;

  await getDb();

  // POST /api/verify
  if (req.method === 'POST' && action === 'verify') {
    const { code } = req.body || {};
    if (!code) return res.json({ ok: false, msg: '请输入密码' });
    const stmt = db.prepare('SELECT * FROM passwords WHERE code = ?');
    stmt.bind([code]);
    let row = null;
    if (stmt.step()) row = stmt.getAsObject();
    stmt.free();
    if (!row) return res.json({ ok: false, msg: '密码错误' });
    if (row.used) return res.json({ ok: false, msg: '该密码已被使用' });
    db.run('UPDATE passwords SET used = 1, used_at = ? WHERE id = ?', [new Date().toISOString(), row.id]);
    saveDb();
    return res.json({ ok: true });
  }

  // GET /api/stats
  if (req.method === 'GET' && action === 'stats') {
    const total = db.exec('SELECT COUNT(*) as c FROM passwords');
    const used = db.exec('SELECT COUNT(*) as c FROM passwords WHERE used = 1');
    const t = total[0]?.values[0]?.[0] || 0;
    const u = used[0]?.values[0]?.[0] || 0;
    return res.json({ totalPwd: t, usedPwd: u, revenue: u * 0.99 });
  }

  return res.status(404).json({ error: 'Not found' });
}
