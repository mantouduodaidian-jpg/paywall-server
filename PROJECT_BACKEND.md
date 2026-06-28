# 二豆 · 校园二手交易平台 — 后端文档

## 部署信息

| 项目 | 值 |
|------|-----|
| 域名 | https://paywall-server.onrender.com |
| 仓库 | https://github.com/mantouduodaidian-jpg/paywall-server |
| 数据库 | Supabase: hcinnimptpsjocbkkbna.supabase.co |
| 自动部署 | GitHub push → Render 自动部署（约 2 分钟） |

## 启动

```bash
node server.js
# 默认端口 3456
```

## 权限体系

| 角色 | 标识 | 说明 |
|------|------|------|
| 超管 | `admin` | 密码 ADMIN_PASSWORD 环境变量，全部权限 |
| 学校管理员 | `school_admin` | SCHOOL_ADMINS 环境变量定义，仅自己学校 |
| 普通用户 | 无 | 通过 `market.html` 登录，非 admin |

### 中间件

- `schoolScope`: 验证 admin token，设置 `req.adminSchool`
- `fullAdmin`: 仅超管可用
- `anyAdmin`: 任何 admin 角色可用（含废弃的 manager）

### 鉴权方式

admin 通过 `POST /api/admin/login` 获取 token，后续请求 `Authorization: Bearer <token>`。

## 文件结构

```
server.js                     # 所有后端逻辑（~1900 行单文件）
├── AI Chat API (行 1-50)
├── SQLite 数据库（行 27-40，闲置）
├── Supabase 配置（行 ~100-300）
├── Admin 登录（行 ~300-400）
├── 各 API 路由（行 400-1800）
│   ├── marketplace/     # 商品/分类/公告/敏感词等
│   ├── verify/          # 认证（学生证/收款码）
│   ├── trade/           # 交易流程
│   └── messages/        # 聊天消息
└── WebSocket 服务器（行 1820-1920）
public/
├── market.html           # 前台（单页应用）
└── admin-market.html     # 管理后台
```

## API 端点

### 公开（无需 admin 登录）

| 端点 | 说明 |
|------|------|
| `GET /api/marketplace/products` | 商品列表 |
| `GET /api/marketplace/products/:id` | 商品详情 |
| `GET /api/marketplace/categories` | 分类列表 |
| `GET /api/marketplace/announcements` | 公告 |
| `GET /api/marketplace/promotions` | 周边有礼 |
| `GET /api/marketplace/nicknames` | 昵称映射 `{student_id: nickname}` |
| `POST /api/marketplace/login` | 登录/注册（二合一） |
| `POST /api/marketplace/phone-login` | 游客手机登录 |
| `POST /api/marketplace/messages` | 发送消息 |
| `GET /api/marketplace/messages` | 获取消息 |
| `POST /api/marketplace/trade/*` | 交易流程（request/confirm/cancel/buyer-confirm） |
| `POST /api/marketplace/products` | 发布商品 |
| `POST /api/marketplace/reports` | 提交举报 |

### 需要 admin 登录（schoolScope）

| 端点 | 说明 |
|------|------|
| `POST /api/admin/login` | admin 登录 |
| `GET /api/marketplace/admin/stats` | 概览统计 |
| `PATCH /api/marketplace/products/:id` | 审核/上下架商品 |
| `DELETE /api/marketplace/products/:id` | 删除商品 |
| `GET /api/verify/list` | 认证列表 |
| `POST /api/verify/approve` | 通过认证 |
| `POST /api/verify/reject` | 拒绝认证 |
| `DELETE /api/verify/:id` | 删除认证 |
| `POST /api/marketplace/announcements` | 发布公告 |
| `GET/POST/DELETE /api/marketplace/blocked-words` | 敏感词管理 |
| `GET /api/marketplace/logs` | 操作日志 |
| `POST /api/marketplace/transactions/pay` | 确认转账 |
| `GET /api/marketplace/export/:type` | CSV 导出 |

## Supabase 表

| 表名 | 学校字段 | 说明 |
|------|---------|------|
| `products` | `school` | 商品 |
| `verifications` | `school` | 学生认证 |
| `messages` | `school` | 聊天消息 |
| `announcements` | `school` | 公告 |
| `promotions` | `school` | 周边有礼 |
| `reports` | `school` | 举报 |
| `logs` | 无 | 操作日志 |
| `blocked_words` | `school` | 敏感词 |
| `categories` | 无 | 分类 |
| `chat_alerts` | 无 | 聊天预警 |

所有业务表皆有 `school` 字段用于学校数据隔离。空 school = 全局。

## WebSocket

服务端通过 `wss` 广播消息，admin 和普通用户连接在同一个 server。

### 事件类型

| type | 方向 | 说明 |
|------|------|------|
| `chat` | server → client | 新消息，`data` 包含消息内容 |
| `product_update` | server → client | 商品更新 |
| `new_product` | server → admin | 新商品发布 |
| `new_verification` | server → admin | 新认证申请 |

### admin WS 认证

admin 连接后发送 `{type:'admin_auth', token: '<token>'}`。

## 关键业务逻辑

### 昵称显示规则

商品详情/聊天头部：无交易或不涉及自己 → 只显示昵称（匿名）。卖家确认交易后 → `昵称 (真名)`。

昵称存在 `verifications.nickname` 字段，公开接口 `/api/marketplace/nicknames` 返回 `{student_id: nickname}`。

### 交易流程

```
买家点购买 → status: trading
卖家确认   → status: awaiting_buyer  
买家确认   → status: completed, sold: true
```

每一步都调用 `sendNotify()` 给相关方发系统消息。

### 通知系统

`sendNotify(ownerStudentId, ownerName, school, msg)` 通过 messages 表发系统消息 from `kefu_<school>`。

前台通过 `startUnreadPoll()`（每 3s）拉取未读消息，过滤 `from_name === '系统通知'` 显示在通知面板。

### 消息实时推送

所有消息通过 WebSocket 广播 `{type:'chat', data: {...}}`。前台 `connectWS()` 接收，不在当前聊天则增加 badge 计数。

## 后台缓存机制

- `_adminNickCache`: 在 `init()` 时从 `/api/verify/list` 加载，用于显示昵称(真名)
- `_nickCache`（前台）: 从 `/api/marketplace/nicknames` 加载，5 分钟 TTL

## 关键环境变量

```
ADMIN_PASSWORD=         # 超管密码
MANAGER_PASSWORD=       # 客服经理密码（废弃）
SCHOOL_ADMINS=          # JSON: [{"code":"gxny","name":"广西农业职业技术大学","password":"xxx"}]
JWT_SECRET=             # JWT 签名
TOKEN_EXPIRY_HOURS=12   # Token 过期时间
```

## 内测注意事项

1. 所有数据修改操作都会写入 `logs` 表，可追溯
2. 测试敏感词/公告/周边有礼时注意学校隔离
3. 测试交易流程需两个真实用户账号
4. 删除认证不会删除商品/聊天记录（仅删除认证信息）
5. Render 免费版 Supabase 查询约 0.5-3s，非代码问题
