/**
 * 防刷单：订单信用分每日递减
 * ==================================================================
 * 要防的是「时间币集中 / 互刷」：时间币总额守恒（不会通胀），
 * 但**刷出来的币可以买走真实的劳动**，而且每单 +2 信用分是实打实的收益。
 *
 * ★ 关键设计：不判断「谁是刷子」（良性固定搭子和刷单在数据上长得一样），
 *   只限制**收益**。真实用户一天碰不到上限。
 *
 * 重点断言：
 *   · 档位：前 3 单 +2 / 第 4~6 单 +1 / 第 7 单起 +0
 *   · **时间币始终照常结算**（平台没有权力没收用户的币）
 *   · 超过 24 小时的记录**不计入**次数
 *   · 封顶时写的那条说明流水**不能被计入次数**（否则一旦封顶就永远拿不到分）
 *   · 上限是**按人**算的，不是按订单
 * ==================================================================
 */
module.exports = async function (t) {
  const logs = () => (t.store().credit_logs || [])

  /** 造 n 条「已完成订单」的信用分流水（默认算作 1 小时前） */
  const pump = (openid, n, hoursAgo) => {
    t.store().credit_logs = t.store().credit_logs || []
    for (let i = 0; i < n; i++) {
      t.store().credit_logs.push({
        _id: 'cl_' + openid + '_' + i + '_' + (hoursAgo || 1),
        _openid: openid, change: 2, score: 100,
        reason: 'order_finish', reasonText: '订单顺利完成', orderId: '',
        createTime: Date.now() - (hoursAgo || 1) * 3600 * 1000
      })
    }
  }

  /** 完整走完一单：下单 → 接单 → 标记完成 → 买家确认（触发结算） */
  const runOrder = async () => {
    let r = await t.call('order', 'o_buy', 'create', { skillId: 'sk1' })
    t.eq(r.code, 0, '（前置）下单成功')
    const id = r.data.orderId
    await t.call('order', 'o_sel', 'accept', { orderId: id })
    await t.call('order', 'o_sel', 'finish', { orderId: id })
    r = await t.call('order', 'o_buy', 'confirm', { orderId: id })
    t.eq(r.code, 0, '（前置）确认完成成功')
    return id
  }

  /* ==================================================================
   * 组 1 · 前 3 单：全额 +2
   * ================================================================== */
  t.group('组 1 · 前 3 单全额 +2')

  t.seed()
  pump('o_buy', 2)                        // 已 2 单 → 本单是第 3 单
  let before = t.user('o_buy').creditScore
  await runOrder()
  t.eq(t.user('o_buy').creditScore, before + 2, '★ 第 3 单仍然是全额 +2')
  t.eq(t.user('o_sel').creditScore, 110 + 2, '★ 卖家没刷过单，照常 +2（上限是**按人**算的）')

  /* ==================================================================
   * 组 2 · 第 4~6 单：减半 +1
   * ================================================================== */
  t.group('组 2 · 第 4~6 单减半 +1')

  t.seed()
  pump('o_buy', 3)                        // 已 3 单 → 本单是第 4 单
  before = t.user('o_buy').creditScore
  await runOrder()
  t.eq(t.user('o_buy').creditScore, before + 1, '★ 第 4 单只有 +1（减半，向上取整不为 0）')
  t.eq(t.user('o_sel').creditScore, 110 + 2, '卖家仍然全额')

  t.seed()
  pump('o_buy', 5)                        // 已 5 单 → 第 6 单仍在减半档
  before = t.user('o_buy').creditScore
  await runOrder()
  t.eq(t.user('o_buy').creditScore, before + 1, '第 6 单还是 +1（档位边界）')

  /* ==================================================================
   * 组 3 · 第 7 单起：不计分 + 说明流水
   * ================================================================== */
  t.group('组 3 · 第 7 单起不计分，但写一条说明流水')

  t.seed()
  pump('o_buy', 6)                        // 已 6 单 → 第 7 单不给分
  before = t.user('o_buy').creditScore
  const orderId = await runOrder()
  t.eq(t.user('o_buy').creditScore, before, '★★ 第 7 单不再加信用分')

  const capped = logs().filter(x => x.reason === 'order_finish_capped')
  t.eq(capped.length, 1, '★ 写了一条**说明性流水**（change=0）—— 不静默跳过')
  t.eq(capped[0].change, 0, '说明流水的 change 是 0')
  t.ok(/今日上限/.test(capped[0].reasonText), '★ 文案说明了原因，用户查明细能看懂', capped[0].reasonText)

  /* ---- ★ 这条最关键：说明流水不能被计入次数 ---- */
  // ★ 必须按人过滤：这一单卖家也会写一条 order_finish，不按人过滤就会数成 7
  t.eq(logs().filter(x => x._openid === 'o_buy' && x.reason === 'order_finish').length, 6,
    '★★ 说明流水用的是 order_finish_capped，**不会把自己算进次数** —— 否则计数只增不减，一且封顶就永远拿不到分')

  /* ==================================================================
   * 组 4 · ★ 时间币不受影响（平台没权力没收用户的币）
   * ================================================================== */
  t.group('组 4 · ★ 时间是信用分，时间币始终照常结算')

  t.seed()
  pump('o_buy', 10)                       // 远超上限
  const buyBefore = t.user('o_buy').coins
  const sellBefore = t.user('o_sel').coins
  const frozenBefore = t.user('o_buy').frozenCoins
  await runOrder()

  t.eq(t.user('o_buy').coins, buyBefore - 3, '★★ 买家照常扣 3 枚（信用分封顶**不影响钱**）')
  t.eq(t.user('o_sel').coins, sellBefore + 3, '★★ 卖家照常收到 3 枚')
  t.eq(t.user('o_buy').coins + t.user('o_buy').frozenCoins,
    buyBefore - 3 + frozenBefore, '★ 时间币总额仍然守恒')
  t.eq(t.store().wallet_logs.filter(x => x.type === 'income' && x._openid === 'o_sel').length > 0, true,
    '钱包流水照常写入')

  /* ==================================================================
   * 组 5 · 超过 24 小时的记录不计入
   * ================================================================== */
  t.group('组 5 · 滚动 24 小时：更早的记录不算数')

  t.seed()
  pump('o_buy', 6, 25)                    // 6 条，但都是 25 小时前 → 已过期
  before = t.user('o_buy').creditScore
  await runOrder()
  t.eq(t.user('o_buy').creditScore, before + 2,
    '★★ 25 小时前的记录**不计入** —— 否则用户一旦刷满就永久受限')

  /* ==================================================================
   * 组 6 · 连续奖励也受上限约束
   * ================================================================== */
  t.group('组 6 · 连续 5 单奖励也受同一档位约束')

  t.seed()
  pump('o_sel', 10)                       // 卖家已超上限
  t.user('o_sel').stats.ontimeStreak = 4  // 本单完成正好到 5 → 触发连续奖励
  before = t.user('o_sel').creditScore
  await runOrder()
  t.eq(t.user('o_sel').creditScore, before,
    '★★ 超上限时，连续 5 单的 +3 也拿不到 —— 否则刷子可以靠「每 5 单 +3」持续拿分')
  t.eq(logs().filter(x => x.reason === 'ontime_streak').length, 0, '没有写连续奖励流水')
}
