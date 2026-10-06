/**
 * 云函数 admin —— 管理端（ARCHITECTURE.md §4.7 + §4.8 数据看板）
 * ==================================================================
 * ★ 除 check 外，每个 action 都必须先 await requireAdmin()
 * ★ 所有写操作尽量幂等：重复审核不重复发通知、重复处理举报不重复扣分
 *
 * action：
 *   check / stats
 *   users / auditUser / setUserStatus / setUserRole / adjustCoins
 *   categories / saveCategory / deleteCategory
 *   skills / auditSkill
 *   orders
 *   reports / handleReport
 *   banners / saveBanner / deleteBanner
 *   config / saveConfig
 * ==================================================================
 */
const {
  db, _, $, C,
  wrap, bizError, assert,
  now, startOfDay, lastNDays, pad,
  parsePage, paginateQuery,
  requireAdmin, requireDebugger, getUser,
  ROLE, isAdminUser, isDebuggerUser,
  getConfig, changeCredit, addWalletLog, addNotice
} = require('./shared')

/* ============================ 通用工具 ============================ */

/** 单次 get 上限：云函数内 db.get() 默认最多 100 条，超出要 skip 分页 */
const GET_PAGE = 100
/** 分页兜底上限，防止异常数据把云函数拖死 */
const GET_MAX = 3000

/** 正则元字符转义，防止 keyword 注入（用户搜索 admin/学生） */
function escapeReg(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}
const likeReg = kw => db.RegExp({ regexp: escapeReg(kw), options: 'i' })

/**
 * 分页拉全量（云函数内单次 get 最多 100 条）
 * @param {String} coll 集合名
 * @param {Object} where 条件
 * @param {Object|null} field 只取指定字段
 */
async function fetchAll(coll, where, field) {
  const out = []
  for (let skip = 0; skip < GET_MAX; skip += GET_PAGE) {
    let q = db.collection(coll).where(where || {})
    if (field) q = q.field(field)
    const res = await q.skip(skip).limit(GET_PAGE).get()
    const rows = res.data || []
    out.push(...rows)
    if (rows.length < GET_PAGE) break
  }
  return out
}

/**
 * 聚合分组计数（带分页，绕开聚合 group 单次最多 100 条的限制）
 * ★ 云数据库聚合 group 的结果集单次最多 100 条：数据量大时直接用
 *   .group().end() 会「静默截断」，导致统计偏小。这里按 100 条翻页取全部分组，
 *   并用 cap 作保护上限（校园项目规模远小于 cap）。
 * @param {String} coll
 * @param {Object} match 聚合 match 条件（空对象表示不过滤）
 * @param {String} idExpr 分组表达式，如 '$skillSnapshot.title'
 * @param {Number} cap 保护上限
 */
async function groupCount(coll, match, idExpr, cap) {
  const limit = cap || 2000
  const out = []
  for (let i = 0; i * GET_PAGE < limit; i++) {
    let agg = db.collection(coll).aggregate()
    if (match && Object.keys(match).length) agg = agg.match(match)
    const res = await agg
      .group({ _id: idExpr, value: $.sum(1) })
      .sort({ value: -1 })
      .skip(i * GET_PAGE)
      .limit(GET_PAGE)
      .end()
    const rows = res.list || []
    out.push(...rows)
    if (rows.length < GET_PAGE) break
  }
  return out
}

/** 支持 _openid 或 _id 两种标识查用户（管理端前端两种都可能传） */
async function findUser(key) {
  assert(key, '缺少用户标识', 400)
  const res = await db.collection(C.USERS)
    .where(_.or([{ _openid: key }, { _id: key }]))
    .limit(1)
    .get()
  return (res.data || [])[0] || null
}

/** 增长率百分比，保留 1 位小数；昨日为 0 时返回 100 */
function growthRate(today, yesterday) {
  const t = Number(today) || 0
  const y = Number(yesterday) || 0
  if (!y) return t > 0 ? 100 : 0
  return Math.round(((t - y) / y) * 1000) / 10
}

const ORDER_STATUS_TEXT = {
  finished: '已完成',
  ongoing: '服务中',
  waiting: '待接单',
  confirming: '待确认',
  canceled: '已取消',
  // closed 必须与 canceled 分开：两者都是「终态但未完成」，语义不同。
  //   合并成一格会让看板「已关闭」恒为 0、「已取消」虚高一倍。
  //   前端 constants.ORDER_STATUS / mock.js / admin 订单页的 DIST_NAME_TO_KEY
  //   都按 6 个状态设计，云端必须一致。
  closed: '已关闭'
}
const ORDER_STATUS_NAMES = ['已完成', '服务中', '待接单', '待确认', '已取消', '已关闭']
const CREDIT_BUCKETS = [
  { name: '0-59', min: 0, max: 59 },
  { name: '60-79', min: 60, max: 79 },
  { name: '80-99', min: 80, max: 99 },
  { name: '100-119', min: 100, max: 119 },
  { name: '120-150', min: 120, max: 150 }
]

/* ============================ check ============================ */
/** check —— 不抛错，未登录 / 非管理员返回 isAdmin=false */
async function check() {
  const u = await getUser()          // 未登录返回 null，不抛异常
  // ★ 封禁账号不应被识别为管理员：否则后台入口可见、但每个 action 都 403，
  //   前端无从解释「为什么我是管理员却什么都干不了」。
  const ok = !!u && Number(u.status) !== 0
  return {
    isAdmin: ok && isAdminUser(u),        // 能否进管理后台：管理员 + 调试员
    isDebugger: ok && isDebuggerUser(u),  // 能否接触调试功能：仅调试员
    role: (u && u.role) || ROLE.USER
  }
}

/* ============================ stats（§4.8 看板） ============================ */
async function stats(event) {
  const range = [7, 14, 30].indexOf(Number(event.range)) >= 0 ? Number(event.range) : 7

  const today0 = startOfDay()
  const yest0 = startOfDay(new Date(Date.now() - 86400000))
  const rangeStart = startOfDay(new Date(Date.now() - (range - 1) * 86400000))

  const [
    userTotal, userToday, userYest,
    orderTotal, orderToday, orderYest,
    authPending, reportPending,
    coinAgg, usersAll, ordersInRange,
    hotRows, catRows, statusRows, topRes
  ] = await Promise.all([
    db.collection(C.USERS).count().then(r => (r && r.total) || 0),
    db.collection(C.USERS).where({ createTime: _.gte(today0) }).count().then(r => (r && r.total) || 0),
    db.collection(C.USERS).where({ createTime: _.gte(yest0).and(_.lt(today0)) }).count().then(r => (r && r.total) || 0),
    db.collection(C.ORDERS).count().then(r => (r && r.total) || 0),
    db.collection(C.ORDERS).where({ createTime: _.gte(today0) }).count().then(r => (r && r.total) || 0),
    db.collection(C.ORDERS).where({ createTime: _.gte(yest0).and(_.lt(today0)) }).count().then(r => (r && r.total) || 0),
    db.collection(C.USERS).where({ authStatus: 1 }).count().then(r => (r && r.total) || 0),
    db.collection(C.REPORTS).where({ status: 0 }).count().then(r => (r && r.total) || 0),
    // coinCirculation / coinFrozen / coinEarned = 聚合求和（分组只有一行，不受 100 条上限影响）
    db.collection(C.USERS).aggregate().group({
      _id: null,
      coins: $.sum('$coins'),
      frozen: $.sum('$frozenCoins'),
      earned: $.sum('$totalEarned')
    }).end(),
    // 全量用户（分页取）：用于趋势里的每日新增、信用分分布、平均评分
    fetchAll(C.USERS, {}, { _openid: true, createTime: true, creditScore: true, stats: true }),
    // 区间内订单（分页取）：在云函数内存里按天分组，比聚合表达式更稳、更好讲
    fetchAll(C.ORDERS, { createTime: _.gte(rangeStart) }, { createTime: true, amount: true, status: true, skillSnapshot: true }),
    groupCount(C.ORDERS, {}, '$skillSnapshot.title'),
    groupCount(C.ORDERS, {}, '$skillSnapshot.categoryName'),
    groupCount(C.ORDERS, {}, '$status'),
    // 活跃用户 TOP5（按服务单数）
    (async () => {
      try {
        const r = await db.collection(C.USERS).orderBy('stats.serveCount', 'desc').limit(5).get()
        return r.data || []
      } catch (e) {
        const all = await fetchAll(C.USERS, {}, null)
        return all
          .sort((a, b) => (((b.stats || {}).serveCount) || 0) - (((a.stats || {}).serveCount) || 0))
          .slice(0, 5)
      }
    })()
  ])

  /* ---- overview ---- */
  const coinRow = ((coinAgg && coinAgg.list) || [])[0] || {}
  const finishedTotal = statusRows
    .filter(r => r._id === 'finished')
    .reduce((n, r) => n + (Number(r.value) || 0), 0)

  let ratingSum = 0
  let reviewCount = 0
  usersAll.forEach(u => {
    const s = u.stats || {}
    ratingSum += Number(s.ratingSum) || 0
    reviewCount += Number(s.reviewCount) || 0
  })

  const overview = {
    userTotal,
    userToday,
    userGrowthRate: growthRate(userToday, userYest),
    orderTotal,
    orderToday,
    orderGrowthRate: growthRate(orderToday, orderYest),
    coinCirculation: Number(coinRow.coins) || 0,
    coinFrozen: Number(coinRow.frozen) || 0,
    coinEarned: Number(coinRow.earned) || 0,
    finishRate: orderTotal ? Math.round((finishedTotal / orderTotal) * 1000) / 10 : 0,
    avgRating: reviewCount ? Math.round((ratingSum / reviewCount) * 100) / 100 : 0,
    authPending,
    reportPending
  }

  /* ---- trend：近 N 天（骨架来自 lastNDays，再在内存里按天归集） ---- */
  const dayKey = d => {
    const t = new Date(d)
    if (isNaN(t.getTime())) return ''
    return `${t.getFullYear()}-${pad(t.getMonth() + 1)}-${pad(t.getDate())}`
  }
  const dayLabel = key => {
    const [, m, d] = String(key).split('-')
    return `${Number(m)}/${Number(d)}`
  }
  const buckets = {}
  const days = lastNDays(range)
  days.forEach(k => { buckets[k] = { users: 0, orders: 0, coins: 0 } })

  usersAll.forEach(u => {
    const k = dayKey(u.createTime)
    if (buckets[k]) buckets[k].users += 1
  })
  ordersInRange.forEach(o => {
    const k = dayKey(o.createTime)
    if (buckets[k]) {
      buckets[k].orders += 1
      // coins = 当日新增订单的时间币金额合计（下单冻结量，口径稳定）
      buckets[k].coins += Number(o.amount) || 0
    }
  })
  const trend = days.map(k => ({
    date: dayLabel(k),
    users: buckets[k].users,
    orders: buckets[k].orders,
    coins: buckets[k].coins
  }))

  /* ---- 分布类 ---- */
  const hotSkills = hotRows
    .filter(r => r._id)
    .map(r => ({ name: String(r._id), value: Number(r.value) || 0 }))
    .slice(0, 8)

  const categoryDist = catRows
    .filter(r => r._id)
    .map(r => ({ name: String(r._id), value: Number(r.value) || 0 }))
    .slice(0, 8)

  const orderStatusDist = ORDER_STATUS_NAMES.map(name => ({ name, value: 0 }))
  statusRows.forEach(r => {
    const name = ORDER_STATUS_TEXT[r._id]
    const hit = orderStatusDist.find(x => x.name === name)
    if (hit) hit.value += Number(r.value) || 0
  })

  const creditDist = CREDIT_BUCKETS.map(b => ({
    name: b.name,
    value: usersAll.filter(u => {
      const s = Number(u.creditScore)
      const raw = isNaN(s) ? 100 : s
      // ★ 把越界分数兜进首/末档。changeCredit 理论上会 clamp 到 [0,150]，
      //   但历史数据 / 导入数据可能越界；越界时不属任何一档，
      //   会让 creditDist 合计 < userTotal，看板口径自相矛盾。
      const score = raw < 0 ? 0 : (raw > 150 ? 150 : raw)
      return score >= b.min && score <= b.max
    }).length
  }))

  const topUsers = (topRes || []).slice(0, 5).map(u => ({
    openid: u._openid,
    nickName: u.nickName || '匿名同学',
    avatarUrl: u.avatarUrl || '',
    serveCount: ((u.stats || {}).serveCount) || 0,
    // 不能用 `|| 100`：0 分是合法值，会被当成缺失而显示成 100（mock 侧是裸 creditScore，两端会漂移）。
    //   只有真的不是数字时才兜底 100。
    creditScore: typeof u.creditScore === 'number' ? u.creditScore : 100,
    avgRating: ((u.stats || {}).avgRating) || 0
  }))

  return { overview, trend, hotSkills, categoryDist, orderStatusDist, creditDist, topUsers }
}

/* ============================ 用户管理 ============================ */
async function users(event) {
  const kw = event.keyword ? String(event.keyword).trim() : ''
  const conds = []
  if (kw) conds.push(_.or([{ nickName: likeReg(kw) }, { studentNo: likeReg(kw) }]))
  if (event.authStatus !== undefined && event.authStatus !== null && event.authStatus !== '') {
    conds.push({ authStatus: Number(event.authStatus) })
  }
  if (event.status !== undefined && event.status !== null && event.status !== '') {
    conds.push({ status: Number(event.status) })
  }
  const where = conds.length === 0 ? {} : (conds.length === 1 ? conds[0] : _.and(conds))

  const { page, size } = parsePage(event, 10)
  const res = await paginateQuery(db.collection(C.USERS).where(where), {
    page, size, orderBy: [['createTime', 'desc']]
  })
  return { list: res.list, total: res.total, hasMore: res.hasMore }
}

/** auditUser —— 校园认证审核（幂等：状态没变化时不再重复发通知） */
async function auditUser(event) {
  const admin = await requireAdmin()
  const pass = !!event.pass
  const u = await findUser(event.userId)
  if (!u) throw bizError(404, '用户不存在')

  const nextStatus = pass ? 2 : 3
  const remark = event.remark ? String(event.remark).slice(0, 200) : ''

  // ★ 幂等：已经是同一审核结论时直接返回，不重复发通知、不重复写时间
  if (u.authStatus === nextStatus) return { ok: true }

  await db.collection(C.USERS).doc(u._id).update({
    data: {
      authStatus: nextStatus,
      authRemark: pass ? '' : remark,
      authTime: now(),
      updateTime: now()
    }
  })

  if (pass) {
    // 认证相关通知（徽章由 user 云函数的 badges/mine/reviews 动态补发，不在这里重复实现）
    await addNotice({
      openid: u._openid,
      type: 'audit',
      title: '校园认证已通过',
      content: '你的校园认证资料已通过审核，现在可以发布技能和下单了。',
      orderId: ''
    })
  } else {
    await addNotice({
      openid: u._openid,
      type: 'audit',
      title: '校园认证未通过',
      content: `你的校园认证资料未通过审核${remark ? '：' + remark : ''}，请修改后重新提交。`,
      orderId: ''
    })
  }

  console.log('[admin.auditUser]', admin._openid, '→', u._openid, pass ? 'pass' : 'reject')
  return { ok: true }
}

/** setUserStatus —— 封禁 / 解封 */
async function setUserStatus(event) {
  const admin = await requireAdmin()
  const u = await findUser(event.userId)
  if (!u) throw bizError(404, '用户不存在')

  const status = Number(event.status) === 0 ? 0 : 1
  if (status === 0 && u._openid === admin._openid) throw bizError(409, '不能封禁自己')
  // ★ 调试员只有调试员能封 —— 否则普通管理员可以把校方账号封掉
  if (status === 0 && isDebuggerUser(u) && !isDebuggerUser(admin)) throw bizError(403, '无管理员权限')
  // 管理员之间不能互封（防止学生管理员互相打击）；调试员（校方）有权限处理
  if (status === 0 && isAdminUser(u) && !isDebuggerUser(admin)) throw bizError(409, '不能封禁管理员账号')

  await db.collection(C.USERS).doc(u._id).update({ data: { status, updateTime: now() } })

  if (status === 0) {
    await addNotice({
      openid: u._openid,
      type: 'system',
      title: '账号已被封禁',
      content: '你的账号因违规行为已被暂时封禁，如有疑问请联系管理员。',
      orderId: ''
    })
  }
  return { ok: true }
}

/** setUserRole —— 设置 / 取消管理员 或 调试员 */
async function setUserRole(event) {
  const admin = await requireAdmin()
  const u = await findUser(event.userId)
  if (!u) throw bizError(404, '用户不存在')

  const wanted = [ROLE.USER, ROLE.ADMIN, ROLE.DEBUGGER].indexOf(event.role) >= 0 ? event.role : ROLE.USER

  /*
   * ★ 调试员身份的**授予与撤销只有调试员能做**。
   *
   *   否则整套权限隔离形同虚设：普通管理员只要调一次 setUserRole
   *   把 role 改成 'debugger' 就能给自己升级，然后碰那些
   *   「不想让学生看到」的功能。
   *
   *   文案与 requireAdmin 保持一致，不透露上层的存在。
   */
  const touchesDebugger = wanted === ROLE.DEBUGGER || u.role === ROLE.DEBUGGER
  if (touchesDebugger && !isDebuggerUser(admin)) throw bizError(403, '无管理员权限')

  if (wanted === ROLE.USER && u._openid === admin._openid) throw bizError(409, '不能取消自己的管理员身份')

  await db.collection(C.USERS).doc(u._id).update({ data: { role: wanted, updateTime: now() } })
  return { ok: true }
}

/** adjustCoins —— 管理员调整时间币（必须写 wallet_logs） */
async function adjustCoins(event) {
  const admin = await requireAdmin()
  const amount = Number(event.amount)
  assert(Number.isFinite(amount) && amount !== 0, '调整数量必须是非 0 数字', 400)

  const u = await findUser(event.userId)
  if (!u) throw bizError(404, '用户不存在')

  const balance = (Number(u.coins) || 0) + amount
  if (balance < 0) throw bizError(409, '调整后余额不能为负')
  const remark = event.remark ? String(event.remark).slice(0, 100) : '管理员调整'

  await db.collection(C.USERS).doc(u._id).update({ data: { coins: balance, updateTime: now() } })
  await addWalletLog({
    openid: u._openid,
    type: 'admin',
    amount,
    balance,
    frozen: Number(u.frozenCoins) || 0,
    orderId: '',
    orderNo: '',
    remark: `${remark}（操作人 ${admin.nickName || admin._openid}）`
  })
  await addNotice({
    openid: u._openid,
    type: 'system',
    title: '时间币已调整',
    content: `管理员${amount > 0 ? '增加' : '扣除'}了 ${Math.abs(amount)} 枚时间币：${remark}`,
    orderId: ''
  })
  return { ok: true }
}

/* ============================ 分类 ============================ */
async function categories() {
  const res = await db.collection(C.CATEGORIES).orderBy('sort', 'asc').limit(GET_PAGE).get()
  return { list: res.data || [] }
}

async function saveCategory(event) {
  await requireAdmin()
  const name = event.name ? String(event.name).trim() : ''
  assert(name, '请填写分类名称', 400)
  assert(name.length <= 10, '分类名称不超过 10 字', 400)

  const icon = event.icon || '✨'
  const sort = Number(event.sort) || 99

  if (event._id) {
    let old = null
    try {
      const r = await db.collection(C.CATEGORIES).doc(event._id).get()
      old = r.data || null
    } catch (e) { old = null }
    if (!old) throw bizError(404, '分类不存在')

    await db.collection(C.CATEGORIES).doc(old._id).update({
      data: {
        name,
        icon,
        sort,
        status: event.status === undefined ? old.status : Number(event.status),
        updateTime: now()
      }
    })
    return { id: old._id }
  }

  const addRes = await db.collection(C.CATEGORIES).add({
    data: {
      name,
      icon,
      sort,
      status: event.status === undefined ? 1 : Number(event.status),
      createTime: now()
    }
  })
  return { id: addRes._id }
}

async function deleteCategory(event) {
  await requireAdmin()
  assert(event._id, '缺少分类 _id', 400)

  // 有技能引用时拒绝删除（返回 409）
  const used = await db.collection(C.SKILLS).where({ categoryId: event._id }).count()
  if ((used && used.total) > 0) throw bizError(409, '该分类下还有技能，不能删除')

  let old = null
  try {
    const r = await db.collection(C.CATEGORIES).doc(event._id).get()
    old = r.data || null
  } catch (e) { old = null }
  if (!old) throw bizError(404, '分类不存在')

  await db.collection(C.CATEGORIES).doc(old._id).remove()
  return { ok: true }
}

/* ============================ 技能审核 ============================ */
async function skills(event) {
  await requireAdmin()
  const conds = []
  if (event.status !== undefined && event.status !== null && event.status !== '') {
    conds.push({ status: Number(event.status) })
  }
  if (event.keyword) conds.push({ title: likeReg(String(event.keyword).trim()) })
  const where = conds.length === 0 ? {} : (conds.length === 1 ? conds[0] : _.and(conds))

  const { page, size } = parsePage(event, 10)
  const res = await paginateQuery(db.collection(C.SKILLS).where(where), {
    page, size, orderBy: [['createTime', 'desc']]
  })
  return { list: res.list, total: res.total, hasMore: res.hasMore }
}

/**
 * auditSkill —— 技能审核 / 下架 / 恢复 / 置顶
 * @param {Number} event.status  3=违规下架，1=恢复上架（0/2/4 也允许，做通用状态迁移）
 * @param {Boolean} [event.isTop] 传了就更新置顶态（广场列表按 isTop 优先排序）
 */
async function auditSkill(event) {
  const admin = await requireAdmin()
  const status = Number(event.status)
  assert([0, 1, 2, 3, 4].indexOf(status) > -1, '非法的技能状态', 400)

  let sk = null
  try {
    const r = await db.collection(C.SKILLS).doc(event.id).get()
    sk = r.data || null
  } catch (e) { sk = null }
  if (!sk) throw bizError(404, '技能不存在')

  // ★ `remark` 与 `isTop` 都遵循「**显式传了才更新**」原则：
  //   否则前端「只切置顶」时会把原有的违规下架原因清空，
  //   「只改状态」时又会把置顶态意外清掉。两个字段都是可选增量更新。
  const hasRemark = event.remark !== undefined
  const remark = hasRemark ? String(event.remark || '').slice(0, 200) : (sk.auditRemark || '')
  const patch = { status, updateTime: now() }
  if (hasRemark) patch.auditRemark = remark
  if (event.isTop !== undefined) patch.isTop = !!event.isTop

  await db.collection(C.SKILLS).doc(sk._id).update({ data: patch })

  // 违规下架时通知作者（幂等：状态没变化则不重复通知）
  if (status === 3 && sk.status !== 3) {
    await addNotice({
      openid: sk.authorId || sk._openid,
      type: 'system',
      title: '技能已被下架',
      content: `你的技能「${sk.title}」因违规已被下架${remark ? '：' + remark : ''}。`,
      orderId: ''
    })
  }
  console.log('[admin.auditSkill]', admin._openid, sk._id, status, patch.isTop)
  return { ok: true }
}

/* ============================ 订单管理 ============================ */
async function orders(event) {
  await requireAdmin()
  const conds = []
  if (event.status && event.status !== 'all') conds.push({ status: event.status })
  if (event.orderNo) conds.push({ orderNo: likeReg(String(event.orderNo).trim()) })
  if (event.keyword) {
    const reg = likeReg(String(event.keyword).trim())
    conds.push(_.or([{ orderNo: reg }, { 'skillSnapshot.title': reg }]))
  }
  const where = conds.length === 0 ? {} : (conds.length === 1 ? conds[0] : _.and(conds))

  const { page, size } = parsePage(event, 10)
  const res = await paginateQuery(db.collection(C.ORDERS).where(where), {
    page, size, orderBy: [['createTime', 'desc']]
  })

  // 列表展示需要买卖双方昵称（orders 里已有冗余快照，这里提到顶层方便表格直接绑定）
  const list = (res.list || []).map(o => Object.assign({}, o, {
    buyerNickName: (o.buyerInfo && o.buyerInfo.nickName) || '',
    sellerNickName: (o.sellerInfo && o.sellerInfo.nickName) || ''
  }))
  return { list, total: res.total, hasMore: res.hasMore }
}

/* ============================ 举报 ============================ */
async function reports(event) {
  await requireAdmin()
  const where = {}
  if (event.status !== undefined && event.status !== null && event.status !== '') {
    where.status = Number(event.status)
  }
  const { page, size } = parsePage(event, 10)
  const res = await paginateQuery(db.collection(C.REPORTS).where(where), {
    page, size, orderBy: [['createTime', 'desc']]
  })
  return { list: res.list, total: res.total, hasMore: res.hasMore }
}

/** handleReport —— result 1=核实成立（对被举报人 -10 信用分 + 通知举报人）；2=驳回 */
/* ============================ 申诉（最小闭环） ============================ */
/*
 * 与举报相反的方向：举报是「用户指控别人」，申诉是「用户对**已作出的处置**申辩」。
 * 平台在此之前只有前者 —— 被扣分、被下架的只有一条通知，没有申辩渠道。
 *
 * 最小闭环覆盖两类处置：credit（信用分被扣）、skill（技能被违规下架）。
 */

/** appeals —— 申诉列表 */
async function appeals(event) {
  await requireAdmin()
  const where = {}
  if (event.status !== undefined && event.status !== '' && event.status !== null) {
    where.status = Number(event.status)
  }
  const { page, size } = parsePage(event, 10)
  const res = await paginateQuery(db.collection(C.APPEALS).where(where), {
    page, size, orderBy: [['createTime', 'desc']]
  })
  return { list: res.list, total: res.total, hasMore: res.hasMore }
}

/**
 * ★ 撤销原处置 —— 申诉「成立」时执行。
 *
 * 【为什么不删掉原来那条记录】
 *   扣分记录、下架动作都是**已经发生的事实**。删掉它会让人以为从来没扣过，
 *   也让「这条分是怎么回来的」变得不可追溯。
 *   所以一律**写一条反向记录**：
 *     · credit → 加回分数，并在 credit_logs 里写一条 appeal_ok 的正向流水
 *     · skill  → 把 status 恢复为上架，下架原因保留在 auditRemark 里
 *   这样账本始终是「只增不改」的，对得上。
 *
 * 【为什么按提交时固化的 restore 来恢复】
 *   处理可能在几天后发生，那时原记录可能已被别的操作改动。
 *   所以恢复量在**提交申诉时**就固定下来，而不是处理时再算。
 *
 * @returns {Object} { handled, kind, note }
 */
async function undoByAppeal(a) {
  const restore = a.restore || {}

  if (a.type === 'credit') {
    const back = Number(restore.scoreChange) || 0
    if (back <= 0) return { handled: false, kind: 'credit', note: '未记录可恢复的分数，未处理' }
    /*
     * ★ 注意：changeCredit 会把分数钳制在 0~150。
     *   如果用户在申诉期间又攒了分，加回后可能触顶 —— 那时恢复不满额。
     *   这是**分数上限**的正确行为，不是 bug；流水里仍会如实记下加了多少。
     */
    await changeCredit(a._openid, back, 'appeal_ok', '申诉成立，信用分已恢复')
    return { handled: true, kind: 'credit', note: '信用分已加回 ' + back }
  }

  if (a.type === 'skill') {
    let sk = null
    try { sk = (await db.collection(C.SKILLS).doc(a.targetId).get()).data } catch (e) { sk = null }
    if (!sk) return { handled: false, kind: 'skill', note: '技能已不存在' }
    const want = Number(restore.prevStatus) || 1
    if (Number(sk.status) === want) return { handled: false, kind: 'skill', note: '技能已是该状态' }
    await db.collection(C.SKILLS).doc(sk._id).update({
      // 保留 auditRemark：它记录了当初为什么被下架，是历史的一部分
      data: { status: want, updateTime: now() }
    })
    await addNotice({
      openid: sk.authorId || sk._openid,
      type: 'system',
      title: '技能已恢复上架',
      content: '你的技能「' + sk.title + '」经申诉核实已恢复上架。感谢你的耐心等待。',
      orderId: ''
    })
    return { handled: true, kind: 'skill', note: '技能已恢复上架' }
  }

  return { handled: false, kind: a.type, note: '该类型不支持自动撤销' }
}

/** handleAppeal —— result 1=成立（撤销原处置 + 通知）；2=驳回 */
async function handleAppeal(event) {
  const admin = await requireAdmin()
  assert(event.id, '缺少申诉 id', 400)

  let a = null
  try { a = (await db.collection(C.APPEALS).doc(event.id).get()).data } catch (e) { a = null }
  if (!a) throw bizError(404, '申诉不存在')

  // ★ 幂等：已结案的不重复撤销、不重复发通知
  if (Number(a.status) !== 0) return { ok: true, undo: { handled: false, note: '已结案' } }

  const result = Number(event.result)
  assert(result === 1 || result === 2, '处理结果只能是 1（成立）或 2（驳回）', 400)
  const remark = event.remark ? String(event.remark).slice(0, 200) : ''

  // ★ 先撤销、再更改申诉单状态：与举报处理同一原则 ——
  //   「让处置真正被纠正」比记账紧急
  let undo = { handled: false, kind: a.type, note: '' }
  if (result === 1) undo = await undoByAppeal(a)

  await db.collection(C.APPEALS).doc(a._id).update({
    data: {
      status: result,
      handleRemark: remark,
      handlerId: admin._openid,
      handleTime: now(),
      undo: undo.handled ? undo.kind : ''
    }
  })

  await addNotice({
    openid: a._openid,
    type: 'appeal',
    title: result === 1 ? '申诉已成立' : '申诉未成立',
    content: result === 1
      ? '你提交的申诉已核实成立，我们已撤销相应处置' + (remark ? '：' + remark : '。')
      : '你提交的申诉经核实未予成立' + (remark ? '：' + remark : '。'),
    orderId: ''
  })

  return { ok: true, undo }
}

/**
 * ★ 举报「核实成立」时必须**顺带把内容处理掉**。
 *
 *   原来的行为是「扣被举报人 10 信用分 + 通知举报人」—— 然后**内容还在**。
 *   举报人刷新一下广场，被举报的技能照样挂着；管理员还得再手动去
 *   「技能审核」里下架一遍。**处理完 ≠ 内容消失**，处理链路没闭环。
 *
 * 各类型的处置方式（刻意不同）：
 *   · skill  → 与 auditSkill 的「违规下架」**同一语义**：status=3 + 记录原因 + 通知作者
 *   · review → reviews 没有 status 字段，用 hidden 标记；评价列表查询会过滤掉
 *   · user   → **不自动处置**。封禁比扣分重得多，不该由**一次**举报自动触发，
 *              交给管理员在用户管理里判断
 *   · order  → 不适用（订单没有「下架」这个概念）
 *
 * @returns {Object} { handled, kind, note } —— 回给管理端，让它看到做了什么
 */
async function takeDownReported(r, why) {
  const reason = why || r.reason || '举报核实成立'

  if (r.targetType === 'skill') {
    let sk = null
    try { sk = (await db.collection(C.SKILLS).doc(r.targetId).get()).data } catch (e) { sk = null }
    if (!sk) return { handled: false, kind: 'skill', note: '技能已不存在，无需下架' }
    if (sk.status === 3) return { handled: false, kind: 'skill', note: '技能已是下架状态' }
    await db.collection(C.SKILLS).doc(sk._id).update({
      data: { status: 3, auditRemark: reason, updateTime: now() }
    })
    await addNotice({
      openid: sk.authorId || sk._openid,
      type: 'system',
      title: '技能已被下架',
      content: `你的技能「${sk.title}」因举报核实成立已被下架：${reason}`,
      orderId: ''
    })
    return { handled: true, kind: 'skill', note: '技能已下架' }
  }

  if (r.targetType === 'review') {
    let rv = null
    try { rv = (await db.collection(C.REVIEWS).doc(r.targetId).get()).data } catch (e) { rv = null }
    if (!rv) return { handled: false, kind: 'review', note: '评价已不存在，无需隐藏' }
    if (rv.hidden) return { handled: false, kind: 'review', note: '评价已是隐藏状态' }
    await db.collection(C.REVIEWS).doc(rv._id).update({
      data: { hidden: true, hiddenReason: reason, hiddenTime: now() }
    })
    await addNotice({
      openid: rv.fromId,
      type: 'system',
      title: '评价已被隐藏',
      content: `你的一条评价因举报核实成立已被隐藏：${reason}`,
      orderId: ''
    })
    return { handled: true, kind: 'review', note: '评价已隐藏' }
  }

  return {
    handled: false,
    kind: r.targetType,
    note: r.targetType === 'user'
      ? '用户类举报不做自动处置（封禁比扣分重，留给管理员判断）'
      : '该类型不需要处置'
  }
}

async function handleReport(event) {
  const admin = await requireAdmin()
  assert(event.id, '缺少举报 id', 400)

  let r = null
  try {
    const res = await db.collection(C.REPORTS).doc(event.id).get()
    r = res.data || null
  } catch (e) { r = null }
  if (!r) throw bizError(404, '举报不存在')

  // ★ 幂等：已处理过的举报不再重复扣分 / 重复发通知
  if (r.status !== 0) return { ok: true }

  // ★ 契约收紧：result 只能是 1（成立）或 2（驳回）。
  //   不能写 `Number(event.result) === 1 ? 1 : 2` —— 那样会把非法值
  //   （缺失 / 3 / 'abc'）**静默当成「驳回」**处理，管理员传错参数拿不到任何提示。
  const result = Number(event.result)
  assert(result === 1 || result === 2, '处理结果只能是 1（成立）或 2（驳回）', 400)
  const remark = event.remark ? String(event.remark).slice(0, 200) : ''

  /*
   * ★ 核实成立时**先处置被举报的内容**，再更新举报单与记账。
   *   顺序理由：「让违规内容消失」比记账更紧急 ——
   *   即使后面某一步失败，内容也已经下架了，不会出现「扣了分但内容还在」。
   */
  let takeDown = { handled: false, note: '' }
  if (result === 1) {
    takeDown = await takeDownReported(r, remark || r.reason)
  }

  await db.collection(C.REPORTS).doc(r._id).update({
    data: {
      status: result,
      handleRemark: remark,
      handlerId: admin._openid,
      handleTime: now(),
      // ★ 把「对内容做了什么」一并留痕：以后复查能看出这条举报当时是否真的下架了内容
      takeDown: takeDown.handled ? takeDown.kind : ''
    }
  })

  if (result === 1) {
    if (r.targetUserId) {
      await changeCredit(r.targetUserId, -10, 'report_valid', '举报核实成立')
    }
    await addNotice({
      openid: r._openid,
      type: 'report',
      title: '举报已处理',
      content: `你提交的举报「${r.reason}」已核实成立，我们已对被举报方做出处理。感谢你的监督！`,
      orderId: ''
    })
  } else {
    await addNotice({
      openid: r._openid,
      type: 'report',
      title: '举报处理结果',
      content: `你提交的举报「${r.reason}」经核实未予成立${remark ? '：' + remark : ''}。感谢你的监督！`,
      orderId: ''
    })
  }
  return { ok: true, takeDown }
}

/* ============================ 轮播图 ============================ */
async function banners() {
  const res = await db.collection(C.BANNERS).orderBy('sort', 'asc').limit(GET_PAGE).get()
  return { list: res.data || [] }
}

async function saveBanner(event) {
  await requireAdmin()
  const data = {
    image: event.image || '',
    title: event.title ? String(event.title).slice(0, 40) : '',
    link: event.link || '',
    sort: Number(event.sort) || 99,
    status: event.status === undefined ? 1 : Number(event.status),
    updateTime: now()
  }

  if (event._id) {
    let old = null
    try {
      const r = await db.collection(C.BANNERS).doc(event._id).get()
      old = r.data || null
    } catch (e) { old = null }
    if (!old) throw bizError(404, '轮播图不存在')

    // 更新时**未传的字段必须沿用旧值**，不能回落到新增时的默认值：
    //   否则「只改标题」会把 status 0（停用）重置为启用 1、sort 从 2 掉到 99、image 被清空。
    //   saveCategory 是「保留 old.status」的正确写法，这里对齐。
    const patch = {
      image: event.image === undefined ? (old.image || '') : (event.image || ''),
      title: event.title === undefined ? (old.title || '') : String(event.title).slice(0, 40),
      link: event.link === undefined ? (old.link || '') : (event.link || ''),
      sort: event.sort === undefined ? (old.sort == null ? 99 : old.sort) : (Number(event.sort) || 99),
      status: event.status === undefined ? (old.status == null ? 1 : old.status) : Number(event.status),
      updateTime: now()
    }
    await db.collection(C.BANNERS).doc(old._id).update({ data: patch })
    return { id: old._id }
  }

  const addRes = await db.collection(C.BANNERS).add({ data: Object.assign({ createTime: now() }, data) })
  return { id: addRes._id }
}

async function deleteBanner(event) {
  await requireAdmin()
  assert(event._id, '缺少轮播图 _id', 400)
  // 幂等：重复删除同样返回 ok（与 mock 行为一致，不因已删除而报错）
  await db.collection(C.BANNERS).doc(event._id).remove()
  return { ok: true }
}

/* ============================ 全局配置 ============================ */
async function config() {
  return await getConfig()
}

/** saveConfig —— config 是 _id:'global' 的单文档，直接 set 覆盖 */
async function saveConfig(event) {
  await requireAdmin()
  const cur = await getConfig()

  const num = (v, dft) => {
    // 空串 / null / 纯空白必须先判掉再 Number()。
    //   Number('') === 0 且 0 >= 0 成立，于是前端数字输入框留空（传 ''）
    //   会把 minCreditToOrder 从 60 静默写成 0 —— 等于关闭信用门槛。
    if (v === null || v === undefined) return dft
    if (typeof v === 'string' && v.trim() === '') return dft
    const n = Number(v)
    return Number.isFinite(n) && n >= 0 ? n : dft
  }

  const data = {
    registerBonus: num(event.registerBonus, cur.registerBonus),
    orderExpireHours: num(event.orderExpireHours, cur.orderExpireHours),
    confirmExpireHours: num(event.confirmExpireHours, cur.confirmExpireHours),
    minCreditToOrder: num(event.minCreditToOrder, cur.minCreditToOrder),
    serviceFee: num(event.serviceFee, cur.serviceFee),
    hotCategories: Array.isArray(event.hotCategories) ? event.hotCategories.slice(0, 20) : (cur.hotCategories || []),
    aboutUs: typeof event.aboutUs === 'string' ? event.aboutUs.slice(0, 2000) : (cur.aboutUs || ''),
    // 白名单必须覆盖所有可写字段，因为收尾是 doc('global').set() 整篇覆盖 ——
    //   漏掉 subscribeTemplates，管理员保存任意配置都会把模板 ID 永久删掉，
    //   于是 order 云函数 tplId() 取不到模板，订阅消息静默失效。
    //   传对象则按 key 合并（保留未知模板），不传则原样沿用。
    subscribeTemplates: (event.subscribeTemplates &&
      typeof event.subscribeTemplates === 'object' &&
      !Array.isArray(event.subscribeTemplates))
      ? Object.assign({}, cur.subscribeTemplates || {}, event.subscribeTemplates)
      : (cur.subscribeTemplates || {}),
    updateTime: now()
  }

  // ★ 兜底：cur 里未被上面白名单覆盖的字段一律原样带回。
  //   doc('global').set() 是整篇覆盖，白名单漏任何一个字段都会造成
  //   「保存一次配置 = 永久删除该字段」。这样写之后，新增配置项也不会踩坑。
  Object.keys(cur || {}).forEach(k => {
    if (k === '_id' || k === 'updateTime') return
    if (data[k] === undefined) data[k] = cur[k]
  })

  // set 会整篇覆盖（_id 由 doc('global') 决定，不能再放进 data 里）
  await db.collection(C.CONFIG).doc('global').set({ data })
  return { ok: true }
}

/* ============================ debugInfo（仅调试员） ============================ */
/**
 * 调试员专用的环境 / 配置速查。
 *
 * ★ 它存在的意义不只是「有个功能」：
 *   它让 requireDebugger 这道关卡**真的被用上**，从而能被测试覆盖
 *   （普通管理员 → 403，调试员 → 0）。
 *   否则权限隔离就只有前端在演，云端其实没有边界 ——
 *   而前端是可以被绕过的。
 *
 * ★ 文案口径：管理员拿到的是和 requireAdmin 一样的「无管理员权限」，
 *   不透露「上面还有一层」，避免学生顺着报错去猜。
 */
async function debugInfo() {
  const u = await requireDebugger()
  const config = await getConfig()
  return {
    role: u.role,
    serverTime: now(),
    config
  }
}

/* ==================================================================
 * 入口（check 之外每个 action 内部都已 requireAdmin）
 * ================================================================== */
exports.main = wrap(async (event, context) => {
  const action = event.action || ''
  switch (action) {
    case 'check': return await check()
    case 'stats': await requireAdmin(); return await stats(event)

    case 'debugInfo': return await debugInfo(event)

    case 'users': await requireAdmin(); return await users(event)
    case 'auditUser': return await auditUser(event)
    case 'setUserStatus': return await setUserStatus(event)
    case 'setUserRole': return await setUserRole(event)
    case 'adjustCoins': return await adjustCoins(event)

    case 'categories': await requireAdmin(); return await categories()
    case 'saveCategory': return await saveCategory(event)
    case 'deleteCategory': return await deleteCategory(event)

    case 'skills': return await skills(event)
    case 'auditSkill': return await auditSkill(event)

    case 'orders': return await orders(event)

    case 'reports': return await reports(event)
  case 'appeals': return await appeals(event)
  case 'handleAppeal': return await handleAppeal(event)
    case 'handleReport': return await handleReport(event)

    case 'banners': await requireAdmin(); return await banners()
    case 'saveBanner': return await saveBanner(event)
    case 'deleteBanner': return await deleteBanner(event)

    case 'config': await requireAdmin(); return await config()
    case 'saveConfig': return await saveConfig(event)

    default: throw bizError(400, `未知 action: ${action}`)
  }
})
