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

  const count = db.exec('SELECT COUNT(*) as c FROM products');
  if (!count.length || !count[0].values.length || !count[0].values[0][0]) {
    db.run('INSERT INTO products (name, price) VALUES (?, ?)', ['光纤通信复习题库', 0.99]);
  }
  saveDbSync();
}

function saveDbSync() {
  try {
    const data = db.export();
    writeFileSync(DB_PATH, Buffer.from(data));
  } catch(e) { console.error('save error', e); }
}

function q(sql, params = []) {
  const stmt = db.prepare(sql);
  if (sql.trim().toUpperCase().startsWith('SELECT') || sql.trim().toUpperCase().startsWith('WITH')) {
    stmt.bind(params);
    const rows = [];
    while (stmt.step()) rows.push(stmt.getAsObject());
    stmt.free();
    return rows;
  } else {
    const result = stmt.run(params);
    stmt.free();
    saveDbSync();
    return result;
  }
}

function qOne(sql, params = []) {
  const rows = q(sql, params);
  return rows.length ? rows[0] : null;
}

await initDb();

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static(join(__dirname, 'public')));

// ==================== API ====================

// 生成密码（管理员用）
app.post('/api/passwords', (req, res) => {
  const { count = 1, label = '' } = req.body;
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const codes = [];

  for (let i = 0; i < count; i++) {
    let code = '';
    for (let j = 0; j < 8; j++) code += chars[Math.floor(Math.random() * chars.length)];
    try {
      q('INSERT INTO passwords (product_id, code, label, created_at) VALUES (?, ?, ?, ?)', [1, code, label, new Date().toISOString()]);
      codes.push(code);
    } catch (e) { i--; }
  }
  res.json({ ok: true, count: codes.length, codes });
});

// 密码列表（管理员用）
app.get('/api/passwords', (req, res) => {
  res.json(q('SELECT * FROM passwords ORDER BY id DESC'));
});

// 验证密码（前端调用）
app.post('/api/verify', (req, res) => {
  const { code } = req.body;
  if (!code) return res.json({ ok: false, msg: '请输入密码' });

  const row = qOne('SELECT * FROM passwords WHERE code = ?', [code]);
  if (!row) return res.json({ ok: false, msg: '密码错误' });
  if (row.used) return res.json({ ok: false, msg: '该密码已被使用' });

  q("UPDATE passwords SET used = 1, used_at = ? WHERE id = ?", [new Date().toISOString(), row.id]);
  res.json({ ok: true, product_name: '光纤通信复习题库' });
});

// 订单列表（管理员用）
app.get('/api/orders', (req, res) => {
  res.json(q(`SELECT o.*, p.code as password_code FROM orders o LEFT JOIN passwords p ON o.password_id = p.id ORDER BY o.id DESC LIMIT 50`));
});

// 统计数据
app.get('/api/stats', (req, res) => {
  const totalPwd = qOne('SELECT COUNT(*) as c FROM passwords').c;
  const usedPwd = qOne('SELECT COUNT(*) as c FROM passwords WHERE used = 1').c;
  const totalOrders = qOne('SELECT COUNT(*) as c FROM orders').c;
  const paidOrders = qOne("SELECT COUNT(*) as c FROM orders WHERE status = 'paid'").c;
  res.json({ totalPwd, usedPwd, totalOrders, paidOrders, revenue: paidOrders * 0.99 });
});

const PORT = process.env.PORT || 3456;
console.log('Using port:', PORT);
app.listen(PORT, '0.0.0.0', () => {
  console.log(`✅ 付费验证服务已启动: http://0.0.0.0:${PORT}`);
  console.log(`📊 管理后台: http://localhost:${PORT}/admin.html`);
});
