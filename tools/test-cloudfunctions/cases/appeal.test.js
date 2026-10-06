/**
 * 申诉（最小闭环）：信用分被扣 / 技能被下架
 * ==================================================================
 * 这个功能补上的是平台的**双向性**：在此之前只有举报（指控别人），
 * 没有申辩渠道 —— 被扣分、被下架的人只收到一条通知。
 *
 * 重点断言：
 *   · 撤销是**写反向记录**，不是删原记录（账本只增不改，才可追溯）
 *   · 三道约束：只能申诉自己的 / 只能申诉扣分记录 / 7 天窗口期
 *   · 幂等：重复处理不重复加回分数
 * ==================================================================
 */
module.exports = async function (t) {
  const appeals = () => (t.store().appeals || [])
  const creditLogs = () => (t.store().credit_logs || [])
  const notices = () => (t.store().notices || [])

  /** 造一条「被扣 10 分」的信用分流水（o_buy 的） */
  const mkDeductLog = (daysAgo) => {
    t.store().credit_logs = t.store().credit_logs || []
    const log = {
      _id: 'cl_deduct', _openid: 'o_buy', change: -10, score: 100,
      reason: 'report_valid', reasonText: '举报核实成立',
      orderId: '', createTime: Date.now() - (daysAgo || 0) * 86400000
    }
    t.store().credit_logs.push(log)
    return log
  }

  /* ==================================================================
   * 组 1 · 提交申诉：三道约束
   * ================================================================== */
  t.group('组 1 · 提交申诉：只能自己的 / 只能扣分记录 / 7 天窗口期')

  t.seed()
  t.fake.__secReset()
  mkDeductLog(1)

  let r = await t.call('user', 'o_buy', 'appealCreate', {
    type: 'credit', targetId: 'cl_deduct', reason: '那次举报是误会，服务确实完成了'
  })
  t.eq(r.code, 0, '★ 正常提交申诉成功')
  t.ok(r.data && r.data.id, '返回申诉 id')
  t.eq(appeals().length, 1, '申诉落库')
  const apId = r.data.id
  t.eq(appeals()[0].status, 0, '初始状态为待处理')
  t.eq(appeals()[0].restore.scoreChange, 10, '★★ 恢复量在**提交时**固化（处理时原记录可能已变）')

  // 重复申诉
  r = await t.call('user', 'o_buy', 'appealCreate', {
    type: 'credit', targetId: 'cl_deduct', reason: '再申诉一次'
  })
  t.eq(r.code, 409, '★ 同一处置已有待处理申诉 → 409')

  // 别人的记录
  t.seed()
  t.fake.__secReset()
  mkDeductLog(1)
  r = await t.call('user', 'o_sel', 'appealCreate', {
    type: 'credit', targetId: 'cl_deduct', reason: '不是我的'
  })
  t.eq(r.code, 403, '★ 只能申诉自己的处置 → 403')

  // 加分记录不可申诉
  t.seed()
  t.fake.__secReset()
  t.store().credit_logs = t.store().credit_logs || []
  t.store().credit_logs.push({
    _id: 'cl_plus', _openid: 'o_buy', change: 2, score: 102,
    reason: 'order_done', reasonText: '订单完成', orderId: '', createTime: Date.now()
  })
  r = await t.call('user', 'o_buy', 'appealCreate', {
    type: 'credit', targetId: 'cl_plus', reason: '加分也想申诉'
  })
  t.eq(r.code, 400, '★ 只有**被扣分**的记录能申诉 → 400')

  // 窗口期
  t.seed()
  t.fake.__secReset()
  mkDeductLog(8)
  r = await t.call('user', 'o_buy', 'appealCreate', {
    type: 'credit', targetId: 'cl_deduct', reason: '过了八天才想起来'
  })
  t.eq(r.code, 409, '★ 超过 7 天窗口期 → 409（否则管理端会被历史申诉淹没）')
  t.ok(/7 天/.test(r.msg), '文案说明窗口期', r.msg)

  // 内容安全
  t.seed()
  t.fake.__secReset()
  mkDeductLog(1)
  t.fake.__secRisky(['违禁词'])
  r = await t.call('user', 'o_buy', 'appealCreate', {
    type: 'credit', targetId: 'cl_deduct', reason: '附带违禁词'
  })
  t.eq(r.code, 400, '★ 申诉理由也过内容安全')
  t.ok(/申诉理由/.test(r.msg), '文案指明是「申诉理由」', r.msg)
  t.eq(appeals().length, 0, '被拦下时未落库')
  t.fake.__secReset()

  /* ==================================================================
   * 组 2 · 申诉成立 → 信用分加回（写反向流水，不删原记录）
   * ================================================================== */
  t.group('组 2 · 成立：信用分加回 10 分')

  t.seed()
  t.fake.__secReset()
  t.user('o_buy').creditScore = 90        // 被扣到 90
  mkDeductLog(1)
  const logsBefore = creditLogs().length

  r = await t.call('user', 'o_buy', 'appealCreate', { type: 'credit', targetId: 'cl_deduct', reason: '误会' })
  const id2 = r.data.id

  r = await t.call('admin', 'o_adm', 'handleAppeal', { id: id2, result: 1, remark: '核实确为误会' })
  t.eq(r.code, 0, '处理成功')
  t.eq(r.data.undo.handled, true, '★ 出参说明确实撤销了')
  t.eq(r.data.undo.kind, 'credit', '撤销类型是 credit')

  t.eq(t.user('o_buy').creditScore, 100, '★★ 信用分从 90 加回 100')
  t.eq(creditLogs().length, logsBefore + 1, '★★ **新增**一条流水，而不是删掉原来那条')
  const backLog = creditLogs()[creditLogs().length - 1]
  t.eq(backLog.change, 10, '★ 反向流水的 change 是 +10')
  t.eq(backLog.reason, 'appeal_ok', '★ reason 标记为 appeal_ok（可追溯）')
  t.eq(creditLogs().filter(x => x._id === 'cl_deduct').length, 1, '★★ 原来那条扣分记录**仍然在** —— 账本只增不改')

  t.eq(appeals().find(x => x._id === id2).status, 1, '申诉单置为已成立')
  t.eq(appeals().find(x => x._id === id2).undo, 'credit', '申诉单留痕 undo 字段')
  t.ok(notices().some(n => n.title === '申诉已成立'), '申诉人收到成立通知')

  /* ---- 幂等 ---- */
  const scoreNow = t.user('o_buy').creditScore
  const logsNow = creditLogs().length
  r = await t.call('admin', 'o_adm', 'handleAppeal', { id: id2, result: 1 })
  t.eq(r.code, 0, '重复处理返回 ok（幂等）')
  t.eq(t.user('o_buy').creditScore, scoreNow, '★★ 重复处理**不再加一次分**')
  t.eq(creditLogs().length, logsNow, '也不再多写流水')

  /* ==================================================================
   * 组 3 · 申诉成立 → 技能恢复上架
   * ================================================================== */
  t.group('组 3 · 成立：被违规下架的技能恢复上架')

  t.seed()
  t.fake.__secReset()
  const sk = t.store().skills.find(x => x._id === 'sk1')
  sk.status = 3
  sk.auditRemark = '涉嫌引流'
  sk.updateTime = Date.now()

  r = await t.call('user', 'o_sel', 'appealCreate', {
    type: 'skill', targetId: 'sk1', reason: '我的技能是正常教学，没有引流'
  })
  t.eq(r.code, 0, '技能所有者提交申诉成功')
  const id3 = r.data.id

  r = await t.call('admin', 'o_adm', 'handleAppeal', { id: id3, result: 1, remark: '复核后确认正常' })
  t.eq(r.data.undo.kind, 'skill', '撤销类型是 skill')
  t.eq(t.store().skills.find(x => x._id === 'sk1').status, 1, '★★ 技能已恢复上架')
  t.eq(t.store().skills.find(x => x._id === 'sk1').auditRemark, '涉嫌引流',
    '★ 原下架原因保留 —— 它是历史的一部分，不抹掉')
  t.ok(notices().some(n => n.title === '技能已恢复上架' && n._openid === 'o_sel'), '作者收到恢复通知')

  /* ==================================================================
   * 组 4 · 驳回不动任何东西
   * ================================================================== */
  t.group('组 4 · 驳回：不做任何撤销')

  t.seed()
  t.fake.__secReset()
  t.user('o_buy').creditScore = 90
  mkDeductLog(1)
  r = await t.call('user', 'o_buy', 'appealCreate', { type: 'credit', targetId: 'cl_deduct', reason: '我不服' })
  r = await t.call('admin', 'o_adm', 'handleAppeal', { id: r.data.id, result: 2, remark: '证据不足' })
  t.eq(r.code, 0, '驳回成功')
  t.eq(r.data.undo.handled, false, '★ 驳回时 undo.handled = false')
  t.eq(t.user('o_buy').creditScore, 90, '★★ 信用分**没有**被加回')
  t.ok(notices().some(n => n.title === '申诉未成立'), '收到驳回通知')

  /* ---- 参数校验 ---- */
  r = await t.call('admin', 'o_adm', 'handleAppeal', { id: 'nope', result: 1 })
  t.eq(r.code, 404, '不存在的申诉 → 404')

  t.seed()
  t.fake.__secReset()
  mkDeductLog(1)
  r = await t.call('user', 'o_buy', 'appealCreate', { type: 'credit', targetId: 'cl_deduct', reason: 'x' })
  const id5 = r.data.id
  r = await t.call('admin', 'o_adm', 'handleAppeal', { id: id5, result: 3 })
  t.eq(r.code, 400, '★ result 只能是 1/2，非法值报 400（不静默当驳回）', r.msg)

  t.fake.__secReset()
}
