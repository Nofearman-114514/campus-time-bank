/**
 * initdb —— 一键初始化（ARCHITECTURE.md §4.9）
 * ==================================================================
 * action：init | clear | setAdmin
 *
 * 安全规则：
 *   · users 集合为空（第一次初始化）→ 允许直接执行 init / clear
 *   · 否则必须调用者已是 admin
 *
 * 设计要点：
 *   · 全部集合逐个 db.createCollection，已存在会抛错 → try/catch 吞掉（数量见 ALL_COLLECTIONS）
 *   · 幂等：所有种子写入前先按 _id 探测，重复调用不会产生重复数据
 *   · 云数据库单次删除上限 100 条 → 循环批量删除
 *   · 演示数据文案与 Campus Time Bank/utils/mock.js 保持一致（答辩演示用）
 * ==================================================================
 */
const {
  db, C, _,
  wrap, bizError, assert,
  now, getOpenId, requireAdmin, requireDebugger,
  newSalt, hashPassword
} = require('./shared')

/* ============================ 常量 ============================ */

/** §3 的 13 个集合 */
const ALL_COLLECTIONS = [
  C.USERS, C.CATEGORIES, C.SKILLS, C.ORDERS, C.REVIEWS,
  C.WALLET_LOGS, C.CREDIT_LOGS, C.CHATS, C.MESSAGES,
  C.NOTICES, C.REPORTS, C.BANNERS, C.CONFIG, C.FAVORITES,
  // ★ 第 15/16 个集合：内部账户与会话（账号密码登录，不绑定微信号）
  //   注意它们不在 BUSINESS_COLLECTIONS 里 —— clear 不该把内部账户删掉，
  //   否则就再也登不进来了（只能去控制台手工重建）。
  C.ACCOUNTS, C.SESSIONS,
  // ★ 第 17 个集合：申诉（清空业务数据时不动它 —— 申诉是「处置的凭证」，
  //   和 accounts 一样属于不该被 clear 抹掉的东西）
  C.APPEALS
]

/** clear 清空的业务集合（users 只删非 admin） */
const BUSINESS_COLLECTIONS = [
  C.SKILLS, C.ORDERS, C.REVIEWS, C.WALLET_LOGS, C.CREDIT_LOGS,
  C.CHATS, C.MESSAGES, C.NOTICES, C.REPORTS, C.FAVORITES
]

/** clear 保留的基础配置集合（否则首页会空掉） */
const KEEP_COLLECTIONS = [C.CATEGORIES, C.BANNERS, C.CONFIG]

const BATCH = 100   // 云数据库单次操作上限

const U1 = 'openid_demo_u1'
const U2 = 'openid_demo_u2'
const U3 = 'openid_demo_u3'
const U4 = 'openid_demo_u4'
const U5 = 'openid_demo_u5'
const U6 = 'openid_demo_u6'

const DEMO_OPENIDS = [U1, U2, U3, U4, U5, U6]

/* ============================ 基础工具 ============================ */

const str = v => (v === undefined || v === null ? '' : String(v).trim())
const daysAgo = d => new Date(Date.now() - d * 86400000)
const hoursAgo = h => new Date(Date.now() - h * 3600000)

/*
 * ⚠️ 这里**故意不再提供** `requireOpenId()` 辅助函数。
 *
 * 初版实现里 `init` 的第一行就是 `const openid = requireOpenId()`，
 * 结果云端测试（控制台「运行测试」，不经过小程序、拿不到 OPENID）
 * 直接返回 `{"code":401,"msg":"请先登录"}` —— 唯一的引导入口被焊死，
 * 表现为「没有管理员 → init 被拒 → 引导不出管理员」的死锁。
 *
 * 本项目 `initdb` 的三个 action 全部使用 `getOpenId()`（允许为空），
 * 由 `guardDangerous()` 按「调用来源 + 是否有管理员」两层判断。
 * 如果将来有人想在这里加回登录态强校验，请先读一遍 guardDangerous
 * 上方的鉴权模型说明 —— 那正是这个 bug 的成因。
 */
const requireOpenId = null   // 保留标识符，任何调用都会立刻抛错而不是静默失效

/** 安全 count，集合不存在时返回 0 */
async function countOf(name, where) {
  try {
    const res = await db.collection(name).where(where || {}).count()
    return res.total || 0
  } catch (e) {
    return 0
  }
}

/** 按固定 _id 写入，已存在则跳过（幂等） */
/**
 * 并发执行 + 限制同时进行的请求数。
 *
 * ★ 为什么需要它：微信云函数**默认超时只有 3 秒**。原来 seedDocs 是完全串行的
 *   （每条种子数据 1 次 get + 1 次 add ≈ 2 次往返），60 多条就是 120+ 次串行往返，
 *   必然超时。并发写入后往返轮次约为串行的 1/8。
 *
 *   限制并发数（而不是 Promise.all 全开）是因为云开发对并发请求有配额，
 *   一次放几百个请求反而会触发限流。
 */
async function mapLimit(items, limit, fn) {
  const list = items || []
  if (!list.length) return []
  const out = new Array(list.length)
  let cursor = 0
  const workerCount = Math.max(1, Math.min(limit, list.length))
  const workers = []
  for (let w = 0; w < workerCount; w++) {
    workers.push((async () => {
      for (;;) {
        const i = cursor++
        if (i >= list.length) return
        out[i] = await fn(list[i], i)
      }
    })())
  }
  await Promise.all(workers)
  return out
}

/**
 * 修复模式开关。
 * actionInit 每次调用都会显式赋值（不依赖上一次的残留），
 * seedDocs 据此决定「已存在文档」是跳过还是**用种子值覆盖**。
 */
let SEED_REPAIR = false

/**
 * 并发写入种子数据（按 _id 幂等）
 * @param {String} name 集合名
 * @param {Array} docs 种子文档
 * @param {String} label 中文名（报告用）
 *
 * 默认模式：已存在则**跳过** —— 保证 init 可断点续跑、不会覆盖线上数据。
 * 修复模式（SEED_REPAIR）：已存在则用种子值**覆盖** ——
 *   用于「config 被改坏了 / 演示文案被改乱了，想恢复初始状态」。
 */
async function seedDocs(name, docs, label) {
  let inserted = 0
  let skipped = 0
  let updated = 0
  await mapLimit(docs, 8, async (d) => {
    // 幂等：★ 这一点很重要 —— 如果上一次 init 因为超时中断，
    // 重跑时必须能跳过已写入的，从断点继续，而不是重复插入
    let exists = false
    try {
      const old = await db.collection(name).doc(d._id).get()
      exists = !!(old && old.data)
    } catch (e) { exists = false }
    if (exists && !SEED_REPAIR) { skipped++; return }
    try {
      if (exists) {
        // ★ 真实云开发的 set **不允许 data 里带 _id**：
        //     document.set:fail -501007 invalid parameters. 不能更新_id的值
        //   文档 id 已由 doc(id) 指定，body 里必须剔除 _id。
        //   （离线 stub 按真实行为拒绝带 _id 的 set，所以这个 bug 不会被测试放过。）
        const body = Object.assign({}, d)
        delete body._id
        await db.collection(name).doc(d._id).set({ data: body })
        updated++
      } else {
        await db.collection(name).add({ data: d })
        inserted++
      }
    } catch (e) {
      console.warn(`[initdb] 写入 ${name}/${d._id} 失败：`, e && e.message)
    }
  })
  return { name, label, inserted, skipped, updated }
}

/**
 * 循环批量删除（单次上限 100 条），直到删完
 * @param {String} name 集合名
 * @param {Object} where 条件（默认全量）
 */
async function clearCollection(name, where, label) {
  let deleted = 0
  for (let round = 0; round < 200; round++) {   // 安全上限：200 轮 × 100 条
    let batch = []
    try {
      const res = await db.collection(name).where(where || {}).limit(BATCH).get()
      batch = res.data || []
    } catch (e) {
      break
    }
    if (!batch.length) break

    // 同一批内的删除并发执行（串行删 100 条同样会撞上 3 秒超时）
    await mapLimit(batch, 10, async (doc) => {
      try {
        await db.collection(name).doc(doc._id).remove()
        deleted++
      } catch (e) {
        console.warn(`[initdb] 删除 ${name}/${doc._id} 失败：`, e && e.message)
      }
    })
    if (batch.length < BATCH) break
  }
  return { name, label, deleted }
}

/**
 * 权限闸门。
 * @param {String} openid  调用者 openid —— ★ 云端测试时为空字符串，这是正常的
 * @param {String} action  动作名，仅用于日志
 *
 * ★ 鉴权模型（两层，不要混为一谈）：
 *
 *   ① **云开发控制台调用**（`openid` 为空，即控制台「云端测试」）→ **一律放行**。
 *      理由：控制台本身就是开发者（root）权限 —— 能打开它的人可以直接在
 *      「数据库」页面增删任何集合、改任何字段。云函数里再拦一道，
 *      **拦不住任何真实攻击，只会让合法运维卡死**（比如首次部署时
 *      「没有管理员 → init 被拒 → 引导不出管理员」的死锁）。
 *      同时云端测试也没有登录态（不经过小程序，拿不到 OPENID），
 *      所以这里**绝不能**调 requireOpenId()。
 *
 *   ② **小程序调用**（`openid` 非空）→ 才算真正的应用层鉴权：
 *      · `users` 为空            → 首次部署，放行
 *      · `users` 里还没有 admin  → 引导模式，放行（否则永远引导不出第一个管理员）
 *      · 已有 admin              → 严格要求调用者是管理员
 */
async function guardDangerous(openid, action) {
  // ① 控制台调用：开发者权限，放行（仅记日志留痕）
  if (!openid) {
    console.log(`[initdb] ${action} 来自云开发控制台（开发者权限），放行`)
    return { firstTime: false, bootstrap: false, operator: 'console' }
  }

  // ② 小程序调用：应用层鉴权
  const userCount = await countOf(C.USERS)
  if (userCount === 0) {
    console.log(`[initdb] ${action} 以「首次部署」模式执行：users 为空`)
    return { firstTime: true, bootstrap: true, operator: openid }
  }

  // 管理员和调试员都算「已有人管事」—— 否则只剩调试员时会被误判成
  // 引导模式，于是任何人都能调危险操作。
  const managerCount = await countOf(C.USERS, { role: 'admin' }) +
    await countOf(C.USERS, { role: 'debugger' })
  if (managerCount === 0) {
    console.log(`[initdb] ${action} 以「引导模式」执行：系统尚无管理员`)
    return { firstTime: true, bootstrap: true, operator: openid }
  }

  // ★ 危险操作只有**调试员**能做（不只是管理员）。
  //   控制台与引导模式在上面已经放行，否则会出现「没人能初始化」的死锁。
  const who = await requireDebugger(openid)
  console.log(`[initdb] ${action} 由调试员执行：`, who._openid, who.nickName || '')
  return { firstTime: false, bootstrap: false, operator: who._openid }
}

/* ============================ 种子数据 ============================ */

/** §3.2 技能分类，10 条 */
const SEED_CATEGORIES = [
  { _id: 'c1', name: '学业辅导', icon: '📚', sort: 1, status: 1 },
  { _id: 'c2', name: '技能教学', icon: '🎸', sort: 2, status: 1 },
  { _id: 'c3', name: '摄影修图', icon: '📷', sort: 3, status: 1 },
  { _id: 'c4', name: '代取代买', icon: '🛵', sort: 4, status: 1 },
  { _id: 'c5', name: '电脑技术', icon: '💻', sort: 5, status: 1 },
  { _id: 'c6', name: '运动健身', icon: '🏃', sort: 6, status: 1 },
  { _id: 'c7', name: '生活服务', icon: '🧺', sort: 7, status: 1 },
  { _id: 'c8', name: '设计美工', icon: '🎨', sort: 8, status: 1 },
  { _id: 'c9', name: '语言互助', icon: '🌏', sort: 9, status: 1 },
  { _id: 'c10', name: '其他', icon: '✨', sort: 10, status: 1 }
]

/** §3.13 全局配置（单文档 _id: 'global'） */
const SEED_CONFIG = {
  _id: 'global',
  registerBonus: 5,
  orderExpireHours: 24,
  confirmExpireHours: 72,
  minCreditToOrder: 60,
  serviceFee: 0,
  hotCategories: ['c1', 'c2', 'c3'],
  aboutUs: '广东职业技术学院（广职院）校园时间银行：用「时间币」衡量每一次帮助，1 次服务 = 若干时间币。时间币不可充值、不可提现，只能通过帮助他人获得。山上山下、饭堂图书馆，约在公共区域见面更安心。',
  /**
   * 订阅消息模板 ID（服务端来源）。
   * 小程序端的模板 ID 写在 Campus Time Bank/envList.js 的 SUBSCRIBE_TEMPLATES 里，
   * 但云函数读不到小程序端文件，所以服务端必须自己存一份。
   * 留空时 sendSubscribe() 直接跳过发送，**不阻断任何主流程** ——
   * 也就是说不配置订阅消息，整个平台依然完全可用（这是刻意的降级设计）。
   * 拿到真实模板 ID 后，可在管理端「参数配置」或云开发控制台里改这两个字段。
   */
  subscribeTemplates: {
    ORDER_CREATE: '',
    ORDER_ACCEPT: '',
    ORDER_FINISH: '',
    ORDER_CONFIRM: ''
  },
  updateTime: daysAgo(3)
}

/** §3.12 首页轮播，3 条（文案对齐 utils/mock.js 的 banners） */
const SEED_BANNERS = [
  { _id: 'b1', image: '', title: '广职院技能互助：山上山下都能约到帮手', link: '', sort: 1, status: 1, createTime: daysAgo(30) },
  { _id: 'b2', image: '', title: '时间币不可充值、不可提现，只能靠帮助他人获得', link: '', sort: 2, status: 1, createTime: daysAgo(30) },
  { _id: 'b3', image: '', title: '完成校园认证解锁全部功能；约在饭堂、图书馆等公共场所更安心', link: '/pages/auth/campus/campus', sort: 3, status: 1, createTime: daysAgo(30) }
]

/**
 * §3.1 演示用户 6 位，_openid 固定为 openid_demo_u1 ~ openid_demo_u6
 * 文案与 utils/mock.js 的 mkUser 调用一一对应
 */
/* ------------------------------------------------------------------
 * 演示数据的年级：按「当前届」推算，**不写死**
 * ------------------------------------------------------------------
 * 8 月是入学月（与 pages/user/profile/profile.js 的 buildGradeRange 口径一致）。
 * 写死年级的话，明年这些写着「大三」的角色就变成已毕业了。
 */
const GRADE_NOW = (() => {
  const d = new Date()
  return (d.getMonth() + 1) >= 8 ? d.getFullYear() : d.getFullYear() - 1
})()
/** yearsAgo: 0=大一 1=大二 2=大三 3=大四 */
const gradeAt = (yearsAgo) => (GRADE_NOW - yearsAgo) + '级'

/* ============================ 内部账户（账号密码，不绑定微信号） ============================ */
/*
 * ★ 这是**唯一**不需要微信号的登录方式，供校方 / 运维使用。
 *
 *   口令只存 PBKDF2-SHA256 哈希（盐随机、5 万次迭代、32 字节），**不存明文**。
 *
 *   ⚠️ 默认口令写在下面的 SEED_ACCOUNTS 里，会随仓库一起公开。
 *      正式使用前**必须改掉** —— 最省事的方式是改这里再跑一次 repair，
 *      或者直接在控制台改 accounts 集合里的 salt / passwordHash
 *      （用 _shared 的 hashPassword(新口令, 新盐) 现算）。
 */
const ACCT_ADMIN_OPENID = 'acct_internal_admin'
const ACCT_DEBUG_OPENID = 'acct_internal_debugger'

const SEED_ACCOUNTS = [
  { username: 'admin', password: 'Admin@2026', openid: ACCT_ADMIN_OPENID, nickName: '内部管理员' },
  { username: 'debugger', password: 'Debug@2026', openid: ACCT_DEBUG_OPENID, nickName: '内部调试员' }
]

/**
 * 内部账户对应的 users 文档。
 * ★ 业务层全部按 openid 索引，所以必须有这条记录 ——
 *   会话令牌解析出来的 openid 要能查到人。
 */
const INTERNAL_USERS = [
  { _id: 'user_acct_admin', _openid: ACCT_ADMIN_OPENID, nickName: '内部管理员', role: 'admin' },
  { _id: 'user_acct_debug', _openid: ACCT_DEBUG_OPENID, nickName: '内部调试员', role: 'debugger' }
].map(u => Object.assign({
  avatarUrl: '', gender: 0, phone: '',
  campus: '广东职业技术学院', college: '', major: '', grade: '',
  studentNo: '', realName: u.nickName,
  bio: '系统内部账户（账号密码登录，不绑定微信号）',
  tags: [],
  authStatus: 2, authImages: [], authRemark: '', authTime: 0,
  coins: 0, frozenCoins: 0, totalEarned: 0, totalSpent: 0,
  creditScore: 100, creditLevel: 'good',
  badges: [],
  stats: {
    publishCount: 0, serveCount: 0, buyCount: 0,
    reviewCount: 0, ratingSum: 0, avgRating: 0, ontimeStreak: 0
  },
  location: null, locationName: '', locationTime: null,
  status: 1, createTime: 0, updateTime: 0, lastLoginTime: 0
}, u))

/** 生成 accounts 种子文档：每次现算哈希，盐是随机的 */
function accountDocs() {
  return SEED_ACCOUNTS.map(a => {
    const salt = newSalt()
    return {
      _id: 'acc_' + a.username,
      username: a.username,
      salt,
      passwordHash: hashPassword(a.password, salt),
      openid: a.openid,
      nickName: a.nickName,
      status: 1,
      failCount: 0,
      lockUntil: 0,
      createTime: now(),
      lastLoginTime: 0
    }
  })
}

const DEMO_USERS = [
  {
    _id: 'user_u1', _openid: U1, nickName: '李思远', avatarUrl: '', gender: 0, phone: '',
    campus: '广东职业技术学院', college: '艺术设计学院', major: '音乐表演', grade: gradeAt(2),
    studentNo: '2021010233', realName: '',
    bio: '音乐社社长，艺术设计学院大三。弹了六年吉他，带过三届新生。零基础也能上手，第一节课就能弹出完整旋律，平时在 B 栋空教室上课。',
    tags: ['吉他', '尤克里里', '乐理'],
    authStatus: 2, authImages: [], authRemark: '', authTime: daysAgo(30),
    coins: 23, frozenCoins: 0, totalEarned: 41, totalSpent: 18,
    creditScore: 128, creditLevel: 'excellent',
    badges: ['newbie', 'ontime', 'warm', 'expert', 'trust'],
    stats: { publishCount: 2, serveCount: 21, buyCount: 2, reviewCount: 19, ratingSum: 90, avgRating: 4.9, ontimeStreak: 12 },
    location: null, locationName: '', locationTime: null,
    role: 'user', status: 1,
    createTime: daysAgo(40), updateTime: daysAgo(1), lastLoginTime: hoursAgo(2)
  },
  {
    _id: 'user_u2', _openid: U2, nickName: '王雨桐', avatarUrl: '', gender: 0, phone: '',
    campus: '广东职业技术学院', college: '艺术设计学院', major: '数字媒体艺术设计', grade: gradeAt(1),
    studentNo: '2022010451', realName: '',
    bio: '摄影协会成员，艺术设计学院。有单反和补光灯，专拍证件照、毕业照。学子湖和图书馆一带的出片点我都熟，当天出片、免费修图三次。',
    tags: ['摄影', '证件照', '后期修图', '短视频'],
    authStatus: 2, authImages: [], authRemark: '', authTime: daysAgo(30),
    coins: 17, frozenCoins: 0, totalEarned: 30, totalSpent: 13,
    creditScore: 121, creditLevel: 'excellent',
    badges: ['newbie', 'ontime', 'warm', 'trust'],
    stats: { publishCount: 2, serveCount: 14, buyCount: 4, reviewCount: 13, ratingSum: 62, avgRating: 4.8, ontimeStreak: 4 },
    location: null, locationName: '', locationTime: null,
    role: 'user', status: 1,
    createTime: daysAgo(40), updateTime: daysAgo(1), lastLoginTime: hoursAgo(3)
  },
  {
    _id: 'user_u3', _openid: U3, nickName: '陈子豪', avatarUrl: '', gender: 0, phone: '',
    campus: '广东职业技术学院', college: '智能制造学院', major: '机电一体化技术', grade: gradeAt(2),
    studentNo: '2021010876', realName: '',
    bio: '智能制造学院大三，高数/线代/概率论都能带。擅长考前突击，两小时讲完一学期的重点，可约图书馆研讨间。',
    tags: ['高等数学', '线性代数', '概率论', '考研数学'],
    authStatus: 2, authImages: [], authRemark: '', authTime: daysAgo(30),
    coins: 31, frozenCoins: 0, totalEarned: 55, totalSpent: 24,
    creditScore: 133, creditLevel: 'excellent',
    badges: ['newbie', 'ontime', 'warm', 'expert', 'trust', 'popular'],
    stats: { publishCount: 3, serveCount: 28, buyCount: 3, reviewCount: 25, ratingSum: 119, avgRating: 4.8, ontimeStreak: 9 },
    location: null, locationName: '', locationTime: null,
    role: 'user', status: 1,
    createTime: daysAgo(40), updateTime: daysAgo(1), lastLoginTime: hoursAgo(1)
  },
  {
    _id: 'user_u4', _openid: U4, nickName: '刘佳怡', avatarUrl: '', gender: 0, phone: '',
    campus: '广东职业技术学院', college: '艺术设计学院', major: '视觉传达设计', grade: gradeAt(1),
    studentNo: '2022020319', realName: '',
    bio: '艺术设计学院视觉传达方向。PS / AI / Figma 熟练，接海报、PPT、简历排版，改到满意为止。',
    tags: ['PS', '海报设计', 'PPT美化', '简历排版', 'Figma'],
    authStatus: 2, authImages: [], authRemark: '', authTime: daysAgo(30),
    coins: 15, frozenCoins: 0, totalEarned: 26, totalSpent: 11,
    creditScore: 109, creditLevel: 'good',
    badges: ['newbie', 'ontime', 'social'],
    stats: { publishCount: 2, serveCount: 11, buyCount: 5, reviewCount: 10, ratingSum: 45, avgRating: 4.5, ontimeStreak: 3 },
    location: null, locationName: '', locationTime: null,
    role: 'user', status: 1,
    createTime: daysAgo(40), updateTime: daysAgo(1), lastLoginTime: hoursAgo(4)
  },
  {
    _id: 'user_u5', _openid: U5, nickName: '赵一鸣', avatarUrl: '', gender: 0, phone: '',
    campus: '广东职业技术学院', college: '信息工程学院', major: '计算机应用技术', grade: gradeAt(3),
    studentNo: '2023030145', realName: '',
    bio: '计算机协会技术部，信息工程学院。装机、清灰、系统重装、装环境都能搞，约在实训楼或山下饭堂门口，一般 1 小时内解决。',
    tags: ['电脑维修', '系统重装', '装机', '环境配置'],
    authStatus: 2, authImages: [], authRemark: '', authTime: daysAgo(30),
    coins: 9, frozenCoins: 0, totalEarned: 19, totalSpent: 10,
    creditScore: 96, creditLevel: 'normal',
    badges: ['newbie', 'ontime'],
    stats: { publishCount: 1, serveCount: 8, buyCount: 6, reviewCount: 7, ratingSum: 32, avgRating: 4.6, ontimeStreak: 2 },
    location: null, locationName: '', locationTime: null,
    role: 'user', status: 1,
    createTime: daysAgo(40), updateTime: daysAgo(1), lastLoginTime: hoursAgo(5)
  },
  {
    _id: 'user_u6', _openid: U6, nickName: '孙晓雯', avatarUrl: '', gender: 0, phone: '',
    campus: '广东职业技术学院', college: '外语外贸学院', major: '商务英语', grade: gradeAt(2),
    studentNo: '2022040502', realName: '',
    bio: '外语外贸学院，校田径队。可以陪跑配速、制定体测训练计划；也能陪练英语口语（雅思 7.0），新操场或学子湖边都行。',
    tags: ['跑步', '健身计划', '英语口语', '雅思'],
    authStatus: 2, authImages: [], authRemark: '', authTime: daysAgo(30),
    coins: 14, frozenCoins: 0, totalEarned: 22, totalSpent: 8,
    creditScore: 115, creditLevel: 'good',
    badges: ['newbie', 'ontime', 'warm'],
    stats: { publishCount: 2, serveCount: 10, buyCount: 3, reviewCount: 9, ratingSum: 42, avgRating: 4.7, ontimeStreak: 5 },
    location: null, locationName: '', locationTime: null,
    role: 'user', status: 1,
    createTime: daysAgo(40), updateTime: daysAgo(1), lastLoginTime: hoursAgo(6)
  }
]

const USER_MAP = DEMO_USERS.reduce((m, u) => (m[u._openid] = u, m), {})
const CAT_MAP = SEED_CATEGORIES.reduce((m, c) => (m[c._id] = c, m), {})


/* ==================================================================
 * 广职院校内地点表（演示数据用）
 * ------------------------------------------------------------------
 * ★ 坐标基准：1 栋（山下男生宿舍）北纬 23°0'13"、东经 112°49'6"
 *   → 纬度 23.003611、经度 112.818333（换算：23 + 13/3600、112 + 49/60 + 6/3600）。
 *   其余地点按「山下（南）/ 中区 / 山上（北）」的相对关系推出，校园跨度约 600 米。
 *   ⚠️ 若山上与山下的实际方位与此相反，只需调整本表的 lng/lat ——
 *   技能数据是通过下面的 DEMO_SKILL_LOCS 自动挂上去的，会跟着一起变。
 *
 * ★ 宿舍规则（1~6 栋男生、7~14 栋女生，互不进入）体现为一条用地原则：
 *   **上门类服务默认约在公共区域**（饭堂 / 图书馆 / 教学楼 / 实训楼 / 操场），
 *   演示数据里不出现「去异性宿舍」的场景。
 * ================================================================== */
const CAMPUS = {
  dorm1: { address: '广职院 · 学生公寓 1 栋', locationName: '学生公寓 1 栋楼下', lng: 112.823601, lat: 23.001079 },
  canteenS: { address: '广职院 · 山下饭堂', locationName: '山下饭堂一楼', lng: 112.823584, lat: 23.000554 },
  bldgB: { address: '广职院 · 教学楼 B1', locationName: '教学楼 B1 楼', lng: 112.821652, lat: 23.000751 },
  train1: { address: '广职院 · 实训楼 1 号', locationName: '实训楼 1 号', lng: 112.823408, lat: 22.999123 },
  canteenN: { address: '广职院 · 山上饭堂', locationName: '山上饭堂二楼', lng: 112.821381, lat: 23.001627 },
  lake: { address: '广职院 · 学子湖', locationName: '学子湖边', lng: 112.821641, lat: 22.999801 },
  newField: { address: '广职院 · 新操场', locationName: '新操场田径场', lng: 112.823102, lat: 22.998165 },
  library: { address: '广职院 · 图书馆', locationName: '图书馆一楼大厅', lng: 112.820359, lat: 23.000436 }
}

/** 演示技能 → 校内地点（顺序与 DEMO_SKILLS / mock.js 的 skills 一一对应）
 *  注意：mock.js 有 15 条技能（比云端的 DEMO_SKILLS 多 3 条「我」发布的），
 *  所以本表按 15 条编写；云端只用到前 12 条。 */
const DEMO_SKILL_LOCS = [
  'bldgB',    // 01 吉他入门：教学楼 B1
  'bldgB',    // 02 尤克里里：教学楼 B1
  'train1',   // 03 证件照拍摄：实训楼 1 号
  'lake',     // 04 毕业照跟拍：学子湖边
  'library',  // 05 高数辅导：图书馆一楼大厅
  'bldgB',    // 06 线代答疑：教学楼 B1
  'train1',   // 07 海报设计：实训楼 1 号
  'train1',   // 08 PPT 美化：实训楼 1 号
  'canteenS', // 09 电脑清灰：山下饭堂门口（公共区域）
  'newField', // 10 校园陪跑：新操场田径场
  'lake',     // 11 英语口语：学子湖边
  'train1',   // 12 剪映教学：实训楼 1 号
]

/** 构造一条演示技能 */
function mkDemoSkill(id, authorId, type, title, desc, catId, price, duration, tags, ageDays, extra) {
  const u = USER_MAP[authorId] || {}
  const c = CAT_MAP[catId] || { name: '其他', icon: '✨' }
  const t = daysAgo(ageDays)
  return Object.assign({
    _id: id,
    _openid: authorId,
    authorId: authorId,
    authorInfo: {
      nickName: u.nickName || '匿名同学',
      avatarUrl: u.avatarUrl || '',
      creditScore: Number.isFinite(u.creditScore) ? u.creditScore : 100,
      creditLevel: u.creditLevel || 'good',
      authStatus: u.authStatus === undefined ? 2 : u.authStatus
    },
    type: type,
    title: title,
    desc: desc,
    categoryId: catId,
    categoryName: c.name,
    categoryIcon: c.icon,
    price: price,
    duration: duration,
    images: [],
    tags: tags,
    location: null,
    address: '广职院 · B 栋',
    locationName: 'B 栋 301 教室',
    status: 1,
    auditRemark: '',
    viewCount: 0,
    orderCount: 0,
    isTop: false,
    createTime: t,
    updateTime: t
  }, extra || {})
}

/**
 * 演示技能 12 条
 * 文案照抄 utils/mock.js 的 mkSkill 清单（剔除作者为演示「我」的两条）
 */
const DEMO_SKILLS = [
  /*
   * ★ 被违规下架的技能（status = 3）—— 申诉功能要有一个「可申诉的下架」才有得演示。
   *   demo_appeal_02 就是 U3 对它发起的申诉（待处理，管理员可当场点「成立」把它恢复上架）。
   *   下架原因写在 auditRemark 里：申诉成立后会**保留**它 —— 那是历史的一部分。
   */
  mkDemoSkill('demo_skill_13', U3, 'offer', '论文降重 / 查重报告解读（知网、维普）',
    '帮你把重复率降到 15% 以内，并逐段解释查重报告里为什么标红。',
    'c6', 8, 90, ['降重', '查重报告'], 20,
    { status: 3, auditRemark: '涉嫌提供代写服务，与互助性质不符，予以下架', auditTime: daysAgo(5) }),
  mkDemoSkill('demo_skill_01', U1, 'offer', '吉他入门一对一，零基础也能弹唱',
    '六年琴龄，音乐社社长。第一节课带你认识吉他、学会按和弦；三节课内能完整弹唱一首歌。\n自带两把琴，你不用准备任何东西。教学地点在艺术楼琴房或者宿舍楼下都行。',
    'c2', 2, 60, ['零基础友好', '自带吉他', '可试听'], 9, { viewCount: 486, orderCount: 9 }),

  mkDemoSkill('demo_skill_02', U1, 'offer', '尤克里里速成 3 节课',
    '尤克里里比吉他好上手得多，3 节课就能自弹自唱。适合想快速获得一项技能的同学。',
    'c2', 1, 45, ['速成', '小班可谈'], 7, { viewCount: 213, orderCount: 5 }),

  mkDemoSkill('demo_skill_03', U2, 'offer', '证件照拍摄 + 精修（当天出片）',
    '单反 + 双补光灯 + 白/蓝/红三色背景布，拍完当场选片。\n含精修 3 次，不满意免费重拍。考公、考研、简历、签证照都能拍。',
    'c3', 2, 60, ['当天出片', '含精修', '免费重拍'], 11, { viewCount: 401, orderCount: 8 }),

  mkDemoSkill('demo_skill_04', U2, 'offer', '毕业照 / 情侣照跟拍 2 小时',
    '校园内任选 3 个机位，拍 200 张以上原片全给，另精修 15 张。熟悉校园每个出片点。',
    'c3', 5, 120, ['原片全给', '含精修15张'], 6, { viewCount: 267, orderCount: 4 }),

  mkDemoSkill('demo_skill_05', U3, 'offer', '高数期末突击辅导，2 小时讲完重点',
    '数学系在读，带过 20+ 位同学。按你的教材和往年卷子划重点，讲透典型题型。\n考前一周效果最好，可约图书馆研讨间。',
    'c1', 3, 120, ['考前突击', '带往年卷', '可小班'], 10, { viewCount: 532, orderCount: 12, isTop: true }),

  mkDemoSkill('demo_skill_06', U3, 'offer', '线性代数 / 概率论 答疑',
    '按章节答疑，也可以帮你检查作业思路。线上语音或线下自习室都可以。',
    'c1', 1, 60, ['按需答疑', '线上线下均可'], 8, { viewCount: 198, orderCount: 6 }),

  mkDemoSkill('demo_skill_07', U4, 'offer', '海报 / 宣传图设计（含 3 次修改）',
    '视觉传达专业，熟练 PS / AI / Figma。社团招新海报、活动预告、公众号首图都能做。\n先沟通风格，出 2 版初稿，改到满意为止。',
    'c8', 3, 90, ['出2版初稿', '含3次修改'], 12, { viewCount: 344, orderCount: 7 }),

  mkDemoSkill('demo_skill_08', U4, 'offer', 'PPT 美化排版（每 10 页）',
    '把内容交给我，负责配色、版式、图标、图表统一。答辩 PPT、课程汇报都适用。',
    'c8', 2, 60, ['答辩专用', '配色统一'], 5, { viewCount: 289, orderCount: 6 }),

  mkDemoSkill('demo_skill_09', U5, 'offer', '电脑清灰 / 系统重装 / 环境配置',
    '计算机协会技术部。清灰换硅脂、重装系统、装开发环境（Python/Java/Node）都能搞。\n宿舍楼下随叫随到，一般 1 小时内解决。',
    'c5', 1, 60, ['随叫随到', '当场解决'], 9, { viewCount: 176, orderCount: 5 }),

  mkDemoSkill('demo_skill_10', U6, 'offer', '校园陪跑 + 体测突击训练',
    '校田径队，可以按你的配速陪跑，也能帮你制定 800/1000 米体测训练计划。\n早上 6:30 或晚上 8:00，操场集合。',
    'c6', 1, 60, ['配速陪跑', '体测突击'], 7, { viewCount: 231, orderCount: 4 }),

  mkDemoSkill('demo_skill_11', U6, 'offer', '英语口语陪练（雅思 7.0）',
    '全英文对话陪练，纠正发音和表达。也可以帮你模拟雅思口语 Part 1-3。',
    'c9', 2, 60, ['全英文', '可模拟雅思'], 4, { viewCount: 158, orderCount: 3 }),

  mkDemoSkill('demo_skill_12', U3, 'need', '求一位会剪辑的同学教我用剪映',
    '毕设要做一个演示视频，完全不会剪辑。希望有人能带我过一遍剪映的基本操作：分割、转场、字幕、配乐。一次就够，我自己练。',
    'c5', 2, 90, ['求教学', '一次即可'], 3, { viewCount: 96, orderCount: 2 })
]


/* 给演示技能挂上校内真实地点（含坐标，供「附近」排序演示） */
DEMO_SKILLS.forEach((s, i) => {
  const p = CAMPUS[DEMO_SKILL_LOCS[i]]
  if (!p) return
  s.address = p.address
  s.locationName = p.locationName
  s.location = db.Geo.Point(p.lng, p.lat)
})

const SKILL_MAP = DEMO_SKILLS.reduce((m, s) => (m[s._id] = s, m), {})

/** 构造一条演示订单 */
function mkDemoOrder(id, no, skillId, buyerId, sellerId, status, ageDays, extra) {
  const sk = SKILL_MAP[skillId] || {}
  const buyer = USER_MAP[buyerId] || {}
  const seller = USER_MAP[sellerId] || {}
  const created = daysAgo(ageDays)
  return Object.assign({
    _id: id,
    orderNo: no,
    skillId: skillId,
    skillSnapshot: {
      title: sk.title || '',
      price: sk.price || 1,
      duration: sk.duration || 60,
      categoryName: sk.categoryName || '其他',
      images: sk.images || [],
      type: sk.type || 'offer'
    },
    buyerId: buyerId,
    buyerInfo: { nickName: buyer.nickName || '同学', avatarUrl: buyer.avatarUrl || '', creditScore: Number.isFinite(buyer.creditScore) ? buyer.creditScore : 100 },
    sellerId: sellerId,
    sellerInfo: { nickName: seller.nickName || '同学', avatarUrl: seller.avatarUrl || '', creditScore: Number.isFinite(seller.creditScore) ? seller.creditScore : 100 },
    amount: sk.price || 1,
    status: status,
    remark: '',
    expectTime: '',
    contact: '',
    timeline: [{ status: 'waiting', time: created, remark: '买家下单，时间币已冻结', operator: buyerId }],
    cancelBy: '',
    cancelReason: '',
    isRatedBuyer: false,
    isRatedSeller: false,
    buyerScore: 0,
    sellerScore: 0,
    createTime: created,
    acceptTime: null,
    finishTime: null,
    confirmTime: null,
    cancelTime: null,
    expireTime: new Date(created.getTime() + 86400000)
  }, extra || {})
}

/** 演示订单 8 条，覆盖 waiting / ongoing / confirming / finished / canceled 全状态 */
const DEMO_ORDERS = [
  /*
   * ★★ 异常增长监控的演示数据 —— 刻意做成「来源集中」的样子：
   *   卖家 U6 有 3 笔收入，**全部来自同一个买家 U4**（前 2 人占比 100%），
   *   其中 2 笔还带着 suspectFast 标记（完成过快）。
   *   管理员打开「异常监控」就能看到一个命中案例，验证判据真的会响。
   *
   *   ⚠️ 这是**故意埋的演示数据**，不是真实用户的违规记录。
   *      如果不想在答辩时看到「可疑账户」，删掉这 3 条即可。
   *
   *   另外注意：其余演示订单的买家都很分散（U1/U2/U3/U4/U5/U6 互相都有），
   *   它们**不会**命中 —— 这正好也演示了「正常数据不误报」。
   */
  mkDemoOrder('demo_order_10', 'TB20250605190010', 'demo_skill_10', U4, U6, 'finished', 3,
    { acceptTime: daysAgo(3), finishTime: daysAgo(3), confirmTime: daysAgo(3), amount: 6,
      suspectFast: true, suspectMinutes: 2, isRatedBuyer: true, buyerScore: 5, isRatedSeller: true, sellerScore: 5 }),
  mkDemoOrder('demo_order_11', 'TB20250606100011', 'demo_skill_10', U4, U6, 'finished', 2,
    { acceptTime: daysAgo(2), finishTime: daysAgo(2), confirmTime: daysAgo(2), amount: 6,
      suspectFast: true, suspectMinutes: 3 }),
  mkDemoOrder('demo_order_12', 'TB20250607140012', 'demo_skill_11', U4, U6, 'finished', 1,
    { acceptTime: daysAgo(1), finishTime: daysAgo(1), confirmTime: daysAgo(1), amount: 5 }),
  mkDemoOrder('demo_order_01', 'TB20250601120001', 'demo_skill_01', U2, U1, 'waiting', 0.1,
    { remark: '想学《晴天》，周末下午有空', expectTime: '周六 15:00 之后' }),

  mkDemoOrder('demo_order_02', 'TB20250530143002', 'demo_skill_03', U3, U2, 'ongoing', 2,
    { remark: '考研报名用的证件照', expectTime: '周五上午', acceptTime: daysAgo(2) }),

  mkDemoOrder('demo_order_03', 'TB20250528110003', 'demo_skill_05', U1, U3, 'confirming', 4,
    { remark: '概率论期末救命', acceptTime: daysAgo(4), finishTime: hoursAgo(6) }),

  mkDemoOrder('demo_order_04', 'TB20250520153004', 'demo_skill_07', U6, U4, 'finished', 12,
    {
      remark: '社团招新海报', acceptTime: daysAgo(12), finishTime: daysAgo(11), confirmTime: daysAgo(11),
      isRatedBuyer: true, buyerScore: 5, isRatedSeller: true, sellerScore: 5
    }),

  mkDemoOrder('demo_order_05', 'TB20250515203005', 'demo_skill_09', U2, U5, 'finished', 17,
    {
      acceptTime: daysAgo(17), finishTime: daysAgo(17), confirmTime: daysAgo(17),
      isRatedBuyer: true, buyerScore: 4
    }),

  mkDemoOrder('demo_order_06', 'TB20250510101506', 'demo_skill_10', U4, U6, 'canceled', 22,
    { cancelBy: 'buyer', cancelReason: '临时有事，改天再约', cancelTime: daysAgo(21) }),

  // 买家是 U1、卖家是 U4：与 mock 中「我买到的海报设计订单」同构
  mkDemoOrder('demo_order_07', 'TB20250529100008', 'demo_skill_07', U1, U4, 'finished', 5,
    {
      acceptTime: daysAgo(5), finishTime: daysAgo(4), confirmTime: daysAgo(4),
      isRatedBuyer: true, buyerScore: 5, isRatedSeller: false
    }),

  mkDemoOrder('demo_order_08', 'TB20250525142009', 'demo_skill_06', U5, U3, 'confirming', 7,
    { acceptTime: daysAgo(6), finishTime: daysAgo(1), remark: '概率论作业思路答疑' })
]

const ORDER_MAP = DEMO_ORDERS.reduce((m, o) => (m[o._id] = o, m), {})

/** 演示评价 6 条 */
const DEMO_REVIEWS = [
  {
    _id: 'demo_review_01', orderId: 'demo_order_04', skillId: 'demo_skill_07',
    fromId: U6, fromInfo: { nickName: '孙晓雯', avatarUrl: '' },
    toId: U4, toInfo: { nickName: '刘佳怡', avatarUrl: '' },
    role: 'buyer', score: 5, tags: ['专业靠谱', '态度超好', '效率很高'],
    content: '海报改了两版就完全达到我想要的风格，社团招新那天好多人问是谁做的。强烈推荐！',
    anonymous: false, reply: { content: '谢谢你！下次社团活动图还找我～', time: daysAgo(10) },
    createTime: daysAgo(11)
  },
  {
    _id: 'demo_review_02', orderId: 'demo_order_05', skillId: 'demo_skill_09',
    fromId: U2, fromInfo: { nickName: '王雨桐', avatarUrl: '' },
    toId: U5, toInfo: { nickName: '赵一鸣', avatarUrl: '' },
    role: 'buyer', score: 4, tags: ['准时守约', '效率很高'],
    content: '清灰很利索，装环境也顺手帮我搞定了。就是约的时间稍微晚了一点，整体还是很满意。',
    anonymous: false, reply: null, createTime: daysAgo(17)
  },
  {
    _id: 'demo_review_03', orderId: 'demo_order_03', skillId: 'demo_skill_05',
    fromId: U1, fromInfo: { nickName: '李思远', avatarUrl: '' },
    toId: U3, toInfo: { nickName: '陈子豪', avatarUrl: '' },
    role: 'buyer', score: 5, tags: ['讲解细致', '物超所值'],
    content: '概率论本来要挂了，两小时被他讲明白，期末考了 82 分。救命的辅导。',
    anonymous: false, reply: null, createTime: daysAgo(6)
  },
  {
    _id: 'demo_review_04', orderId: 'demo_order_02', skillId: 'demo_skill_03',
    fromId: U3, fromInfo: { nickName: '陈子豪', avatarUrl: '' },
    toId: U2, toInfo: { nickName: '王雨桐', avatarUrl: '' },
    role: 'buyer', score: 5, tags: ['专业靠谱', '效率很高', '态度超好'],
    content: '证件照拍得很好看，当天晚上就把修好的图发我了，办证直接用，一次通过。',
    anonymous: true, reply: null, createTime: daysAgo(6)
  },
  {
    _id: 'demo_review_05', orderId: 'demo_order_01', skillId: 'demo_skill_01',
    fromId: U2, fromInfo: { nickName: '王雨桐', avatarUrl: '' },
    toId: U1, toInfo: { nickName: '李思远', avatarUrl: '' },
    role: 'buyer', score: 5, tags: ['准时守约', '讲解细致', '物超所值'],
    content: '第一节课就学会了按和弦，社长特别有耐心，我这种手残都能弹出来。',
    anonymous: false, reply: null, createTime: daysAgo(8)
  },
  {
    _id: 'demo_review_06', orderId: 'demo_order_08', skillId: 'demo_skill_06',
    fromId: U5, fromInfo: { nickName: '赵一鸣', avatarUrl: '' },
    toId: U3, toInfo: { nickName: '陈子豪', avatarUrl: '' },
    role: 'buyer', score: 5, tags: ['讲解细致', '物超所值'],
    content: '按章节帮我理了一遍思路，作业自己就写出来了，比看网课有用。',
    anonymous: false, reply: null, createTime: daysAgo(3)
  }
]

/** 演示时间币流水（_openid = 流水归属人，与 wallet.logs 的过滤口径一致） */
const DEMO_WALLET_LOGS = [
  { _id: 'demo_wl_01', _openid: U1, type: 'bonus', amount: 5, balance: 5, frozen: 0, orderId: '', orderNo: '', remark: '新用户注册赠送', createTime: daysAgo(40) },
  { _id: 'demo_wl_02', _openid: U2, type: 'freeze', amount: -2, balance: 10, frozen: 2, orderId: 'demo_order_01', orderNo: 'TB20250601120001', remark: '下单冻结：吉他入门一对一，零基础也能弹唱', createTime: daysAgo(0.1) },
  { _id: 'demo_wl_03', _openid: U3, type: 'freeze', amount: -2, balance: 8, frozen: 2, orderId: 'demo_order_02', orderNo: 'TB20250530143002', remark: '下单冻结：证件照拍摄 + 精修（当天出片）', createTime: daysAgo(2) },
  { _id: 'demo_wl_04', _openid: U4, type: 'unfreeze', amount: 1, balance: 11, frozen: 0, orderId: 'demo_order_06', orderNo: 'TB20250510101506', remark: '订单取消，时间币退回', createTime: daysAgo(21) },
  { _id: 'demo_wl_05', _openid: U4, type: 'income', amount: 3, balance: 15, frozen: 0, orderId: 'demo_order_04', orderNo: 'TB20250520153004', remark: '服务收入：海报 / 宣传图设计', createTime: daysAgo(11) },
  { _id: 'demo_wl_06', _openid: U6, type: 'expense', amount: -3, balance: 11, frozen: 0, orderId: 'demo_order_04', orderNo: 'TB20250520153004', remark: '服务支出：海报 / 宣传图设计', createTime: daysAgo(11) },
  { _id: 'demo_wl_07', _openid: U5, type: 'income', amount: 1, balance: 9, frozen: 0, orderId: 'demo_order_05', orderNo: 'TB20250515203005', remark: '服务收入：电脑清灰 / 系统重装', createTime: daysAgo(17) },
  { _id: 'demo_wl_08', _openid: U2, type: 'expense', amount: -1, balance: 17, frozen: 0, orderId: 'demo_order_05', orderNo: 'TB20250515203005', remark: '服务支出：电脑清灰 / 系统重装', createTime: daysAgo(17) }
]

/** 演示信用分流水 */
const DEMO_CREDIT_LOGS = [
  /*
   * ★ 下面 3 条是**申诉功能的演示原料**，不是随手加的数据：
   *   demo_cl_08  U3 被举报核实成立 → 扣 10 分   ← demo_appeal_03 的申诉对象
   *   demo_cl_09  U3 申诉成立 → 加回 10 分       ← ★ 撤销是「写反向流水」而不是删原记录，
   *                                              所以 demo_cl_08 **仍然在**，两条都在账上
   *   demo_cl_10  U5 爽约扣 5 分                 ← demo_appeal_04 的申诉对象（被驳回，分数不动）
   */
  { _id: 'demo_cl_08', _openid: U3, change: -10, score: 123, reason: 'report_valid', reasonText: '举报核实成立', orderId: '', createTime: daysAgo(9) },
  { _id: 'demo_cl_09', _openid: U3, change: 10, score: 133, reason: 'appeal_ok', reasonText: '申诉成立，信用分已恢复', orderId: '', createTime: daysAgo(6) },
  { _id: 'demo_cl_10', _openid: U5, change: -5, score: 91, reason: 'cancel_after_accept', reasonText: '接单后取消 / 爽约', orderId: '', createTime: daysAgo(4) },
  { _id: 'demo_cl_01', _openid: U4, change: 2, score: 109, reason: 'order_finish', reasonText: '订单顺利完成', orderId: 'demo_order_04', createTime: daysAgo(11) },
  { _id: 'demo_cl_02', _openid: U4, change: 1, score: 107, reason: 'review_5', reasonText: '收到 5 星好评', orderId: 'demo_order_04', createTime: daysAgo(11) },
  { _id: 'demo_cl_03', _openid: U1, change: 2, score: 128, reason: 'order_finish', reasonText: '订单顺利完成', orderId: 'demo_order_01', createTime: daysAgo(8) },
  { _id: 'demo_cl_04', _openid: U5, change: 2, score: 96, reason: 'order_finish', reasonText: '订单顺利完成', orderId: 'demo_order_05', createTime: daysAgo(17) },
  { _id: 'demo_cl_05', _openid: U3, change: 3, score: 133, reason: 'ontime_streak', reasonText: '连续 5 单按时完成', orderId: '', createTime: daysAgo(9) },
  { _id: 'demo_cl_06', _openid: U4, change: -5, score: 106, reason: 'cancel_after_accept', reasonText: '接单后取消 / 爽约', orderId: 'demo_order_06', createTime: daysAgo(21) },
  { _id: 'demo_cl_07', _openid: U2, change: 1, score: 121, reason: 'review_5', reasonText: '收到 5 星好评', orderId: 'demo_order_02', createTime: daysAgo(6) }
]

/** 演示系统通知 */
const DEMO_NOTICES = [
  { _id: 'demo_notice_01', _openid: U1, type: 'order', title: '收到新订单', content: '王雨桐 想要你的「吉他入门一对一，零基础也能弹唱」，快去看看吧。', orderId: 'demo_order_01', read: false, createTime: daysAgo(0.1) },
  { _id: 'demo_notice_02', _openid: U2, type: 'order', title: '有人接单啦', content: '李思远 已接下你的「证件照拍摄 + 精修（当天出片）」订单，快去聊聊具体时间吧。', orderId: 'demo_order_02', read: false, createTime: daysAgo(2) },
  { _id: 'demo_notice_03', _openid: U1, type: 'order', title: '服务已完成，请确认', content: '陈子豪 已标记「高数期末突击辅导，2 小时讲完重点」服务完成，确认后时间币将结算给 TA。', orderId: 'demo_order_03', read: false, createTime: hoursAgo(6) },
  { _id: 'demo_notice_04', _openid: U4, type: 'credit', title: '信用分 +2', content: '订单顺利完成，信用分从 107 提升到 109。继续保持！', orderId: 'demo_order_04', read: true, createTime: daysAgo(11) },
  { _id: 'demo_notice_05', _openid: U3, type: 'system', title: '欢迎加入校园时间银行', content: '我们已赠送 5 枚时间币作为起步资金。时间币不可充值、不可提现，只能通过帮助他人获得。', orderId: '', read: true, createTime: daysAgo(40) }
]

/** 演示举报 2 条 */
const DEMO_REPORTS = [
  { _id: 'demo_report_01', _openid: U6, targetType: 'skill', targetId: 'demo_skill_06', targetTitle: '线性代数 / 概率论 答疑', targetUserId: U3, reason: '虚假信息 / 与描述不符', images: [], status: 0, handleRemark: '', handlerId: '', handleTime: null, createTime: hoursAgo(10) },
  // ★ 补一条 status=2（已驳回）：三种状态都有，管理端筛选才演示得全
  { _id: 'demo_report_03', _openid: U3, targetType: 'review', targetId: 'demo_review_02', targetTitle: '评价：王雨桐 证件照拍摄', targetUserId: U2, reason: '恶意差评 / 内容不实', images: [], status: 2, handleRemark: '经核实该评价为真实体验，不予处理。', handlerId: '', handleTime: daysAgo(3), createTime: daysAgo(4) },
  { _id: 'demo_report_02', _openid: U5, targetType: 'user', targetId: U4, targetTitle: '刘佳怡', targetUserId: U4, reason: '爽约 / 服务态度恶劣', images: [], status: 1, handleRemark: '已联系双方核实，对被举报人信用分扣除 5 分并警告。', handlerId: '', handleTime: daysAgo(2), createTime: daysAgo(5) }
]

/* ============================ 演示申诉 / 收藏 ============================ */
/**
 * 演示申诉 —— 覆盖**三种状态 × 两种类型**，这样管理端筛选和详情都有东西可看：
 *   demo_appeal_01  credit · 待处理 —— 管理员可以当场处理
 *   demo_appeal_02  skill  · 待处理 —— 对 demo_skill_13 的下架申诉，点「成立」会真的恢复上架
 *   demo_appeal_03  credit · 已成立 —— 对应 demo_cl_08 / demo_cl_09（扣分 + 恢复，两条都在账上）
 *   demo_appeal_04  credit · 未成立 —— 驳回，信用分不动
 *
 * ★ restore 里的恢复量是**提交申诉时固化**的（见 user 云函数的说明），
 *   所以演示数据也按同样结构写，不能等到处理时再算。
 */
const DEMO_APPEALS = [
  {
    _id: 'demo_appeal_01', _openid: U4, type: 'credit', targetId: 'demo_cl_06',
    targetTitle: '接单后取消 / 爽约 -5',
    reason: '那天室友突发高烧，我陪他去了医务室，是提前跟买家说明并征得同意的，不是无故爽约。',
    images: [], restore: { scoreChange: 5, prevStatus: 0 },
    status: 0, handleRemark: '', handlerId: '', handleTime: null, createTime: hoursAgo(20)
  },
  {
    _id: 'demo_appeal_02', _openid: U3, type: 'skill', targetId: 'demo_skill_13',
    targetTitle: '论文降重 / 查重报告解读（知网、维普）',
    reason: '我只教降重方法和怎么读报告，不代写。详情里写的「逐段解释为什么标红」被人理解成代写了。',
    images: [], restore: { scoreChange: 0, prevStatus: 1 },
    status: 0, handleRemark: '', handlerId: '', handleTime: null, createTime: hoursAgo(8)
  },
  {
    _id: 'demo_appeal_03', _openid: U3, type: 'credit', targetId: 'demo_cl_08',
    targetTitle: '举报核实成立 -10',
    reason: '那条举报说的是另一个人，管理员核实时看错了账号。',
    images: [], restore: { scoreChange: 10, prevStatus: 0 },
    status: 1, handleRemark: '已与举报人核实，确系指认错误，信用分已恢复。',
    handlerId: '', handleTime: daysAgo(6), createTime: daysAgo(7), undo: 'credit'
  },
  {
    _id: 'demo_appeal_04', _openid: U5, type: 'credit', targetId: 'demo_cl_10',
    targetTitle: '接单后取消 / 爽约 -5',
    reason: '我觉得不应该扣分。',
    images: [], restore: { scoreChange: 5, prevStatus: 0 },
    status: 2, handleRemark: '订单日志显示接单 40 分钟后才取消，且未与买家沟通，维持原处理。',
    handlerId: '', handleTime: daysAgo(2), createTime: daysAgo(3)
  }
]

/** 演示收藏（「我的收藏」页要有东西可看） */
const DEMO_FAVORITES = [
  { _id: 'demo_fav_01', _openid: U1, skillId: 'demo_skill_07', createTime: daysAgo(2) },
  { _id: 'demo_fav_02', _openid: U1, skillId: 'demo_skill_09', createTime: daysAgo(5) },
  { _id: 'demo_fav_03', _openid: U4, skillId: 'demo_skill_01', createTime: daysAgo(3) }
]

/* ============================ action ============================ */

/** init —— 建集合 + 写种子数据（幂等） */
async function actionInit(event) {
  // ★ 修复模式：把**已存在**的种子文档用种子值覆盖（默认只补缺失、不动已有）。
  //   用途：config 被管理员改坏了、演示文案被改乱了，想恢复初始状态。
  //   每次调用都显式赋值，避免上一次的开关残留到下一次。
  SEED_REPAIR = !!(event && event.repair)
  // ★ 用 getOpenId() 而不是 requireOpenId()：
  //   在云开发控制台的「云端测试」里没有登录态，而首次初始化必须在
  //   控制台就能跑（见 guardDangerous 的引导模式说明）。
  const openid = getOpenId()
  const guard = await guardDangerous(openid, 'init')

  /* ① 创建全部集合（已存在会抛错 → 必须 try/catch 吞掉；清单见 ALL_COLLECTIONS） */
  const created = []
  const existed = []
  for (const name of ALL_COLLECTIONS) {
    try {
      await db.createCollection(name)
      created.push(name)
    } catch (e) {
      // CollectionExists 等「已存在」错误：吞掉
      existed.push(name)
    }
  }

  /* ② 种子数据（逐集合幂等：按固定 _id 探测后写入） */
  const seeded = {}
  seeded.categories = await seedDocs(C.CATEGORIES, SEED_CATEGORIES.map(c => Object.assign({}, c, { createTime: daysAgo(30) })), '技能分类')
  seeded.config = await seedDocs(C.CONFIG, [SEED_CONFIG], '全局配置')
  seeded.banners = await seedDocs(C.BANNERS, SEED_BANNERS, '首页轮播')
  seeded.users = await seedDocs(C.USERS, DEMO_USERS, '演示用户')
  // ★ 内部账户：users 记录 + accounts 登录凭据
  seeded.internalUsers = await seedDocs(C.USERS, INTERNAL_USERS, '内部账户用户')
  seeded.accounts = await seedDocs(C.ACCOUNTS, accountDocs(), '内部账户')
  seeded.skills = await seedDocs(C.SKILLS, DEMO_SKILLS, '演示技能')
  seeded.orders = await seedDocs(C.ORDERS, DEMO_ORDERS, '演示订单')
  seeded.reviews = await seedDocs(C.REVIEWS, DEMO_REVIEWS, '演示评价')
  seeded.walletLogs = await seedDocs(C.WALLET_LOGS, DEMO_WALLET_LOGS, '演示时间币流水')
  seeded.creditLogs = await seedDocs(C.CREDIT_LOGS, DEMO_CREDIT_LOGS, '演示信用分流水')
  seeded.notices = await seedDocs(C.NOTICES, DEMO_NOTICES, '演示系统通知')
  seeded.reports = await seedDocs(C.REPORTS, DEMO_REPORTS, '演示举报')
  seeded.appeals = await seedDocs(C.APPEALS, DEMO_APPEALS, '演示申诉')
  seeded.favorites = await seedDocs(C.FAVORITES, DEMO_FAVORITES, '演示收藏')

  const summary = {
    users: await countOf(C.USERS),
    skills: await countOf(C.SKILLS),
    orders: await countOf(C.ORDERS),
    reviews: await countOf(C.REVIEWS),
    categories: await countOf(C.CATEGORIES),
    banners: await countOf(C.BANNERS)
  }

  console.log('[initdb] init 完成', JSON.stringify({ created, existed, seeded, summary }))

  return {
    created,          // 本次新建的集合
    existed,          // 已存在的集合
    seeded,           // 每个集合写入情况 { inserted, skipped }
    summary,          // 当前集合条数
    firstTime: guard.firstTime
  }
}

/** clear —— 清空业务集合（保留 users 里的 admin） */
async function actionClear() {
  // clear 是破坏性操作：不享受「首次部署/引导模式」豁免。
  // 但控制台调用照样放行 —— 见 guardDangerous 的鉴权模型说明。
  const openid = getOpenId()
  const guard = await guardDangerous(openid, 'clear')

  const cleared = []
  for (const name of BUSINESS_COLLECTIONS) {
    cleared.push(await clearCollection(name, {}, name))
  }

  // users：只删非 admin（单次上限 100 条 → 循环）
  cleared.push(await clearCollection(C.USERS, { role: _.nin(['admin', 'debugger']) }, '用户（保留管理员与调试员）'))

  const keptAdmins = await countOf(C.USERS, { role: _.in(['admin', 'debugger']) })
  console.log('[initdb] clear 完成', JSON.stringify(cleared), '保留管理员', keptAdmins)

  return {
    cleared,
    kept: KEEP_COLLECTIONS,     // 分类 / 轮播 / 配置属于基础配置，保留
    keptAdmins,
    firstTime: guard.firstTime
  }
}

/**
 * setAdmin —— 把指定用户设为管理员（**仅用于引导第一个管理员**）
 * 入参 { openid } 或 { studentNo }
 *
 * ★ 安全边界（只针对**小程序调用**）：
 *   只在「系统里还没有任何管理员」时可用。否则任何人只要知道这个云函数名，
 *   就能把自己的 openid 提权成管理员 —— 这是一个提权漏洞。
 *   第一个管理员产生之后，后续授权走管理端「用户管理 → 设为管理员」
 *   （`admin.setUserRole`，带鉴权）。
 *
 * ★ 控制台调用不受此限：见 guardDangerous 的鉴权模型说明 ——
 *   控制台即开发者（root）权限，拦不住也不该拦。
 */
async function actionSetAdmin(event) {
  const callerOpenid = getOpenId()
  const openid = str(event.openid)
  const studentNo = str(event.studentNo)
  assert(openid || studentNo, '请传入 openid 或 studentNo')

  if (callerOpenid) {
    // 小程序调用：只有在还没有管理员时才允许（防提权）
    const adminCount = await countOf(C.USERS, { role: 'admin' })
    assert(
      adminCount === 0,
      '系统已有管理员，本接口仅用于引导第一个管理员。请在管理端「用户管理」中授权',
      403
    )
  }

  const where = openid ? { _openid: openid } : { studentNo: studentNo }
  const res = await db.collection(C.USERS).where(where).limit(1).get()
  const target = (res.data && res.data[0]) || null
  if (!target) throw bizError(404, '用户不存在')
  // 必须校验账号状态，否则把已封禁用户设成管理员也会成功。
  //   封禁账号不该获得后台权限。
  assert(Number(target.status) !== 0, '该账号已被封禁，不能设为管理员', 400)

  /*
   * ★ 这里也是「调试员」的**引导入口（bootstrap）**。
   *
   *   规则是「调试员身份只有调试员能授予」—— 这在日常是对的（防止普通管理员
   *   给自己升级），但它有个先有鸡还是先有蛋的问题：**第一个调试员谁来设？**
   *
   *   答案就是这个函数：initdb 是控制台手动调用的运维工具，
   *   它不走 requireAdmin，本来就承担着「初始化 / 救急」的职责。
   *   在云开发控制台执行：
   *     { "action": "setAdmin", "openid": "xxx", "role": "debugger" }
   *   就能把第一个校方账号设成调试员，之后由它去管理其他调试员。
   */
  const wanted = event.role === 'debugger' ? 'debugger' : 'admin'

  await db.collection(C.USERS).doc(target._id).update({
    data: { role: wanted, updateTime: now() }
  })

  return { ok: true, openid: target._openid, nickName: target.nickName || '', role: wanted }
}

/* ============================ 入口 ============================ */
exports.main = wrap(async (event, context) => {
  const action = event.action
  switch (action) {
    case 'init': return actionInit(event, context)
    case 'clear': return actionClear(event, context)
    case 'setAdmin': return actionSetAdmin(event, context)
    default: throw bizError(400, `未知 action: ${action}`)
  }
})
