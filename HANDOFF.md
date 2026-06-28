# 二豆校园二手 · 交接文档

## 新对话必读

继续开发二豆校园二手项目。先读 `CHECKLIST.md`、`PROJECT_SUMMARY.md`、`PROJECT_BACKEND.md` 了解全貌，再读本文件了解当前阶段。

**网页版已完善，停止新功能开发，只修 Bug。当前主攻微信小程序。**

小程序目录：`D:\OneDrive\桌面\创造i\miniprogram\`

**优先任务：**
1. 修登录页 — 对齐网页版登录流程（学号+电话 / 手机验证）
2. 修底部导航 — 首页/分类/发布/消息/我的
3. 补交易按钮 — 商品详情加「购买」「联系卖家」
4. 补收藏功能 — 前端收藏 + 后端接口

## 项目概览
校园二手交易平台，前后端分离架构。后端 Node.js + Supabase，前端网页版 + 微信小程序。

## 目录结构
```
D:\OneDrive\桌面\创造i\server\          ← 后端 + 网页前端
├── server.js                          ← 主服务器（API + WebSocket）
├── CHECKLIST.md                       ← AI 改前必读
├── PROJECT_SUMMARY.md                 ← 项目完整说明（AI 必读）
├── WECHAT_MP_GUIDE.md                 ← 小程序对接 API 文档
├── HANDOFF.md                         ← 本文件
├── public/
│   ├── market.html                    ← 前台（二手集市）
│   └── admin-market.html              ← 后台管理面板
├── api/verify.js                      ← 密码验证系统（旧，可忽略）
└── .gitignore

D:\OneDrive\桌面\创造i\miniprogram\    ← 微信小程序代码
├── app.js / app.json / app.wxss
├── pages/
│   ├── index/     ← 首页（商品列表+分类+学校选择）
│   ├── detail/    ← 商品详情
│   ├── login/     ← 登录
│   ├── message/   ← 消息列表
│   ├── chat/      ← 聊天
│   ├── profile/   ← 个人中心
│   └── publish/   ← 发布商品
└── images/
```

## 部署信息
- **线上地址**: https://paywall-server.onrender.com
- **GitHub**: github.com/mantouduodaidian-jpg/paywall-server.git
- **Supabase**: hcinnimptpsjocbkkbna.supabase.co
- **自动部署**: GitHub push → Render 自动部署

## 网页版已完成功能

### 前台 (market.html)
- ✅ 商品列表（分类/搜索/价格区间/排序）
- ✅ 出售/出租切换
- ✅ 商品收藏 ❤️
- ✅ 昵称/匿名系统（交易完成前匿名，完成后显示真名）
- ✅ 交易流程三阶段（购买请求 → 卖家确认 → 买家收货）
- ✅ 聊天系统（私聊 + 客服）
- ✅ 系统通知面板（右下角喇叭）
- ✅ 提示音（消息音 + 系统铃铛音）
- ✅ 未读消息（关闭聊天才标记已读，像微信）
- ✅ 发布/编辑商品
- ✅ 卖家自下架可上架
- ✅ 被下架/未通过可编辑重新提交审核
- ✅ 游客提示（主题色卡片）
- ✅ SVG 主题图标全部替换

### 后台 (admin-market.html)
- ✅ 13 个 Tab 管理面板
- ✅ 批量处理（全选 + 批量通过/拒绝/删除）
- ✅ 认证表昵称列
- ✅ 卖家账号删除
- ✅ 审核通知自动发送
- ✅ 商品/租借待审核 badge 分开

### 服务器 (server.js)
- ✅ 所有 API 端点（商品/交易/聊天/认证/通知等）
- ✅ WebSocket 实时推送
- ✅ 通知系统全覆盖
- ✅ 昵称公开接口

## 微信小程序现状

### 已完成
- ✅ 首页（商品列表 + 分类滚动 + 学校选择 + 搜索）
- ✅ 详情页
- ✅ 登录页
- ✅ 消息列表 + 聊天
- ✅ 个人中心
- ✅ 发布商品

### 未完成 / 需要继续的
- ❌ 底部 Tab 导航栏（缺图标 PNG）
- ❌ 交易状态按钮（聊天底部确认/取消/收货）
- ❌ 收藏功能
- ❌ 我的商品列表
- ❌ 图片上传
- ❌ 下拉刷新/加载更多
- ❌ 提示音
- ❌ 出租类型发布

## 关键业务逻辑（AI 必读）

### 交易状态机
```
购买请求 → trade_status='trading' → 卖家看到确认/取消按钮
卖家确认 → trade_status='awaiting_buyer' → 双方可见真实姓名
买家收货 → trade_status='completed', sold=true → 双方通知
取消     → trade_status='' → 清空买家信息
```

### 昵称规则
| 场景 | 显示 |
|------|------|
| 浏览商品（非卖家） | 昵称 or "匿名卖家" |
| 自己看自己商品 | 真名 |
| 交易中/已完成 | 昵称 (真名) |

### 上下架规则
| 操作 | 标记 | 能否恢复 |
|------|------|---------|
| 卖家自下架 | reject_reason='owner_delisted' | ✅ 可上架 |
| 管理员下架 | 无特殊标记 | ❌ 不可上架，可编辑后提交审核 |
| 审核未通过 | status='rejected' | 可编辑后提交审核 |

### 通知覆盖
- 买家请求 → 卖家收到
- 卖家确认 → 买家收到
- 买家收货 → 双方收到
- 卖家取消 → 双方收到
- 商品审核通过/拒绝 → 卖家收到
- 商品被下架 → 卖家收到
- 认证通过/拒绝 → 用户收到

### 错误排查方法
```bash
node --check server.js              # 后端语法
grep -o '{' file.html | wc -l       # 数 { 必须等于 }
grep -o '(' file.js | wc -l         # 数 ( 必须等于 )
cat -A file.html | grep -n "div"    # 查缩进 / 缺 </div>
```

## 小程序注意事项
1. Render 免费版冷启动约 30 秒，第一次请求可能超时
2. 微信开发者工具必须勾选「不校验合法域名」
3. 小程序不支持 WXML 内联 SVG，图标用 emoji 或 PNG
4. 图片上传建议用微信云存储，接口已支持 base64

## 工作模式（AI 必读）

### 改前流程
1. **先出方案** — 用户说需求，AI 给方案。用户说「开搞」才写代码
2. **改前检查** — 三项必做：
   ```bash
   node --check server.js                   # 后端语法
   grep -o '{' file.html | wc -l           # { } 必须相等
   grep -o '(' file.js | wc -l             # ( ) 必须相等
   ```
3. **分批隔离** — 工作 vs 不工作部分找分界线，定位 DOM 炸点
4. **`cat -A` 查缩进** — 真实空格数，缺 `</div>` 一眼看出来
5. **不用 CSS 字符串判断状态** — 用 JS 变量（如 `_pubType`）
6. **前端送数归一化** — `parseFloat(x) || 0`
7. **前后端校验一致** — 出租判 `rent_price`，不出售判 `price`

### 推前检查
```bash
git add .
git commit -m "类型: 描述"     # 类型: fix/feat/perf/style/docs
git push origin master         # Render 自动部署
```

### 沟通风格（用户是超管）
- 用户主动提需求，AI 给方案
- 用户说「开搞」才写代码
- 出错先看 console 报错
- 括号不平衡、node --check 不通过 = 不能推
- 用户是超级管理员，密码在 Render 环境变量里
- 用户喜欢「分批隔离法」排查问题

### 小程序开发特别规则
- 微信开发者工具必须勾选「不校验合法域名」
- 不要在 WXML 里内联 SVG（不支持）
- 图标用 emoji 或 PNG 图片
- `bindtap` 事件需配合 `value="{{var}}"` 双向绑定
- `wx:key` 建议用 `wx:for-index="idx" wx:key="idx"`

## 当前问题
1. 小程序登录页没有快捷测试账号（不知道手机号）
2. 小程序请求因 Render 冷启动易超时
3. 网页版 admin-market.html 仍有 `class` 语法错误（用户自己修）
