import initSqlJs from 'sql.js';
import { readFileSync, writeFileSync, existsSync, mkdirSync, randomBytes } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

const DB_PATH = join(tmpdir(), 'paywall.db');
const CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const sessions = new Map();
const SESSION_TTL = 24 * 60 * 60 * 1000;

let db;
async function getDb() {
  if (db) return db;
  const SQL = await initSqlJs();
  try { db = new SQL.Database(readFileSync(DB_PATH)); }
  catch(e) { db = new SQL.Database(); }
  db.run('CREATE TABLE IF NOT EXISTS products (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT, price REAL, desc_text TEXT)');
  db.run('CREATE TABLE IF NOT EXISTS passwords (id INTEGER PRIMARY KEY AUTOINCREMENT, product_id INTEGER DEFAULT 1, code TEXT UNIQUE, label TEXT DEFAULT "", used INTEGER DEFAULT 0, used_at TEXT, created_at TEXT)');
  db.run("INSERT OR IGNORE INTO products (id, name, price) VALUES (1, '光纤通信复习题库', 0.99)");
  db.run("INSERT OR IGNORE INTO products (id, name, price) VALUES (2, '数字信号处理复习题库', 0.99)");
  saveDb();
  return db;
}
function saveDb() { try { writeFileSync(DB_PATH, Buffer.from(db.export())); } catch(e) {} }
function q(sql, params = []) {
  const stmt = db.prepare(sql);
  if (/^SELECT/i.test(sql.trim())) {
    stmt.bind(params); const rows = []; while (stmt.step()) rows.push(stmt.getAsObject()); stmt.free(); return rows;
  } else { const r = stmt.run(params); stmt.free(); saveDb(); return r; }
}
function qOne(sql, params = []) { const rows = q(sql, params); return rows.length ? rows[0] : null; }

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const { path } = req.query;
  const action = Array.isArray(path) ? path[0] : path;
  await getDb();

  // 产品列表
  if (req.method === 'GET' && (!action || action === 'products')) {
    const rows = q('SELECT * FROM products');
    return res.json(rows.length ? rows : [{id:1,name:'光纤通信复习题库',price:0.99},{id:2,name:'数字信号处理复习题库',price:0.99}]);
  }

  // 生成密码
  if (req.method === 'POST' && action === 'passwords') {
    const { count = 1, label = '', product_id = 1 } = req.body || {};
    const codes = [];
    for (let i = 0; i < count; i++) {
      let code = '';
      for (let j = 0; j < 8; j++) code += CHARS[Math.floor(Math.random() * CHARS.length)];
      try { q('INSERT INTO passwords (product_id, code, label, created_at) VALUES (?, ?, ?, ?)', [product_id, code, label, new Date().toISOString()]); codes.push(code); } catch(e) { i--; }
    }
    return res.json({ ok: true, count: codes.length, codes });
  }

  // 密码列表
  if (req.method === 'GET' && action === 'passwords') {
    const pid = parseInt(req.query.product_id || 0);
    const sql = pid ? 'SELECT p.*, pr.name as product_name FROM passwords p LEFT JOIN products pr ON p.product_id = pr.id WHERE p.product_id = ? ORDER BY p.id DESC' : 'SELECT p.*, pr.name as product_name FROM passwords p LEFT JOIN products pr ON p.product_id = pr.id ORDER BY p.id DESC';
    return res.json(q(sql, pid ? [pid] : []));
  }

  // 删除密码
  if (req.method === 'DELETE' && action === 'passwords' && req.query.all === 'used') {
    const pid = parseInt(req.query.product_id || 0);
    q(pid ? 'DELETE FROM passwords WHERE used = 1 AND product_id = ?' : 'DELETE FROM passwords WHERE used = 1', pid ? [pid] : []);
    return res.json({ ok: true });
  }
  if (req.method === 'DELETE' && /^passwords\/(\d+)$/.test(action || '')) {
    const id = parseInt(action.split('/')[1]);
    q('DELETE FROM passwords WHERE id = ? AND used = 0', [id]);
    return res.json({ ok: true });
  }

  // 验证密码
  if (req.method === 'POST' && action === 'verify') {
    const { code } = req.body || {};
    if (!code) return res.json({ ok: false, msg: '请输入密码' });
    const row = qOne('SELECT p.*, pr.name as product_name FROM passwords p LEFT JOIN products pr ON p.product_id = pr.id WHERE p.code = ?', [code]);
    if (!row) return res.json({ ok: false, msg: '密码错误' });
    if (row.used) return res.json({ ok: false, msg: '该密码已被使用' });
    q('UPDATE passwords SET used = 1, used_at = ? WHERE id = ?', [new Date().toISOString(), row.id]);
    const token = randomBytes(24).toString('hex');
    sessions.set(token, { createdAt: Date.now(), product_id: row.product_id });
    return res.json({ ok: true, product_name: row.product_name, product_id: row.product_id, token });
  }

  // 验证会话
  if (req.method === 'POST' && action === 'verify-session') {
    const { token } = req.body || {};
    if (!token) return res.json({ ok: false });
    const sess = sessions.get(token);
    if (!sess || Date.now() - sess.createdAt > SESSION_TTL) { sessions.delete(token); return res.json({ ok: false }); }
    return res.json({ ok: true, product_id: sess.product_id });
  }

  // 统计
  if (req.method === 'GET' && action === 'stats') {
    const totalPwd = qOne('SELECT COUNT(*) as c FROM passwords').c;
    const usedPwd = qOne('SELECT COUNT(*) as c FROM passwords WHERE used = 1').c;
    return res.json({ totalPwd, usedPwd, revenue: usedPwd * 0.99 });
  }

  return res.status(404).json({ error: 'Not found' });
}
