# 二豆 · 校园二手交易平台 — 项目完整说明

## 目录结构
```
D:\OneDrive\桌面\创造i\server\
├── server.js              ← 后端 API + WebSocket (Express + Supabase)
├── package.json
├── data/                  ← SQLite 数据（旧系统，不用管）
└── public/
    ├── market.html        ← 前台（二手集市）
    └── admin-market.html  ← 后台管理面板
```

## 部署信息
- **Render:** paywall-server.onrender.com
- **Supabase:** hcinnimptpsjocbkkbna.supabase.co
- **GitHub:** github.com/mantouduodaidian-jpg/paywall-server.git
- **自动部署:** GitHub push → Render 自动部署（已配好）

## 权限体系（3 层）

### 1. 超级管理员 (admin)
- 密码: `x130977889X`（Render 环境变量 `ADMIN_PASSWORD`）
- 权限: 全部功能、全部学校
- 登录后顶部有学校下拉框可切换查看任意学校

### 2. 学校管理员 (school_admin)
- 由 Render 环境变量 `SCHOOL_ADMINS` 定义，格式:
  ```json
  [{"code":"gxny","name":"广西农业职业技术大学","password":"phy91"},{"code":"hnkj","name":"海南科技职业大学","password":"wqs91"}]
  ```
- 权限: 只能操作自己学校的数据（商品/认证/消息/交易等）
- 登录: 输入对应密码，系统自动匹配学校

### 3. 客服经理 (manager) — 已废弃，保留兼容
- 密码: 环境变量 `MANAGER_PASSWORD` 或默认 `manager123`
- 说明: 早期角色，后来被学校管理员替代。目前仅能访问部分路由（`anyAdmin`），不能删商品、不能审认证。保留是为了兼容已有 token，新项目可忽略。

## 核心功能

### 前台 (market.html)
- 商品浏览、分类筛选、搜索、出租/出售切换
- 发布闲置/出租 (带学生证+收款码上传)
- 聊天系统（私聊 + 学校专属客服）
- 交易流程（请求/确认/取消）
- 举报系统
- 学校选择（注册时选校，数据自动隔离）

### 后台 (admin-market.html) — 13 个 Tab
```
概览 → 商品 → 租借 → 卖家 → 认证 → 分类 → 举报 → 公告 → 敏感词 → 日志 → 消息 → 周边有礼 → 💰交易
```

| Tab | 功能 |
|-----|------|
| 概览 | 统计数字 + 图表（近7日发布/分类/状态/成交额）|
| 商品 | 审核/上下架/置顶/编辑/删除/标记已售（仅显示 item_type='sell'）|
| 租借 | 同商品，仅显示 item_type='rent' |
| 卖家 | 查看商品/全部上下架/封禁/禁言 |
| 认证 | 审核/删除/查看学生证+收款码 |
| 分类 | 增删改排序 |
| 举报 | 处理/驳回 |
| 公告 | 按学校发布/全局发布（黄色标识）|
| 敏感词 | 增删 |
| 日志 | 操作记录 |
| 消息 | 客服回复用户（可主动联系）+ 发图片 |
| 周边有礼 | 增删改 |
| 💰交易 | 已售商品列表 + 确认转账/标记失败 |

### 认证系统
- 注册上传: 学生证 + 收款码（微信/支付宝）
- 图片压缩: 自动压缩至 800px / JPEG 60%
- 后台查看: 每个认证有「📷学生证」「📷收款码」按钮

### 客服系统
- 每个学校有专属客服 ID: `kefu_` + 学校代码（如 `kefu_gxny`）
- 用户联系人列表自动显示本校客服
- 后台客服可以看到本校所有已注册用户（不限于聊过天的）
- 支持发图片、搜索联系人

### 交易管理
- 商品标记「已售」→ 自动出现在「💰交易」Tab
- 管理员转钱给卖家后点「✅确认转账」
- 概览图表: 近7日成交额柱状图 + 待转账金额统计

### 多学校隔离
- 4 所学校: 广西农业(gxny)、海南科技(hnkj)、广东财经(gdcj)、柳州铁道(lztd)
- 各校数据完全隔离（商品/认证/公告/客服消息互不可见）
- 超管可切换查看

## 数据库 (Supabase)
主要表: `products`, `verifications`, `messages`, `announcements`, `promotions`, `reports`, `logs`, `blocked_words`, `chat_alerts`
所有表都有 `school` 字段用于隔离

## 关键环境变量 (Render)
| 变量 | 说明 |
|------|------|
| `ADMIN_PASSWORD` | 超管密码 |
| `MANAGER_PASSWORD` | 客服经理密码（废弃）|
| `SCHOOL_ADMINS` | 学校管理员 JSON 数组 |
| `JWT_SECRET` | JWT 签名密钥 |
| `TOKEN_EXPIRY_HOURS` | Token 过期小时数（默认12）|

## 设计风格
- 二豆绿白扁平主题: 暖奶油底 `#f7f3ea`、主绿 `#4e9e80`
- 纯 SVG 图标（零外部依赖）
- 弹簧动画 `cubic-bezier(.34,1.56,.64,1)`
- 自定义确认弹窗取代浏览器原生 confirm

## 待完善功能
1. 商品图片上传（目前只有 📦 emoji）
2. 用户通知（审核结果通知）
3. 数据导出 Excel
4. 搜索优化（价格区间/排序）
