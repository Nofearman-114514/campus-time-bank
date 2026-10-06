/**
 * 举报：内容安全 + 核实成立时自动处置内容
 * ==================================================================
 * 两块都是补的缺口：
 *   ① 举报理由/补充说明没过内容安全 —— 而举报是「直接送到管理员眼前」的
 *      通道，比普通内容更不该不过滤
 *   ② 核实成立只扣分、**内容还在** —— 举报人刷新一下广场被举报的技能照样挂着，
 *      管理员还得再手动下架一遍。「处理完 ≠ 内容消失」
 * ==================================================================
 */
module.exports = async function (t) {
  const reports = () => (t.store().reports || [])
  const notices = () => (t.store().notices || [])

  /* ==================================================================
   * 组 1 · 举报理由与补充说明过内容安全
   * ================================================================== */
  t.group('组 1 · 举报理由 / 补充说明过内容安全')

  t.seed()
  t.fake.__secReset()
  t.fake.__secRisky(['违禁词'])

  let r = await t.call('skill', 'o_buy', 'report', {
    targetType: 'skill', targetId: 'sk1', reason: '违禁词', remark: ''
  })
  t.eq(r.code, 400, '★ 举报原因含违规内容 → 400')
  t.ok(/举报原因/.test(r.msg), '★ 文案指明是「举报原因」而不是笼统的「内容」', r.msg)
  t.eq(reports().length, 0, '★ 被拦下的举报没有落库')

  r = await t.call('skill', 'o_buy', 'report', {
    targetType: 'skill', targetId: 'sk1', reason: '虚假信息 / 与描述不符', remark: '附带违禁词'
  })
  t.eq(r.code, 400, '★ 补充说明含违规内容 → 400')
  t.ok(/补充说明/.test(r.msg), '文案指明是「补充说明」', r.msg)
  t.eq(reports().length, 0, '补充说明违规时也没落库')

  t.fake.__secReset()
  r = await t.call('skill', 'o_buy', 'report', {
    targetType: 'skill', targetId: 'sk1', reason: '虚假信息 / 与描述不符'
  })
  t.eq(r.code, 0, '★ 正常举报照常提交')
  t.eq(reports().length, 1, '正常举报落库')
  const reportId = r.data.id

  /* ==================================================================
   * 组 2 · 核实成立 → 技能自动下架（处理闭环）
   * ================================================================== */
  t.group('组 2 · 核实成立：技能自动下架 + 通知作者')

  t.eq(t.store().skills.find(s => s._id === 'sk1').status, 1, '下架前技能是上架状态')

  r = await t.call('admin', 'o_adm', 'handleReport', { id: reportId, result: 1, remark: '内容与描述不符' })
  t.eq(r.code, 0, '核实成立处理成功')
  t.ok(r.data && r.data.takeDown, '★ 出参带 takeDown，管理端能看到做了什么')
  t.eq(r.data.takeDown.handled, true, '★ takeDown.handled = true（确实处置了）')
  t.eq(r.data.takeDown.kind, 'skill', '处置类型是 skill')

  const sk = t.store().skills.find(s => s._id === 'sk1')
  t.eq(sk.status, 3, '★★ 技能被自动下架（status=3，与 admin.auditSkill 同一语义）')
  t.eq(sk.auditRemark, '内容与描述不符', '★ 下架原因被记录')
  t.ok(notices().some(n => n.title === '技能已被下架' && n._openid === sk.authorId),
    '★★ 作者收到下架通知 —— 否则他不知情')

  t.eq(t.user('o_sel').creditScore < 110, true, '被举报人信用分被扣（原有行为保留）')
  t.eq(reports().find(x => x._id === reportId).status, 1, '举报单状态置为已处理')
  t.eq(reports().find(x => x._id === reportId).takeDown, 'skill', '★ 举报单上留痕「处置了 skill」')

  /* ---- 幂等：重复处理不应重复动作 ---- */
  const noticeCount = notices().length
  r = await t.call('admin', 'o_adm', 'handleReport', { id: reportId, result: 1 })
  t.eq(r.code, 0, '重复处理返回 ok（幂等）')
  t.eq(notices().length, noticeCount, '★ 重复处理不再发通知')

  /* ==================================================================
   * 组 3 · 驳回不动内容
   * ================================================================== */
  t.group('组 3 · 驳回：不处置内容')

  t.seed()
  t.fake.__secReset()
  r = await t.call('skill', 'o_buy', 'report', {
    targetType: 'skill', targetId: 'sk1', reason: '其他违规行为'
  })
  const rid2 = r.data.id
  r = await t.call('admin', 'o_adm', 'handleReport', { id: rid2, result: 2, remark: '证据不足' })
  t.eq(r.code, 0, '驳回处理成功')
  t.eq(r.data.takeDown.handled, false, '★ 驳回时 takeDown.handled = false')
  t.eq(t.store().skills.find(s => s._id === 'sk1').status, 1, '★★ 技能仍然是上架状态（驳回不该下架内容）')

  /* ==================================================================
   * 组 4 · 评价类举报 → 隐藏
   * ================================================================== */
  t.group('组 4 · 评价类举报：隐藏 + 列表过滤')

  t.seed()
  t.fake.__secReset()
  t.store().reviews = t.store().reviews || []
  t.store().reviews.push({
    _id: 'rv_bad', orderId: 'o1', skillId: 'sk1',
    fromId: 'o_weak', fromInfo: { nickName: '弱', avatarUrl: '' },
    toId: 'o_sel', toInfo: { nickName: '卖家', avatarUrl: '' },
    role: 'buyer', score: 1, tags: [], content: '辱骂内容', anonymous: false,
    reply: null, createTime: Date.now()
  })
  r = await t.call('skill', 'o_buy', 'report', {
    targetType: 'review', targetId: 'rv_bad', reason: '言语骚扰或人身攻击'
  })
  t.eq(r.code, 0, '举报评价成功')
  r = await t.call('admin', 'o_adm', 'handleReport', { id: r.data.id, result: 1, remark: '骚扰成立' })
  t.eq(r.data.takeDown.kind, 'review', '处置类型是 review')
  t.eq(t.store().reviews.find(x => x._id === 'rv_bad').hidden, true, '★ 评价被标记 hidden')
  t.ok(notices().some(n => n.title === '评价已被隐藏' && n._openid === 'o_weak'), '评价作者收到隐藏通知')

  /* ==================================================================
   * 组 5 · 用户类举报不自动处置
   * ================================================================== */
  t.group('组 5 · 用户类举报：不自动封禁（只扣分）')

  t.seed()
  t.fake.__secReset()
  t.store().reviews = t.store().reviews || []
  r = await t.call('skill', 'o_buy', 'report', {
    targetType: 'user', targetId: 'o_sel', reason: '涉嫌诈骗或诱导线下付款'
  })
  t.eq(r.code, 0, '举报用户成功')
  r = await t.call('admin', 'o_adm', 'handleReport', { id: r.data.id, result: 1, remark: '诈骗成立' })
  t.eq(r.code, 0, '处理成功')
  t.eq(r.data.takeDown.handled, false, '★ 用户类**不做自动处置**')
  t.ok(/留给管理员/.test(r.data.takeDown.note), '★ 给出说明：封禁比扣分重，交管理员判断', r.data.takeDown.note)
  t.eq(t.user('o_sel').status, 1, '★★ 账号没有被自动封禁')
  t.eq(t.user('o_sel').creditScore < 110, true, '但信用分照扣')

  t.fake.__secReset()
}
