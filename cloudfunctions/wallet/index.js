/**
 * 校园时间银行 · 时间币钱包云函数
 * ==================================================================
 * 【余额三种口径】coins 可用、frozenCoins 冻结、coins + frozenCoins 总资产。
 * 冻结的原因：下单时钱必须先锁住（coins → frozenCoins），否则买家可以拿同一笔钱
 * 反复下单，卖家却以为自己能收到款；只有买家确认完成（或超时自动确认）才真正转移给卖家，
 * 取消 / 拒单 / 超时则原路解冻退回。因此「冻结」不是支出，本函数的收支统计里不计入 freeze。
 * 【为什么不用聚合按天分组】云开发时间字段是 Date，用 $.dayOfYear/$dateToString 拼 key 在不同
 * 运行时下时有差异、也不好调试；这里改为「查出近 7 天全部流水 → 在云函数内存里按本地日期分组」，
 * 结果稳定、代码直白，答辩时对着这段讲收支趋势最清楚。数据量级（个人 7 天流水）完全撑得住。
 * ==================================================================
 */
const {
  db, _, C,
  wrap, bizError, assert,
  now, daysAgo, startOfDay, lastNDays, pad, parsePage, paginateQuery,
  getOpenId, requireUser
} = require('./shared')

/* ============================ 本地常量 ============================ */
/** 视为「收入」的流水类型（与 utils/mock.js 的 wallet.logs 过滤规则一致） */
const INCOME_TYPES = ['income', 'bonus', 'unfreeze', 'refund']
/** 视为「支出」的流水类型 */
const EXPENSE_TYPES = ['expense', 'settle']
/** 单次查询/扫描的条数上限（云函数单次最多 1000，取 200 更兼容各版本） */
const PAGE = 200
/** 近 7 天流水最多翻页数（200 * 10 = 2000 条，个人流水足够） */
const MAX_PAGES = 10

/* ============================ 本地工具 ============================ */
/** 拼时间区间查询条件 */
function timeRange(since, until) {
  if (since && until) return _.and(_.gte(since), _.lte(until))
  if (since) return _.gte(since)
  if (until) return _.lte(until)
  return null
}

/** 按条件取流水（分页拉全，供内存统计用） */
async function fetchLogs(openid, opt) {
  const o = opt || {}
  const where = { _openid: openid }
  if (o.types && o.types.length) where.type = _.in(o.types)
  const tr = timeRange(o.since, o.until)
  if (tr) where.createTime = tr

  const out = []
  for (let i = 0; i < MAX_PAGES; i++) {
    const res = await db.collection(C.WALLET_LOGS)
      .where(where)
      .orderBy('createTime', 'desc')
      .skip(i * PAGE)
      .limit(PAGE)
      .get()
    const list = res.data || []
    out.push.apply(out, list)
    if (list.length < PAGE) break
  }
  return out
}

/** 按条件取订单（分页拉全，供内存分组用） */
async function fetchOrders(where) {
  const out = []
  for (let i = 0; i < MAX_PAGES; i++) {
    const res = await db.collection(C.ORDERS)
      .where(where)
      .field({ amount: true, skillSnapshot: true })
      .orderBy('createTime', 'desc')
      .skip(i * PAGE)
      .limit(PAGE)
      .get()
    const list = res.data || []
    out.push.apply(out, list)
    if (list.length < PAGE) break
  }
  return out
}

/** '2025-06-08' → '6/8'（与 mock.js 的 trend[].date 格式一致） */
function dayLabel(key) {
  const parts = String(key).split('-')
  return `${Number(parts[1])}/${Number(parts[2])}`
}

/** Date → 'YYYY-MM-DD'（本地时区，与 lastNDays 的骨架对齐） */
function dateKey(d) {
  const t = new Date(d)
  if (isNaN(t.getTime())) return ''
  return `${t.getFullYear()}-${pad(t.getMonth() + 1)}-${pad(t.getDate())}`
}

/* ==================================================================
 * action: info —— 余额概览 + 近 7 天收支
 * ================================================================== */
async function actionInfo(event, openid) {
  const u = await requireUser(openid)
  const since = startOfDay(daysAgo(6))   // 含今天在内的近 7 天

  const logs = await fetchLogs(openid, { since, types: INCOME_TYPES.concat(EXPENSE_TYPES) })
  let income7d = 0
  let expense7d = 0
  logs.forEach(l => {
    const amt = Math.abs(Number(l.amount) || 0)
    if (INCOME_TYPES.indexOf(l.type) > -1) income7d += amt
    else if (EXPENSE_TYPES.indexOf(l.type) > -1) expense7d += amt
  })

  return {
    coins: u.coins || 0,
    frozenCoins: u.frozenCoins || 0,
    totalEarned: u.totalEarned || 0,
    totalSpent: u.totalSpent || 0,
    income7d,
    expense7d
  }
}

/* ==================================================================
 * action: logs —— 分页流水明细
 * type: all | income | expense | freeze
 * ================================================================== */
async function actionLogs(event, openid) {
  await requireUser(openid)
  const { page, size } = parsePage(event, 20)

  const type = event.type || 'all'
  const where = { _openid: openid }
  if (type !== 'all') {
    if (type === 'income') where.type = _.in(INCOME_TYPES)
    else if (type === 'expense') where.type = _.in(EXPENSE_TYPES)
    else where.type = type
  }

  return paginateQuery(db.collection(C.WALLET_LOGS).where(where), {
    page,
    size,
    orderBy: [['createTime', 'desc']]
  })
}

/* ==================================================================
 * action: stats —— 近 7 天收支趋势 + 支出分类分布
 * 返回 { trend: [{date:'6/14', income, expense}], byCategory: [{name, value}] }
 * ================================================================== */
async function actionStats(event, openid) {
  await requireUser(openid)

  /* ---------- ① trend：lastNDays(7) 生成日期骨架，再在内存里按天归集 ---------- */
  const days = lastNDays(7)
  const basket = {}
  days.forEach(k => { basket[k] = { income: 0, expense: 0 } })

  const since = startOfDay(daysAgo(6))
  const logs = await fetchLogs(openid, { since })
  logs.forEach(l => {
    const key = dateKey(l.createTime)
    const bucket = basket[key]
    if (!bucket) return
    const amt = Math.abs(Number(l.amount) || 0)
    if (INCOME_TYPES.indexOf(l.type) > -1) bucket.income += amt
    else if (EXPENSE_TYPES.indexOf(l.type) > -1) bucket.expense += amt
    // freeze / unfreeze 只是余额位置的移动，不算收入也不算支出
  })
  const trend = days.map(k => ({
    date: dayLabel(k),
    income: basket[k].income,
    expense: basket[k].expense
  }))

  /* ---------- ② byCategory：本人作为买家的已完成订单，按技能分类汇总支出 ---------- */
  const orders = await fetchOrders({ buyerId: openid, status: 'finished' })
  const catMap = {}
  orders.forEach(o => {
    const name = (o.skillSnapshot && o.skillSnapshot.categoryName) || '其他'
    catMap[name] = (catMap[name] || 0) + (Math.abs(Number(o.amount) || 0))
  })
  const byCategory = Object.keys(catMap)
    .map(name => ({ name, value: catMap[name] }))
    .sort((a, b) => b.value - a.value)
    .slice(0, 8)

  return { trend, byCategory }
}

/* ============================ 入口 ============================ */
exports.main = wrap(async (event, context) => {
  const openid = getOpenId()
  switch (event.action) {
    case 'info': return actionInfo(event, openid)
    case 'logs': return actionLogs(event, openid)
    case 'stats': return actionStats(event, openid)
    default: throw bizError(400, `未知 action: ${event.action}`)
  }
})
