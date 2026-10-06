# 校园时间银行 · 大学生技能互助平台

> 最后更新：2026-06 | 适用版本：v0.6.3

用「时间币」结算的校园技能互助小程序：**1 次服务 = 若干时间币**，时间币**不可充值、不可提现**，
只能靠帮助他人赚取、靠求助他人消耗。本科毕业设计作品。

`📱 微信小程序原生开发` · `☁️ 微信云开发（云数据库/云函数/云存储）` · `🧩 管理端分包` · `📊 ECharts 数据看板` · `📦 零第三方依赖` · `🔌 离线可预览`

---

## 一、项目亮点

1. **时间币冻结—结算双阶段记账**：下单只把时间币从可用余额划入冻结额（钱仍属买家），确认完成才真正结算给服务方，取消/拒单/超时一律原路解冻 —— 平台时间币总量恒等于 `Σ(coins + frozenCoins)`，账实永远对得上。
2. **云开发数据库事务 + 绝对值写入**：结算涉及「买家减冻结、卖家加余额、订单置完成、双方统计更新」四处改写，全部放在同一个 `db.runTransaction` 里同生共死；事务内统一「先读出来 → 在 JS 里算绝对值 → 写绝对值」，**刻意不用 `_.inc()`**，避免更新指令在事务内的语义不确定性。
3. **并发下单不超卖**：余额校验与扣减在同一事务、同一份快照内完成，后提交的事务遇到写冲突自动重试，重试后读到的是对方已扣减的新余额，不足即抛 409 回滚 ——「够不够」和「扣没扣」是一个原子判断。
4. **超时处理「双保险」**：`order` 云函数配了每 10 分钟的定时触发器（`orderAutoTask`）批量兜底超时单；同时任意用户调 `order.counts` 时顺手做一次惰性检查。定时任务漏跑也不会让买家的时间币被无限期冻结，两条路径共用同一组内部函数且都有状态断言，重复执行是幂等的。
5. **实时聊天用云开发原生 `watch`**：`messages` 集合权限设为「所有用户可读，仅创建者可写」，客户端只拿读权限用于 `db.collection('messages').watch()` 长连接推送，**写入仍强制走 `message.send` 云函数**（服务端校验二人确为会话成员）；`onError` 自动降级为 3 秒轮询，`onUnload` 必关连接防泄漏。
6. **地理位置零第三方依赖**：附近技能用 `db.Geo.Point` + `_.geoNear({ geometry, maxDistance })` 在云函数里算距离，结果自带 `distance` 字段并天然按距离升序；地图选点用原生 `wx.chooseLocation()`。腾讯位置服务仅作为「逆地址解析」的可选增强，不配 Key 也能跑通全部功能。
7. **零素材降级 + 零云环境可预览**：项目不含任何图片资源，技能封面/Banner/头像全部有「渐变 + emoji / 昵称首字」降级方案，答辩演示不会出现白块；未填 `ENV_ID` 时自动进入离线模式，`utils/mock.js` 用与真实云函数**完全一致**的返回结构撑起全部 65 个接口，`node tools/smoke-test-mock.js` 一键验证。

---

## 二、功能清单

### 2.1 用户端（主包 `pages/`，共 23 个页面）

| 模块 | 页面（`app.json` 中的路径） | 说明 |
|---|---|---|
| 登录与认证 | `pages/square/square`（首页即入口）、`pages/user/profile/profile`、`pages/auth/campus/campus`、`pages/about/about` | 静默登录自动注册并赠送 5 枚时间币；完善昵称头像；提交学生证照片做校园认证；用户协议与平台规则 |
| 技能广场 | `pages/square/square`、`pages/search/search`、`pages/skill/detail/detail` | 分类横滑 + 关键词搜索 + 最新/热门/附近/时间币升降序；详情页浏览量自增、一键预约（带余额与信用分前置校验）、举报入口 |
| 发布技能 | `pages/publish/publish`、`pages/map/picker/picker` | 「我能提供 / 我要求助」二选一切换；价格、时长、图片（≤3）、标签（≤5）；地图选点 |
| 订单 | `pages/order/list/list`、`pages/order/detail/detail`、`pages/order/create/create` | 买到的 / 我接的双视角；状态筛选；详情页状态机操作按钮 + 时间轴；下单确认页做余额与信用分校验 |
| 时间币 | `pages/wallet/wallet` | 可用余额 / 冻结额 / 累计赚取 / 累计消耗；收支明细分类型筛选；7 日趋势与分类占比 |
| 信用与徽章 | `pages/credit/detail/detail`、`pages/badge/badge` | 信用分等级与权益；变动明细（reason key 可读化）；七枚徽章墙（含未点亮状态） |
| 消息 | `pages/chat/list/list`、`pages/chat/room/room`、`pages/notice/list/list` | 会话列表 + 系统通知入口；聊天室 `watch` 实时；通知分类型筛选、全部已读 |
| 个人中心 | `pages/mine/mine`、`pages/user/home/home`、`pages/user/skills/skills` | 个人中心聚合（发布/接单/购买/未读）；他人主页（技能 + 评价）；我的发布 / 我的接单 |
| 评价与举报 | `pages/review/create/create`、`pages/review/list/list`、`pages/report/report` | 星级 + 标签 + 文字评价、匿名、被评人回复；收到/发出的评价；技能/用户/订单/评价四类举报 |

> `app.json` 的 `tabBar` 为 4 项 + 中间凸起「发布」按钮（`custom-tab-bar/`）：广场 / 订单 / 时间币 / 我的。

### 2.2 管理端（分包 `packageAdmin/pages/`，8 个页面）

| 页面 | 说明 |
|---|---|
| `pages/dashboard/dashboard` | 数据看板：ECharts 共 7 张图（趋势折线、分类饼图、热门技能横向柱、订单状态饼图、信用分分布柱、平台雷达、完成率仪表盘） |
| `pages/users/users` | 用户管理：搜索、封禁/解封、设为管理员、调整时间币 |
| `pages/auth-audit/auth-audit` | 校园认证审核：大图查看、通过/驳回 |
| `pages/categories/categories` | 技能分类管理：增删改与排序 |
| `pages/skills/skills` | 技能审核与违规下架 |
| `pages/orders/orders` | 订单管理 |
| `pages/reports/reports` | 举报处理 |
| `pages/settings/settings` | 参数配置（注册赠送/超时小时数/最低信用分）+ 轮播图管理 |

> 分包在 `pages/mine/mine` 上配置了 `preloadRule`（`network: all`），进入「我的」时预热管理端分包。
> 8 个管理端页面均已落地（`js/json/wxml/wxss` 四件套齐全），
> `node tools/check-project.mjs` 的页面完整性检查为全通过。

---

## 三、技术架构

```
┌──────────────────────────────────────────────────────────────────────────┐
│  小程序端（微信原生，无 npm 依赖）                                        │
│                                                                          │
│  pages/ 23 个页面          packageAdmin/ 管理端分包（含 ECharts）         │
│      │                            │                                      │
│      └──────────┬─────────────────┘                                      │
│                 ▼                                                        │
│        utils/api.js  ★ 唯一网络出口（把 action 映射到云函数）             │
│                 │                                                        │
│        utils/cloud.js  超时控制 · 错误归一 · 失败重试 · 离线分发          │
│                 │                                                        │
│        utils/mock.js ── MOCK 模式（未填 ENV_ID 时）→ 纯前端模拟数据       │
│                 │                                                        │
│        components/ 8 个公共组件 + custom-tab-bar                          │
│        styles/theme.wxss 设计 token（禁止硬编码色值）                     │
└─────────────────────────────────┬────────────────────────────────────────┘
                                  │  wx.cloud.callFunction({ name, data:{action,...} })
                                  ▼
┌──────────────────────────────────────────────────────────────────────────┐
│  云函数层（Node.js + wx-server-sdk，8 个函数 / 65 个 action）             │
│                                                                          │
│   login    skill    order★    wallet    user    message    admin   initdb │
│     │        │        │         │        │        │         │       │     │
│     └────────┴────────┴────┬────┴────────┴────────┴─────────┴───────┘     │
│                            ▼                                             │
│              cloudfunctions/_shared/index.js  ★ 共享层唯一源             │
│   db · _ · $ · ok/fail/bizError/assert · wrap · getUser/requireUser/      │
│   requireVerified/requireAdmin · getConfig · changeCredit · addWalletLog  │
│   addNotice · sendSubscribe · paginateQuery · genOrderNo · 快照构造       │
│                            │                                             │
│              tools/sync-shared.mjs 复制到每个函数的 shared/ 子目录        │
│              （云开发每个函数独立打包，无法跨目录 require）               │
└─────────────────────────────────┬────────────────────────────────────────┘
                                  │
              ┌───────────────────┼────────────────────┐
              ▼                   ▼                    ▼
     ┌─────────────────┐  ┌──────────────┐  ┌──────────────────┐
     │  云数据库 13 个  │  │  云存储      │  │  开放接口        │
     │  users/skills/  │  │  头像、认证  │  │  手机号验证      │
     │  orders/reviews │  │  照片、技能  │  │  订阅消息        │
     │  wallet_logs 等 │  │  图片 fileID │  │  定时触发器      │
     └─────────────────┘  └──────────────┘  └──────────────────┘
        ├ 11 个集合：仅管理端可读写（读写全走云函数）
        └ chats / messages：所有用户可读、仅创建者可写（客户端 watch 实时聊天）
```

---

## 四、目录结构

```
campus-time-bank/
├── project.config.json            小程序项目配置（miniprogramRoot / cloudfunctionRoot，appid 默认 touristappid）
├── .gitignore
├── README.md                      ← 本文件
│
├── Campus Time Bank/                   小程序前端
│   ├── app.js                     入口：云开发初始化、并发登录合并、定位缓存、事件总线、tabBar 角标
│   ├── app.json                   页面注册（23 主包页 + 1 个管理端分包）、window、tabBar、定位权限声明
│   ├── app.wxss                   全局样式入口（@import theme/common）
│   ├── envList.js                 ★ 部署第一步：ENV_ID / SUBSCRIBE_TEMPLATES / QQMAP_KEY / MOCK_OVERRIDE
│   ├── sitemap.json               搜索索引配置
│   ├── custom-tab-bar/            自定义 tabBar（4 tab + 中间凸起「发布」按钮）
│   ├── styles/
│   │   ├── theme.wxss             设计 token：颜色 / 渐变 / 圆角 / 阴影 / 字号 / 间距
│   │   └── common.wxss            原子类与通用样式
│   ├── utils/
│   │   ├── api.js                 ★ 唯一网络出口，把 65 个 action 映射到 8 个云函数
│   │   ├── cloud.js               云函数调用封装：超时、重试、错误归一、MOCK 分发
│   │   ├── mock.js                离线模拟数据层（与真实云函数返回结构完全一致）
│   │   ├── constants.js           枚举 / 字典 / 状态机文案 / 徽章 / 信用规则
│   │   ├── credit.js              信用分与徽章算法（前端展示副本，服务端为准）
│   │   ├── util.js                格式化、节流防抖、校验、图片选择、定位、距离计算
│   │   └── qqmap.js               腾讯位置服务逆地址解析（可选增强，不配 Key 也能跑）
│   ├── components/                8 个公共组件
│   │   ├── nav-bar/               自定义导航栏（适配胶囊）
│   │   ├── empty/                 空态
│   │   ├── loading-skeleton/      骨架屏（5 种 type）
│   │   ├── skill-card/            技能卡片
│   │   ├── order-card/            订单卡片（含状态机操作按钮）
│   │   ├── user-avatar/           头像 + 信用分角标 / 认证标记
│   │   ├── star-rate/             星级评分（可只读可交互）
│   │   └── badge-wall/            徽章墙
│   ├── pages/                     23 个主包页面（结构见 §2.1）
│   └── packageAdmin/              管理端分包
│       ├── pages/                 管理端 8 个页面（js/json/wxml/wxss 四件套齐全）
│       ├── components/ec-canvas/  ECharts 小程序 Canvas 适配器 + echarts.js（约 1MB，放分包不占主包体积）
│       └── utils/
│           ├── chart.js           7 类图表 option 生成器（折线/饼/柱/信用分布/雷达/仪表盘）
│           ├── guard.js           管理端页面守卫：非管理员 toast + 返回（失败降级 reLaunch）
│           └── admin.wxss         管理端公共样式
│
├── cloudfunctions/                云函数（8 个业务函数 + 1 个共享源目录）
│   ├── _shared/index.js           ★ 共享层唯一源（改完必须跑 tools/sync-shared.mjs）
│   ├── login/                     登录 / 资料 / 校园认证 / 手机号 / 定位（6 个 action）
│   ├── skill/                     广场 / 详情 / 发布 / 编辑 / 下架 / 分类 / 轮播 / 举报（9 个 action）
│   ├── order/                     ★ 订单与时间币事务核心（9 个 action + autoTask 定时入口）
│   ├── wallet/                    时间币余额 / 流水 / 统计（3 个 action）
│   ├── user/                      个人中心 / 信用分 / 徽章 / 评价（7 个 action）
│   ├── message/                   聊天 / 通知 / 订阅消息（9 个 action）
│   ├── admin/                     管理端全部接口（20 个 action）
│   ├── initdb/                    一键初始化：建集合 + 种子数据 / 清库 / 设管理员（3 个 action）
│   └── <每个函数>/shared/index.js ★ 构建产物：由 sync-shared.mjs 生成（8 份副本共 3,392 行，不计入手写量，不要手改）
│
├── tools/                         构建、自检与测试脚本（13 个文件）
│   ├── sync-shared.mjs            把 _shared 同步进每个云函数的 shared/
│   ├── check-project.mjs          项目结构自检 + 规模统计
│   ├── smoke-test-mock.js         离线数据层冒烟测试（65 个 action 全量跑一遍）
│   ├── fetch-echarts.mjs          重新下载 / 升级 ECharts 适配器到 ec-canvas
│   ├── .smoke-tmp/                冒烟测试临时产物目录
│   └── test-cloudfunctions/       ★ 云函数离线回归测试（零依赖、不连云环境）
│       ├── run.js                 入口：加载案例 → 分组报告 → 退出码
│       ├── README.md              测试说明（测什么 / 怎么跑 / 原理 / 已知局限）
│       ├── stub/wx-server-sdk.js  内存版 SDK（含事务快照隔离、写冲突检测与重试）
│       ├── lib/harness.js         模块解析劫持 + 断言引擎 + 报告渲染
│       ├── lib/fixtures.js        夹具：用户 / 技能 / 配置 / 订单
│       └── cases/                 4 个案例文件 → 88 组 / 1901 条断言
│
└── docs/                          设计文档
    ├── ARCHITECTURE.md            ★ 架构与接口契约（唯一事实来源，冻结契约）
    ├── 部署指南.md                 手把手部署
    ├── 数据库设计.md               13 张集合表结构 / ER 图 / 索引 / 数据字典
    ├── 核心机制说明.md             6 个核心机制的深挖说明
    ├── 答辩材料.md                 讲稿 / PPT 大纲 / 22 问 / 演示脚本 / 数字速查
    └── 测试用例.md                 50+ 条功能测试用例 + 自动化测试说明
```

---

## 五、快速开始

### 方式 A：先看效果（无需云环境，30 秒）

```bash
# 1. 克隆后直接用微信开发者工具「导入项目」，选择本目录
#    appid 保持 touristappid 即可（测试号，仅本地预览）

# 2. 什么都不用改：Campus Time Bank/envList.js 里 ENV_ID 默认为空字符串
#    → MOCK 自动为 true → 全部页面跑在 utils/mock.js 之上，数据齐全

# 3. （可选，命令行验证）在项目根目录执行：
node tools/smoke-test-mock.js
#    期望输出：通过 65  失败 0  跳过 0     ← 离线数据层：65 个 action 全量跑一遍
node tools/test-cloudfunctions/run.js
#    期望输出：通过 1901 / 失败 0          ← 云函数离线回归：1901 条断言 / 88 组
```

离线模式能看：广场列表与排序、技能详情、发布表单、订单全状态流转、时间币流水与趋势、
信用分与徽章、聊天（2 秒轮询模拟实时）、系统通知、管理端看板（ECharts 真图）。

### 方式 B：接入真实后端（5 步）

```bash
# 1. 把 Campus Time Bank/envList.js 的 ENV_ID 改成你的云开发环境 ID
#    （填了非空值后 MOCK 自动变 false，无需额外开关）

# 2. 同步云函数共享层（修改过 _shared 才需要；首次部署也建议跑一次）
node tools/sync-shared.mjs

# 3. 微信开发者工具里对 cloudfunctions/ 下每个云函数右键
#    「上传并部署：云端安装依赖」（共 8 个：login skill order wallet user message admin initdb）

# 4. 调 initdb 云函数初始化数据库：云开发控制台 → 云函数 → initdb → 测试 → 传 {"action":"init"}

# 5. 把自己设为管理员：传 {"action":"setAdmin","openid":"你的openid"}
#    （openid 可在首次登录后从云开发控制台 users 集合看到）
```

详细步骤、13 张集合的权限配置表与常见报错排查见 **[docs/部署指南.md](docs/部署指南.md)**。

---

## 六、可用脚本

所有脚本均在**项目根目录**执行。

> **懒人版**：`npm test` 一次跑完前三套（结构 + 离线数据 + 云函数逻辑），约 3 秒。

### 6.1 代码级测试（零依赖、零配置，直接跑）

| 命令 | 作用 | 何时用 |
|---|---|---|
| `node tools/sync-shared.mjs` | 把 `cloudfunctions/_shared/index.js` 复制到每个云函数的 `shared/` 子目录（8 个副本） | **每次修改 `_shared` 后必跑**；否则上传的云函数用的还是旧共享代码（云开发每个函数独立打包，无法跨目录 `require('../_shared')`）。⚠️ 副本是**构建产物**，不要手改，也不计入代码量 |
| `node tools/check-project.mjs` | 结构自检：页面四件套完整性、`usingComponents` 路径、页面调用的 `api.x.y()` 是否存在、mock 覆盖率（65/65）、`require` 相对路径、tabBar 声明、云函数目录结构、事件绑定、`wx:for` 的 `wx:key`、**`<text>` 内容跨行**（真机会因此偏移）、模板变量、`app.*` 调用；并输出代码规模统计 | 提交前 / 答辩前跑一次；**当前全通过** |
| `node tools/smoke-test-mock.js` | **离线数据层冒烟**：在 Node 里把 `api.js` 声明的 **65 个 action** 全部真实调用一遍（含订单状态机全流程断言：拒单退款、取消不扣分、确认结算到账、评价写入），验证离线模式下每个接口都有数据 | 改完 `mock.js` 或 `api.js` 后；答辩彩排前的保险 |
| `node tools/test-cloudfunctions/run.js` | **★ 云函数离线回归测试**：纯 Node、零依赖、不连云环境，用内存版 `wx-server-sdk` 把 `order`（时间币事务核心）与 `wallet` 的业务规则全跑一遍 —— **88 组 / 1901 条断言 / 114 次数据库事务（含 6 次写冲突自动重试）**，约 1 秒跑完。可直接演示「并发下单不会超卖」「时间币账实守恒」「超时自动结算幂等」。详见 [tools/test-cloudfunctions/README.md](tools/test-cloudfunctions/README.md) | 改完 `order` / `wallet` / `_shared` 后立刻跑；也可接进 CI（退出码 0/1） |
| `node tools/fetch-echarts.mjs` | 从 CDN 重新下载 `ec-canvas.js / wx-canvas.js / echarts.js` 等 6 个文件到 `packageAdmin/components/ec-canvas/` | 仓库里已包含下载好的文件，**正常开发不需要执行**，仅在升级 ECharts 版本或文件损坏时用 |

### 6.2 页面级冒烟（需要一次性配置）

| 命令 | 作用 | 前置条件 |
|---|---|---|
| `npm run test:ui` | **★ 一键走遍全部 32 个页面**：用微信官方 `miniprogram-automator` 驱动开发者工具，自动逐个打开 `app.json` 里的每个页面，捕获**未捕获异常**、`console.error`、以及「页面 data 为空（根本没渲染成功）」三种故障，最后给出通过/失败清单 | ① `npm install`（只装 `miniprogram-automator` 这一个开发依赖）<br>② 开发者工具里打开本项目<br>③ **设置 → 安全设置 → 打开「服务端口」**（一次性） |

> `test:ui` 测的是「**页面能不能活着打开**」，不测业务正确性 ——
> 业务正确性由 6.1 的 `test:mock` 与 `test:cf` 负责。两者互补，不是替代关系。
>
> 脚本会自动探测开发者工具的 `cli.bat`（常见安装位置）；装在别处时用环境变量指定：
> `$env:WX_CLI="D:\...\微信web开发者工具\cli.bat"`

---

## 七、文档索引

| 文档 | 内容 |
|---|---|
| [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) | **唯一事实来源**：14 个集合字段、8 个云函数与全部 action、订单状态机、信用分算法、页面地图、设计 token、组件接口、编码规范 |
| [docs/部署指南.md](docs/部署指南.md) | 前置准备 → 导入项目 → 建环境 → 部署云函数 → 初始化数据库 → 集合权限表 → 设管理员 → 云存储 → 订阅消息 → 定位服务 → 报错排查 → 上线检查清单 |
| [docs/数据库设计.md](docs/数据库设计.md) | 设计原则、13 张集合详细表结构、Mermaid ER 图、索引建议、枚举数据字典、数据量估算与分页策略 |
| [docs/核心机制说明.md](docs/核心机制说明.md) | 时间币冻结-结算、订单状态机、并发安全、信用分算法、实时聊天、地理查询 —— 六个机制的「问题 → 方案 → 代码位置 → 关键片段 → 为什么这么设计」 |
| [docs/答辩材料.md](docs/答辩材料.md) | 3 分钟讲稿、13~15 页 PPT 大纲、22 个高频答辩问题与参考答案、5 分钟现场演示脚本、关键数字速查 |
| [docs/测试用例.md](docs/测试用例.md) | 50+ 条可操作测试用例（10 个模块）、边界与异常测试要点、自动化测试说明 |

---

## 八、FAQ

**Q1：为什么用原生小程序，不用 uni-app？**
本项目只上微信一端，云开发能力（`wx.cloud`、`db.watch`、`openapi.subscribeMessage`、定时触发器）是深度绑定的核心，跨端框架反而要在云开发能力上做适配层，收益为负。原生开发还带来两个实际好处：零 npm 依赖（`package.json` 里只有 `wx-server-sdk`），下载即可编译；页面四件套结构简单，答辩时老师随便点开一个文件都能读懂。

**Q2：时间币为什么不能充值？**
这是**设计选择**而非技术限制。一旦允许充值，平台就变成「预付费资金池」，涉及支付资质、资金存管、退款纠纷、洗钱风险，对一个校园互助项目来说是灾难性的复杂度。时间币只锚定「你帮助过别人多少次」，与人民币不产生任何兑换关系，所以余额永远不会成为需要法律合规的真金白银。注册赠送 5 枚只作为起步资金，且是平台凭空发放的记账额度。

**Q3：那为什么不需要微信支付资质？**
因为全流程**没有任何真实资金流动**：时间币的产生（注册赠送、服务收入）与消耗（下单冻结、结算支出）都在 `users.coins` / `users.frozenCoins` 两个字段里完成，云函数只改数值、写 `wallet_logs` 流水，从不调用 `cloud.openapi.*pay*` 或任何支付接口。没有商户号、没有 `wx.requestPayment`，自然不需要支付资质。

**Q4：附近技能为什么不用腾讯位置服务？**
因为云开发已经把「按距离筛选与排序」做成了数据库原生能力：`skills.location` 存 `db.Geo.Point(lng, lat)`，云函数用 `_.geoNear({ geometry, maxDistance })` 查询，**结果自带 `distance` 字段（单位米）且天然按距离升序**，一次查询搞定筛选 + 排序 + 距离计算。若引入腾讯位置服务，就要额外申请 Key、处理配额与签名校验、把经纬度送去第三方换算，只为了拿到本该由数据库直接给出的距离。项目里 `utils/qqmap.js` 保留腾讯位置服务，但只用于「逆地址解析把坐标变成中文地点名」这一件数据库做不了的事，且**不配置 Key 也能跑通全部功能**（地点名降级显示为「校园内」）。

**Q5：实时聊天怎么做的？**
`messages` 集合权限设为「所有用户可读，仅创建者可写」，客户端 `db.collection('messages').where({chatId}).orderBy('createTime','asc').watch({...})` 建立长连接，`onChange` 回调里的 `snapshot.docs` 就是当前全量结果集，直接 `setData` 即可（无需自己算增量）。**读**走这条通道，**写**必须调 `message.send` 云函数 —— 服务端会校验发送者与接收者确实在 `chats.members` 里，防止任意用户伪造消息。`onError`（断线 / 权限变动）后自动关闭 watcher 并降级为 3 秒轮询 `message.history`，同时 toast「实时连接已断开，已切换轮询」；`onUnload` 里必须 `watcher.close()` 并 `clearInterval`，否则长连接泄漏。

**Q6：改完云函数为什么要跑 `sync-shared`？**
微信云开发**每个云函数是独立打包上传的**：上传 `cloudfunctions/order/` 时，云端只能拿到这个目录以内的文件，不能 `require('../_shared')` 去引用兄弟目录。所以共享层的分发方式是「单一源码 + 构建同步」：`cloudfunctions/_shared/index.js` 是唯一手写的源文件，`tools/sync-shared.mjs` 把它复制成 `cloudfunctions/<每个函数>/shared/index.js`，代码里统一写 `require('./shared')`。改完源文件不同步，上传的云函数跑的就是旧逻辑 —— 这是本项目最容易踩的坑，`check-project.mjs` 会专门检查每个函数的 `shared/index.js` 是否存在。

**Q7：离线模式能干什么？不能干什么？**
**能做**：不加任何云环境就让全部 32 个页面（含 8 个管理端页面）跑起来并带真实交互数据 —— 广场分类/排序/搜索、技能详情、下单、订单六个状态的完整流转（含拒单退款、取消不扣分、确认后卖家到账 +2 信用分等断言）、时间币流水与 7 日趋势、信用分与七枚徽章、聊天（2 秒轮询模拟实时）、系统通知、ECharts 真图。适合写论文配图、录演示视频、答辩彩排。

**不能做（这里要说清楚边界）**：验证真实云开发的**网络层与权限层** —— `geoNear` 地理索引、聚合管道、`watch` 长连接推送、真实 `openapi.subscribeMessage` 返回码、单次 `get` 的 1000 条上限、冷启动与并发压测。这些必须部署到真云环境才能测。

所以项目有**两层自动化测试**，各管一段：
① `node tools/smoke-test-mock.js` —— 65 个 action 的**离线数据层冒烟**，保证每个接口都有数据可渲染；
② `node tools/test-cloudfunctions/run.js` —— **云函数业务规则回归**（1901 条断言 / 88 组 / 121 次事务），在内存版 SDK 上真实跑订单状态机与时间币账务，但**不覆盖网络与权限层**。
两者的定位都是「快速回归 + 可演示的证据」，不等于完整的系统测试（见 [tools/test-cloudfunctions/README.md](tools/test-cloudfunctions/README.md) 的「暂时没有覆盖的部分」）。

**Q8：`echarts.js` 有 1MB 太大怎么办？**
它已经被放在**管理端分包** `packageAdmin/` 里，不在主包内：主包体积上限 2MB，而分包上限更大且**不占用主包体积**，普通学生用户从下载到使用全程不会加载它（实测主包约 **559 KB**、管理分包约 **1,177 KB**，都在限额内）。代码分包配置了 `"lazyCodeLoading": "requiredComponents"`，只有管理员进入 dashboard 时才按需下载；`dashboard.js` 里 `data.ec = { lazyLoad: true }`，等接口数据回来后再手动 `echarts.init`，避免初始化空图浪费流量。如果还想更小，可用 `tools/fetch-echarts.mjs` 换成自定义构建的精简版 ECharts（本项目默认用 5.5.1 全量版，7 张图都用得到）。

**Q9：一个微信账号能同时是买家和卖家吗？**
能，这是核心玩法。同一用户的 `orders` 记录里 `buyerId` 或 `sellerId` 命中自己就分别显示「我买到的」和「我接的单」，`order.list` 用 `role` 参数切换视角，`withRole()` 会补上 `role` / `roleText` / `counterpart`（对方信息）三个派生字段。唯一限制是**不能购买自己发布的技能**（`canOrderSkill` 里显式拦截并抛 409）。

**Q10：项目真的没有任何第三方依赖吗？**
是的。前端 `Campus Time Bank/` 下没有 npm 依赖，唯一的外部代码是 ECharts 适配器（放在分包里、随仓库提供）；云函数 `package.json` 的 `dependencies` 里只有微信官方的 `wx-server-sdk ~2.6.3`；`tools/test-cloudfunctions/` 的测试框架**也是自己写的**（`lib/harness.js` 断言引擎 + `stub/wx-server-sdk.js` 内存版 SDK），没有引入 Jest / Mocha。这保证了「下载 → 导入工具 → 编译」零障碍，也避免了答辩机器上 `npm install` 失败的尴尬。

**Q11：为什么代码量统计有两个数字？**
因为 `tools/sync-shared.mjs` 会把 `cloudfunctions/_shared/index.js` 复制成 8 份
`cloudfunctions/<函数>/shared/index.js`，**这 8 份副本共 3,392 行是构建产物，内容完全相同**，
不应计入「手写代码量」。所以：
- **核心手写代码量（小程序端 23,335 + 云函数 4,578）= 27,913 行**；
- 加上工具脚本（2,286 行）与文档（6,171 行）的总量 = **36,370 行**。

> **行数口径**：均为 **`wc -l` 等价口径** —— 按 `\n` 切分计算，
> **空行与注释行都计入**，末尾换行不计为额外一行。任何人可按同口径复算核对。

答辩时如果被问到「两万八千行是不是重复堆的」，主动说明
**「共享层是单一源码 + 构建同步，副本由脚本生成」**，反而是工程规范上的加分项 ——
因为云开发每个云函数独立打包、无法跨目录 `require`，这是该平台下唯一的正确做法。

---

## 九、作者与声明

- **项目名称**：校园时间银行 —— 基于微信云开发的大学生技能互助平台
- **项目性质**：本科毕业设计作品
- **技术栈**：微信小程序原生框架 + 微信云开发（云数据库 / 云函数 / 云存储）+ ECharts for 微信小程序
- **版本**：v0.6.3

**声明**

1. 本项目为**教学与学术用途**的毕业设计作品，非商业产品，未接入任何支付能力。
2. 「时间币」是平台内部的**虚拟计数单位**，与人民币无任何兑换关系，不可充值、不可提现、不可转让，不构成任何形式的代币或预付卡。
3. 项目代码不包含任何真实用户数据；`cloudfunctions/initdb/` 写入的演示用户、技能与订单均为虚构内容。
4. 平台定位为**校园内技能信息与服务撮合工具**，线下服务过程中的安全与纠纷由当事人自行负责，平台通过信用分、举报与管理员仲裁机制提供事后约束。

**许可**

本项目仅供学习、教学与答辩交流使用。转载请注明出处；未经作者许可，不得用于商业用途。

---

> 相关文档：[架构与接口契约](docs/ARCHITECTURE.md) · [部署指南](docs/部署指南.md) · [数据库设计](docs/数据库设计.md) · [核心机制说明](docs/核心机制说明.md) · [答辩材料](docs/答辩材料.md) · [测试用例](docs/测试用例.md)
