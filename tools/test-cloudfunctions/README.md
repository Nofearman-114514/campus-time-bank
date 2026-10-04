# 云函数离线回归测试（`tools/test-cloudfunctions/`）

用一套**纯 Node、零依赖、不连云环境**的测试，把 `order`（时间币事务核心）和 `wallet`
（钱包统计）的全部业务规则跑一遍。既能在改代码后立刻发现回归，也能在答辩现场直接演示
「并发下单不会超卖」「时间币账实守恒」「超时自动结算幂等」这些最容易讲不清的点。

> 当前规模：**88 组 / 1901 条断言 / 121 次数据库事务（其中 7 次写冲突自动重试）**，
> 全部通过约 1 秒。数字会随案例增加而变，以实际输出为准。

---

## 怎么跑

在项目根目录执行：

```bash
node tools/test-cloudfunctions/run.js              # 跑全部案例
node tools/test-cloudfunctions/run.js order        # 只跑文件名含 order 的案例
node tools/test-cloudfunctions/run.js wallet       # 只跑 wallet 案例
```

- **退出码**：`0` = 全部通过，`1` = 有失败（可直接接进 CI）。
- 报告按「组」打印，每组标注 `✓ 全通过` 或 `✗ N 条失败`；失败的断言会打印**期望值与实际值**，
  并在末尾汇总一份失败清单。
- 云函数里的 `console.log/error` 默认被收集起来不打断报告；想看原始日志用
  `TB_TEST_VERBOSE=1 node tools/test-cloudfunctions/run.js`。失败时会自动回显最后 30 行。

一次典型的通过输出：

```
[1/20] 组 0 · 自检：被测模块确实是仓库里的真源码   ✓ 全通过
...
[4/20] 组 3 · ★ 并发防超卖：4 个并发 create 只成功 3 单，coins+frozenCoins 守恒   ✓ 全通过
...
通过 1901 / 失败 0   断言总数 1901
数据库事务 114 次（其中写冲突自动重试 6 次）
```

---

## 目录结构

```
tools/test-cloudfunctions/
├── run.js                      入口：加载案例 → 打印分组报告 → 设置退出码
├── README.md                   本文件
├── stub/
│   └── wx-server-sdk.js        ★ 内存版 wx-server-sdk（含事务的隔离/冲突检测/重试语义）
├── lib/
│   ├── harness.js              模块解析劫持 + 断言引擎 + 报告渲染
│   └── fixtures.js             夹具：用户/技能/配置/订单 + 调用云函数的便捷方法
└── cases/
    ├── order.create.test.js    组 1-4   下单冻结 / 校验错误码 / ★并发防超卖 / 信用等级上限
    ├── order.flow.test.js      组 5-8   accept 并发抢占 / reject·cancel / ★finish→confirm 结算 / list·detail·counts
    ├── order.timeout.test.js   组 9-10  超时兜底（惰性 + autoTask）/ 幂等 / 单批上限
    └── wallet.test.js          组 11-13 wallet.info / logs / stats
```

---

## 原理

### 1. 测试直接跑仓库里的真源码，不存副本

`lib/harness.js` 在加载被测模块**之前**劫持 `Module._resolveFilename`：

| 源码里的写法 | 实际被解析到 |
|---|---|
| `require('./shared')`（来自 `cloudfunctions/<fn>/index.js`） | `cloudfunctions/_shared/index.js`（唯一事实来源） |
| `require('wx-server-sdk')`（任何文件） | `tools/test-cloudfunctions/stub/wx-server-sdk.js` |

因此测试跑的永远是仓库里那一份实现：**实现一改，测试立刻跟着变**，不存在「测试副本
与实现脱节」。`run.js` 里的「组 0」还会显式断言 `_shared/index.js` 已加载、而
`order/shared`、`wallet/shared` 这两个由 `tools/sync-shared.mjs` 生成的副本**没有被加载**。

> 注意：部署前仍必须执行 `node tools/sync-shared.mjs`，把 `_shared` 同步进各云函数
> ——测试绕过副本是为了测试，不是为了部署。

### 2. 伪造的 SDK 提供了「像真数据库」的事务

`stub/wx-server-sdk.js` 实现云函数真正用到的那一小块能力：集合查询
（`where/orderBy/field/skip/limit/get/count/update`）、文档操作
（`doc().get()/update()/set()`）、指令（`_.in/_.lt/_.and/_.or/_.push/_.inc` …），
以及最关键的 `runTransaction()`：

1. **快照隔离**：事务开始时对全库做快照，事务内所有读写都发生在快照上；
2. **提交时写冲突检测**：若本事务执行期间有别的请求提交过 → 判定冲突，**整个事务重跑**
   （最多 8 次）；
3. **按文档提交**：提交时只把「本事务真正写过的文档」合并回主库，所以事务之外并发写入的
   时间币流水、站内通知不会被覆盖 —— 这正是真实数据库的行为。

第 2 条是「并发防超卖」测试有意义的前提：如果没有冲突检测，4 个并发下单会各自读到同一份
余额、互相覆盖，测试就变成了自欺欺人。报告里那句「其中写冲突自动重试 N 次」就是这套机制
真的被触发过的证据。

### 3. 暂时没有覆盖的部分（如实说明）

- 不连真实云环境，因此**云开发特有的能力**（`geoNear`、聚合管道 `$`、`watch` 实时推送、
  真实的 `openapi.subscribeMessage` 返回码）不在覆盖范围内；订阅消息只断言「是否发起调用」。
- 内存库的查询指令是**按需实现**的：如果将来云函数用了新的 `db.command`，stub 会直接抛
  `不支持的指令`，属于「明确失败」而不是静默通过。
- 单次 `get` 的 1000 条上限、冷启动、并发压测等运行时特性不在范围内。

---

## 答辩里可以直接引用的三组证据

| 组 | 断言要点 |
|---|---|
| 组 3 · ★ 并发防超卖 | 4 个并发下单只成功 3 单；`coins + frozenCoins` 恒为 10；订单金额之和 = 买家冻结额；技能 `orderCount` 不丢计数；事务冲突重试次数 > 0 |
| 组 7 · ★ finish → confirm | 确认前「钱锁在买家名下、卖家余额为 0」；确认后冻结清零、卖家到账、双方 `+2`、`totalEarned/totalSpent` 与 `serveCount/buyCount` 同步累加；`coins+frozen` 总量守恒；连续 5 单额外 `+3`；徽章去重补发 |
| 组 10 · autoTask 幂等 | 定时触发器无登录态可跑；重复执行 `closed/settled` 均为 0，余额、流水、`serveCount` 不重复变化；单批上限 50（60 张超时单分两轮处理完） |

---

## 加新案例

在 `cases/` 下新建 `xxx.test.js`，导出 `async (t) => { ... }`，并在 `run.js` 的 `CASES`
数组里登记即可。`t` 上可用的方法：

| 方法 | 说明 |
|---|---|
| `t.group(title)` | 开一个新的断言分组（报告里按组显示） |
| `t.eq(actual, expected, msg)` | 断言相等，失败打印期望/实际 |
| `t.ok(cond, msg, extra)` / `t.isTrue(v, msg)` | 布尔断言 |
| `t.seed(opts)` | 重置内存库并写入标准夹具（用户/技能/config） |
| `t.call(fn, openid, action, payload)` | 调用云函数（`fn` 为 `'order'` / `'wallet'`），自动带登录态 |
| `t.callRaw(fn, event)` | 模拟定时触发的裸 event 调用（无 openid） |
| `t.user(oid)` `t.order(id)` `t.orders()` `t.skill()` `t.logs(oid, type)` `t.credits(oid)` `t.notices(oid)` | 直接读库校验副作用 |
| `t.putOrder(o)` | 手工塞一张订单（用于构造超时等场景，绕过下单的信用上限） |
| `t.fake.__stats` / `t.fake.__totals` | 事务次数、冲突重试次数、订阅消息发送次数 |
| `t.shared` | 共享层（可直接单测 `orderLimitOf`、`creditLevelOf` 这类纯函数） |
