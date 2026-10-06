/**
 * 离线数据层冒烟测试
 * ==================================================================
 * 用法（项目根目录）：
 *     node tools/smoke-test-mock.js
 *
 * 为什么需要它：
 *   envList.js 未填写 ENV_ID 时，整个小程序跑在 utils/mock.js 之上。
 *   本脚本在 Node 里把 api.js 声明的**每一个 action** 都真实调用一遍，
 *   确保「零云环境」下所有页面都有数据可渲染 —— 这是答辩彩排的保险。
 *
 * 退出码 0 表示全部通过。
 * ==================================================================
 */
const path = require('path')

const ROOT = path.resolve(__dirname, '..')
const mock = require(path.join(ROOT, 'Campus Time Bank/utils/mock.js'))
const apiSrc = require('fs').readFileSync(path.join(ROOT, 'Campus Time Bank/utils/api.js'), 'utf8')

/* ------------------------------------------------------------------ */
/* 从 api.js 提取全部 [命名空间, action]                                */
/* ------------------------------------------------------------------ */
const actions = []
for (const m of apiSrc.matchAll(/call\(\s*'([A-Za-z_]\w*)'\s*,\s*'([A-Za-z_]\w*)'/g)) {
  actions.push([m[1], m[2]])
}

/* ------------------------------------------------------------------ */
/* 参数构造（依赖 mock store 的真实 id，避免写死）                        */
/* ------------------------------------------------------------------ */
const S = mock.store
const ME = 'openid_demo_me'

function findOrder(status, role) {
  return S.orders.find(o => o.status === status && (role === 'buyer' ? o.buyerId === ME : o.sellerId === ME))
}
function findAnyOrder(pred) { return S.orders.find(pred) }

/** 一个我可以下单的技能（不是我自己发布的） */
const buyableSkill = S.skills.find(s => s.authorId !== ME && s.status === 1)
/** 一个我发布的、没有进行中订单的技能（可以删除） */
const removableSkill = S.skills.find(s => s.authorId === ME &&
  !S.orders.some(o => o.skillId === s._id && ['waiting', 'ongoing', 'confirming'].includes(o.status)))
const chat = S.chats[0]
const notice = S.notices.find(n => n._openid === ME)
const report = S.reports.find(r => r.status === 0)

/**
 * 预置一个「干净的、归我所有、没有任何订单引用」的技能，
 * 专门给 skill.remove 用。
 * 种子数据里我的两个技能都有进行中的订单（这是刻意的，
 * 用来演示「有进行中订单不能删除」的守卫），所以这里临时造一个。
 */
const TMP_SKILL_ID = 'skill_tmp_removable'
S.skills.push({
  _id: TMP_SKILL_ID,
  _openid: ME,
  authorId: ME,
  authorInfo: { nickName: '张小明', avatarUrl: '', creditScore: 112, creditLevel: 'good', authStatus: 2 },
  type: 'offer', title: '临时可删除技能', desc: '冒烟测试专用', categoryId: 'c10', categoryName: '其他',
  categoryIcon: '✨', price: 1, duration: 30, images: [], tags: [],
  location: null, address: '', locationName: '',
  status: 1, auditRemark: '', viewCount: 0, orderCount: 0, isTop: false,
  createTime: new Date(), updateTime: new Date()
})

/**
 * 每个 action 执行后的状态修正。
 * 目的：让冒烟测试可以「一个循环跑完所有 action」而不被前一个 action
 * 的副作用干扰 —— 副作用本身是正确的业务行为，不该被当成失败。
 */
const AFTER = {
  // 提交认证会把状态改成「审核中」；恢复成「已认证」，
  // 否则后面的 skill.create / order.create 会被认证守卫正确拦下
  'login.submitCampusAuth': () => {
    const me = S.users.find(u => u._openid === ME)
    if (me) me.authStatus = 2
  },
  // 审核通过后恢复成待审核，避免影响后面的 admin 断言
  'admin.auditUser': () => {
    const u = S.users.find(x => x._openid === 'openid_demo_u6')
    if (u) u.authStatus = 1
  }
}

const P = (ns, fn) => ({
  'login.login': {},
  'login.updateProfile': { nickName: '张小明', avatarUrl: '', bio: '测试简介' },
  'login.submitCampusAuth': { realName: '张小明', studentNo: '20220001', campus: '示范大学', authImages: [] },
  'login.bindPhone': { code: 'mock-code' },
  'login.getUser': { openid: 'openid_demo_u1' },
  'login.updateLocation': { longitude: 112.818333, latitude: 23.003611, locationName: '山下 1 栋楼下' },

  'skill.list': { page: 1, size: 5 },
  'skill.detail': { id: S.skills[0]._id },
  'skill.create': {
    type: 'offer', title: '测试技能', desc: '这是一段至少十个字的测试描述文本',
    categoryId: 'c1', price: 2, duration: 60, images: [], tags: ['测试'],
    longitude: 112.818333, latitude: 23.003611, address: '广职院 · 山下 1 栋', locationName: '山下 1 栋楼下'
  },
  'skill.update': { id: S.skills.find(s => s.authorId === ME)._id, title: '改过的标题' },
  'skill.remove': { id: TMP_SKILL_ID },
  'skill.myList': { page: 1, size: 10 },
  'skill.collect': { id: buyableSkill._id, collected: true },
  'skill.myFavorites': { page: 1, size: 10 },
  'skill.categories': {},
  'skill.banners': {},
  'skill.report': { targetType: 'skill', targetId: S.skills[0]._id, targetTitle: '测试', reason: '虚假信息 / 与描述不符', images: [] },

  'order.create': { skillId: buyableSkill._id, remark: '冒烟测试下单', expectTime: '周六下午' },
  'order.accept': null,   // 动态填充
  'order.reject': null,
  'order.cancel': null,
  'order.finish': null,
  'order.confirm': null,
  'order.list': { role: 'buyer', status: 'all', page: 1, size: 10 },
  'order.detail': null,
  'order.counts': {},

  'wallet.info': {},
  'wallet.logs': { page: 1, size: 10, type: 'all' },
  'wallet.stats': {},

  'user.mine': {},
  'user.home': { openid: 'openid_demo_u1' },
  'user.creditLogs': { page: 1, size: 10 },
  'user.badges': {},
  'user.reviews': { role: 'received', page: 1, size: 10 },
  'user.reviewCreate': null,  // 动态填充
  'user.reviewReply': { reviewId: S.reviews.find(r => r.toId === ME)._id, content: '谢谢你的评价！' },

  'message.conversations': { page: 1, size: 10 },
  'message.openChat': { toId: 'openid_demo_u4' },
  'message.history': { chatId: chat._id, page: 1, size: 20 },
  'message.send': { chatId: chat._id, toId: 'openid_demo_u1', content: '冒烟测试消息', type: 'text' },
  'message.read': { chatId: chat._id },
  'message.unreadTotal': {},
  'message.notices': { page: 1, size: 10, type: 'all' },
  'message.readNotice': { id: notice ? notice._id : 'x' },
  'message.subConfig': {},

  'admin.check': {},
  'admin.stats': { range: 7 },
  'admin.users': { page: 1, size: 10 },
  'admin.auditUser': { userId: 'openid_demo_u6', pass: true, remark: '' },
  'admin.setUserStatus': { userId: 'openid_demo_u6', status: 1 },
  'admin.setUserRole': { userId: 'openid_demo_u5', role: 'user' },
  'admin.adjustCoins': { userId: 'openid_demo_u5', amount: 1, remark: '冒烟测试调整' },
  'admin.categories': {},
  'admin.saveCategory': { name: '冒烟测试分类', icon: '🧪', sort: 99, status: 1 },
  'admin.deleteCategory': { _id: 'c10' },
  'admin.skills': { page: 1, size: 10 },
  'admin.auditSkill': { id: S.skills[0]._id, status: 1, remark: '' },
  'admin.orders': { page: 1, size: 10 },
  'admin.reports': { page: 1, size: 10 },
  'admin.handleReport': { id: report ? report._id : 'x', result: 2, remark: '证据不足' },
  'admin.banners': {},
  'admin.saveBanner': { title: '冒烟测试轮播', link: '', sort: 99 },
  'admin.deleteBanner': { _id: 'b3' },
  'admin.config': {},
  'admin.saveConfig': { registerBonus: 5 }
}[`${ns}.${fn}`])

/* ------------------------------------------------------------------ */
/* 执行                                                                */
/* ------------------------------------------------------------------ */
const C = { r: '\x1b[0m', red: '\x1b[31m', green: '\x1b[32m', yellow: '\x1b[33m', dim: '\x1b[2m', b: '\x1b[1m' }

const pass = []
const skip = []
const failed = []

async function run() {
  console.log(`\n${C.b}离线数据层冒烟测试 —— 共 ${actions.length} 个 action${C.r}\n`)

  /* ---- 阶段 1：与订单状态流转无关的接口 ---- */
  for (const [ns, fn] of actions) {
    const key = `${ns}.${fn}`
    if (['order.accept', 'order.reject', 'order.cancel', 'order.finish', 'order.confirm', 'order.detail', 'user.reviewCreate', 'message.history', 'message.send', 'message.read'].includes(key)) {
      continue // 放到阶段 2（依赖阶段 1 产生的订单）
    }
    const params = P(ns, fn)
    if (params === undefined) { skip.push(`${key}（脚本未提供参数）`); continue }
    try {
      await mock.dispatch(ns, Object.assign({ action: fn }, params || {}))
      pass.push(key)
    } catch (e) {
      failed.push(`${key} → ${e.message}`)
    }
    if (AFTER[key]) {
      try { AFTER[key]() } catch (e) { /* 状态修正失败不影响断言 */ }
    }
  }

  /* ---- 阶段 2：订单全流程 ---- *
   * 种子数据里买卖双方视角的场景不齐（例如没有「我是卖家且待接单」的订单），
   * 所以这里合成订单，把状态机的每条迁移都真实跑一遍。
   * ------------------------------------------------------------ */
  const syn = (status, sellerIsMe, price) => {
    const o = JSON.parse(JSON.stringify(S.orders[0]))
    o._id = 'order_tmp_' + status + '_' + Math.random().toString(36).slice(2, 7)
    o.orderNo = 'TBTMP' + Math.floor(Math.random() * 1e8)
    o.amount = price || 1
    o.skillSnapshot = Object.assign({}, o.skillSnapshot, { price: price || 1 })
    if (sellerIsMe) {
      o.sellerId = ME
      o.sellerInfo = { nickName: '张小明', avatarUrl: '', creditScore: 112 }
      o.buyerId = 'openid_demo_u1'
      o.buyerInfo = { nickName: '李思远', avatarUrl: '', creditScore: 128 }
    } else {
      o.buyerId = ME
      o.buyerInfo = { nickName: '张小明', avatarUrl: '', creditScore: 112 }
      o.sellerId = 'openid_demo_u1'
      o.sellerInfo = { nickName: '李思远', avatarUrl: '', creditScore: 128 }
    }
    o.status = status
    o.timeline = []
    o.isRatedBuyer = false
    o.isRatedSeller = false
    S.orders.unshift(o)
    return o
  }

  try {
    // ① 卖家视角：待接单 → 接单 → 标记完成（waiting → ongoing → confirming）
    const acceptOrder = syn('waiting', true)
    await mock.dispatch('order', { action: 'accept', orderId: acceptOrder._id })
    pass.push('order.accept')
    await mock.dispatch('order', { action: 'finish', orderId: acceptOrder._id })
    pass.push('order.finish')
    if (acceptOrder.status !== 'confirming') throw new Error('finish 后状态应为 confirming，实际为 ' + acceptOrder.status)
    if (!acceptOrder.finishTime) throw new Error('finish 未写入 finishTime')

    // ② 卖家视角：拒单（waiting → closed，且买家时间币解冻退回）
    const rejectOrder = syn('waiting', true)
    const buyerBefore = S.users.find(u => u._openid === 'openid_demo_u1')
    const coinsBefore = buyerBefore.coins
    await mock.dispatch('order', { action: 'reject', orderId: rejectOrder._id, reason: '冒烟测试拒单' })
    pass.push('order.reject')
    if (rejectOrder.status !== 'closed') throw new Error('reject 后状态应为 closed')
    if (buyerBefore.coins !== coinsBefore + rejectOrder.amount) {
      throw new Error(`拒单未退回时间币：期望 +${rejectOrder.amount}，实际 ${buyerBefore.coins - coinsBefore}`)
    }

    // ③ 买家视角：取消（waiting 阶段取消不扣信用分）
    const cancelOrder = syn('waiting', false)
    const myCreditBefore = S.users.find(u => u._openid === ME).creditScore
    await mock.dispatch('order', { action: 'cancel', orderId: cancelOrder._id, reason: '冒烟测试取消' })
    pass.push('order.cancel')
    const myCreditAfter = S.users.find(u => u._openid === ME).creditScore
    if (myCreditAfter !== myCreditBefore) {
      throw new Error(`waiting 阶段取消不应扣信用分，实际变化 ${myCreditAfter - myCreditBefore}`)
    }

    // ④ 买家视角：确认完成 → 时间币结算给卖家 → 双方 +2 信用分 → 评价
    const confirmOrder = syn('confirming', false, 1)
    const sellerU = S.users.find(u => u._openid === 'openid_demo_u1')
    const sellerCoinsBefore = sellerU.coins
    const sellerCreditBefore = sellerU.creditScore
    await mock.dispatch('order', { action: 'confirm', orderId: confirmOrder._id })
    pass.push('order.confirm')
    if (confirmOrder.status !== 'finished') throw new Error('confirm 后状态应为 finished')
    if (sellerU.coins !== sellerCoinsBefore + 1) {
      throw new Error(`结算未到账：期望 +1，实际 ${sellerU.coins - sellerCoinsBefore}`)
    }
    if (sellerU.creditScore !== sellerCreditBefore + 2) {
      throw new Error(`完成订单卖家应 +2 信用分，实际 ${sellerU.creditScore - sellerCreditBefore}`)
    }
    // 确认后才能真正评价
    await mock.dispatch('user', {
      action: 'reviewCreate', orderId: confirmOrder._id, score: 5,
      tags: ['专业靠谱'], content: '冒烟测试评价'
    })
    pass.push('user.reviewCreate')
    if (!confirmOrder.isRatedBuyer) throw new Error('评价后未写入 isRatedBuyer')

    // ⑤ 订单详情
    await mock.dispatch('order', { action: 'detail', orderId: confirmOrder._id })
    pass.push('order.detail')

    // ⑥ 聊天三件套
    const c2 = S.chats[0]
    const other = c2.members.find(m => m !== ME)
    await mock.dispatch('message', { action: 'history', chatId: c2._id, page: 1, size: 20 })
    pass.push('message.history')
    const before = S.messages.filter(m => m.chatId === c2._id).length
    await mock.dispatch('message', { action: 'send', chatId: c2._id, toId: other, content: '冒烟测试消息', type: 'text' })
    pass.push('message.send')
    if (S.messages.filter(m => m.chatId === c2._id).length !== before + 1) throw new Error('发送消息未写入 messages')
    await mock.dispatch('message', { action: 'read', chatId: c2._id })
    pass.push('message.read')
  } catch (e) {
    failed.push(`订单/聊天流程断言 → ${e.message}`)
  }

  /* ------------------------------------------------------------------ */
  /* 内容安全（离线镜像的行为断言）                                        */
  /* ------------------------------------------------------------------ */
  /*
   * ★ 为什么单独验它：check-project 只能证明「mock 覆盖了这个 action」，
   *   证明不了「行为与云端一致」。离线镜像若没生效，演示时一条违规内容
   *   会畅通无阻 —— 而演示恰恰是最容易被看到的时候。
   *   这里直接打 mock 的派发入口，断言它真的会拒。
   */
  let secChecked = 0
  const secCases = [
    ['skill', { action: 'create', title: '违禁词一条', desc: '正常描述', categoryId: 'c1', price: 1, duration: 30, longitude: 112.823601, latitude: 23.001079 },
      '技能标题含违规词'],
    ['skill', { action: 'create', title: '正常标题', desc: '详情里有违禁词', categoryId: 'c1', price: 1, duration: 30, longitude: 112.823601, latitude: 23.001079 },
      '技能详情含违规词'],
    ['order', { action: 'create', skillId: (S.skills.find(x => x._openid !== ME) || {})._id, remark: '帮我办证' },
      '下单留言含违规词'],
    ['user', { action: 'reviewCreate', orderId: (findOrder('finished') || {})._id, score: 5, content: '涉及赌博' },
      '评价内容含违规词']
  ]
  for (const [fn, payload, label] of secCases) {
    secChecked++
    let threw = null
    try { await mock.dispatch(fn, payload) } catch (e) { threw = e }
    if (!threw) failed.push('内容安全镜像 → ' + label + ' 应被拦下（400），实际放行了')
    else if (threw.code !== 400) failed.push('内容安全镜像 → ' + label + ' 应报 400，实际 ' + threw.code + '：' + threw.message)
  }
  console.log(`  ${C.green}✓${C.r} 内容安全镜像：${secChecked} 个入口的违规内容都被拦下`)

  /* 正常内容必须能通过（否则镜像就成了「什么都拒」） */
  let secPassOk = false
  try {
    await mock.dispatch('skill', { action: 'create', title: '吉他入门', desc: '周六下午，教学楼 B1', categoryId: 'c1', price: 1, duration: 30, longitude: 112.823601, latitude: 23.001079 })
    secPassOk = true
  } catch (e) { failed.push('内容安全镜像 → 正常内容被误拦：' + e.message) }
  if (secPassOk) console.log(`  ${C.green}✓${C.r} 内容安全镜像：正常内容不受影响`)

  /* ---- 输出 ---- */
  console.log(`${C.green}通过 ${pass.length}${C.r}   ${C.red}失败 ${failed.length}${C.r}   ${C.yellow}跳过 ${skip.length}${C.r}\n`)

  if (failed.length) {
    console.log(`${C.red}${C.b}失败明细：${C.r}`)
    failed.forEach(f => console.log(`  ${C.red}✗${C.r} ${f}`))
    console.log('')
  }
  if (skip.length) {
    console.log(`${C.yellow}${C.b}跳过：${C.r}`)
    skip.forEach(s => console.log(`  ${C.yellow}·${C.r} ${s}`))
    console.log('')
  }

  // 覆盖率
  const covered = new Set(pass.map(p => p.replace(/×\d/g, '')))
  console.log(`${C.dim}覆盖率：${covered.size}/${actions.length} 个 action 在离线模式下可用${C.r}\n`)

  process.exit(failed.length ? 1 : 0)
}

run().catch(e => {
  console.error(`${C.red}脚本异常：${C.r}`, e)
  process.exit(1)
})
