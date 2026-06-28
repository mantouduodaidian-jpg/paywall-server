# 二豆校园二手 · 小程序对接指南

## 部署信息
- 后端: https://paywall-server.onrender.com
- Supabase: hcinnimptpsjocbkkbna.supabase.co
- GitHub: github.com/mantouduodaidian-jpg/paywall-server.git

## 表结构 (Supabase)

### products
| 字段 | 类型 | 说明 |
|------|------|------|
| id | int8 | 主键 |
| title | text | 商品标题 |
| price | float8 | 价格（出售） |
| category | text | 分类 |
| quality | text | 新旧程度 |
| desc | text | 描述 |
| images | jsonb | 图片数组 |
| status | text | pending/approved/rejected |
| listed | bool | 是否上架 |
| sold | bool | 是否售出 |
| item_type | text | sell/rent |
| rent_price | float8 | 租金 |
| rent_period | text | day/week/month |
| deposit | float8 | 押金 |
| negotiable | bool | 可议价 |
| owner_student_id | text | 卖家学号 |
| owner_name | text | 卖家姓名 |
| school | text | 学校代码 |
| trade_status | text | 交易状态（trading/awaiting_buyer/completed）|
| trade_buyer_id | text | 买家学号 |
| trade_buyer_name | text | 买家姓名 |
| reject_reason | text | 拒绝/下架原因 |
| pinned | bool | 置顶 |
| created_at | timestamptz | 创建时间 |

### verifications
| 字段 | 说明 |
|------|------|
| student_id | 学号（唯一标识）|
| name | 真实姓名 |
| phone | 手机号 |
| school | 学校代码 |
| nickname | 匿名昵称 |
| gender | male/female |
| status | pending/approved/rejected/muted |
| image | 学生证图片(base64) |
| payment_qr | 收款码(base64) |

### messages
| 字段 | 说明 |
|------|------|
| product_id | 关联商品ID |
| from_student_id | 发送者 |
| to_student_id | 接收者 |
| content | 消息内容（纯文本，[img]前缀表示图片）|
| read | bool 是否已读 |

### reports, announcements, blocked_words, logs, promotions
见 Supabase 控制台，结构简单。

## 核心 API 清单

### 认证
```
POST /api/marketplace/login          — 注册/登录（学号+手机）
GET  /api/marketplace/nicknames       — 获取昵称映射 {student_id: nickname}
POST /api/marketplace/check-session   — 检查 session 是否有效
```

### 商品
```
GET    /api/marketplace/products      — 商品列表（支持 ?category=&search=&owner=&item_type=&school=&sort=&price_min=&price_max=&limit=&offset=）
GET    /api/marketplace/products/:id  — 商品详情
POST   /api/marketplace/products      — 发布商品
PATCH  /api/marketplace/products/:id/owner-edit     — 卖家编辑
POST   /api/marketplace/products/:id/resubmit       — 提交审核
PATCH  /api/marketplace/products/:id/owner-delist   — 卖家下架
PATCH  /api/marketplace/products/:id/owner-relist   — 卖家上架
DELETE /api/marketplace/products/:id/owner-delete   — 卖家删除
```

### 交易
```
POST /api/marketplace/trade/request       — 买家发起购买请求
POST /api/marketplace/trade/confirm       — 卖家确认交易
POST /api/marketplace/trade/buyer-confirm — 买家确认收货
POST /api/marketplace/trade/cancel        — 取消交易
```

### 聊天
```
GET  /api/marketplace/messages      — 获取消息（?student_id=&other_student_id=&since_id=）
POST /api/marketplace/messages      — 发送消息
POST /api/marketplace/messages/read — 标记已读
GET  /api/marketplace/contacts      — 联系人列表（含未读数）
```

### 其他
```
GET  /api/marketplace/categories    — 分类列表
POST /api/marketplace/reports       — 提交举报
GET  /api/marketplace/announcements — 公告
```

## 交易状态机

```
[买家点"我想交易"]
    → trade_status = 'trading'
    → 卖家看到: "买家下单" + 确认/取消按钮

[卖家点"确认"]
    → trade_status = 'awaiting_buyer'
    → 买家看到: "请确认收货" + 确认按钮
    → 双方可见真实姓名

[买家点"确认收货"]
    → trade_status = 'completed', sold = true, listed = false
    → 双方收到系统通知
    → 卖家: "已收款 🎉"
    → 买家: "已收货 🎉"
```

## 昵称/匿名规则

| 场景 | 显示 |
|------|------|
| 浏览商品（非买家） | 昵称 / "匿名卖家" |
| 自己看自己 | 真名 |
| 交易中/已完成 | 昵称 (真名) |

## 通知类型

| 触发 | 谁收到 | 内容 |
|------|--------|------|
| 买家请求 | 卖家 | "有人想购买你的商品「xxx」" |
| 卖家确认 | 买家 | "卖家已确认购买「xxx」" |
| 买家收货 | 双方 | "交易完成 🎉" |
| 卖家取消 | 双方 | "交易已取消" |
| 商品通过 | 卖家 | "已通过审核" |
| 商品拒绝 | 卖家 | "未通过审核" |
| 商品下架 | 卖家 | "已被管理员下架" |
| 认证通过 | 用户 | "认证已通过" |
| 认证拒绝 | 用户 | "认证未通过" |

## 关键业务逻辑

1. **商品只显示已上架的** — 非管理员查询自动加 `status=eq.approved&listed=eq.true`
2. **卖家看到自己所有商品** — `?owner=student_id` 不过滤状态
3. **昵称来自 verifications 表** — 公共接口 `/api/marketplace/nicknames` 返回全部 `{student_id: nickname}`
4. **卖家自下架可上架** — 自下架设置 `reject_reason='owner_delisted'`，管理员下架不设置
5. **未读消息** — 关闭聊天时才标记已读，不支持像微信一样逐条标记

## WebSocket

路径: `wss://paywall-server.onrender.com`

消息格式:
```json
// 客户端发送
{"type":"auth","student_id":"xxx"}
{"type":"admin_auth","token":"xxx"}

// 服务端推送
{"type":"chat","data":{"id":1,"from_student_id":"...","content":"..."}}
{"type":"product_update","data":{"id":1}}
{"type":"admin_new_product","data":{"id":1,"title":"...","item_type":"sell"}}
{"type":"admin_new_verification","data":{"student_id":"...","name":"..."}}
```

## 学校代码
```
gxny — 广西农业职业技术大学
hnkj — 海南科技职业大学
gdcj — 广东财经大学
lztd — 柳州铁道职业技术学院
```

## 小程序注意事项

1. **图片上传** — 当前 API 支持 base64（`images:[]`），小程序端建议用微信云存储，传回 URL
2. **登录** — 当前用学号+手机号，小程序可改为微信一键登录+绑定学号
3. **消息推送** — WebSocket 在微信小程序后台可能断开，需要轮询备用
4. **敏感词过滤** — 服务端已内置，发布商品时自动检测
