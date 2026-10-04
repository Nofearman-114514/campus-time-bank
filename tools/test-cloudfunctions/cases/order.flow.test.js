/**
 * 案例组 5-8：accept 并发抢占 / reject 与 cancel / finish→confirm 结算 / list·detail·counts
 */
module.exports = async function (t) {
  /* ==================================================================
   * 组 5：accept —— 并发抢占，只有一个能成功
   * ================================================================== */
  t.group('组 5 · accept 卖家接单：两个并发请求只有一个成功，另一个 409')

  t.seed()
  let r = await t.call('order', 'o_buy', 'create', { skillId: 'sk1' })
  const a1 = r.data.orderId
  t.eq((await t.call('order', 'o_buy', 'accept', { orderId: a1 })).code, 403, '买家自己接单 → 403')
  t.eq((await t.call('order', 'o_weak', 'accept', { orderId: a1 })).code, 403, '非参与方接单 → 403')

  const two = await Promise.all([
    t.call('order', 'o_sel', 'accept', { orderId: a1 }),
    t.call('order', 'o_sel', 'accept', { orderId: a1 })
  ])
  t.eq(two.filter(x => x.code === 0).length, 1, '★ 两个并发 accept 只有 1 个成功（条件更新原子抢占）')
  t.eq(two.filter(x => x.code === 409).length, 1, '另一个返回 409')
  t.eq(t.order(a1).status, 'ongoing', '订单状态 waiting → ongoing')
  t.ok(!!t.order(a1).acceptTime, '写入 acceptTime')
  t.eq(t.order(a1).timeline.length, 2, 'timeline 追加 1 条（共 2 条），没有重复追加')
  t.eq(t.order(a1).timeline[1].remark, '服务者已接单', 'timeline 文案')
  t.eq(t.order(a1).timeline[1].operator, 'o_sel', 'timeline operator=卖家')
  t.eq(t.notices('o_buy').filter(n => n.title === '有人接单啦').length, 1, '通知买家「有人接单啦」且只发一次')
  t.eq((await t.call('order', 'o_sel', 'accept', { orderId: a1 })).code, 409, '再次接单 → 409（不重复改状态）')
  t.eq(t.user('o_buy').frozenCoins, 3, '接单不改变资金状态（冻结仍在）')

  /* ==================================================================
   * 组 6：reject / cancel —— 解冻退回 + 爽约扣分
   * ================================================================== */
  t.group('组 6 · reject 卖家拒单：解冻退回买家，双方都不扣分')

  t.seed()
  r = await t.call('order', 'o_buy', 'create', { skillId: 'sk1' })
  const j1 = r.data.orderId
  r = await t.call('order', 'o_sel', 'reject', { orderId: j1, reason: '本周没空' })
  t.eq(r.code, 0, '卖家拒单成功')
  t.eq(t.order(j1).status, 'closed', '状态 waiting → closed')
  t.eq(t.order(j1).cancelBy, 'seller', "cancelBy='seller'")
  t.eq(t.order(j1).cancelReason, '本周没空', 'cancelReason 落库')
  t.ok(!!t.order(j1).cancelTime, '写入 cancelTime')
  t.eq(t.user('o_buy').coins, 10, '买家余额全额退回 10')
  t.eq(t.user('o_buy').frozenCoins, 0, '买家冻结额清零')
  const uf = t.logs('o_buy', 'unfreeze')
  t.eq(uf.length, 1, '写入 1 条 unfreeze 流水')
  t.eq(uf[0].amount, 3, 'unfreeze 金额 +3（原路退回）')
  t.eq(uf[0].balance, 10, 'unfreeze 流水 balance=10')
  t.eq(uf[0].frozen, 0, 'unfreeze 流水 frozen=0')
  t.eq(t.user('o_buy').creditScore, 100, '拒单不扣买家信用分')
  t.eq(t.user('o_sel').creditScore, 110, '拒单不扣卖家信用分（尚未接单，不算爽约）')
  t.eq(t.credits('o_sel').length, 0, '拒单不写信用流水')
  t.eq(t.notices('o_buy').filter(n => n.title === '订单被拒绝').length, 1, '通知买家订单被拒')

  t.group('组 6b · cancel（waiting）：双方可取消、不扣信用分')

  t.seed()
  r = await t.call('order', 'o_buy', 'create', { skillId: 'sk1' })
  const c1 = r.data.orderId
  t.eq((await t.call('order', 'o_weak', 'cancel', { orderId: c1 })).code, 403, '非参与方取消 → 403')
  r = await t.call('order', 'o_buy', 'cancel', { orderId: c1, reason: '临时有事' })
  t.eq(r.code, 0, '买家在 waiting 取消成功')
  t.eq(t.order(c1).status, 'canceled', '状态 → canceled')
  t.eq(t.order(c1).cancelBy, 'buyer', "cancelBy='buyer'")
  t.eq(t.user('o_buy').coins, 10, '时间币退回')
  t.eq(t.user('o_buy').creditScore, 100, '未接单前取消不扣信用分')
  t.eq(t.credits('o_buy').length, 0, '未接单前取消不写信用流水')
  t.eq(t.logs('o_buy', 'unfreeze').length, 1, '写 unfreeze 流水')
  t.eq(t.notices('o_sel').filter(n => n.title === '订单已取消').length, 1, '通知另一方（卖家）')

  t.group('组 6c · cancel（ongoing）= 接单后取消/爽约：取消方 -5 分且 streak 归零')

  t.seed()
  t.user('o_sel').stats.ontimeStreak = 6
  r = await t.call('order', 'o_buy', 'create', { skillId: 'sk1' })
  const c2 = r.data.orderId
  await t.call('order', 'o_sel', 'accept', { orderId: c2 })
  r = await t.call('order', 'o_sel', 'cancel', { orderId: c2, reason: '临时冲突' })
  t.eq(r.code, 0, '卖家接单后取消成功')
  t.eq(t.order(c2).status, 'canceled', '状态 → canceled')
  t.eq(t.order(c2).cancelBy, 'seller', "cancelBy='seller'")
  t.eq(t.user('o_sel').creditScore, 105, '★ 取消方（卖家）110 - 5 = 105')
  t.eq(t.user('o_sel').creditLevel, 'good', '信用等级同步重算')
  const sc = t.credits('o_sel')
  t.eq(sc.length, 1, '写 1 条信用流水')
  t.eq(sc[0].change, -5, '信用流水 change=-5')
  t.eq(sc[0].reason, 'cancel_after_accept', "reason='cancel_after_accept'")
  t.eq(sc[0].reasonText, '接单后取消 / 爽约', 'reasonText 中文说明')
  t.eq(sc[0].score, 105, '信用流水记录变动后分数')
  t.eq(t.user('o_sel').stats.ontimeStreak, 0, '★ 取消方 ontimeStreak 由 6 归零')
  t.eq(t.user('o_buy').creditScore, 100, '非取消方（买家）不扣分')
  t.eq(t.user('o_buy').coins, 10, '买家时间币仍全额退回')

  t.seed()
  r = await t.call('order', 'o_buy', 'create', { skillId: 'sk1' })
  const c3 = r.data.orderId
  await t.call('order', 'o_sel', 'accept', { orderId: c3 })
  await t.call('order', 'o_buy', 'cancel', { orderId: c3 })
  t.eq(t.user('o_buy').creditScore, 95, '买家在 ongoing 取消也扣 5 分 → 95')
  t.eq(t.user('o_sel').creditScore, 110, '被放鸽子的卖家不扣分')
  t.eq(t.user('o_buy').frozenCoins, 0, '取消后冻结清零')

  t.eq((await t.call('order', 'o_buy', 'cancel', { orderId: c3 })).code, 409, '已取消的订单再取消 → 409')

  /* ==================================================================
   * 组 7：finish → confirm（★ 结算事务）
   * ================================================================== */
  t.group('组 7 · finish → confirm 结算：余额、累计收支、双方 +2 信用分、streak 奖励、徽章')

  t.seed({ streak: 4 })
  r = await t.call('order', 'o_buy', 'create', { skillId: 'sk1' })
  const f1 = r.data.orderId
  await t.call('order', 'o_sel', 'accept', { orderId: f1 })

  t.eq((await t.call('order', 'o_buy', 'finish', { orderId: f1 })).code, 403, '买家标记完成 → 403')
  r = await t.call('order', 'o_sel', 'finish', { orderId: f1 })
  t.eq(r.code, 0, '卖家标记服务完成成功')
  t.eq(t.order(f1).status, 'confirming', '状态 ongoing → confirming')
  t.ok(!!t.order(f1).finishTime, '写入 finishTime')
  t.eq(t.order(f1).timeline.length, 3, 'timeline 追加到 3 条')
  t.eq(t.notices('o_buy').filter(n => n.title === '服务已完成，请确认').length, 1, '通知买家确认')
  t.eq(t.user('o_buy').frozenCoins, 3, '★ 确认前冻结额仍是 3：钱还锁在买家名下，卖家拿不到')
  t.eq(t.user('o_sel').coins, 0, '★ 确认前卖家余额仍是 0')
  t.eq((await t.call('order', 'o_sel', 'finish', { orderId: f1 })).code, 409, '重复标记完成 → 409')

  t.eq((await t.call('order', 'o_sel', 'confirm', { orderId: f1 })).code, 403, '卖家确认 → 403（只有买家能确认）')
  r = await t.call('order', 'o_buy', 'confirm', { orderId: f1 })
  t.eq(r.code, 0, '买家确认完成成功')

  const o7 = t.order(f1)
  t.eq(o7.status, 'finished', '状态 confirming → finished')
  t.ok(!!o7.confirmTime, '写入 confirmTime')
  t.eq(o7.timeline.length, 4, 'timeline 共 4 条（waiting/ongoing/confirming/finished）')

  t.eq(t.user('o_buy').coins, 7, '买家可用余额仍是 7（下单时已扣走）')
  t.eq(t.user('o_buy').frozenCoins, 0, '★ 买家冻结额释放为 0')
  t.eq(t.user('o_buy').totalSpent, 3, '买家 totalSpent 累计 = 3')
  t.eq(t.user('o_buy').stats.buyCount, 1, '买家 stats.buyCount = 1')
  t.eq(t.user('o_sel').coins, 3, '★ 卖家到账 3')
  t.eq(t.user('o_sel').totalEarned, 3, '卖家 totalEarned 累计 = 3')
  t.eq(t.user('o_sel').stats.serveCount, 1, '卖家 stats.serveCount = 1')
  t.eq(
    t.user('o_buy').coins + t.user('o_buy').frozenCoins + t.user('o_sel').coins + t.user('o_sel').frozenCoins,
    10,
    '★ 结算后平台时间币总量守恒 = 10（只是从买家口袋到了卖家口袋）'
  )

  const ex = t.logs('o_buy', 'expense')
  t.eq(ex.length, 1, '买家写入 1 条 expense 流水')
  t.eq(ex[0].amount, -3, '买家 expense 金额 -3')
  t.eq(ex[0].balance, 7, '买家 expense balance=7')
  t.eq(ex[0].frozen, 0, '买家 expense frozen=0')
  t.ok(/完成结算/.test(ex[0].remark), '买家流水备注含「完成结算」', ex[0].remark)
  const inc = t.logs('o_sel', 'income')
  t.eq(inc.length, 1, '卖家写入 1 条 income 流水')
  t.eq(inc[0].amount, 3, '卖家 income 金额 +3')
  t.eq(inc[0].balance, 3, '卖家 income balance=3')
  t.eq(inc[0].orderId, f1, '卖家流水关联订单')
  t.ok(/服务收入/.test(inc[0].remark), '卖家流水备注含「服务收入」', inc[0].remark)

  t.eq(t.user('o_buy').creditScore, 102, '买家信用分 100 + 2 = 102')
  t.eq(t.user('o_sel').creditScore, 115, '卖家 110 + 2（订单完成）+ 3（连续 5 单）= 115')
  const sReasons = t.credits('o_sel').map(c => `${c.reason}:${c.change}`)
  t.ok(sReasons.indexOf('order_finish:2') > -1, '卖家写入 order_finish +2 信用流水', JSON.stringify(sReasons))
  t.ok(sReasons.indexOf('ontime_streak:3') > -1, '★ 卖家连续 5 单按时完成触发 ontime_streak +3', JSON.stringify(sReasons))
  t.ok(t.credits('o_buy').map(c => c.reason).indexOf('order_finish') > -1, '买家写入 order_finish 信用流水')
  t.eq(t.user('o_sel').stats.ontimeStreak, 5, '卖家 ontimeStreak 4 → 5')

  const sb = t.user('o_sel').badges
  t.ok(sb.indexOf('newbie') > -1, '卖家补发 newbie（完成首单）', JSON.stringify(sb))
  t.ok(sb.indexOf('ontime') > -1, '卖家补发 ontime（streak ≥ 5）', JSON.stringify(sb))
  t.ok(t.user('o_buy').badges.indexOf('newbie') > -1, '买家补发 newbie', JSON.stringify(t.user('o_buy').badges))
  const ns = t.notices('o_sel')
  t.eq(ns.filter(n => n.title === '时间币已到账').length, 1, '通知卖家「时间币已到账」')
  t.eq((await t.call('order', 'o_buy', 'confirm', { orderId: f1 })).code, 409, '重复确认 → 409（幂等，不重复打款）')
  t.eq(t.user('o_sel').coins, 3, '重复确认后卖家余额不变（没有重复结算）')

  t.group('组 7b · 徽章：warm（服务 ≥10 单）/ expert（同分类 ≥5 单且评分 ≥4.5）')

  t.seed({ serveCount: 9, avgRating: 4.8, streak: 0 })
  for (let i = 0; i < 4; i++) {
    t.putOrder({
      _id: 'old' + i, orderNo: 'TB_OLD' + i, status: 'finished',
      buyerId: 'o_other', amount: 2, finishTime: t.D(50), confirmTime: t.D(50)
    })
  }
  r = await t.call('order', 'o_buy', 'create', { skillId: 'sk1' })
  const f2 = r.data.orderId
  await t.call('order', 'o_sel', 'accept', { orderId: f2 })
  await t.call('order', 'o_sel', 'finish', { orderId: f2 })
  await t.call('order', 'o_buy', 'confirm', { orderId: f2 })
  t.eq(t.user('o_sel').stats.serveCount, 10, '卖家 serveCount 达到 10')
  const b2 = t.user('o_sel').badges
  t.ok(b2.indexOf('warm') > -1, '★ 补发 warm（完成 10 次技能提供）', JSON.stringify(b2))
  t.ok(b2.indexOf('expert') > -1, '★ 补发 expert（同一分类 5 单 + 平均评分 4.8 ≥ 4.5）', JSON.stringify(b2))
  t.ok(b2.indexOf('ontime') < 0, 'streak 只有 1 时不发 ontime 徽章', JSON.stringify(b2))

  t.group('组 7c · 徽章去重与条件边界')

  t.seed({ streak: 0 })
  t.user('o_sel').badges = ['newbie', 'ontime']
  r = await t.call('order', 'o_buy', 'create', { skillId: 'sk1' })
  const f3 = r.data.orderId
  await t.call('order', 'o_sel', 'accept', { orderId: f3 })
  await t.call('order', 'o_sel', 'finish', { orderId: f3 })
  await t.call('order', 'o_buy', 'confirm', { orderId: f3 })
  t.eq(t.user('o_sel').badges.length, 2, '★ 已拥有的徽章不重复写入（去重）')
  t.eq(t.credits('o_sel').filter(c => c.reason === 'ontime_streak').length, 0, 'streak=1 不触发连续完成奖励')

  /* ==================================================================
   * 组 8：list / detail / counts
   * ================================================================== */
  t.group('组 8 · list / detail / counts 的返回结构')

  t.seed()
  const l1 = (await t.call('order', 'o_buy', 'create', { skillId: 'sk1' })).data.orderId
  await t.call('order', 'o_sel', 'accept', { orderId: l1 })

  let lb = await t.call('order', 'o_buy', 'list', { role: 'buyer', status: 'all', page: 1, size: 10 })
  t.eq(lb.code, 0, 'list 调用成功')
  t.eq(lb.data.total, 1, '买家列表 total=1')
  t.eq(lb.data.list.length, 1, 'list 长度 1')
  t.eq(lb.data.hasMore, false, 'hasMore=false')
  t.eq(lb.data.list[0].role, 'buyer', "补 role='buyer'")
  t.eq(lb.data.list[0].roleText, '我买到的', "补 roleText='我买到的'")
  t.eq(lb.data.list[0].counterpart.nickName, '卖家思远', '补 counterpart（对方资料快照）')
  t.eq(lb.data.list[0].counterpartId, 'o_sel', '补 counterpartId')

  const lsel = await t.call('order', 'o_sel', 'list', { role: 'seller', status: 'ongoing' })
  t.eq(lsel.data.total, 1, '卖家按状态 ongoing 筛选 total=1')
  t.eq(lsel.data.list[0].role, 'seller', "卖家视角 role='seller'")
  t.eq(lsel.data.list[0].roleText, '我接的单', "卖家 roleText='我接的单'")
  t.eq(lsel.data.list[0].counterpartId, 'o_buy', '卖家视角 counterpartId=买家')
  t.eq((await t.call('order', 'o_buy', 'list', { role: 'buyer', status: 'waiting' })).data.total, 0, '状态筛选生效（waiting 已无单）')
  t.eq((await t.call('order', 'o_weak', 'list', { role: 'buyer' })).data.total, 0, '别人的订单不会出现在我的列表')

  const ld = await t.call('order', 'o_adm', 'detail', { orderId: l1 })
  t.eq(ld.code, 0, '管理员可查看任意订单详情')
  t.eq(ld.data.role, 'admin', "非参与方的管理员 role='admin'（不假装成买卖双方）")
  t.eq((await t.call('order', 'o_weak', 'detail', { orderId: l1 })).code, 403, '非参与方查看详情 → 403')
  const db2 = await t.call('order', 'o_buy', 'detail', { orderId: l1 })
  t.eq(db2.code, 0, '参与方（买家）可查看详情')
  t.eq(db2.data.role, 'buyer', 'detail 返回 role')
  t.eq(db2.data.order.roleText, '我买到的', 'detail.order 也经过 withRole 处理')
  t.eq(t.order(l1).orderNo && (await t.call('order', 'o_buy', 'detail', { orderId: t.order(l1).orderNo })).code, 0, 'detail 支持用 orderNo 查询')
  t.eq((await t.call('order', 'o_buy', 'detail', { orderId: 'TB_NOPE' })).code, 404, '订单不存在 → 404')

  let cnt = await t.call('order', 'o_buy', 'counts', {})
  t.eq(cnt.code, 0, 'counts 调用成功')
  t.eq(cnt.data.ongoing, 1, 'counts.ongoing=1')
  t.eq(Object.keys(cnt.data).sort().join(','), 'canceled,confirming,finished,ongoing,waiting', 'counts 返回 5 个状态字段')

  const rj = await t.call('order', 'o_buy', 'create', { skillId: 'sk1' })
  await t.call('order', 'o_sel', 'reject', { orderId: rj.data.orderId })
  cnt = await t.call('order', 'o_buy', 'counts', {})
  t.eq(cnt.data.canceled, 1, '★ closed 计入 canceled')
  t.eq(cnt.data.waiting, 0, '被拒的单不再计入 waiting')

  const rq = await t.call('order', 'o_weak', 'create', { skillId: 'sk1' })
  const cntSeller = await t.call('order', 'o_sel', 'counts', {})
  t.eq(rq.code, 0, '另一买家下单成功')
  t.eq(cntSeller.data.waiting, 1, 'counts 合并买卖双方（卖家侧看到 new 单）')
}
