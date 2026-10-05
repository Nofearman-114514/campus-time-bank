/**
 * 云函数 message —— 聊天 / 系统通知 / 订阅消息（ARCHITECTURE.md §4.6）
 * ==================================================================
 * action：
 *   conversations 会话列表（补 otherId / otherInfo / unreadCount）
 *   openChat      打开或创建会话（members 升序保证唯一）
 *   history       历史消息（校验成员身份，page=1 返回最新一页，升序返回）
 *   send          发消息（写 messages + 更新 chat 摘要与未读）
 *   read          会话已读
 *   unreadTotal   未读总数 { chat, notice }
 *   notices       系统通知列表
 *   readNotice    通知已读（单条 / 全部）
 *   subConfig     订阅消息模板 key/title 配置
 *
 * 返回结构必须与 Campus Time Bank/utils/mock.js 中同名 handler 逐字段一致。
 * ==================================================================
 */
const {
  db, _, C,
  wrap, bizError, assert,
  now, parsePage, paginateQuery,
  requireUser, getUser
} = require('./shared')

/** 单次 get 上限：云函数内 db.get() 默认最多返回 100 条，超出需 skip 分页 */
const GET_PAGE = 100
/** 分页兜底上限，避免异常数据导致死循环 */
const GET_MAX = 2000

/** 会话成员快照（memberInfos 的值） */
const memberSnapshot = u => ({
  nickName: (u && u.nickName) || '匿名同学',
  avatarUrl: (u && u.avatarUrl) || '',
  creditScore: (u && u.creditScore) || 100
})

/** 取会话文档，不存在抛 404 */
async function getChat(chatId) {
  assert(chatId, '缺少 chatId', 400)
  let chat = null
  try {
    const r = await db.collection(C.CHATS).doc(chatId).get()
    chat = r.data || null
  } catch (e) {
    chat = null
  }
  if (!chat) throw bizError(404, '会话不存在')
  return chat
}

/** 校验调用者属于该会话，否则 403 */
function assertMember(chat, openid) {
  assert((chat.members || []).indexOf(openid) > -1, '你不在该会话中', 403)
}

/** 我的会话总数中未读数之和（分页拉全量，绕开 100 条单次上限） */
async function sumChatUnread(openid) {
  let total = 0
  for (let skip = 0; skip < GET_MAX; skip += GET_PAGE) {
    const res = await db.collection(C.CHATS)
      .where({ members: openid })
      .field({ unread: true })
      .skip(skip)
      .limit(GET_PAGE)
      .get()
    const rows = res.data || []
    rows.forEach(c => { total += ((c.unread || {})[openid] || 0) })
    if (rows.length < GET_PAGE) break
  }
  return total
}

/* ==================================================================
 * actions
 * ================================================================== */

/** conversations —— 我的会话列表，按 lastTime 倒序 */
async function conversations(event) {
  const me = await requireUser()
  const openid = me._openid
  const { page, size } = parsePage(event, 10)

  // ★ 数组字段匹配语义：云开发中 where({ members: openid }) 对数组字段就是「包含」语义
  //   （等价于 elemMatch 值匹配），因此这里直接写等值即可；
  //   若要更显式，也可写成 _.all([openid])。
  const res = await paginateQuery(
    db.collection(C.CHATS).where({ members: openid }),
    { page, size, orderBy: [['lastTime', 'desc']] }
  )

  const list = res.list || []
  // memberInfos 可能缺对方快照，统一补一次用户资料
  const missing = []
  list.forEach(c => {
    const other = (c.members || []).find(m => m !== openid)
    if (other && !(c.memberInfos || {})[other] && missing.indexOf(other) < 0) missing.push(other)
  })
  let infoMap = {}
  if (missing.length) {
    const uRes = await db.collection(C.USERS)
      .where({ _openid: _.in(missing.slice(0, 50)) })
      .field({ _openid: true, nickName: true, avatarUrl: true, creditScore: true })
      .get()
    ;(uRes.data || []).forEach(u => { infoMap[u._openid] = memberSnapshot(u) })
  }

  const mapped = list.map(c => {
    const otherId = (c.members || []).find(m => m !== openid) || ''
    const otherInfo = (c.memberInfos || {})[otherId] || infoMap[otherId] || { nickName: '用户', avatarUrl: '' }
    return Object.assign({}, c, {
      otherId,
      otherInfo,
      unreadCount: ((c.unread || {})[openid] || 0)
    })
  })

  return { list: mapped, total: res.total, hasMore: res.hasMore }
}

/**
 * 由 members（已升序）推出**确定性会话 _id**：同一对用户恒定同一个 id。
 *
 * 这是「并发下不会建出两条会话」的根基：把唯一性交给数据库主键，
 * 而不是交给「先查再建」这种 check-then-act。
 *
 * openid 理论上只含 [A-Za-z0-9_-]，直接拼接即可（构造上不可能碰撞）；
 * 万一出现其它字符则退化为双 32 位哈希，避免产生非法 _id。
 */
function chatIdOf(members) {
  const parts = members.map(m => String(m))
  if (parts.some(p => /[^A-Za-z0-9_-]/.test(p))) {
    const raw = parts.join('|')
    let h1 = 0x811c9dc5
    let h2 = 0x1000193
    for (let i = 0; i < raw.length; i++) {
      h1 = Math.imul(h1 ^ raw.charCodeAt(i), 0x01000193) >>> 0
      h2 = (h2 + raw.charCodeAt(i) * (i + 1)) >>> 0
    }
    return 'chat_' + h1.toString(36) + h2.toString(36)
  }
  return 'chat_' + parts.join('_')
}

/** openChat —— 打开（不存在则创建）与某人的会话 */
async function openChat(event) {
  const me = await requireUser()
  const toId = event.toId
  assert(toId && typeof toId === 'string', '缺少对方 openid', 400)
  assert(toId !== me._openid, '不能和自己发起会话', 400)

  const other = await getUser(toId)
  if (!other) throw bizError(404, '对方用户不存在')

  // members 按 openid 字符串升序排列
  const members = [me._openid, toId].sort()

  let orderId = event.orderId || ''
  let orderNo = ''
  if (orderId) {
    try {
      const o = await db.collection(C.ORDERS).doc(orderId).get()
      orderNo = (o.data && o.data.orderNo) || ''
    } catch (e) { orderNo = '' }
  }

  // 用**确定性 _id** 保证同一对用户物理上只可能有一条会话。
  //   不能 check-then-act（先 where 查、不存在再 add）—— 双方同时开聊会各建一条：
  //   其中一条成为孤儿（lastMsg 永远为空），两个聊天窗口内容不同步。
  //   members 升序只能保证「顺序调用」幂等，挡不住并发。
  const chatId = chatIdOf(members)

  // ① 先按确定性 _id 取
  let exist = null
  try {
    const r = await db.collection(C.CHATS).doc(chatId).get()
    exist = r.data || null
  } catch (e) { exist = null }

  // ② 再按 members 兜底 —— 兼容修复之前用随机 _id 建出来的历史会话
  if (!exist) {
    const found = await db.collection(C.CHATS).where({ members: _.all(members) }).limit(1).get()
    exist = (found.data || [])[0] || null
  }

  if (exist) {
    // 已存在则复用；顺便补上关联订单
    const patch = { updateTime: now() }
    if (orderId && !exist.orderId) { patch.orderId = orderId; patch.orderNo = orderNo }
    await db.collection(C.CHATS).doc(exist._id).update({ data: patch })
    return { chatId: exist._id }
  }

  try {
    // 显式指定 _id：并发下第二个 add 会因主键冲突失败，**不会**产生第二条会话
    await db.collection(C.CHATS).add({
      data: {
        _id: chatId,
        members,
        memberInfos: {
          [me._openid]: memberSnapshot(me),
          [toId]: memberSnapshot(other)
        },
        orderId,
        orderNo,
        lastMsg: '',
        lastMsgType: 'text',
        lastTime: now(),
        unread: {},
        createTime: now(),
        updateTime: now()
      }
    })
    return { chatId }
  } catch (e) {
    // 主键冲突 = 另一方刚建好，直接复用同一条，绝不新建第二条
    try {
      const r = await db.collection(C.CHATS).doc(chatId).get()
      if (r.data) return { chatId }
    } catch (e2) { /* 忽略，落到下面抛原错 */ }
    throw e
  }
}

/**
 * history —— 历史消息
 * ★ page=1 返回**最新**一页（ARCHITECTURE.md §4.6，2025 修订）：
 *   内部按 createTime desc 查出第 page 页，再在云函数内 reverse() 成**升序**返回，
 *   聊天页打开即看到最新对话、直接顺序渲染，上滑再加载更早的消息。
 *   hasMore = 是否还有**更早**的消息（skip + size < total）。
 *   实时聊天以 messages 集合 watch 为主，这里是断线降级轮询的兜底。
 */
async function history(event) {
  const me = await requireUser()
  const chat = await getChat(event.chatId)
  assertMember(chat, me._openid)

  const { page, size } = parsePage(event, 20)
  const res = await paginateQuery(
    db.collection(C.MESSAGES).where({ chatId: chat._id }),
    { page, size, orderBy: [['createTime', 'desc']] }
  )
  // 倒序取第 page 页 → 反转为升序（一页内仍是正序，前端无需自己排）
  return { list: (res.list || []).slice().reverse(), hasMore: res.hasMore }
}

/** send —— 发送消息（客户端只读，写必须过这里校验成员身份） */
async function send(event) {
  const me = await requireUser()
  const chat = await getChat(event.chatId)
  assertMember(chat, me._openid)

  const type = event.type || 'text'
  const content = event.content == null ? '' : String(event.content)
  assert(content.trim(), '消息内容不能为空', 400)
  assert(content.length <= 1000, '消息内容不能超过 1000 字', 400)
  // 类型必须是 §3.9 定义的枚举：否则 'video' 之类会原样落库并写进 lastMsgType
  assert(['text', 'image', 'system'].indexOf(type) > -1, '不支持的消息类型', 400)

  const toId = event.toId || (chat.members || []).find(m => m !== me._openid)
  assert((chat.members || []).indexOf(toId) > -1, '接收者不在该会话中', 400)
  // 禁止给自己发消息 —— 只校验「是会话成员」是不够的，
  //   于是 unread[自己] +1，聊天列表会出现清不掉的红点
  assert(toId !== me._openid, '不能给自己发消息', 400)

  // 文本消息落库前必须 trim，否则首尾空格会直接进会话列表的 lastMsg
  const finalContent = type === 'text' ? content.trim() : content

  const createTime = now()
  // ★ messages 权限为「所有用户可读，仅创建者可写」，_openid 必须显式写成发送者
  const addRes = await db.collection(C.MESSAGES).add({
    data: {
      _openid: me._openid,
      chatId: chat._id,
      fromId: me._openid,
      toId,
      type,
      content: finalContent,
      read: false,
      createTime
    }
  })

  await db.collection(C.CHATS).doc(chat._id).update({
    data: {
      lastMsg: type === 'image' ? '[图片]' : finalContent,
      lastMsgType: type,
      lastTime: createTime,
      updateTime: createTime,
      [`unread.${toId}`]: _.inc(1)
    }
  })

  return { msgId: addRes._id, createTime }
}

/** read —— 会话已读：发给我的消息置 read=true，并清零 unread.{me} */
async function read(event) {
  const me = await requireUser()
  const chat = await getChat(event.chatId)
  assertMember(chat, me._openid)

  await db.collection(C.MESSAGES)
    .where({ chatId: chat._id, toId: me._openid, read: false })
    .update({ data: { read: true } })

  await db.collection(C.CHATS).doc(chat._id).update({
    data: { [`unread.${me._openid}`]: 0 }
  })
  return { ok: true }
}

/** unreadTotal —— 未读总数 */
async function unreadTotal() {
  const me = await requireUser()
  const [chatCount, noticeRes] = await Promise.all([
    sumChatUnread(me._openid),
    db.collection(C.NOTICES).where({ _openid: me._openid, read: false }).count()
  ])
  return { chat: chatCount, notice: (noticeRes && noticeRes.total) || 0 }
}

/** notices —— 系统通知列表 */
async function notices(event) {
  const me = await requireUser()
  const { page, size } = parsePage(event, 10)
  const where = { _openid: me._openid }
  if (event.type && event.type !== 'all') where.type = event.type

  const res = await paginateQuery(
    db.collection(C.NOTICES).where(where),
    { page, size, orderBy: [['createTime', 'desc']] }
  )
  return { list: res.list, total: res.total, hasMore: res.hasMore }
}

/** readNotice —— 单条已读 / 全部已读 */
async function readNotice(event) {
  const me = await requireUser()

  if (event.all) {
    await db.collection(C.NOTICES)
      .where({ _openid: me._openid, read: false })
      .update({ data: { read: true } })
    return { ok: true }
  }

  assert(event.id, '缺少通知 id（或传 { all: true }）', 400)
  let n = null
  try {
    const r = await db.collection(C.NOTICES).doc(event.id).get()
    n = r.data || null
  } catch (e) {
    n = null
  }
  if (!n) throw bizError(404, '通知不存在')
  assert(n._openid === me._openid, '只能操作自己的通知', 403)

  await db.collection(C.NOTICES).doc(n._id).update({ data: { read: true } })
  return { ok: true }
}

/**
 * subConfig —— 订阅消息模板配置
 * 模板 ID 由小程序端 envList.js 提供，这里只回 key/title + id 占位，
 * 客户端用 key 去 envList 里取真实 tmplId 再 wx.requestSubscribeMessage。
 */
async function subConfig() {
  return {
    templates: [
      { id: 'ORDER_CREATE', title: '新订单提醒', key: 'ORDER_CREATE' },
      { id: 'ORDER_ACCEPT', title: '接单成功通知', key: 'ORDER_ACCEPT' },
      { id: 'ORDER_FINISH', title: '服务完成待确认', key: 'ORDER_FINISH' },
      { id: 'ORDER_CONFIRM', title: '确认完成到账', key: 'ORDER_CONFIRM' }
    ]
  }
}

/* ==================================================================
 * 入口
 * ================================================================== */
exports.main = wrap(async (event, context) => {
  const action = event.action || ''
  switch (action) {
    case 'conversations': return await conversations(event)
    case 'openChat': return await openChat(event)
    case 'history': return await history(event)
    case 'send': return await send(event)
    case 'read': return await read(event)
    case 'unreadTotal': return await unreadTotal()
    case 'notices': return await notices(event)
    case 'readNotice': return await readNotice(event)
    case 'subConfig': return await subConfig()
    default: throw bizError(400, `未知 action: ${action}`)
  }
})
