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
  changeCredit, addNotice, checkText, SEC_SCENE
} = require('./shared')

/* ============================ 申诉（最小闭环） ============================ */
/*
 * 为什么要有：平台在此之前是**单向**的 —— 只有举报，没有申辩。
 *   举报核实成立直接扣 10 信用分、技能被判违规直接下架，
 *   被处置的人只收到一条通知，没有任何表达异议的渠道。
 *
 * 最小闭环只覆盖两件影响最直接的处置：
 *   · credit —— 信用分被扣（读 credit_logs 里那条扣分记录）
 *   · skill  —— 技能被违规下架（status=3）
 *   封禁暂不开放申诉：它比扣分重得多，涉及的风险也更高，
 *   先让流程跑顺再扩。
 *
 * 三道约束（缺一个都会让管理端被淹没）：
 *   ① 窗口期 —— 处置后 7 天内才能申诉
 *   ② 只能申诉**自己的**处置
 *   ③ 同一处置只能有一条未结案的申诉
 */
const APPEAL_WINDOW_MS = 7 * 24 * 3600 * 1000
/** 可申诉的处置类型 */
const APPEAL_TYPES = ['credit', 'skill']

/** appealCreate —— 提交申诉 */
async function appealCreate(event) {
  const me = await requireUser()

  const type = String(event.type || '')
  assert(APPEAL_TYPES.indexOf(type) > -1, '申诉类型不正确', 400)

  const targetId = String(event.targetId || '')
  assert(targetId, '缺少申诉对象', 400)

  const reason = String(event.reason == null ? '' : event.reason).trim().slice(0, 200)
  assert(reason, '请填写申诉理由', 400)
  const images = Array.isArray(event.images) ? event.images.slice(0, 3) : []

  // ★ 申诉理由也是用户写的 UGC，而且管理员必看 —— 和举报同理
  await checkText(reason, { scene: SEC_SCENE.COMMENT, openid: me._openid, label: '申诉理由' })

  let targetTitle = ''
  let createTime = 0
  let restore = null

  if (type === 'credit') {
    let log = null
    try { log = (await db.collection(C.CREDIT_LOGS).doc(targetId).get()).data } catch (e) { log = null }
    assert(log, '信用分记录不存在', 404)
    assert(log._openid === me._openid, '只能申诉自己的信用分变动', 403)
    // 只允许申诉**扣分**记录
    assert(Number(log.change) < 0, '只有被扣分的记录可以申诉', 400)
    targetTitle = (log.reasonText || '信用分变动') + ' ' + Number(log.change)
    createTime = Number(log.createTime) || 0
    // ★ 把「恢复多少分」在提交时就固化下来 ——
    //   处理时原记录可能已经变了，不能那时候再算
    restore = { scoreChange: Math.abs(Number(log.change)) || 0, prevStatus: 0 }
  } else {
    let sk = null
    try { sk = (await db.collection(C.SKILLS).doc(targetId).get()).data } catch (e) { sk = null }
    assert(sk, '技能不存在', 404)
    assert(sk.authorId === me._openid || sk._openid === me._openid, '只能申诉自己发布的技能', 403)
    assert(Number(sk.status) === 3, '只有被违规下架的技能可以申诉', 400)
    targetTitle = String(sk.title || '').slice(0, 60)
    createTime = Number(sk.updateTime) || Number(sk.createTime) || 0
    // 申诉成立则恢复上架
    restore = { scoreChange: 0, prevStatus: 1 }
  }

  // ① 窗口期
  if (createTime) {
    const days = Math.floor((Date.now() - createTime) / 86400000)
    assert(days <= 7, '已超过 7 天申诉期，无法再申诉', 409)
  }

  // ② 同一处置只允许一条未结案的申诉
  const dup = await db.collection(C.APPEALS)
    .where({ _openid: me._openid, type, targetId, status: 0 })
    .count()
  assert((dup.total || 0) === 0, '你已就这条记录提交过申诉，正在处理中', 409)

  const res = await db.collection(C.APPEALS).add({
    data: {
      _openid: me._openid,
      type,
      targetId,
      targetTitle,
      reason,
      images,
      restore,
      status: 0,
      handleRemark: '',
      handlerId: '',
      handleTime: null,
      createTime: now()
    }
  })
  return { ok: true, id: res._id }
}

/** appealList —— 我的申诉（含处理结果） */
async function appealList(event) {
  const me = await requireUser()
  const { page, size } = parsePage(event, 10)
  const res = await paginateQuery(
    db.collection(C.APPEALS).where({ _openid: me._openid }),
    { page, size, orderBy: [['createTime', 'desc']] }
  )
  return { list: res.list, total: res.total, hasMore: res.hasMore }
}

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

  /*
   * ★ 过滤被隐藏的评价（举报核实成立后会打 hidden 标记）。
   *   用 _.neq(true) 而不是 _.eq(false)：历史数据**没有 hidden 字段**，
   *   严格相等会把它们全部漏掉。
   */
  const where = role === 'received'
    ? { toId: openid, hidden: _.neq(true) }
    : { fromId: openid, hidden: _.neq(true) }
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

  // ★ 内容安全：评价挂在对方主页上，是典型的他人可见 UGC
  await checkText(content, { scene: SEC_SCENE.COMMENT, openid: me._openid, label: '评价内容' })

  const tags = Array.isArray(event.tags) ? event.tags.slice(0, 10) : []

  const toId = isBuyer ? order.sellerId : order.buyerId
  const target = await getUser(toId)
  assert(target, '被评价人不存在', 404)

  const fromInfo = { nickName: me.nickName || '匿名同学', avatarUrl: me.avatarUrl || '' }
  const toInfo = { nickName: target.nickName || '匿名同学', avatarUrl: target.avatarUrl || '' }

  // 1) ★ 原子抢占「评价位」（关键修复）
  //    不能「读订单判 isRatedBuyer → 中间隔 6 次 await 才写回订单」—— 这是 check-then-act：
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

/* ==================== 贡献排行榜 ==================== */
/**
 * ★ 排行榜按「累计收入」而不是「时间币余额」—— 这个选择很关键。
 *
 *   按**余额**排：靠前的人更有动力**不花出去**，币越堆越集中。
 *   一个全站只有 30 枚币的平台，前 3 名囤了 25 枚，剩下的人就没币交易了 ——
 *   **排行本身会加剧市场停摆**。
 *
 *   按**累计收入**排：收入 = 提供了多少服务。鼓励提供服务而不是囤积，
 *   与「用技能换技能」的初衷一致。而且花掉币不影响名次。
 *
 * 【匿名化必须在**服务端**做】
 *   只在客户端遮名字是没用的 —— 接口照样返回真名，抓个包就看见了。
 *   所以这里返回的 nickName 已经是脱敏后的。
 *
 * 【可退出】
 *   个人资料页可以关闭「参与排行榜」（leaderboardHidden = true）。
 *   校园是熟人圈，不是所有人都愿意被公开比较。
 *
 * 【为什么只给前 N 名】
 *   展示全站排名会让靠后的人被「公开处刑」—— 而新用户恰恰最需要鼓励。
 *   所以只给前 20 名 + 自己的名次。
 */
const RANK_LIMIT = 20

/** 昵称脱敏：王小明 → 王*明；两字 → 王*；一字 → 原样 */
function maskName(name) {
  const s = String(name || '').trim()
  if (s.length <= 1) return s || '同学'
  if (s.length === 2) return s.slice(0, 1) + '*'
  return s.slice(0, 1) + '*' + s.slice(-1)
}

/** leaderboard —— 贡献排行榜（前 N 名 + 我的名次） */
async function leaderboard(event) {
  const me = await requireUser()
  const limit = Math.min(50, Math.max(1, Number(event.limit) || RANK_LIMIT))

  /** 参与排行的条件：没退出 + 账号正常 */
  const base = { leaderboardHidden: _.neq(true), status: 1 }

  let list = []
  try {
    const res = await db.collection(C.USERS)
      .where(base)
      .orderBy('totalEarned', 'desc')
      .limit(limit)
      .get()
    list = res.data || []
  } catch (e) { list = [] }

  /* ★ 脱敏在服务端做；排名序也在服务端定，避免客户端各自算出错位 */
  const rows = list.map((u, i) => ({
    rank: i + 1,
    nickName: maskName(u.nickName),
    avatarUrl: u.avatarUrl || '',
    totalEarned: Number(u.totalEarned) || 0,
    serveCount: (u.stats && Number(u.stats.serveCount)) || 0,
    creditScore: Number(u.creditScore) || 0,
    /*
     * ★ 学院照常展示，不做脱敏。
     *   依据：学院信息**本来就在用户主页公开**（_shared 的 publicUser 保留了
     *   campus / college / major / grade），加到榜单不增加任何新的泄露。
     *   而且它正是榜单的价值之一 —— 「我们学院有人上榜」比一个光秃秃的昵称更有意义。
     */
    college: u.college || '',
    isMe: u._openid === me._openid
  }))

  /* 我的名次：比我收入高的人数 + 1（不依赖我是否在前 N 名里） */
  const myEarned = Number(me.totalEarned) || 0
  let myRank = 0
  try {
    const higher = await db.collection(C.USERS)
      .where({ leaderboardHidden: _.neq(true), status: 1, totalEarned: _.gt(myEarned) })
      .count()
    myRank = (higher.total || 0) + 1
  } catch (e) { myRank = 0 }

  return {
    list: rows,
    limit: limit,
    me: {
      rank: me.leaderboardHidden ? 0 : myRank,
      totalEarned: myEarned,
      serveCount: (me.stats && Number(me.stats.serveCount)) || 0,
      hidden: !!me.leaderboardHidden
    }
  }
}

/* ============================ cancel —— 注销账号 ============================ */
/**
 * 注销账号：**匿名化**，不做物理删除。
 *
 * 为什么不能物理删除：你服务过的订单、你在对方那里的评价，都还挂在对方那边。
 * 删掉 users 文档会让那些记录指向一个不存在的用户，对方的「我的订单」直接崩。
 * 所以保留文档与业务记录，只抹掉**能指向具体人**的字段。
 *
 * 拒绝条件：还有进行中的订单 —— 否则对方约不到人、订单永远卡住。
 */
async function cancelAccount() {
  const me = await requireUser()
  assert(!me.canceled, '该账号已注销，无需重复操作', 409)

  const ACTIVE = ['waiting', 'ongoing', 'confirming']
  const asBuyer = await db.collection(C.ORDERS)
    .where({ buyerId: me._openid, status: _.in(ACTIVE) }).count()
  const asSeller = await db.collection(C.ORDERS)
    .where({ sellerId: me._openid, status: _.in(ACTIVE) }).count()
  const active = (asBuyer.total || 0) + (asSeller.total || 0)
  assert(active === 0, `你还有 ${active} 个进行中的订单，请先完成或取消它们再注销`, 409)

  /*
   * ★ 只抹掉「能指向具体人」的字段。
   *   时间币 / 信用分 / 统计数据**保留** —— 它们是与其他人的往来记录，
   *   而且「时间币总额守恒」是全项目的硬约束，凭空清掉会破坏账。
   */
  const data = {
    canceled: true,
    canceledTime: now(),
    status: 0,                  // 注销后不能再登录

    nickName: '已注销用户',
    avatarUrl: '',
    realName: '',
    studentNo: '',
    phone: '',
    campus: '',
    college: '',
    major: '',
    grade: '',
    bio: '',
    tags: [],
    // 认证材料是最敏感的部分（证件照等），必须清
    authStatus: 0,
    authImages: [],
    authRemark: '',
    authTime: 0,
    // 定位
    location: null,
    locationName: '',
    locationTime: null,

    updateTime: now()
  }

  await db.collection(C.USERS).doc(me._id).update({ data })

  // 内部账户：把会话一并作废，否则旧令牌仍然能操作
  try {
    await db.collection(C.SESSIONS).where({ accountOpenid: me._openid }).remove()
  } catch (e) { /* 没有会话是常态 */ }

  return { ok: true }
}

/* ==================================================================
 * 入口
 * ================================================================== */
exports.main = wrap(async (event, context) => {
  const action = event.action || ''
  switch (action) {
    case 'mine': return await mine()
    // 注：参与排行的开关走 login.updateProfile 的 leaderboardHidden 字段
    case 'home': return await home(event)
    case 'creditLogs': return await creditLogs(event)
    case 'badges': return await badges(event)
    case 'reviews': return await reviews(event)
    case 'reviewCreate': return await reviewCreate(event)
    case 'reviewReply': return await reviewReply(event)
    case 'cancel': return await cancelAccount(event)
    case 'leaderboard': return await leaderboard(event)
    case 'appealCreate': return await appealCreate(event)
    case 'appealList': return await appealList(event)
    default: throw bizError(400, `未知 action: ${action}`)
  }
})
