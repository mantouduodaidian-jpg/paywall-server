import express from 'express';
import initSqlJs from 'sql.js';
import cors from 'cors';
import { randomBytes } from 'crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = join(__dirname, 'data');
if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR);
const DB_PATH = join(DATA_DIR, 'paywall.db');

let db;
async function initDb() {
  const SQL = await initSqlJs();
  try {
    const buf = readFileSync(DB_PATH);
    db = new SQL.Database(buf);
  } catch(e) {
    db = new SQL.Database();
  }
  db.run('CREATE TABLE IF NOT EXISTS products (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, price REAL NOT NULL DEFAULT 0.99, desc_text TEXT DEFAULT \'\')');
  db.run('CREATE TABLE IF NOT EXISTS passwords (id INTEGER PRIMARY KEY AUTOINCREMENT, product_id INTEGER NOT NULL DEFAULT 1, code TEXT NOT NULL UNIQUE, label TEXT DEFAULT \'\', used INTEGER DEFAULT 0, used_at TEXT, created_at TEXT)');
  db.run('CREATE TABLE IF NOT EXISTS orders (id INTEGER PRIMARY KEY AUTOINCREMENT, product_id INTEGER NOT NULL DEFAULT 1, order_no TEXT UNIQUE NOT NULL, password_id INTEGER, amount REAL NOT NULL DEFAULT 0.99, status TEXT DEFAULT \'pending\', paid_at TEXT, created_at TEXT)');

  // 初始化产品
  const products = q('SELECT * FROM products');
  if (!products.length) {
    db.run('INSERT INTO products (name, price, desc_text) VALUES (?, ?, ?)', ['光纤通信复习题库', 0.99, '光纤通信交互式复习']);
    db.run('INSERT INTO products (name, price, desc_text) VALUES (?, ?, ?)', ['数字信号处理复习题库', 0.99, '数字信号处理交互式复习']);
    saveDbSync();
  }
}
initDb();

function saveDbSync() {
  try { writeFileSync(DB_PATH, Buffer.from(db.export())); } catch(e) { console.error('save error', e); }
}

function q(sql, params = []) {
  const stmt = db.prepare(sql);
  if (sql.trim().toUpperCase().startsWith('SELECT') || sql.trim().toUpperCase().startsWith('WITH')) {
    stmt.bind(params);
    const rows = []; while (stmt.step()) rows.push(stmt.getAsObject()); stmt.free(); return rows;
  } else {
    const result = stmt.run(params); stmt.free(); saveDbSync(); return result;
  }
}
function qOne(sql, params = []) { const rows = q(sql, params); return rows.length ? rows[0] : null; }

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static(join(__dirname, 'public')));

// ==================== 产品 API ====================
app.get('/api/products', (req, res) => {
  res.json(q('SELECT * FROM products'));
});

// ==================== 密码 API（支持按产品筛选）====================

// 生成密码
app.post('/api/passwords', (req, res) => {
  const { count = 1, label = '', product_id = 1 } = req.body;
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const codes = [];
  for (let i = 0; i < count; i++) {
    let code = '';
    for (let j = 0; j < 8; j++) code += chars[Math.floor(Math.random() * chars.length)];
    try {
      q('INSERT INTO passwords (product_id, code, label, created_at) VALUES (?, ?, ?, ?)', [product_id, code, label, new Date().toISOString()]);
      codes.push(code);
    } catch (e) { i--; }
  }
  res.json({ ok: true, count: codes.length, codes });
});

// 密码列表（按产品筛选）
app.get('/api/passwords', (req, res) => {
  const pid = parseInt(req.query.product_id) || 0;
  const sql = pid ? 'SELECT p.*, pr.name as product_name FROM passwords p LEFT JOIN products pr ON p.product_id = pr.id WHERE p.product_id = ? ORDER BY p.id DESC' : 'SELECT p.*, pr.name as product_name FROM passwords p LEFT JOIN products pr ON p.product_id = pr.id ORDER BY p.id DESC';
  const params = pid ? [pid] : [];
  res.json(q(sql, params));
});

// 删除单条密码
app.delete('/api/passwords/:id', (req, res) => {
  const id = parseInt(req.params.id);
  if (!id) return res.json({ ok: false, msg: '参数错误' });
  q('DELETE FROM passwords WHERE id = ? AND used = 0', [id]);
  res.json({ ok: true });
});

// 批量删除已用密码
app.delete('/api/passwords/used/all', (req, res) => {
  const pid = parseInt(req.query.product_id) || 0;
  if (pid) q("DELETE FROM passwords WHERE used = 1 AND product_id = ?", [pid]);
  else q("DELETE FROM passwords WHERE used = 1");
  res.json({ ok: true });
});

// ==================== 会话系统 ====================
const sessions = new Map();
const SESSION_TTL = 24 * 60 * 60 * 1000;
setInterval(() => {
  const now = Date.now();
  for (const [token, sess] of sessions) if (now - sess.createdAt > SESSION_TTL) sessions.delete(token);
}, 3600000);

// 验证密码
app.post('/api/verify', (req, res) => {
  const { code } = req.body;
  if (!code) return res.json({ ok: false, msg: '请输入密码' });

  const row = qOne('SELECT p.*, pr.name as product_name FROM passwords p LEFT JOIN products pr ON p.product_id = pr.id WHERE p.code = ?', [code]);
  if (!row) return res.json({ ok: false, msg: '密码错误' });
  if (row.used) return res.json({ ok: false, msg: '该密码已被使用' });

  q("UPDATE passwords SET used = 1, used_at = ? WHERE id = ?", [new Date().toISOString(), row.id]);

  const token = randomBytes(24).toString('hex');
  sessions.set(token, { createdAt: Date.now(), product_id: row.product_id });
  res.json({ ok: true, product_name: row.product_name, product_id: row.product_id, token });
});

// 验证会话 token
app.post('/api/verify-session', (req, res) => {
  const { token } = req.body;
  if (!token) return res.json({ ok: false });
  const sess = sessions.get(token);
  if (!sess || Date.now() - sess.createdAt > SESSION_TTL) {
    if (sess) sessions.delete(token);
    return res.json({ ok: false });
  }
  res.json({ ok: true, product_id: sess.product_id });
});

// 统计
app.get('/api/stats', (req, res) => {
  const pid = parseInt(req.query.product_id) || 0;
  const w = pid ? ' WHERE product_id = ' + pid : '';
  const totalPwd = qOne('SELECT COUNT(*) as c FROM passwords' + w).c;
  const usedPwd = qOne('SELECT COUNT(*) as c FROM passwords' + w + (w ? '' : '') + (pid ? '' : ''))?.c || 0;
  // Need to handle the WHERE clause properly
  const totalPwd2 = qOne('SELECT COUNT(*) as c FROM passwords' + (pid ? ' WHERE product_id = ' + pid : '')).c;
  const usedPwd2 = qOne('SELECT COUNT(*) as c FROM passwords WHERE used = 1' + (pid ? ' AND product_id = ' + pid : '')).c;
  res.json({ totalPwd: totalPwd2, usedPwd: usedPwd2, revenue: usedPwd2 * 0.99 });
});

const PORT = process.env.PORT || 3456;
app.listen(PORT, '0.0.0.0', () => {
  console.log(`✅ 付费验证服务已启动: http://0.0.0.0:${PORT}`);
  console.log(`📊 管理后台: http://localhost:${PORT}/admin.html`);
});
