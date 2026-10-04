/**
 * 云函数 user —— 个人中心 / 信用分 / 徽章 / 评价（ARCHITECTURE.md §4.5）
 * ==================================================================
 * action：
 *   mine         个人中心聚合（并行 count 查询）
 *   home         他人主页（公开资料 + 技能 + 收到的评价 + 统计）
 *   creditLogs   信用分流水（分页）
 *   badges       徽章（动态判定；查自己才增量写回 users.badges，查他人只读计算）
 *   reviews      评价列表（收到 / 发出）
 *   reviewCreate 发表评价（星级 → 信用分联动）
 *   reviewReply  回复评价（仅被评价人）
 *
 * 返回结构必须与 Campus Time Bank/utils/mock.js 中同名 handler 逐字段一致。
 * ==================================================================
 */
const {
  db, _, $, C,
  wrap, bizError, assert,
  now, parsePage, paginateQuery,
  requireUser, getUser, publicUser, getOpenId,
  changeCredit, addNotice
} = require('./shared')

/* ==================================================================
 * 徽章定义
 * ------------------------------------------------------------------
 * ★ 从 Campus Time Bank/utils/constants.js 的 BADGES 复制一份：
 *   云函数独立打包，无法 require 小程序目录，只能复制。
 * ★ 同步要求（改一处必须同时改三处，否则前后端徽章不一致）：
 *   ① 本文件顶部的 BADGES                  ← 权威判定（服务端）
 *   ② Campus Time Bank/utils/constants.js 的 BADGES       ← 名称/图标/文案
 *   ③ Campus Time Bank/utils/credit.js 的 calcBadges      ← 前端即时预判展示
 * ================================================================== */
const BADGES = [
  { id: 'newbie', name: '初出茅庐', icon: '🌱', color: '#0EA47A', desc: '完成第一笔订单' },
  { id: 'ontime', name: '守时达人', icon: '⏰', color: '#3B82F6', desc: '连续 5 单按时完成' },
  { id: 'warm', name: '热心助人', icon: '❤️', color: '#F5483B', desc: '完成 10 次技能提供' },
  { id: 'expert', name: '技能达人', icon: '🎯', color: '#FF8B3D', desc: '同一分类完成 5 单且评分 ≥ 4.5' },
  { id: 'trust', name: '信用之星', icon: '⭐', color: '#F5B301', desc: '信用分达到 120' },
  { id: 'popular', name: '人气之星', icon: '🔥', color: '#FF6B35', desc: '发布的技能被浏览 500 次' },
  { id: 'social', name: '社交达人', icon: '💬', color: '#7C5CFF', desc: '收到 20 条以上评价' }
]
const BADGE_MAP = BADGES.reduce((m, b) => (m[b.id] = b, m), {})

/** 归一化 stats，避免 undefined 进入前端 data */
function normalizeStats(st) {
  const s = st || {}
  return {
    publishCount: Number(s.publishCount) || 0,
    serveCount: Number(s.serveCount) || 0,
    buyCount: Number(s.buyCount) || 0,
    reviewCount: Number(s.reviewCount) || 0,
    ratingSum: Number(s.ratingSum) || 0,
    avgRating: Number(s.avgRating) || 0,
    ontimeStreak: Number(s.ontimeStreak) || 0
  }
}

/* ==================================================================
 * 徽章动态判定（§6.3）
 * ================================================================== */
/**
 * 计算用户当前应得的徽章 id 数组
 * @param {Object} user users 文档
 * @returns {Promise<String[]>}
 */
async function computeBadges(user) {
  if (!user) return []
  const st = normalizeStats(user.stats)
  const owned = []

  // newbie：完成首单（提供服务或购买服务任一次）
  if (st.serveCount + st.buyCount >= 1) owned.push('newbie')
  // ontime：连续 5 单按时完成
  if (st.ontimeStreak >= 5) owned.push('ontime')
  // warm：完成「提供技能」≥ 10 单
  if (st.serveCount >= 10) owned.push('warm')
  // expert：同一分类完成 ≥ 5 单 且 平均评分 ≥ 4.5
  if (st.avgRating >= 4.5) {
    const res = await db.collection(C.ORDERS).aggregate()
      .match({ sellerId: user._openid, status: 'finished' })
      .group({ _id: '$skillSnapshot.categoryName', value: $.sum(1) })
      .sort({ value: -1 })
      .limit(1)
      .end()
    const top = (res.list || [])[0]
    if (top && Number(top.value) >= 5) owned.push('expert')
  }
  // trust：信用分 ≥ 120
  if ((Number(user.creditScore) || 100) >= 120) owned.push('trust')
  // popular：自己所有技能被浏览之和 ≥ 500
  const views = await db.collection(C.SKILLS).aggregate()
    .match({ authorId: user._openid })
    .group({ _id: null, total: $.sum('$viewCount') })
    .end()
  const viewTotal = Number(((views.list || [])[0] || {}).total) || 0
  if (viewTotal >= 500) owned.push('popular')
  // social：收到评价 ≥ 20 条
  if (st.reviewCount >= 20) owned.push('social')

  return owned
}

/**
 * 判定并「增量补发」徽章到 users.badges（去重，已拥有的不重复写）
 * 这样徽章墙 / 个人中心 / 他人主页都能直接读 users.badges
 * @returns {Promise<String[]>} 判定出的完整徽章 id 列表
 */
async function syncBadges(user) {
  if (!user) return []
  const computed = await computeBadges(user)
  const current = (user.badges || []).slice()
  const added = computed.filter(id => current.indexOf(id) < 0)
  if (added.length) {
    await db.collection(C.USERS).doc(user._id).update({
      data: { badges: current.concat(added), updateTime: now() }
    })
  }
  return computed
}

/** id 数组 → 徽章对象数组 */
const toBadgeObjects = ids => (ids || []).map(id => BADGE_MAP[id]).filter(Boolean)

/* ==================================================================
 * actions
 * ================================================================== */

/** mine —— 个人中心聚合：counts 用并行 count 查询 */
async function mine() {
  const me = await requireUser()
  const openid = me._openid
  const st = normalizeStats(me.stats)

  // ★ 并行 count：技能发布数 / 未读通知 / 我作为买家与卖家各自待处理订单数
  //   （serve / buy / review 直接取 users.stats 冗余字段，不必再查库）
  const [publishRes, unreadRes, waitBuyRes, waitSellRes, favRes] = await Promise.all([
    db.collection(C.SKILLS).where({ authorId: openid }).count(),
    db.collection(C.NOTICES).where({ _openid: openid, read: false }).count(),
    db.collection(C.ORDERS).where({ buyerId: openid, status: _.in(['waiting', 'confirming']) }).count(),
    db.collection(C.ORDERS).where({ sellerId: openid, status: _.in(['waiting', 'confirming']) }).count(),
    db.collection(C.FAVORITES).where({ _openid: openid }).count()
  ])

  const badgeIds = await syncBadges(me)

  return {
    user: me,
    counts: {
      publish: (publishRes && publishRes.total) || 0,
      serve: st.serveCount,
      buy: st.buyCount,
      unreadNotice: (unreadRes && unreadRes.total) || 0,
      waitingOrder: ((waitBuyRes && waitBuyRes.total) || 0) + ((waitSellRes && waitSellRes.total) || 0),
      review: st.reviewCount,
      collected: (favRes && favRes.total) || 0
    },
    badges: toBadgeObjects(badgeIds)
  }
}

/** home —— 他人主页：公开资料 + 上架技能前 6 条 + 收到的评价前 3 条 + stats */
async function home(event) {
  const openid = event.openid
  assert(openid, '缺少 openid', 400)
  const u = await getUser(openid)
  if (!u) throw bizError(404, '用户不存在')

  const [skillsRes, reviewsRes] = await Promise.all([
    db.collection(C.SKILLS)
      .where({ authorId: openid, status: 1 })
      .orderBy('createTime', 'desc')
      .limit(6)
      .get(),
    db.collection(C.REVIEWS)
      .where({ toId: openid })
      .orderBy('createTime', 'desc')
      .limit(3)
      .get()
  ])

  return {
    user: publicUser(u),               // 过滤 phone / studentNo / authImages
    skills: skillsRes.data || [],
    reviews: reviewsRes.data || [],
    stats: normalizeStats(u.stats)
  }
}

/** creditLogs —— 我的信用分流水，createTime 倒序分页 */
async function creditLogs(event) {
  const me = await requireUser()
  const { page, size } = parsePage(event, 10)
  const res = await paginateQuery(
    db.collection(C.CREDIT_LOGS).where({ _openid: me._openid }),
    { page, size, orderBy: [['createTime', 'desc']] }
  )
  return { list: res.list, total: res.total, hasMore: res.hasMore }
}

/** badges —— 徽章墙：owned 为已获得徽章对象，all 为全部徽章（带 owned 标记） */
async function badges(event) {
  const me = await requireUser()
  const target = event.openid ? await getUser(event.openid) : me
  if (!target) throw bizError(404, '用户不存在')

  // ★ 安全边界：只把徽章写回**自己**的 users.badges。
  //   查询他人徽章时仅做只读计算（computeBadges），绝不写对方的用户文档 ——
  //   否则任何登录用户传一个 openid 就能触发对他人文档的写入。
  const isSelf = !event.openid || event.openid === getOpenId()
  const ownedIds = isSelf
    ? await syncBadges(target)       // 自己：增量去重写回，其它页面可直接复用
    : await computeBadges(target)    // 他人：纯计算，不落库

  return {
    owned: toBadgeObjects(ownedIds),
    all: BADGES.map(b => Object.assign({}, b, { owned: ownedIds.indexOf(b.id) > -1 }))
  }
}

/** reviews —— 评价列表：received 按 toId / sent 按 fromId */
async function reviews(event) {
  const me = await requireUser()
  const openid = event.openid || me._openid
  const role = event.role === 'sent' ? 'sent' : 'received'
  const { page, size } = parsePage(event, 10)

  const where = role === 'received' ? { toId: openid } : { fromId: openid }
  const res = await paginateQuery(
    db.collection(C.REVIEWS).where(where),
    { page, size, orderBy: [['createTime', 'desc']] }
  )
  return { list: res.list, total: res.total, hasMore: res.hasMore }
}

/** reviewCreate —— 发表评价（订单已完成且未评价过） */
async function reviewCreate(event) {
  const me = await requireUser()
  const orderId = event.orderId
  const score = Number(event.score)
  assert(orderId, '缺少 orderId', 400)
  assert(score >= 1 && score <= 5, '请选择 1-5 星评分', 400)

  // 订单存在性
  let order = null
  try {
    const r = await db.collection(C.ORDERS).doc(orderId).get()
    order = r.data || null
  } catch (e) {
    order = null
  }
  if (!order) throw bizError(404, '订单不存在')
  assert(order.status === 'finished', '订单完成后才能评价', 409)

  const isBuyer = order.buyerId === me._openid
  const isSeller = order.sellerId === me._openid
  assert(isBuyer || isSeller, '只有订单参与方可以评价', 403)
  assert(isBuyer ? !order.isRatedBuyer : !order.isRatedSeller, '你已经评价过了', 409)

  const rawContent = event.content == null ? '' : String(event.content)
  assert(rawContent.length <= 200, '评价内容不超过 200 字', 400)
  const content = rawContent.trim()
  const tags = Array.isArray(event.tags) ? event.tags.slice(0, 10) : []

  const toId = isBuyer ? order.sellerId : order.buyerId
  const target = await getUser(toId)
  assert(target, '被评价人不存在', 404)

  const fromInfo = { nickName: me.nickName || '匿名同学', avatarUrl: me.avatarUrl || '' }
  const toInfo = { nickName: target.nickName || '匿名同学', avatarUrl: target.avatarUrl || '' }

  // 1) ★ 原子抢占「评价位」（关键修复）
  //    原实现是「读订单判 isRatedBuyer → 中间隔 6 次 await 才写回订单」，属 check-then-act：
  //    同一方的两个并发评价会**双双通过校验** → 落 2 条评价、2 条 +1 信用流水，
  //    但 creditScore 只 +1（**账实不符**），还能刷 social 徽章、重复发通知。
  //    改成条件 update 抢占：并发下只有一个请求能把 false 改成 true（updated === 1），
  //    其余拿到 updated === 0 → 409。后续写入因此天然只发生一次。
  const claim = await db.collection(C.ORDERS)
    .where(Object.assign({ _id: order._id },
      isBuyer ? { isRatedBuyer: false } : { isRatedSeller: false }))
    .update({
      data: isBuyer
        ? { isRatedBuyer: true, buyerScore: score }
        : { isRatedSeller: true, sellerScore: score }
    })
  if (!claim.stats || claim.stats.updated !== 1) throw bizError(409, '你已经评价过了')

  // 2) 写评价（字段严格按 §3.5）
  await db.collection(C.REVIEWS).add({
    data: {
      orderId: order._id,
      skillId: order.skillId || '',
      fromId: me._openid,
      fromInfo,
      toId,
      toInfo,
      role: isBuyer ? 'buyer' : 'seller',
      score,
      tags,
      content,
      anonymous: !!event.anonymous,
      reply: null,
      createTime: now()
    }
  })

  // 3) 被评价人统计：reviewCount +1、ratingSum += score、avgRating 重算（保留 1 位小数）
  const tst = normalizeStats(target.stats)
  const reviewCount = tst.reviewCount + 1
  const ratingSum = tst.ratingSum + score
  const avgRating = Math.round((ratingSum / reviewCount) * 10) / 10
  await db.collection(C.USERS).doc(target._id).update({
    data: {
      'stats.reviewCount': reviewCount,
      'stats.ratingSum': ratingSum,
      'stats.avgRating': avgRating,
      updateTime: now()
    }
  })

  // 4) 信用分联动（delta 为 0 时不调 changeCredit，避免无意义的流水）
  const deltaMap = { 5: 1, 4: 0, 3: -1, 2: -2, 1: -3 }
  const delta = deltaMap[score] || 0
  if (delta) await changeCredit(toId, delta, 'review_' + score, `收到 ${score} 星评价`, order._id)

  // 5) 通知被评价人
  const skillTitle = (order.skillSnapshot && order.skillSnapshot.title) || '技能服务'
  await addNotice({
    openid: toId,
    type: 'order',
    title: `收到 ${score} 星评价`,
    content: `${event.anonymous ? '一位同学' : (me.nickName || '一位同学')} 评价了你的「${skillTitle}」：${score} 星${content ? '。' + content.slice(0, 40) : ''}`,
    orderId: order._id
  })

  // 6) 复算徽章（social / expert 等可能刚好达标）
  const fresh = await getUser(toId)
  if (fresh) await syncBadges(fresh)

  return { ok: true }
}

/** reviewReply —— 被评价人回复评价 */
async function reviewReply(event) {
  const me = await requireUser()
  assert(event.reviewId, '缺少 reviewId', 400)
  const content = event.content == null ? '' : String(event.content).trim()
  assert(content, '回复内容不能为空', 400)
  assert(content.length <= 200, '回复内容不超过 200 字', 400)

  let review = null
  try {
    const r = await db.collection(C.REVIEWS).doc(event.reviewId).get()
    review = r.data || null
  } catch (e) {
    review = null
  }
  if (!review) throw bizError(404, '评价不存在')
  assert(review.toId === me._openid, '只能回复给自己的评价', 403)

  await db.collection(C.REVIEWS).doc(review._id).update({
    data: { reply: { content, time: now() } }
  })
  return { ok: true }
}

/* ==================================================================
 * 入口
 * ================================================================== */
exports.main = wrap(async (event, context) => {
  const action = event.action || ''
  switch (action) {
    case 'mine': return await mine()
    case 'home': return await home(event)
    case 'creditLogs': return await creditLogs(event)
    case 'badges': return await badges(event)
    case 'reviews': return await reviews(event)
    case 'reviewCreate': return await reviewCreate(event)
    case 'reviewReply': return await reviewReply(event)
    default: throw bizError(400, `未知 action: ${action}`)
  }
})
