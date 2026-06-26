# 部署前检查清单

> AI 可读。改代码前先读此文件。

## 1. 语法检查

```bash
node --check server.js                     # 后端 JS 编译
grep -o '{' public/market.html | wc -l     # 数 {
grep -o '}' public/market.html | wc -l     # 数 }，必须相等
grep -o '{' public/admin-market.html | wc -l
grep -o '}' public/admin-market.html | wc -l
grep -o '(' server.js | wc -l              # 数 (
grep -o ')' server.js | wc -l              # 数 )，必须相等
```

## 2. 备份

```bash
cp public/market.html public/market.html.bak
cp public/admin-market.html public/admin-market.html.bak
cp server.js server.js.bak
```

## 3. 前端编码规则

| 场景 | 不要 | 要 |
|------|------|----|
| 判断状态 | `style.background.includes('color')` | JS 变量 `var _pubType` |
| 数值字段 | `price: parseFloat(price)` | `price: parseFloat(price) \|\| 0` |
| 重复 API | 每条消息调 `/api/xxx` | 缓存 `_nickCache` |
| 前后端校验 | 各写各的 | 前后端规则一致 |

## 4. HTML 陷阱

- 每个 `<div>` 必须有 `</div>`，缺一个后面全炸
- 浏览器按 tag 顺序解析 DOM，不按缩进
- `<div>` 不自动闭合，忘记 `</div>` 会让后续元素变成子级
- 分批隔离法：工作 vs 不工作找分界线排查

## 5. 后端规则

- 环境变量不写死，用 `process.env.XXX`
- 每个 API handler 包 try/catch
- 先验参数再查库
- 数值字段 normalize：`parseFloat(x) || 0`

## 6. 推送

```bash
git add .
git commit -m "fix|feat|perf: 描述"
git push origin master
# Render 自动部署，等约 2 分钟
```

## 7. 验证

- [ ] 刷新页面看控制台有无报红
- [ ] Network 请求有无 4xx/5xx
- [ ] 功能走一遍
