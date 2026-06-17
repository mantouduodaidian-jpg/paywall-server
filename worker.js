// Cloudflare Worker - 免费计划每天10万次请求
// 部署：复制这段代码到 https://workers.cloudflare.com

// 简易 KV 存储（使用 Cloudflare KV 命名空间）
// 先在 Cloudflare Dashboard 创建 KV 命名空间 "PWD_STORE"
// 然后在 worker 设置中绑定

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname;
    const cors = { headers: { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'GET,POST,OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type' } };

    if (request.method === 'OPTIONS') return new Response(null, { status: 200, ...cors });

    // 验证密码
    if (request.method === 'POST' && path === '/api/verify') {
      const { code } = await request.json();
      if (!code) return new Response(JSON.stringify({ ok: false, msg: '请输入密码' }), cors);

      const key = `pwd:${code}`;
      const val = await env.PWD_STORE.get(key);
      if (!val) return new Response(JSON.stringify({ ok: false, msg: '密码错误' }), cors);

      const pwd = JSON.parse(val);
      if (pwd.used) return new Response(JSON.stringify({ ok: false, msg: '该密码已被使用' }), cors);

      pwd.used = true;
      pwd.used_at = new Date().toISOString();
      await env.PWD_STORE.put(key, JSON.stringify(pwd));

      return new Response(JSON.stringify({ ok: true }), cors);
    }

    // 统计
    if (request.method === 'GET' && path === '/api/stats') {
      const list = await env.PWD_STORE.list({ prefix: 'pwd:' });
      let total = 0, used = 0;
      for (const key of list.keys) {
        total++;
        const val = await env.PWD_STORE.get(key.name);
        if (val) { const p = JSON.parse(val); if (p.used) used++; }
      }
      return new Response(JSON.stringify({ totalPwd: total, usedPwd: used, revenue: used * 0.99 }), cors);
    }

    return new Response('Not found', { status: 404 });
  }
};
