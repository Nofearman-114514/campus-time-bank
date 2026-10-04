/**
 * 案例组 9-10：超时兜底（惰性 + 定时触发器 autoTask）与幂等
 */
module.exports = async function (t) {
  /* ==================================================================
   * 组 9：惰性超时（counts 顺带处理）
   * ================================================================== */
  t.group('组 9 · waiting 超时：counts 首次调用即自动关闭并解冻退款')

  t.seed()
  let r = await t.call('order', 'o_buy', 'create', { skillId: 'sk1' })
  const w1 = r.data.orderId
  t.order(w1).expireTime = t.D(1)          // 人为把超时时间推到 1 小时前

  let cnt = await t.call('order', 'o_buy', 'counts', {})
  t.eq(cnt.code, 0, 'counts 调用成功')
  t.eq(cnt.data.waiting, 0, '超时单不再计入 waiting')
  t.eq(cnt.data.canceled, 1, '超时单计入 canceled')
  t.eq(t.order(w1).status, 'closed', '超时单状态 → closed')
  t.eq(t.order(w1).cancelBy, 'system', "cancelBy='system'")
  t.eq(t.order(w1).cancelReason, '超时未接单，系统自动取消', '超时原因文案')
  t.ok(!!t.order(w1).cancelTime, '写入 cancelTime')
  t.eq(t.user('o_buy').coins, 10, '★ 超时自动解冻，余额退回 10')
  t.eq(t.user('o_buy').frozenCoins, 0, '★ 冻结额清零')
  t.eq(t.logs('o_buy', 'unfreeze').length, 1, '写 1 条 unfreeze 流水')
  t.eq(t.notices('o_buy').filter(n => n.title === '订单超时已关闭').length, 1, '通知买家订单超时关闭')
  t.eq(t.skill().orderCount, 1, '技能 orderCount 不回滚（历史下单事实保留）')

  cnt = await t.call('order', 'o_buy', 'counts', {})
  t.eq(cnt.data.canceled, 1, '再次调用 counts 不会重复处理')
  t.eq(t.user('o_buy').coins, 10, '幂等：不重复退款')
  t.eq(t.logs('o_buy', 'unfreeze').length, 1, '幂等：不重复写流水')

  t.group('组 9b · confirming 超时：自动确认并把时间币结算给卖家')

  t.seed()
  r = await t.call('order', 'o_buy', 'create', { skillId: 'sk1' })
  const p1 = r.data.orderId
  await t.call('order', 'o_sel', 'accept', { orderId: p1 })
  await t.call('order', 'o_sel', 'finish', { orderId: p1 })
  t.order(p1).finishTime = t.D(100)        // 超过 config.confirmExpireHours = 72h

  cnt = await t.call('order', 'o_buy', 'counts', {})
  t.eq(cnt.data.confirming, 0, '超时单不再计入 confirming')
  t.eq(cnt.data.finished, 1, '超时单计入 finished')
  t.eq(t.order(p1).status, 'finished', '自动结算后状态 → finished')
  t.ok(!!t.order(p1).confirmTime, '写入 confirmTime')
  t.eq(t.user('o_sel').coins, 3, '★ 卖家自动到账 3')
  t.eq(t.user('o_sel').totalEarned, 3, '卖家 totalEarned 累加')
  t.eq(t.user('o_sel').stats.serveCount, 1, '卖家 serveCount 累加')
  t.eq(t.user('o_buy').frozenCoins, 0, '买家冻结额释放')
  t.eq(t.user('o_buy').totalSpent, 3, '买家 totalSpent 累加')
  t.eq(t.logs('o_sel', 'income').length, 1, '写卖家 income 流水')
  t.eq(t.logs('o_buy', 'expense').length, 1, '写买家 expense 流水')
  const tl = t.order(p1).timeline
  t.ok(/系统自动结算/.test(tl[tl.length - 1].remark), 'timeline 最后一条记录系统自动结算', JSON.stringify(tl[tl.length - 1]))
  t.eq(t.user('o_buy').creditScore, 102, '自动结算同样给双方 +2 信用分（买家）')
  t.eq(t.user('o_sel').creditScore, 112, '自动结算同样给双方 +2 信用分（卖家）')

  /* ==================================================================
   * 组 10：autoTask 定时触发器
   * ================================================================== */
  t.group('组 10 · autoTask：定时触发器无登录态也能跑，且幂等')

  t.seed()
  const e1 = (await t.call('order', 'o_buy', 'create', { skillId: 'sk1' })).data.orderId
  t.order(e1).expireTime = t.D(2)
  const e2 = (await t.call('order', 'o_buy', 'create', { skillId: 'sk1' })).data.orderId
  await t.call('order', 'o_sel', 'accept', { orderId: e2 })
  await t.call('order', 'o_sel', 'finish', { orderId: e2 })
  t.order(e2).finishTime = t.D(80)

  let at = await t.callRaw('order', { Type: 'Timer', TriggerName: 'orderAutoTask' })
  t.eq(at.code, 0, '定时触发 event（{Type:"Timer"}）无 OPENID 也返回 code=0')
  t.eq(at.data.closed, 1, 'autoTask 关闭 1 单超时待接单')
  t.eq(at.data.settled, 1, 'autoTask 结算 1 单超时待确认')
  t.eq(t.order(e1).status, 'closed', '超时待接单 → closed')
  t.eq(t.order(e1).cancelBy, 'system', 'cancelBy=system')
  t.eq(t.order(e2).status, 'finished', '超时待确认 → finished')
  t.eq(t.user('o_buy').coins, 7, '买家：10 - 3（已结算的那单）= 7，被关闭的那单已退回')
  t.eq(t.user('o_buy').frozenCoins, 0, '冻结额清零')
  t.eq(t.user('o_buy').totalSpent, 3, '只把真正完成的单计入支出')
  t.eq(t.user('o_sel').coins, 3, '卖家到账 3')
  t.eq(t.logs('o_buy', 'unfreeze').length, 1, '被关闭的单写 unfreeze 流水')
  t.eq(t.logs('o_buy', 'expense').length, 1, '被结算的单写 expense 流水')

  at = await t.callRaw('order', { action: 'autoTask' })
  t.eq(at.code, 0, '用 {action:"autoTask"} 显式调用同样可用')
  t.eq(at.data.closed, 0, '★ 幂等：再次执行没有可关闭的单')
  t.eq(at.data.settled, 0, '★ 幂等：再次执行没有可结算的单')
  t.eq(t.user('o_buy').coins, 7, '★ 幂等：不重复退款')
  t.eq(t.user('o_sel').coins, 3, '★ 幂等：不重复结算')
  t.eq(t.user('o_sel').stats.serveCount, 1, '幂等：serveCount 没有被重复累加')
  t.eq(t.logs('o_sel', 'income').length, 1, '幂等：流水没有重复写入')
  t.eq(t.logs('o_buy', 'unfreeze').length, 1, '幂等：解冻流水没有重复写入')

  t.group('组 10b · autoTask 单批上限 50（云函数超时保护）')

  t.seed({ buyCoins: 20, price: 2, buyScore: 130 })
  for (let i = 0; i < 60; i++) t.putOrder({ _id: 'exp' + i, orderNo: 'TB_EXP' + i, amount: 2 })
  t.eq(t.orders().filter(o => o.status === 'waiting').length, 60, '构造 60 张已超时的待接单')

  at = await t.callRaw('order', { action: 'autoTask' })
  t.eq(at.data.closed, 50, '第一批最多处理 50 条（不一次性跑完导致云函数超时）')
  t.eq(t.orders().filter(o => o.status === 'waiting').length, 10, '还剩 10 张未处理，等下一轮触发')

  at = await t.callRaw('order', { action: 'autoTask' })
  t.eq(at.data.closed, 10, '第二轮处理剩余 10 条')
  at = await t.callRaw('order', { action: 'autoTask' })
  t.eq(at.data.closed, 0, '第三轮已无单可处理')

  t.eq(t.user('o_buy').coins, 20 + 60 * 2, '60 张单全部退款到账：20 + 120 = 140')
  t.eq(t.user('o_buy').frozenCoins, 0, '全部解冻完成')
  t.eq(t.logs('o_buy', 'unfreeze').length, 60, '60 条解冻流水，一条不多一条不少')
  t.eq(t.logs('o_buy', 'unfreeze').reduce((n, l) => n + l.amount, 0), 120, '退款总额 = 120')
}
