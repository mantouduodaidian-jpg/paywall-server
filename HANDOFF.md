# 二豆校园 · 交接文档

## 新对话必读

先读 `CHECKLIST.md`、`PROJECT_SUMMARY.md`、`PROJECT_BACKEND.md` 了解全貌，再读本文件了解当前阶段。

**网页版功能完善，主攻微信小程序。**

## 部署信息
- **线上地址**: https://paywall-server.onrender.com
- **GitHub**: github.com/mantouduodaidian-jpg/paywall-server.git
- **Supabase**: hcinnimptpsjocbkkbna.supabase.co
- **自动部署**: GitHub push → Render 自动部署（~2分钟）
- **Git 结构**: 根目录 git（含 miniprogram/）+ server/ 子模块 git

## 环境变量（Render 需设置）

| 变量 | 必填 | 说明 |
|------|------|------|
| ADMIN_PASSWORD | ✅ | 超管密码 |
| SCHOOL_ADMINS | ✅ | JSON 数组，各校分管密码 |
| WALL_ADMIN_PASSWORD | ❌ | 校园墙后台密码 |
| MANAGER_PASSWORD | ❌ | 经理密码 |
| BETA_ADMIN_SCHOOLS | ❌ | 能管内测的学校代码，默认 gxny,hnkj,gdcj |
| BETA_PASSWORD | ❌ | 内测入口密码（不设也能进） |

### SCHOOL_ADMINS 格式
```json
[
  {"code":"gxny","name":"广西农业职业技术大学","password":"phy91"},
  {"code":"hnkj","name":"海南科技职业大学","password":"wqs91"},
  {"code":"gdcj","name":"广东财经大学","password":"whm91"},
  {"code":"lztd","name":"柳州铁道职业技术学院","password":"wly91"}
]
```

## 目录结构
```
D:\OneDrive\桌面\创造i\
├── server/                     ← 后端 + 网页前端
│   ├── server.js               ← 主服务器（API + WebSocket，~2100行）
│   ├── public/
│   │   ├── market.html         ← 前台二手集市
│   │   ├── admin-market.html   ← 后台管理面板（15+ Tab）
│   │   ├── admin-wall.html     ← 校园墙独立管理页
│   │   ├── campus-wall.html    ← 校园墙前台页面
│   │   └── ...
│   └── HANDOFF.md
│
├── miniprogram/                ← 微信小程序
│   ├── pages/
│   │   ├── index/    ← 首页（商品+分类+学校+公告+筛选）
│   │   ├── detail/   ← 商品详情
│   │   ├── login/    ← 登录/注册（含内测入口）
│   │   ├── message/  ← 消息列表
│   │   ├── chat/     ← 聊天（交易+评价+图片）
│   │   ├── profile/  ← 个人中心
│   │   └── publish/  ← 发布商品
│   └── custom-tab-bar/
```

## 后台功能 (admin-market.html)

| Tab | 功能 |
|-----|------|
| 概览 | 统计卡片+图表（可点击跳转筛选）+已交易金额 |
| 商品 | 商品审核、多图预览、偏好列 |
| 租借 | 出租商品管理 |
| 卖家 | 卖家列表+评价数+信誉分 |
| 认证 | 学生证审核+性别+评价+**信誉分** |
| 评价 | 所有评价列表+信誉分 +/- 操作 |
| 交易 | 转账管理+待转账角标+学校列 |
| 公告 | 发布公告（选学校或全局）|
| 周边有礼 | 推广管理 |
| 消息 | 客服聊天（文字+图片）|
| 校园墙 | 帖子审核（暂停）|

### 权限
- **超管**: 全部，可切换学校
- **分管**: 锁定本校，不可切换
- **内测分管** (BETA_ADMIN_SCHOOLS): 可切到内测服

### 新增核心功能
- 信用分（初始80，后台 +/-）
- 交易评价（标签+理由+图片）
- 交易角标+已交易金额统计
- 学校隔离（school=beta 完全隔离）

## 小程序功能

| 页面 | 已完成功能 |
|------|-----------|
| 首页 | 商品列表+分类+搜索+公告条+分页+状态角标+价格筛选+排序 |
| 详情 | 商品信息+联系卖家+购买+性别显示 |
| 登录 | 学号+电话登录/注册+学生证+内测入口 |
| 聊天 | 消息+交易确认/取消/收货+评价弹窗+图片发送/显示 |
| 发布 | 出售/出租+图片上传+租期+性别偏好 |

### 内测系统
- 登录页「🔒 内测入口」→ 用户名+密码登录
- school=beta 隔离，商品列表空
- 账号: phy/phw91, wqs/wqs91, whm/whm91

## 交易流程
```
购买请求 → trading
  → 卖家确认 → awaiting_buyer, payment_status=pending（产生待转账）
    → 买家收货 → completed（弹出评价窗口）
    → 取消 → 清空
```

## 新增后端 API

| 方法 | 路径 | 说明 |
|------|------|------|
| POST | /api/marketplace/reviews | 提交评价 |
| GET | /api/marketplace/reviews | 查评价 |
| PATCH | /api/marketplace/credit | 改信誉分 |
| POST | /api/marketplace/beta-login | 内测用户登录 |
| GET | /api/chat-image/:id | 聊天图片代理 |
| POST | /api/wall/posts | 校园墙发帖（暂停）|

## Supabase 关键表
- **products**: 商品（含 payment_status, gender_pref）
- **verifications**: 用户（含 credit_score, gender）
- **reviews**: 交易评价（tags[], reason, images[]）
- **messages**: 聊天消息（含[img]标记）
- **wall_posts**: 校园墙帖子（暂停）

## 注意事项
1. Render 冷启动 ~30s，首次请求会超时或 502
2. 小程序必须勾「不校验合法域名」
3. 小程序不支持 base64 图片，用 `/api/chat-image/:id` 代理
4. 系统通知用 `sys_` 前缀，客服用 `kefu_` 前缀，互不干扰
5. 校园墙功能暂停开发
