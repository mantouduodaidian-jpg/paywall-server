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
app.use(express.json({ limit: '20mb' }));
app.use((req, res, next) => {
  res.setHeader('Content-Security-Policy', "default-src 'self' 'unsafe-inline' 'unsafe-eval' data: https:; img-src 'self' data: https:; connect-src 'self' https: ws:; script-src 'self' 'unsafe-inline' 'unsafe-eval'; style-src 'self' 'unsafe-inline';");
  next();
});
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

// ====== Chat Sync ======
const CONVS_FILE = join(DATA_DIR, 'chat-convs.json');

app.get('/api/chat/sync', (req, res) => {
  try {
    const data = JSON.parse(readFileSync(CONVS_FILE, 'utf8'));
    res.json({ ok: true, convs: data.convs || [] });
  } catch(e) {
    res.json({ ok: true, convs: [] });
  }
});

app.post('/api/chat/sync', (req, res) => {
  try {
    const { convs } = req.body;
    if (!convs) return res.json({ ok: false, msg: 'no data' });
    writeFileSync(CONVS_FILE, JSON.stringify({ convs: convs.slice(-30), updated: Date.now() }));
    res.json({ ok: true });
  } catch(e) {
    res.json({ ok: false, msg: e.message });
  }
});

// ====== API Proxy ======
const API_KEYS = {
  deepseek: process.env.DEEPSEEK_KEY || '',
  openai: process.env.OPENAI_KEY || '',
  dashscope: process.env.DASHSCOPE_KEY || process.env.QW_KET || '',
  siliconflow: process.env.SILICONFLOW_KEY || '',
  kimi: process.env.KIMI_KEY || process.env.KIMI_KET || '',
  doubao: process.env.DOUBAO_KEY || process.env.DOUBAO_KET || '',
  groq: process.env.GROQ_KEY || '',
  github: process.env.GITHUB_KEY || '',
  agnes: process.env.AGNES_API_KEY || 'sk-JL8A3iizDl9ohLtgxdywS3VeZFyeUPFJtgCbAlBSf1rc7s38',
};
const PROXY_BASE = {
  deepseek: 'https://api.deepseek.com',
  openai: 'https://api.openai.com/v1',
  dashscope: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
  siliconflow: 'https://api.siliconflow.cn/v1',
  kimi: 'https://api.moonshot.cn/v1',
  doubao: 'https://ark.cn-beijing.volces.com/api/v3',
  groq: 'https://api.groq.com/openai/v1',
  github: 'https://models.inference.ai.azure.com',
  agnes: 'https://apihub.agnes-ai.com/v1',
};

function getProvider(model) {
  const m = model.toLowerCase();
  if (m.startsWith('gh-')) return 'github';
  if (m.includes('deepseek')) return 'deepseek';
  if (m.includes('gpt') || m.includes('o1') || m.includes('o3')) return 'openai';
  if (m.includes('qwen') || m.includes('qvq') || m.includes('qwq')) return 'dashscope';
  if (m.includes('kimi') || m.includes('moonshot')) return 'kimi';
  if (m.includes('doubao') || m.includes('ark-')) return 'doubao';
  if (m.includes('silicon') || m.includes('glm') || m.includes('yi-')) return 'siliconflow';
  if (m.includes('groq') || m.includes('llama') || m.includes('mixtral') || m.includes('gemma')) return 'groq';
  if (m.includes('agnes')) return 'agnes';
  return 'deepseek';
}

function mapModel(provider, model) {
  if (provider === 'github') return model.replace(/^gh-/, '');
  return model;
}

const SUPABASE_URL = 'https://hcinnimptpsjocbkkbna.supabase.co';
const SUPABASE_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImhjaW5uaW1wdHBzam9jYmtrYm5hIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODIwOTIxMjgsImV4cCI6MjA5NzY2ODEyOH0.AeEZcgDaVFqn4LmqK5dMqj7qOzYl0WUly398jG_dcpM';
const SB = (path) => SUPABASE_URL + '/rest/v1/' + path;
const SB_HEADERS = { 'apikey': SUPABASE_KEY, 'Authorization': 'Bearer ' + SUPABASE_KEY, 'Content-Type': 'application/json', 'Prefer': 'return=minimal' };
const SB_HEADERS2 = { 'apikey': SUPABASE_KEY, 'Authorization': 'Bearer ' + SUPABASE_KEY, 'Content-Type': 'application/json' };

async function trackAI(model, tokens) {
  try {
    const today = new Date().toISOString().slice(0,10);
    const check = await fetch(SB('ai_usage?date=eq.'+today+'&select=id,tokens,requests'), { headers: SB_HEADERS });
    const rows = await check.json();
    if (rows && rows.length > 0) {
      const r = rows[0];
      await fetch(SB('ai_usage?id=eq.'+r.id), {
        method: 'PATCH',
        headers: SB_HEADERS,
        body: JSON.stringify({ tokens: (r.tokens||0) + (tokens||0), requests: (r.requests||0) + 1 })
      });
    } else {
      await fetch(SB('ai_usage'), {
        method: 'POST',
        headers: SB_HEADERS,
        body: JSON.stringify({ date: today, model: model || 'unknown', tokens: tokens || 0, requests: 1 })
      });
    }
  } catch(e) { console.error('trackAI error:', e.message); }
}

app.post('/v1/chat/completions', express.json({ limit: '20mb' }), async (req, res) => {
  const { model = 'deepseek-chat', messages = [], stream = false, max_tokens = 4096, temperature = 0.7 } = req.body;
  if (!messages.length) return res.status(400).json({ error: 'messages required' });

  const provider = getProvider(model);
  const apiKey = API_KEYS[provider];
  if (!apiKey) return res.status(500).json({ error: provider + ' API key not configured' });

  const baseUrl = PROXY_BASE[provider];
  const url = baseUrl + '/chat/completions';

  const upstreamModel = mapModel(provider, model);
  const body = JSON.stringify({ model: upstreamModel, messages, stream, max_tokens, temperature });

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
            if (d.usage) await trackAI(model, d.usage.total_tokens);
          }
        } catch(e) {}
      }
      if (fullText) await trackAI(model, Math.ceil(fullText.length / 2));
      res.write('data: [DONE]\n\n');
      res.end();
    } else {
      const text = await providerRes.text();
      let data;
      try { data = JSON.parse(text); } catch(e) {
        return res.status(502).json({ error: '上游返回异常', detail: text.slice(0,300) });
      }
      const tokens = data?.usage?.total_tokens || 0;
      await trackAI(model, tokens);
      res.status(providerRes.status).json(data);
    }
  } catch (e) {
    res.status(502).json({ error: 'proxy error: ' + e.message });
  }
});

// ====== Dashboard API ======
import os from 'os';
const startTime = Date.now();

app.get('/api/dashboard', async (req, res) => {
  const mem = process.memoryUsage();
  const uptime = Math.floor((Date.now() - startTime) / 1000);
  const h = u => u > 86400 ? Math.floor(u/86400)+'d '+Math.floor((u%86400)/3600)+'h' : u > 3600 ? Math.floor(u/3600)+'h '+Math.floor((u%3600)/60)+'m' : Math.floor(u/60)+'m';

  // Read AI usage from Supabase
  let ai = { today: 0, tokens: 0, month: 0 };
  try {
    const today = new Date().toISOString().slice(0,10);
    const monthStart = new Date().toISOString().slice(0,7)+'-01';
    const [tdRes, moRes] = await Promise.all([
      fetch(SB('ai_usage?date=eq.'+today+'&select=tokens,requests'), { headers: SB_HEADERS }),
      fetch(SB('ai_usage?date=gte.'+monthStart+'&select=tokens'), { headers: SB_HEADERS })
    ]);
    const td = await tdRes.json();
    const mo = await moRes.json();
    ai = {
      today: td?.reduce((s,r) => s + (r.requests||0), 0) || 0,
      tokens: td?.reduce((s,r) => s + (r.tokens||0), 0) || 0,
      month: mo?.reduce((s,r) => s + (r.tokens||0), 0) || 0,
    };
  } catch(e) { console.error('dashboard ai error:', e.message); }

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
      groq: ['llama3-70b-8192', 'llama3-8b-8192', 'mixtral-8x7b-32768'],
      github: ['gpt-4o-mini', 'gpt-4o', 'AI21-Jamba-1.5-Mini', 'cohere-command-r'],
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
    groq: !!API_KEYS.groq,
    github: !!API_KEYS.github,
  };
  const models = { deepseek: ['deepseek-chat','deepseek-v4-flash'], openai: ['gpt-4o-mini','gpt-4o'], dashscope: ['qwen-plus','qwen-turbo'], kimi: ['kimi-k2','moonshot-v1'], doubao: ['doubao-pro-32k'], groq: ['llama3-70b','llama3-8b','mixtral-8x7b'], github: ['gh-gpt-4o-mini','gh-gpt-4o','gh-jamba','gh-command-r'] };
  res.type('html').send(`<!DOCTYPE html><html><head><meta charset="utf-8"><title>API Proxy</title><link rel="icon" type="image/svg+xml" href="/favicon.svg"><meta name="viewport" content="width=device-width"><style>body{font-family:system-ui;background:#0f0d23;color:#fff;padding:24px;max-width:600px;margin:0 auto;}h1{font-size:22px;color:#a78bfa}code{background:rgba(255,255,255,.04);padding:2px 8px;border-radius:4px;font-size:13px}.ok{color:#34d399}.off{color:rgba(255,255,255,.15)}.card{background:rgba(255,255,255,.03);border-radius:12px;padding:16px;margin:12px 0;border:1px solid rgba(255,255,255,.06)}</style></head><body>
<h1>✦ API Proxy</h1>
<p style="color:rgba(255,255,255,.4);margin-bottom:20px;">POST 请求发送到 <code>/v1/chat/completions</code></p>
<div class="card"><h3 style="margin:0 0 12px 0;font-size:14px;color:rgba(255,255,255,.5);">已配置的供应商</h3>
${Object.entries(info).map(([k,v]) => '<div style="display:flex;justify-content:space-between;padding:4px 0;"><span>'+k+'</span><span class="'+(v?'ok':'off')+'">'+(v?'✅ 已配置':'○ 未配置')+'</span></div>').join('')}</div>
<div class="card"><h3 style="margin:0 0 8px 0;font-size:14px;color:rgba(255,255,255,.5);">可用模型</h3>
${Object.entries(models).map(([p,ms]) => ms.map(m => '<code style="display:inline-block;margin:3px;">'+m+'</code>').join('')).join('<br>')}</div>
<p style="color:rgba(255,255,255,.2);font-size:12px;margin-top:20px;"><a href="/dashboard.html" style="color:rgba(167,139,250,.4);">仪表盘 →</a></p>
</body></html>`);
});

// ====== Verification API ======
app.post('/api/verify/apply', express.json({ limit:'10mb' }), async (req, res) => {
  try {
    const { name, student_id, phone, image } = req.body;
    if (!name || !student_id) return res.status(400).json({ error: 'name and student_id required' });
    const r = await fetch(SB('verifications'), {
      method: 'POST', headers: SB_HEADERS2,
      body: JSON.stringify({ name, student_id, phone: phone||'', image: image||'', status: 'pending', created_at: new Date().toISOString() })
    });
    const t = await r.text();
    res.json(t ? JSON.parse(t) : { ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/verify/list', async (req, res) => {
  try {
    const r = await fetch(SB('verifications?order=created_at.desc&select=*'), { headers: SB_HEADERS2 });
    res.json(await r.json());
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/verify/approve', express.json(), async (req, res) => {
  try {
    const { id, productIds } = req.body;
    if (!id) return res.status(400).json({ error: 'id required' });
    await fetch(SB('verifications?id=eq.'+id), { method: 'PATCH', headers: SB_HEADERS2, body: JSON.stringify({ status: 'approved' }) });
    if (productIds && productIds.length) {
      for (const pid of productIds) {
        await fetch(SB('products?id=eq.'+pid), { method: 'PATCH', headers: SB_HEADERS2, body: JSON.stringify({ verified: true }) });
      }
    }
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ====== Marketplace Admin API ======
app.get('/api/marketplace/admin/stats', async (req, res) => {
  try {
    const [prodR, verR] = await Promise.all([
      fetch(SB('products?select=id,verified'), { headers: SB_HEADERS }),
      fetch(SB('verifications?select=id,status'), { headers: SB_HEADERS })
    ]);
    const products = await prodR.json();
    const verifications = await verR.json();
    const arr = p => Array.isArray(p) ? p : [];
    res.json({
      total: arr(products).length,
      verified: arr(products).filter(p => p.verified).length,
      pending: arr(products).filter(p => !p.verified).length,
      verTotal: arr(verifications).length,
      verPending: arr(verifications).filter(v => v.status === 'pending').length,
      verApproved: arr(verifications).filter(v => v.status === 'approved').length,
    });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.patch('/api/marketplace/products/:id', express.json(), async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    if (!id) return res.status(400).json({ error: 'id required' });
    const { verified, title, price, category, desc, quality, contact } = req.body;
    const fields = {};
    if (verified !== undefined) fields.verified = verified;
    if (title !== undefined) fields.title = title;
    if (price !== undefined) fields.price = parseFloat(price);
    if (category !== undefined) fields.category = category;
    if (desc !== undefined) fields.desc = desc;
    if (quality !== undefined) fields.quality = quality;
    if (contact !== undefined) fields.contact = contact;
    if (!Object.keys(fields).length) return res.status(400).json({ error: 'no fields to update' });
    await fetch(SB('products?id=eq.'+id), {
      method: 'PATCH', headers: SB_HEADERS2,
      body: JSON.stringify(fields)
    });
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.delete('/api/marketplace/products/:id', async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    if (!id) return res.status(400).json({ error: 'id required' });
    await fetch(SB('products?id=eq.'+id), { method: 'DELETE', headers: SB_HEADERS });
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/verify/reject', express.json(), async (req, res) => {
  try {
    const { id } = req.body;
    if (!id) return res.status(400).json({ error: 'id required' });
    await fetch(SB('verifications?id=eq.'+id), { method: 'PATCH', headers: SB_HEADERS2, body: JSON.stringify({ status: 'rejected' }) });
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.delete('/api/verify/:id', async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    if (!id) return res.status(400).json({ error: 'id required' });
    await fetch(SB('verifications?id=eq.'+id), { method: 'DELETE', headers: SB_HEADERS });
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ====== Marketplace API ======
app.post('/api/marketplace/products', express.json(), async (req, res) => {
  try {
    const { title, price, category, desc, images, contact, quality } = req.body;
    if (!title || !price) return res.status(400).json({ error: 'title and price required' });
    const r = await fetch(SB('products'), {
      method: 'POST',
      headers: { 'apikey': SUPABASE_KEY, 'Authorization': 'Bearer ' + SUPABASE_KEY, 'Content-Type': 'application/json', 'Prefer': 'return=representation' },
      body: JSON.stringify({ title, price: parseFloat(price), category: category||'其他', desc: desc||'', images: images||[], contact: contact||'', quality: quality||'八成新', verified: false })
    });
    const t = await r.text();
    res.json(t ? JSON.parse(t) : { ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/marketplace/products', async (req, res) => {
  try {
    const { category, search } = req.query;
    let url = SB('products?order=created_at.desc&select=*');
    if (category) url = SB('products?category=eq.'+category+'&order=created_at.desc&select=*');
    const r = await fetch(url, { headers: SB_HEADERS });
    let data = await r.json();
    if (search) data = data.filter(p => p.title?.toLowerCase().includes(search.toLowerCase()));
    res.json(data);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/marketplace/products/:id', async (req, res) => {
  try {
    const r = await fetch(SB('products?id=eq.'+req.params.id+'&select=*'), { headers: SB_HEADERS });
    const data = await r.json();
    res.json(data[0] || null);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ====== Expenses API ======
app.get('/api/expenses', async (req, res) => {
  try {
    const month = req.query.month || new Date().toISOString().slice(0,7);
    const start = month + '-01';
    const end = new Date(new Date(start).getTime() + 32*86400000).toISOString().slice(0,7) + '-01';
    const r = await fetch(SB('expenses?date=gte.'+start+'&date=lt.'+end+'&order=date.desc'), { headers: SB_HEADERS });
    const data = await r.json();
    const budget = req.query.budget ? parseFloat(req.query.budget) : 0;
    const total = data.reduce((s,e) => s + (e.type==='expense' ? parseFloat(e.amount) : 0), 0);
    res.json({ entries: data, total, budget });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/expenses', express.json(), async (req, res) => {
  try {
    const { date, amount, category, note, type } = req.body;
    if (!amount) return res.status(400).json({ error: 'amount required' });
    const r = await fetch(SB('expenses'), {
      method: 'POST',
      headers: { 'apikey': SUPABASE_KEY, 'Authorization': 'Bearer ' + SUPABASE_KEY, 'Content-Type': 'application/json', 'Prefer': 'return=representation' },
      body: JSON.stringify({ date: date||new Date().toISOString().slice(0,10), amount: parseFloat(amount), category: category||'其他', note: note||'', type: type||'expense' })
    });
    const text = await r.text();
    res.json(text ? JSON.parse(text) : { ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.delete('/api/expenses/:id', async (req, res) => {
  try {
    await fetch(SB('expenses?id=eq.'+req.params.id), { method: 'DELETE', headers: SB_HEADERS });
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

const PORT = process.env.PORT || 3456;
app.listen(PORT, '0.0.0.0', () => {
  console.log(`✅ 付费验证服务已启动: http://0.0.0.0:${PORT}`);
  console.log(`📊 管理后台: http://localhost:${PORT}/admin.html`);
});
