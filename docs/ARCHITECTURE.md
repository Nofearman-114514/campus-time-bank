# 校园时间银行 · 架构与接口契约（唯一事实来源）

> 本文件是**冻结契约**。所有页面、云函数、管理端代码必须严格遵循此处的字段名、action 名与返回结构，
> 任何一方擅自改名都会导致联调失败。修改本文件前请先同步所有引用方。

---

## 0. 一句话定位

大学生用「时间币」互相交换技能的校园互助平台。**1 次服务 = 若干时间币**，
时间币**不可充值、不可提现**，只能通过服务赚取与消耗 —— 因此**完全不需要微信支付资质**。

---

## 1. 目录结构

```
campus-time-bank/
├── project.config.json          小程序项目配置（miniprogramRoot / cloudfunctionRoot）
├── Campus Time Bank/                 小程序前端
│   ├── app.js / app.json / app.wxss
│   ├── envList.js               云开发环境 ID 列表（★ 部署时必改）
│   ├── custom-tab-bar/          自定义 tabBar（中间凸起「发布」按钮）
│   ├── styles/
│   │   ├── theme.wxss           设计 token（颜色/圆角/阴影/字号）
│   │   └── common.wxss          原子类与通用组件样式
│   ├── utils/
│   │   ├── api.js               ★ 唯一网络出口：把 action 映射到云函数
│   │   ├── cloud.js             云函数调用封装（超时/重试/错误归一）
│   │   ├── mock.js              离线模拟数据（无云环境也能预览 UI）
│   │   ├── constants.js         枚举/字典/状态机文案
│   │   ├── credit.js            信用分与徽章算法（前端展示用副本）
│   │   ├── util.js              格式化/节流/防抖/校验
│   │   └── qqmap.js             腾讯位置服务（可选，仅逆地址解析用）
│   ├── components/              自定义组件
│   │   ├── nav-bar/             自定义导航栏（适配胶囊）
│   │   ├── empty/               空态
│   │   ├── loading/             骨架屏 / 加载中
│   │   ├── skill-card/          技能卡片
│   │   ├── order-card/          订单卡片
│   │   ├── user-avatar/         头像 + 信用分角标
│   │   ├── star-rate/           星级评分（可只读/可交互）
│   │   ├── badge-wall/          徽章墙
│   │   └── ec-canvas/           ECharts 小程序 Canvas 适配器（管理端用）
│   ├── pages/                   主包页面
│   └── packageAdmin/            管理端分包
├── cloudfunctions/              云函数
│   ├── _shared/                 ★ 共享代码源（由 tools/sync-shared.mjs 同步到各函数）
│   ├── login/ skill/ order/ wallet/ user/ message/ admin/ initdb/
├── tools/
│   ├── sync-shared.mjs          把 _shared 同步进每个云函数
│   └── fetch-echarts.mjs        下载 echarts.min.js 到 ec-canvas
└── docs/                        设计文档 / 部署指南 / 答辩材料
```

---

## 2. 设计 Token（`Campus Time Bank/styles/theme.wxss`）

**所有页面必须使用这些变量，禁止硬编码色值。**

> 说明：下表是**页面应当使用的公开子集**，不是 `theme.wxss` 的全集。
> 该文件里另有约 16 个供组件内部与渐变使用的 token
> （`--c-accent-d` / `--c-t4` / `--c-inverse` / `--c-mask` / `--g-primary|accent|wallet|credit` /
> `--r-xl` / `--sh-primary|accent` / `--fs-sm|mini` / `--sp-s|l` 及各 `-l` 浅底色），
> 页面直接使用也完全合法 —— 只要**不硬编码色值**即可。

| 变量 | 值 | 用途 |
|---|---|---|
| `--c-primary` | `#0EA47A` | 主色（青绿，代表「时间」） |
| `--c-primary-d` | `#0B8A66` | 主色按下态 |
| `--c-primary-l` | `#E8F7F1` | 主色浅底 |
| `--c-accent` | `#FF8B3D` | 时间币橙（金币/强调） |
| `--c-accent-l` | `#FFF1E6` | 橙浅底 |
| `--c-danger` | `#F5483B` | 危险/删除/爽约 |
| `--c-warn` | `#FF9F0A` | 警告/待处理 |
| `--c-success` | `#0EA47A` | 成功/已完成 |
| `--c-info` | `#3B82F6` | 信息/进行中 |
| `--c-t1` | `#1A1D1F` | 主文字 |
| `--c-t2` | `#6B7280` | 次文字 |
| `--c-t3` | `#9CA3AF` | 辅助/占位 |
| `--c-line` | `#EDEFF2` | 分割线 |
| `--c-bg` | `#F5F7F9` | 页面底色 |
| `--c-card` | `#FFFFFF` | 卡片底 |
| `--r-s` | `12rpx` | 小圆角 |
| `--r-m` | `20rpx` | 中圆角（卡片默认） |
| `--r-l` | `32rpx` | 大圆角（弹层/按钮） |
| `--r-full` | `999rpx` | 胶囊 |
| `--sh-1` | `0 2rpx 12rpx rgba(16,24,40,.06)` | 卡片阴影 |
| `--sh-2` | `0 8rpx 32rpx rgba(16,24,40,.10)` | 浮层阴影 |
| `--fs-h1` | `44rpx` | 页面大标题 |
| `--fs-h2` | `36rpx` | 区块标题 |
| `--fs-h3` | `32rpx` | 卡片标题 |
| `--fs-body` | `28rpx` | 正文 |
| `--fs-cap` | `24rpx` | 辅助文字 |
| `--sp` | `24rpx` | 页面左右安全边距 |

### 2.1 硬编码色值的允许例外

规范要求「优先使用变量」，但以下是**明确允许**的字面量（全项目共约 28 处，审计可复现）：

| 例外 | 出现位置 | 理由 |
|---|---|---|
| `#fff` / `#ffffff` | 彩色底上的白字、头像描边、tabBar 底 | 纯白与主题无关，语义上不需要随主题变化（`--c-inverse` 就是 `#FFFFFF`，两者等价） |
| `#F5B301` | `star-rate` 的星级金色 | 星级的金色是**行业约定**，不属于本项目的语义色板 |
| `#EEF1F4` `#F6F8FA` `#FAFBFC` `#F2F4F6` | 骨架屏流光渐变、按压态底色 | 属于「中性灰阶的机械过渡值」，做成 token 反而增加噪音 |

除上述四类外，任何页面/组件都**不得**新增硬编码色值。
唯一的其它例外是**无法用变量表达**的属性值：`wx.setNavigationBarColor` 的 `backgroundColor`、
`<switch color>` 的 `color` —— 这类必须集中在 js 顶部的常量里并注释「与 theme.wxss 同源」。

---

## 3. 数据库集合（13 个）

> 全部集合的权限统一设为 **「仅管理端可读写」**（所有读写走云函数），
> **例外**：`chats` 与 `messages` 设为 **「所有用户可读，仅创建者可写」**，
> 以便客户端 `db.collection('messages').watch()` 实现实时聊天；写入仍强制走云函数校验成员身份。

### 3.1 `users` — 用户
```js
{
  _id: String,
  _openid: String,              // ★ 全库以 _openid 作为用户唯一标识
  nickName: String,             // 昵称
  avatarUrl: String,            // 头像（cloud:// fileID 或 https）
  gender: Number,               // 0未知 1男 2女
  phone: String,                // 手机号（可选）
  campus: String,               // 学校
  college: String,              // 学院
  major: String,                // 专业
  grade: String,                // 年级，如 "2022级"
  studentNo: String,            // 学号
  realName: String,             // ★ 真实姓名（校园认证时提交，管理端审核要核对；
                                //   与可自由修改的 nickName 分开存，认证页与审核页都读它）
  bio: String,                  // 个人简介
  tags: [String],               // 技能标签

  authStatus: Number,           // 0未提交 1待审核 2已通过 3已驳回
  authImages: [String],         // 学生证/校园卡照片 fileID
  authRemark: String,           // 管理员驳回原因
  authTime: Date,

  coins: Number,                // 可用时间币
  frozenCoins: Number,          // 冻结时间币
  totalEarned: Number,          // 累计赚取
  totalSpent: Number,           // 累计消耗

  creditScore: Number,          // 信用分，初始 100，范围 [0,150]
  creditLevel: String,          // 信用等级文案 key

  badges: [String],             // 徽章 id 数组
  stats: {                      // 统计（冗余，便于列表展示）
    publishCount: Number,       // 发布数
    serveCount: Number,         // 完成「提供技能」单数
    buyCount: Number,           // 完成「购买服务」单数
    reviewCount: Number,        // 收到评价数
    ratingSum: Number,          // 评分总和（算平均用）
    avgRating: Number,          // 平均分，保留 1 位
    ontimeStreak: Number        // 连续按时完成单数
  },

  location: GeoPoint,           // db.Geo.Point(lng, lat)，最近一次定位
  locationName: String,         // 位置描述，如 "东区宿舍"
  locationTime: Date,

  role: String,                 // 'user' | 'admin'
  status: Number,               // 1正常 0封禁

  createTime: Date,
  updateTime: Date,
  lastLoginTime: Date
}
```

### 3.2 `categories` — 技能分类
```js
{ _id, name: String, icon: String, sort: Number, status: Number /*1启用 0停用*/, createTime: Date }
```
> 种子数据见 `cloudfunctions/initdb/index.js`。

### 3.3 `skills` — 技能 / 求助
```js
{
  _id, _openid,
  authorId: String,             // = _openid，便于统一
  authorInfo: {                 // ★ 冗余快照，列表页不用联表
    nickName, avatarUrl, creditScore, creditLevel, authStatus
  },
  type: String,                 // 'offer' 我能提供 | 'need' 我要求助
  title: String,                // 标题，≤30 字
  desc: String,                 // 详情，≤500 字
  categoryId: String,
  categoryName: String,         // 冗余，列表直接显示
  price: Number,                // 时间币/次，≥1 整数
  duration: Number,             // 单次时长（分钟），如 60
  images: [String],             // fileID 数组，≤3
  tags: [String],               // ≤5

  location: GeoPoint,           // ★ 用于附近技能 geoNear
  address: String,              // 详细地址
  locationName: String,         // 位置名，如 "图书馆"

  status: Number,               // 1上架 0下架 2已完成 3违规下架 4待审核
  auditRemark: String,
  viewCount: Number,
  orderCount: Number,
  isTop: Boolean,               // 管理员置顶

  createTime: Date,
  updateTime: Date
}
```

### 3.4 `orders` — 订单
```js
{
  _id,
  orderNo: String,              // 'TB' + yyyyMMddHHmmss + 4位随机
  skillId: String,
  skillSnapshot: {              // ★ 下单时快照，防止技能被改/删后订单信息丢失
    title, price, duration, categoryName, images, type
  },
  buyerId: String,              // 买家 _openid（消耗时间币）
  buyerInfo: { nickName, avatarUrl, creditScore },
  sellerId: String,             // 卖家 _openid（提供服务方，收时间币）
  sellerInfo: { nickName, avatarUrl, creditScore },

  amount: Number,               // 本次消耗时间币

  status: String,               // 见 §5 状态机
  // 'waiting' 待接单 | 'ongoing' 服务中 | 'confirming' 待确认
  // 'finished' 已完成 | 'canceled' 已取消 | 'closed' 已关闭

  remark: String,               // 买家留言
  expectTime: String,           // 期望时间（自由文本/日期字符串）
  contact: String,              // 联系方式（可选）

  timeline: [{ status, time: Date, remark: String, operator: String }],

  cancelBy: String,             // 'buyer' | 'seller' | 'system'
  cancelReason: String,

  isRatedBuyer: Boolean,        // 买家是否已评
  isRatedSeller: Boolean,       // 卖家是否已评
  buyerScore: Number,           // 买家给的分（1-5）
  sellerScore: Number,          // 卖家给的分（1-5）

  createTime, acceptTime, finishTime, confirmTime, cancelTime: Date,
  expireTime: Date              // 待接单超时时间 = createTime + 24h
}
```

### 3.5 `reviews` — 评价
```js
{
  _id,
  orderId: String,
  skillId: String,
  fromId: String,               // 评价人 _openid
  fromInfo: { nickName, avatarUrl },
  toId: String,                 // 被评价人 _openid
  toInfo: { nickName, avatarUrl },
  role: String,                 // 'buyer' 买家评卖家 | 'seller' 卖家评买家
  score: Number,                // 1-5
  tags: [String],               // 如 ['专业','准时','有耐心']
  content: String,              // ≤200 字
  anonymous: Boolean,
  reply: { content: String, time: Date },   // 被评价人回复
  createTime: Date
}
```

### 3.6 `wallet_logs` — 时间币流水
```js
{
  _id, _openid,
  type: String,   // 'income' 收入 | 'expense' 支出 | 'freeze' 冻结
                  // 'unfreeze' 解冻 | 'settle' 结算给服务方
                  // 'refund' 退款 | 'admin' 管理员调整 | 'bonus' 注册赠送
  amount: Number,               // 正数=进账，负数=出账（对本人视角）
  balance: Number,              // 变动后可用余额
  frozen: Number,               // 变动后冻结额
  orderId, orderNo, remark: String,
  createTime: Date
}
```

### 3.7 `credit_logs` — 信用分流水
```js
{
  _id, _openid,
  change: Number,               // 正负
  score: Number,                // 变动后分数
  reason: String,               // 规则 key，见 §6
  reasonText: String,           // 中文说明
  orderId: String,
  createTime: Date
}
```

### 3.8 `chats` — 会话
```js
{
  _id,
  members: [String, String],    // 两个 _openid，升序排列保证唯一
  memberInfos: {                // 以 openid 为 key
    "<openid>": { nickName, avatarUrl, creditScore }
  },
  orderId: String,              // 关联订单（可空）
  orderNo: String,
  lastMsg: String,
  lastMsgType: String,          // 'text'|'image'|'system'
  lastTime: Date,
  unread: { "<openid>": Number },
  createTime: Date,
  updateTime: Date
}
```

### 3.9 `messages` — 消息（客户端可 watch）
```js
{
  _id, _openid: String,         // 发送者 openid（云函数显式写入）
  chatId: String,
  fromId: String,
  toId: String,
  type: String,                 // 'text' | 'image' | 'system'
  content: String,              // 文本内容 或 图片 fileID
  read: Boolean,
  createTime: Date
}
```

### 3.10 `notices` — 系统通知
```js
{
  _id, _openid,                 // 接收者
  type: String,                 // 'order'|'audit'|'credit'|'system'|'report'
  title: String,
  content: String,
  orderId: String,
  read: Boolean,
  createTime: Date
}
```

### 3.11 `reports` — 举报
```js
{
  _id, _openid,                 // 举报人
  targetType: String,           // 'skill' | 'user' | 'order' | 'review'
  targetId: String,
  targetTitle: String,          // 冗余，便于列表
  targetUserId: String,         // 被举报人
  reason: String,               // 举报原因（单选，取值见 constants.REPORT_REASONS）
  remark: String,               // 补充说明（举报页的 textarea，≤200 字）
  images: [String],             // 凭证图片 fileID
  status: Number,               // 0待处理 1已处理 2已驳回
  handleRemark: String,
  handlerId: String,
  handleTime: Date,
  createTime: Date
}
```

### 3.12 `banners` — 首页轮播（可选）
```js
{ _id, image: String, title: String, link: String, sort: Number, status: Number, createTime: Date }
```
> `image` 为空时，首页轮播渲染成「渐变底色 + `title` 大字文案」，因此**没有图片也能有完整视觉**。
> `link` 为空则不可点击；填页面路径（如 `/pages/auth/campus/campus`）则点击跳转。

### 3.13 `config` — 全局配置（单文档，`_id: 'global'`）
```js
{
  _id: 'global',
  registerBonus: Number,        // 注册赠送时间币，默认 5
  orderExpireHours: Number,     // 待接单超时小时，默认 24
  confirmExpireHours: Number,   // 待确认超时小时，默认 72（超时自动打款）
  minCreditToOrder: Number,     // 下单最低信用分，默认 60
  serviceFee: Number,           // 手续费（0 = 不抽成）
  hotCategories: [String],
  aboutUs: String,
  /**
   * 订阅消息模板 ID（服务端来源）。
   * 小程序端的模板 ID 写在 Campus Time Bank/envList.js 的 SUBSCRIBE_TEMPLATES 里，
   * 但**云函数读不到小程序端的文件**，所以服务端需要自己有一份。
   * 留空或字段缺失时，sendSubscribe() 会直接跳过发送，**不阻断主流程**。
   * 配置了真实模板后，data 的字段名要按模板实际的关键词编号调整
   * （当前实现按 thing1/thing2/character_string3/amount4 组装）。
   */
  subscribeTemplates: {
    ORDER_CREATE: '',
    ORDER_ACCEPT: '',
    ORDER_FINISH: '',
    ORDER_CONFIRM: ''
  },
  updateTime: Date
}
```

### 3.14 `favorites` — 技能收藏（第 17 个集合）
```js
{
  _id: String,
  _openid: String,        // 收藏者 openid（与其它集合一致，显式写入）
  skillId: String,        // 被收藏的技能 _id
  createTime: Date
}
```
> ★ **为什么单独建集合，而不是在 `skills` 上挂 `collectedBy: [openid]` 数组**：
> ① 「我的收藏」是一次 `where({_openid}).orderBy('createTime','desc')` 查询，语义干净；
> ② 取消收藏是删一条文档，不用读改写整个技能文档；
> ③ 技能文档**不会因为收藏人数增长而无限膨胀**（数组字段会把热点文档越写越大）。
>
> 唯一性由业务保证（`collect` 先查后写，重复收藏幂等）；已删除的技能在 `myFavorites` 里被跳过。
> 权限同样为「仅管理端可读写」——读写全部走云函数。

---

## 4. 云函数与 action 契约

### 4.0 统一调用协议

客户端：`wx.cloud.callFunction({ name, data: { action, ...payload } })`

云函数统一返回：
```js
{ code: 0, msg: 'ok', data: <任意> }        // 成功
{ code: 401, msg: '请先登录', data: null }   // 业务失败，code 非 0
```

| code | 含义 |
|---|---|
| 0 | 成功 |
| 400 | 参数错误 |
| 401 | 未登录 / 用户不存在 |
| 403 | 无权限（非管理员、非订单参与方、未认证） |
| 404 | 资源不存在 |
| 409 | 状态冲突（订单已被接、余额不足、重复操作） |
| 500 | 服务端异常 |

**所有云函数共用 `_shared` 导出的**：`db`、`_`、`$`（聚合命令）、`ok()`、`fail()`、`bizError()`、
`getUser(openid)`、`requireAuth()`、`requireAdmin()`、`assert()`、`addLog()`、`addNotice()`、
`now()`、`genOrderNo()`、`C`（集合名常量）。

### 4.1 `login` — 登录 / 资料 / 校园认证
| action | 入参 | 出参 |
|---|---|---|
| `login` | 无 | `{ user, isNew, config }` — 首次自动注册并赠送 `registerBonus` 时间币 |
| `updateProfile` | `{ nickName, avatarUrl, gender, bio, campus, college, major, grade, tags }` | `{ user }` |
| `submitCampusAuth` | `{ realName, studentNo, campus, college, major, authImages: [] }` | `{ authStatus }` | 前置条件：**只要求已设置昵称**（`nickName` 非空）。★ 刻意**不要求头像** —— 前端在 `avatarUrl` 为空时会渲染「昵称首字 + 稳定渐变色」的降级头像，所以「没有头像」是合法状态，不应当作前进门槛（否则种子演示用户无法提交认证）。★ **`realName` 必须落库到 `users.realName`**（不能只写进认证记录）—— 管理端「认证审核」页要显示它来核对身份，审核通过与驳回都依赖它 |
| `bindPhone` | `{ code }`（getPhoneNumber 返回） | `{ phone }` |
| `getUser` | `{ openid }` | `{ user }` — 公开字段，隐藏手机号等隐私 |
| `updateLocation` | `{ longitude, latitude, locationName }` | `{ ok: true }` |

### 4.2 `skill` — 技能域
| action | 入参 | 出参 |
|---|---|---|
| `list` | `{ page=1, size=10, categoryId, keyword, type, sort='new'\|'hot'\|'near'\|'priceAsc'\|'priceDesc', longitude, latitude, radius=3000, onlyVerified, authorId }` | `{ list: [Skill], total, hasMore }` — ★ `sort='near'` 但未传经纬度时**静默降级**为 `createTime desc`（不报错、不返空），此时列表项无 `distance` 字段，前端按 `item.distance ?? ''` 渲染 |
| `detail` | `{ id }` | `{ skill, author, isOwner, isCollected }` — 同时 `viewCount + 1`。★ `author` = 公开字段（滤掉 `phone/studentNo/authImages`）**并附带 `stats`**（`avgRating/reviewCount/serveCount/buyCount` 四个字段保证存在，默认 0），详情页作者卡要用它显示评分。`isCollected` 现在**真实反映收藏态**（查 `favorites` 集合；未登录时恒为 `false`） |
| `create` | `{ type, title, desc, categoryId, price, duration, images, tags, longitude, latitude, address, locationName }` | `{ id }` — ★ **`longitude`/`latitude` 现在是必填**，且坐标必须落在**校园范围内**（`CAMPUS_CENTER` 为圆心、`CAMPUS_RADIUS` = 1200 米的圆）。不在校内一律 400：「只能发布校内地点。校外的任务一旦出现纠纷或意外，校方无法及时处理」。这是一条**安全策略**，客户端会拦、云端是最后一道防线 |
| `update` | `{ id, ...同上 }` | `{ ok: true }` — 与 `create` 同样受校内限制：**传了坐标就必须在校内**（编辑旧任务时不强制补地点，但一旦传了就不许把任务挪到校外） |
| `remove` | `{ id }` | `{ ok: true }` — 有进行中订单时拒绝 |
| `collect` | `{ id, collected? }` | `{ collected: Boolean }` — 收藏 / 取消收藏。`collected` 显式传 `true/false` 时按值执行，**缺省则按当前状态取反（toggle）**。约束：未注册 401、缺 id 400、技能不存在 404、**已下架 409**、**收藏自己发布的 400**。幂等：重复收藏不产生第二条、重复取消不报错 |
| `myFavorites` | `{ page=1, size=10 }` | `{ list: [Skill & { collectedTime }], total, hasMore, page }` — 按**收藏时间倒序**；技能若已被删除则该条被跳过（不返回空洞）。⚠️ `total` 按收藏记录数统计，因此可能大于 `list` 长度，前端应按 `list` 渲染 |
| `myList` | `{ type, status, page, size }` | `{ list, total, hasMore }` |
| `categories` | 无 | `{ list: [Category] }` |
| `banners` | 无 | `{ list: [Banner] }` |
| `report` | `{ targetType, targetId, reason, images, remark?, targetTitle?, targetUserId? }` | `{ ok: true }` — `remark` 是举报页的「补充说明」；`targetTitle/targetUserId` 为可选冗余字段（§3.11 需要），前端传了以传的为准，没传则服务端按 `targetType` 自动补全 |

### 4.3 `order` — 订单域（★ 时间币事务核心）
| action | 入参 | 出参 | 关键校验 |
|---|---|---|---|
| `create` | `{ skillId, remark, expectTime, contact }` | `{ orderId, orderNo }` | 不能买自己的；信用分 ≥ `minCreditToOrder`；`coins ≥ amount`；技能上架中 |
| `accept` | `{ orderId }` | `{ ok: true }` | 仅卖家；状态必须 `waiting` |
| `reject` | `{ orderId, reason }` | `{ ok: true }` | 仅卖家；解冻买家时间币 |
| `cancel` | `{ orderId, reason }` | `{ ok: true }` | 买家在 `waiting`/`ongoing` 可取消；`ongoing` 取消扣信用分 |
| `finish` | `{ orderId }` | `{ ok: true }` | 仅卖家；`ongoing → confirming` |
| `confirm` | `{ orderId }` | `{ ok: true }` | ★ 仅买家；`confirming → finished`；**解冻并结算给卖家**；双方 +2 信用分 |
| `list` | `{ role='buyer'\|'seller', status='all'\|'waiting'\|... , page, size }` | `{ list: [Order], total, hasMore }` |
| `detail` | `{ orderId }` | `{ order, role }` | 仅参与方或管理员可看。★ `role` 可能是 **`'admin'`**（非参与方的管理员查看时），前端**不要假设只有 buyer/seller**：此时应正常展示订单与时间轴，但**隐藏所有状态操作按钮** |
| `counts` | 无 | `{ waiting, ongoing, confirming, finished, canceled }`（作为 buyer+seller 合并） |

**结算事务**（`confirm`）伪代码：
```js
await db.runTransaction(async tx => {
  const buyer = await tx.collection('users').doc(buyerId).get()
  const order = await tx.collection('orders').doc(orderId).get()
  assert(order.status === 'confirming')
  // 买家：冻结额释放并真正扣除（下单时已从 coins 扣走，此处只减冻结）
  await tx.collection('users').doc(buyerId).update({ data: { frozenCoins: _.inc(-amount), totalSpent: _.inc(amount) } })
  // 卖家：到账
  await tx.collection('users').doc(sellerId).update({ data: { coins: _.inc(amount), totalEarned: _.inc(amount), 'stats.serveCount': _.inc(1) } })
  await tx.collection('orders').doc(orderId).update({ data: { status: 'finished', confirmTime: now() } })
  // 流水与信用分在事务外补写（集合写入较多，避免事务超时）
})
```

### 4.4 `wallet` — 时间币
| action | 入参 | 出参 |
|---|---|---|
| `info` | 无 | `{ coins, frozenCoins, totalEarned, totalSpent, income7d, expense7d }` |
| `logs` | `{ page, size, type='all' }` | `{ list: [WalletLog], total, hasMore }` |
| `stats` | 无 | `{ trend: [{date, income, expense}], byCategory: [{name, value}] }` |

### 4.5 `user` — 个人中心 / 信用 / 评价
| action | 入参 | 出参 |
|---|---|---|
| `mine` | 无 | `{ user, counts: { publish, serve, buy, review, unreadNotice, waitingOrder }, badges: [Badge] }` — 注意 `counts` **不含聊天未读数**，个人中心的「我的消息」红点由页面另调 `message.unreadTotal()` 获取（该接口同时返回 `{chat, notice}`，可一次拿全） |
| `home` | `{ openid }` | `{ user（公开字段）, skills: [Skill]（前 6 条）, reviews: [Review]（前 3 条）, stats }` |
| `creditLogs` | `{ page, size }` | `{ list: [CreditLog], total, hasMore }` |
| `badges` | `{ openid? }` | `{ owned: [Badge], all: [Badge] }` |
| `reviews` | `{ openid?, role='received'\|'sent', page, size }` | `{ list: [Review], total, hasMore }` |
| `reviewCreate` | `{ orderId, score, tags, content, anonymous }` | `{ ok: true }` — 校验订单已完成且未评价过 |
| `reviewReply` | `{ reviewId, content }` | `{ ok: true }` |

### 4.6 `message` — 聊天 / 通知 / 订阅消息
| action | 入参 | 出参 |
|---|---|---|
| `conversations` | `{ page, size }` | `{ list: [Chat], total, hasMore }` |
| `openChat` | `{ toId, orderId? }` | `{ chatId }` — 不存在则创建 |
| `history` | `{ chatId, page, size }` | `{ list: [Message], hasMore }` — ★ `page=1` 返回**最新**一页：内部按 `createTime desc` 分页查询后**反转为升序**返回，`hasMore` 表示是否还有更早的消息。这样聊天页打开就能看到最新对话，上滑再加载历史 |
| `send` | `{ chatId, toId, content, type='text' }` | `{ msgId, createTime }` |
| `read` | `{ chatId }` | `{ ok: true }` |
| `unreadTotal` | 无 | `{ chat, notice }` |
| `notices` | `{ page, size, type='all' }` | `{ list: [Notice], total, hasMore }` |
| `readNotice` | `{ id }` / `{ all: true }` | `{ ok: true }` |
| `subConfig` | 无 | `{ templates: [{ id, title, key }] }` — 订阅消息模板 ID 配置 |

### 4.7 `admin` — 管理端（全部要求 `role === 'admin'`）
| action | 入参 | 出参 |
|---|---|---|
| `check` | 无 | `{ isAdmin: Boolean }` |
| `stats` | `{ range=7 }` | 见 §4.8 看板结构 |
| `users` | `{ keyword, authStatus, status, page, size }` | `{ list: [User], total, hasMore }` |
| `auditUser` | `{ userId, pass: Boolean, remark }` | `{ ok: true }` — 同步写 `notices` |
| `setUserStatus` | `{ userId, status }` | `{ ok: true }` |
| `setUserRole` | `{ userId, role }` | `{ ok: true }` |
| `adjustCoins` | `{ userId, amount, remark }` | `{ ok: true }` — 写 `wallet_logs` |
| `categories` | 无 | `{ list }` |
| `saveCategory` | `{ _id?, name, icon, sort, status }` | `{ id }` |
| `deleteCategory` | `{ _id }` | `{ ok: true }` — 有技能引用时拒绝 |
| `skills` | `{ status, keyword, page, size }` | `{ list, total, hasMore }` |
| `auditSkill` | `{ id, status, remark, isTop? }` | `{ ok: true }` — `status` 3=违规下架 / 1=恢复上架；`isTop` 传了就更新置顶态（广场列表按 `isTop` 优先排序） |
| `orders` | `{ status, keyword, page, size }` | `{ list, total, hasMore }` |
| `reports` | `{ status, page, size }` | `{ list, total, hasMore }` |
| `handleReport` | `{ id, result, remark }` | `{ ok: true }` |
| `banners` / `saveBanner` / `deleteBanner` | — | — |
| `config` | 无 | **直接返回 config 对象本身**（字段平铺，不包一层 `{config}`）：`{ registerBonus, orderExpireHours, confirmExpireHours, minCreditToOrder, serviceFee, hotCategories, aboutUs, subscribeTemplates, updateTime }` |
| `saveConfig` | 上述字段的任意子集 | `{ ok: true }` —— 只更新传入的字段。★ 前端保存时应**回传完整表单**（而不是只传改动项），避免后端整体覆盖时把未展示的字段清空 |

### 4.8 `admin.stats` 返回结构（管理端看板直接绑定）
```js
{
  overview: {
    userTotal, userToday, userGrowthRate,      // 用户数
    orderTotal, orderToday, orderGrowthRate,   // 订单量
    coinCirculation,                            // 时间币流通量 = Σ users.coins
    coinFrozen,                                 // 冻结总量
    coinEarned,                                 // 累计产生
    finishRate,                                 // 完成率 0-100
    avgRating,                                  // 平均评分
    authPending, reportPending                  // 待办数
  },
  trend: [{ date: '6/14', users: 3, orders: 8, coins: 12 }],   // 近 N 天，date 为 'M/D'（不补零，直接作 ECharts 类目轴标签）
                                                               // coins 口径 = 当日下单冻结的时间币合计
  hotSkills: [{ name: '吉他入门', value: 23 }],       // 热门技能 TOP8（按订单数）
  categoryDist: [{ name: '学业辅导', value: 31 }],     // 分类分布
  orderStatusDist: [{ name: '已完成', value: 42 }],    // 订单状态分布
  creditDist: [{ name: '100-119', value: 12 }],        // 信用分分布
  topUsers: [{ nickName, avatarUrl, serveCount, creditScore }]  // 活跃用户 TOP5
}
```

### 4.9 `initdb` — 一键初始化
| action | 说明 |
|---|---|
| `init` | 创建 17 个集合并写入种子数据（分类、config、banner、演示用户/技能/订单） |
| `clear` | 清空业务集合（保留 users 里的 admin） |
| `setAdmin` | `{ openid }` 或 `{ studentNo }` 把指定用户设为管理员 |

#### ★ 鉴权模型（两层，别混为一谈）

很多人（包括本项目的初版实现）会把这两件事搞混，结果要么留下提权漏洞，要么把
唯一的引导入口堵死。正确的划分是：

**第 ① 层：云开发控制台调用（`getOpenId()` 为空）**

> **一律放行。**

理由：**控制台本身就是开发者（root）权限** —— 能打开它的人可以直接在「数据库」
页面增删任何集合、修改任何字段。在云函数里再拦一道，**挡不住任何真实攻击，
只会让合法运维卡死**。而且云端测试不经过小程序，本来就拿不到 `OPENID`，
在这里校验登录态等于把引导入口焊死。

**第 ② 层：小程序调用（`getOpenId()` 非空）—— 这才是真正的应用层鉴权**

| 条件 | `init` | `setAdmin` | `clear` |
|---|---|---|---|
| `users` 为空（首次部署） | 放行 | 放行 | 放行 |
| `users` 非空、**无任何 admin** | 放行（引导模式） | 放行（仅用于引导第一个管理员） | 放行 |
| 已有 admin，调用者是 admin | 放行 | **403**，改用 `admin.setUserRole` | 放行 |
| 已有 admin，调用者非 admin | **403** | **403** | **403** |

「引导模式」（无 admin 时放行）是必需的，否则会死锁：
没有管理员 → `init` 被拒 → 建不了数据 → 也产生不了第一个管理员。

#### 踩过的三个坑（都是真实发生过的）

1. **`init` 开头调了 `requireOpenId()`** → 云端测试直接返回
   `{"code":401,"msg":"请先登录"}`，`init` 永远跑不起来。
   **规则：`init` / `clear` 一律用 `getOpenId()`，不允许前置校验登录态。**
2. **`setAdmin` 完全不鉴权** → 提权漏洞：任何人只要知道云函数名，
   就能把自己的 `openid` 提升为管理员。**规则：小程序调用时限制在「尚无 admin」。**
3. **只按「有没有管理员」判据、不区分调用来源** → 一旦系统里有了管理员，
   控制台就再也调不动 `init`（因为控制台没有登录态），
   仍然是一个死锁，只是从「没管理员」换成了「有管理员」。
   **规则：先判来源，再判角色。**

---

## 5. 订单状态机（★ 答辩必讲）

```
                  ┌──────────────────────────────────────┐
                  │  买家下单 create                      │
                  │  · 校验余额 ≥ price                   │
                  │  · coins -= price, frozenCoins += price│
                  │  · 写 wallet_log: freeze              │
                  └───────────────┬──────────────────────┘
                                  ▼
                          ┌───────────────┐
      卖家 reject ────────▶│    waiting    │◀──── 超时 24h 系统自动取消
      (解冻退回买家)       │    待接单      │
                          └───────┬───────┘
                                  │ 卖家 accept
                                  ▼
                          ┌───────────────┐
      买家/卖家 cancel ───▶│    ongoing    │
      (解冻退回买家,        │    服务中      │
      扣违约方信用分)       └───────┬───────┘
                                  │ 卖家 finish（线下服务完成）
                                  ▼
                          ┌───────────────┐
                          │  confirming   │
                          │   待买家确认   │
                          └───────┬───────┘
                    买家 confirm  │  超时 72h 系统自动确认
                                  ▼
                          ┌───────────────┐
                          │   finished    │  冻结额真正扣除并打给卖家
                          │    已完成      │  双方 +2 信用分
                          └───────┬───────┘
                                  │ 双方互评
                                  ▼
                          信用分按星级加权变化
```

**状态文案与颜色**（`utils/constants.js` 中定义）：
| status | 中文 | 颜色 token |
|---|---|---|
| `waiting` | 待接单 | `--c-warn` |
| `ongoing` | 服务中 | `--c-info` |
| `confirming` | 待确认 | `--c-accent` |
| `finished` | 已完成 | `--c-success` |
| `canceled` | 已取消 | `--c-t3` |
| `closed` | 已关闭 | `--c-t3` |

---

## 6. 时间币与信用分算法

### 6.1 时间币（不可充值 / 不可提现）
- 注册赠送 `config.registerBonus`（默认 5）
- 下单即冻结（`coins → frozenCoins`），完成才真正转移给服务方
- 取消/拒单/超时 → 解冻退回买家
- 管理员可通过 `admin.adjustCoins` 调整（写流水，用于纠纷仲裁）
- **三种余额口径**：`coins`（可用）、`frozenCoins`（冻结）、`coins + frozenCoins`（总资产）

### 6.2 信用分（初始 100，区间 [0,150]）
| 事件 | 变化 | reason key |
|---|---|---|
| 订单完成（双方） | `+2` | `order_finish` |
| 收到 5 星 | `+1` | `review_5` |
| 收到 4 星 | `0` | `review_4` |
| 收到 3 星 | `-1` | `review_3` |
| 收到 2 星 | `-2` | `review_2` |
| 收到 1 星 | `-3` | `review_1` |
| 接单后取消 / 爽约 | `-5` | `cancel_after_accept` |
| 举报核实成立 | `-10` | `report_valid` |
| 连续 5 单按时完成 | `+3` | `ontime_streak` |
| 管理员手动调整 | 任意 | `admin_adjust` |

**评价加权平均**（用于展示「综合评分」）：
```
w_i = 0.9 ^ (距今小时数 / 24)       // 时间衰减：越近的评价权重越高
综合评分 = Σ(score_i × w_i) / Σ(w_i)
```

**信用等级**：
| 分数 | 等级 | 权益 |
|---|---|---|
| `120-150` | 极佳 `excellent` | 可同时进行 5 单，广场展示「信用之星」角标 |
| `100-119` | 优秀 `good` | 可同时进行 3 单 |
| `80-99` | 良好 `normal` | 可同时进行 2 单 |
| `60-79` | 一般 `weak` | 仅可同时进行 1 单 |
| `0-59` | 受限 `limited` | 禁止下单，仅可浏览 |

### 6.3 徽章（`utils/credit.js` 中定义规则，云函数 `user.badges` 计算）

> ⚠️ **维护提醒**：徽章规则存在于三处，改动时必须同步 ——
> ① `Campus Time Bank/utils/constants.js` 的 `BADGES`（展示元数据：名称/图标/颜色/描述）
> ② `Campus Time Bank/utils/credit.js` 的 `calcBadges()`（前端即时预判，用于展示「还差什么」）
> ③ `cloudfunctions/user/index.js` 顶部的 `BADGES` + `computeBadges()`（**服务端权威**，结果写回 `users.badges`）
>
> 为什么不能合并：微信云函数独立打包，无法 require 小程序端代码；这是平台限制而非设计失误。
> 答辩若被问到，答「前端预判 + 服务端权威，三处显式标注同步要求」。

| id | 名称 | 图标 | 条件 |
|---|---|---|---|
| `newbie` | 初出茅庐 | 🌱 | 完成首单 |
| `ontime` | 守时达人 | ⏰ | `stats.ontimeStreak ≥ 5` |
| `warm` | 热心助人 | ❤️ | 完成「提供技能」≥ 10 单 |
| `expert` | 技能达人 | 🎯 | 同一分类完成 ≥ 5 单且平均评分 ≥ 4.5 |
| `trust` | 信用之星 | ⭐ | `creditScore ≥ 120` |
| `popular` | 人气之星 | 🔥 | 技能被浏览 ≥ 500 次 |
| `social` | 社交达人 | 💬 | 收到评价 ≥ 20 条 |

---

## 7. 页面地图

### 主包 `pages/`
| 路径 | 说明 | tabBar |
|---|---|---|
| `square/square` | 技能广场（分类横滑 + 搜索 + 附近/最新/热门排序） | ① |
| `search/search` | 搜索结果页（历史记录 + **热门分类**（读 `config.hotCategories`）+ 热门搜索） | |
| `skill/detail/detail` | 技能详情 + 联系 TA（`message.openChat`）+ 立即预约 | |
| `publish/publish` | 发布技能 / 求助（二选一切换） | ✚ 凸起 |
| `map/picker/picker` | 地图选点（`wx.chooseLocation` + 定位） | |
| `order/list/list` | 订单列表（买到的 / 我接的，状态筛选） | ② |
| `order/detail/detail` | 订单详情 + 状态机操作按钮 + 时间轴 | |
| `order/create/create` | 下单确认（余额校验 + 留言 + 期望时间） | |
| `wallet/wallet` | 时间币钱包（余额/冻结/明细/趋势） | ③ |
| `mine/mine` | 个人中心 | ④ |
| `user/profile/profile` | 编辑资料 | |
| `user/home/home` | 他人主页（技能 + 评价） | |
| `user/skills/skills` | 我的发布 / 我的接单 | |
| `auth/campus/campus` | 校园认证提交 | |
| `review/create/create` | 发表评价（星级 + 标签 + 文字） | |
| `review/list/list` | 我的评价（收到 / 发出） | |
| `chat/list/list` | 消息列表（会话 + 系统通知入口） | |
| `chat/room/room` | 聊天室（★ `watch` 实时） | |
| `notice/list/list` | 系统通知 | |
| `credit/detail/detail` | 信用分详情 + 变化明细 | |
| `badge/badge` | 徽章墙 | |
| `report/report` | 举报提交 | |
| `about/about` | 关于 / 用户协议 / 平台规则 | |

### 分包 `packageAdmin/pages/`
| 路径 | 说明 |
|---|---|
| `dashboard/dashboard` | 数据看板（ECharts：折线趋势 + 饼图 + 柱状 TOP8 + 雷达） |
| `users/users` | 用户管理（搜索/封禁/设管理员/调整时间币） |
| `auth-audit/auth-audit` | 校园认证审核（大图查看 + 通过/驳回） |
| `categories/categories` | 技能分类管理（增删改排序） |
| `skills/skills` | 技能审核与下架 |
| `orders/orders` | 订单管理 |
| `reports/reports` | 举报处理 |
| `settings/settings` | 参数配置 + 轮播图管理 |

---

## 8. 客户端 API 层约定（`utils/api.js`）

页面**禁止**直接调用 `wx.cloud.callFunction`，一律走：
```js
const api = require('../../utils/api')

const res = await api.skill.list({ page: 1, size: 10 })
// res 即为云函数返回的 data 字段（api 内部已剥离 code/msg，失败时 throw）
```
- 失败统一 `throw new Error(msg)`，页面用 `try/catch` + `util.toast(e.message)`。
- `api.raw(name, action, payload)` 为逃生舱。
- `app.globalData.MOCK = true` 时（`envList.js` 中配置）走 `utils/mock.js`，**无需云环境即可预览全部 UI**。

---

## 9. 实时聊天实现（技术亮点）

```js
// pages/chat/room/room.js
this.watcher = wx.cloud.database()
  .collection('messages')
  .where({ chatId })
  .orderBy('createTime', 'asc')
  .watch({
    onChange: snapshot => {
      // snapshot.docs 为全量当前结果集，直接 setData
      this.setData({ messages: snapshot.docs, scrollInto: 'msg-bottom' })
    },
    onError: err => { /* 降级为 3s 轮询 */ }
  })
// onUnload 必须关闭，否则连接泄漏
this.watcher && this.watcher.close()
```
- `messages` 集合权限设为「所有用户可读，仅创建者可写」→ 客户端只能**读**，**写必须过 `message.send` 云函数**（服务端校验二人确为会话成员）。
- 断线降级：`onError` 后切换为 `setInterval` 轮询 `message.history`，并提示「实时连接已断开，已切换轮询」。

---

## 9.5 ★ 离线层与云函数的「行为等价」要求（本项目最大的隐性风险）

`Campus Time Bank/utils/mock.js` 不是一份随便编的假数据，它是**云函数的离线镜像**：
同一批 action、同样的返回结构、同样的业务规则。这样做的收益是「零云环境也能完整演示」，
代价是**两套实现会悄悄漂移** —— 而且漂移的表现往往是「离线演示时像坏了」，很难排查。

开发过程中已经真实踩到 3 次，全部是 mock 落后于云函数：

| # | 漂移点 | 症状 | 已修 |
|---|---|---|---|
| 1 | `publicUser()` 未过滤 `realName` | 云函数侧补了隐私过滤，mock 侧没有 → 离线看他人主页会暴露真实姓名 | ✔ |
| 2 | `order.detail` 对管理员返回 `role: 'seller'` | 云函数已改成 `'admin'`，mock 依旧 → 离线走不到「管理员只读」分支 | ✔ |
| 3 | `skill.list` 未按 `isTop` 优先排序 | 云函数所有排序模式都以 `isTop desc` 为首键，mock 没有 → 管理端点「置顶」在离线下**毫无反应**，看起来像按钮坏了 | ✔ |

### 维护规则（改任意一侧时必须同步）

1. **改云函数的返回结构或业务规则后，立刻检查 `mock.js` 的对应 handler。**
2. 判断标准不是「字段名一样」，而是**行为一样**：同样的入参要得到同样的结果与同样的错误码。
3. 每个 action 改完后至少跑一次 `node tools/smoke-test-mock.js`（它会把 75 个 action 全调一遍）。
4. 结构层面的漂移由 `node tools/check-project.mjs` 兜底（action 名、返回字段名）；
   **行为层面的漂移目前只能靠人工对照** —— 这是本项目已知的工程局限，答辩时可如实说明，
   并指出改进方向：把「业务规则」抽成两端共享的纯函数表（JSON 规则 + 各自的执行器）。

---

## 10. 地理位置方案（技术亮点）

**不依赖任何第三方 SDK / Key**，全部使用云开发原生能力：
- **附近技能**：`skills.location` 存 `db.Geo.Point`，云函数用
  `db.collection('skills').where({ location: _.geoNear({ geometry: db.Geo.Point(lng, lat), maxDistance: radius }) })`
- **地图选点**：`wx.chooseLocation()` 原生能力，返回 `{ name, address, latitude, longitude }`
- **定位**：`wx.getLocation({ type: 'gcj02' })`，需在 `app.json` 声明 `permission.scope.userLocation`
- **可选增强**：`utils/qqmap.js` 封装腾讯位置服务逆地址解析，需自备 Key，**不配置也能跑通全部功能**

---

## 11. 订阅消息（技术亮点）

- 触发点：下单成功（通知卖家）、接单成功（通知买家）、服务完成（通知买家）、确认完成（通知卖家）
- 客户端 `wx.requestSubscribeMessage({ tmplIds })` 授权，模板 ID 从 `message.subConfig` 拉取（也可写死在 `envList.js`）
- 服务端 `cloud.openapi.subscribeMessage.send(...)`，失败**不阻断主流程**（try/catch 吞掉并记日志）

---

## 12. 云函数附加配置（`config.json`）

云开发的部分开放接口需要显式声明权限，否则调用会报 `errCode: -604100 / 无权限`。

| 云函数 | 文件 | 配置内容 | 用途 |
|---|---|---|---|
| `login` | `cloudfunctions/login/config.json` | `openapi: ["phonenumber.getPhoneNumber"]` | 手机号快速验证 |
| `message` | `cloudfunctions/message/config.json` | `openapi: ["subscribeMessage.send"]` | 发送订阅消息 |
| `order` | `cloudfunctions/order/config.json` | 定时触发器 `0 */10 * * * * *`（每 10 分钟） | 兜底处理超时订单 |

### 12.2 ★ 云函数超时时间（`config.json` 管不了，必须在控制台改）

微信云函数的 **`timeout` 默认是 3 秒**（官方范围 1–300 秒）。
`config.json` **不支持**声明超时时间，只能在云开发控制台
（云函数 → 函数配置）或 CLI 调整。

`initdb` 的 `init` 要创建 17 个集合并写入 60+ 条种子数据，
**首次冷启动下 3 秒必然不够**，会返回：

```json
{"errorCode":-1,"errorMessage":"Invoking task timed out after 3 seconds","statusCode":433}
```

**部署清单里必须包含这一步：把 `initdb` 的超时改到 20 秒。**

代码侧也做了对应的优化：`seedDocs` / `clearCollection` 用 `mapLimit()` 并发执行
（并发数 8 / 10），把串行的 120+ 次往返压到 1/8 左右 —— 这是必需的，
但**不能替代调大超时**，因为首次建集合的开销无法压缩。

另外 `init` 是**幂等**的（按 `_id` 跳过已存在的数据），
所以超时中断后重跑会从断点继续，不会重复插入。

### 12.1 订单超时的「双保险」设计

定时触发器**不保证**准时（云开发存在触发抖动，且函数冷启动有延迟），
所以超时处理做了两层：

1. **定时触发器**（`order.autoTask`，每 10 分钟）：批量扫描超时订单并处理，
   不依赖任何用户在线 —— 这是主路径。
2. **惰性检查**（`order.counts` 被任意用户调用时）：顺手检查并处理与自己相关的超时订单 —— 这是兜底。

答辩时如果被问「定时任务失败怎么办」，就用这个双保险回答。

---

## 13. 自定义组件接口（冻结）

页面通过**绝对路径**引用组件，例如 `"skill-card": "/components/skill-card/index"`。

| 组件 | properties | events |
|---|---|---|
| `user-avatar` | `url` `name` `size('s'\|'m'\|'l'\|'xl'\|数字rpx)` `showCredit` `credit` `verified` `ring` | `bindtap` |
| `empty` | `icon` `text` `desc` `btn` `btnType` `compact` | `bindaction` |
| `star-rate` | `value` `size` `editable` `showValue` `emptyIcon` | `bindchange` → `{value}` |
| `skill-card` | `item` `showAuthor` `showDistance` `compact` | `bindcard` → `{item}`；`bindauthor` → `{openid}` |
| `order-card` | `item` `role` `showActions` `showRoleTag` | `bindcard` → `{item}`；`bindaction` → `{action, item}`，action ∈ `accept`\|`reject`\|`cancel`\|`finish`\|`confirm`\|`chat`\|`review` |
| `badge-wall` | `list` `ownedList` `cols` `showLocked` `showDesc` | `bindtap` → `{badge}` |
| `loading-skeleton` | `type('skill'\|'order'\|'list'\|'detail'\|'grid')` `count` | — |
| `nav-bar` | `title` `bg` `color` `showBack` `fixed` `placeholder` `backIcon`（需页面 `navigationStyle: custom`） | — |

| 自定义 tabBar | 说明 |
|---|---|
| `custom-tab-bar/index` | 4 个 tab + 中间凸起「发布」按钮（`navigateTo` 到 `pages/publish/publish`）。tab 页在 `onShow` 里调 `app.selectTab(this, index)` 同步选中态；角标由 `app.refreshTabBadge()` 统一刷新。 |

**封面降级策略（重要）**：项目**不含任何图片资源**。
所有图片位（技能封面、Banner、头像）都有「渐变 + emoji / 昵称首字」的降级方案，
因此零素材也能有完整视觉，答辩演示不会出现白块。

---

## 14. 编码规范（强制）

0. **★ `require` 层级与组件引用路径（本项目最高频的错误来源，务必照做）**

   小程序页面的路径层级很容易数错，规则如下：

   | 页面位置 | 示例 | 回 `Campus Time Bank/` 的前缀 |
   |---|---|---|
   | `pages/x/x.js` | `pages/square/square.js` | `../../utils/...` |
   | `pages/x/y/y.js` | `pages/order/detail/detail.js` | `../../../utils/...` |
   | `packageAdmin/pages/x/x.js` | `packageAdmin/pages/users/users.js` | `../../../utils/...` |

   **组件一律用绝对路径**（以 `/` 开头，相对 `Campus Time Bank/` 根），这样页面在哪一层都不会错：
   ```json
   "usingComponents": {
     "user-avatar": "/components/user-avatar/index",
     "ec-canvas": "/packageAdmin/components/ec-canvas/ec-canvas"
   }
   ```

   写完务必在项目根目录执行一次自检：
   ```bash
   node tools/check-project.mjs
   ```
   它会揪出所有「require 路径不存在」「组件引用失效」「api 方法不存在」的错误。

1. **不引入任何 npm 第三方包**（除 `wx-server-sdk`），保证 `npm install` 零障碍。

1.5 **★ 严禁用 PowerShell 的 `Set-Content` / `Out-File` 改写项目源文件**

   本项目已因此踩过一次坑：`Get-Content -Raw | Set-Content -Encoding UTF8` 在
   Windows PowerShell 5.1 下会按系统 ANSI 码页读取再用 UTF-8 写出，
   导致**中文被二次编码**，文件出现乱码甚至 `SyntaxError`（`campus.js` 曾因此报错）。

   改写源文件一律使用编辑器的 write/edit 能力（本项目的 AI 协作流程用 write 工具）。
   如果只想批量检查编码，用只读命令：
   ```powershell
   # 只读校验：确认文件是合法 UTF-8 且不含替换字符 U+FFFD
   [System.IO.File]::ReadAllText($p, [System.Text.Encoding]::UTF8).Contains([char]0xFFFD)
   ```
   提交前全量自查：`node tools/check-project.mjs`（含 JSON 解析与 require 解析）。
2. 每个页面 4 件套 `js/json/wxml/wxss`；`json` 必须写 `{"usingComponents": {}}`（哪怕为空）。
3. 页面样式使用 `styles/theme.wxss` 的 CSS 变量，通过 `app.wxss` 全局 `@import` 后即可在页面直接 `var(--c-primary)`。
4. 所有云函数入口结构：
   ```js
   const { ok, fail, bizError, db, _, C, getUser } = require('./shared')
   exports.main = async (event, context) => {
     const { action } = event
     try {
       switch (action) { /* ... */ }
       default: return fail(400, `未知 action: ${action}`)
     } catch (e) {
       if (e && e.__biz) return fail(e.code, e.message)
       console.error('[fn] error', action, e)
       return fail(500, e.message || '服务异常')
     }
   }
   ```
5. 中文文案统一、标点用全角；金额只出现在时间币语境，禁止出现「¥ / 元 / 付款」等支付词汇。
6. 所有 `setData` 前做空值兜底，禁止把 `undefined` 写进 `data`。
