/**
 * 案例组 14-20：user 云函数（7 个 action）
 * 契约见 docs/ARCHITECTURE.md §4.5；数据结构 §3.1 users / §3.5 reviews / §3.7 credit_logs
 *
 * 本文件重点覆盖三块真实风险：
 *   ① user.badges 的安全边界：只有查自己（openid 为空或等于调用者）才把判定结果
 *      **写回** users.badges；查他人必须只读不落库（否则任何登录用户都能触发对他人文档的写）。
 *   ② user.badges 的 7 条判定规则，其中 expert（同分类 ≥5 单）与 popular（浏览合计 ≥500）
 *      走聚合管道，必须真造数据验，不能只看空集合。
 *   ③ user.reviewCreate：状态机（finished 且未评过）、星级 → 信用分映射
 *      （5→+1 / 4→0 / 3→-1 / 2→-2 / 1→-3，delta=0 不写流水）、avgRating 保留 1 位小数、
 *      订单 isRated 标记与通知。
 */
module.exports = async function (t) {
  /* ==================================================================
   * 本文件内部工具
   * ================================================================== */

  /**
   * 以「非本人」身份查徽章：走 computeBadges 只读分支，返回徽章 id 数组。
   * 调用者是 o_weak，目标是别人（本文件里都是 o_sel）—— 这样不会触发生成写回。
   */
  async function badgesOf (targetOpenid) {
    const r = await t.call('user', 'o_weak', 'badges', { openid: targetOpenid })
    return r.code === 0 ? r.data.owned.map(b => b.id) : ['<code:' + r.code + '>']
  }

  const has = (ids, id) => ids.indexOf(id) > -1

  /** 重建库，并把 o_sel 造成指定的徽章画像（stats / creditScore / badges / orders / skills） */
  function badgeCase (stats, opt) {
    const o = opt || {}
    t.seed()
    const u = t.user('o_sel')
    Object.assign(u.stats, stats || {})
    if (o.creditScore != null) u.creditScore = o.creditScore
    if (o.badges) u.badges = o.badges.slice()
    if (o.orders) t.store().orders = o.orders
    if (o.skills) t.store().skills = o.skills
    return u
  }

  /** 造 n 张 o_sel 作为卖家的订单（默认同一分类、已完成） */
  function sellerOrders (n, categoryName, status) {
    const out = []
    for (let i = 0; i < n; i++) {
      out.push({
        _id: 'eo' + i, _openid: 'o_buy', orderNo: 'TB_EO' + i, skillId: 'sk1',
        skillSnapshot: { title: '手工单', categoryName: categoryName || '技能教学' },
        buyerId: 'o_buy', sellerId: 'o_sel', amount: 2,
        status: status || 'finished',
        isRatedBuyer: false, isRatedSeller: false,
        createTime: t.D(i + 1)
      })
    }
    return out
  }

  /** 重建库 + 造一张可评价订单，返回订单 */
  function reviewCase (opt) {
    const o = opt || {}
    t.seed()
    if (o.sellerStats) Object.assign(t.user('o_sel').stats, o.sellerStats)
    if (o.buyerStats) Object.assign(t.user('o_buy').stats, o.buyerStats)
    if (o.seller) Object.assign(t.user('o_sel'), o.seller)
    if (o.buyer) Object.assign(t.user('o_buy'), o.buyer)
    t.store().reviews = []          // seed() 不建 reviews 集合，断言前先确保存在
    return t.putOrder(Object.assign(
      { _id: 'orv', orderNo: 'TB_RV1', status: 'finished' },
      o.order || {}
    ))
  }

  /* ==================================================================
   * 组 14：mine
   * ================================================================== */
  t.group('组 14 · user.mine：个人中心聚合（并行 count）+ 徽章写回自己')

  t.seed()
  const s14 = t.store()
  s14.skills.push({ _id: 'sk2', _openid: 'o_buy', authorId: 'o_buy', title: '我的技能', status: 1, createTime: t.D(1) })
  s14.skills.push({ _id: 'sk3', _openid: 'o_buy', authorId: 'o_buy', title: '已下架', status: 0, createTime: t.D(2) })
  s14.notices = [
    { _id: 'n1', _openid: 'o_buy', type: 'order', title: 'a', content: '', orderId: '', read: false, createTime: t.D(1) },
    { _id: 'n2', _openid: 'o_buy', type: 'credit', title: 'b', content: '', orderId: '', read: false, createTime: t.D(2) },
    { _id: 'n3', _openid: 'o_buy', type: 'system', title: 'c', content: '', orderId: '', read: true, createTime: t.D(3) },
    { _id: 'n4', _openid: 'o_sel', type: 'order', title: 'd', content: '', orderId: '', read: false, createTime: t.D(1) }
  ]
  t.putOrder({ _id: 'm1', status: 'waiting' })                                    // 买家侧待处理
  t.putOrder({ _id: 'm2', status: 'confirming' })                                 // 买家侧待确认
  t.putOrder({ _id: 'm3', status: 'waiting', buyerId: 'o_other', _openid: 'o_other' }) // 卖家侧待处理
  t.putOrder({ _id: 'm4', status: 'finished' })                                   // 已完成，不计
  t.putOrder({ _id: 'm5', status: 'ongoing', buyerId: 'o_other', _openid: 'o_other' }) // 进行中，不计
  t.putOrder({ _id: 'm6', status: 'closed' })                                     // 已关闭，不计
  Object.assign(t.user('o_buy').stats, { serveCount: 3, buyCount: 2, reviewCount: 4, ratingSum: 18, avgRating: 4.5, ontimeStreak: 0 })

  let r = await t.call('user', 'o_buy', 'mine', {})
  t.eq(r.code, 0, 'mine 调用成功')
  t.eq(Object.keys(r.data).sort().join(','), 'badges,counts,user', 'mine 只返回 user / counts / badges 三个字段')
  t.eq(Object.keys(r.data.counts).sort().join(','), 'buy,collected,publish,review,serve,unreadNotice,waitingOrder', 'counts 的 7 个字段与 §4.5 一致（collected 为收藏数）')
  t.eq(r.data.counts.publish, 2, 'publish 走 count 查询：2 条技能（含 status=0 的，与 mock.js 口径一致）')
  t.eq(r.data.counts.serve, 3, 'serve 直接取 stats.serveCount')
  t.eq(r.data.counts.buy, 2, 'buy 直接取 stats.buyCount')
  t.eq(r.data.counts.review, 4, 'review 直接取 stats.reviewCount')
  t.eq(r.data.counts.unreadNotice, 2, 'unreadNotice 只数自己的未读（o_sel 那条不计入）')
  t.eq(r.data.counts.waitingOrder, 2, '★ waitingOrder = 买家自己 waiting + confirming 共 2 单（卖家侧那张买方不是本人）')
  t.eq(r.data.user._openid, 'o_buy', 'user 是当前登录者本人')
  t.eq(r.data.badges.map(b => b.id).join(','), 'newbie', '刚完成首单 → 返回 newbie 徽章对象')
  t.eq(t.user('o_buy').badges.join(','), 'newbie', '★ mine 顺带把徽章写回 users.badges')
  t.eq(r.data.user.badges.length, 0, '★ 已知不一致：响应里的 user 是补发徽章前的快照，user.badges 仍为空（前端应读 data.badges）')
  t.eq(r.data.badges[0].icon, '🌱', '徽章对象带 icon/name 等展示字段')

  r = await t.call('user', 'o_sel', 'mine', {})
  t.eq(r.data.counts.publish, 1, '他人视角：o_sel 只有 sk1')
  t.eq(r.data.counts.waitingOrder, 3, 'o_sel 的待处理单：m1/m2 作为卖家 + m3 作为卖家')
  t.eq(r.data.counts.unreadNotice, 1, 'o_sel 自己那条未读通知')

  t.eq((await t.call('user', 'o_ghost', 'mine', {})).code, 401, '未注册用户 → 401')
  t.user('o_weak').status = 0
  t.eq((await t.call('user', 'o_weak', 'mine', {})).code, 403, '被封禁用户（status=0）→ 403')

  /* ==================================================================
   * 组 15：home
   * ================================================================== */
  t.group('组 15 · user.home：公开资料脱敏 + 上架技能前 6 + 收到评价前 3')

  t.seed()
  const s15 = t.store()
  Object.assign(t.user('o_sel'), {
    phone: '13800000000', studentNo: '2021001', realName: '张思远',
    authImages: ['cloud://student-card.jpg'], authRemark: '照片模糊'
  })
  s15.skills = []
  for (let i = 0; i < 8; i++) {
    s15.skills.push({
      _id: 'h' + i, _openid: 'o_sel', authorId: 'o_sel', type: 'offer',
      title: '技能' + i, categoryName: '技能教学', price: 2, status: i === 7 ? 0 : 1,
      createTime: t.D(i + 1)
    })
  }
  s15.reviews = [
    { _id: 'hr1', toId: 'o_sel', fromId: 'o_weak', score: 5, content: 'a', createTime: t.D(1) },
    { _id: 'hr2', toId: 'o_sel', fromId: 'o_weak', score: 4, content: 'b', createTime: t.D(2) },
    { _id: 'hr3', toId: 'o_sel', fromId: 'o_weak', score: 3, content: 'c', createTime: t.D(3) },
    { _id: 'hr4', toId: 'o_sel', fromId: 'o_weak', score: 2, content: 'd', createTime: t.D(4) },
    { _id: 'hr5', toId: 'o_buy', fromId: 'o_weak', score: 1, content: 'e', createTime: t.D(1) }
  ]

  r = await t.call('user', 'o_buy', 'home', { openid: 'o_sel' })
  t.eq(r.code, 0, 'home 调用成功')
  t.eq(Object.keys(r.data).sort().join(','), 'reviews,skills,stats,user', 'home 返回 user / skills / reviews / stats')
  t.eq(r.data.user.nickName, '卖家思远', '保留公开昵称')
  t.eq(r.data.user.phone, undefined, '★ 脱敏：phone 不对外')
  t.eq(r.data.user.studentNo, undefined, '★ 脱敏：studentNo 不对外')
  t.eq(r.data.user.realName, undefined, '★ 脱敏：realName（认证真名）不对外')
  t.eq(r.data.user.authImages, undefined, '★ 脱敏：authImages 不对外')
  t.eq(r.data.user.authRemark, undefined, '★ 脱敏：authRemark（驳回原因）不对外')
  t.eq(r.data.skills.length, 6, '★ 上架技能最多 6 条（第 7 条 h6 被 limit(6) 截断）')
  t.eq(r.data.skills[0]._id, 'h0', '技能按 createTime 倒序，最新在前')
  t.eq(r.data.skills.filter(x => x.status !== 1).length, 0, '下架技能（h7/status=0）不出现')
  t.eq(r.data.reviews.length, 3, '★ 收到的评价最多 3 条')
  t.eq(r.data.reviews[0]._id, 'hr1', '评价按 createTime 倒序')
  t.eq(r.data.reviews.filter(x => x.toId !== 'o_sel').length, 0, '别人的评价不会混入')
  t.eq(Object.keys(r.data.stats).sort().join(','), 'avgRating,buyCount,ontimeStreak,publishCount,ratingSum,reviewCount,serveCount', 'stats 经 normalizeStats 归一化')

  t.eq((await t.call('user', 'o_buy', 'home', {})).code, 400, '缺 openid → 400')
  t.eq((await t.call('user', 'o_buy', 'home', { openid: 'o_ghost' })).code, 404, '用户不存在 → 404')

  /* ==================================================================
   * 组 16：creditLogs
   * ================================================================== */
  t.group('组 16 · user.creditLogs：本人流水、倒序分页')

  t.seed()
  const s16 = t.store()
  s16.credit_logs = []
  for (let i = 1; i <= 5; i++) {
    s16.credit_logs.push({
      _id: 'cl' + i, _openid: 'o_buy', change: i, score: 100 + i,
      reason: 'r' + i, reasonText: '说明' + i, orderId: i === 5 ? 'oX' : '',
      createTime: new Date(Date.now() - (6 - i) * 60000)
    })
  }
  s16.credit_logs.push({ _id: 'cl9', _openid: 'o_sel', change: 1, score: 111, reason: 'x', reasonText: '', orderId: '', createTime: new Date() })

  let cl = await t.call('user', 'o_buy', 'creditLogs', { page: 1, size: 2 })
  t.eq(cl.code, 0, 'creditLogs 调用成功')
  t.eq(cl.data.total, 5, '只统计本人信用流水')
  t.eq(cl.data.list.length, 2, 'size=2 生效')
  t.eq(cl.data.hasMore, true, 'hasMore=true')
  t.eq(cl.data.list[0]._id, 'cl5', '★ 按 createTime 倒序，最新在前')
  t.eq(cl.data.list[0].score, 105, '返回变动后分数')
  t.eq(Object.keys(cl.data.list[0]).sort().join(','), '_id,_openid,change,createTime,orderId,reason,reasonText,score', '流水字段按 §3.7')
  cl = await t.call('user', 'o_buy', 'creditLogs', { page: 3, size: 2 })
  t.eq(cl.data.list.length, 1, '第三页 1 条')
  t.eq(cl.data.list[0]._id, 'cl1', '第三页是最早那条')
  t.eq(cl.data.hasMore, false, '最后一页 hasMore=false')
  t.eq((await t.call('user', 'o_sel', 'creditLogs', {})).data.total, 1, '他人只看到自己的 1 条')
  t.eq((await t.call('user', 'o_ghost', 'creditLogs', {})).code, 401, '未注册 → 401')

  /* ==================================================================
   * 组 17：badges —— ★ 安全边界（本文件最重要的一组）
   * ================================================================== */
  t.group('组 17 · ★ user.badges 安全边界：查他人只读不落库，查自己才写回')

  t.seed()
  const sel17 = t.user('o_sel')
  sel17.stats.serveCount = 10
  sel17.creditScore = 130
  sel17.badges = ['newbie']
  sel17.updateTime = new Date('2020-01-01T00:00:00Z')
  const beforeBadges = sel17.badges.slice()
  const beforeUpdate = sel17.updateTime.getTime()

  r = await t.call('user', 'o_buy', 'badges', { openid: 'o_sel' })
  t.eq(r.code, 0, '查他人徽章成功')
  t.eq(Object.keys(r.data).sort().join(','), 'all,owned', '返回 owned / all 两个字段')
  t.eq(r.data.all.length, 7, 'all 是全部 7 个徽章定义')
  t.ok(has(r.data.owned.map(b => b.id), 'warm'), '★ 查他人也照常返回完整判定结果（warm：serveCount 10）', JSON.stringify(r.data.owned.map(b => b.id)))
  t.ok(has(r.data.owned.map(b => b.id), 'trust'), '查他人时 trust（信用分 130）也判出来了')
  t.eq(r.data.all.filter(b => b.owned).map(b => b.id).join(','), r.data.owned.map(b => b.id).join(','), 'all[].owned 标记与 owned 列表一致')
  t.ok(r.data.all.every(b => typeof b.owned === 'boolean' && b.id && b.name && b.icon && b.color && b.desc), '每个徽章对象字段完整')
  t.eq(t.user('o_sel').badges.join(','), beforeBadges.join(','), '★★ 查他人后对方 users.badges 未被修改（只读计算，绝不写他人文档）')
  t.eq(t.user('o_sel').updateTime.getTime(), beforeUpdate, '★★ 查他人后 updateTime 未被触碰（连时间戳都没写）')

  r = await t.call('user', 'o_sel', 'badges', {})
  t.eq(r.code, 0, '查自己徽章成功')
  t.eq(t.user('o_sel').badges.join(','), 'newbie,warm,trust', '★ 查自己才把增量判定结果写回 users.badges')
  t.eq(r.data.owned.map(b => b.id).join(','), 'newbie,warm,trust', '返回的 owned 与落库结果一致')

  const lenAfter = t.user('o_sel').badges.length
  await t.call('user', 'o_sel', 'badges', {})
  await t.call('user', 'o_sel', 'badges', {})
  t.eq(t.user('o_sel').badges.length, lenAfter, '★ 重复查自己不会重复追加（去重）')

  r = await t.call('user', 'o_sel', 'badges', { openid: 'o_sel' })
  t.eq(r.code, 0, 'openid 显式等于调用者本人时按「自己」处理')
  t.eq(t.user('o_sel').badges.length, lenAfter, '显式传自己 openid 同样走写回且去重')

  t.eq((await t.call('user', 'o_buy', 'badges', { openid: 'o_ghost' })).code, 404, '目标用户不存在 → 404')
  t.eq((await t.call('user', 'o_ghost', 'badges', {})).code, 401, '未注册调用者 → 401')

  /* ==================================================================
   * 组 18：badges 七条判定规则（含两条聚合）
   * ================================================================== */
  t.group('组 18 · user.badges 判定规则：newbie / ontime / warm / expert / trust / popular / social')

  badgeCase({})
  let ids = await badgesOf('o_sel')
  t.eq(ids.length, 0, '★ 空白用户（无单、无评价、信用 110、技能 0 浏览）→ 一个徽章都没有')

  badgeCase({ serveCount: 1 })
  t.ok(has(await badgesOf('o_sel'), 'newbie'), 'newbie：提供 1 单即得')
  badgeCase({ buyCount: 1 })
  t.ok(has(await badgesOf('o_sel'), 'newbie'), 'newbie：买入 1 单也算完成首单')
  badgeCase({ serveCount: 1, buyCount: 0 })
  t.ok(!has(await badgesOf('o_sel'), 'ontime'), 'serveCount=1 时不给 ontime')

  badgeCase({ ontimeStreak: 4 })
  t.ok(!has(await badgesOf('o_sel'), 'ontime'), 'ontime 边界：streak=4 → 不发')
  badgeCase({ ontimeStreak: 5 })
  t.ok(has(await badgesOf('o_sel'), 'ontime'), '★ ontime 边界：streak=5 → 发')

  badgeCase({ serveCount: 9 })
  t.ok(!has(await badgesOf('o_sel'), 'warm'), 'warm 边界：serveCount=9 → 不发')
  badgeCase({ serveCount: 10 })
  t.ok(has(await badgesOf('o_sel'), 'warm'), '★ warm 边界：serveCount=10 → 发')

  badgeCase({}, { creditScore: 119 })
  t.ok(!has(await badgesOf('o_sel'), 'trust'), 'trust 边界：119 分 → 不发')
  badgeCase({}, { creditScore: 120 })
  t.ok(has(await badgesOf('o_sel'), 'trust'), '★ trust 边界：120 分 → 发')

  badgeCase({ reviewCount: 19 })
  t.ok(!has(await badgesOf('o_sel'), 'social'), 'social 边界：19 条评价 → 不发')
  badgeCase({ reviewCount: 20 })
  t.ok(has(await badgesOf('o_sel'), 'social'), '★ social 边界：20 条评价 → 发')

  badgeCase({}, { skills: [{ _id: 'pv1', _openid: 'o_sel', authorId: 'o_sel', viewCount: 499, status: 1 }] })
  t.ok(!has(await badgesOf('o_sel'), 'popular'), 'popular 聚合边界：技能浏览合计 499 → 不发')
  badgeCase({}, { skills: [
    { _id: 'pv1', _openid: 'o_sel', authorId: 'o_sel', viewCount: 300, status: 1 },
    { _id: 'pv2', _openid: 'o_sel', authorId: 'o_sel', viewCount: 200, status: 1 }
  ] })
  t.ok(has(await badgesOf('o_sel'), 'popular'), '★ popular 聚合：多个技能浏览数求和 300+200=500 → 发')
  badgeCase({}, { skills: [
    { _id: 'pv1', _openid: 'o_sel', authorId: 'o_sel', viewCount: 400, status: 1 },
    { _id: 'pv2', _openid: 'o_other', authorId: 'o_other', viewCount: 999, status: 1 }
  ] })
  t.ok(!has(await badgesOf('o_sel'), 'popular'), 'popular 聚合只算自己的技能（他人的 999 不计）')

  badgeCase({ avgRating: 5 }, { orders: sellerOrders(5, '技能教学') })
  t.ok(has(await badgesOf('o_sel'), 'expert'), '★ expert：同分类已完成 5 单 + avgRating 5 → 发')
  badgeCase({ avgRating: 4.4 }, { orders: sellerOrders(5, '技能教学') })
  t.ok(!has(await badgesOf('o_sel'), 'expert'), 'expert 边界：评分 4.4 < 4.5 → 不发（即使有 5 单同分类）')
  badgeCase({ avgRating: 5 }, { orders: sellerOrders(4, '技能教学') })
  t.ok(!has(await badgesOf('o_sel'), 'expert'), 'expert 边界：同分类只有 4 单 → 不发')
  badgeCase({ avgRating: 5 }, { orders: sellerOrders(5, '技能教学', 'ongoing') })
  t.ok(!has(await badgesOf('o_sel'), 'expert'), '★ expert 聚合只数 status=finished（5 张 ongoing 不算）')
  badgeCase({ avgRating: 5 }, { orders: sellerOrders(3, '技能教学').concat(sellerOrders(5, '学业辅导').map((o, i) => Object.assign(o, { _id: 'eb' + i }))) })
  t.ok(has(await badgesOf('o_sel'), 'expert'), 'expert 取单分类最多的一档（学业辅导 5 单）')
  badgeCase({ avgRating: 5 }, { orders: sellerOrders(5, '技能教学').map((o, i) => Object.assign(o, { _id: 'eo_other' + i, sellerId: 'o_other', _openid: 'o_other' })) })
  t.ok(!has(await badgesOf('o_sel'), 'expert'), 'expert 聚合只数自己作为卖家的订单（他人作为卖家的 5 单不计）')

  /* ==================================================================
   * 组 18b：reviews
   * ================================================================== */
  t.group('组 18b · user.reviews：received / sent、分页、可查他人')

  t.seed()
  const s18 = t.store()
  s18.reviews = [
    { _id: 'rv1', toId: 'o_sel', fromId: 'o_buy', score: 5, content: 'a', createTime: t.D(1) },
    { _id: 'rv2', toId: 'o_sel', fromId: 'o_weak', score: 4, content: 'b', createTime: t.D(2) },
    { _id: 'rv3', toId: 'o_sel', fromId: 'o_buy', score: 3, content: 'c', createTime: t.D(3) },
    { _id: 'rv4', fromId: 'o_sel', toId: 'o_buy', score: 5, content: 'd', createTime: t.D(1) },
    { _id: 'rv5', fromId: 'o_sel', toId: 'o_weak', score: 2, content: 'e', createTime: t.D(4) }
  ]

  let rv = await t.call('user', 'o_sel', 'reviews', {})
  t.eq(rv.code, 0, 'reviews 调用成功')
  t.eq(rv.data.total, 3, "默认 role='received'：按 toId 统计")
  t.eq(rv.data.list[0]._id, 'rv1', '按 createTime 倒序')
  rv = await t.call('user', 'o_sel', 'reviews', { role: 'sent' })
  t.eq(rv.data.total, 2, "role='sent'：按 fromId 统计")
  t.eq(rv.data.list[0]._id, 'rv4', '发出的评价同样倒序')
  rv = await t.call('user', 'o_buy', 'reviews', { openid: 'o_sel' })
  t.eq(rv.data.total, 3, '可以按 openid 查他人的「收到」评价')
  rv = await t.call('user', 'o_sel', 'reviews', { role: 'garbage' })
  t.eq(rv.data.total, 3, "非法 role 回退为 received（不报错）")
  rv = await t.call('user', 'o_sel', 'reviews', { page: 1, size: 2 })
  t.eq(rv.data.list.length, 2, 'size=2 生效')
  t.eq(rv.data.hasMore, true, 'page1 hasMore=true')
  rv = await t.call('user', 'o_sel', 'reviews', { page: 2, size: 2 })
  t.eq(rv.data.list.length, 1, 'page2 剩 1 条')
  t.eq(rv.data.hasMore, false, 'page2 hasMore=false')
  t.eq((await t.call('user', 'o_ghost', 'reviews', {})).code, 401, '未注册 → 401')

  /* ==================================================================
   * 组 19：reviewCreate —— 主流程与副作用
   * ================================================================== */
  t.group('组 19 · user.reviewCreate：买家评卖家（写评价 / 标记订单 / 统计 / 信用分 / 通知）')

  reviewCase({ sellerStats: { reviewCount: 2, ratingSum: 9, avgRating: 4.5 } })
  r = await t.call('user', 'o_buy', 'reviewCreate', { orderId: 'orv', score: 5, content: '  很棒  ', tags: ['准时', '耐心'] })
  t.eq(r.code, 0, '买家评价成功')
  const s19 = t.store()
  t.eq(s19.reviews.length, 1, '写入 1 条评价')
  const rv19 = s19.reviews[0]
  t.eq(Object.keys(rv19).sort().join(','), '_id,anonymous,content,createTime,fromId,fromInfo,orderId,reply,role,score,skillId,tags,toId,toInfo', '★ 评价字段严格按 §3.5（13 字段 + _id）')
  t.eq(rv19.orderId, 'orv', 'orderId 落库')
  t.eq(rv19.skillId, 'sk1', 'skillId 取订单快照里的技能')
  t.eq(rv19.fromId, 'o_buy', 'fromId = 评价人')
  t.eq(rv19.toId, 'o_sel', 'toId = 被评价人（买家评卖家）')
  t.eq(rv19.role, 'buyer', "role='buyer'")
  t.eq(rv19.score, 5, 'score 落库')
  t.eq(rv19.content, '很棒', '★ content 已 trim')
  t.eq(rv19.tags.join(','), '准时,耐心', 'tags 落库')
  t.eq(rv19.anonymous, false, 'anonymous 默认 false')
  t.eq(rv19.reply, null, 'reply 初始 null')
  t.eq(rv19.fromInfo.nickName, '买家小明', 'fromInfo 快照')
  t.eq(rv19.toInfo.nickName, '卖家思远', 'toInfo 快照')
  t.eq(rv19.createTime instanceof Date, true, 'createTime 是 Date')

  t.eq(t.order('orv').isRatedBuyer, true, '★ 订单标记 isRatedBuyer=true')
  t.eq(t.order('orv').buyerScore, 5, '★ 写入 buyerScore')
  t.eq(t.order('orv').isRatedSeller, false, '卖家一侧仍未评')

  const sel19 = t.user('o_sel')
  t.eq(sel19.stats.reviewCount, 3, '被评价人 reviewCount 2 → 3')
  t.eq(sel19.stats.ratingSum, 14, 'ratingSum 9 + 5 = 14')
  t.eq(sel19.stats.avgRating, 4.7, '★ avgRating = 14/3 = 4.666… → 4.7（保留 1 位小数）')
  t.eq(sel19.creditScore, 111, '★ 5 星 → 被评价人 +1 信用分')
  const cl19 = t.credits('o_sel')
  t.eq(cl19.length, 1, '写 1 条信用分流水')
  t.eq(cl19[0].change, 1, '流水 change=+1')
  t.eq(cl19[0].reason, 'review_5', "流水 reason='review_5'")
  t.eq(cl19[0].score, 111, '流水 score=变动后分数')
  t.eq(cl19[0].orderId, 'orv', '流水关联订单')
  const nt19 = t.notices('o_sel')
  t.eq(nt19.length, 1, '通知被评价人 1 条')
  t.eq(nt19[0]._openid, 'o_sel', '通知发给被评价人')
  t.eq(nt19[0].type, 'order', "通知 type='order'")
  t.eq(nt19[0].title, '收到 5 星评价', '通知标题')
  t.ok(nt19[0].content.indexOf('很棒') > -1, '通知正文带上评价内容')

  t.eq((await t.call('user', 'o_buy', 'reviewCreate', { orderId: 'orv', score: 5 })).code, 409, '★ 同一方重复评价 → 409')
  t.eq(t.store().reviews.length, 1, '重复提交没有多写评价')
  t.eq(t.order('orv').isRatedBuyer, true, '标记未被回滚')

  r = await t.call('user', 'o_sel', 'reviewCreate', { orderId: 'orv', score: 4, content: '不错的买家' })
  t.eq(r.code, 0, '卖家也可以评价买家')
  t.eq(t.store().reviews.length, 2, '第二条评价落库')
  t.eq(t.store().reviews[1].role, 'seller', "第二条 role='seller'")
  t.eq(t.store().reviews[1].toId, 'o_buy', '卖家评买家，toId=买家')
  t.eq(t.order('orv').isRatedSeller, true, '订单标记 isRatedSeller=true')
  t.eq(t.order('orv').sellerScore, 4, '写入 sellerScore')
  t.eq(t.user('o_buy').stats.reviewCount, 1, '买家统计 reviewCount 0 → 1')
  t.eq(t.user('o_buy').stats.avgRating, 4, '买家 avgRating = 4/1 = 4')
  t.eq(t.user('o_buy').creditScore, 100, '★ 4 星 delta=0：买家信用分不变')
  t.eq(t.credits('o_buy').length, 0, '★ 4 星不写信用分流水（delta=0 必须跳过 changeCredit）')
  t.eq((await t.call('user', 'o_sel', 'reviewCreate', { orderId: 'orv', score: 4 })).code, 409, '双方都评过后任一方再评 → 409')

  t.group('组 19b · ★ 星级 → 信用分映射（5→+1 / 4→0 / 3→-1 / 2→-2 / 1→-3）')

  for (const [score, delta] of [[5, 1], [4, 0], [3, -1], [2, -2], [1, -3]]) {
    reviewCase({})
    const rr = await t.call('user', 'o_buy', 'reviewCreate', { orderId: 'orv', score })
    t.eq(rr.code, 0, `${score} 星评价成功`)
    t.eq(t.user('o_sel').creditScore, 110 + delta, `${score} 星 → 被评价人信用分 = 110 ${delta >= 0 ? '+' : ''}${delta}`)
    t.eq(t.credits('o_sel').length, delta === 0 ? 0 : 1, delta === 0 ? `${score} 星 delta=0 → 不写流水` : `${score} 星写 1 条流水`)
    if (delta !== 0) t.eq(t.credits('o_sel')[0].change, delta, `${score} 星流水 change=${delta}`)
  }
  reviewCase({})
  r = await t.call('user', 'o_buy', 'reviewCreate', { orderId: 'orv', score: 1 })
  t.eq(t.credits('o_sel')[0].reason, 'review_1', '1 星流水 reason=review_1')
  t.eq(t.credits('o_sel')[0].reasonText, '收到 1 星评价', '1 星流水中文说明')
  t.eq(t.credits('o_sel')[0].score, 107, '1 星后分数 110-3=107')

  /* ==================================================================
   * 组 20：reviewCreate 校验 / 权限 / 状态机
   * ================================================================== */
  t.group('组 20 · user.reviewCreate 校验：入参 400 / 状态 409 / 越权 403 / 404')

  reviewCase({})
  t.eq((await t.call('user', 'o_buy', 'reviewCreate', { score: 5 })).code, 400, '缺 orderId → 400')
  t.eq((await t.call('user', 'o_buy', 'reviewCreate', { orderId: 'orv', score: 0 })).code, 400, '0 星 → 400')
  t.eq((await t.call('user', 'o_buy', 'reviewCreate', { orderId: 'orv', score: 6 })).code, 400, '6 星 → 400')
  t.eq((await t.call('user', 'o_buy', 'reviewCreate', { orderId: 'orv', score: 'abc' })).code, 400, '非数字分数 → 400')
  t.eq((await t.call('user', 'o_buy', 'reviewCreate', { orderId: 'orv' })).code, 400, '缺 score → 400')
  t.eq((await t.call('user', 'o_buy', 'reviewCreate', { orderId: 'orv', score: 5, content: 'x'.repeat(201) })).code, 400, 'content 201 字 → 400')
  t.eq((await t.call('user', 'o_buy', 'reviewCreate', { orderId: 'ghost', score: 5 })).code, 404, '订单不存在 → 404')
  t.eq((await t.call('user', 'o_weak', 'reviewCreate', { orderId: 'orv', score: 5 })).code, 403, '非订单参与方 → 403')
  t.eq((await t.call('user', 'o_ghost', 'reviewCreate', { orderId: 'orv', score: 5 })).code, 401, '未注册调用者 → 401')
  t.eq(t.store().reviews.length, 0, '以上校验分支全部没有落库')

  reviewCase({ order: { status: 'ongoing' } })
  t.eq((await t.call('user', 'o_buy', 'reviewCreate', { orderId: 'orv', score: 5 })).code, 409, '★ 订单未 finished → 409')
  t.eq(t.store().reviews.length, 0, '未完成订单不写评价')
  t.eq(t.order('orv').isRatedBuyer, false, '未完成订单不改 isRatedBuyer')

  reviewCase({ order: { status: 'confirming' } })
  t.eq((await t.call('user', 'o_buy', 'reviewCreate', { orderId: 'orv', score: 5 })).code, 409, 'confirming 状态也不能评价')

  reviewCase({ order: { sellerId: 'o_ghost' } })
  t.eq((await t.call('user', 'o_buy', 'reviewCreate', { orderId: 'orv', score: 5 })).code, 404, '被评价人不存在 → 404')
  t.eq(t.store().reviews.length, 0, '被评价人缺失时不落库、不改统计')

  reviewCase({})
  r = await t.call('user', 'o_buy', 'reviewCreate', { orderId: 'orv', score: 5, content: 'x'.repeat(200) })
  t.eq(r.code, 0, 'content 恰好 200 字通过')
  t.eq(t.store().reviews[0].content.length, 200, '200 字完整落库')

  reviewCase({})
  r = await t.call('user', 'o_buy', 'reviewCreate', { orderId: 'orv', score: 5, tags: ['t1', 't2', 't3', 't4', 't5', 't6', 't7', 't8', 't9', 't10', 't11', 't12'] })
  t.eq(r.code, 0, 'tags 超过 10 个也能提交')
  t.eq(t.store().reviews[0].tags.length, 10, '★ tags 截断到 10 个')

  reviewCase({})
  await t.call('user', 'o_buy', 'reviewCreate', { orderId: 'orv', score: 5, tags: '不是数组' })
  t.eq(t.store().reviews[0].tags.length, 0, 'tags 非数组 → 落库为空数组')

  reviewCase({})
  await t.call('user', 'o_buy', 'reviewCreate', { orderId: 'orv', score: 5, anonymous: true, content: '匿名好评' })
  t.eq(t.store().reviews[0].anonymous, true, 'anonymous 透传')
  t.ok(t.notices('o_sel')[0].content.indexOf('一位同学') === 0, '★ 匿名评价的通知不暴露昵称', t.notices('o_sel')[0].content)

  /* ==================================================================
   * 组 20b：reviewCreate 重算 avgRating + 徽章联动
   * ================================================================== */
  t.group('组 20b · ★ reviewCreate 重算 avgRating（1 位小数）与徽章联动')

  reviewCase({ sellerStats: { reviewCount: 0, ratingSum: 0, avgRating: 0 } })
  await t.call('user', 'o_buy', 'reviewCreate', { orderId: 'orv', score: 5 })
  t.eq(t.user('o_sel').stats.avgRating, 5, '首评 5 星 → avgRating=5')

  reviewCase({ sellerStats: { reviewCount: 3, ratingSum: 10 } })
  await t.call('user', 'o_buy', 'reviewCreate', { orderId: 'orv', score: 4 })
  t.eq(t.user('o_sel').stats.avgRating, 3.5, '(10+4)/4 = 3.5')
  t.eq(Math.round(t.user('o_sel').stats.avgRating * 10) / 10, t.user('o_sel').stats.avgRating, 'avgRating 不超过 1 位小数')

  reviewCase({ sellerStats: { serveCount: 19, reviewCount: 19, ratingSum: 90, avgRating: 4.7 } })
  r = await t.call('user', 'o_buy', 'reviewCreate', { orderId: 'orv', score: 5 })
  t.eq(r.code, 0, '第 20 条评价提交成功')
  t.eq(t.user('o_sel').stats.reviewCount, 20, 'reviewCount 19 → 20')
  t.eq(t.user('o_sel').stats.avgRating, 4.8, '★ (90+5)/20 = 4.75 → 4.8')
  t.ok(t.user('o_sel').badges.indexOf('social') > -1, '★ 达标后 reviewCreate 里复算徽章并写回 social', JSON.stringify(t.user('o_sel').badges))

  /* ==================================================================
   * 组 20c：reviewReply
   * ================================================================== */
  t.group('组 20c · user.reviewReply：仅被评价人可回复')

  t.seed()
  t.store().reviews = [{ _id: 'rp1', orderId: 'orv', fromId: 'o_buy', toId: 'o_sel', score: 5, content: '很好', reply: null, createTime: t.D(1) }]

  t.eq((await t.call('user', 'o_sel', 'reviewReply', { content: '谢谢' })).code, 400, '缺 reviewId → 400')
  t.eq((await t.call('user', 'o_sel', 'reviewReply', { reviewId: 'rp1', content: '   ' })).code, 400, '空白回复 → 400')
  t.eq((await t.call('user', 'o_sel', 'reviewReply', { reviewId: 'rp1', content: 'x'.repeat(201) })).code, 400, '回复超过 200 字 → 400')
  t.eq((await t.call('user', 'o_sel', 'reviewReply', { reviewId: 'rpX', content: '谢谢' })).code, 404, '评价不存在 → 404')
  t.eq((await t.call('user', 'o_buy', 'reviewReply', { reviewId: 'rp1', content: '谢谢' })).code, 403, '★ 非被评价人回复 → 403')
  t.eq((await t.call('user', 'o_ghost', 'reviewReply', { reviewId: 'rp1', content: '谢谢' })).code, 401, '未注册 → 401')
  t.eq(t.store().reviews[0].reply, null, '以上失败分支都没有写入回复')

  r = await t.call('user', 'o_sel', 'reviewReply', { reviewId: 'rp1', content: '  谢谢你的认可  ' })
  t.eq(r.code, 0, '被评价人回复成功')
  t.eq(t.store().reviews[0].reply.content, '谢谢你的认可', '★ 回复内容已 trim')
  t.eq(t.store().reviews[0].reply.time instanceof Date, true, '回复带时间戳')

  r = await t.call('user', 'o_sel', 'reviewReply', { reviewId: 'rp1', content: '补充一句' })
  t.eq(r.code, 0, '同一评价可再次回复')
  t.eq(t.store().reviews[0].reply.content, '补充一句', '（已知行为）再次回复会覆盖旧回复，服务端没有「只能回复一次」的限制')

  /* ==================================================================
   * 组 20d：★★ 并发重复评价 —— 原子抢占修复验证
   * ------------------------------------------------------------------
   * 关键在于：「未评价过」校验（读订单）与 isRatedBuyer 落库之间隔了 6 次 await，
   * 两个并发请求会双双通过校验 → 2 条评价、2 条 +1 流水，但 creditScore 只 +1
   * （账实不符），还能刷 social 徽章、重复发通知。
   * 现已在写评价**之前**用条件 update **原子抢占评价位**（updated===1 才算抢到），
   * 并发下只有一个能成功，其余 409 —— 后续写入天然只发生一次。
   * 本组断言的是**正确的**并发行为 —— 用非原子的旧写法会失败。
   * ================================================================== */
  t.group('组 20d · ★★ 并发 reviewCreate：原子抢占保证只写一条')

  reviewCase({})
  const two = await Promise.all([
    t.call('user', 'o_buy', 'reviewCreate', { orderId: 'orv', score: 5 }),
    t.call('user', 'o_buy', 'reviewCreate', { orderId: 'orv', score: 5 })
  ])
  t.eq(two.map(x => x.code).sort().join(','), '0,409', '★★ 两个并发请求只有一个成功，另一个 409（原子抢占生效）')
  t.eq(t.store().reviews.length, 1, '★★ 一张订单只被同一方写入 1 条评价')
  t.eq(t.credits('o_sel').length, 1, '被评价人只收到 1 条 review_5 信用流水')
  t.eq(t.user('o_sel').creditScore, 111, '信用分只 +1')
  t.eq(t.credits('o_sel').reduce((n, c) => n + c.change, 0), 1, '★★ 流水合计 +1 与真实分数 +1 **一致**（账实相符）')
  t.eq(t.notices('o_sel').length, 1, '被评价人只收到 1 条通知（不再重复）')
  t.eq(t.order('orv').isRatedBuyer, true, '订单已标记为已评价')
  t.eq(t.user('o_sel').stats.reviewCount, 1, 'stats.reviewCount 与实际评价条数一致')

  /* ==================================================================
   * 组 21：★ changeCredit 在信用分为 0 时的边界
   * ------------------------------------------------------------------
   * 不能写 `(u.creditScore || 100) + change` —— 0 是假值，会被当成「字段缺失」，
   * 于是 0 分用户的下一次变动从 **100** 起算：0 分直接跳到 100+。
   * 更阴的是 credit_logs 记的就是跳完的值，**对账时完全看不出异常**，
   * 只有专门构造 0 分的用例才会暴露。
   * ================================================================== */
  t.group('组 21 · ★ changeCredit：信用分 0 是合法值，不能被当成 100')

  t.seed({ selScore: 0 })
  t.eq(t.user('o_sel').creditScore, 0, '前置：信用分为 0')

  await t.shared.changeCredit('o_sel', 1, 'review_5', '测试 +1', '')
  t.eq(t.user('o_sel').creditScore, 1, '★ 0 + 1 = 1（不是 100 + 1 = 101）')

  t.seed({ selScore: 0 })
  await t.shared.changeCredit('o_sel', -3, 'review_1', '测试 -3', '')
  t.eq(t.user('o_sel').creditScore, 0, '0 分再扣分仍是 0（clamp 下界生效）')

  t.seed({ selScore: 148 })
  await t.shared.changeCredit('o_sel', 5, 'review_5', '测试 +5', '')
  t.eq(t.user('o_sel').creditScore, 150, '148 + 5 被 clamp 到 150（上界）')

  t.eq((await t.call('user', 'o_buy', 'nope', {})).code, 400, '未知 action → 400')

  /* ==================================================================
   * 组 22 · ★ 注销账号：匿名化而不是物理删除
   * ------------------------------------------------------------------
   * 为什么不能物理删除：你服务过的订单、你在对方那里的评价，都还挂在对方
   * 那边。删掉 users 文档会让那些记录指向不存在的用户，对方的「我的订单」
   * 直接崩。所以保留文档与业务记录，只抹掉**能指向具体人**的字段。
   * ================================================================== */
  t.group('组 22 · ★ 注销账号：匿名化 + 保留业务记录')

  t.seed()
  const meBefore = t.user('o_buy')
  meBefore.realName = '买家小明'
  meBefore.studentNo = '2021001'
  meBefore.phone = '13800000000'
  meBefore.campus = '广东职业技术学院'
  meBefore.college = '信息工程学院'
  meBefore.major = '计算机应用技术'
  meBefore.grade = '2024级'
  meBefore.bio = '这是我的自我介绍'
  meBefore.tags = ['吉他', '摄影']
  meBefore.authImages = ['cloud://fake-idcard.jpg']
  meBefore.locationName = '山下饭堂一楼'
  const coinsBefore = meBefore.coins
  const creditBefore = meBefore.creditScore

  // 所有进行中的订单先结掉，否则注销会被拒
  t.store().orders.forEach(o => {
    if (o.buyerId === 'o_buy' || o.sellerId === 'o_buy') o.status = 'finished'
  })
  const orderCount = t.store().orders.length
  // user 用例的 seed 只造 7 个集合，没有 reviews —— 用安全访问
  const reviewCount = (t.store().reviews || []).length

  let cr = await t.call('user', 'o_buy', 'cancel', {})
  t.eq(cr.code, 0, '★ 无进行中订单时注销成功')

  const me = t.user('o_buy')
  t.eq(me.canceled, true, '★ 打上 canceled 标记')
  t.eq(me.status, 0, '★ status=0（注销后不能再登录）')
  t.eq(me.nickName, '已注销用户', '昵称匿名化')
  t.eq(me.realName, '', '真实姓名清空')
  t.eq(me.studentNo, '', '学号清空')
  t.eq(me.phone, '', '手机号清空')
  t.eq(me.campus, '', '校区清空')
  t.eq(me.college, '', '院系清空')
  t.eq(me.major, '', '专业清空')
  t.eq(me.grade, '', '年级清空')
  t.eq(me.bio, '', '简介清空')
  t.eq(JSON.stringify(me.tags), '[]', '标签清空')
  t.eq(JSON.stringify(me.authImages), '[]', '★ 认证材料（证件照）清空 —— 这是最敏感的部分')
  t.eq(me.authStatus, 0, '认证状态重置')
  t.eq(me.locationName, '', '定位信息清空')
  t.eq(me.location, null, '★ 经纬度清空')

  t.eq(me.coins, coinsBefore, '★ 时间币保留（「总额守恒」是硬约束，清掉会破坏账）')
  t.eq(me.creditScore, creditBefore, '信用分保留（记录的是与他人的往来）')
  t.eq(t.store().orders.length, orderCount, '★ 订单记录保留（对方的历史不能凭空消失）')
  t.eq((t.store().reviews || []).length, reviewCount, '★ 评价记录保留')

  // 注销后不能再以该身份操作
  cr = await t.call('user', 'o_buy', 'mine', {})
  t.eq(cr.code, 403, '★ 注销后再调接口 → 403')
  t.ok(/已注销/.test(cr.msg), '★ 文案说的是「已注销」而不是「已被封禁」', r.msg)

  // 重复注销
  cr = await t.call('user', 'o_buy', 'cancel', {})
  t.eq(cr.code, 403, '重复注销 → 403（requireUser 先拦下）')

  /* 有进行中订单时必须拒绝 */
  t.seed()
  t.store().orders.forEach(o => {
    if (o.buyerId === 'o_buy' || o.sellerId === 'o_buy') o.status = 'finished'
  })
  // 这个用例的 seed 不保证有订单 —— 自己造一条进行中的
  t.store().orders.push({
    _id: 'ord_cancel_test',
    orderNo: 'TB_CANCEL1',
    buyerId: 'o_buy',
    sellerId: 'o_sel',
    skillId: 'sk1',
    status: 'ongoing',
    amount: 5,
    createTime: Date.now()
  })
  cr = await t.call('user', 'o_buy', 'cancel', {})
  t.eq(cr.code, 409, '★ 有进行中的订单 → 409（否则对方约不到人、订单永远卡住）')
  t.ok(/进行中的订单/.test(cr.msg), '409 文案提示先处理订单', cr.msg)
  t.eq(t.user('o_buy').canceled, undefined, '被拒后没有打上注销标记')

  /* 内部账户注销要连会话一起作废 */
  t.seed()
  t.store().accounts = []
  t.store().sessions = []
  const salt = t.shared.newSalt()
  t.store().accounts.push({
    _id: 'acc_t', username: 't', salt,
    passwordHash: t.shared.hashPassword('T@2026', salt),
    openid: 'o_buy', nickName: '内部T', status: 1, failCount: 0, lockUntil: 0,
    createTime: Date.now(), lastLoginTime: 0
  })
  t.store().users.push({
    _id: 'u_t', _openid: 'acct_x', nickName: '内部T', coins: 0, frozenCoins: 0,
    creditScore: 100, authStatus: 2, status: 1, role: 'admin', badges: [],
    stats: {}, createTime: Date.now(), updateTime: Date.now()
  })
  t.store().sessions.push({
    token: 't'.repeat(64), accountOpenid: 'acct_x', accountId: 'acc_t',
    createTime: Date.now(), expireTime: Date.now() + 100000
  })
  t.store().orders.forEach(o => {
    if (o.buyerId === 'acct_x' || o.sellerId === 'acct_x') o.status = 'finished'
  })
  cr = await t.call('user', 'o_buy', 'cancel', { __token: 't'.repeat(64) })
  t.eq(cr.code, 0, '内部账户注销成功')
  t.eq(t.store().sessions.length, 0, '★ 注销时把该账户的会话一并作废（否则旧令牌仍能操作）')
}
