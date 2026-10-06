/**
 * 内容安全（security.msgSecCheck）
 * ==================================================================
 * 覆盖 4 个 UGC 入口：技能标题/详情、下单留言、聊天消息、评价内容。
 *
 * ★ 重点断言两件事：
 *   ① 违规内容**必须被拦下，且不能落库** —— 只报错但数据已经写进去了，
 *      等于没拦（用户刷新一下就看到自己的违规内容还在）
 *   ② 检测接口本身失败时**必须放行**（fail-open）——
 *      否则一次接口抖动会让所有人都发不出内容，那比漏一条违规严重得多
 * ==================================================================
 */
module.exports = async function (t) {
  const LOC = { longitude: 112.818333, latitude: 23.003611, address: '广职院 · 山下 1 栋', locationName: '山下 1 栋楼下' }
  const BAD = '违禁词'
  const pub = (over) => t.call('skill', 'o_buy', 'create', Object.assign({
    ...LOC, type: 'offer', title: '吉他入门', desc: '零基础也能上手',
    categoryId: 'c2', price: 3, duration: 60
  }, over || {}))

  /* ==================================================================
   * 组 1 · 技能标题与详情
   * ================================================================== */
  t.group('组 1 · 技能发布：标题 / 详情过内容安全')

  t.seed()
  t.fake.__secReset()
  t.fake.__secRisky([BAD])

  let r = await pub({ title: '吉他入门' + BAD })
  t.eq(r.code, 400, '★ 标题含违规内容 → 400')
  t.ok(/违规信息/.test(r.msg), '400 文案说明是违规信息', r.msg)
  t.ok(/技能标题/.test(r.msg), '★★ 文案指明是「技能标题」而不是笼统的「内容」', r.msg)
  t.eq(t.store().skills.filter(s => s.authorId === 'o_buy').length, 0,
    '★★ 被拦下时技能**没有落库** —— 只报错但数据已写入等于没拦')

  r = await pub({ desc: '详情里有' + BAD })
  t.eq(r.code, 400, '★ 详情含违规内容 → 400')
  t.ok(/技能详情/.test(r.msg), '★ 文案指明是「技能详情」', r.msg)
  t.eq(t.store().skills.filter(s => s.authorId === 'o_buy').length, 0, '详情违规时技能也没落库')

  r = await pub({ title: '吉他入门一对一', desc: '周六下午，教学楼 B1' })
  t.eq(r.code, 0, '★ 正常内容照常发布')
  t.eq(t.store().skills.filter(s => s.authorId === 'o_buy').length, 1, '正常内容确实落库了')

  /* ---- review（疑似）应当放行 ---- */
  t.seed()
  t.fake.__secReset()
  t.fake.__secReview([BAD])
  r = await pub({ title: '疑似内容' + BAD })
  t.eq(r.code, 0, '★ suggest=review（疑似）**放行**，交给人工审核 —— 一刀切会误伤大量正常内容')
  t.eq(t.store().skills.filter(s => s.authorId === 'o_buy').length, 1, 'review 内容正常落库')

  /* ---- 接口失败必须放行（fail-open） ---- */
  t.seed()
  t.fake.__secReset()
  t.fake.__secFail(true)
  r = await pub({ title: '接口挂了也要能发' })
  t.eq(r.code, 0, '★★ 检测接口失败时**放行** —— 失败就拒绝会让所有人都发不出内容')
  t.eq(t.store().skills.filter(s => s.authorId === 'o_buy').length, 1, '接口失败时内容照常落库')
  t.ok(t.fake.__secCalls() > 0, '接口确实被调用过（不是根本没走到）')
  t.fake.__secFail(false)

  /* ---- 接口被调用的次数要合理 ---- */
  t.seed()
  t.fake.__secReset()
  r = await pub({})
  t.eq(r.code, 0, '正常发布成功')
  t.eq(t.fake.__secCalls(), 2, '★ 标题 + 详情各检一次，共 2 次')

  /* ==================================================================
   * 组 2 · 聊天消息
   * ================================================================== */
  t.group('组 2 · 聊天消息：社交日志场景')

  t.seed()
  t.fake.__secReset()
  t.fake.__secRisky([BAD])

  r = await t.call('message', 'o_buy', 'openChat', { toId: 'o_sel' })
  t.eq(r.code, 0, '先建立会话')
  const chatId = r.data.chatId

  r = await t.call('message', 'o_buy', 'send', { chatId, content: '你好' + BAD })
  t.eq(r.code, 400, '★ 聊天消息含违规内容 → 400')
  const msgs = (t.store().messages || []).filter(m => m.chatId === chatId)
  t.eq(msgs.length, 0, '★★ 被拦下的消息**没有落库**')

  r = await t.call('message', 'o_buy', 'send', { chatId, content: '周六下午两点可以吗？' })
  t.eq(r.code, 0, '★ 正常消息照常发送')
  t.eq((t.store().messages || []).filter(m => m.chatId === chatId).length, 1, '正常消息落库')

  const before = t.fake.__secCalls()
  r = await t.call('message', 'o_buy', 'send', { chatId, content: 'cloud://fake.jpg', type: 'image' })
  t.eq(r.code, 0, '图片消息照常发送')
  t.eq(t.fake.__secCalls(), before, '★ 图片消息**不做文本检测**（图片是另一套接口）')

  /* ==================================================================
   * 组 3 · 评价内容
   * ================================================================== */
  t.group('组 3 · 评价内容')

  t.seed()
  t.fake.__secReset()
  t.fake.__secRisky([BAD])
  t.putOrder({
    _id: 'rv_sec1', orderNo: 'TB_SEC0001', buyerId: 'o_buy', sellerId: 'o_sel',
    skillId: 'sk1', status: 'finished', amount: 3,
    isRatedBuyer: false, isRatedSeller: false,
    buyerInfo: { nickName: '买家', avatarUrl: '' },
    sellerInfo: { nickName: '卖家', avatarUrl: '' }
  })

  r = await t.call('user', 'o_buy', 'reviewCreate', { orderId: 'rv_sec1', score: 5, content: '很不好的' + BAD })
  t.eq(r.code, 400, '★ 评价含违规内容 → 400')
  t.ok(/评价内容/.test(r.msg), '文案指明是「评价内容」', r.msg)
  t.eq((t.store().reviews || []).length, 0, '★★ 被拦下的评价没有落库')

  /* ==================================================================
   * 组 4 · 下单留言
   * ================================================================== */
  t.group('组 4 · 下单留言')

  t.seed()
  t.fake.__secReset()
  t.fake.__secRisky([BAD])

  r = await t.call('order', 'o_buy', 'create', { skillId: 'sk1', remark: '帮我带个' + BAD })
  t.eq(r.code, 400, '★ 留言含违规内容 → 400')
  t.ok(/留言/.test(r.msg), '文案指明是「留言」', r.msg)
  t.eq(t.user('o_buy').coins, 10, '★★ 被拦下时**时间币没有被冻结** —— 拦在事务之前')
  t.eq(t.user('o_buy').frozenCoins, 0, '冻结额仍为 0')
  t.eq(t.store().orders.filter(o => o.buyerId === 'o_buy').length, 0, '订单没有创建')

  r = await t.call('order', 'o_buy', 'create', { skillId: 'sk1', remark: '周六下午方便吗' })
  t.eq(r.code, 0, '★ 正常留言照常下单')

  /* ---- 空留言不白调接口 ---- */
  t.seed()
  t.fake.__secReset()
  r = await t.call('order', 'o_buy', 'create', { skillId: 'sk1' })
  t.eq(r.code, 0, '不填留言也能下单')
  t.eq(t.fake.__secCalls(), 0, '★ 空内容直接跳过，不白调一次接口')

  t.fake.__secReset()
}
