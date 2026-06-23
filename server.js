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

// ====== News API ======
const NEWS_CACHE = { data: null, time: 0 };
app.get('/api/news', async (req, res) => {
  try {
    if (Date.now() - NEWS_CACHE.time < 300000 && NEWS_CACHE.data) return res.json(NEWS_CACHE.data);
    // Try 36kr RSS (Chinese news)
    const feeds = [
      'https://36kr.com/feed',
      'https://feedss.36kr.com/feed/news',
      'https://www.zhihu.com/rss/hotlist',
    ];
    let items = [];
    for (const url of feeds) {
      try {
        const r = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' }, signal: AbortSignal.timeout(5000) });
        if (!r.ok) continue;
        const text = await r.text();
        const titles = [...text.matchAll(/<title>(?:<!\[CDATA\[)?(.*?)(?:\]\]>)?<\/title>/gs)].slice(1, 11).map(m => {
          let t = m[1]; t = t.replace(/<!\[CDATA\[/g,'').replace(/\]\]>/g,''); return t;
        }).filter(Boolean);
        if (titles.length > 3) { items = titles; break; }
      } catch(e) { continue; }
    }
    if (items.length) {
      NEWS_CACHE.data = { items: items.slice(0, 10), source: '中文热闻' };
      NEWS_CACHE.time = Date.now();
      return res.json(NEWS_CACHE.data);
    }
  } catch(e) {
    res.json({ items: ['今日新闻暂无'], source: '' });
  }
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

// ====== Log Helper ======
async function addLog(action, targetType, targetId, detail) {
  try {
    await fetch(SB('logs'), {
      method: 'POST', headers: SB_HEADERS2,
      body: JSON.stringify({ action, target_type: targetType, target_id: String(targetId), detail, created_at: new Date().toISOString() })
    });
  } catch(e) {}
}

// ====== Marketplace Admin API ======
app.get('/api/marketplace/admin/stats', async (req, res) => {
  try {
    const [prodR, verR, reportR, annR] = await Promise.all([
      fetch(SB('products?select=id,verified,status,listed'), { headers: SB_HEADERS }),
      fetch(SB('verifications?select=id,status'), { headers: SB_HEADERS }),
      fetch(SB('reports?select=id,status'), { headers: SB_HEADERS }),
      fetch(SB('announcements?select=id'), { headers: SB_HEADERS }),
    ]);
    const products = await prodR.json();
    const verifications = await verR.json();
    const reports = await reportR.json();
    const announcements = await annR.json();
    const arr = p => Array.isArray(p) ? p : [];
    res.json({
      total: arr(products).length,
      verified: arr(products).filter(p => p.verified).length,
      pending: arr(products).filter(p => p.status === 'pending').length,
      approved: arr(products).filter(p => p.status === 'approved').length,
      listed: arr(products).filter(p => p.listed !== false).length,
      verTotal: arr(verifications).length,
      verPending: arr(verifications).filter(v => v.status === 'pending').length,
      verApproved: arr(verifications).filter(v => v.status === 'approved').length,
      reports: arr(reports).length,
      reportsPending: arr(reports).filter(r => r.status === 'pending').length,
      announcements: arr(announcements).length,
    });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.patch('/api/marketplace/products/:id', express.json(), async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    if (!id) return res.status(400).json({ error: 'id required' });
    const { verified, status, listed, sold, reject_reason, title, price, category, desc, quality, contact } = req.body;
    const fields = {};
    if (verified !== undefined) fields.verified = verified;
    if (status !== undefined) fields.status = status;
    if (listed !== undefined) fields.listed = listed;
    if (sold !== undefined) fields.sold = sold;
    if (reject_reason !== undefined) fields.reject_reason = reject_reason;
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
    addLog('product_update', 'product', id, JSON.stringify(fields));
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.delete('/api/marketplace/products/:id', async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    if (!id) return res.status(400).json({ error: 'id required' });
    await fetch(SB('products?id=eq.'+id), { method: 'DELETE', headers: SB_HEADERS });
    addLog('product_delete', 'product', id, '');
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ====== Login API ======
app.post('/api/marketplace/login', express.json(), async (req, res) => {
  try {
    const { student_id, phone, name } = req.body;

    // Register first (has name) - avoid collision with login
    if (name && student_id && phone) {
      const chk = await fetch(SB("verifications?student_id=eq."+encodeURIComponent(student_id.trim())+"&select=id,status"), { headers: SB_HEADERS });
      const chkData = await chk.json();
      if (Array.isArray(chkData) && chkData.length > 0) {
        const existing = chkData[0];
        if (existing.status === 'approved') return res.json({ ok: true, user: existing, msg: '已认证，请登录' });
        if (existing.status === 'pending') return res.json({ ok: false, msg: '认证审核中，请等待' });
        await fetch(SB('verifications?id=eq.'+existing.id), { method: 'PATCH', headers: SB_HEADERS2, body: JSON.stringify({ status: 'pending', name, phone, image: req.body.image||'' }) });
        addLog('user_register', 'verification', student_id, name);
        return res.json({ ok: true, msg: '✅ 认证已重新提交，等待审核' });
      }
      await fetch(SB('verifications'), {
        method: 'POST', headers: { 'apikey': SUPABASE_KEY, 'Authorization': 'Bearer ' + SUPABASE_KEY, 'Content-Type': 'application/json', 'Prefer': 'return=representation' },
        body: JSON.stringify({ name, student_id, phone, image: req.body.image||'', status: 'pending', created_at: new Date().toISOString() })
      });
      addLog('user_register', 'verification', student_id, name);
      return res.json({ ok: true, msg: '✅ 认证已提交，等待管理员审核' });
    }

    // Login with student_id + phone
    if (student_id && phone) {
      const r = await fetch(SB("verifications?student_id=eq."+encodeURIComponent(student_id)+"&phone=eq."+encodeURIComponent(phone)+"&select=*"), { headers: SB_HEADERS });
      const data = await r.json();
      const arr = Array.isArray(data) ? data : [];
      const approved = arr.filter(v => v.status === 'approved');
      if (approved.length) {
        return res.json({ ok: true, user: { id: approved[0].id, name: approved[0].name, student_id: approved[0].student_id, phone: approved[0].phone } });
      }
      const pending = arr.filter(v => v.status === 'pending');
      if (pending.length) return res.json({ ok: false, msg: '认证审核中，请等待' });
      if (arr.length) return res.json({ ok: false, msg: '认证未通过' });
      return res.json({ ok: false, msg: '学号或电话错误' });
    }
    res.status(400).json({ error: '参数不足' });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ====== Categories API ======
app.get('/api/marketplace/categories', async (req, res) => {
  try {
    const r = await fetch(SB('categories?order=sort_order.asc&select=*'), { headers: SB_HEADERS });
    res.json(await r.json());
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/marketplace/categories', express.json(), async (req, res) => {
  try {
    const { name, icon, sort_order } = req.body;
    if (!name) return res.status(400).json({ error: 'name required' });
    const r = await fetch(SB('categories'), {
      method: 'POST', headers: { 'apikey': SUPABASE_KEY, 'Authorization': 'Bearer ' + SUPABASE_KEY, 'Content-Type': 'application/json', 'Prefer': 'return=representation' },
      body: JSON.stringify({ name, icon: icon||'📦', sort_order: sort_order||0 })
    });
    const t = await r.json();
    addLog('category_create', 'category', t.id, name);
    res.json(t);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.put('/api/marketplace/categories/:id', express.json(), async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    if (!id) return res.status(400).json({ error: 'id required' });
    const { name, icon, sort_order } = req.body;
    const fields = {};
    if (name !== undefined) fields.name = name;
    if (icon !== undefined) fields.icon = icon;
    if (sort_order !== undefined) fields.sort_order = sort_order;
    await fetch(SB('categories?id=eq.'+id), { method: 'PATCH', headers: SB_HEADERS2, body: JSON.stringify(fields) });
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.delete('/api/marketplace/categories/:id', async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    if (!id) return res.status(400).json({ error: 'id required' });
    await fetch(SB('categories?id=eq.'+id), { method: 'DELETE', headers: SB_HEADERS });
    addLog('category_delete', 'category', id, '');
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ====== Reports API ======
app.post('/api/marketplace/reports', express.json(), async (req, res) => {
  try {
    const { product_id, reason, detail, reporter_contact } = req.body;
    if (!product_id || !reason) return res.status(400).json({ error: 'product_id and reason required' });
    await fetch(SB('reports'), {
      method: 'POST', headers: SB_HEADERS2,
      body: JSON.stringify({ product_id, reason, detail: detail||'', reporter_contact: reporter_contact||'', status: 'pending' })
    });
    addLog('report_submit', 'report', product_id, reason);
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/marketplace/reports', async (req, res) => {
  try {
    const { status } = req.query;
    let url = SB('reports?order=created_at.desc&select=*');
    if (status) url = SB('reports?status=eq.'+status+'&order=created_at.desc&select=*');
    const r = await fetch(url, { headers: SB_HEADERS });
    let data = await r.json();
    // Attach product title
    const products = await (await fetch(SB('products?select=id,title'), { headers: SB_HEADERS })).json();
    const prodMap = {};
    if (Array.isArray(products)) products.forEach(p => prodMap[p.id] = p.title);
    if (Array.isArray(data)) data = data.map(r => ({ ...r, product_title: prodMap[r.product_id] || '(已删除)' }));
    res.json(data);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/marketplace/reports/resolve', express.json(), async (req, res) => {
  try {
    const { id, action: reportAction } = req.body;
    if (!id) return res.status(400).json({ error: 'id required' });
    await fetch(SB('reports?id=eq.'+id), { method: 'PATCH', headers: SB_HEADERS2, body: JSON.stringify({ status: reportAction||'resolved' }) });
    addLog('report_resolve', 'report', id, reportAction);
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ====== Announcements API ======
app.get('/api/marketplace/announcements', async (req, res) => {
  try {
    const { all } = req.query;
    let url = all ? SB('announcements?order=created_at.desc&select=*') : SB('announcements?active=eq.true&order=created_at.desc&select=*');
    const r = await fetch(url, { headers: SB_HEADERS });
    res.json(await r.json());
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/marketplace/announcements', express.json(), async (req, res) => {
  try {
    const { title, content } = req.body;
    if (!title) return res.status(400).json({ error: 'title required' });
    const r = await fetch(SB('announcements'), {
      method: 'POST', headers: { 'apikey': SUPABASE_KEY, 'Authorization': 'Bearer ' + SUPABASE_KEY, 'Content-Type': 'application/json', 'Prefer': 'return=representation' },
      body: JSON.stringify({ title, content: content||'', active: true })
    });
    const t = await r.json();
    addLog('announcement_create', 'announcement', t.id, title);
    res.json(t);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.put('/api/marketplace/announcements/:id', express.json(), async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    const { title, content, active } = req.body;
    const fields = {};
    if (title !== undefined) fields.title = title;
    if (content !== undefined) fields.content = content;
    if (active !== undefined) fields.active = active;
    if (!Object.keys(fields).length) return res.status(400).json({ error: 'no fields' });
    await fetch(SB('announcements?id=eq.'+id), { method: 'PATCH', headers: SB_HEADERS2, body: JSON.stringify(fields) });
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.delete('/api/marketplace/announcements/:id', async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    await fetch(SB('announcements?id=eq.'+id), { method: 'DELETE', headers: SB_HEADERS });
    addLog('announcement_delete', 'announcement', id, '');
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ====== Logs API ======
app.get('/api/marketplace/logs', async (req, res) => {
  try {
    const { limit: lmt } = req.query;
    let url = SB('logs?order=created_at.desc&select=*');
    if (lmt) url = SB('logs?order=created_at.desc&select=*&limit='+lmt);
    else url = SB('logs?order=created_at.desc&select=*&limit=200');
    const r = await fetch(url, { headers: SB_HEADERS });
    res.json(await r.json());
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ====== Blocked Words API ======
app.get('/api/marketplace/blocked-words', async (req, res) => {
  try {
    const r = await fetch(SB('blocked_words?select=*'), { headers: SB_HEADERS });
    res.json(await r.json());
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/marketplace/blocked-words', express.json(), async (req, res) => {
  try {
    const { word } = req.body;
    if (!word) return res.status(400).json({ error: 'word required' });
    const r = await fetch(SB('blocked_words'), {
      method: 'POST', headers: { 'apikey': SUPABASE_KEY, 'Authorization': 'Bearer ' + SUPABASE_KEY, 'Content-Type': 'application/json', 'Prefer': 'return=representation' },
      body: JSON.stringify({ word })
    });
    const t = await r.json();
    addLog('blocked_word_add', 'blocked_word', t.id, word);
    res.json(t);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.delete('/api/marketplace/blocked-words/:id', async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    await fetch(SB('blocked_words?id=eq.'+id), { method: 'DELETE', headers: SB_HEADERS });
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ====== CSV Export ======
app.get('/api/marketplace/export/:type', async (req, res) => {
  try {
    const type = req.params.type;
    if (type === 'products') {
      const r = await fetch(SB('products?order=created_at.desc&select=*'), { headers: SB_HEADERS });
      const data = await r.json();
      const rows = Array.isArray(data) ? data : [];
      const header = 'ID,标题,价格,分类,描述,联系方式,品质,状态,上架,已售,创建时间\n';
      const csv = header + rows.map(p =>
        [p.id, `"${(p.title||'').replace(/"/g,'""')}"`, p.price, `"${p.category}"`, `"${(p.desc||'').replace(/"/g,'""')}"`, `"${p.contact}"`, `"${p.quality}"`, p.status||'pending', p.listed!==false?'是':'否', p.sold?'是':'否', p.created_at].join(',')
      ).join('\n');
      res.setHeader('Content-Type', 'text/csv; charset=utf-8');
      res.setHeader('Content-Disposition', 'attachment; filename=products.csv');
      res.send('﻿' + csv);
    } else if (type === 'reports') {
      const r = await fetch(SB('reports?order=created_at.desc&select=*'), { headers: SB_HEADERS });
      const data = await r.json();
      const rows = Array.isArray(data) ? data : [];
      const header = 'ID,商品ID,原因,详情,联系方式,状态,创建时间\n';
      const csv = header + rows.map(r =>
        [r.id, r.product_id, `"${r.reason}"`, `"${(r.detail||'').replace(/"/g,'""')}"`, `"${r.reporter_contact}"`, r.status, r.created_at].join(',')
      ).join('\n');
      res.setHeader('Content-Type', 'text/csv; charset=utf-8');
      res.setHeader('Content-Disposition', 'attachment; filename=reports.csv');
      res.send('﻿' + csv);
    } else {
      res.status(400).json({ error: 'unknown export type' });
    }
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ====== Verify API ======
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
    addLog('verify_approve', 'verification', id, '');
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
    addLog('verify_delete', 'verification', id, '');
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ====== Marketplace API ======
app.post('/api/marketplace/products', express.json(), async (req, res) => {
  try {
    const { title, price, category, desc, images, contact, quality } = req.body;
    if (!title || !price) return res.status(400).json({ error: 'title and price required' });

    // Check blocked words
    try {
      const bwR = await fetch(SB('blocked_words?select=word'), { headers: SB_HEADERS });
      const bwData = await bwR.json();
      const words = Array.isArray(bwData) ? bwData.map(w => w.word.toLowerCase()) : [];
      const checkText = (title + ' ' + (desc||'')).toLowerCase();
      const found = words.filter(w => checkText.includes(w));
      if (found.length) return res.status(400).json({ error: '包含违规词: ' + found.join(', ') });
    } catch(e) {}

    const r = await fetch(SB('products'), {
      method: 'POST',
      headers: { 'apikey': SUPABASE_KEY, 'Authorization': 'Bearer ' + SUPABASE_KEY, 'Content-Type': 'application/json', 'Prefer': 'return=representation' },
      body: JSON.stringify({ title, price: parseFloat(price), category: category||'其他', desc: desc||'', images: images||[], contact: contact||'', quality: quality||'八成新', verified: false, status: 'pending', listed: true, sold: false })
    });
    const t = await r.json();
    addLog('product_create', 'product', t?.id||'?', title);
    res.json(t ? JSON.parse(JSON.stringify(t)) : { ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/marketplace/products', async (req, res) => {
  try {
    const { category, search, admin } = req.query;
    let url = SB('products?order=created_at.desc&select=*');
    // Admin sees all, public sees only approved+listed
    if (!admin) url = SB('products?status=eq.approved&listed=eq.true&order=created_at.desc&select=*');
    if (category && admin) url = SB('products?category=eq.'+category+'&order=created_at.desc&select=*');
    if (category && !admin) url = SB('products?category=eq.'+category+'&status=eq.approved&listed=eq.true&order=created_at.desc&select=*');
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
// force redeploy Tue Jun 23 15:09:58     2026
