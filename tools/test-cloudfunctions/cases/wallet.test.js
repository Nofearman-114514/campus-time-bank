/**
 * 案例组 11-13：wallet.info / wallet.logs / wallet.stats
 */
module.exports = async function (t) {
  /** 造一份跨 7 天的时间币流水夹具 */
  function seedWallet () {
    t.seed()
    const s = t.store()
    s.users[0].coins = 10
    s.users[0].frozenCoins = 0
    s.users[0].totalEarned = 12
    s.users[0].totalSpent = 14
    s.wallet_logs = [
      { _id: 'w1', _openid: 'o_buy', type: 'income', amount: 3, balance: 10, frozen: 0, orderId: '', orderNo: '', remark: '', createTime: new Date() },
      { _id: 'w2', _openid: 'o_buy', type: 'expense', amount: -2, balance: 8, frozen: 0, orderId: '', orderNo: '', remark: '', createTime: new Date() },
      { _id: 'w3', _openid: 'o_buy', type: 'freeze', amount: -3, balance: 5, frozen: 3, orderId: '', orderNo: '', remark: '', createTime: new Date() },
      { _id: 'w4', _openid: 'o_buy', type: 'unfreeze', amount: 3, balance: 8, frozen: 0, orderId: '', orderNo: '', remark: '', createTime: new Date() },
      { _id: 'w5', _openid: 'o_buy', type: 'bonus', amount: 5, balance: 5, frozen: 0, orderId: '', orderNo: '', remark: '', createTime: t.D(24 * 10) },
      { _id: 'w6', _openid: 'o_sel', type: 'income', amount: 9, balance: 9, frozen: 0, orderId: '', orderNo: '', remark: '', createTime: new Date() }
    ]
    s.orders = [
      { _id: 'of1', _openid: 'o_buy', buyerId: 'o_buy', status: 'finished', amount: 3, skillSnapshot: { categoryName: '技能教学' }, createTime: t.D(30) },
      { _id: 'of2', _openid: 'o_buy', buyerId: 'o_buy', status: 'finished', amount: 2, skillSnapshot: { categoryName: '学业辅导' }, createTime: t.D(40) },
      { _id: 'of3', _openid: 'o_buy', buyerId: 'o_buy', status: 'finished', amount: 3, skillSnapshot: { categoryName: '技能教学' }, createTime: t.D(50) },
      { _id: 'of4', _openid: 'o_buy', buyerId: 'o_buy', status: 'waiting', amount: 4, skillSnapshot: { categoryName: '生活服务' }, createTime: t.D(1) }
    ]
  }

  /* ==================================================================
   * 组 11：wallet.info
   * ================================================================== */
  t.group('组 11 · wallet.info：三种余额口径 + 近 7 天收支')

  seedWallet()
  let r = await t.call('wallet', 'o_buy', 'info', {})
  t.eq(r.code, 0, 'wallet.info 调用成功')
  t.eq(r.data.coins, 10, 'coins 可用余额')
  t.eq(r.data.frozenCoins, 0, 'frozenCoins 冻结额')
  t.eq(r.data.totalEarned, 12, 'totalEarned 来自 users 文档')
  t.eq(r.data.totalSpent, 14, 'totalSpent 来自 users 文档')
  t.eq(r.data.income7d, 6, 'income7d = income 3 + unfreeze 3（freeze 只是锁定，不算收入）')
  t.eq(r.data.expense7d, 2, 'expense7d = 2')
  t.eq(Object.keys(r.data).sort().join(','), 'coins,expense7d,frozenCoins,income7d,totalEarned,totalSpent', 'info 返回 6 个字段，与契约一致')

  t.eq(t.logs('o_buy').filter(l => ['income', 'bonus', 'unfreeze', 'refund'].indexOf(l.type) > -1).reduce((n, l) => n + l.amount, 0), 11, '全部收入类流水合计 11（含 10 天前的 bonus 5）')
  t.eq(r.data.income7d, 6, '★ 近 7 天只算窗口内的 6，10 天前的 bonus 被排除（按 createTime 范围过滤）')

  /* ==================================================================
   * 组 12：wallet.logs
   * ================================================================== */
  t.group('组 12 · wallet.logs：分页、类型过滤、按时间倒序、只看自己')

  seedWallet()
  let l = await t.call('wallet', 'o_buy', 'logs', { page: 1, size: 2, type: 'all' })
  t.eq(l.code, 0, 'wallet.logs 调用成功')
  t.eq(l.data.total, 5, '只统计本人流水（卖家那条不计入）')
  t.eq(l.data.list.length, 2, '分页 size=2 生效')
  t.eq(l.data.hasMore, true, 'hasMore=true')
  t.ok(new Date(l.data.list[0].createTime) >= new Date(l.data.list[1].createTime), '按 createTime 倒序返回')
  l = await t.call('wallet', 'o_buy', 'logs', { page: 2, size: 2 })
  t.eq(l.data.list.length, 2, '第二页返回 2 条')
  t.eq(l.data.hasMore, true, '第二页仍有更多')
  l = await t.call('wallet', 'o_buy', 'logs', { page: 3, size: 2 })
  t.eq(l.data.list.length, 1, '第三页返回 1 条')
  t.eq(l.data.hasMore, false, '最后一页 hasMore=false')

  t.eq((await t.call('wallet', 'o_buy', 'logs', { type: 'all' })).data.total, 5, 'type=all 返回全部 5 条')
  t.eq((await t.call('wallet', 'o_buy', 'logs', { type: 'income' })).data.total, 3, 'type=income 匹配 income/bonus/unfreeze/refund')
  t.eq((await t.call('wallet', 'o_buy', 'logs', { type: 'expense' })).data.total, 1, 'type=expense 匹配 expense/settle')
  t.eq((await t.call('wallet', 'o_buy', 'logs', { type: 'freeze' })).data.total, 1, 'type=freeze 精确匹配 freeze')
  const inc = await t.call('wallet', 'o_buy', 'logs', { type: 'income' })
  t.ok(inc.data.list.every(x => ['income', 'bonus', 'unfreeze', 'refund'].indexOf(x.type) > -1), 'income 分类里的每条流水类型都合法')
  t.eq((await t.call('wallet', 'o_sel', 'logs', { type: 'all' })).data.total, 1, '卖家只看到自己的 1 条')

  /* ==================================================================
   * 组 13：wallet.stats
   * ================================================================== */
  t.group('组 13 · wallet.stats：近 7 天趋势（内存按天分组）+ 支出分类分布')

  seedWallet()
  let st = await t.call('wallet', 'o_buy', 'stats', {})
  t.eq(st.code, 0, 'wallet.stats 调用成功')
  t.eq(st.data.trend.length, 7, 'trend 固定 7 个数据点（lastNDays(7) 骨架）')
  t.ok(/^\d{1,2}\/\d{1,2}$/.test(st.data.trend[0].date), "trend[].date 形如 '6/14'（与 mock 一致）", st.data.trend[0].date)
  t.eq(st.data.trend[6].income, 6, '今天 income = 3 + 3 = 6')
  t.eq(st.data.trend[6].expense, 2, '今天 expense = 2')
  t.eq(st.data.trend[0].income, 0, '7 天前无流水 → 0（骨架补零，不是缺项）')
  t.eq(st.data.trend[0].expense, 0, '7 天前 expense → 0')
  t.eq(st.data.trend.reduce((n, d) => n + d.income, 0), 6, '7 天收入合计 = 6')
  t.eq(st.data.trend.reduce((n, d) => n + d.expense, 0), 2, '7 天支出合计 = 2')
  t.eq(st.data.trend[6].income - st.data.trend[1].income, 6, '窗口内但当日无流水的日期补 0（不是缺项）')
  t.eq(st.data.trend[1].income + st.data.trend[5].income, 0, '第 2~6 天（今天之外）均无流水 → 0')

  t.eq(st.data.byCategory.length, 2, 'byCategory 只有 2 个分类（waiting 单不计入）')
  t.eq(st.data.byCategory[0].name, '技能教学', 'byCategory 按金额降序，第一项是技能教学')
  t.eq(st.data.byCategory[0].value, 6, '技能教学合计 3 + 3 = 6（同一分类合并）')
  t.eq(st.data.byCategory[1].name, '学业辅导', '第二项是学业辅导')
  t.eq(st.data.byCategory[1].value, 2, '学业辅导合计 2')
  t.eq(st.data.byCategory.reduce((n, c) => n + c.value, 0), 8, '分类合计 = 已完成订单支出总额 8')

  t.eq((await t.call('wallet', 'o_ghost', 'info', {})).code, 401, '未注册用户 → 401')
  t.eq((await t.call('wallet', 'o_buy', 'nope')).code, 400, '未知 action → 400')
}
