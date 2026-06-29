import express from 'express';
import initSqlJs from 'sql.js';
import cors from 'cors';
import { randomBytes, createHmac } from 'crypto';
import http from 'http';
import { WebSocketServer } from 'ws';
import sharp from 'sharp';
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

// ====== Vault API ======
app.get('/api/vault', async (req, res) => {
  try {
    const r = await fetch(SB('vault?order=created_at.desc&select=*'), { headers: SB_HEADERS2 });
    res.json(await r.json());
  } catch(e) { res.json([]); }
});

app.post('/api/vault', express.json(), async (req, res) => {
  try {
    const { name, username, password, note } = req.body;
    const r = await fetch(SB('vault'), { method: 'POST', headers: SB_HEADERS2, body: JSON.stringify({name, username, password, note}) });
    const t = await r.text(); res.json(t ? JSON.parse(t) : { ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.put('/api/vault/:id', express.json(), async (req, res) => {
  try {
    await fetch(SB('vault?id=eq.'+req.params.id), { method: 'PATCH', headers: SB_HEADERS2, body: JSON.stringify(req.body) });
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.delete('/api/vault/clear', async (req, res) => {
  try { await fetch(SB('vault?id=gt.0'), { method: 'DELETE', headers: SB_HEADERS2 }); res.json({ ok: true }); } catch(e) { res.json({ ok: false }); }
});

app.delete('/api/vault/:id', async (req, res) => {
  try {
    await fetch(SB('vault?id=eq.'+req.params.id), { method: 'DELETE', headers: SB_HEADERS2 });
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
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

// ====== Chat Sync (Supabase) ======
app.get('/api/chat/sync', async (req, res) => {
  try {
    const r = await fetch(SB('chat_convs?select=data&order=id.desc&limit=1'), { headers: SB_HEADERS2 });
    const rows = await r.json();
    const convs = rows?.[0]?.data || [];
    res.json({ ok: true, convs });
  } catch(e) {
    res.json({ ok: true, convs: [] });
  }
});

app.post('/api/chat/sync', (req, res) => {
  try {
    const { convs } = req.body;
    if (!convs) return res.json({ ok: false, msg: 'no data' });
    // Store in Supabase
    const body = JSON.stringify({ data: convs.slice(-30), updated: new Date().toISOString() });
    fetch(SB('chat_convs'), {
      method: 'POST', headers: SB_HEADERS2,
      body
    }).catch(() => {});
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

// ====== Sensitive Words API ======
const SENSITIVE_WORDS = ['代考','替考','作弊','答案','出售答案','买答案','代写','枪手','办证','假证','发票','赌博','赌场','毒品','吸毒','卖淫','嫖娼','诈骗','洗钱','高利贷','校园贷','裸贷','传销'];
app.get('/api/sensitive-words', (req, res) => { res.json({ words: SENSITIVE_WORDS }); });

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

app.get('/api/verify/list', schoolScope, async (req, res) => {
  try {
    const r = await fetch(SB('verifications?order=created_at.desc&select=id,name,student_id,phone,status,created_at,reject_reason,nickname,gender,school,credit_score' + (req.adminSchool ? '&school=eq.'+req.adminSchool : '')), { headers: SB_HEADERS2 });
    res.json(await r.json());
  } catch(e) { res.status(500).json({ error: e.message }); }
});
app.get('/api/marketplace/nicknames', async (req, res) => {
  try {
    const r = await fetch(SB('verifications?status=eq.approved&select=student_id,nickname,gender'), { headers: SB_HEADERS });
    const d = await r.json();
    var map = {};
    (Array.isArray(d) ? d : []).forEach(function(v){ if(v.student_id && v.nickname) map[v.student_id] = v.nickname; if(v.student_id && v.gender) { if(!map._gender) map._gender = {}; map._gender[v.student_id] = v.gender; } });
    res.json(map);
  } catch(e) { res.json({}); }
});

app.post('/api/verify/approve', schoolScope, express.json(), async (req, res) => {
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
app.get('/api/marketplace/admin/stats', schoolScope, async (req, res) => {
  try {
    var sf = req.adminSchool ? '&school=eq.'+req.adminSchool : '';
    const [prodR, verR, reportR, annR] = await Promise.all([
      fetch(SB('products?select=id,item_type,verified,status,listed,payment_status'+sf), { headers: SB_HEADERS }),
      fetch(SB('verifications?select=id,status'+sf), { headers: SB_HEADERS }),
      fetch(SB('reports?select=id,status'+sf), { headers: SB_HEADERS }),
      fetch(SB('announcements?select=id'+sf), { headers: SB_HEADERS }),
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
      rentPending: arr(products).filter(p => p.status === 'pending' && p.item_type === 'rent').length,
      approved: arr(products).filter(p => p.status === 'approved').length,
      listed: arr(products).filter(p => p.listed !== false).length,
      txPending: arr(products).filter(p => p.payment_status === "pending").length,
      verTotal: arr(verifications).length,
      verPending: arr(verifications).filter(v => v.status === 'pending').length,
      verApproved: arr(verifications).filter(v => v.status === 'approved').length,
      reports: arr(reports).length,
      reportsPending: arr(reports).filter(r => r.status === 'pending').length,
      announcements: arr(announcements).length,
    });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// Send notification message from system kefu to user
async function sendNotify(ownerStudentId, ownerName, school, msg) {
  if (!ownerStudentId) return;
  const sysId = 'sys_' + (school || 'admin');
  try {
    await fetch(SB('messages'), {
      method: 'POST', headers: SB_HEADERS2,
      body: JSON.stringify({ product_id: 0, from_student_id: sysId, from_name: '系统通知', to_student_id: ownerStudentId, to_name: ownerName, content: msg, created_at: new Date().toISOString(), read: false })
    });
  } catch(e) {}
}

app.patch('/api/marketplace/products/:id', anyAdmin, express.json(), async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    if (!id) return res.status(400).json({ error: 'id required' });
    const { verified, status, listed, sold, reject_reason, pinned, title, price, category, desc, quality, contact } = req.body;
    const fields = {};
    if (verified !== undefined) fields.verified = verified;
    if (status !== undefined) fields.status = status;
    if (listed !== undefined) fields.listed = listed;
    if (sold !== undefined) fields.sold = sold;
    if (reject_reason !== undefined) fields.reject_reason = reject_reason;
    if (pinned !== undefined) fields.pinned = pinned;
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
    // Send notification on approve/reject
    if (status === 'approved' || status === 'rejected') {
      try {
        const prodR = await fetch(SB('products?id=eq.'+id+'&select=title,owner_student_id,owner_name,school'), { headers: SB_HEADERS });
        const prodD = await prodR.json();
        const prod = Array.isArray(prodD) ? prodD[0] : prodD;
        if (prod && prod.owner_student_id) {
          var nMsg = status === 'approved' ? '✅ 你的商品「'+prod.title+'」已通过审核，现在可以在集市上看到了' : '✕ 你的商品「'+prod.title+'」未通过审核' + (reject_reason ? '，原因：'+reject_reason : '');
          sendNotify(prod.owner_student_id, prod.owner_name||'', prod.school||'', nMsg);
        }
      } catch(e) {}
    }
    // Delist notification (seller's product taken down)
    if (listed === false && status === undefined) {
      try {
        const prodR = await fetch(SB('products?id=eq.'+id+'&select=title,owner_student_id,owner_name,school'), { headers: SB_HEADERS });
        const prodD = await prodR.json();
        const prod = Array.isArray(prodD) ? prodD[0] : prodD;
        if (prod && prod.owner_student_id) {
          sendNotify(prod.owner_student_id, prod.owner_name||'', prod.school||'', '📌 你的商品「'+prod.title+'」已被管理员下架');
        }
      } catch(e) {}
    }
    addLog('product_update', 'product', id, JSON.stringify(fields));
    notifyAdmin('product_update', { id, fields });
    onlineUsers.forEach(function(ws) {
      try { ws.send(JSON.stringify({ type: 'product_update', data: { id, fields } })); } catch(e) {}
    });
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.delete('/api/marketplace/products/:id', schoolScope, async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    if (!id) return res.status(400).json({ error: 'id required' });
    await fetch(SB('products?id=eq.'+id), { method: 'DELETE', headers: SB_HEADERS });
    addLog('product_delete', 'product', id, '');
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});
// Owner self-delist
app.patch('/api/marketplace/products/:id/owner-delist', express.json(), async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    const { student_id } = req.body;
    if (!id || !student_id) return res.status(400).json({ error: '参数错误' });
    const r = await fetch(SB('products?id=eq.'+id+'&select=id,owner_student_id'), { headers: SB_HEADERS });
    const d = await r.json();
    const p = Array.isArray(d) ? d[0] : null;
    if (!p) return res.status(404).json({ error: '商品不存在' });
    if (p.owner_student_id !== student_id) return res.status(403).json({ error: '无权操作' });
    await fetch(SB('products?id=eq.'+id), { method: 'PATCH', headers: SB_HEADERS2, body: JSON.stringify({ listed: false, reject_reason: 'owner_delisted' }) });
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});
// Owner re-list
app.patch('/api/marketplace/products/:id/owner-relist', express.json(), async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    const { student_id } = req.body;
    if (!id || !student_id) return res.status(400).json({ error: '参数错误' });
    const r = await fetch(SB('products?id=eq.'+id+'&select=id,owner_student_id,reject_reason,status'), { headers: SB_HEADERS });
    const d = await r.json();
    const p = Array.isArray(d) ? d[0] : null;
    if (!p) return res.status(404).json({ error: '商品不存在' });
    if (p.owner_student_id !== student_id) return res.status(403).json({ error: '无权操作' });
    if (p.reject_reason !== 'owner_delisted') return res.status(400).json({ error: '此商品不可自行上架' });
    if (p.status !== 'approved') return res.status(400).json({ error: '仅已通过商品可上架' });
    await fetch(SB('products?id=eq.'+id), { method: 'PATCH', headers: SB_HEADERS2, body: JSON.stringify({ listed: true, reject_reason: '' }) });
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});
// Owner edit product (no admin required)
app.patch('/api/marketplace/products/:id/owner-edit', express.json({ limit: '20mb' }), async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    const { student_id, title, price, category, quality, desc, gender_pref, negotiable, images, rent_price, rent_period, deposit } = req.body;
    if (!id || !student_id) return res.status(400).json({ error: '参数错误' });
    const r = await fetch(SB('products?id=eq.'+id+'&select=id,owner_student_id'), { headers: SB_HEADERS });
    const d = await r.json();
    const p = Array.isArray(d) ? d[0] : null;
    if (!p) return res.status(404).json({ error: '商品不存在' });
    if (p.owner_student_id !== student_id) return res.status(403).json({ error: '无权操作' });
    var fields = {};
    if (title !== undefined) fields.title = title;
    if (price !== undefined) fields.price = parseFloat(price);
    if (category !== undefined) fields.category = category;
    if (quality !== undefined) fields.quality = quality;
    if (desc !== undefined) fields.desc = desc;
    if (gender_pref !== undefined) fields.gender_pref = gender_pref;
    if (negotiable !== undefined) fields.negotiable = negotiable;
    if (images !== undefined) fields.images = images;
    if (rent_price !== undefined) fields.rent_price = parseFloat(rent_price);
    if (rent_period !== undefined) fields.rent_period = rent_period;
    if (deposit !== undefined) fields.deposit = parseFloat(deposit);
    if (!Object.keys(fields).length) return res.status(400).json({ error: '没有要修改的字段' });
    await fetch(SB('products?id=eq.'+id), { method: 'PATCH', headers: SB_HEADERS2, body: JSON.stringify(fields) });
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});
// Owner resubmit for review (delisted/rejected → pending)
app.post('/api/marketplace/products/:id/resubmit', express.json(), async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    const { student_id } = req.body;
    if (!id || !student_id) return res.status(400).json({ error: '参数错误' });
    const r = await fetch(SB('products?id=eq.'+id+'&select=id,owner_student_id,status'), { headers: SB_HEADERS });
    const d = await r.json();
    const p = Array.isArray(d) ? d[0] : null;
    if (!p) return res.status(404).json({ error: '商品不存在' });
    if (p.owner_student_id !== student_id) return res.status(403).json({ error: '无权操作' });
    if (p.status === 'pending') return res.status(400).json({ error: '已处于审核中' });
    await fetch(SB('products?id=eq.'+id), { method: 'PATCH', headers: SB_HEADERS2, body: JSON.stringify({ status: 'pending', reject_reason: '' }) });
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});
// Owner self-delete product (sold/listed/rejected/pending only)
app.delete('/api/marketplace/products/:id/owner-delete', express.json(), async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    const { student_id } = req.body;
    if (!id || !student_id) return res.status(400).json({ error: '参数错误' });
    const r = await fetch(SB('products?id=eq.'+id+'&select=id,owner_student_id,sold,status,listed'), { headers: SB_HEADERS });
    const d = await r.json();
    const p = Array.isArray(d) ? d[0] : null;
    if (!p) return res.status(404).json({ error: '商品不存在' });
    if (p.owner_student_id !== student_id) return res.status(403).json({ error: '无权操作' });
    if (!p.sold && p.listed !== false && p.status !== 'rejected' && p.status !== 'pending') return res.status(400).json({ error: '仅已售/下架/拒绝/待审核商品可删除' });
    await fetch(SB('products?id=eq.'+id), { method: 'DELETE', headers: SB_HEADERS });
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ====== Promotions API ======
app.get('/api/marketplace/promotions', async (req, res) => {
  try {
    const { all, school } = req.query;
    var promoUrl = all ? 'promotions?order=sort_order.asc&select=*' : 'promotions?active=eq.true&order=sort_order.asc&select=*';
    if (school && all) promoUrl += '&school=eq.'+encodeURIComponent(school);
    let url = SB(promoUrl);
    const r = await fetch(url, { headers: SB_HEADERS });
    res.json(await r.json());
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/marketplace/promotions', schoolScope, express.json(), async (req, res) => {
  try {
    const { title, desc, contact, image, sort_order, school } = req.body;
    if (!title) return res.status(400).json({ error: 'title required' });
    const r = await fetch(SB('promotions'), {
      method: 'POST', headers: { 'apikey': SUPABASE_KEY, 'Authorization': 'Bearer ' + SUPABASE_KEY, 'Content-Type': 'application/json', 'Prefer': 'return=representation' },
      body: JSON.stringify({ title, desc: desc||'', contact: contact||'', image: image||'', sort_order: sort_order||0, active: true, school: school||'' })
    });
    res.json(await r.json());
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.put('/api/marketplace/promotions/:id', fullAdmin, express.json(), async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    const { title, desc, contact, image, sort_order, active } = req.body;
    const fields = {};
    if (title !== undefined) fields.title = title;
    if (desc !== undefined) fields.desc = desc;
    if (contact !== undefined) fields.contact = contact;
    if (image !== undefined) fields.image = image;
    if (sort_order !== undefined) fields.sort_order = sort_order;
    if (active !== undefined) fields.active = active;
    await fetch(SB('promotions?id=eq.'+id), { method: 'PATCH', headers: SB_HEADERS2, body: JSON.stringify(fields) });
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.delete('/api/marketplace/promotions/:id', fullAdmin, async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    await fetch(SB('promotions?id=eq.'+id), { method: 'DELETE', headers: SB_HEADERS });
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ====== Reviews API ======
app.post('/api/marketplace/reviews', express.json(), async (req, res) => {
  try {
    const { product_id, buyer_id, seller_id, tags, reason, images } = req.body;
    if (!product_id || !buyer_id || !seller_id || !reason) return res.status(400).json({ error: '参数不足' });
    if (!tags || !tags.length) return res.status(400).json({ error: '请选择评价标签' });
    if (buyer_id === seller_id) return res.status(400).json({ error: '不能给自己评价' });
    // Verify trade completed and user is a participant
    const r = await fetch(SB('products?id=eq.'+product_id+'&select=trade_status,trade_buyer_id,owner_student_id'), { headers: SB_HEADERS });
    const d = await r.json();
    const p = Array.isArray(d) ? d[0] : null;
    if (!p || p.trade_status !== 'completed') return res.status(400).json({ error: '交易未完成' });
    // Save
    const ins = await fetch(SB('reviews'), { method: 'POST', headers: SB_HEADERS2, body: JSON.stringify({ product_id, buyer_id, seller_id, tags, reason, images: images||[], created_at: new Date().toISOString() }) });
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/marketplace/reviews', async (req, res) => {
  try {
    const { seller_id, product_id } = req.query;
    let url = SB('reviews?order=created_at.desc&select=*');
    if (seller_id) url = SB('reviews?seller_id=eq.'+encodeURIComponent(seller_id)+'&order=created_at.desc&select=*');
    if (product_id) url = SB('reviews?product_id=eq.'+product_id+'&order=created_at.desc&select=*');
    const r = await fetch(url, { headers: SB_HEADERS });
    res.json(await r.json());
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ====== Credit Score API ======
app.get("/api/marketplace/credit", async (req, res) => {
  try {
    const { student_id } = req.query;
    let url = SB("verifications?select=student_id,credit_score&status=eq.approved");
    if (student_id) url = SB("verifications?student_id=eq."+encodeURIComponent(student_id)+"&select=student_id,credit_score");
    const r = await fetch(url, { headers: SB_HEADERS });
    const d = await r.json();
    const arr = Array.isArray(d) ? d : [];
    var map = {};
    arr.forEach(function(v){ if(v.student_id) map[v.student_id] = v.credit_score || 80; });
    res.json(student_id ? (arr[0]||{credit_score:80}) : map);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.patch("/api/marketplace/credit", schoolScope, express.json(), async (req, res) => {
  try {
    const { student_id, delta, reason } = req.body;
    if (!student_id || !delta) return res.status(400).json({ error: "参数不足" });
    const r = await fetch(SB("verifications?student_id=eq."+encodeURIComponent(student_id)+"&select=id,credit_score"), { headers: SB_HEADERS });
    const d = await r.json();
    const v = Array.isArray(d) ? d[0] : null;
    if (!v) return res.status(404).json({ error: "用户不存在" });
    var newScore = Math.max(0, Math.min(100, (v.credit_score||80) + delta));
    await fetch(SB("verifications?id=eq."+v.id), { method: "PATCH", headers: SB_HEADERS2, body: JSON.stringify({ credit_score: newScore }) });
    addLog("credit_update", "verification", student_id, (delta>0?"+":"")+delta+" 原因:"+(reason||""));
    res.json({ ok: true, credit_score: newScore });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ====== Campus Wall API ======
app.post('/api/wall/posts', express.json(), async (req, res) => {
  try {
    const { title, content, images, type, author_name, author_student_id, school } = req.body;
    if (!title || !content) return res.status(400).json({ error: '标题和内容不能为空' });
    const r = await fetch(SB('wall_posts'), {
      method: 'POST', headers: SB_HEADERS2,
      body: JSON.stringify({ title, content, images: images||[], type: type||'post', status: 'pending', author_name: author_name||'', author_student_id: author_student_id||'', school: school||'', created_at: new Date().toISOString() })
    });
    const t = await r.json();
    res.json(t);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/wall/posts', async (req, res) => {
  try {
    const { type, school, limit, offset } = req.query;
    let url = SB('wall_posts?status=eq.approved&order=created_at.desc&select=*');
    if (type) url = SB('wall_posts?status=eq.approved&type=eq.'+type+'&order=created_at.desc&select=*');
    if (school) url += '&school=eq.'+encodeURIComponent(school);
    if (limit) url += '&limit='+parseInt(limit); else url += '&limit=50';
    if (offset) url += '&offset='+parseInt(offset);
    const r = await fetch(url, { headers: SB_HEADERS });
    res.json(await r.json());
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/wall/admin/posts', schoolScope, async (req, res) => {
  try {
    const { status, type, search } = req.query;
    let url = SB('wall_posts?order=created_at.desc&select=*');
    if (status) url = SB('wall_posts?status=eq.'+status+'&order=created_at.desc&select=*');
    if (type) url += '&type=eq.'+type;
    if (req.adminSchool) url += '&school=eq.'+req.adminSchool;
    if (search) { const r = await fetch(url, { headers: SB_HEADERS }); let d = await r.json(); d = (Array.isArray(d)?d:[]).filter(p => (p.title||'').toLowerCase().includes(search.toLowerCase()) || (p.author_name||'').toLowerCase().includes(search.toLowerCase())); return res.json(d); }
    const r = await fetch(url, { headers: SB_HEADERS });
    res.json(await r.json());
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.patch('/api/wall/admin/posts/:id', schoolScope, express.json(), async (req, res) => {
  try {
    const { status, reject_reason } = req.body;
    const body = {};
    if (status) body.status = status;
    if (reject_reason !== undefined) body.reject_reason = reject_reason;
    await fetch(SB('wall_posts?id=eq.'+req.params.id), { method: 'PATCH', headers: SB_HEADERS2, body: JSON.stringify(body) });
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.delete('/api/wall/admin/posts/:id', schoolScope, async (req, res) => {
  try {
    await fetch(SB('wall_posts?id=eq.'+req.params.id), { method: 'DELETE', headers: SB_HEADERS });
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});


// ====== Wall Admin Login ======
app.post("/api/wall/admin/login", express.json(), (req, res) => {
  const { password } = req.body;
  if (password === WALL_ADMIN_PASSWORD) { var t = randomBytes(16).toString("hex"); wallAdminTokens.add(t); return res.json({ ok: true, token: t }); }
  res.status(401).json({ error: "密码错误" });
});

// ====== Phone-only (guest) login ======
app.post('/api/marketplace/phone-login', express.json(), async (req, res) => {
  try {
    const { phone } = req.body;
    if (!phone || !phone.match(/^\d{11}$/)) return res.json({ ok: false, msg: '请输入11位手机号' });
    const r = await fetch(SB("verifications?phone=eq."+encodeURIComponent(phone)+"&select=id,phone,name,status,school"), { headers: SB_HEADERS });
    const data = await r.json();
    const arr = Array.isArray(data) ? data : [];
    var existing = arr.find(function(v){ return v.status === 'phone_only' || v.status === 'approved'; });
    if (existing) {
      return res.json({ ok: true, user: { id: existing.id||phone, phone: existing.phone||phone, name: existing.name || '游客', school: existing.school||'', tier: existing.status === 'approved' ? 'full' : 'phone' } });
    }
    // Create phone-only record
    var now = new Date().toISOString();
    await fetch(SB('verifications'), {
      method: 'POST', headers: { 'apikey': SUPABASE_KEY, 'Authorization': 'Bearer '+SUPABASE_KEY, 'Content-Type': 'application/json' },
      body: JSON.stringify({ phone, status: 'phone_only', created_at: now })
    });
    res.json({ ok: true, user: { id: phone, phone: phone, name: '游客', school: '', tier: 'phone' } });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ====== Beta check API ======
var BETA_PASSWORD = process.env.BETA_PASSWORD || '';
app.post('/api/marketplace/beta-check', express.json(), (req, res) => {
  if (!BETA_PASSWORD) return res.json({ ok: true, beta: false });
  if (req.body.password === BETA_PASSWORD) return res.json({ ok: true, beta: true });
  res.json({ ok: false, msg: '内测密码错误' });
});
app.post('/api/admin/beta-password', anyAdmin, express.json(), (req, res) => {
  if (req.body.password) { BETA_PASSWORD = req.body.password; res.json({ ok: true, password: BETA_PASSWORD }); }
  else res.json({ ok: false, error: 'password required' });
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
        await fetch(SB('verifications?id=eq.'+existing.id), { method: 'PATCH', headers: SB_HEADERS2, body: JSON.stringify({ status: 'pending', name, phone, image: req.body.image||'', payment_qr: req.body.payment_qr||'', nickname: req.body.nickname||'', school: req.body.school||'' }) });
        addLog('user_register', 'verification', student_id, name);
        return res.json({ ok: true, msg: '✅ 认证已重新提交，等待审核' });
      }
      await fetch(SB('verifications'), {
        method: 'POST', headers: { 'apikey': SUPABASE_KEY, 'Authorization': 'Bearer ' + SUPABASE_KEY, 'Content-Type': 'application/json', 'Prefer': 'return=representation' },
        body: JSON.stringify({ name, student_id, phone, image: req.body.image||'', payment_qr: req.body.payment_qr||'', gender: req.body.gender||'', nickname: req.body.nickname||'', school: req.body.school||'', status: 'pending', created_at: new Date().toISOString() })
      });
      addLog('user_register', 'verification', student_id, name);
        notifyAdmin('new_verification', { student_id, name });
      return res.json({ ok: true, msg: '✅ 认证已提交，等待管理员审核' });
    }

    // Login with student_id + phone
    if (student_id && phone) {
      const r = await fetch(SB("verifications?student_id=eq."+encodeURIComponent(student_id)+"&phone=eq."+encodeURIComponent(phone)+"&select=*"), { headers: SB_HEADERS });
      const data = await r.json();
      const arr = Array.isArray(data) ? data : [];
      const approved = arr.filter(v => v.status === 'approved');
      if (approved.length) {
        var loginToken = randomBytes(16).toString('hex');
        await fetch(SB('verifications?id=eq.'+approved[0].id), { method: 'PATCH', headers: SB_HEADERS2, body: JSON.stringify({ login_token: loginToken }) });
        approved[0].login_token = loginToken;
        return res.json({ ok: true, user: { id: approved[0].id, name: approved[0].name, student_id: approved[0].student_id, phone: approved[0].phone, nickname: approved[0].nickname||'', school: approved[0].school||'', login_token: loginToken, tier: 'full' } });
      }
      const muted = arr.filter(v => v.status === 'muted');
      if (muted.length) {
        var loginToken = randomBytes(16).toString('hex');
        await fetch(SB('verifications?id=eq.'+muted[0].id), { method: 'PATCH', headers: SB_HEADERS2, body: JSON.stringify({ login_token: loginToken }) });
        muted[0].login_token = loginToken;
        return res.json({ ok: true, user: { id: muted[0].id, name: muted[0].name, student_id: muted[0].student_id, phone: muted[0].phone, nickname: muted[0].nickname||'', school: muted[0].school||'', login_token: loginToken }, muted: true, msg: '账号已禁言，仅可发布商品不可聊天' });
      }
      const banned = arr.filter(v => v.status === 'banned');
      if (banned.length) return res.json({ ok: false, msg: '账号已封禁' + (banned[0]?.reject_reason ? '：' + banned[0].reject_reason : '') });
      const pending = arr.filter(v => v.status === 'pending');
      if (pending.length) return res.json({ ok: false, msg: '认证审核中，请等待' });
      if (arr.length) return res.json({ ok: false, msg: '认证未通过' + (arr[0]?.reject_reason ? '：' + arr[0].reject_reason : '') });
      return res.json({ ok: false, msg: '学号或电话错误' });
    }
    res.status(400).json({ error: '参数不足' });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ====== Trade API ======
app.post('/api/marketplace/trade/request', express.json(), async (req, res) => {
  try {
    const { product_id, buyer_id, buyer_name } = req.body;
    if (!product_id || !buyer_id) return res.status(400).json({ error: 'missing fields' });
    // Get real name from verifications
    var realName = buyer_name||'';
    try { var nr = await fetch(SB("verifications?student_id=eq."+encodeURIComponent(buyer_id)+"&select=name"), { headers: SB_HEADERS }); var nd = await nr.json(); if(Array.isArray(nd)&&nd[0]&&nd[0].name) realName = nd[0].name; } catch(e){}
    await fetch(SB('products?id=eq.'+product_id), { method: 'PATCH', headers: SB_HEADERS2, body: JSON.stringify({ trade_status: 'trading', trade_buyer_id: buyer_id, trade_buyer_name: realName }) });
    try {
      const rr = await fetch(SB('products?id=eq.'+product_id+'&select=title,owner_student_id,owner_name,school'), { headers: SB_HEADERS });
      const rd = await rr.json(); const rp = Array.isArray(rd) ? rd[0] : null;
      if (rp && rp.owner_student_id) sendNotify(rp.owner_student_id, rp.owner_name, rp.school, '📦 有人想购买你的商品「'+rp.title+'」，快去看看吧');
    } catch(e) {}
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/marketplace/trade/confirm', express.json(), async (req, res) => {
  try {
    const { product_id } = req.body;
    if (!product_id) return res.status(400).json({ error: 'product_id required' });
    await fetch(SB('products?id=eq.'+product_id), { method: 'PATCH', headers: SB_HEADERS2, body: JSON.stringify({ trade_status: 'awaiting_buyer', payment_status: 'pending' }) });
    try {
      const rr = await fetch(SB('products?id=eq.'+product_id+'&select=title,trade_buyer_id,trade_buyer_name,owner_student_id,owner_name,school'), { headers: SB_HEADERS });
      const rd = await rr.json(); const rp = Array.isArray(rd) ? rd[0] : null;
      if (rp && rp.trade_buyer_id) sendNotify(rp.trade_buyer_id, rp.trade_buyer_name, rp.school, '✅ 卖家已确认购买「'+rp.title+'」，请确认收货');
    } catch(e) {}
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});
app.post('/api/marketplace/trade/buyer-confirm', express.json(), async (req, res) => {
  try {
    const { product_id } = req.body;
    if (!product_id) return res.status(400).json({ error: 'product_id required' });
    await fetch(SB('products?id=eq.'+product_id), { method: 'PATCH', headers: SB_HEADERS2, body: JSON.stringify({ trade_status: 'completed', sold: true, listed: false }) });
    // Notify both parties
    try {
      const r = await fetch(SB('products?id=eq.'+product_id+'&select=title,owner_student_id,owner_name,trade_buyer_id,trade_buyer_name,school'), { headers: SB_HEADERS });
      const d = await r.json();
      const p = Array.isArray(d) ? d[0] : null;
      if (p) {
        sendNotify(p.owner_student_id, p.owner_name, p.school, '💰 你的商品「'+p.title+'」买家已确认收货，交易完成 🎉');
        sendNotify(p.trade_buyer_id, p.trade_buyer_name, p.school, '✅ 你购买的「'+p.title+'」已确认收货，交易完成 🎉');
      }
    } catch(e) {}
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/marketplace/trade/cancel', express.json(), async (req, res) => {
  try {
    const { product_id } = req.body;
    if (!product_id) return res.status(400).json({ error: 'product_id required' });
    await fetch(SB('products?id=eq.'+product_id), { method: 'PATCH', headers: SB_HEADERS2, body: JSON.stringify({ trade_status: '', trade_buyer_id: '', trade_buyer_name: '' }) });
    try {
      const rr = await fetch(SB('products?id=eq.'+product_id+'&select=title,owner_student_id,owner_name,trade_buyer_id,trade_buyer_name,school'), { headers: SB_HEADERS });
      const rd = await rr.json(); const rp = Array.isArray(rd) ? rd[0] : null;
      if (rp) {
        sendNotify(rp.owner_student_id, rp.owner_name, rp.school, '✕ 商品「'+rp.title+'」的交易已取消');
        if (rp.trade_buyer_id) sendNotify(rp.trade_buyer_id, rp.trade_buyer_name, rp.school, '✕ 商品「'+rp.title+'」的交易已被卖家取消');
      }
    } catch(e) {}
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ====== Seller Management API ======
app.get('/api/marketplace/sellers', async (req, res) => {
  try {
    var schoolFilter = req.query.school ? '&school=eq.'+req.query.school : '';
    const r = await fetch(SB('products?select=owner_student_id,owner_name,id,title,status,listed,sold'+schoolFilter), { headers: SB_HEADERS });
    let data = await r.json();
    let arr = Array.isArray(data) ? data : [];
    // Group by owner
    let sellers = {}, seen = {};
    arr.forEach(function(p) {
      if (!p.owner_student_id) return;
      if (!sellers[p.owner_student_id]) sellers[p.owner_student_id] = { student_id: p.owner_student_id, name: p.owner_name||p.owner_student_id, total: 0, active: 0, listed: 0, product_ids: [] };
      sellers[p.owner_student_id].total++;
      if (p.status === 'approved') sellers[p.owner_student_id].active++;
      if (p.listed) sellers[p.owner_student_id].listed++;
      sellers[p.owner_student_id].product_ids.push(p.id);
    });
    var sellerList = Object.values(sellers);
    // Attach rating stats
    try {
      var rR = await fetch(SB('reviews?select=seller_id,buyer_id'), { headers: SB_HEADERS });
      var rData = await rR.json();
      if (Array.isArray(rData)) {
        var rCount = {};
        rData.forEach(function(r) { if (r.seller_id) rCount[r.seller_id] = (rCount[r.seller_id]||0) + 1; });
        sellerList.forEach(function(s) { s.review_count = rCount[s.student_id]||0; });
      }
    } catch(e) {}
    // Attach muted status from verifications
    try {
      var vR = await fetch(SB('verifications?select=student_id,status'+schoolFilter), { headers: SB_HEADERS });
      var vData = await vR.json();
      if (Array.isArray(vData)) {
        var vMap = {}, cMap = {};
        vData.forEach(function(v) { vMap[v.student_id] = v.status; if (v.credit_score) cMap[v.student_id] = v.credit_score; });
        sellerList.forEach(function(s) { s.status = vMap[s.student_id] || 'approved'; s.credit_score = cMap[s.student_id] || 80; });
      }
    } catch(e) {}
    res.json(sellerList);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/marketplace/sellers/toggle-all', express.json(), async (req, res) => {
  try {
    const { student_id, listed } = req.body;
    if (!student_id) return res.status(400).json({ error: 'student_id required' });
    const r = await fetch(SB("products?owner_student_id=eq."+encodeURIComponent(student_id)+"&status=eq.approved&select=id"), { headers: SB_HEADERS });
    let data = await r.json();
    let arr = Array.isArray(data) ? data : [];
    for (const p of arr) {
      await fetch(SB('products?id=eq.'+p.id), { method: 'PATCH', headers: SB_HEADERS2, body: JSON.stringify({ listed: !!listed }) });
    }
    addLog('seller_toggle', 'seller', student_id, listed?'上架':'下架'+' '+arr.length+'件');
    res.json({ ok: true, count: arr.length });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// Ban account
app.post('/api/marketplace/sellers/ban', express.json(), async (req, res) => {
  try {
    const { student_id, reason } = req.body;
    if (!student_id) return res.status(400).json({ error: 'student_id required' });
    // Find verification by student_id
    const r = await fetch(SB("verifications?student_id=eq."+encodeURIComponent(student_id)+"&select=id"), { headers: SB_HEADERS });
    const data = await r.json();
    const arr = Array.isArray(data) ? data : [];
    if (arr.length) {
      await fetch(SB('verifications?id=eq.'+arr[0].id), { method: 'PATCH', headers: SB_HEADERS2, body: JSON.stringify({ status: 'banned', reject_reason: reason||'' }) });
    }
    // Also take down all products
    const prodR = await fetch(SB("products?owner_student_id=eq."+encodeURIComponent(student_id)+"&select=id"), { headers: SB_HEADERS });
    const prodData = await prodR.json();
    const prodArr = Array.isArray(prodData) ? prodData : [];
    for (const p of prodArr) {
      await fetch(SB('products?id=eq.'+p.id), { method: 'PATCH', headers: SB_HEADERS2, body: JSON.stringify({ listed: false, status: 'rejected' }) });
    }
    addLog('seller_ban', 'seller', student_id, reason);
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/marketplace/sellers/mute', express.json(), async (req, res) => {
  try {
    const { student_id, reason, action } = req.body;
    if (!student_id) return res.status(400).json({ error: 'student_id required' });
    const newStatus = action === 'unmute' ? 'pending' : 'muted';
    const r = await fetch(SB("verifications?student_id=eq."+encodeURIComponent(student_id)+"&select=id"), { headers: SB_HEADERS });
    const data = await r.json();
    const arr = Array.isArray(data) ? data : [];
    if (arr.length) {
      await fetch(SB('verifications?id=eq.'+arr[0].id), { method: 'PATCH', headers: SB_HEADERS2, body: JSON.stringify({ status: newStatus, reject_reason: reason||'' }) });
    }
    addLog('seller_' + (action === 'unmute' ? 'unmute' : 'mute'), 'seller', student_id, reason||'');
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});
// Delete seller account + all products
app.delete('/api/marketplace/sellers/:student_id', async (req, res) => {
  try {
    var sid = req.params.student_id;
    // Delete all products by this seller
    await fetch(SB("products?owner_student_id=eq."+encodeURIComponent(sid)), { method: 'DELETE', headers: SB_HEADERS });
    // Delete verification records
    var vR = await fetch(SB("verifications?student_id=eq."+encodeURIComponent(sid)+"&select=id"), { headers: SB_HEADERS });
    var vD = await vR.json();
    var ids = (Array.isArray(vD)?vD:[]).map(function(v){ return v.id; });
    for (var vid of ids) {
      await fetch(SB('verifications?id=eq.'+vid), { method: 'DELETE', headers: SB_HEADERS });
    }
    addLog('seller_delete', 'seller', sid, '');
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ====== Categories API ======
app.get('/api/marketplace/categories', async (req, res) => {
  try {
    const r = await fetch(SB('categories?order=sort_order.asc&select=*'), { headers: SB_HEADERS });
    res.json(await r.json());
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/marketplace/categories', fullAdmin, express.json(), async (req, res) => {
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

app.put('/api/marketplace/categories/:id', fullAdmin, express.json(), async (req, res) => {
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

app.delete('/api/marketplace/categories/:id', fullAdmin, async (req, res) => {
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

app.get('/api/marketplace/reports', schoolScope, async (req, res) => {
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

app.post('/api/marketplace/reports/resolve', anyAdmin, express.json(), async (req, res) => {
  try {
    const { id, action: reportAction } = req.body;
    if (!id) return res.status(400).json({ error: 'id required' });
    await fetch(SB('reports?id=eq.'+id), { method: 'PATCH', headers: SB_HEADERS2, body: JSON.stringify({ status: reportAction||'resolved' }) });
    addLog('report_resolve', 'report', id, reportAction);
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});
app.delete('/api/marketplace/reports/:id', anyAdmin, async (req, res) => {
  try {
    await fetch(SB('reports?id=eq.'+req.params.id), { method: 'DELETE', headers: SB_HEADERS });
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ====== Announcements API ======
app.get('/api/marketplace/announcements', async (req, res) => {
  try {
    const { all, school } = req.query;
    var annUrl = all ? 'announcements?order=created_at.desc&select=*' : 'announcements?active=eq.true&order=created_at.desc&select=*';
    if (school && all) annUrl += '&or=(school.eq.,school.eq.'+encodeURIComponent(school)+')';
    const r = await fetch(SB(annUrl), { headers: SB_HEADERS });
    res.json(await r.json());
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/marketplace/announcements', schoolScope, express.json(), async (req, res) => {
  try {
    const { title, content } = req.body;
    if (!title) return res.status(400).json({ error: 'title required' });
    const school = req.body.school || req.adminSchool || '';
    const r = await fetch(SB('announcements'), {
      method: 'POST', headers: { 'apikey': SUPABASE_KEY, 'Authorization': 'Bearer ' + SUPABASE_KEY, 'Content-Type': 'application/json', 'Prefer': 'return=representation' },
      body: JSON.stringify({ title, content: content||'', active: true, school })
    });
    const t = await r.json();
    addLog('announcement_create', 'announcement', t.id, title);
    res.json(t);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.put('/api/marketplace/announcements/:id', anyAdmin, express.json(), async (req, res) => {
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

app.delete('/api/marketplace/announcements/:id', anyAdmin, async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    await fetch(SB('announcements?id=eq.'+id), { method: 'DELETE', headers: SB_HEADERS });
    addLog('announcement_delete', 'announcement', id, '');
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ====== Logs API ======
app.get('/api/marketplace/logs', schoolScope, async (req, res) => {
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
app.get('/api/marketplace/blocked-words', schoolScope, async (req, res) => {
  try {
    var sf = req.adminSchool ? '&school=eq.'+req.adminSchool : '';
    const r = await fetch(SB('blocked_words?select=*'+sf), { headers: SB_HEADERS });
    res.json(await r.json());
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/marketplace/blocked-words', schoolScope, express.json(), async (req, res) => {
  try {
    const { word, school } = req.body;
    if (!word) return res.status(400).json({ error: 'word required' });
    const r = await fetch(SB('blocked_words'), {
      method: 'POST', headers: { 'apikey': SUPABASE_KEY, 'Authorization': 'Bearer ' + SUPABASE_KEY, 'Content-Type': 'application/json', 'Prefer': 'return=representation' },
      body: JSON.stringify({ word, school })
    });
    const t = await r.json();
    addLog('blocked_word_add', 'blocked_word', t.id, word+(school?' ['+school+']':''));
    res.json(t);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.delete('/api/marketplace/blocked-words/:id', schoolScope, async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    await fetch(SB('blocked_words?id=eq.'+id), { method: 'DELETE', headers: SB_HEADERS });
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ====== Chat Alert API ======
app.post('/api/marketplace/chat-alert', express.json(), async (req, res) => {
  try {
    const { content, from, to } = req.body;
    let words = ['微信','电话','转账','银行卡','支付宝','QQ','私下交易','加我','联系我'];
    try { const r = await fetch(SB('blocked_words?select=word'), { headers: SB_HEADERS }); const d = await r.json(); if (d.length) words = d.map(w => w.word); } catch(e) {}
    const found = words.filter(w => content?.includes(w));
    if (found.length) {
      await fetch(SB('chat_alerts'), { method: 'POST', headers: SB_HEADERS2, body: JSON.stringify({ content: content?.slice(0,200), from_name: from||'', to_name: to||'', words: found.join(','), created_at: new Date().toISOString() }) });
      notifyAdmin('chat_alert', { from, to, words: found });
    }
    res.json({ ok: true });
  } catch(e) { res.json({ ok: false }); }
});

app.get('/api/marketplace/chat-alerts', schoolScope, async (req, res) => {
  try {
    const r = await fetch(SB('chat_alerts?order=created_at.desc&limit=50&select=*' + (req.adminSchool ? '&school=eq.'+req.adminSchool : '')), { headers: SB_HEADERS2 });
    res.json(await r.json());
  } catch(e) { res.json([]); }
});

// ====== CSV Export ======
app.get('/api/marketplace/export/:type', schoolScope, async (req, res) => {
  try {
    const type = req.params.type;
    if (type === 'products') {
      const r = await fetch(SB('products?order=created_at.desc&select=*' + (req.adminSchool ? '&school=eq.'+req.adminSchool : '')), { headers: SB_HEADERS });
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
      const r = await fetch(SB('reports?order=created_at.desc&select=*' + (req.adminSchool ? '&school=eq.'+req.adminSchool : '')), { headers: SB_HEADERS });
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

app.get('/api/verify/list', schoolScope, async (req, res) => {
  try {
    const r = await fetch(SB('verifications?order=created_at.desc&select=id,name,student_id,phone,status,created_at,reject_reason,nickname,gender,school' + (req.adminSchool ? '&school=eq.'+req.adminSchool : '')), { headers: SB_HEADERS2 });
    res.json(await r.json());
  } catch(e) { res.status(500).json({ error: e.message }); }
});
app.get('/api/marketplace/nicknames', async (req, res) => {
  try {
    const r = await fetch(SB('verifications?status=eq.approved&select=student_id,nickname,gender'), { headers: SB_HEADERS });
    const d = await r.json();
    var map = {};
    (Array.isArray(d) ? d : []).forEach(function(v){ if(v.student_id && v.nickname) map[v.student_id] = v.nickname; if(v.student_id && v.gender) { if(!map._gender) map._gender = {}; map._gender[v.student_id] = v.gender; } });
    res.json(map);
  } catch(e) { res.json({}); }
});

app.post('/api/verify/approve', schoolScope, express.json(), async (req, res) => {
  try {
    const { id, productIds } = req.body;
    if (!id) return res.status(400).json({ error: 'id required' });
    await fetch(SB('verifications?id=eq.'+id), { method: 'PATCH', headers: SB_HEADERS2, body: JSON.stringify({ status: 'approved' }) });
    if (productIds && productIds.length) {
      for (const pid of productIds) {
        await fetch(SB('products?id=eq.'+pid), { method: 'PATCH', headers: SB_HEADERS2, body: JSON.stringify({ verified: true }) });
      }
    }
    // Send notification
    try {
      const vr = await fetch(SB('verifications?id=eq.'+id+'&select=student_id,name,school'), { headers: SB_HEADERS });
      const vd = await vr.json();
      const v = Array.isArray(vd) ? vd[0] : vd;
      if (v && v.student_id) sendNotify(v.student_id, v.name||'', v.school||'', '✅ 你的学生认证已通过审核 🎉');
    } catch(e) {}
    addLog('verify_approve', 'verification', id, '');
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/verify/reject', schoolScope, express.json(), async (req, res) => {
  try {
    const { id, reason } = req.body;
    if (!id) return res.status(400).json({ error: 'id required' });
    const fields = { status: 'rejected' };
    if (reason) fields.reject_reason = reason;
    await fetch(SB('verifications?id=eq.'+id), { method: 'PATCH', headers: SB_HEADERS2, body: JSON.stringify(fields) });
    // Send notification
    try {
      const vr = await fetch(SB('verifications?id=eq.'+id+'&select=student_id,name,school'), { headers: SB_HEADERS });
      const vd = await vr.json();
      const v = Array.isArray(vd) ? vd[0] : vd;
      if (v && v.student_id) sendNotify(v.student_id, v.name||'', v.school||'', '✕ 你的学生认证未通过审核' + (reason ? '，原因：'+reason : ''));
    } catch(e) {}
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.delete('/api/verify/:id', schoolScope, async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    if (!id) return res.status(400).json({ error: 'id required' });
    await fetch(SB('verifications?id=eq.'+id), { method: 'DELETE', headers: SB_HEADERS });
    addLog('verify_delete', 'verification', id, '');
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/verify/image/:id', schoolScope, async (req, res) => {
  try {
    const r = await fetch(SB('verifications?id=eq.'+req.params.id+'&select=image'), { headers: SB_HEADERS2 });
    const data = await r.json();
    res.json({ image: data?.[0]?.image || null });
  } catch(e) { res.json({ image: null }); }
});

app.get('/api/verify/payment-qr/:id', schoolScope, async (req, res) => {
  try {
    const r = await fetch(SB('verifications?id=eq.'+req.params.id+'&select=payment_qr'), { headers: SB_HEADERS2 });
    const data = await r.json();
    res.json({ payment_qr: data?.[0]?.payment_qr || null });
  } catch(e) { res.json({ payment_qr: null }); }
});

// ====== Marketplace API ======
app.post('/api/marketplace/products', express.json({ limit: '20mb' }), async (req, res) => {
  try {
    const { title, price, category, desc, images, contact, quality, item_type, rent_price } = req.body;
    if (!title) return res.status(400).json({ error: 'title required' });
    if (item_type !== 'rent' && !price) return res.status(400).json({ error: 'price required' });
    if (item_type === 'rent' && !rent_price) return res.status(400).json({ error: 'rent_price required' });

    // Check blocked words (school-specific + global)
    try {
      var schoolFilter = req.body.school ? '&school=eq.'+encodeURIComponent(req.body.school) : '';
      const bwR = await fetch(SB('blocked_words?select=word'+schoolFilter), { headers: SB_HEADERS });
      const bwData = await bwR.json();
      const words = Array.isArray(bwData) ? bwData.map(w => w.word.toLowerCase()) : [];
      const checkText = (title + ' ' + (desc||'')).toLowerCase();
      const found = words.filter(w => checkText.includes(w));
      if (found.length) return res.status(400).json({ error: '包含违规词: ' + found.join(', ') });
    } catch(e) {}

    const r = await fetch(SB('products'), {
      method: 'POST',
      headers: { 'apikey': SUPABASE_KEY, 'Authorization': 'Bearer ' + SUPABASE_KEY, 'Content-Type': 'application/json', 'Prefer': 'return=representation' },
      body: JSON.stringify({ title, price: parseFloat(price), category: category||'其他', desc: desc||'', images: images||[], contact: contact||'', quality: quality||'八成新', verified: false, status: 'pending', listed: true, sold: false, owner_student_id: req.body.owner_student_id||'', owner_name: req.body.owner_name||'', gender_pref: req.body.gender_pref||'all', item_type: req.body.item_type||'sell', rent_price: parseFloat(req.body.rent_price)||0, rent_period: req.body.rent_period||'day', deposit: parseFloat(req.body.deposit)||0, school: req.body.school||'', negotiable: req.body.negotiable||false })
    });
    const t = await r.json();
    addLog('product_create', 'product', t?.id||'?', title);
        notifyAdmin('new_product', { id: t?.id, title, item_type: req.body.item_type||'sell' });
    res.json(t ? JSON.parse(JSON.stringify(t)) : { ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/marketplace/products', async (req, res) => {
  try {
    const { category, search, admin, limit, offset, owner, item_type, school, sort, price_min, price_max } = req.query;
    const pageSize = parseInt(limit) || 20;
    const pageOffset = parseInt(offset) || 0;
    var orderBy = 'pinned.desc,created_at.desc';
    if (sort === 'oldest') orderBy = 'pinned.desc,created_at.asc';
    if (sort === 'price_asc' || sort === 'price_desc') {
      var pf = item_type === 'rent' ? 'rent_price' : 'price';
      orderBy = 'pinned.desc,'+pf+'.'+(sort === 'price_asc' ? 'asc' : 'desc');
    }
    // Get total count first
    let countUrl = SB('products?select=id');
    if (!admin) countUrl = SB('products?status=eq.approved&listed=eq.true&select=id');
    if (category && admin) countUrl = SB('products?category=eq.'+category+'&select=id');
    if (category && !admin) countUrl = SB('products?category=eq.'+category+'&status=eq.approved&listed=eq.true&select=id');

    if (school) {
      countUrl = SB('products?school=eq.'+school+'&status=eq.approved&listed=eq.true&select=id');
      if (category) countUrl = SB('products?school=eq.'+school+'&category=eq.'+category+'&status=eq.approved&listed=eq.true&select=id');
      if (admin) { countUrl = SB('products?school=eq.'+school+'&select=id'); if(category) countUrl = SB('products?school=eq.'+school+'&category=eq.'+category+'&select=id'); }
    }
    if (item_type && !admin) {
      if (school) {
        countUrl = SB('products?item_type=eq.'+item_type+'&school=eq.'+school+'&status=eq.approved&listed=eq.true&select=id');
        if (category) countUrl = SB('products?item_type=eq.'+item_type+'&school=eq.'+school+'&category=eq.'+category+'&status=eq.approved&listed=eq.true&select=id');
      } else {
        countUrl = SB('products?item_type=eq.'+item_type+'&status=eq.approved&listed=eq.true&select=id');
        if (category) countUrl = SB('products?item_type=eq.'+item_type+'&category=eq.'+category+'&status=eq.approved&listed=eq.true&select=id');
      }
    }
    if (owner) {
      countUrl = SB("products?owner_student_id=eq."+encodeURIComponent(owner)+"&select=id");
      if (category) countUrl = SB("products?owner_student_id=eq."+encodeURIComponent(owner)+"&category=eq."+category+"&select=id");
    }
    const countR = await fetch(countUrl, { headers: SB_HEADERS });
    let countData = await countR.json();
    let total = Array.isArray(countData) ? countData.length : 0;

    // Get page
    let url = SB('products?order=pinned.desc,created_at.desc&select=*&limit='+pageSize+'&offset='+pageOffset);
    if (!admin) url = SB('products?status=eq.approved&listed=eq.true&order=pinned.desc,created_at.desc&select=*&limit='+pageSize+'&offset='+pageOffset);
    if (category && admin) url = SB('products?category=eq.'+category+'&order=pinned.desc,created_at.desc&select=*&limit='+pageSize+'&offset='+pageOffset);
    if (category && !admin) url = SB('products?category=eq.'+category+'&status=eq.approved&listed=eq.true&order=pinned.desc,created_at.desc&select=*&limit='+pageSize+'&offset='+pageOffset);
    if (school) {
      url = SB('products?school=eq.'+school+'&status=eq.approved&listed=eq.true&order=pinned.desc,created_at.desc&select=*&limit='+pageSize+'&offset='+pageOffset);
      if (category) url = SB('products?school=eq.'+school+'&category=eq.'+category+'&status=eq.approved&listed=eq.true&order=pinned.desc,created_at.desc&select=*&limit='+pageSize+'&offset='+pageOffset);
      if (admin) { url = SB('products?school=eq.'+school+'&order=pinned.desc,created_at.desc&select=*&limit='+pageSize+'&offset='+pageOffset); if(category) url = SB('products?school=eq.'+school+'&category=eq.'+category+'&order=pinned.desc,created_at.desc&select=*&limit='+pageSize+'&offset='+pageOffset); }
    }
    if (item_type && !admin) {
      if (school) {
        url = SB('products?item_type=eq.'+item_type+'&school=eq.'+school+'&status=eq.approved&listed=eq.true&order=pinned.desc,created_at.desc&select=*&limit='+pageSize+'&offset='+pageOffset);
        if (category) url = SB('products?item_type=eq.'+item_type+'&school=eq.'+school+'&category=eq.'+category+'&status=eq.approved&listed=eq.true&order=pinned.desc,created_at.desc&select=*&limit='+pageSize+'&offset='+pageOffset);
      } else {
        url = SB('products?item_type=eq.'+item_type+'&status=eq.approved&listed=eq.true&order=pinned.desc,created_at.desc&select=*&limit='+pageSize+'&offset='+pageOffset);
        if (category) url = SB('products?item_type=eq.'+item_type+'&category=eq.'+category+'&status=eq.approved&listed=eq.true&order=pinned.desc,created_at.desc&select=*&limit='+pageSize+'&offset='+pageOffset);
      }
    }
    if (owner) {
      url = SB("products?owner_student_id=eq."+encodeURIComponent(owner)+"&order=pinned.desc,created_at.desc&select=*&limit="+pageSize+"&offset="+pageOffset);
      if (category) url = SB("products?owner_student_id=eq."+encodeURIComponent(owner)+"&category=eq."+category+"&order=pinned.desc,created_at.desc&select=*&limit="+pageSize+"&offset="+pageOffset);
    }
    if (orderBy !== 'pinned.desc,created_at.desc') url = url.replace(/pinned\.desc,created_at\.desc/g, orderBy);
    var priceField = item_type === 'rent' ? 'rent_price' : 'price';
    if (price_min) { url += '&'+priceField+'=gte.'+price_min; countUrl += '&'+priceField+'=gte.'+price_min; }
    if (price_max) { url += '&'+priceField+'=lte.'+price_max; countUrl += '&'+priceField+'=lte.'+price_max; }
    const r = await fetch(url, { headers: SB_HEADERS });
    let data = await r.json();
    if (price_min) data = (Array.isArray(data) ? data : []).filter(function(p){ var v = (item_type === 'rent' ? parseFloat(p.rent_price) : parseFloat(p.price)); return !isNaN(v) && v >= parseFloat(price_min); });
    if (price_max) data = (Array.isArray(data) ? data : []).filter(function(p){ var v = (item_type === 'rent' ? parseFloat(p.rent_price) : parseFloat(p.price)); return !isNaN(v) && v <= parseFloat(price_max); });
    if (search) data = (Array.isArray(data) ? data : []).filter(p => p.title?.toLowerCase().includes(search.toLowerCase()));
    // Enrich with nicknames & gender
    if (Array.isArray(data) && data.length) {
      try {
        var nr = await fetch(SB('verifications?status=eq.approved&select=student_id,nickname,gender'), { headers: SB_HEADERS });
        var nd = await nr.json();
        var nmap = {}; var gmap = {};
        (Array.isArray(nd) ? nd : []).forEach(function(v){ if(v.student_id) { if(v.nickname) nmap[v.student_id] = v.nickname; if(v.gender) gmap[v.student_id] = v.gender; } });
        data.forEach(function(p){ if(p.owner_student_id) { if(nmap[p.owner_student_id]) p.owner_nickname = nmap[p.owner_student_id]; if(gmap[p.owner_student_id]) p.owner_gender = gmap[p.owner_student_id]; } });
      } catch(e) {}
    }
    // Strip images from list (performance — base64 too large), keep first as proxy URL for thumb
    if (Array.isArray(data)) data.forEach(function(p){
      if (p.images && p.images.length) {
        if (req.query.admin) p.images = p.images.map(function(img, idx){ return '/api/product-image/'+p.id+'/'+idx; });
        else p.images = ['/api/product-image/'+p.id+'/0'];
      } else delete p.images;
    });
    res.json({ data: Array.isArray(data) ? data : [], total, limit: pageSize, offset: pageOffset });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/marketplace/products/:id', async (req, res) => {
  try {
    const r = await fetch(SB('products?id=eq.'+req.params.id+'&select=*'), { headers: SB_HEADERS });
    const data = await r.json();
    var p = data[0] || null;
    if (p && p.owner_student_id) {
      try {
        var nr = await fetch(SB("verifications?status=eq.approved&select=student_id,nickname,gender&student_id=eq."+encodeURIComponent(p.owner_student_id)), { headers: SB_HEADERS });
        var nd = await nr.json();
        var nv = Array.isArray(nd) ? nd[0] : null;
        if (nv) { if (nv.nickname) p.owner_nickname = nv.nickname; if (nv.gender) p.owner_gender = nv.gender; }
      } catch(e) {}
    }
    // Convert base64 images to proxy URLs for performance
    if (p && Array.isArray(p.images)) {
      p.images = p.images.map(function(img, idx) { return '/api/product-image/' + p.id + '/' + idx; });
    }
    res.json(p);
  } catch(e) { res.status(500).json({ error: e.message }); }
});
// Serve product images as binary with in-memory + file cache
var IMG_CACHE_DIR = './cache/img/';
var imgMemCache = new Map();
try { require('fs').mkdirSync(IMG_CACHE_DIR, { recursive: true }); } catch(e) {}
app.get('/api/product-image/:id/:idx', async (req, res) => {
  try {
    const id = parseInt(req.params.id), idx = parseInt(req.params.idx);
    var cacheKey = id + '-' + idx;
    // Try in-memory cache (fastest, survives within session)
    if (imgMemCache.has(cacheKey)) {
      var entry = imgMemCache.get(cacheKey);
      res.setHeader('Content-Type', entry.type);
      res.setHeader('Cache-Control', 'public, max-age=604800');
      return res.send(entry.buf);
    }
    var cacheFile = IMG_CACHE_DIR + cacheKey + '.img';
    // Try file cache
    try {
      var buf = require('fs').readFileSync(cacheFile);
      var ext = require('fs').readFileSync(cacheFile + '.type', 'utf8');
      res.setHeader('Content-Type', 'image/' + ext);
      res.setHeader('Cache-Control', 'public, max-age=604800');
      return res.send(buf);
    } catch(e) {}
    // Fetch from DB
    const r = await fetch(SB('products?id=eq.'+id+'&select=images'), { headers: SB_HEADERS });
    const data = await r.json();
    const p = Array.isArray(data) ? data[0] : null;
    if (!p || !Array.isArray(p.images) || !p.images[idx]) return res.status(404).end();
    var img = p.images[idx];
    var match = img.match(/^data:image\/(\w+);base64,(.+)$/);
    if (!match) return res.redirect(img);
    var raw = Buffer.from(match[2], 'base64');
    var ext = match[1];
    // Serve raw decoded image immediately (fast), compress in background
    imgMemCache.set(cacheKey, { buf: raw, type: 'image/' + ext });
    try { require('fs').writeFileSync(cacheFile, raw); require('fs').writeFileSync(cacheFile+'.type', ext); } catch(e) {}
    res.setHeader('Content-Type', 'image/' + ext);
    res.setHeader('Cache-Control', 'public, max-age=604800');
    res.send(raw);
    // Background compress for next visit (fire-and-forget)
    sharp(raw).resize(800, 800, { fit: 'inside', withoutEnlargement: true }).jpeg({ quality: 70 }).toBuffer()
      .then(function(c) {
        imgMemCache.set(cacheKey, { buf: c, type: 'image/jpeg' });
        try { require('fs').writeFileSync(cacheFile, c); require('fs').writeFileSync(cacheFile+'.type', 'jpeg'); } catch(e) {}
      })
      .catch(function(){});
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ====== Reviews API ======
const REVIEW_TAGS = ['商品与描述一致', '沟通态度好', '准时到达', '商品完好', '价格合理', '交易顺利', '与描述不符', '沟通不愉快'];
app.post('/api/marketplace/reviews', express.json({ limit: '10mb' }), async (req, res) => {
  try {
    const { product_id, buyer_id, seller_id, tags, reason, images } = req.body;
    if (!product_id || !tags || !reason) return res.status(400).json({ error: '缺少必填字段' });
    await fetch(SB('reviews'), {
      method: 'POST', headers: { 'apikey': SUPABASE_KEY, 'Authorization': 'Bearer ' + SUPABASE_KEY, 'Content-Type': 'application/json' },
      body: JSON.stringify({ product_id, buyer_id, seller_id: seller_id||'', tags: tags||[], reason, images: images||[], created_at: new Date().toISOString() })
    });
    // Notify admin
    notifyAdmin('new_review', { product_id, tags });
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});
// Admin: list reviews
app.get('/api/admin/reviews', anyAdmin, async (req, res) => {
  try {
    const r = await fetch(SB('reviews?order=created_at.desc'), { headers: SB_HEADERS });
    const data = await r.json();
    res.json(Array.isArray(data) ? data : []);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ====== Messages API ======
function kefuId(school) { return 'kefu_' + (school || 'admin'); }
function isKefu(id) { return id && id.startsWith('kefu_'); }
app.get('/api/marketplace/messages', async (req, res) => {
  try {
    const { product_id, student_id, other_student_id, since_id } = req.query;
    var fields = 'id,product_id,from_student_id,from_name,to_student_id,to_name,content,read,created_at';
    // Two-participant chat: targeted query instead of full scan
    if (student_id && other_student_id) {
      var urlA = SB("messages?from_student_id=eq."+encodeURIComponent(student_id)+"&to_student_id=eq."+encodeURIComponent(other_student_id)+"&order=created_at.asc&select="+fields+(since_id?'&id=gt.'+since_id:''));
      var urlB = SB("messages?from_student_id=eq."+encodeURIComponent(other_student_id)+"&to_student_id=eq."+encodeURIComponent(student_id)+"&order=created_at.asc&select="+fields+(since_id?'&id=gt.'+since_id:''));
      var [rA,rB] = await Promise.all([fetch(urlA,{headers:SB_HEADERS}), fetch(urlB,{headers:SB_HEADERS})]);
      var [dA,dB] = await Promise.all([rA.json(), rB.json()]);
      var msgs = (Array.isArray(dA)?dA:[]).concat(Array.isArray(dB)?dB:[]);
      msgs.sort(function(a,b){ return new Date(a.created_at)-new Date(b.created_at); });
      return res.json(msgs);
    }
    var s = student_id || other_student_id;
    if (s) {
      var r = await fetch(SB("messages?or=(from_student_id.eq."+encodeURIComponent(s)+",to_student_id.eq."+encodeURIComponent(s)+")&order=created_at.asc&select="+fields+(since_id?'&id=gt.'+since_id:'')), { headers: SB_HEADERS });
      return res.json(await r.json());
    }
    if (product_id) {
      var r = await fetch(SB('messages?product_id=eq.'+product_id+'&order=created_at.asc&select='+fields+(since_id?'&id=gt.'+since_id:'')), { headers: SB_HEADERS });
      return res.json(await r.json());
    }
    res.json([]);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// Get unique contacts for a user
app.get('/api/marketplace/contacts', async (req, res) => {
  try {
    const { student_id, school } = req.query;
    if (!student_id) return res.json([]);
    const r = await fetch(SB("messages?or=(from_student_id.eq."+encodeURIComponent(student_id)+",to_student_id.eq."+encodeURIComponent(student_id)+")&order=created_at.desc&select=id,product_id,from_student_id,from_name,to_student_id,to_name,content,read,created_at"), { headers: SB_HEADERS });
    let data = await r.json();
    let arr = Array.isArray(data) ? data : [];
    let seen = {}, contacts = [];
    arr.forEach(function(m) {
      var otherId = m.from_student_id === student_id ? m.to_student_id : m.from_student_id;
      var otherName = m.from_student_id === student_id ? m.to_name : m.from_name;
      if (!otherId) return;
      if (!seen[otherId]) {
        seen[otherId] = { name: otherName || otherId, product_id: m.product_id, unread: 0, last_time: m.created_at, last_message: m.content, products: [] };
      }
      if (m.product_id && !seen[otherId].products.includes(m.product_id)) seen[otherId].products.push(m.product_id);
      if (new Date(m.created_at) > new Date(seen[otherId].last_time)) {
        seen[otherId].last_time = m.created_at;
        seen[otherId].last_message = m.content;
        seen[otherId].product_id = m.product_id;
      }
      if (m.to_student_id === student_id && !m.read) seen[otherId].unread++;
      // Try to improve name from any message (skip for kefu)
      if (!isKefu(otherId)) {
        var nameCandidate = m.from_student_id === student_id ? m.to_name : m.from_name;
        if (nameCandidate && nameCandidate.length > 0 && nameCandidate !== seen[otherId].name && !nameCandidate.match(/^\d+$/)) {
          seen[otherId].name = nameCandidate;
        }
      }
    });
    contacts = Object.keys(seen).map(function(k) {
      return { student_id: k, name: seen[k].name, unread: seen[k].unread, last_message: seen[k].last_message, last_time: seen[k].last_time, product_id: seen[k].product_id, products: seen[k].products };
    });
    if (isKefu(student_id)) {
      contacts = contacts.filter(function(c) { return !isKefu(c.student_id); });
    } else {
      contacts = contacts.filter(function(c) { return c.student_id !== student_id && !isKefu(c.student_id); });
      // Look up user's school to add their school's kefu
      try {
        var uR = await fetch(SB("verifications?student_id=eq."+encodeURIComponent(student_id)+"&select=school"), { headers: SB_HEADERS });
        var uData = await uR.json();
        var uSchool = (Array.isArray(uData) && uData[0]) ? uData[0].school : (school || '');
        if (uSchool) { var kName = uSchool; SCHOOL_ADMINS.forEach(function(sa) { if (sa.code === uSchool) kName = sa.name; });
          var ku = kefuId(uSchool);
          var kn = kName + '二豆客服';
          var kunread = 0, kmsg = '你好，有什么可以帮你的？';
          try {
            var kr = await fetch(SB("messages?from_student_id=eq."+encodeURIComponent(ku)+"&to_student_id=eq."+encodeURIComponent(student_id)+"&order=created_at.desc&limit=1"), { headers: SB_HEADERS });
            var kd = await kr.json();
            if (Array.isArray(kd) && kd.length) { kmsg = kd[0].content||kmsg; }
          } catch(e) {}
          try {
            var kr2 = await fetch(SB("messages?from_student_id=eq."+encodeURIComponent(ku)+"&to_student_id=eq."+encodeURIComponent(student_id)+"&read=eq.false&select=id"), { headers: SB_HEADERS });
            var kd2 = await kr2.json();
            kunread = Array.isArray(kd2) ? kd2.length : 0;
          } catch(e) {}
          contacts.unshift({ student_id: ku, name: kn, unread: kunread, last_message: kmsg, last_time: null, product_id: 0 });
        }
      } catch(e) {}
    }
    // Filter by school if requested
    if (school && contacts.length) {
      try {
        var ids = contacts.map(function(c) { return encodeURIComponent(c.student_id); }).join(',');
        var vR = await fetch(SB("verifications?student_id=in.("+ids+")&select=student_id,school"), { headers: SB_HEADERS });
        var vData = await vR.json();
        if (Array.isArray(vData)) {
          var schoolMap = {};
          vData.forEach(function(v) { schoolMap[v.student_id] = v.school; });
          contacts = contacts.filter(function(c) { return c.student_id === kefuId(school) || schoolMap[c.student_id] === school; });
        }
      } catch(e) {}
    }
    res.json(contacts);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/marketplace/messages', express.json(), async (req, res) => {
  try {
    let { product_id, from_student_id, from_name, to_student_id, to_name, content } = req.body;
    if (!from_student_id || !content) return res.status(400).json({ error: 'missing fields' });
    // Check muted — muted users cannot send messages but can publish products
    try {
      var muteChk = await fetch(SB("verifications?student_id=eq."+encodeURIComponent(from_student_id)+"&status=eq.muted&select=id"), { headers: SB_HEADERS });
      var muteData = await muteChk.json();
      if (Array.isArray(muteData) && muteData.length) return res.status(403).json({ error: '账号已禁言，无法发送消息' });
    } catch(e) {}
    if (product_id === undefined || product_id === null) {
      if (isKefu(to_student_id) || isKefu(from_student_id)) product_id = 0;
      else return res.status(400).json({ error: 'product_id required' });
    }
    const r = await fetch(SB('messages'), {
      method: 'POST', headers: { 'apikey': SUPABASE_KEY, 'Authorization': 'Bearer ' + SUPABASE_KEY, 'Content-Type': 'application/json', 'Prefer': 'return=representation' },
      body: JSON.stringify({ product_id, from_student_id, from_name: from_name||'', to_student_id: to_student_id||'', to_name: to_name||'', content, read: false })
    });
    const t = await r.json();
    // Broadcast via WebSocket for instant delivery
    try {
      var msgData = JSON.stringify({ type: 'chat', data: { id: t.id, product_id, from_student_id: from_student_id, from_name: from_name||'', to_student_id: to_student_id||'', content: content, created_at: t.created_at||new Date().toISOString() } });
      wss.clients.forEach(function(ws) {
        if (ws.readyState === 1) {
          try { ws.send(msgData); } catch(e) {}
        }
      });
    } catch(e) {}
    res.json(t);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/marketplace/messages/read', express.json(), async (req, res) => {
  try {
    const { product_id, student_id, from_student_id } = req.body;
    let readUrl = SB('messages?to_student_id=eq.'+student_id+'&read=eq.false');
    if (from_student_id) readUrl = SB('messages?to_student_id=eq.'+student_id+'&from_student_id=eq.'+from_student_id+'&read=eq.false');
    else if (product_id) readUrl = SB('messages?product_id=eq.'+product_id+'&to_student_id=eq.'+student_id);
    await fetch(readUrl, { method: 'PATCH', headers: SB_HEADERS2, body: JSON.stringify({ read: true }) });
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ====== Account Check API ======
app.get('/api/marketplace/check-account', async (req, res) => {
  try {
    const { student_id } = req.query;
    if (!student_id) return res.json({ ok: false });
    const r = await fetch(SB("verifications?student_id=eq."+encodeURIComponent(student_id)+"&select=id,status"), { headers: SB_HEADERS });
    const data = await r.json();
    const arr = Array.isArray(data) ? data : [];
    const valid = arr.some(function(v) { return v.status === 'approved'; });
    res.json({ ok: valid });
  } catch(e) { res.json({ ok: false }); }
});

app.get('/api/marketplace/check-session', async (req, res) => {
  try {
    const { student_id, token } = req.query;
    if (!student_id) return res.json({ ok: false });
    const r = await fetch(SB("verifications?student_id=eq."+encodeURIComponent(student_id)+"&select=login_token"), { headers: SB_HEADERS });
    const data = await r.json();
    const arr = Array.isArray(data) ? data : [];
    if (arr.length && arr[0].login_token) {
      return res.json({ ok: arr[0].login_token === token });
    }
    res.json({ ok: false });
  } catch(e) { res.json({ ok: false }); }
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

const WALL_ADMIN_PASSWORD = process.env.WALL_ADMIN_PASSWORD;
var wallAdminTokens = new Set();
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'x130977889X';
const MANAGER_PASSWORD = process.env.MANAGER_PASSWORD || 'manager123';
const JWT_SECRET = process.env.JWT_SECRET || 'paywall-default-jwt-secret-2024';
let SCHOOL_ADMINS = [];
try { SCHOOL_ADMINS = JSON.parse(process.env.SCHOOL_ADMINS || '[]'); } catch(e) {}
function signToken(payload) {
  var header = Buffer.from(JSON.stringify({alg:'HS256',typ:'JWT'})).toString('base64url');
  var body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  var sig = createHmac('sha256', JWT_SECRET).update(header+'.'+body).digest('base64url');
  return header+'.'+body+'.'+sig;
}

function verifyToken(token) {
  try {
    var parts = token.split('.');
    if (parts.length !== 3) return null;
    var sig = createHmac('sha256', JWT_SECRET).update(parts[0]+'.'+parts[1]).digest('base64url');
    if (sig !== parts[2]) return null;
    var payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString());
    if (payload.exp && Date.now() > payload.exp) return null;
    return payload;
  } catch(e) { return null; }
}

app.post('/api/admin/login', express.json(), (req, res) => {
  const { password } = req.body;
  let role = null, school = null, schoolName = null;

  var sa = SCHOOL_ADMINS.find(function(s) { return s.password === password; });
  if (sa) { role = 'school_admin'; school = sa.code; schoolName = sa.name; }
  else if (password === ADMIN_PASSWORD) role = 'admin';
  else if (password === MANAGER_PASSWORD) role = 'manager';
  if (!role) return res.json({ ok: false, msg: '密码错误' });

  var tokenHours = parseInt(process.env.TOKEN_EXPIRY_HOURS) || 12;
  var token = signToken({ role, school, schoolName, exp: Date.now() + tokenHours * 3600000 });
  res.json({ ok: true, token, role, school, schoolName, schools: role === 'admin' ? SCHOOL_ADMINS : undefined });
});

function getAdminSession(req) {
  const auth = req.headers.authorization;
  if (!auth || !auth.startsWith('Bearer ')) return null;
  return verifyToken(auth.slice(7));
}

function anyAdmin(req, res, next) {
  const sess = getAdminSession(req);
  if (!sess) return res.status(401).json({ ok: false, msg: '未授权' });
  req.adminRole = sess.role;
  req.adminSchool = sess.school;
  req.adminSchoolName = sess.schoolName;
  next();
}

function wallScope(req, res, next) {
  const auth = req.headers.authorization;
  if (auth && auth.startsWith("Bearer ") && wallAdminTokens.has(auth.slice(7))) { req.adminRole = "wall_admin"; return next(); }
  const sess = getAdminSession(req);
  if (!sess) return res.status(401).json({ ok: false, msg: "未授权" });
  req.adminRole = sess.role;
  req.adminSchool = sess.school || req.query.school || null;
  next();
}

function schoolScope(req, res, next) {
  const sess = getAdminSession(req);
  if (!sess) return res.status(401).json({ ok: false, msg: '未授权' });
  req.adminRole = sess.role;
  // Super admin uses ?school= param; school admin locked to their school
  req.adminSchool = sess.school || req.query.school || null;
  req.adminSchoolName = sess.schoolName;
  if (sess.role === 'school_admin' && !sess.school) return res.status(403).json({ ok: false, msg: '无学校权限' });
  next();
}

function fullAdmin(req, res, next) {
  const sess = getAdminSession(req);
  if (!sess) return res.status(401).json({ ok: false, msg: '未授权' });
  if (sess.role !== 'admin') return res.status(403).json({ ok: false, msg: '无权限' });
  req.adminRole = sess.role;
  next();
}

// Helper: add school filter to Supabase URL if applicable
function addSchoolFilter(url, req) {
  var school = req.adminSchool || req.query.school;
  if (school) url += '&school=eq.' + encodeURIComponent(school);
  return url;
}

// ====== Transactions API ======
app.get('/api/marketplace/transactions', schoolScope, async (req, res) => {
  try {
    var sf = req.adminSchool ? '&school=eq.'+req.adminSchool : '';
    const r = await fetch(SB('products?payment_status=in.(pending,paid)&select=id,title,price,owner_name,owner_student_id,trade_buyer_name,trade_buyer_id,trade_status,payment_status,created_at,school'+sf+'&order=created_at.desc'), { headers: SB_HEADERS });
    let data = await r.json();
    res.json(Array.isArray(data) ? data : []);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/marketplace/transactions/pay', schoolScope, express.json(), async (req, res) => {
  try {
    const { id, status } = req.body;
    if (!id) return res.status(400).json({ error: 'id required' });
    await fetch(SB('products?id=eq.'+id), { method: 'PATCH', headers: SB_HEADERS2, body: JSON.stringify({ payment_status: status || 'paid' }) });
    addLog('transaction_pay', 'product', id, status||'paid');
    // Notify seller of payment
    try {
      var pr = await fetch(SB('products?id=eq.'+id+'&select=id,title,owner_student_id'), { headers: SB_HEADERS });
      var pd = await pr.json();
      var prod = Array.isArray(pd) ? pd[0] : null;
      if (prod && prod.owner_student_id) {
        await fetch(SB('messages'), {
          method: 'POST', headers: { 'apikey': SUPABASE_KEY, 'Authorization': 'Bearer '+SUPABASE_KEY, 'Content-Type': 'application/json', 'Prefer': 'return=representation' },
          body: JSON.stringify({ product_id: id, from_student_id: 'system', from_name: '系统通知', to_student_id: prod.owner_student_id, content: '💰 您售出的商品「'+prod.title+'」的款项已到账，请查看账户余额。', created_at: new Date().toISOString(), read: false })
        });
      }
    } catch(e) {}
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

const PORT = process.env.PORT || 3456;

// ====== WebSocket Server ======
const server = http.createServer(app);
const wss = new WebSocketServer({ server });
const onlineUsers = new Map();
const adminConns = new Set();

function notifyAdmin(event, data) {
  const msg = JSON.stringify({ type: 'admin_' + event, data: data || {} });
  adminConns.forEach(ws => { try { ws.send(msg); } catch(e) {} });
}

wss.on('connection', (ws, req) => {
  let userId = null;
  let isAdmin = false;
  ws.on('message', async (raw) => {
    try {
      if (!raw || !raw.toString().trim()) return;
      var rawStr = (raw && raw.toString && raw.toString().trim()) || '';
      if (!rawStr || rawStr === 'undefined' || rawStr === 'null') return;
      const msg = JSON.parse(rawStr);
      if (msg.type === 'auth' && msg.student_id) {
        userId = msg.student_id;
        onlineUsers.set(userId, ws);
        ws.send(JSON.stringify({ type: 'auth_ok', student_id: userId }));
        return;
      }
      if (msg.type === 'admin_auth' && verifyToken(msg.token)) {
        isAdmin = true;
        adminConns.add(ws);
        ws.send(JSON.stringify({ type: 'admin_auth_ok' }));
        return;
      }
      if (msg.type === 'ai_chat' && msg.messages) {
        const model = msg.model || 'deepseek-chat';
        const provider = getProvider(model);
        const apiKey = API_KEYS[provider];
        if (!apiKey) { ws.send(JSON.stringify({ type: 'ai_error', error: provider + ' key not configured' })); return; }
        const baseUrl = PROXY_BASE[provider];
        const upstreamModel = mapModel(provider, model);
        try {
          const r = await fetch(baseUrl + '/chat/completions', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + apiKey },
            body: JSON.stringify({ model: upstreamModel, messages: msg.messages, stream: true, max_tokens: msg.max_tokens||4096 })
          });
          if (!r.ok) { ws.send(JSON.stringify({ type: 'ai_error', error: 'upstream error' })); return; }
          const reader = r.body.getReader();
          const decoder = new TextDecoder();
          let fullText = '';
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            const chunk = decoder.decode(value);
            const lines = chunk.split('\n').filter(l => l.startsWith('data: ') && l !== 'data: [DONE]');
            for (const line of lines) {
              try {
                const d = JSON.parse(line.slice(6));
                if (d.choices?.[0]?.delta?.content) {
                  const token = d.choices[0].delta.content;
                  fullText += token;
                  ws.send(JSON.stringify({ type: 'ai_token', token }));
                }
                if (d.usage) await trackAI(model, d.usage.total_tokens);
              } catch(e) {}
            }
          }
          ws.send(JSON.stringify({ type: 'ai_done', fullText }));
          if (fullText) await trackAI(model, Math.ceil(fullText.length / 2));
        } catch(e) { ws.send(JSON.stringify({ type: 'ai_error', error: e.message })); }
        return;
      }
      if (msg.type === 'chat' && msg.product_id && msg.content && userId) {
        const r = await fetch(SB('messages'), {
          method: 'POST', headers: { 'apikey': SUPABASE_KEY, 'Authorization': 'Bearer ' + SUPABASE_KEY, 'Content-Type': 'application/json', 'Prefer': 'return=representation' },
          body: JSON.stringify({ product_id: msg.product_id, from_student_id: userId, from_name: msg.from_name||'', to_student_id: msg.to_student_id||'', to_name: msg.to_name||'', content: msg.content, read: false })
        });
        const saved = await r.json();
        const msgData = { type: 'chat', data: saved };
        if (msg.to_student_id && onlineUsers.has(msg.to_student_id)) {
          onlineUsers.get(msg.to_student_id).send(JSON.stringify(msgData));
        }
        ws.send(JSON.stringify(msgData));
      }
    } catch(e) { console.error('ws error:', e.message); }
  });
  ws.on('close', () => {
    if (userId) onlineUsers.delete(userId);
    if (isAdmin) adminConns.delete(ws);
  });
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`✅ 付费验证服务已启动: http://0.0.0.0:${PORT}`);
  console.log(`📊 管理后台: http://localhost:${PORT}/admin.html`);
  console.log(`💬 WebSocket 已启动`);
});
// force redeploy Tue Jun 23 15:09:58     2026
