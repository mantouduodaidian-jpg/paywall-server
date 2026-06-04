// Deno Deploy 入口 - 使用 Deno.serve 原生 API
const cors = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
    },
  });

// 内存存储（每次部署重启会重置，适合演示）
// 生产环境需要接入 KV 数据库
const store = new Map<string, { code: string; label: string; used: boolean; used_at?: string; created_at: string }>();

Deno.serve((req: Request) => {
  const url = new URL(req.url);
  const path = url.pathname;

  if (req.method === "OPTIONS") return cors(null, 204);

  // 验证密码
  if (req.method === "POST" && path === "/api/verify") {
    return req.json().then(({ code }) => {
      if (!code) return cors({ ok: false, msg: "请输入密码" });
      const pwd = store.get(code);
      if (!pwd) return cors({ ok: false, msg: "密码错误" });
      if (pwd.used) return cors({ ok: false, msg: "该密码已被使用" });
      pwd.used = true;
      pwd.used_at = new Date().toISOString();
      store.set(code, pwd);
      return cors({ ok: true });
    });
  }

  // 统计
  if (req.method === "GET" && path === "/api/stats") {
    let total = 0, used = 0;
    for (const val of store.values()) {
      total++;
      if (val.used) used++;
    }
    return cors({ totalPwd: total, usedPwd: used, revenue: used * 0.99 });
  }

  // 生成密码
  if (req.method === "POST" && path === "/api/passwords") {
    return req.json().then(({ count = 1, label = "" }) => {
      const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
      const codes: string[] = [];
      for (let i = 0; i < count; i++) {
        let code = "";
        for (let j = 0; j < 8; j++) code += chars[Math.floor(Math.random() * chars.length)];
        if (!store.has(code)) {
          store.set(code, { code, label, used: false, created_at: new Date().toISOString() });
          codes.push(code);
        } else i--;
      }
      return cors({ ok: true, count: codes.length, codes });
    });
  }

  return cors({ error: "Not found" }, 404);
});
