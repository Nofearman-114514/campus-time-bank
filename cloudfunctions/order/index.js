/**
 * 校园时间银行 · 订单域云函数（★ 时间币事务核心）
 * ==================================================================
 * 【时间币为什么要冻结】时间币是平台唯一的「货币」，下单时若直接打给服务方，一旦对方拒单、
 * 爽约或超时未接单，钱已经在别人账上，平台没有任何强制手段追回。所以下单只把款项从可用余额
 * coins 划入冻结额 frozenCoins（钱仍属买家、只是被锁住不能再花），确认完成才真正结算给服务方，
 * 取消 / 拒单 / 超时一律解冻原路退回。任何时刻平台时间币总量恒等于 Σ(coins + frozenCoins)，账实对得上。
 * 【confirm 为什么要用事务】结算是「一笔记账、多处改写」：买家减冻结、卖家加余额、订单置完成、
 * 双方统计同时更新，必须同生共死，否则会出现「钱扣了订单没完成」这类无法靠对账修复的脏账。
 * 事务内统一「先 get 读出 → 在 JS 里算绝对值 → update 写绝对值」，不用 _.inc() 等更新指令，
 * 避免事务内更新指令语义不确定而算错余额。
 * 【并发下单如何避免超卖】余额校验与扣减在同一事务、同一份快照内完成：两个请求同时下单时，
 * 后提交的事务检测到写冲突会自动重试，重试后读到的是对方已扣减的新余额，不足即抛 409 回滚 ——
 * 「够不够」和「扣没扣」是一个原子判断，不会出现两边都读到 10 枚、各扣 6 枚的超卖。
 * ==================================================================
 */
const {
  db, _, C,
  wrap, bizError, assert,
  now, hoursLater, genOrderNo, parsePage, paginateQuery,
  getOpenId, getUser, requireUser, getConfig,
  creditLevelOf, orderLimitOf, changeCredit, addWalletLog, addNotice, sendSubscribe,
  partySnapshot, canOrderSkill,
  isAdminUser, checkText, SEC_SCENE
} = require('./shared')

/* ============================ 本地常量 ============================ */
/** 进行中（占用买家「同时进行订单数」额度）的状态 */
const ACTIVE_STATUS = ['waiting', 'ongoing', 'confirming']
/** 可取消的状态 */
const CANCELABLE_STATUS = ['waiting', 'ongoing']

/**
 * 信用等级的「可同时进行订单数」不再在本文件定义：
 * 唯一权威定义在共享层 CREDIT_LEVELS.limit（ARCHITECTURE §6.2），通过 orderLimitOf() 取。
 */
const LEVEL_TEXT = {
  excellent: '极佳', good: '优秀', normal: '良好', weak: '一般', limited: '受限'
}

/** 订阅消息模板 ID：留空或 config 未配置时 sendSubscribe 内部会跳过，不阻断主流程 */
const SUB_TEMPLATES = {
  ORDER_CREATE: '',
  ORDER_ACCEPT: '',
  ORDER_FINISH: '',
  ORDER_CONFIRM: ''
}

/* ============================ 本地工具 ============================ */
function levelTextOf(score) {
  return LEVEL_TEXT[creditLevelOf(score)] || '良好'
}

/** 订单补上「对我而言的角色」，与 utils/mock.js 的 withRole 保持一致 */
function withRole(o, openid) {
  const order = Object.assign({}, o)
  if (o.buyerId === openid) order.role = 'buyer'
  else if (o.sellerId === openid) order.role = 'seller'
  else order.role = 'admin'                       // 管理员旁观，非参与方
  order.roleText = order.role === 'buyer' ? '我买到的' : (order.role === 'seller' ? '我接的单' : '订单详情')
  order.counterpart = order.role === 'buyer' ? (o.sellerInfo || {}) : (o.buyerInfo || {})
  order.counterpartId = order.role === 'buyer' ? o.sellerId : o.buyerId
  return order
}

/** 按 _id 或 orderNo 找订单 */
async function findOrder(key) {
  assert(key, '缺少订单参数 orderId')
  const res = await db.collection(C.ORDERS)
    .where(_.or([{ _id: key }, { orderNo: key }]))
    .limit(1)
    .get()
  return (res.data && res.data[0]) || null
}

/** 事务外的补偿写入：失败只记日志，绝不让「已经成功的订单」变成客户端眼中的失败 */
async function bestEffort(label, fn) {
  try {
    return await fn()
  } catch (e) {
    console.error(`[order] 事务外补写失败（${label}）：`, (e && e.message) || e)
    return null
  }
}

function tplId(config, key) {
  const fromConfig = (config && config.subscribeTemplates && config.subscribeTemplates[key]) || ''
  return fromConfig || SUB_TEMPLATES[key] || ''
}

/**
 * 订阅消息数据（字段名需与公众平台所选模板一致，换模板时同步改这里）
 * 模板 ID 未配置时 sendSubscribe 会直接跳过，因此这里不会影响主流程。
 */
function subPayload(order, statusText) {
  return {
    thing1: { value: String((order.skillSnapshot && order.skillSnapshot.title) || '校园技能服务').slice(0, 20) },
    thing2: { value: String(statusText || '订单状态更新').slice(0, 20) },
    character_string3: { value: String(order.orderNo || '') },
    amount4: { value: String(order.amount || 0) }
  }
}

/** 给用户补发徽章（去重后整体回写 badges 数组） */
async function awardBadges(openid, ids) {
  const want = (ids || []).filter(Boolean)
  if (!want.length) return []
  const u = await getUser(openid)
  if (!u) return []
  const owned = (u.badges || []).slice()
  const add = want.filter(id => owned.indexOf(id) < 0)
  if (!add.length) return []
  await db.collection(C.USERS).doc(u._id).update({
    data: { badges: owned.concat(add), updateTime: now() }
  })
  console.log(`[order] 补发徽章 ${openid} → ${add.join(',')}`)
  return add
}

/** 连续按时完成记录清零（接单后取消 / 爽约） */
async function resetStreak(openid) {
  const u = await getUser(openid)
  if (!u) return
  const stats = Object.assign({}, u.stats || {})
  if (!stats.ontimeStreak) return
  stats.ontimeStreak = 0
  await db.collection(C.USERS).doc(u._id).update({ data: { stats, updateTime: now() } })
}

/* ==================================================================
 * 核心：关闭订单并解冻退回买家时间币（reject / cancel / 超时共用）
 * 金额变动一律走事务 + 绝对值写，避免「订单关了钱没退」。
 * ================================================================== */
async function closeAndRefund(order, by, status, reason, remark, operator) {
  const buyerDoc = await getUser(order.buyerId)
  assert(buyerDoc, '买家不存在', 404)
  const t = now()

  const r = await db.runTransaction(async tx => {
    const oRes = await tx.collection(C.ORDERS).doc(order._id).get()
    const o = oRes.data
    assert(o, '订单不存在', 404)
    assert(CANCELABLE_STATUS.indexOf(o.status) > -1, '当前状态不能取消或关闭', 409)

    const bRes = await tx.collection(C.USERS).doc(buyerDoc._id).get()
    const b = bRes.data
    assert(b, '买家不存在', 404)

    const amount = Math.round(Number(o.amount) || 0)
    // 绝对值写法：解冻 = 可用余额加回、冻结额减掉
    const coins = (b.coins || 0) + amount
    const frozenCoins = Math.max(0, (b.frozenCoins || 0) - amount)

    await tx.collection(C.USERS).doc(buyerDoc._id).update({
      data: { coins, frozenCoins, updateTime: t }
    })
    await tx.collection(C.ORDERS).doc(o._id).update({
      data: {
        status,
        cancelBy: by,
        cancelReason: reason,
        cancelTime: t,
        timeline: (o.timeline || []).concat([{ status, time: t, remark, operator }])
      }
    })
    return { order: o, amount, coins, frozenCoins }
  })

  // —— 事务外补写 ——
  await bestEffort('close.walletLog', () => addWalletLog({
    openid: order.buyerId,
    type: 'unfreeze',
    amount: r.amount,
    balance: r.coins,
    frozen: r.frozenCoins,
    orderId: order._id,
    orderNo: order.orderNo,
    remark: '订单取消，时间币退回'
  }))
  return r
}

/* ==================================================================
 * action: create —— 下单（冻结买家时间币）
 * ================================================================== */
async function actionCreate(event, openid) {
  const skillId = event.skillId || event.id
  assert(skillId, '缺少技能参数 skillId')

  const config = await getConfig()
  const buyer = await requireUser(openid)

  // ① 事务外快路径预检：只为尽早抛出友好错误，真正的判定仍在事务内
  let skill = null
  try {
    const res = await db.collection(C.SKILLS).doc(skillId).get()
    skill = res.data || null
  } catch (e) {
    skill = null
  }
  canOrderSkill(skill, buyer, config)
  const seller = await getUser(skill.authorId)

  // ② 同时进行中订单数上限（ARCHITECTURE §6.2 信用等级权益）
  const limit = orderLimitOf(buyer.creditScore)
  const activeRes = await db.collection(C.ORDERS)
    .where({ buyerId: buyer._openid, status: _.in(ACTIVE_STATUS) })
    .count()
  const active = activeRes.total || 0
  if (active >= limit) {
    throw bizError(409, `你当前的信用等级「${levelTextOf(buyer.creditScore)}」最多同时进行 ${limit} 单，现有 ${active} 单还没结束，先处理完再来下单吧～`)
  }

  const orderNo = genOrderNo()
  const createTime = now()
  const expireTime = hoursLater(Number(config.orderExpireHours) || 24)
  const remark = String(event.remark || '').slice(0, 200)
  const expectTime = String(event.expectTime || '').slice(0, 50)
  const contact = String(event.contact || '').slice(0, 50)

  // ★ 内容安全：留言会被服务方看到（空内容 checkText 会直接跳过，不白调接口）
  await checkText(remark, { scene: SEC_SCENE.COMMENT, openid: buyer._openid, label: '留言' })
  const sellerInfo = seller
    ? partySnapshot(seller)
    : partySnapshot({
      nickName: (skill.authorInfo && skill.authorInfo.nickName) || '匿名同学',
      avatarUrl: (skill.authorInfo && skill.authorInfo.avatarUrl) || '',
      creditScore: (skill.authorInfo && skill.authorInfo.creditScore) || 100
    })

  const r = await db.runTransaction(async tx => {
    // 事务内重读技能与买家：价格、上架状态、余额都以同一份快照为准
    const sRes = await tx.collection(C.SKILLS).doc(skillId).get()
    const txSkill = sRes.data
    const bRes = await tx.collection(C.USERS).doc(buyer._id).get()
    const txBuyer = bRes.data
    assert(txBuyer, '用户不存在，请重新登录', 401)
    canOrderSkill(txSkill, txBuyer, config)   // 上架中 / 不能买自己的 / 已认证 / 信用分 / 余额

    const amount = Math.round(Number(txSkill.price) || 0)
    assert(amount >= 1, '技能时间币价格异常，暂时无法下单')

    // ★ 绝对值写法：先算出结果再写，不用 _.inc()
    const coins = (txBuyer.coins || 0) - amount
    const frozenCoins = (txBuyer.frozenCoins || 0) + amount
    const orderCount = (txSkill.orderCount || 0) + 1

    await tx.collection(C.USERS).doc(buyer._id).update({
      data: { coins, frozenCoins, updateTime: createTime }
    })

    const addRes = await tx.collection(C.ORDERS).add({
      data: {
        _openid: buyer._openid,                 // 买家即创建者
        orderNo,
        skillId,
        skillSnapshot: {                        // §3.4 严格快照
          title: txSkill.title || '',
          price: amount,
          duration: txSkill.duration || 60,
          categoryName: txSkill.categoryName || '其他',
          images: txSkill.images || [],
          type: txSkill.type || 'offer'
        },
        buyerId: buyer._openid,
        buyerInfo: partySnapshot(txBuyer),
        sellerId: txSkill.authorId,
        sellerInfo,
        amount,
        status: 'waiting',
        remark,
        expectTime,
        contact,
        timeline: [{
          status: 'waiting',
          time: createTime,
          remark: '买家下单，时间币已冻结',
          operator: buyer._openid
        }],
        cancelBy: '',
        cancelReason: '',
        isRatedBuyer: false,
        isRatedSeller: false,
        buyerScore: 0,
        sellerScore: 0,
        createTime,
        acceptTime: null,
        finishTime: null,
        confirmTime: null,
        cancelTime: null,
        expireTime
      }
    })

    await tx.collection(C.SKILLS).doc(skillId).update({
      data: { orderCount, updateTime: createTime }
    })

    return {
      orderId: addRes._id,
      orderNo,
      amount,
      coins,
      frozenCoins,
      title: txSkill.title || '校园技能服务',
      sellerId: txSkill.authorId
    }
  })

  // —— 事务外补写（失败不阻断，订单已成立）——
  await bestEffort('create.walletLog', () => addWalletLog({
    openid: buyer._openid,
    type: 'freeze',
    amount: -r.amount,
    balance: r.coins,
    frozen: r.frozenCoins,
    orderId: r.orderId,
    orderNo: r.orderNo,
    remark: `下单冻结：${r.title}`
  }))
  await bestEffort('create.notice', () => addNotice({
    openid: r.sellerId,
    type: 'order',
    title: '收到新订单',
    content: `${buyer.nickName || '有同学'} 想要你的「${r.title}」，快去看看吧。`,
    orderId: r.orderId
  }))
  const orderLite = { orderNo: r.orderNo, amount: r.amount, skillSnapshot: { title: r.title } }
  await bestEffort('create.subscribe', () => sendSubscribe({
    openid: r.sellerId,
    templateId: tplId(config, 'ORDER_CREATE'),
    page: `pages/order/detail/detail?orderId=${r.orderId}`,
    data: subPayload(orderLite, '有新的订单待接单')
  }))

  return { orderId: r.orderId, orderNo: r.orderNo }
}

/* ==================================================================
 * action: accept —— 卖家接单（waiting → ongoing）
 * ================================================================== */
async function actionAccept(event, openid) {
  const me = await requireUser(openid)
  const order = await findOrder(event.orderId)
  assert(order, '订单不存在', 404)
  if (order.sellerId !== openid && !isAdminUser(me)) throw bizError(403, '只有服务者可以接单')

  const config = await getConfig()
  const t = now()
  // 条件更新 = 原子抢占：并发的两个接单请求只有一个能改到 waiting 的文档
  const res = await db.collection(C.ORDERS)
    .where({ _id: order._id, status: 'waiting' })
    .update({
      data: {
        status: 'ongoing',
        acceptTime: t,
        timeline: _.push([{
          status: 'ongoing',
          time: t,
          remark: '服务者已接单',
          operator: openid
        }])
      }
    })
  if (!res.stats || res.stats.updated !== 1) throw bizError(409, '该订单已被处理')

  const title = (order.skillSnapshot && order.skillSnapshot.title) || '校园技能服务'
  const sellerName = (order.sellerInfo && order.sellerInfo.nickName) || '服务者'
  await bestEffort('accept.notice', () => addNotice({
    openid: order.buyerId,
    type: 'order',
    title: '有人接单啦',
    content: `${sellerName} 已接下你的「${title}」，快去聊聊具体时间吧。`,
    orderId: order._id
  }))
  await bestEffort('accept.subscribe', () => sendSubscribe({
    openid: order.buyerId,
    templateId: tplId(config, 'ORDER_ACCEPT'),
    page: `pages/order/detail/detail?orderId=${order._id}`,
    data: subPayload(order, '服务者已接单')
  }))
  return { ok: true }
}

/* ==================================================================
 * action: reject —— 卖家拒单（waiting → closed，解冻退回买家）
 * ================================================================== */
async function actionReject(event, openid) {
  const me = await requireUser(openid)
  const order = await findOrder(event.orderId)
  assert(order, '订单不存在', 404)
  if (order.sellerId !== openid && !isAdminUser(me)) throw bizError(403, '只有服务者可以拒单')
  assert(order.status === 'waiting', '该订单已被处理', 409)

  const reason = String(event.reason || '').trim() || '服务者暂时无法接单'
  const title = (order.skillSnapshot && order.skillSnapshot.title) || '校园技能服务'
  const r = await closeAndRefund(order, 'seller', 'closed', reason, `服务者拒绝接单：${reason}`, openid)

  await bestEffort('reject.notice', () => addNotice({
    openid: order.buyerId,
    type: 'order',
    title: '订单被拒绝',
    content: `「${title}」服务者未能接单：${reason}。${r.amount} 枚时间币已退回你的账户。`,
    orderId: order._id
  }))
  return { ok: true }
}

/* ==================================================================
 * action: cancel —— 买卖双方在 waiting / ongoing 取消（解冻退回）
 * ongoing 取消 = 已接单后取消 / 爽约，取消方扣 5 分信用分
 * ================================================================== */
async function actionCancel(event, openid) {
  await requireUser(openid)
  const order = await findOrder(event.orderId)
  assert(order, '订单不存在', 404)
  const isBuyer = order.buyerId === openid
  const isSeller = order.sellerId === openid
  if (!isBuyer && !isSeller) throw bizError(403, '无权操作该订单')
  assert(CANCELABLE_STATUS.indexOf(order.status) > -1, '当前状态不能取消', 409)

  const by = isBuyer ? 'buyer' : 'seller'
  const wasOngoing = order.status === 'ongoing'
  const reason = String(event.reason || '').trim() || '用户取消'
  const byText = by === 'buyer' ? '买家' : '服务者'
  const title = (order.skillSnapshot && order.skillSnapshot.title) || '校园技能服务'

  const r = await closeAndRefund(order, by, 'canceled', reason, `${byText}取消：${reason}`, openid)

  const otherId = isBuyer ? order.sellerId : order.buyerId
  await bestEffort('cancel.notice', () => addNotice({
    openid: otherId,
    type: 'order',
    title: '订单已取消',
    content: `「${title}」已被${byText}取消（${reason}）。${r.amount} 枚时间币已退回买家。`,
    orderId: order._id
  }))

  // 已接单后取消 = 爽约：取消方扣 5 分信用分，连续按时完成记录清零
  if (wasOngoing) {
    await bestEffort('cancel.credit', () => changeCredit(
      openid, -5, 'cancel_after_accept', '接单后取消 / 爽约', order._id
    ))
    await bestEffort('cancel.streak', () => resetStreak(openid))
  }
  return { ok: true }
}

/* ==================================================================
 * action: finish —— 卖家标记服务完成（ongoing → confirming）
 * ================================================================== */
async function actionFinish(event, openid) {
  const me = await requireUser(openid)
  const order = await findOrder(event.orderId)
  assert(order, '订单不存在', 404)
  if (order.sellerId !== openid && !isAdminUser(me)) throw bizError(403, '只有服务者可以标记完成')

  const config = await getConfig()
  const t = now()
  const res = await db.collection(C.ORDERS)
    .where({ _id: order._id, status: 'ongoing' })
    .update({
      data: {
        status: 'confirming',
        finishTime: t,
        timeline: _.push([{
          status: 'confirming',
          time: t,
          remark: '服务者标记服务完成，等待买家确认',
          operator: openid
        }])
      }
    })
  if (!res.stats || res.stats.updated !== 1) throw bizError(409, '当前状态不能标记完成')

  const title = (order.skillSnapshot && order.skillSnapshot.title) || '校园技能服务'
  const sellerName = (order.sellerInfo && order.sellerInfo.nickName) || '服务者'
  await bestEffort('finish.notice', () => addNotice({
    openid: order.buyerId,
    type: 'order',
    title: '服务已完成，请确认',
    content: `${sellerName} 已标记「${title}」服务完成，确认后时间币将结算给 TA。`,
    orderId: order._id
  }))
  await bestEffort('finish.subscribe', () => sendSubscribe({
    openid: order.buyerId,
    templateId: tplId(config, 'ORDER_FINISH'),
    page: `pages/order/detail/detail?orderId=${order._id}`,
    data: subPayload(order, '服务已完成，待你确认')
  }))
  return { ok: true }
}

/* ==================================================================
 * ★★ 结算核心：confirming → finished，冻结额真正扣除并打给服务方
 *    买家手动 confirm 与「超时自动确认」共用本函数（auto = true）
 * ================================================================== */
async function settleOrder(orderId, opt) {
  const o = opt || {}
  const auto = !!o.auto

  const order0 = await findOrder(orderId)
  assert(order0, '订单不存在', 404)
  assert(order0.status === 'confirming', '当前状态不能确认', 409)
  if (!auto) assert(order0.buyerId === o.operator, '只有买家可以确认完成', 403)

  const config = await getConfig()
  const buyerDoc = await getUser(order0.buyerId)
  const sellerDoc = await getUser(order0.sellerId)
  assert(buyerDoc && sellerDoc, '订单参与方不存在', 404)

  const t = now()
  const actor = auto ? 'system' : order0.buyerId

  const r = await db.runTransaction(async tx => {
    const oRes = await tx.collection(C.ORDERS).doc(order0._id).get()
    const txOrder = oRes.data
    assert(txOrder, '订单不存在', 404)
    assert(txOrder.status === 'confirming', '当前状态不能确认', 409)

    const bRes = await tx.collection(C.USERS).doc(buyerDoc._id).get()
    const sRes = await tx.collection(C.USERS).doc(sellerDoc._id).get()
    const b = bRes.data
    const s = sRes.data
    assert(b && s, '订单参与方不存在', 404)

    const amount = Math.round(Number(txOrder.amount) || 0)

    // 买家：冻结额释放并真正扣除（下单时已从 coins 扣走，此处只减冻结）
    const bFrozen = Math.max(0, (b.frozenCoins || 0) - amount)
    const bSpent = (b.totalSpent || 0) + amount
    const bStats = Object.assign({}, b.stats || {})
    bStats.buyCount = (bStats.buyCount || 0) + 1

    // 卖家：到账 + 完成单数 + 连续按时完成
    const sCoins = (s.coins || 0) + amount
    const sEarned = (s.totalEarned || 0) + amount
    const sStats = Object.assign({}, s.stats || {})
    sStats.serveCount = (sStats.serveCount || 0) + 1
    const broken = !!txOrder.cancelTime || !!txOrder.cancelBy   // 这单被取消过 → streak 归零
    sStats.ontimeStreak = broken ? 0 : (sStats.ontimeStreak || 0) + 1

    // ★ 全部写绝对值，不使用 _.inc()
    await tx.collection(C.USERS).doc(buyerDoc._id).update({
      data: { frozenCoins: bFrozen, totalSpent: bSpent, stats: bStats, updateTime: t }
    })
    await tx.collection(C.USERS).doc(sellerDoc._id).update({
      data: { coins: sCoins, totalEarned: sEarned, stats: sStats, updateTime: t }
    })
    await tx.collection(C.ORDERS).doc(txOrder._id).update({
      data: {
        status: 'finished',
        confirmTime: t,
        timeline: (txOrder.timeline || []).concat([{
          status: 'finished',
          time: t,
          remark: auto ? '买家超时未确认，系统自动结算给服务者' : '买家确认完成，时间币已结算',
          operator: actor
        }])
      }
    })

    return {
      order: txOrder,
      amount,
      buyerBalance: b.coins || 0,
      buyerFrozen: bFrozen,
      buyerCreditBefore: b.creditScore === undefined ? 100 : b.creditScore,
      sellerBalance: sCoins,
      sellerFrozen: Math.max(0, s.frozenCoins || 0),
      sellerCreditBefore: s.creditScore === undefined ? 100 : s.creditScore,
      sellerStats: sStats,
      buyerStats: bStats
    }
  })

  const title = (r.order.skillSnapshot && r.order.skillSnapshot.title) || '校园技能服务'

  // —— 事务外补写 ①：买卖双方各一条时间币流水 ——
  await bestEffort('settle.expenseLog', () => addWalletLog({
    openid: r.order.buyerId,
    type: 'expense',
    amount: -r.amount,
    balance: r.buyerBalance,
    frozen: r.buyerFrozen,
    orderId: r.order._id,
    orderNo: r.order.orderNo,
    remark: `完成结算：${title}`
  }))
  await bestEffort('settle.incomeLog', () => addWalletLog({
    openid: r.order.sellerId,
    type: 'income',
    amount: r.amount,
    balance: r.sellerBalance,
    frozen: r.sellerFrozen,
    orderId: r.order._id,
    orderNo: r.order.orderNo,
    remark: `服务收入：${title}`
  }))

  // —— 事务外补写 ②：双方 +2 信用分（订单顺利完成）——
  let buyerCredit = Math.min(150, r.buyerCreditBefore + 2)
  let sellerCredit = Math.min(150, r.sellerCreditBefore + 2)
  const bc = await bestEffort('settle.buyerCredit', () => changeCredit(
    r.order.buyerId, 2, 'order_finish', '订单顺利完成', r.order._id
  ))
  if (typeof bc === 'number') buyerCredit = bc
  const sc = await bestEffort('settle.sellerCredit', () => changeCredit(
    r.order.sellerId, 2, 'order_finish', '订单顺利完成', r.order._id
  ))
  if (typeof sc === 'number') sellerCredit = sc

  // —— 事务外补写 ③：连续 5 单按时完成奖励 ——
  const streak = (r.sellerStats && r.sellerStats.ontimeStreak) || 0
  if (streak > 0 && streak % 5 === 0) {
    await bestEffort('settle.streakBonus', () => changeCredit(
      r.order.sellerId, 3, 'ontime_streak', '连续 5 单按时完成', r.order._id
    ))
  }

  // —— 事务外补写 ④：徽章补发（去重写入卖家 badges 数组）——
  const sellerBadges = []
  const stats = r.sellerStats || {}
  if ((stats.serveCount || 0) + (stats.buyCount || 0) >= 1) sellerBadges.push('newbie')
  if ((stats.serveCount || 0) >= 10) sellerBadges.push('warm')
  if (streak >= 5) sellerBadges.push('ontime')
  if (sellerCredit >= 120) sellerBadges.push('trust')
  if ((stats.avgRating || 0) >= 4.5) {
    const cat = (r.order.skillSnapshot && r.order.skillSnapshot.categoryName) || ''
    if (cat) {
      const cnt = await bestEffort('settle.expertCount', () => db.collection(C.ORDERS)
        .where({ sellerId: r.order.sellerId, status: 'finished', 'skillSnapshot.categoryName': cat })
        .count())
      if (cnt && (cnt.total || 0) >= 5) sellerBadges.push('expert')
    }
  }
  await bestEffort('settle.badges', () => awardBadges(r.order.sellerId, sellerBadges))

  const buyerBadges = []
  if ((r.buyerStats.buyCount || 0) >= 1) buyerBadges.push('newbie')
  if (buyerCredit >= 120) buyerBadges.push('trust')
  await bestEffort('settle.buyerBadges', () => awardBadges(r.order.buyerId, buyerBadges))

  // —— 事务外补写 ⑤：通知 + 订阅消息 ——
  await bestEffort('settle.notice', () => addNotice({
    openid: r.order.sellerId,
    type: 'order',
    title: '时间币已到账',
    content: `「${title}」已完成，${r.amount} 枚时间币已到账。记得和对方互评哦～`,
    orderId: r.order._id
  }))
  await bestEffort('settle.subscribe', () => sendSubscribe({
    openid: r.order.sellerId,
    templateId: tplId(config, 'ORDER_CONFIRM'),
    page: `pages/order/detail/detail?orderId=${r.order._id}`,
    data: subPayload(r.order, '时间币已到账')
  }))

  return { ok: true }
}

/* ==================================================================
 * action: confirm —— ★ 买家确认完成（结算）
 * ================================================================== */
async function actionConfirm(event, openid) {
  await requireUser(openid)
  assert(event.orderId, '缺少订单参数 orderId')
  const order = await findOrder(event.orderId)
  assert(order, '订单不存在', 404)
  assert(order.buyerId === openid, '只有买家可以确认完成', 403)
  return settleOrder(order._id, { operator: openid })
}

/* ==================================================================
 * 超时兜底处理（两种触发方式共用本函数）
 *   ① waiting 且 expireTime < now        → 系统自动关闭并解冻退回买家
 *   ② confirming 且 finishTime + confirmExpireHours < now → 系统自动结算给服务者
 *
 * 【为什么是「定时触发器 + 惰性检查」双保险】
 * 云开发的定时触发器最小粒度是分钟级，且不保证精确准点（高峰期会有延迟、函数也可能因
 * 发布/冷启动错过一次触发）；如果只靠定时任务，用户完全可能在这段空窗里看到一条早已过期
 * 却还显示「待接单」的订单。反过来，如果只靠惰性检查（用户请求顺带处理），没人访问的订单
 * 就永远躺在那里，买家的时间币会被无限期冻结。两者互补：定时任务兜住「没人访问」的订单，
 * 惰性检查兜住「定时任务没跑/跑晚了」的窗口 —— 任一条路径都能让钱和状态最终一致。
 * 两条路径都调用同一组内部函数（closeAndRefund / settleOrder），且内部都有状态断言，
 * 因此重复执行是幂等的（第二次会因状态不符直接跳过），不会重复退款或重复结算。
 * ================================================================== */
async function handleTimeouts(opt) {
  const o = opt || {}
  const batch = Math.max(1, Number(o.batch) || 20)   // 单批上限，防止云函数超时
  const config = await getConfig()
  const expireHours = Number(config.orderExpireHours) || 24
  const confirmHours = Number(config.confirmExpireHours) || 72
  const t = now()
  let closed = 0
  let settled = 0

  // ① 待接单超时 → 系统自动关闭并解冻退回
  try {
    const res = await db.collection(C.ORDERS)
      .where({ status: 'waiting', expireTime: _.lt(t) })
      .limit(batch)
      .get()
    for (const od of (res.data || [])) {
      try {
        const title = (od.skillSnapshot && od.skillSnapshot.title) || '校园技能服务'
        const r = await closeAndRefund(
          od, 'system', 'closed', '超时未接单，系统自动取消',
          `超过 ${expireHours} 小时无人接单，系统自动关闭并退回时间币`, 'system'
        )
        closed += 1
        await bestEffort('timeout.notice', () => addNotice({
          openid: od.buyerId,
          type: 'order',
          title: '订单超时已关闭',
          content: `「${title}」超过 ${expireHours} 小时无人接单，已自动关闭，${r.amount} 枚时间币已退回。`,
          orderId: od._id
        }))
      } catch (e) {
        console.error('[order] 自动关闭订单失败：', od._id, (e && e.message) || e)
      }
    }
  } catch (e) {
    console.error('[order] 扫描超时待接单失败：', (e && e.message) || e)
  }

  // ② 待确认超时 → 系统自动结算给服务者
  try {
    const threshold = new Date(Date.now() - confirmHours * 3600000)
    const res = await db.collection(C.ORDERS)
      .where({ status: 'confirming', finishTime: _.lt(threshold) })
      .limit(batch)
      .get()
    for (const od of (res.data || [])) {
      try {
        await settleOrder(od._id, { auto: true, operator: 'system' })
        settled += 1
      } catch (e) {
        console.error('[order] 自动确认订单失败：', od._id, (e && e.message) || e)
      }
    }
  } catch (e) {
    console.error('[order] 扫描超时待确认失败：', (e && e.message) || e)
  }

  return { closed, settled }
}

/* ==================================================================
 * action: autoTask —— 定时触发器兜底（无登录态）
 * 由 config.json 的 orderAutoTask（每 10 分钟）触发，
 * 定时触发时 event 形如 { Type: 'Timer', TriggerName: 'orderAutoTask' }，没有 OPENID，
 * 因此本分支**不调用 requireUser()**，只做全库的超时订单处理。
 * ================================================================== */
async function actionAutoTask() {
  const r = await handleTimeouts({ batch: 50 })
  console.log(`[order] autoTask 完成：关闭 ${r.closed} 单，自动结算 ${r.settled} 单`)
  return { closed: r.closed, settled: r.settled }
}

/* ==================================================================
 * action: list —— 我的订单（买到的 / 我接的）
 * ================================================================== */
async function actionList(event, openid) {
  await requireUser(openid)
  const role = event.role === 'seller' ? 'seller' : 'buyer'
  const { page, size } = parsePage(event)

  const where = role === 'buyer' ? { buyerId: openid } : { sellerId: openid }
  const status = event.status
  if (status && status !== 'all') {
    where.status = status === 'canceled' ? _.in(['canceled', 'closed']) : status
  }

  const res = await paginateQuery(db.collection(C.ORDERS).where(where), {
    page,
    size,
    orderBy: [['createTime', 'desc']]
  })
  res.list = (res.list || []).map(o => withRole(o, openid))
  return res
}

/* ==================================================================
 * action: detail —— 仅参与方或管理员可看
 * ================================================================== */
async function actionDetail(event, openid) {
  const me = await requireUser(openid)
  const order = await findOrder(event.orderId)
  assert(order, '订单不存在', 404)
  const isParty = order.buyerId === openid || order.sellerId === openid
  if (!isParty && !isAdminUser(me)) throw bizError(403, '无权查看该订单')
  const view = withRole(order, openid)
  return { order: view, role: view.role }
}

/* ==================================================================
 * action: counts —— 买卖双方合并的各状态数量（closed 计入 canceled）
 * ================================================================== */
async function actionCounts(event, openid) {
  await requireUser(openid)
  // 惰性超时处理（双保险的另一半）：用户来看数量时顺手清一遍自己/全库的超时单，
  // 保证列表和角标立刻是最新的；真正的兜底交给 autoTask 定时触发器。
  await handleTimeouts({ batch: 20 })

  const mine = extra => _.or([
    Object.assign({ buyerId: openid }, extra),
    Object.assign({ sellerId: openid }, extra)
  ])
  const countOf = extra => db.collection(C.ORDERS).where(mine(extra)).count()

  const [waiting, ongoing, confirming, finished, canceled] = await Promise.all([
    countOf({ status: 'waiting' }),
    countOf({ status: 'ongoing' }),
    countOf({ status: 'confirming' }),
    countOf({ status: 'finished' }),
    countOf({ status: _.in(['canceled', 'closed']) })
  ])

  return {
    waiting: waiting.total || 0,
    ongoing: ongoing.total || 0,
    confirming: confirming.total || 0,
    finished: finished.total || 0,
    canceled: canceled.total || 0
  }
}

/* ============================ 入口 ============================ */
exports.main = wrap(async (event, context) => {
  // 定时触发器（无登录态）：event 带 Type='Timer' 或显式调用 autoTask 时走兜底分支
  if (event.action === 'autoTask' || event.Type === 'Timer') {
    return actionAutoTask()
  }
  const openid = getOpenId()
  switch (event.action) {
    case 'create': return actionCreate(event, openid)
    case 'accept': return actionAccept(event, openid)
    case 'reject': return actionReject(event, openid)
    case 'cancel': return actionCancel(event, openid)
    case 'finish': return actionFinish(event, openid)
    case 'confirm': return actionConfirm(event, openid)
    case 'list': return actionList(event, openid)
    case 'detail': return actionDetail(event, openid)
    case 'counts': return actionCounts(event, openid)
    default: throw bizError(400, `未知 action: ${event.action}`)
  }
})
