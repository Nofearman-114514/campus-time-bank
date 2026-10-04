/**
 * 案例组 1-4：下单冻结 / 校验错误码 / ★ 并发防超卖 / 信用等级并发上限
 */
module.exports = async function (t) {
  /* ==================================================================
   * 组 1：create —— 下单冻结时间币
   * ================================================================== */
  t.group('组 1 · create 下单冻结：coins 减、frozenCoins 加、写 freeze 流水')
  t.seed()
  let r = await t.call('order', 'o_buy', 'create', { skillId: 'sk1', remark: '想学《晴天》', expectTime: '周六 15:00' })
  t.eq(r.code, 0, '下单成功返回 code=0')
  t.ok(r.data && r.data.orderId && /^TB\d{18}$/.test(r.data.orderNo), '返回 { orderId, orderNo }，orderNo=TB+14位时间+4位随机', JSON.stringify(r.data))
  const id1 = r.data.orderId

  t.eq(t.user('o_buy').coins, 7, '买家可用余额 10 - 3 = 7')
  t.eq(t.user('o_buy').frozenCoins, 3, '买家冻结额 0 + 3 = 3')
  t.eq(t.user('o_buy').coins + t.user('o_buy').frozenCoins, 10, '冻结只是「换口袋」：coins+frozenCoins 守恒 = 10')
  t.eq(t.user('o_sel').coins, 0, '下单时钱不会到卖家账上')

  const o1 = t.order(id1)
  t.eq(o1.status, 'waiting', '订单初始状态 waiting')
  t.eq(o1.amount, 3, '订单金额 = 技能价格 3')
  t.eq(o1._openid, 'o_buy', '订单写入 _openid（买家）')
  t.eq(o1.buyerId, 'o_buy', 'buyerId = 买家 openid')
  t.eq(o1.sellerId, 'o_sel', 'sellerId = 技能作者 openid')
  t.eq(o1.remark, '想学《晴天》', '买家留言落库')
  t.eq(o1.expectTime, '周六 15:00', '期望时间落库')
  t.eq(o1.cancelBy, '', 'cancelBy 初始为空')
  t.eq(o1.isRatedBuyer, false, 'isRatedBuyer 初始 false')

  const snap = o1.skillSnapshot || {}
  t.eq(snap.title, '吉他入门一对一', 'skillSnapshot.title 快照')
  t.eq(snap.price, 3, 'skillSnapshot.price 快照')
  t.eq(snap.duration, 60, 'skillSnapshot.duration 快照')
  t.eq(snap.categoryName, '技能教学', 'skillSnapshot.categoryName 快照')
  t.ok(Array.isArray(snap.images), 'skillSnapshot.images 是数组')
  t.eq(snap.type, 'offer', 'skillSnapshot.type 快照')

  t.eq(o1.timeline.length, 1, 'timeline 只有首条')
  t.eq(o1.timeline[0].status, 'waiting', 'timeline[0].status=waiting')
  t.eq(o1.timeline[0].remark, '买家下单，时间币已冻结', 'timeline[0].remark 文案')
  t.eq(o1.timeline[0].operator, 'o_buy', 'timeline[0].operator=买家')
  t.ok(Math.abs(new Date(o1.expireTime) - Date.now() - 24 * t.HOUR) < 60000, 'expireTime = 下单时间 + 24h（config.orderExpireHours）', o1.expireTime)

  t.eq(t.skill().orderCount, 1, '技能 orderCount 累加 1')

  const fz = t.logs('o_buy', 'freeze')
  t.eq(fz.length, 1, '写入 1 条 freeze 流水')
  t.eq(fz[0].amount, -3, 'freeze 流水金额 -3（对买家视角是出账）')
  t.eq(fz[0].balance, 7, 'freeze 流水 balance=变动后可用余额 7')
  t.eq(fz[0].frozen, 3, 'freeze 流水 frozen=变动后冻结额 3')
  t.eq(fz[0].orderId, id1, 'freeze 流水关联订单')
  t.ok(/下单冻结/.test(fz[0].remark), 'freeze 流水备注含「下单冻结」', fz[0].remark)

  t.eq(t.notices('o_sel').length, 1, '给卖家写 1 条站内通知')
  t.eq(t.notices('o_sel')[0].title, '收到新订单', '卖家通知标题')
  t.eq(t.notices('o_sel')[0].orderId, id1, '卖家通知关联订单')

  t.seed({ subscribe: { ORDER_CREATE: 'TMPL_ORDER_CREATE' } })
  await t.call('order', 'o_buy', 'create', { skillId: 'sk1' })
  t.eq(t.fake.__stats.subscribeSends, 1, 'config 配了模板 ID 时会调用订阅消息一次')
  t.seed()
  await t.call('order', 'o_buy', 'create', { skillId: 'sk1' })
  t.eq(t.fake.__stats.subscribeSends, 0, '模板 ID 为空时自动降级为站内通知，不调用订阅消息（不阻断主流程）')

  /* ==================================================================
   * 组 2：下单校验的错误码
   * ================================================================== */
  t.group('组 2 · create 校验：余额不足 409 / 信用分不足 403 / 自购 409 / 未认证 403 / 404 / 401 / 400')

  t.seed({ buyCoins: 2, buyScore: 130 })
  r = await t.call('order', 'o_buy', 'create', { skillId: 'sk1' })
  t.eq(r.code, 409, '余额 2 < 3 → 409')
  t.ok(/时间币不足/.test(r.msg), '409 文案提示时间币不足', r.msg)
  t.eq(t.user('o_buy').coins, 2, '失败后余额未变（事务回滚）')
  t.eq(t.orders().length, 0, '失败后没有留下订单')
  t.eq(t.logs('o_buy').length, 0, '失败后没有留下流水')

  t.seed({ buyScore: 50 })
  r = await t.call('order', 'o_buy', 'create', { skillId: 'sk1' })
  t.eq(r.code, 403, '信用分 50 < minCreditToOrder 60 → 403')
  t.ok(/信用分低于/.test(r.msg), '403 文案提示信用分不足', r.msg)

  /* ★ 回归：门槛必须跟随配置，不能被 `|| 60` 顶成固定值。
     原实现写的是 `config.minCreditToOrder || 60`，0 是假值会被顶成 60 ——
     管理员把门槛调高调低都不生效，报错文案永远写 60。
     注意：这里用 80 分（「良好」等级，并发上限 > 0）来隔离变量 ——
     信用分 0 属于「受限」等级、并发上限为 0，本来就不能下单，那是另一条规则。 */
  t.seed({ buyScore: 80, buyCoins: 100 })
  r = await t.call('order', 'o_buy', 'create', { skillId: 'sk1' })
  t.eq(r.code, 0, '前置：80 分 + 默认门槛 60 → 可下单')

  t.seed({ buyScore: 80, buyCoins: 100 })
  t.store().config[0].minCreditToOrder = 90
  r = await t.call('order', 'o_buy', 'create', { skillId: 'sk1' })
  t.eq(r.code, 403, '★ 门槛调到 90 时 80 分被拦（门槛确实是可配的）')
  t.ok(/信用分低于 90/.test(r.msg), '★ 文案里的数字跟随配置，不是写死的 60', r.msg)

  t.seed({ buyScore: 80, buyCoins: 100 })
  t.store().config[0].minCreditToOrder = 0
  r = await t.call('order', 'o_buy', 'create', { skillId: 'sk1' })
  t.eq(r.code, 0, '★ 门槛=0 时不再因信用分被拦（管理员能真正关掉门槛）')

  t.seed()
  r = await t.call('order', 'o_sel', 'create', { skillId: 'sk1' })
  t.eq(r.code, 409, '购买自己发布的技能 → 409')
  t.ok(/不能购买自己发布的服务/.test(r.msg), '自购文案', r.msg)

  t.seed({ buyAuth: 0 })
  r = await t.call('order', 'o_buy', 'create', { skillId: 'sk1' })
  t.eq(r.code, 403, '未通过校园认证 → 403')
  t.ok(/校园认证/.test(r.msg), '未认证文案', r.msg)

  t.seed()
  t.eq((await t.call('order', 'o_buy', 'create', { skillId: 'sk_nope' })).code, 404, '技能不存在 → 404')
  t.seed({ skillStatus: 0 })
  r = await t.call('order', 'o_buy', 'create', { skillId: 'sk1' })
  t.eq(r.code, 409, '技能已下架 → 409')
  t.ok(/已下架/.test(r.msg), '下架文案', r.msg)

  t.seed()
  t.eq((await t.call('order', 'o_ghost', 'create', { skillId: 'sk1' })).code, 401, '用户不存在 → 401')
  t.eq((await t.call('order', 'o_buy', 'create', {})).code, 400, '缺少 skillId → 400')
  t.eq((await t.call('order', 'o_buy', 'nope')).code, 400, '未知 action → 400')

  /* ==================================================================
   * 组 3：★ 并发防超卖（答辩重点）
   * ================================================================== */
  t.group('组 3 · ★ 并发防超卖：4 个并发 create 只成功 3 单，coins+frozenCoins 守恒')

  t.seed({ buyScore: 130 })          // 信用 130 → 上限 5，不会先撞上限
  const rs = await Promise.all([
    t.call('order', 'o_buy', 'create', { skillId: 'sk1' }),
    t.call('order', 'o_buy', 'create', { skillId: 'sk1' }),
    t.call('order', 'o_buy', 'create', { skillId: 'sk1' }),
    t.call('order', 'o_buy', 'create', { skillId: 'sk1' })
  ])
  const okN = rs.filter(x => x.code === 0).length
  const conflictN = rs.filter(x => x.code === 409).length
  t.eq(okN, 3, '4 个并发请求只成功 3 单（10 枚 / 每单 3 枚）')
  t.eq(conflictN, 1, '被挡下的那 1 次返回 409（余额不足），而不是静默超卖')
  t.isTrue(t.fake.__stats.retries > 0, '事务确实发生了写冲突重试（证明快照隔离生效，不是顺序执行')
  t.eq(t.user('o_buy').coins, 1, '最终可用余额 1')
  t.eq(t.user('o_buy').frozenCoins, 9, '最终冻结额 9')
  t.eq(t.user('o_buy').coins + t.user('o_buy').frozenCoins, 10, '★ coins + frozenCoins 守恒 = 10（没有凭空多出时间币）')
  t.eq(t.orders().filter(o => o.buyerId === 'o_buy').length, 3, '库里只生成 3 张订单')
  t.eq(t.skill().orderCount, 3, '技能 orderCount = 3（绝对值回写不丢计数）')
  t.eq(t.logs('o_buy', 'freeze').length, 3, 'freeze 流水条数与成功订单数一致')
  const frozenSum = t.orders().reduce((n, o) => n + o.amount, 0)
  t.eq(frozenSum, t.user('o_buy').frozenCoins, '★ 所有订单金额之和 = 买家冻结额（账实一致）')

  t.seed({ buyScore: 130 })
  const seq = []
  for (let i = 0; i < 4; i++) seq.push(await t.call('order', 'o_buy', 'create', { skillId: 'sk1' }))
  t.eq(seq.filter(x => x.code === 0).length, 3, '顺序下单同样是 3 单（并发与顺序结果一致）')
  t.eq(t.user('o_buy').coins + t.user('o_buy').frozenCoins, 10, '顺序下单同样守恒')

  /* ==================================================================
   * 组 4：信用等级并发上限 5 / 3 / 2 / 1 / 0
   * ================================================================== */
  t.group('组 4 · 信用等级并发上限（ARCHITECTURE §6.2）：5 / 3 / 2 / 1 / 0')

  const unit = [
    [130, 5], [120, 5], [119, 3], [110, 3], [100, 3], [99, 2], [90, 2],
    [80, 2], [79, 1], [70, 1], [60, 1], [59, 0], [50, 0], [0, 0], [150, 5]
  ]
  unit.forEach(([score, expect]) => {
    t.eq(t.shared.orderLimitOf(score), expect, `共享层 orderLimitOf(${score}) = ${expect}`)
  })
  ;[['excellent', 5], ['good', 3], ['normal', 2], ['weak', 1], ['limited', 0]].forEach(([key, expect]) => {
    t.eq(t.shared.orderLimitOf(key), expect, `orderLimitOf 传等级 key '${key}' = ${expect}`)
  })

  const behavior = [[130, 5], [110, 3], [90, 2], [70, 1]]
  for (const [score, limit] of behavior) {
    t.seed({ buyScore: score, price: 1 })   // 单价 1、余额 10，保证不会先撞余额
    let okc = 0
    let lastCode = 0
    for (let i = 0; i < limit + 1; i++) {
      const res = await t.call('order', 'o_buy', 'create', { skillId: 'sk1' })
      if (res.code === 0) okc++
      else { lastCode = res.code; r = res }
    }
    t.eq(okc, limit, `信用 ${score}（${t.shared.creditLevelOf(score)}，上限 ${limit}）能下 ${limit} 单`)
    t.eq(lastCode, 409, `信用 ${score} 超出上限的第 ${limit + 1} 单 → 409`)
    if (lastCode === 409) {
      t.ok(new RegExp(`最多同时进行 ${limit} 单`).test(r.msg), `信用 ${score} 的 409 文案给出上限提示`, r.msg)
    }
  }

  t.seed({ buyScore: 50, price: 1 })
  r = await t.call('order', 'o_buy', 'create', { skillId: 'sk1' })
  t.eq(r.code, 403, '信用 50（limited，上限 0）连第 1 单都下不了 → 403')
  t.ok(/信用分低于/.test(r.msg), '受限等级给出信用分提示文案', r.msg)
}
