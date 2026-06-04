// Deno Deploy 入口文件
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

const kv = await Deno.openKv();

async function handler(req: Request): Promise<Response> {
  const url = new URL(req.url);
  const path = url.pathname;

  if (req.method === "OPTIONS") return cors(null, 204);

  // 验证密码
  if (req.method === "POST" && path === "/api/verify") {
    const { code } = await req.json();
    if (!code) return cors({ ok: false, msg: "请输入密码" });

    const key = ["pwd", code];
    const res = await kv.get(key);
    if (!res.value) return cors({ ok: false, msg: "密码错误" });

    const pwd = res.value as { code: string; used: boolean; label?: string };
    if (pwd.used) return cors({ ok: false, msg: "该密码已被使用" });

    pwd.used = true;
    await kv.set(key, pwd);
    return cors({ ok: true });
  }

  // 统计
  if (req.method === "GET" && path === "/api/stats") {
    let total = 0, used = 0;
    const iter = kv.list({ prefix: ["pwd"] });
    for await (const entry of iter) {
      total++;
      const val = entry.value as { used?: boolean };
      if (val.used) used++;
    }
    return cors({ totalPwd: total, usedPwd: used, revenue: used * 0.99 });
  }

  // 生成密码
  if (req.method === "POST" && path === "/api/passwords") {
    const { count = 1, label = "" } = await req.json();
    const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
    const codes: string[] = [];
    for (let i = 0; i < count; i++) {
      let code = "";
      for (let j = 0; j < 8; j++) code += chars[Math.floor(Math.random() * chars.length)];
      const key = ["pwd", code];
      const exist = await kv.get(key);
      if (!exist.value) {
        await kv.set(key, { code, label, used: false, created_at: new Date().toISOString() });
        codes.push(code);
      } else i--;
    }
    return cors({ ok: true, count: codes.length, codes });
  }

  return cors({ error: "Not found" }, 404);
}

serve(handler);
