# 给云函数写离线回归用例 · 编写指南

> 面向 `tools/test-cloudfunctions/cases/*.test.js` 的作者。
> 读完这一页就能动手，不需要先读完整套测试台源码。

---

## 1. 最小可用骨架

```js
/**
 * login 云函数用例
 * 契约见 docs/ARCHITECTURE.md §4.1
 */
module.exports = async function (t) {
  t.group('组 1 · login：首次调用自动注册并赠送时间币')

  const s = t.seed({})                       // 重建一份干净的库 + 取夹具
  t.fake.__setOpenId('openid_alice')          // 设定「当前调用者」

  const r = await s.call('login', 'login')
  t.eq(r.code, 0, '首次 login 返回 code 0')
  t.eq(s.store().users.length, 1, '自动创建了 1 个用户')
  t.eq(s.store().users[0].coins, 5, '赠送 5 枚时间币（config.registerBonus）')
  t.eq(s.logs('openid_alice', 'bonus').length, 1, '写了一条 bonus 流水')
}
```

文件必须 `module.exports = async function (t) {}`；`run.js` 会自动扫描 `cases/*.test.js`。

---

## 2. 运行

```bash
node tools/test-cloudfunctions/run.js            # 全部用例
node tools/test-cloudfunctions/run.js login      # 只跑文件名含 login 的
TB_TEST_VERBOSE=1 node tools/test-cloudfunctions/run.js login   # 附带云函数原始日志
```

退出码 **0 = 全通过，1 = 有失败**（可直接接 CI）。

---

## 3. 可用的断言与夹具

### 3.1 `t`（断言引擎，来自 `lib/harness.js`）

| 方法 | 说明 |
|---|---|
| `t.group(title)` | 开一个分组。**标题用中文**，报告里直接展示 |
| `t.ok(cond, msg, extra?)` | 布尔断言。失败时 `extra` 会打出来 |
| `t.eq(actual, expected, msg)` | 相等断言，失败时自动显示「期望 / 实际」 |
| `t.isTrue(actual, msg)` | 严格 `=== true` |
| **`t.log(msg)`** | 打印一行调试信息（见下方坑 ①） |
| `t.summary()` | `{ passed, failed, groups }`，一般不用自己调 |
| `t.fake` | 内存版 `wx-server-sdk`（`__setOpenId` / `__store` / `__stats` / `__reset`） |
| `t.fns` | 8 个云函数入口，已全部加载 |
| `t.shared` | 共享层 `cloudfunctions/_shared/index.js` |

### 3.2 `s`（夹具，来自 `lib/fixtures.js` 的 `attach(t)`）

`t.seed(overrides?)` 会**清库并种入一份基础数据**，返回夹具对象：

| 成员 | 说明 |
|---|---|
| `s.call(fn, action, payload?)` | 调云函数并**直接返回 `{code,msg,data}`**（不抛错）—— 最常用 |
| `s.callRaw(fn, event)` | 传完整 event（用于非 action 路由，如定时触发的 `autoTask`） |
| `s.store()` | 取内存库 `{ users, skills, orders, wallet_logs, ... }` |
| `s.seed(overrides)` | 重新种库 |
| `s.D(n)` / `s.HOUR` | 构造相对时间（n 天前 / 1 小时的毫秒数） |
| `s.putOrder(o)` | 直接塞一张订单进库（用于构造特定状态） |
| `s.order(id)` / `s.orders()` | 取订单 |
| `s.logs(openid, type?)` | 取某人的时间币流水 |

> 具体签名以 `lib/fixtures.js` 为准 —— 动笔前扫一眼导出的方法列表。

---

## 4. 三个必须知道的坑

### ① `console.log` 会被吞掉

`lib/harness.js` 在被 require 时会**接管 `console`**，把云函数的输出收进 `logs[]`
（默认不打印，避免刷屏）。所以在用例里写 `console.log` 会「看起来什么都没发生」。

**调试一律用 `t.log(...)`。**

### ② 不要改 `run.js`

它已经改成**自动扫描 `cases/*.test.js`**。新增用例只需要把文件放进去，谁都不用动 runner。
（这正是为了避免多人并行改同一个文件。）

### ③ 不要自己改 stub / harness / fixtures

`stub/wx-server-sdk.js`、`lib/harness.js`、`lib/fixtures.js` 是**共享文件**，
同时可能有别人在用。缺能力就告诉 Lead，由单一写者统一扩展。

---

## 5. stub 已支持的数据库能力

**查询**：`where` / `orderBy` / `field` / `skip` / `limit` / `get` / `count` / `update` / `remove`
**文档**：`doc().get()` / `update()` / `set()` / `remove()`
**事务**：`runTransaction()` —— 快照隔离 + 提交时写冲突检测 + 自动重试（8 次）
**指令 `_`**：`in` `nin` `eq` `neq` `lt` `lte` `gt` `gte` `and` `or` `push` `inc` `set` `all` `exists` `geoNear`
**其它**：`db.RegExp`、`db.createCollection`、`db.Geo.Point`
**聚合**：`collection.aggregate().match().group().sort().limit().skip().end()`
，累加器 `$.sum` `$.count` `$.max` `$.min` `$.avg`（`$.sum(1)` 等价计数）

**语义上刻意对齐真实云开发的两点**：
- `where({ members: 'x' })` 对数组字段是**包含**语义（`message` 的会话查询依赖它）
- 空集合上 `$group` 返回**空数组**（对齐 MongoDB，不是一条全 0 记录）
- `geoNear` 会**按距离升序**返回，并给每条文档补 `distance`（米）

---

## 6. 怎么写才算「测透了」

**不要**只断言「函数被调用过」或「返回了对象」。按这四类写：

| 类别 | 例子 |
|---|---|
| **入参校验** | 缺参数 → 400；非法枚举 → 400；越界数值 → 400，且 `msg` 是面向用户的中文 |
| **权限与越权** | 非本人操作 → 403；非管理员调 admin → 403；不存在的资源 → 404 |
| **状态迁移** | 合法迁移成功；**非法迁移被拒**（如已完成的订单不能再接单 → 409） |
| **副作用** | 写没写流水 / 通知 / 统计字段；金额与计数是否守恒；幂等（重复调用不重复写） |

**边界清单**（每个函数都值得过一遍）：空集合、重复操作、并发、超时、
自己操作自己、已封禁用户、未认证用户。

---

## 7. 参考实现

| 文件 | 适合当范例 |
|---|---|
| `cases/wallet.test.js` | **最短**，适合第一个照抄 |
| `cases/order.create.test.js` | 校验分支最全（含并发防超卖） |
| `cases/order.flow.test.js` | 状态机 + 副作用断言 |
| `cases/order.timeout.test.js` | 定时任务 / 幂等 |

---

## 8. 覆盖现状（谁还没被测）

| 云函数 | action 数 | 覆盖 |
|---|---|---|
| `order` | 9 (+autoTask) | ✅ 已覆盖 |
| `wallet` | 3 | ✅ 已覆盖 |
| `login` | 6 | ⬜ 待补 |
| `skill` | 9 | ⬜ 待补 |
| `user` | 7 | ⬜ 待补 |
| `message` | 9 | ⬜ 待补 |
| `admin` | 20 | ⬜ 待补 |
| `initdb` | 3 | ⬜ 待补 |

合计 **65 个 action 中只有 12 个有断言** —— 这就是「测试还没做透」的具体含义。
