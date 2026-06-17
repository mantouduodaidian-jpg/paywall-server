// Deno Deploy 多产品付费验证服务
const cors = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
    },
  });

const kv = await Deno.openKv();
const CHARS = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

// 会话存储（内存，Deno Deploy 重启会丢失，但影响不大）
const sessions = new Map<string, { createdAt: number; product_id: number }>();
const SESSION_TTL = 24 * 60 * 60 * 1000;

async function handler(req: Request): Promise<Response> {
  const url = new URL(req.url);
  const path = url.pathname;
  if (req.method === "OPTIONS") return cors(null, 204);

  // ===== 产品列表 =====
  if (req.method === "GET" && path === "/api/products") {
    const p1 = await kv.get(["product", 1]);
    const p2 = await kv.get(["product", 2]);
    const products: Array<{ id: number; name: string; price: number; desc_text: string }> = [];
    if (p1.value) products.push({ id: 1, name: "光纤通信复习题库", price: 0.99, desc_text: "" });
    else products.push({ id: 1, name: "光纤通信复习题库", price: 0.99, desc_text: "" });
    if (p2.value) products.push({ id: 2, name: "数字信号处理复习题库", price: 0.99, desc_text: "" });
    else products.push({ id: 2, name: "数字信号处理复习题库", price: 0.99, desc_text: "" });
    return cors(products);
  }

  // ===== 生成密码 =====
  if (req.method === "POST" && path === "/api/passwords") {
    const { count = 1, label = "", product_id = 1 } = await req.json();
    const codes: string[] = [];
    for (let i = 0; i < count; i++) {
      let code = "";
      for (let j = 0; j < 8; j++) code += CHARS[Math.floor(Math.random() * CHARS.length)];
      const key = ["pwd", product_id, code];
      const exist = await kv.get(key);
      if (!exist.value) {
        await kv.set(key, { code, label, product_id, used: false, created_at: new Date().toISOString() });
        codes.push(code);
      } else i--;
    }
    return cors({ ok: true, count: codes.length, codes });
  }

  // ===== 密码列表 =====
  if (req.method === "GET" && path === "/api/passwords") {
    const product_id = parseInt(url.searchParams.get("product_id") || "0");
    const iter = kv.list<string>({ prefix: ["pwd"] });
    const list: Array<Record<string, unknown>> = [];
    for await (const entry of iter) {
      const p = entry.value as Record<string, unknown>;
      if (!product_id || p.product_id === product_id) list.push(p);
    }
    list.sort((a, b) => String(b.created_at || "").localeCompare(String(a.created_at || "")));
    return cors(list);
  }

  // ===== 删除密码 =====
  if (req.method === "DELETE" && path.startsWith("/api/passwords/used/all")) {
    const iter = kv.list({ prefix: ["pwd"] });
    for await (const entry of iter) {
      const p = entry.value as { used?: boolean };
      if (p.used) await kv.delete(entry.key);
    }
    return cors({ ok: true });
  }

  if (req.method === "DELETE" && /^\/api\/passwords\/(\d+)$/.test(path)) {
    const id = parseInt(path.split("/").pop()!);
    const iter = kv.list({ prefix: ["pwd"] });
    for await (const entry of iter) {
      const p = entry.value as { id?: number; used?: boolean };
      if (p.id === id && !p.used) { await kv.delete(entry.key); break; }
    }
    return cors({ ok: true });
  }

  // ===== 验证密码 =====
  if (req.method === "POST" && path === "/api/verify") {
    const { code } = await req.json();
    if (!code) return cors({ ok: false, msg: "请输入密码" });

    const iter = kv.list({ prefix: ["pwd"] });
    let found = null;
    for await (const entry of iter) {
      const p = entry.value as Record<string, unknown>;
      if (p.code === code) { found = { ...p, key: entry.key }; break; }
    }
    if (!found) return cors({ ok: false, msg: "密码错误" });
    if (found.used) return cors({ ok: false, msg: "该密码已被使用" });

    found.used = true;
    await kv.set(found.key, found);

    const token = crypto.randomUUID();
    sessions.set(token, { createdAt: Date.now(), product_id: found.product_id as number });
    return cors({ ok: true, product_name: found.product_id === 1 ? "光纤通信复习题库" : "数字信号处理复习题库", product_id: found.product_id, token });
  }

  // ===== 验证会话 =====
  if (req.method === "POST" && path === "/api/verify-session") {
    const { token } = await req.json();
    if (!token) return cors({ ok: false });
    const sess = sessions.get(token);
    if (!sess || Date.now() - sess.createdAt > SESSION_TTL) {
      if (sess) sessions.delete(token);
      return cors({ ok: false });
    }
    return cors({ ok: true, product_id: sess.product_id });
  }

  // ===== 统计 =====
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

  return cors({ error: "Not found" }, 404);
}

serve(handler);
