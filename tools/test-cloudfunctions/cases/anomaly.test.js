/**
 * 异常增长监控（风控）
 * ==================================================================
 * 核心判据不是「排名上升」（卖一个高价技能也会暴涨），而是**增长的结构**：
 *   收入来自多个买家 = 正常；来自少数买家且高度集中 = 可疑
 *
 * 重点断言：
 *   · ★ **分散来源不误报** —— 这是整个设计的意义所在
 *   · 集中来源命中，且给出的是**证据**（signals）而不是判决
 *   · 样本太少不报（2 单就能凑出 100% 集中度）
 *   · 可疑快单（第 2 条防线的标记）能被直接读出来用
 * ==================================================================
 */
module.exports = async function (t) {
  /** 造一笔已完成的订单（默认 1 天前确认） */
  const mkOrder = (id, sellerId, buyerId, amount, opt) => {
    const o = Object.assign({
      _id: id, orderNo: 'TB_' + id, sellerId: sellerId, buyerId: buyerId,
      skillId: 'sk1', amount: amount, status: 'finished',
      createTime: Date.now() - 2 * 86400000,
      confirmTime: Date.now() - 1 * 86400000,
      skillSnapshot: { title: '技能' + id, duration: 60 }
    }, opt || {})
    t.store().orders.push(o)
    return o
  }

  /* ==================================================================
   * 组 1 · ★ 分散来源不误报（这是设计的核心）
   * ================================================================== */
  t.group('组 1 · ★ 收入来自多个买家 → 正常，不报')

  t.seed()
  mkOrder('m1', 'o_sel', 'o_buy', 3)
  mkOrder('m2', 'o_sel', 'o_weak', 3)
  mkOrder('m3', 'o_sel', 'o_adm', 3)

  let r = await t.call('admin', 'o_adm', 'anomalies', { days: 7 })
  t.eq(r.code, 0, '管理员可以调用')
  t.eq(r.data.scanned, 3, '扫描到 3 笔已完成订单')
  t.eq(r.data.list.filter(x => x.openid === 'o_sel').length, 0,
    '★★ 3 单来自 3 个不同买家 → **不报** —— 如果他服务了 3 个人却被报，这个功能就是废的')

  /* ==================================================================
   * 组 2 · ★ 集中来源命中，且给的是证据
   * ================================================================== */
  t.group('组 2 · ★ 收入集中来自少数买家 → 命中（只给证据）')

  t.seed()
  mkOrder('c1', 'o_sel', 'o_buy', 5)
  mkOrder('c2', 'o_sel', 'o_buy', 5)
  mkOrder('c3', 'o_sel', 'o_buy', 5)

  r = await t.call('admin', 'o_adm', 'anomalies', { days: 7 })
  const hit = r.data.list.filter(x => x.openid === 'o_sel')[0]
  t.ok(hit, '★★ 3 单全部来自同 1 个买家 → 命中')
  t.eq(hit.total, 15, '出参带收入总额')
  t.eq(hit.count, 3, '出参带单数')
  t.eq(hit.buyerCount, 1, '★★ 出参带**买家数** —— 管理员要看到「只有 1 个买家」这个事实')
  t.eq(hit.top2Ratio, 100, '出参带前 2 人占比')
  t.ok(Array.isArray(hit.signals) && hit.signals.length > 0, '★ 给的是**信号列表**（证据），不是判决')
  t.ok(/1 个买家/.test(hit.signals.join(' ')), '信号里写清了买家数', hit.signals.join(' | '))
  t.eq(hit.nickName, '卖家思远', '带上昵称，管理员要知道是谁')

  /* ==================================================================
   * 组 3 · 样本太少不报
   * ================================================================== */
  t.group('组 3 · 样本太少不报（2 单就能凑出 100% 集中度）')

  t.seed()
  mkOrder('s1', 'o_sel', 'o_buy', 5)
  mkOrder('s2', 'o_sel', 'o_buy', 5)

  r = await t.call('admin', 'o_adm', 'anomalies', { days: 7 })
  t.eq(r.data.list.length, 0, '★ 只有 2 单 → 不报（否则任何人只要有 1 个回头客就被标记）')

  /* ==================================================================
   * 组 4 · 可疑快单能被直接用上
   * ================================================================== */
  t.group('组 4 · 可疑快单（第 2 条防线的标记）能被读出来')

  t.seed()
  /* 3 个不同买家（来源分散，本不会命中），但其中 2 单被标记了可疑 */
  mkOrder('f1', 'o_sel', 'o_buy', 3, { suspectFast: true, suspectMinutes: 1 })
  mkOrder('f2', 'o_sel', 'o_weak', 3, { suspectFast: true, suspectMinutes: 2 })
  mkOrder('f3', 'o_sel', 'o_adm', 3)

  r = await t.call('admin', 'o_adm', 'anomalies', { days: 7 })
  const f = r.data.list.filter(x => x.openid === 'o_sel')[0]
  t.ok(f, '★ 虽然有 3 个买家（来源分散），但可疑快单让它命中')
  t.eq(f.suspect, 2, '出参带可疑快单数')
  t.ok(f.signals.join(' ').indexOf('完成过快') >= 0, '信号里说明有快单', f.signals.join(' | '))
  t.eq(f.top2Ratio <= 80, true, '（这条不是靠集中度命中的，而是靠快单）')

  /* ==================================================================
   * 组 5 · 时间窗口
   * ================================================================== */
  t.group('组 5 · 时间窗口：窗口外的单不算')

  t.seed()
  mkOrder('w1', 'o_sel', 'o_buy', 5, { confirmTime: Date.now() - 10 * 86400000 })
  mkOrder('w2', 'o_sel', 'o_buy', 5, { confirmTime: Date.now() - 10 * 86400000 })
  mkOrder('w3', 'o_sel', 'o_buy', 5, { confirmTime: Date.now() - 10 * 86400000 })

  r = await t.call('admin', 'o_adm', 'anomalies', { days: 7 })
  t.eq(r.data.list.length, 0, '★ 10 天前的单不在 7 天窗口内 → 不报')

  r = await t.call('admin', 'o_adm', 'anomalies', { days: 30 })
  t.eq(r.data.list.length, 1, '★ 换成 30 天窗口就能看到')

  /* ==================================================================
   * 组 6 · 权限
   * ================================================================== */
  t.group('组 6 · 只有管理员能看')

  t.seed()
  mkOrder('p1', 'o_sel', 'o_buy', 5)
  mkOrder('p2', 'o_sel', 'o_buy', 5)
  mkOrder('p3', 'o_sel', 'o_buy', 5)

  r = await t.call('admin', 'o_buy', 'anomalies', { days: 7 })
  t.eq(r.code, 403, '普通用户调用 → 403')
  t.eq(r.data, null, '没有返回任何数据')
}
