/**
 * 案例组 21-29：message 云函数（9 个 action）
 * 契约见 docs/ARCHITECTURE.md §4.6；数据结构 §3.8 chats / §3.9 messages / §3.10 notices
 *
 * 本文件重点覆盖五块真实风险：
 *   ① openChat：members 必须升序排列，保证同一对用户只会有一条会话（正反两个方向都验）。
 *   ② history：★ page=1 返回**最新**一页（内部按 createTime desc 分页后 reverse 成升序），
 *      hasMore 表示「还有更早的消息」—— 造 25 条消息验 page1/page2/末页。
 *   ③ send / history / read 的成员身份校验（非会话成员必须 403）。
 *   ④ send 的副作用：写 messages + 更新 chat 的 lastMsg / lastMsgType / lastTime / unread 计数。
 *   ⑤ unreadTotal 跨 100 条单次查询上限的累加（分页拉全量）。
 */
module.exports = async function (t) {
  /* ==================================================================
   * 夹具
   * ================================================================== */

  /** 重建库并塞入 3 条会话（c1/c2 属于 o_buy，c3 与 o_buy 无关） */
  function seedChats () {
    t.seed()
    const s = t.store()
    s.chats = [
      {
        _id: 'c1', members: ['o_buy', 'o_sel'],
        memberInfos: {
          o_buy: { nickName: '买家小明', avatarUrl: '', creditScore: 100 },
          o_sel: { nickName: '卖家思远', avatarUrl: '', creditScore: 110 }
        },
        orderId: '', orderNo: '', lastMsg: '', lastMsgType: 'text', lastTime: t.D(1),
        unread: { o_buy: 2, o_sel: 0 }, createTime: t.D(3), updateTime: t.D(1)
      },
      {
        _id: 'c2', members: ['o_buy', 'o_weak'], memberInfos: {},
        orderId: '', orderNo: '', lastMsg: '', lastMsgType: 'text', lastTime: t.D(5),
        unread: { o_buy: 1 }, createTime: t.D(6), updateTime: t.D(5)
      },
      {
        _id: 'c3', members: ['o_sel', 'o_weak'], memberInfos: {},
        orderId: '', orderNo: '', lastMsg: '', lastMsgType: 'text', lastTime: t.D(2),
        unread: { o_sel: 4, o_weak: 3 }, createTime: t.D(7), updateTime: t.D(2)
      }
    ]
    s.messages = []
    s.notices = []
    return s
  }

  /** 造 n 条 c1 里的消息：i=1 最旧、i=n 最新，内容 m01…mNN（便于断言精确顺序） */
  function seedHistory (n) {
    const s = seedChats()
    for (let i = 1; i <= n; i++) {
      const from = i % 2 === 1 ? 'o_buy' : 'o_sel'
      s.messages.push({
        _id: 'msg' + String(i).padStart(2, '0'),
        _openid: from, chatId: 'c1', fromId: from,
        toId: from === 'o_buy' ? 'o_sel' : 'o_buy',
        type: 'text', content: 'm' + String(i).padStart(2, '0'),
        read: false, createTime: new Date(Date.now() - (n - i) * 60000)
      })
    }
    return s
  }

  const chat = id => t.store().chats.find(c => c._id === id)
  const contents = list => list.map(m => m.content).join(',')

  /* ==================================================================
   * 组 21：conversations
   * ================================================================== */
  t.group('组 21 · message.conversations：只列我的会话、lastTime 倒序、补对方资料与未读数')

  seedChats()
  let r = await t.call('message', 'o_buy', 'conversations', {})
  t.eq(r.code, 0, 'conversations 调用成功')
  t.eq(r.data.total, 2, '★ 只统计我是成员的会话（c3 与我无关）')
  t.eq(r.data.list.length, 2, '返回 2 条')
  t.eq(r.data.list[0]._id, 'c1', '按 lastTime 倒序：最近说话的 c1 在前')
  t.eq(r.data.list[0].otherId, 'o_sel', '补 otherId（对方 openid）')
  t.eq(r.data.list[0].otherInfo.nickName, '卖家思远', 'otherInfo 取 memberInfos 快照')
  t.eq(r.data.list[0].unreadCount, 2, 'unreadCount 取 unread[我]')
  t.eq(r.data.list[1]._id, 'c2', '第二条是 c2')
  t.eq(r.data.list[1].otherId, 'o_weak', 'otherId 正确')
  t.eq(r.data.list[1].otherInfo.nickName, '路人同学', '★ memberInfos 缺失时回查 users 补资料')
  t.eq(r.data.list[1].unreadCount, 1, 'unreadCount=1')
  t.eq(r.data.hasMore, false, 'hasMore=false')

  r = await t.call('message', 'o_buy', 'conversations', { page: 1, size: 1 })
  t.eq(r.data.list.length, 1, 'size=1 生效')
  t.eq(r.data.hasMore, true, 'page1 hasMore=true')
  r = await t.call('message', 'o_buy', 'conversations', { page: 2, size: 1 })
  t.eq(r.data.list[0]._id, 'c2', 'page2 返回第二条')

  r = await t.call('message', 'o_sel', 'conversations', {})
  t.eq(r.data.total, 2, 'o_sel 也只看到自己的 2 条会话（c1 / c3）')
  t.eq(r.data.list[0]._id, 'c1', 'c1 对 o_sel 同样可见')
  t.eq(r.data.list[0].unreadCount, 0, 'o_sel 在 c1 的未读为 0')
  t.eq((await t.call('message', 'o_ghost', 'conversations', {})).code, 401, '未注册 → 401')

  /* ==================================================================
   * 组 22：openChat
   * ================================================================== */
  t.group('组 22 · ★ message.openChat：members 升序保证唯一，重复调用返回同一个 chatId')

  t.seed()
  t.store().chats = []

  r = await t.call('message', 'o_sel', 'openChat', { toId: 'o_buy' })
  t.eq(r.code, 0, '由字典序较大的一方 o_sel 发起会话成功')
  const chatId = r.data.chatId
  t.ok(!!chatId, '返回 chatId')
  t.eq(t.store().chats.length, 1, '新建 1 条会话')
  t.eq(Object.keys(r.data).sort().join(','), 'chatId', 'openChat 只返回 chatId')
  t.eq(chat(chatId).members.join(','), 'o_buy,o_sel', '★★ members 升序排列（与谁发起无关）')
  t.eq(chat(chatId).memberInfos.o_sel.nickName, '卖家思远', 'memberInfos 写入发起方快照')
  t.eq(chat(chatId).memberInfos.o_buy.creditScore, 100, 'memberInfos 写入对方快照')
  t.eq(chat(chatId).orderId, '', '未传 orderId → 空字符串')
  t.eq(chat(chatId).lastMsg, '', '新会话 lastMsg 为空')
  t.eq(chat(chatId).lastMsgType, 'text', "lastMsgType 默认 'text'")
  t.eq(JSON.stringify(chat(chatId).unread), '{}', '新会话 unread 为空对象')
  t.eq(Object.keys(chat(chatId)).sort().join(','), '_id,createTime,lastMsg,lastMsgType,lastTime,memberInfos,members,orderId,orderNo,unread,updateTime', '会话字段严格按 §3.8')

  r = await t.call('message', 'o_buy', 'openChat', { toId: 'o_sel' })
  t.eq(r.data.chatId, chatId, '★★ 反方向调用返回同一个 chatId（不会产生第二条会话）')
  t.eq(t.store().chats.length, 1, '★ 会话总数仍为 1')

  const r2 = await t.call('message', 'o_buy', 'openChat', { toId: 'o_weak' })
  t.ok(r2.data.chatId !== chatId, '另一对用户得到不同会话')
  t.eq(t.store().chats.length, 2, '会话数 2')

  t.eq((await t.call('message', 'o_buy', 'openChat', {})).code, 400, '缺 toId → 400')
  t.eq((await t.call('message', 'o_buy', 'openChat', { toId: 123 })).code, 400, 'toId 非字符串 → 400')
  t.eq((await t.call('message', 'o_buy', 'openChat', { toId: 'o_buy' })).code, 400, '不能和自己发起会话 → 400')
  t.eq((await t.call('message', 'o_buy', 'openChat', { toId: 'o_ghost' })).code, 404, '对方用户不存在 → 404')
  t.eq((await t.call('message', 'o_ghost', 'openChat', { toId: 'o_buy' })).code, 401, '未注册调用者 → 401')

  t.putOrder({ _id: 'oc1', orderNo: 'TB_ORD9' })
  r = await t.call('message', 'o_buy', 'openChat', { toId: 'o_weak', orderId: 'oc1' })
  t.eq(r.data.chatId, r2.data.chatId, '带 orderId 复用已有会话')
  t.eq(chat(r.data.chatId).orderId, 'oc1', '★ 已有会话会把关联订单补上')
  t.eq(chat(r.data.chatId).orderNo, 'TB_ORD9', 'orderNo 从订单回查写入')
  await t.call('message', 'o_buy', 'openChat', { toId: 'o_weak', orderId: 'nonono' })
  t.eq(chat(r2.data.chatId).orderId, 'oc1', '（已知行为）会话已有关联订单时不再覆盖，先到先得')

  r = await t.call('message', 'o_buy', 'openChat', { toId: 'o_sel', orderId: 'oc1' })
  t.eq(chat(r.data.chatId).orderNo, 'TB_ORD9', '新建会话直接带 orderId/orderNo')

  /* ==================================================================
   * 组 22b：★★ 并发 openChat —— 唯一性交给数据库主键
   * ------------------------------------------------------------------
   * 原实现是 check-then-act（先查 _.all(members)，再 add），中间没有唯一索引 /
   * 事务 / 条件写：双方同时点「发消息」会各建一条会话，其中一条成孤儿，
   * 同一对用户的两个聊天窗口内容不同步。
   * 现已改为**确定性 _id**（members 升序拼接）把唯一性交给主键：并发下第二个
   * add 会因主键冲突失败并回读同一条，物理上不可能出现第二条。
   * 本组断言「修复后的正确行为」：修复前这里是红的。
   * ================================================================== */
  t.group('组 22b · ★★ 并发 openChat：确定性 _id 保证同一对用户只有一条会话')

  t.seed()
  t.store().chats = []
  const cc = await Promise.all([
    t.call('message', 'o_buy', 'openChat', { toId: 'o_sel' }),
    t.call('message', 'o_sel', 'openChat', { toId: 'o_buy' })
  ])
  t.eq(cc.map(x => x.code).join(','), '0,0', '两个并发 openChat 都返回成功')
  t.eq(cc[0].data.chatId, cc[1].data.chatId, '★★ 两个并发请求拿到**同一个 chatId**（确定性 _id 生效）')
  t.eq(t.store().chats.length, 1, '★★ 同一对用户只产生 1 条会话（唯一性由主键保证，不靠 check-then-act）')
  t.eq(t.store().chats[0].members.join(','), 'o_buy,o_sel', 'members 仍按升序存储')

  // 并发之后双方发消息，必须都落在同一条会话里
  const cid = cc[0].data.chatId
  await t.call('message', 'o_buy', 'send', { chatId: cid, content: 'hi' })
  await t.call('message', 'o_sel', 'send', { chatId: cid, content: 'hello' })
  t.eq(t.store().chats.length, 1, '会话数仍为 1（没有孤儿会话产生）')
  t.ok(t.store().chats[0].lastMsg, '★★ 唯一的那条会话收到了消息 —— 不再有「永远收不到消息的孤儿会话」')

  const again = await t.call('message', 'o_sel', 'openChat', { toId: 'o_buy' })
  t.eq(again.data.chatId, cid, '之后任意方向再调用都复用同一条会话')
  t.eq(t.store().chats.length, 1, '会话总数始终为 1')

  /* ==================================================================
   * 组 23：history —— ★ 分页方向
   * ================================================================== */
  t.group('组 23 · ★ message.history：page=1 返回最新一页，页内升序，hasMore=还有更早的')

  seedHistory(25)
  t.store().messages.push({ _id: 'other1', _openid: 'o_weak', chatId: 'c3', fromId: 'o_weak', toId: 'o_sel', type: 'text', content: '别的会话', read: false, createTime: new Date() })

  let h = await t.call('message', 'o_buy', 'history', { chatId: 'c1', page: 1, size: 10 })
  t.eq(h.code, 0, 'history 调用成功')
  t.eq(Object.keys(h.data).sort().join(','), 'hasMore,list', 'history 只返回 list / hasMore')
  t.eq(h.data.list.length, 10, 'size=10 生效')
  t.eq(h.data.list[0].content, 'm16', '★ page1 的第 1 条是这一页里最早的那条（该页正序起点）')
  t.eq(h.data.list[9].content, 'm25', '★★ page1 最后一条是最新消息 m25 —— page=1 是「最新」一页')
  t.eq(contents(h.data.list), 'm16,m17,m18,m19,m20,m21,m22,m23,m24,m25', '★ page1 完整内容 16→25，页内升序')
  t.ok(new Date(h.data.list[0].createTime) < new Date(h.data.list[9].createTime), '页内按 createTime 升序（前端可直接顺序渲染）')
  t.eq(h.data.hasMore, true, '★ hasMore=true：还有更早的消息')

  h = await t.call('message', 'o_buy', 'history', { chatId: 'c1', page: 2, size: 10 })
  t.eq(contents(h.data.list), 'm06,m07,m08,m09,m10,m11,m12,m13,m14,m15', 'page2 是更早的一页 6→15')
  t.eq(h.data.hasMore, true, 'page2 仍有更早的')

  h = await t.call('message', 'o_buy', 'history', { chatId: 'c1', page: 3, size: 10 })
  t.eq(contents(h.data.list), 'm01,m02,m03,m04,m05', 'page3 只剩最早的 5 条')
  t.eq(h.data.hasMore, false, '★ 最后一页 hasMore=false（没有更早的了）')

  h = await t.call('message', 'o_buy', 'history', { chatId: 'c1' })
  t.eq(h.data.list.length, 20, '不传 size 时默认 20')
  t.eq(h.data.list[19].content, 'm25', '默认页同样以最新消息结尾')

  h = await t.call('message', 'o_buy', 'history', { chatId: 'c1', page: 1, size: 30 })
  t.eq(h.data.list.length, 25, 'size 大于总数时返回全部 25 条')
  t.eq(h.data.hasMore, false, '一页装下全部时 hasMore=false')

  t.eq((await t.call('message', 'o_weak', 'history', { chatId: 'c1' })).code, 403, '★ 非会话成员读历史 → 403')
  t.eq((await t.call('message', 'o_buy', 'history', { chatId: 'cX' })).code, 404, '会话不存在 → 404')
  t.eq((await t.call('message', 'o_buy', 'history', {})).code, 400, '缺 chatId → 400')
  t.eq((await t.call('message', 'o_ghost', 'history', { chatId: 'c1' })).code, 401, '未注册 → 401')

  /* ==================================================================
   * 组 24：send
   * ================================================================== */
  t.group('组 24 · message.send：写消息 + 更新会话摘要与未读，仅成员可发')

  seedChats()
  r = await t.call('message', 'o_buy', 'send', { chatId: 'c1', content: '你好呀' })
  t.eq(r.code, 0, '发送成功')
  t.eq(Object.keys(r.data).sort().join(','), 'createTime,msgId', 'send 返回 msgId / createTime')
  t.ok(!!r.data.msgId, '返回 msgId')
  t.eq(r.data.createTime instanceof Date, true, 'createTime 是 Date')

  let ms = t.store().messages
  t.eq(ms.length, 1, '写入 1 条消息')
  const m0 = ms[0]
  t.eq(Object.keys(m0).sort().join(','), '_id,_openid,chatId,content,createTime,fromId,read,toId,type', '★ 消息字段严格按 §3.9（含显式 _openid）')
  t.eq(m0._openid, 'o_buy', '★ _openid 显式写成发送者（messages 权限「仅创建者可写」依赖它）')
  t.eq(m0.fromId, 'o_buy', 'fromId = 发送者')
  t.eq(m0.toId, 'o_sel', '★ 不传 toId 时自动取会话里的另一方')
  t.eq(m0.chatId, 'c1', 'chatId 落库')
  t.eq(m0.type, 'text', "type 默认 'text'")
  t.eq(m0.content, '你好呀', 'content 落库')
  t.eq(m0.read, false, '新消息 read=false')

  let c1 = chat('c1')
  t.eq(c1.lastMsg, '你好呀', '★ 更新会话 lastMsg')
  t.eq(c1.lastMsgType, 'text', '★ 更新 lastMsgType')
  t.eq(c1.lastTime.getTime(), r.data.createTime.getTime(), '★ lastTime = 消息时间')
  t.eq(c1.unread.o_sel, 1, '★ 接收方未读 0 → 1')
  t.eq(c1.unread.o_buy, 2, '发送方自己的未读不受影响')

  r = await t.call('message', 'o_sel', 'send', { chatId: 'c1', content: '在的' })
  c1 = chat('c1')
  t.eq(t.store().messages[1].toId, 'o_buy', '反向发送时自动取另一方 o_buy')
  t.eq(c1.lastMsg, '在的', 'lastMsg 被最新消息覆盖')
  t.eq(c1.unread.o_buy, 3, '★ o_buy 未读 2 → 3（每次 +1）')
  t.eq(c1.unread.o_sel, 1, 'o_sel 的未读不被自己发送影响')

  await t.call('message', 'o_buy', 'send', { chatId: 'c1', type: 'image', content: 'cloud://chat/1.jpg' })
  c1 = chat('c1')
  t.eq(c1.lastMsg, '[图片]', "★ type='image' 时 lastMsg 固定为 '[图片]'")
  t.eq(c1.lastMsgType, 'image', 'lastMsgType=image')
  t.eq(t.store().messages[2].content, 'cloud://chat/1.jpg', '图片消息 content 存 fileID')

  r = await t.call('message', 'o_buy', 'send', { chatId: 'c1', toId: 'o_sel', content: '显式指定接收者' })
  t.eq(r.code, 0, '显式传合法 toId 成功')
  t.eq(t.store().messages[3].toId, 'o_sel', 'toId 透传')
  t.eq((await t.call('message', 'o_buy', 'send', { chatId: 'c1', toId: 'o_weak', content: 'x' })).code, 400, '★ toId 不是会话成员 → 400')

  t.eq((await t.call('message', 'o_buy', 'send', { chatId: 'c1', content: '' })).code, 400, '空内容 → 400')
  t.eq((await t.call('message', 'o_buy', 'send', { chatId: 'c1', content: '    ' })).code, 400, '全空白内容 → 400')
  t.eq((await t.call('message', 'o_buy', 'send', { chatId: 'c1' })).code, 400, '缺 content → 400')
  t.eq((await t.call('message', 'o_buy', 'send', { chatId: 'c1', content: 'x'.repeat(1001) })).code, 400, '★ 1001 字 → 400（拒绝而不是截断）')
  t.eq((await t.call('message', 'o_buy', 'send', { chatId: 'c1', content: 'x'.repeat(1000) })).code, 0, '恰好 1000 字通过')
  t.eq(t.store().messages[4].content.length, 1000, '1000 字完整落库')
  t.eq((await t.call('message', 'o_weak', 'send', { chatId: 'c1', content: '越权' })).code, 403, '★ 非会话成员发消息 → 403')
  t.eq((await t.call('message', 'o_buy', 'send', { chatId: 'cX', content: 'x' })).code, 404, '会话不存在 → 404')
  t.eq((await t.call('message', 'o_buy', 'send', { content: 'x' })).code, 400, '缺 chatId → 400')
  t.eq((await t.call('message', 'o_ghost', 'send', { chatId: 'c1', content: 'x' })).code, 401, '未注册 → 401')
  t.eq(t.store().messages.length, 5, '★ 所有失败分支都没有多写消息')

  await t.call('message', 'o_buy', 'send', { chatId: 'c1', content: '  两侧有空格  ' })
  t.eq(chat('c1').lastMsg, '两侧有空格', '★ 文本消息落库前 trim（修复前首尾空格会原样进 lastMsg）')

  const before24 = chat('c1').unread.o_buy
  r = await t.call('message', 'o_buy', 'send', { chatId: 'c1', toId: 'o_buy', content: '发给自己' })
  t.eq(r.code, 400, '★ 不能给自己发消息（修复前只校验「是会话成员」，会给自己 +1 未读）')
  t.eq(chat('c1').unread.o_buy, before24, '★ 自己的未读数没有被自己抬高')

  const badType = await t.call('message', 'o_buy', 'send', { chatId: 'c1', content: 'x', type: 'video' })
  t.eq(badType.code, 400, '★ 非法 type 被拒（§3.9 只定义了 text/image/system）')
  t.eq(t.store().messages[t.store().messages.length - 1].type !== 'video', true, '★ 非法 type 没有落库（修复前会原样写入）')

  /* ==================================================================
   * 组 25：read
   * ================================================================== */
  t.group('组 25 · message.read：只把我收到的消息置为已读，并清零我的未读数')

  const s25 = seedChats()
  s25.messages = [
    { _id: 'r1', _openid: 'o_sel', chatId: 'c1', fromId: 'o_sel', toId: 'o_buy', type: 'text', content: 'a', read: false, createTime: t.D(1) },
    { _id: 'r2', _openid: 'o_sel', chatId: 'c1', fromId: 'o_sel', toId: 'o_buy', type: 'text', content: 'b', read: false, createTime: t.D(2) },
    { _id: 'r3', _openid: 'o_sel', chatId: 'c1', fromId: 'o_sel', toId: 'o_buy', type: 'text', content: 'c', read: true, createTime: t.D(3) },
    { _id: 'r4', _openid: 'o_buy', chatId: 'c1', fromId: 'o_buy', toId: 'o_sel', type: 'text', content: 'd', read: false, createTime: t.D(1) },
    { _id: 'r5', _openid: 'o_weak', chatId: 'c2', fromId: 'o_weak', toId: 'o_buy', type: 'text', content: 'e', read: false, createTime: t.D(1) }
  ]
  chat('c1').unread = { o_buy: 2, o_sel: 5 }

  r = await t.call('message', 'o_buy', 'read', { chatId: 'c1' })
  t.eq(r.code, 0, 'read 调用成功')
  t.eq(r.data.ok, true, '返回 { ok: true }')
  const byId = id => t.store().messages.find(m => m._id === id)
  t.eq(byId('r1').read, true, '★ 发给我的未读消息置为已读')
  t.eq(byId('r2').read, true, '★ 发给我的未读消息置为已读')
  t.eq(byId('r3').read, true, '本来就已读的保持 true')
  t.eq(byId('r4').read, false, '★ 我发给对方的消息不会被标记已读')
  t.eq(byId('r5').read, false, '★ 其它会话的消息不受影响（chatId 过滤）')
  t.eq(chat('c1').unread.o_buy, 0, '★ 我的未读清零')
  t.eq(chat('c1').unread.o_sel, 5, '★ 对方的未读不受影响')

  t.eq((await t.call('message', 'o_weak', 'read', { chatId: 'c1' })).code, 403, '★ 非会话成员置已读 → 403')
  t.eq((await t.call('message', 'o_buy', 'read', { chatId: 'cX' })).code, 404, '会话不存在 → 404')
  t.eq((await t.call('message', 'o_buy', 'read', {})).code, 400, '缺 chatId → 400')
  t.eq((await t.call('message', 'o_ghost', 'read', { chatId: 'c1' })).code, 401, '未注册 → 401')

  /* ==================================================================
   * 组 26：unreadTotal
   * ================================================================== */
  t.group('组 26 · message.unreadTotal：会话未读合计 + 通知未读数')

  const s26 = seedChats()
  s26.notices = [
    { _id: 'tn1', _openid: 'o_buy', type: 'order', title: 'a', content: '', orderId: '', read: false, createTime: t.D(1) },
    { _id: 'tn2', _openid: 'o_buy', type: 'credit', title: 'b', content: '', orderId: '', read: false, createTime: t.D(2) },
    { _id: 'tn3', _openid: 'o_buy', type: 'system', title: 'c', content: '', orderId: '', read: true, createTime: t.D(3) },
    { _id: 'tn4', _openid: 'o_sel', type: 'order', title: 'd', content: '', orderId: '', read: false, createTime: t.D(1) }
  ]

  r = await t.call('message', 'o_buy', 'unreadTotal', {})
  t.eq(r.code, 0, 'unreadTotal 调用成功')
  t.eq(Object.keys(r.data).sort().join(','), 'chat,notice', '返回 { chat, notice }')
  t.eq(r.data.chat, 3, '★ chat = c1(2) + c2(1) 的未读之和')
  t.eq(r.data.notice, 2, '★ notice 只数字自己未读的通知')

  r = await t.call('message', 'o_sel', 'unreadTotal', {})
  t.eq(r.data.chat, 4, 'o_sel 只统计自己的会话（c3 的 4，c1 为 0）')
  t.eq(r.data.notice, 1, 'o_sel 的通知未读为 1')

  t.eq((await t.call('message', 'o_ghost', 'unreadTotal', {})).code, 401, '未注册 → 401')

  const s26b = seedChats()
  s26b.chats = []
  for (let i = 0; i < 120; i++) {
    s26b.chats.push({
      _id: 'big' + i, members: ['o_buy', 'o_x' + i], memberInfos: {},
      orderId: '', orderNo: '', lastMsg: '', lastMsgType: 'text', lastTime: t.D(i + 1),
      unread: { o_buy: 1 }, createTime: t.D(i + 1), updateTime: t.D(i + 1)
    })
  }
  r = await t.call('message', 'o_buy', 'unreadTotal', {})
  t.eq(r.data.chat, 120, '★ 会话数超过单次 get 上限 100 条时仍能累加全部未读（skip 分页拉全量）')

  /* ==================================================================
   * 组 27：notices
   * ================================================================== */
  t.group('组 27 · message.notices：只看自己的通知、可按 type 过滤、倒序分页')

  const s27 = seedChats()
  s27.notices = [
    { _id: 'n1', _openid: 'o_buy', type: 'order', title: '订单1', content: '', orderId: '', read: false, createTime: t.D(1) },
    { _id: 'n2', _openid: 'o_buy', type: 'credit', title: '信用1', content: '', orderId: '', read: true, createTime: t.D(2) },
    { _id: 'n3', _openid: 'o_buy', type: 'system', title: '系统1', content: '', orderId: '', read: false, createTime: t.D(3) },
    { _id: 'n4', _openid: 'o_buy', type: 'order', title: '订单2', content: '', orderId: '', read: false, createTime: t.D(4) },
    { _id: 'n5', _openid: 'o_sel', type: 'order', title: '别人的通知', content: '', orderId: '', read: false, createTime: t.D(1) }
  ]

  r = await t.call('message', 'o_buy', 'notices', {})
  t.eq(r.code, 0, 'notices 调用成功')
  t.eq(r.data.total, 4, '★ 只统计自己的通知')
  t.eq(r.data.list[0]._id, 'n1', '按 createTime 倒序')
  t.eq(Object.keys(r.data.list[0]).sort().join(','), '_id,_openid,content,createTime,orderId,read,title,type', '通知字段按 §3.10')
  t.eq((await t.call('message', 'o_buy', 'notices', { type: 'order' })).data.total, 2, "type='order' 过滤生效")
  t.eq((await t.call('message', 'o_buy', 'notices', { type: 'all' })).data.total, 4, "type='all' 返回全部")
  t.eq((await t.call('message', 'o_buy', 'notices', { type: 'credit' })).data.total, 1, "type='credit' 命中 1 条")
  t.eq((await t.call('message', 'o_buy', 'notices', { type: 'nonexistent' })).data.total, 0, '不存在的 type → 0 条')
  r = await t.call('message', 'o_buy', 'notices', { page: 1, size: 2 })
  t.eq(r.data.list.length, 2, 'size=2 生效')
  t.eq(r.data.hasMore, true, 'page1 hasMore=true')
  r = await t.call('message', 'o_buy', 'notices', { page: 2, size: 2 })
  t.eq(r.data.list.length, 2, 'page2 返回 2 条')
  t.eq(r.data.hasMore, false, 'page2 hasMore=false')
  t.eq((await t.call('message', 'o_sel', 'notices', {})).data.total, 1, 'o_sel 只看到自己的 1 条')
  t.eq((await t.call('message', 'o_ghost', 'notices', {})).code, 401, '未注册 → 401')

  /* ==================================================================
   * 组 28：readNotice
   * ================================================================== */
  t.group('组 28 · message.readNotice：单条已读 / 全部已读，越权 403')

  const s28 = seedChats()
  s28.notices = [
    { _id: 'x1', _openid: 'o_buy', type: 'order', title: 'a', content: '', orderId: '', read: false, createTime: t.D(1) },
    { _id: 'x2', _openid: 'o_buy', type: 'credit', title: 'b', content: '', orderId: '', read: false, createTime: t.D(2) },
    { _id: 'x3', _openid: 'o_buy', type: 'system', title: 'c', content: '', orderId: '', read: true, createTime: t.D(3) },
    { _id: 'x4', _openid: 'o_sel', type: 'order', title: 'd', content: '', orderId: '', read: false, createTime: t.D(1) }
  ]
  const notice = id => t.store().notices.find(n => n._id === id)

  t.eq((await t.call('message', 'o_buy', 'readNotice', {})).code, 400, '既没有 id 也没有 all → 400')
  t.eq((await t.call('message', 'o_buy', 'readNotice', { id: 'ghost' })).code, 404, '通知不存在 → 404')
  t.eq((await t.call('message', 'o_buy', 'readNotice', { id: 'x4' })).code, 403, '★ 操作别人的通知 → 403')
  t.eq(notice('x4').read, false, '越权失败后对方通知未被改动')

  r = await t.call('message', 'o_buy', 'readNotice', { id: 'x1' })
  t.eq(r.code, 0, '单条已读成功')
  t.eq(r.data.ok, true, '返回 { ok: true }')
  t.eq(notice('x1').read, true, '★ 指定通知置为已读')
  t.eq(notice('x2').read, false, '其它通知不受影响')

  r = await t.call('message', 'o_buy', 'readNotice', { all: true })
  t.eq(r.code, 0, '全部已读成功')
  t.eq(notice('x2').read, true, '★ all=true 把自己所有未读置为已读')
  t.eq(notice('x3').read, true, '已读的保持已读')
  t.eq(notice('x4').read, false, '★ 别人的通知绝不被连带标记')
  t.eq((await t.call('message', 'o_buy', 'readNotice', { all: true })).code, 0, '再次全部已读幂等成功')
  t.eq((await t.call('message', 'o_ghost', 'readNotice', { all: true })).code, 401, '未注册 → 401')

  /* ==================================================================
   * 组 29：subConfig + 未知 action
   * ================================================================== */
  t.group('组 29 · message.subConfig：订阅消息模板 key/title 配置')

  r = await t.call('message', 'o_buy', 'subConfig', {})
  t.eq(r.code, 0, 'subConfig 调用成功')
  t.eq(r.data.templates.length, 4, '返回 4 个模板')
  t.eq(r.data.templates.map(x => x.key).join(','), 'ORDER_CREATE,ORDER_ACCEPT,ORDER_FINISH,ORDER_CONFIRM', '模板 key 与顺序固定')
  t.ok(r.data.templates.every(x => x.id === x.key && x.title && x.key), '每个模板都有 id / title / key 且 id === key')
  t.eq(r.data.templates[0].title, '新订单提醒', '模板标题中文文案')
  t.eq((await t.call('message', '', 'subConfig', {})).code, 0, '（已知行为）subConfig 是静态配置，不要求登录态')
  t.eq((await t.call('message', 'o_buy', 'nope', {})).code, 400, '未知 action → 400')
}
