/**
 * 云函数共享层（唯一源）
 * ==================================================================
 * 本目录是**源码唯一事实来源**，由 tools/sync-shared.mjs 复制到
 * 每个云函数的 `shared/` 子目录后再上传部署。
 *
 * 修改后请执行：  node tools/sync-shared.mjs
 * ==================================================================
 */
const cloud = require('wx-server-sdk')

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })

const db = cloud.database()
const _ = db.command
const $ = db.command.aggregate

/* ============================ 集合名常量 ============================ */
const C = {
  USERS: 'users',
  CATEGORIES: 'categories',
  SKILLS: 'skills',
  ORDERS: 'orders',
  REVIEWS: 'reviews',
  WALLET_LOGS: 'wallet_logs',
  CREDIT_LOGS: 'credit_logs',
  CHATS: 'chats',
  MESSAGES: 'messages',
  NOTICES: 'notices',
  REPORTS: 'reports',
  BANNERS: 'banners',
  CONFIG: 'config',
  // ★ 第 14 个集合：技能收藏关系。单独建集合而不是在 skills 上挂数组字段 ——
  //   这样「我的收藏」是一次 where 查询、取消收藏是删文档，
  //   技能文档也不会因为收藏人数增长而无限膨胀。
  FAVORITES: 'favorites',
  // ★ 第 15/16 个集合：内部账户与会话（见下方「内部账户」一节）
  ACCOUNTS: 'accounts',
  SESSIONS: 'sessions'
}

/* ============================ 统一返回 ============================ */
/** 成功 */
const ok = (data) => ({ code: 0, msg: 'ok', data: data === undefined ? null : data })

/** 失败 */
const fail = (code, msg, data) => ({ code: code || 500, msg: msg || '操作失败', data: data === undefined ? null : data })

/** 业务异常（抛出后由入口 catch 统一转成 fail） */
class BizError extends Error {
  constructor(code, msg) {
    super(msg)
    this.name = 'BizError'
    this.code = code || 400
    this.__biz = true
  }
}
const bizError = (code, msg) => new BizError(code, msg)

/**
 * 断言，失败抛业务异常
 * @param {Boolean} cond
 * @param {String} msg
 * @param {Number} code
 */
function assert(cond, msg, code) {
  if (!cond) throw new BizError(code || 400, msg)
}

/* ============================ 时间 ============================ */
const now = () => new Date()
const hoursLater = (h) => new Date(Date.now() + h * 3600000)
const daysAgo = (d) => new Date(Date.now() - d * 86400000)
/** 当天 00:00:00 */
function startOfDay(d) {
  const t = d ? new Date(d) : new Date()
  t.setHours(0, 0, 0, 0)
  return t
}
/** 返回近 n 天的日期 key 数组 ['2025-06-01', ...]（含今天） */
function lastNDays(n) {
  const arr = []
  for (let i = n - 1; i >= 0; i--) {
    const d = new Date(Date.now() - i * 86400000)
    arr.push(`${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`)
  }
  return arr
}
function pad(n) { return n < 10 ? '0' + n : '' + n }

/** 订单号：TB + yyyyMMddHHmmss + 4 位随机 */
function genOrderNo() {
  const d = new Date()
  const s = `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`
  return 'TB' + s + String(Math.floor(1000 + Math.random() * 9000))
}

/* ============================ 分页 ============================ */
/**
 * 解析分页参数
 * @returns {{page:Number, size:Number, skip:Number}}
 */
function parsePage(event, defaultSize) {
  const page = Math.max(1, parseInt(event.page, 10) || 1)
  const size = Math.min(50, Math.max(1, parseInt(event.size, 10) || defaultSize || 10))
  return { page, size, skip: (page - 1) * size }
}

/**
 * 统一分页查询
 * @param {Object} query 已构造好的 collection().where(...)
 * @param {Object} opts { page, size, orderBy:[field, 'desc'|'asc'], field }
 * @returns {Promise<{list:Array, total:Number, hasMore:Boolean, page:Number}>}
 */
async function paginateQuery(query, opts) {
  const o = opts || {}
  const page = Math.max(1, o.page || 1)
  const size = Math.min(50, Math.max(1, o.size || 10))
  const skip = (page - 1) * size

  const countRes = await query.count()
  const total = countRes.total || 0

  let q = query
  const orderBy = o.orderBy || [['createTime', 'desc']]
  orderBy.forEach(([field, dir]) => { q = q.orderBy(field, dir || 'desc') })
  if (o.field) q = q.field(o.field)

  const res = await q.skip(skip).limit(size).get()
  return {
    list: res.data || [],
    total,
    hasMore: skip + size < total,
    page
  }
}

/* ============================ 内部账户 ============================ */
/*
 * 背景：普通用户的身份来自 wx.login 换到的 openid，与微信号绑定。
 * 但**内部账户**（校方/运维）需要在没有微信绑定的情况下登录 ——
 * 所以他们走「账号 + 密码」，登录后拿到一个会话令牌。
 *
 * ★ 关键设计：整个后端都是按 openid 索引的（每个 action 都调 getOpenId()）。
 *   所以这里**不去改那 8 个云函数**，而是让 getOpenId() 在「带有效令牌」时
 *   返回该账户的**合成 openid**。业务层一行都不用动。
 */
const identityStore = require('async_hooks').AsyncLocalStorage
const nodeCrypto = require('crypto')

const identityAls = new identityStore()

/** 合成 openid 前缀 —— 与微信 openid（o 开头）天然不冲突 */
const ACCOUNT_PREFIX = 'acct_'

/** 会话有效期：7 天 */
const SESSION_TTL = 7 * 24 * 3600 * 1000
/** PBKDF2 迭代次数：够用又不至于拖慢云函数 */
const PBKDF2_ITER = 50000
const PBKDF2_LEN = 32

function newSalt() {
  return nodeCrypto.randomBytes(16).toString('hex')
}

function newToken() {
  return nodeCrypto.randomBytes(32).toString('hex')
}

/** 口令 → PBKDF2-SHA256 哈希（十六进制）。**绝不存明文。** */
function hashPassword(password, salt) {
  return nodeCrypto
    .pbkdf2Sync(String(password), String(salt), PBKDF2_ITER, PBKDF2_LEN, 'sha256')
    .toString('hex')
}

/**
 * 定长时间比较。
 * ★ 不用 === 是因为字符串比较遇到第一个不同字符就返回，
 *   理论上能通过响应耗时逐字节猜出哈希。
 */
function safeEqual(a, b) {
  const ba = Buffer.from(String(a), 'utf8')
  const bb = Buffer.from(String(b), 'utf8')
  if (ba.length !== bb.length) return false
  return nodeCrypto.timingSafeEqual(ba, bb)
}

/**
 * 用令牌换会话；令牌无效/过期返回 null。
 *
 * ★ 解析失败**不抛错**：调用方回退到微信身份。
 *   这样「令牌过期」不会把人锁在门外，也不会造成权限提升
 *   （拿不到有效令牌 = 只能是微信本人）。
 */
async function resolveSession(token) {
  const tk = String(token || '').trim()
  if (tk.length < 32 || tk.length > 128) return null
  try {
    const res = await db.collection(C.SESSIONS).where({ token: tk }).limit(1).get()
    const s = (res.data && res.data[0]) || null
    if (!s) return null
    if (Number(s.expireTime) && Number(s.expireTime) < Date.now()) return null
    return { openid: s.accountOpenid, session: s }
  } catch (e) {
    return null
  }
}

/** 当前请求是否来自内部账户（不是则返回 null） */
function currentAccount() {
  const store = identityAls.getStore()
  return (store && store.account) || null
}

/* ============================ 用户 ============================ */
/**
 * 当前调用者的 openid。
 *
 * ★ 优先级：内部账户会话 > 微信身份。
 *   「带令牌」是一个显式声明「以谁的身份操作」，比隐式的微信上下文更具体。
 */
function getOpenId() {
  const store = identityAls.getStore()
  if (store && store.openid) return store.openid
  const ctx = cloud.getWXContext()
  return ctx.OPENID || ctx.FROM_OPENID || ''
}

/**
 * 取用户文档（不存在返回 null）
 * @param {String} openid 不传则取当前调用者
 */
async function getUser(openid) {
  const id = openid || getOpenId()
  if (!id) return null
  const res = await db.collection(C.USERS).where({ _openid: id }).limit(1).get()
  return (res.data && res.data[0]) || null
}

/**
 * 取用户，不存在则抛 401
 */
async function requireUser(openid) {
  const u = await getUser(openid)
  if (!u) throw new BizError(401, '用户不存在，请重新登录')
  // ★ 注销要单独判断、单独文案。
  //   注销后 status 也是 0（禁止再登录），若直接落到「已被封禁」分支，
  //   用户会以为自己是违规被封 —— 明明是本人主动注销的。
  if (u.canceled) throw new BizError(403, '该账号已注销，数据不可恢复。如需继续使用，请重新注册')
  if (u.status === 0) throw new BizError(403, '账号已被封禁，如有疑问请联系管理员')
  return u
}

/**
 * 要求已通过校园认证
 */
async function requireVerified(openid) {
  const u = await requireUser(openid)
  if (u.authStatus !== 2) throw new BizError(403, '请先完成校园认证')
  return u
}

/* ============================ 角色 ============================ */
/**
 * 管理层角色。
 *
 * ★ 权限是**包含**关系，不是并列：
 *     debugger（调试员 / 校方） ⊃ admin（管理员 / 学生）
 *
 *   调试员能接触所有数据，所以管理后台也进得去；
 *   管理员反过来**碰不到调试功能** —— 未调试完的新功能不能让学生看到
 *   （现实里总有管理员学生会「手贱」把每个按钮都点一遍）。
 *
 *   因此「一个人同时是两者」等价于「他是调试员」：
 *   debugger 已包含 admin 的全部能力，不需要再用数组字段去表达。
 */
const ROLE = { USER: 'user', ADMIN: 'admin', DEBUGGER: 'debugger' }

/** 能否进入管理后台：管理员 + 调试员 */
function isAdminUser(u) {
  return !!u && (u.role === ROLE.ADMIN || u.role === ROLE.DEBUGGER)
}

/** 能否接触调试功能：仅调试员 */
function isDebuggerUser(u) {
  return !!u && u.role === ROLE.DEBUGGER
}

/**
 * 要求管理员（含调试员）
 */
async function requireAdmin(openid) {
  const u = await requireUser(openid)
  if (!isAdminUser(u)) throw new BizError(403, '无管理员权限')
  return u
}

/**
 * 要求调试员 —— 调试功能、未上线的新功能都走这个。
 * 管理员会拿到 403；文案刻意与 requireAdmin 一致，不透露「还有这么个东西」。
 */
async function requireDebugger(openid) {
  const u = await requireUser(openid)
  if (!isDebuggerUser(u)) throw new BizError(403, '无管理员权限')
  return u
}

/** 读取全局配置（带默认值兜底） */
const DEFAULT_CONFIG = {
  _id: 'global',
  registerBonus: 5,
  orderExpireHours: 24,
  confirmExpireHours: 72,
  minCreditToOrder: 60,
  serviceFee: 0,
  hotCategories: [],
  aboutUs: ''
}
async function getConfig() {
  try {
    const res = await db.collection(C.CONFIG).doc('global').get()
    return Object.assign({}, DEFAULT_CONFIG, res.data || {})
  } catch (e) {
    return Object.assign({}, DEFAULT_CONFIG)
  }
}

/* ============================ 信用分 ============================ */
/**
 * 信用等级表。
 * `limit` = 该等级最多可同时进行的订单数（见 ARCHITECTURE.md §6.2 权益表）。
 * ★ 这张表是全项目唯一的服务端权威定义，order 云函数必须用 `orderLimitOf()`，
 *   不要再在业务代码里复刻一份。
 */
const CREDIT_LEVELS = [
  { min: 120, max: 150, key: 'excellent', limit: 5 },
  { min: 100, max: 119, key: 'good', limit: 3 },
  { min: 80, max: 99, key: 'normal', limit: 2 },
  { min: 60, max: 79, key: 'weak', limit: 1 },
  { min: 0, max: 59, key: 'limited', limit: 0 }
]
function creditLevelOf(score) {
  const s = Math.min(150, Math.max(0, Math.round(Number(score) || 0)))
  const lv = CREDIT_LEVELS.find(l => s >= l.min && s <= l.max)
  return lv ? lv.key : 'normal'
}
/**
 * 该信用分最多可同时进行的订单数
 * @param {Number|String} scoreOrLevel 信用分，或等级 key
 * @returns {Number} 0 表示禁止下单
 */
function orderLimitOf(scoreOrLevel) {
  if (typeof scoreOrLevel === 'string') {
    const byKey = CREDIT_LEVELS.find(l => l.key === scoreOrLevel)
    return byKey ? byKey.limit : 1
  }
  const s = Math.min(150, Math.max(0, Math.round(Number(scoreOrLevel) || 0)))
  const lv = CREDIT_LEVELS.find(l => s >= l.min && s <= l.max)
  return lv ? lv.limit : 1
}

/**
 * 变更用户信用分并写流水
 * @param {String} openid
 * @param {Number} change 正负
 * @param {String} reason 规则 key
 * @param {String} reasonText 中文说明
 * @param {String} orderId
 * @returns {Promise<Number>} 变更后的分数
 */
async function changeCredit(openid, change, reason, reasonText, orderId) {
  if (!change) return null
  const u = await getUser(openid)
  if (!u) return null
  // ★ 用 `|| 100` 会出**静默的数据损坏**：信用分降到 0 之后，
  //   0 是假值会被当成「缺失」，于是下一次任何变动都从 100 起算 ——
  //   一个 0 分用户收到 5 星评价会直接从 0 跳到 101，
  //   而 credit_logs 记的就是 101，**对账时看不出异常**。
  //   所以只在「真的不是数字」时才兜底 100。
  const base = Number.isFinite(u.creditScore) ? u.creditScore : 100
  const score = Math.min(150, Math.max(0, base + change))
  await db.collection(C.USERS).doc(u._id).update({
    data: { creditScore: score, creditLevel: creditLevelOf(score), updateTime: now() }
  })
  await db.collection(C.CREDIT_LOGS).add({
    data: {
      _openid: openid,
      change,
      score,
      reason: reason || 'other',
      reasonText: reasonText || '信用分变动',
      orderId: orderId || '',
      createTime: now()
    }
  })
  // 信用分跨过 120 时补发「信用之星」徽章
  const badges = (u.badges || []).slice()
  if (score >= 120 && badges.indexOf('trust') < 0) {
    badges.push('trust')
    await db.collection(C.USERS).doc(u._id).update({ data: { badges } })
  }
  return score
}

/* ============================ 时间币流水 ============================ */
/**
 * 写一条时间币流水
 * @param {Object} p { openid, type, amount, balance, frozen, orderId, orderNo, remark }
 */
async function addWalletLog(p) {
  return db.collection(C.WALLET_LOGS).add({
    data: {
      _openid: p.openid,
      type: p.type,
      amount: p.amount,
      balance: p.balance,
      frozen: p.frozen || 0,
      orderId: p.orderId || '',
      orderNo: p.orderNo || '',
      remark: p.remark || '',
      createTime: now()
    }
  })
}

/* ============================ 系统通知 ============================ */
/**
 * 写一条系统通知
 * @param {Object} p { openid, type, title, content, orderId }
 */
async function addNotice(p) {
  return db.collection(C.NOTICES).add({
    data: {
      _openid: p.openid,
      type: p.type || 'system',
      title: p.title || '',
      content: p.content || '',
      orderId: p.orderId || '',
      read: false,
      createTime: now()
    }
  })
}

/* ============================ 订阅消息 ============================ */
/**
 * 发送订阅消息（失败不抛错，只记日志，绝不阻断主流程）
 * @param {Object} p { openid, templateId, page, data }
 */
async function sendSubscribe(p) {
  if (!p || !p.templateId || !p.openid) return { skipped: true }
  try {
    const res = await cloud.openapi.subscribeMessage.send({
      touser: p.openid,
      templateId: p.templateId,
      page: p.page || 'pages/order/list/list',
      miniprogramState: 'developer',   // 上线前改成 'formal'
      lang: 'zh_CN',
      data: p.data || {}
    })
    return res
  } catch (e) {
    console.warn('[subscribeMessage] 发送失败：', e.errCode, e.errMsg)
    return { error: e.errMsg || String(e) }
  }
}

/* ============================ 领域工具 ============================ */
/**
 * 构造技能的作者快照（冗余存储，列表页免联表）
 */
function authorSnapshot(user) {
  return {
    nickName: user.nickName || '匿名同学',
    avatarUrl: user.avatarUrl || '',
    // 0 分是合法值，不能走 `|| 100`
    creditScore: Number.isFinite(user.creditScore) ? user.creditScore : 100,
    creditLevel: user.creditLevel || 'good',
    authStatus: user.authStatus || 0
  }
}

/**
 * 构造订单参与者快照
 */
function partySnapshot(user) {
  return {
    nickName: user.nickName || '匿名同学',
    avatarUrl: user.avatarUrl || '',
    creditScore: Number.isFinite(user.creditScore) ? user.creditScore : 100
  }
}

/** 计算技能当前是否允许下单 */
function canOrderSkill(skill, buyer, config) {
  if (!skill) throw new BizError(404, '技能不存在或已被删除')
  if (skill.status !== 1) throw new BizError(409, '该技能已下架，暂时无法下单')
  if (skill.authorId === buyer._openid) throw new BizError(409, '不能购买自己发布的服务')
  if (buyer.authStatus !== 2) throw new BizError(403, '请先完成校园认证')
  // ★ 门槛用 `|| 60` 会让管理员**关不掉信用门槛**：
  //   把 minCreditToOrder 设为 0 本意是「不限制」，但 0 是假值会被顶成 60，
  //   于是后端继续拦、报错文案也写着 60，与后台配置对不上。
  const minCredit = Number.isFinite(config && config.minCreditToOrder) ? config.minCreditToOrder : 60
  if ((buyer.creditScore || 0) < minCredit) {
    throw new BizError(403, `信用分低于 ${minCredit}，暂不能下单`)
  }
  if ((buyer.coins || 0) < skill.price) {
    throw new BizError(409, `时间币不足，还差 ${skill.price - (buyer.coins || 0)} 枚`)
  }
  return true
}

/**
 * 隐私字段过滤：对外（他人可见）暴露用户信息时**必须**先过这一层。
 *
 * ⚠️ 这是黑名单式过滤，新增敏感字段时**务必同步加到这里**，否则会静默泄露。
 * 目前会剔除：
 *   phone       手机号
 *   studentNo   学号
 *   realName    真实姓名 —— 校园认证提交的身份证姓名，只有本人与管理端可见
 *   authImages  学生证/校园卡照片 fileID
 *   authRemark  认证驳回原因（属于本人与管理员之间的沟通，不对外）
 *
 * 保留（公开可见）：_id / _openid / nickName / avatarUrl / gender / campus /
 *   college / major / grade / bio / tags / authStatus / coins? / creditScore /
 *   creditLevel / badges / stats / locationName / createTime
 */
const PUBLIC_USER_BLACKLIST = ['phone', 'studentNo', 'realName', 'authImages', 'authRemark']

function publicUser(u) {
  if (!u) return null
  const o = Object.assign({}, u)
  PUBLIC_USER_BLACKLIST.forEach(k => { delete o[k] })
  return o
}

/* ============================ 统一入口包装 ============================ */
/**
 * 把「内部异常」翻译成**可以给用户看**的中文。
 *
 * ★ 为什么不直接把 `e.message` 返回给客户端：
 *   数据库/驱动的原始报错长这样 —— `collection.get:fail -502005da`，
 *   用户看不懂，看起来还像是小程序坏了；而且会泄露集合名、错误码等内部信息。
 *   真正的排查信息仍然完整打在云函数日志里，这里只给一句能指导操作的提示。
 */
function friendlyError(e) {
  const raw = String((e && (e.message || e.errMsg)) || '')
  if (/collection.*not exist|-502005/i.test(raw)) {
    return '数据尚未初始化，请先在云开发控制台执行 initdb 云函数的 init'
  }
  if (/permission denied|-502003/i.test(raw)) {
    return '数据权限不足，请检查数据库集合的权限设置'
  }
  if (/collection.*already exist/i.test(raw)) {
    return '集合已存在'
  }
  if (/timeout|ETIMEDOUT|socket hang up/i.test(raw)) {
    return '请求超时，请稍后重试'
  }
  if (/duplicate|E11000/i.test(raw)) {
    return '数据已存在，请勿重复提交'
  }
  return '服务异常，请稍后再试'
}

/**
 * 包装云函数 handler，统一 try/catch 与错误码
 * @param {Function} handler async (event, context, ctx) => data
 */
function wrap(handler) {
  return async (event, context) => {
    const action = (event && event.action) || ''
    try {
      /*
       * ★ 只有**带了令牌**才去查会话。
       *
       *   两个理由：
       *   ① 性能：绝大多数请求（普通微信用户）没有令牌，不该白白多一次异步挂起。
       *   ② 正确性：无令牌时保持「进入 handler 前不挂起」，
       *      这样 getOpenId() 在 handler 的第一个 await 之前就能拿到身份。
       *      （测试桩的 __setOpenId 是模块级变量、不隔离；真实云开发的
       *        getWXContext() 虽是请求隔离的，但少一次挂起总是更稳。）
       */
      const token = event && event.__token
      const sess = token ? await resolveSession(token) : null
      const data = await identityAls.run(
        sess ? { openid: sess.openid, account: sess.session } : {},
        () => handler(event || {}, context || {})
      )
      return ok(data)
    } catch (e) {
      // 业务异常：消息本来就是写给用户看的，原样返回
      if (e && e.__biz) return fail(e.code, e.message)
      // 非预期异常：详情进日志，客户端只拿可读提示
      console.error(`[${(context && context.function_name) || 'fn'}] action=${action} 异常：`, e)
      return fail(500, friendlyError(e))
    }
  }
}

/* ============================ 校园范围（安全策略） ============================ */
/**
 * 校园中心与有效半径（米）。
 *
 * ★ 这是一条**安全策略**，不是普通参数校验：任务只能发布在校内 ——
 *   校外的地点一旦出现纠纷或意外，学校无法及时介入处理。
 *   客户端（地图选点页 / 发布页）会拦，但客户端校验可被绕过，
 *   **云端这一层才是最后一道防线**。
 *
 * ★ 坐标基准：1 栋（山下男生宿舍）北纬 23°0'13"、东经 112°49'6"。
 *   最远的校内地点（新操场）距中心约 677 米，半径取 1200 米留出余量。
 * ★ 与 Campus Time Bank/utils/campus.js 的 CENTER / RADIUS 必须保持一致。
 */
const CAMPUS_CENTER = { lat: 23.003611, lng: 112.818333 }
const CAMPUS_RADIUS = 1200

/** 两点间球面距离（米） */
function distanceMeters(lat1, lng1, lat2, lng2) {
  const R = 6371000
  const rad = d => (d * Math.PI) / 180
  const dLat = rad(lat2 - lat1)
  const dLng = rad(lng2 - lng1)
  const a = Math.sin(dLat / 2) ** 2 +
    Math.cos(rad(lat1)) * Math.cos(rad(lat2)) * Math.sin(dLng / 2) ** 2
  return Math.round(R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a)))
}

/** 坐标是否在校园范围内 */
function isInsideCampus(lat, lng) {
  return distanceMeters(CAMPUS_CENTER.lat, CAMPUS_CENTER.lng, Number(lat), Number(lng)) <= CAMPUS_RADIUS
}

/**
 * 校验坐标必须在校内，否则抛业务错误。
 * 文案刻意说得明确 —— 用户要知道**为什么**不能选校外，而不是单纯被拒。
 */
function assertInsideCampus(lat, lng) {
  if (isInsideCampus(lat, lng)) return
  throw bizError(400, '只能发布校内地点。校外的任务一旦出现纠纷或意外，校方无法及时处理，请重新选择校内的位置')
}

module.exports = {
  cloud, db, _, $, C,
  ok, fail, bizError, BizError, assert, wrap, friendlyError,
  now, hoursLater, daysAgo, startOfDay, lastNDays, pad, genOrderNo,
  parsePage, paginateQuery,
  getOpenId, getUser, requireUser, requireVerified, requireAdmin, requireDebugger,
  ROLE, isAdminUser, isDebuggerUser,
  // 内部账户
  ACCOUNT_PREFIX, SESSION_TTL, newSalt, newToken, hashPassword, safeEqual,
  resolveSession, currentAccount,
  getConfig, DEFAULT_CONFIG,
  creditLevelOf, orderLimitOf, changeCredit, CREDIT_LEVELS,
  addWalletLog, addNotice, sendSubscribe,
  authorSnapshot, partySnapshot, canOrderSkill, publicUser,
  CAMPUS_CENTER, CAMPUS_RADIUS, distanceMeters, isInsideCampus, assertInsideCampus
}
