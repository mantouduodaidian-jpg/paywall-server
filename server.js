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

// ==================== 会话系统（当日24:00过期）====================
const sessions = new Map();

function getMidnight() {
  const now = new Date();
  const mid = new Date(now);
  mid.setHours(24, 0, 0, 0);
  return mid.getTime();
}

setInterval(() => {
  const now = Date.now();
  for (const [token, sess] of sessions) if (now > sess.expiresAt) sessions.delete(token);
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
  sessions.set(token, { createdAt: Date.now(), expiresAt: getMidnight(), product_id: row.product_id });
  res.json({ ok: true, product_name: row.product_name, product_id: row.product_id, token });
});

// 验证会话 token
app.post('/api/verify-session', (req, res) => {
  const { token } = req.body;
  if (!token) return res.json({ ok: false });
  const sess = sessions.get(token);
  if (!sess || Date.now() > sess.expiresAt) {
    if (sess) sessions.delete(token);
    return res.json({ ok: false });
  }
  res.json({ ok: true, product_id: sess.product_id });
});

// 统计
app.get('/api/stats', (req, res) => {
  const pid = parseInt(req.query.product_id) || 0;
  const t = qOne('SELECT COUNT(*) as c FROM passwords' + (pid ? ' WHERE product_id = ' + pid : '')).c;
  const u = qOne('SELECT COUNT(*) as c FROM passwords WHERE used = 1' + (pid ? ' AND product_id = ' + pid : '')).c;
  res.json({ totalPwd: t, usedPwd: u, revenue: u * 0.99 });
});

// ====== API Proxy ======
const API_KEYS = {
  deepseek: process.env.DEEPSEEK_KEY || '',
  openai: process.env.OPENAI_KEY || '',
  dashscope: process.env.DASHSCOPE_KEY || process.env.QW_KET || '',
  siliconflow: process.env.SILICONFLOW_KEY || '',
  kimi: process.env.KIMI_KEY || process.env.KIMI_KET || '',
  doubao: process.env.DOUBAO_KEY || process.env.DOUBAO_KET || '',
};
const PROXY_BASE = {
  deepseek: 'https://api.deepseek.com',
  openai: 'https://api.openai.com/v1',
  dashscope: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
  siliconflow: 'https://api.siliconflow.cn/v1',
  kimi: 'https://api.moonshot.cn/v1',
  doubao: 'https://ark.cn-beijing.volces.com/api/v3',
};

function getProvider(model) {
  const m = model.toLowerCase();
  if (m.includes('deepseek')) return 'deepseek';
  if (m.includes('gpt') || m.includes('o1') || m.includes('o3')) return 'openai';
  if (m.includes('qwen') || m.includes('qvq') || m.includes('qwq')) return 'dashscope';
  if (m.includes('kimi') || m.includes('moonshot')) return 'kimi';
  if (m.includes('doubao') || m.includes('ark-')) return 'doubao';
  if (m.includes('silicon') || m.includes('glm') || m.includes('yi-')) return 'siliconflow';
  return 'deepseek';
}

function trackAI(model, tokens) {
  try {
    const p = join(DATA_DIR, 'ai-usage.json');
    let d = { today: 0, tokens: 0, month: 0, history: [] };
    try { d = JSON.parse(readFileSync(p, 'utf8')); } catch(e) {}
    const today = new Date().toISOString().slice(0,10);
    if (d.lastDate !== today) { d.today = 0; d.lastDate = today; }
    d.today += 1;
    d.tokens += tokens || 0;
    d.month += tokens || 0;
    // Keep rolling 30 days
    if (!d.history) d.history = [];
    d.history.push({ time: new Date().toISOString(), model, tokens: tokens || 0 });
    if (d.history.length > 10000) d.history = d.history.slice(-5000);
    writeFileSync(p, JSON.stringify(d));
  } catch(e) {}
}

app.post('/v1/chat/completions', express.json(), async (req, res) => {
  const { model = 'deepseek-chat', messages = [], stream = false, max_tokens = 4096, temperature = 0.7 } = req.body;
  if (!messages.length) return res.status(400).json({ error: 'messages required' });

  const provider = getProvider(model);
  const apiKey = API_KEYS[provider];
  if (!apiKey) return res.status(500).json({ error: provider + ' API key not configured' });

  const baseUrl = PROXY_BASE[provider];
  const url = baseUrl + '/chat/completions';

  const body = JSON.stringify({ model, messages, stream, max_tokens, temperature });

  try {
    const providerRes = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + apiKey },
      body,
    });

    if (stream && providerRes.ok) {
      res.setHeader('Content-Type', 'text/event-stream');
      res.setHeader('Cache-Control', 'no-cache');
      res.setHeader('Connection', 'keep-alive');
      let fullText = '';
      const reader = providerRes.body.getReader();
      const decoder = new TextDecoder();

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        const chunk = decoder.decode(value);
        res.write(chunk);
        // Count tokens from data chunks
        try {
          const lines = chunk.split('\n').filter(l => l.startsWith('data: ') && l !== 'data: [DONE]');
          for (const line of lines) {
            const d = JSON.parse(line.slice(6));
            if (d.choices?.[0]?.delta?.content) fullText += d.choices[0].delta.content;
            if (d.usage) trackAI(model, d.usage.total_tokens);
          }
        } catch(e) {}
      }
      if (fullText) trackAI(model, Math.ceil(fullText.length / 2));
      res.write('data: [DONE]\n\n');
      res.end();
    } else {
      const data = await providerRes.json();
      const tokens = data?.usage?.total_tokens || 0;
      trackAI(model, tokens);
      res.status(providerRes.status).json(data);
    }
  } catch (e) {
    res.status(502).json({ error: 'proxy error: ' + e.message });
  }
});

// ====== Dashboard API ======
import os from 'os';
const startTime = Date.now();

app.get('/api/dashboard', (req, res) => {
  const mem = process.memoryUsage();
  const uptime = Math.floor((Date.now() - startTime) / 1000);
  const h = u => u > 86400 ? Math.floor(u/86400)+'d '+Math.floor((u%86400)/3600)+'h' : u > 3600 ? Math.floor(u/3600)+'h '+Math.floor((u%3600)/60)+'m' : Math.floor(u/60)+'m';

  // Read AI usage from JSON file if exists
  let ai = { today: 0, tokens: 0, month: 0 };
  try {
    ai = JSON.parse(readFileSync(join(DATA_DIR, 'ai-usage.json'), 'utf8'));
  } catch(e) {}

  res.json({
    server: {
      status: 'online',
      uptime: h(uptime),
      uptimeRaw: uptime,
      ram: Math.round(mem.rss / 1024 / 1024) + 'MB',
      cpu: os.loadavg()[0].toFixed(1) + '%',
      platform: process.platform,
      node: process.version,
    },
    ai: {
      today: ai.today || 0,
      tokens: ai.tokens || 0,
      month: ai.month || 0,
    },
    review: {
      lastSync: null,
    }
  });
});

// ====== Codex Status API ======
app.get('/api/codex-status', (req, res) => {
  res.json({
    connected: !!(API_KEYS.deepseek || API_KEYS.openai),
    email: 'mantoududuadian@gmail.com',
    plan: 'Free + API',
    expires: '—',
    endpoints: Object.entries(API_KEYS).filter(([k,v]) => v).map(([k]) =>
      k + ': https://paywall-server.onrender.com/v1/chat/completions'
    ),
  });
});

// ====== API Key Config ======
app.get('/api/keys', (req, res) => {
  res.json({
    configured: Object.fromEntries(Object.entries(API_KEYS).map(([k,v]) => [k, !!v])),
    models: {
      deepseek: ['deepseek-chat', 'deepseek-v4-flash', 'deepseek-reasoner'],
      openai: ['gpt-4o-mini', 'gpt-4o'],
      dashscope: ['qwen-plus', 'qwen-turbo', 'qwen-max'],
      kimi: ['kimi-k2', 'moonshot-v1-8k'],
      doubao: ['doubao-pro-32k', 'doubao-lite-32k'],
      siliconflow: ['Pro/deepseek-ai/DeepSeek-V4', 'glm-4-plus'],
    }
  });
});

// ====== API Root Info ======
app.get('/v1', (req, res) => {
  const info = {
    deepseek: !!API_KEYS.deepseek,
    openai: !!API_KEYS.openai,
    dashscope: !!API_KEYS.dashscope,
    kimi: !!API_KEYS.kimi,
    doubao: !!API_KEYS.doubao,
  };
  const models = { deepseek: ['deepseek-chat','deepseek-v4-flash'], openai: ['gpt-4o-mini','gpt-4o'], dashscope: ['qwen-plus','qwen-turbo'], kimi: ['kimi-k2','moonshot-v1'], doubao: ['doubao-pro-32k'] };
  res.type('html').send(`<!DOCTYPE html><html><head><meta charset="utf-8"><title>API Proxy</title><meta name="viewport" content="width=device-width"><style>body{font-family:system-ui;background:#0f0d23;color:#fff;padding:24px;max-width:600px;margin:0 auto;}h1{font-size:22px;color:#a78bfa}code{background:rgba(255,255,255,.04);padding:2px 8px;border-radius:4px;font-size:13px}.ok{color:#34d399}.off{color:rgba(255,255,255,.15)}.card{background:rgba(255,255,255,.03);border-radius:12px;padding:16px;margin:12px 0;border:1px solid rgba(255,255,255,.06)}</style></head><body>
<h1>✦ API Proxy</h1>
<p style="color:rgba(255,255,255,.4);margin-bottom:20px;">POST 请求发送到 <code>/v1/chat/completions</code></p>
<div class="card"><h3 style="margin:0 0 12px 0;font-size:14px;color:rgba(255,255,255,.5);">已配置的供应商</h3>
${Object.entries(info).map(([k,v]) => '<div style="display:flex;justify-content:space-between;padding:4px 0;"><span>'+k+'</span><span class="'+(v?'ok':'off')+'">'+(v?'✅ 已配置':'○ 未配置')+'</span></div>').join('')}</div>
<div class="card"><h3 style="margin:0 0 8px 0;font-size:14px;color:rgba(255,255,255,.5);">可用模型</h3>
${Object.entries(models).map(([p,ms]) => ms.map(m => '<code style="display:inline-block;margin:3px;">'+m+'</code>').join('')).join('<br>')}</div>
<p style="color:rgba(255,255,255,.2);font-size:12px;margin-top:20px;"><a href="/dashboard.html" style="color:rgba(167,139,250,.4);">仪表盘 →</a></p>
</body></html>`);
});

const PORT = process.env.PORT || 3456;
app.listen(PORT, '0.0.0.0', () => {
  console.log(`✅ 付费验证服务已启动: http://0.0.0.0:${PORT}`);
  console.log(`📊 管理后台: http://localhost:${PORT}/admin.html`);
});
