// Deno Deploy - 内存存储（稳定版）
const store = new Map();

const cors = (data, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
    },
  });

Deno.serve(async (req) => {
  const url = new URL(req.url);
  const path = url.pathname;
  if (req.method === "OPTIONS") return cors(null, 204);

  if (req.method === "POST" && path === "/api/verify") {
    const { code } = await req.json();
    if (!code) return cors({ ok: false, msg: "请输入密码" });
    const pwd = store.get(code);
    if (!pwd) return cors({ ok: false, msg: "密码错误" });
    if (pwd.used) return cors({ ok: false, msg: "该密码已被使用" });
    pwd.used = true;
    store.set(code, pwd);
    return cors({ ok: true });
  }

  if (req.method === "GET" && path === "/api/stats") {
    let total = 0, used = 0;
    for (const val of store.values()) { total++; if (val.used) used++; }
    return cors({ totalPwd: total, usedPwd: used, revenue: used * 0.99 });
  }

  if (req.method === "GET" && path === "/api/passwords") {
    const list = [];
    for (const val of store.values()) list.push(val);
    return cors(list.sort((a, b) => (b.created_at || "").localeCompare(a.created_at || "")));
  }

  if (req.method === "POST" && path === "/api/passwords") {
    const { count = 1, label = "" } = await req.json();
    const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
    const codes = [];
    for (let i = 0; i < count; i++) {
      let code = "";
      for (let j = 0; j < 8; j++) code += chars[Math.floor(Math.random() * chars.length)];
      if (!store.has(code)) {
        store.set(code, { code, label, used: false, created_at: new Date().toISOString() });
        codes.push(code);
      } else i--;
    }
    return cors({ ok: true, count: codes.length, codes });
  }

  return cors({ error: "Not found" }, 404);
});
