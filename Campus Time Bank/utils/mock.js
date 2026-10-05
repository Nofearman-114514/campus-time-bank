/**
 * 离线模拟数据层（Mock）
 * ------------------------------------------------------------------
 * 当 envList.js 未填写 ENV_ID 时自动启用。
 * 所有返回结构与真实云函数**完全一致**，因此页面代码无需任何改动。
 *
 * 用途：① 没部署云开发时预览全部 UI
 *      ② 写论文 / 答辩彩排时稳定复现数据，不受云环境波动影响
 *      ③ 前端联调时脱离后端并行开发
 * ------------------------------------------------------------------
 */

const campus = require('./campus')   // 校内地点表与范围判断（与云端 _shared 的 CAMPUS_RADIUS 保持一致）

/* ============================ 工具 ============================ */
const now = () => new Date()
const daysAgo = d => new Date(Date.now() - d * 86400000)
const hoursAgo = h => new Date(Date.now() - h * 3600000)
const minsAgo = m => new Date(Date.now() - m * 60000)
const clone = o => JSON.parse(JSON.stringify(o))
const rid = p => `${p}_${Math.random().toString(36).slice(2, 10)}`

/** 同一天？用于把演示数据按天聚合到趋势图 */
function sameDay(a, b) {
  const x = new Date(a)
  const y = new Date(b)
  if (isNaN(x.getTime()) || isNaN(y.getTime())) return false
  return x.getFullYear() === y.getFullYear() && x.getMonth() === y.getMonth() && x.getDate() === y.getDate()
}

/**
 * 固定种子的线性同余伪随机。
 * ★ 刻意不用 Math.random()：数据看板的趋势图与统计数字必须**每次加载都一样**，
 *   否则下拉刷新时曲线跳动、数字变化，答辩演示时看着像 bug。
 */
let _seed = 20250601
const rnd = () => { _seed = (_seed * 1103515245 + 12345) % 2147483648; return _seed / 2147483648 }
const pickOne = arr => arr[Math.floor(rnd() * arr.length)]
const rndInt = (min, max) => min + Math.floor(rnd() * (max - min + 1))

/**
 * 造一个「dayOffset 天前」的合理时间点。
 *
 * ★ 为什么要专门写这个函数：直接用 `daysAgo(dayOffset + rnd())` 会踩坑 ——
 *   在凌晨时段（比如现在 03:00），`daysAgo(0.8)` 会落到**昨天** 08:00，
 *   于是「今天」永远是 0 条，看板头部就会出现「今日新增 0 / 增长率 -100%」
 *   这种自相矛盾的数字。这里保证：
 *     · dayOffset = 0 → 一定落在「今天 00:00 ~ 现在」之间（且绝不产生未来时间）
 *     · dayOffset > 0 → 落在那一天的 08:00 ~ 22:59（像正常的下单时段）
 */
function demoTime(dayOffset) {
  if (dayOffset <= 0) {
    const t0 = new Date()
    t0.setHours(0, 0, 0, 0)
    const span = Math.max(60000, Date.now() - t0.getTime())
    return new Date(t0.getTime() + Math.floor(rnd() * span))
  }
  const d = new Date(Date.now() - dayOffset * 86400000)
  d.setHours(rndInt(8, 22), rndInt(0, 59), 0, 0)
  return d
}

class MockError extends Error {
  constructor(code, msg) { super(msg); this.code = code; this.__biz = true }
}
const fail = (code, msg) => { throw new MockError(code, msg) }

/* ============================ 用户 ============================ */
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

const OPENID = {
  me: 'openid_demo_me',
  guitar: 'openid_demo_u1',
  photo: 'openid_demo_u2',
  math: 'openid_demo_u3',
  design: 'openid_demo_u4',
  pc: 'openid_demo_u5',
  run: 'openid_demo_u6'
}

function mkUser(openid, nickName, extra) {
  const base = {
    _id: 'user_' + openid.slice(-2),
    _openid: openid,
    nickName,
    avatarUrl: '',                 // 空 → 组件渲染「首字母 + 渐变色」头像
    gender: 0,
    phone: '',
    campus: '广东职业技术学院',
    college: '信息工程学院',
    major: '移动应用开发',
    grade: '2022级',
    studentNo: '20220' + Math.floor(10000 + Math.random() * 89999),
    bio: '',
    tags: [],
    authStatus: 2,
    authImages: [],
    authRemark: '',
    authTime: daysAgo(30),
    coins: 8,
    frozenCoins: 0,
    totalEarned: 12,
    totalSpent: 10,
    creditScore: 100,
    creditLevel: 'good',
    badges: ['newbie'],
    stats: {
      publishCount: 0, serveCount: 0, buyCount: 0,
      reviewCount: 0, ratingSum: 0, avgRating: 0, ontimeStreak: 0
    },
    location: null,
    locationName: '',
    locationTime: null,
    role: 'user',
    status: 1,
    createTime: daysAgo(40),
    updateTime: daysAgo(1),
    lastLoginTime: hoursAgo(2)
  }
  return Object.assign(base, extra || {})
}

/*
 * 管理层判断 —— 与云端 _shared 的 isAdminUser / isDebuggerUser 保持一致。
 * 权限是包含关系：debugger（校方） ⊃ admin（学生管理员）。
 */
function isMockManager() {
  const r = me().role
  return r === 'admin' || r === 'debugger'
}
function isMockDebugger() {
  return me().role === 'debugger'
}

const users = [
  mkUser(OPENID.me, '张小明', {
    bio: '信息工程学院移动应用开发大三，正在做毕业设计，喜欢用技术解决校园里的小麻烦。',
    tags: ['产品设计', '小程序开发', '羽毛球'],
    coins: 12, frozenCoins: 2, totalEarned: 16, totalSpent: 14,
    creditScore: 112, creditLevel: 'good',
    // ★ 演示用：设为「调试员」而不是「管理员」。
    //   原因：调试模式开关现在**只有调试员可见** —— 如果这里是 admin，
    //   离线模式下就看不到开关，一旦打开就再也关不掉（把自己锁在门外）。
    //   想演示「管理员看不到调试功能」的效果，把这里改成 'admin' 即可。
    role: 'debugger',
    badges: ['newbie', 'ontime', 'social'],
    stats: { publishCount: 2, serveCount: 3, buyCount: 5, reviewCount: 8, ratingSum: 38, avgRating: 4.8, ontimeStreak: 6 }
  }),
  mkUser(OPENID.guitar, '李思远', {
    bio: '音乐社社长，艺术设计学院大三。弹了六年吉他，带过三届新生。零基础也能上手，第一节课就能弹出完整旋律，平时在 B 栋空教室上课。',
    tags: ['吉他', '尤克里里', '乐理'],
    campus: '广东职业技术学院', college: '艺术设计学院', major: '音乐表演', grade: gradeAt(2),
    coins: 23, frozenCoins: 0, totalEarned: 41, totalSpent: 18,
    creditScore: 128, creditLevel: 'excellent',
    badges: ['newbie', 'ontime', 'warm', 'expert', 'trust'],
    stats: { publishCount: 3, serveCount: 21, buyCount: 2, reviewCount: 19, ratingSum: 90, avgRating: 4.9, ontimeStreak: 12 }
  }),
  mkUser(OPENID.photo, '王雨桐', {
    bio: '摄影协会成员，艺术设计学院。有单反和补光灯，专拍证件照、毕业照。学子湖和图书馆一带的出片点我都熟，当天出片、免费修图三次。',
    tags: ['摄影', '证件照', '后期修图', '短视频'],
    college: '艺术设计学院', major: '数字媒体艺术设计', grade: gradeAt(1),
    coins: 17, frozenCoins: 3, totalEarned: 30, totalSpent: 13,
    creditScore: 121, creditLevel: 'excellent',
    badges: ['newbie', 'ontime', 'warm', 'trust'],
    stats: { publishCount: 2, serveCount: 14, buyCount: 4, reviewCount: 13, ratingSum: 62, avgRating: 4.8, ontimeStreak: 4 }
  }),
  mkUser(OPENID.math, '陈子豪', {
    bio: '智能制造学院大三，高数/线代/概率论都能带。擅长考前突击，两小时讲完一学期的重点，可约图书馆研讨间。',
    tags: ['高等数学', '线性代数', '概率论', '考研数学'],
    college: '智能制造学院', major: '机电一体化技术', grade: gradeAt(2),
    coins: 31, frozenCoins: 0, totalEarned: 55, totalSpent: 24,
    creditScore: 133, creditLevel: 'excellent',
    badges: ['newbie', 'ontime', 'warm', 'expert', 'trust', 'popular'],
    stats: { publishCount: 4, serveCount: 28, buyCount: 3, reviewCount: 25, ratingSum: 119, avgRating: 4.8, ontimeStreak: 9 }
  }),
  mkUser(OPENID.design, '刘佳怡', {
    bio: '艺术设计学院视觉传达方向。PS / AI / Figma 熟练，接海报、PPT、简历排版，改到满意为止。',
    tags: ['PS', '海报设计', 'PPT美化', '简历排版', 'Figma'],
    college: '艺术设计学院', major: '视觉传达设计', grade: gradeAt(1),
    coins: 15, frozenCoins: 0, totalEarned: 26, totalSpent: 11,
    creditScore: 109, creditLevel: 'good',
    badges: ['newbie', 'ontime', 'social'],
    stats: { publishCount: 2, serveCount: 11, buyCount: 5, reviewCount: 10, ratingSum: 45, avgRating: 4.5, ontimeStreak: 3 }
  }),
  mkUser(OPENID.pc, '赵一鸣', {
    bio: '计算机协会技术部，信息工程学院。装机、清灰、系统重装、装环境都能搞，约在实训楼或山下饭堂门口，一般 1 小时内解决。',
    tags: ['电脑维修', '系统重装', '装机', '环境配置'],
    college: '信息工程学院', major: '计算机应用技术', grade: gradeAt(3),
    coins: 9, frozenCoins: 0, totalEarned: 19, totalSpent: 10,
    creditScore: 96, creditLevel: 'normal',
    badges: ['newbie', 'ontime'],
    stats: { publishCount: 1, serveCount: 8, buyCount: 6, reviewCount: 7, ratingSum: 32, avgRating: 4.6, ontimeStreak: 2 }
  }),
  mkUser(OPENID.run, '孙晓雯', {
    bio: '外语外贸学院，校田径队。可以陪跑配速、制定体测训练计划；也能陪练英语口语（雅思 7.0），新操场或学子湖边都行。',
    tags: ['跑步', '健身计划', '英语口语', '雅思'],
    college: '外语外贸学院', major: '商务英语', grade: gradeAt(2),
    coins: 14, frozenCoins: 0, totalEarned: 22, totalSpent: 8,
    creditScore: 115, creditLevel: 'good',
    badges: ['newbie', 'ontime', 'warm'],
    stats: { publishCount: 3, serveCount: 10, buyCount: 3, reviewCount: 9, ratingSum: 42, avgRating: 4.7, ontimeStreak: 5 }
  })
]

/* ------------------------------------------------------------------
 * 演示数据扩容
 * ------------------------------------------------------------------
 * 目的：让管理端「数据看板」在离线模式下有像样的量级。
 *
 * ★ 关键设计：看板上的「总数」必须是**真实统计出来的**，而不是硬编码一个大数字。
 *   否则会自相矛盾 —— 看板显示「用户总数 139」，点进用户列表却只有 9 条，
 *   答辩时这是必被追问的破绽。所以这里真的往数据集里塞人塞单，
 *   让总览、趋势、分布三者的口径完全自洽。
 * ------------------------------------------------------------------ */

// ①② 演示用户：真实姓名直接用昵称（真实环境里 realName 由认证表单单独提交）
users.forEach(u => { u.realName = u.nickName })

// ③ 两个「待审核」用户 —— 否则管理端「校园认证审核」页在离线模式下只能看到空态
//    authImages 留空：离线环境没有云存储，无法提供真实凭证图；
//    真实部署时这里会是 cloud:// 的 fileID
users.push(
  mkUser('openid_demo_u7', '周雨薇', {
    realName: '周雨薇', authStatus: 1, authImages: [],
    college: '外语外贸学院', major: '应用英语', grade: gradeAt(1),
    creditScore: 100, coins: 5, badges: [], stats: {
      publishCount: 0, serveCount: 0, buyCount: 0, reviewCount: 0,
      ratingSum: 0, avgRating: 0, ontimeStreak: 0
    }
  }),
  mkUser('openid_demo_u8', '吴天宇', {
    realName: '吴天宇', authStatus: 1, authImages: [],
    college: '教育学院', major: '学前教育', grade: gradeAt(0),
    creditScore: 100, coins: 5, badges: [], stats: {
      publishCount: 0, serveCount: 0, buyCount: 0, reviewCount: 0,
      ratingSum: 0, avgRating: 0, ontimeStreak: 0
    }
  })
)

// ④ 批量生成演示用户，把数据量撑到「像个真实运行的平台」
const DEMO_EXTRA_NAMES = [
  '王梓涵', '李昊然', '张一鸣', '刘雨欣', '陈嘉豪', '杨若曦', '黄浩然', '赵梓萱',
  '周子墨', '吴梦琪', '徐嘉懿', '孙晨曦', '马思远', '朱婉清', '胡明轩', '郭静怡',
  '何宇航', '林语嫣', '高俊杰', '罗嘉琪', '郑伟诚', '梁诗涵', '谢天宇', '唐雪莉',
  '许文博', '韩雨彤', '冯子豪', '邓佳宁', '曹亦凡', '彭梓晴', '曾令辉', '萧若涵',
  '田浩宇', '董思彤', '潘嘉豪', '蒋雨桐', '蔡明哲', '余静雯', '杜承轩', '叶清妍'
]
const DEMO_COLLEGES = [
  // ★ 广职院的真实院系（13 院 1 部）。原来这里写的是虚构大学，
  //   会生成 40 个学院对不上号的用户，管理端「学院分布」一眼就穿帮。
  ['纺织学院', '现代纺织技术'], ['纺织学院', '纺织品设计'],
  ['服装学院', '服装设计与工艺'], ['服装学院', '服装与服饰设计'],
  ['轻工与材料学院', '高分子材料智能制造技术'],
  ['艺术设计学院', '视觉传达设计'], ['艺术设计学院', '数字媒体艺术设计'],
  ['艺术设计学院', '环境艺术设计'],
  ['外语外贸学院', '商务英语'], ['外语外贸学院', '应用英语'],
  ['信息工程学院', '计算机应用技术'], ['信息工程学院', '软件技术'],
  ['信息工程学院', '大数据技术'], ['信息工程学院', '人工智能技术应用'],
  ['商学院', '电子商务'], ['商学院', '大数据与会计'], ['商学院', '现代物流管理'],
  ['智能制造学院', '机电一体化技术'], ['智能制造学院', '工业机器人技术'],
  ['智能制造学院', '数控技术'],
  ['汽车与交通学院', '汽车检测与维修技术'], ['汽车与交通学院', '新能源汽车技术'],
  ['教育学院', '学前教育']
]
const DEMO_GRADES = (() => {
  const out = []
  for (let y = GRADE_NOW - 4; y <= GRADE_NOW; y++) out.push(y + '级')
  return out
})()

DEMO_EXTRA_NAMES.forEach((name, i) => {
  const pair = pickOne(DEMO_COLLEGES)
  const serve = rndInt(0, 22)
  const buy = rndInt(0, 14)
  const rc = Math.max(1, Math.floor(serve * 0.8))
  const avg = Math.round((4.0 + rnd() * 0.9) * 10) / 10
  const u = mkUser('openid_demo_x' + i, name, {
    realName: name,
    authStatus: 2,
    campus: '广东职业技术学院',
    college: pair[0],
    major: pair[1],
    grade: pickOne(DEMO_GRADES),
    bio: '',
    tags: [],
    creditScore: rndInt(82, 138),
    coins: rndInt(0, 32),
    frozenCoins: rnd() > 0.75 ? rndInt(1, 5) : 0,
    totalEarned: rndInt(0, 45),
    totalSpent: rndInt(0, 38),
    // 用 demoTime 而不是 daysAgo(d)：保证「今天」真的落在今天（见 demoTime 注释）
    createTime: demoTime(Math.floor(i * 29 / DEMO_EXTRA_NAMES.length)),
    lastLoginTime: hoursAgo(rndInt(0, 96)),
    stats: {
      publishCount: rndInt(0, 4),
      serveCount: serve,
      buyCount: buy,
      reviewCount: rc,
      ratingSum: Math.round(avg * rc),
      avgRating: avg,
      ontimeStreak: rndInt(0, 9)
    }
  })
  users.push(u)
})

const userMap = users.reduce((m, u) => (m[u._openid] = u, m), {})

/* ============================ 分类 ============================ */
const categories = [
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
const catMap = categories.reduce((m, c) => (m[c._id] = c, m), {})

/* ============================ 技能 ============================ */
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
// ★ 校内地点表直接由 utils/campus.js 生成，**不再各写一份坐标** ——
//   否则改了 campus.js 的坐标而忘了改这里，mock 与页面就会算出不一致的距离。
const CAMPUS = campus.SPOTS.reduce((m, s) => (m[s.key] = s, m), {})

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
  'newField', // 13 羽毛球求球友（仅 mock）：新操场
  'bldgB',    // 14 小程序答疑（仅 mock）：教学楼 B1
  'newField', // 15 羽毛球陪打（仅 mock）：新操场
]

function mkSkill(openid, type, title, desc, categoryId, price, duration, tags, extra) {
  const u = userMap[openid]
  const c = catMap[categoryId]
  const base = {
    _id: rid('skill'),
    _openid: openid,
    authorId: openid,
    authorInfo: {
      nickName: u.nickName, avatarUrl: u.avatarUrl,
      creditScore: u.creditScore, creditLevel: u.creditLevel, authStatus: u.authStatus
    },
    type,
    title,
    desc,
    categoryId,
    categoryName: c ? c.name : '其他',
    categoryIcon: c ? c.icon : '✨',
    price,
    duration,
    images: [],                    // 空 → 卡片渲染分类渐变封面
    tags: tags || [],
    location: null,
    address: '广职院 · B 栋',
    locationName: 'B 栋 301 教室',
    status: 1,
    auditRemark: '',
    viewCount: Math.floor(60 + Math.random() * 500),
    orderCount: Math.floor(1 + Math.random() * 12),
    isTop: false,
    createTime: daysAgo(Math.random() * 12),
    updateTime: daysAgo(Math.random() * 2)
  }
  return Object.assign(base, extra || {})
}

const skills = [
  mkSkill(OPENID.guitar, 'offer', '吉他入门一对一，零基础也能弹唱',
    '六年琴龄，音乐社社长。第一节课带你认识吉他、学会按和弦；三节课内能完整弹唱一首歌。\n自带两把琴，你不用准备任何东西。教学地点在艺术楼琴房或者宿舍楼下都行。',
    'c2', 2, 60, ['零基础友好', '自带吉他', '可试听']),
  mkSkill(OPENID.guitar, 'offer', '尤克里里速成 3 节课',
    '尤克里里比吉他好上手得多，3 节课就能自弹自唱。适合想快速获得一项技能的同學。',
    'c2', 1, 45, ['速成', '小班可谈']),
  mkSkill(OPENID.photo, 'offer', '证件照拍摄 + 精修（当天出片）',
    '单反 + 双补光灯 + 白/蓝/红三色背景布，拍完当场选片。\n含精修 3 次，不满意免费重拍。考公、考研、简历、签证照都能拍。',
    'c3', 2, 60, ['当天出片', '含精修', '免费重拍']),
  mkSkill(OPENID.photo, 'offer', '毕业照 / 情侣照跟拍 2 小时',
    '校园内任选 3 个机位，拍 200 张以上原片全给，另精修 15 张。熟悉校园每个出片点。',
    'c3', 5, 120, ['原片全给', '含精修15张']),
  mkSkill(OPENID.math, 'offer', '高数期末突击辅导，2 小时讲完重点',
    '数学系在读，带过 20+ 位同学。按你的教材和往年卷子划重点，讲透典型题型。\n考前一周效果最好，可约图书馆研讨间。',
    'c1', 3, 120, ['考前突击', '带往年卷', '可小班']),
  mkSkill(OPENID.math, 'offer', '线性代数 / 概率论 答疑',
    '按章节答疑，也可以帮你检查作业思路。线上语音或线下自习室都可以。',
    'c1', 1, 60, ['按需答疑', '线上线下均可']),
  mkSkill(OPENID.design, 'offer', '海报 / 宣传图设计（含 3 次修改）',
    '视觉传达专业，熟练 PS / AI / Figma。社团招新海报、活动预告、公众号首图都能做。\n先沟通风格，出 2 版初稿，改到满意为止。',
    'c8', 3, 90, ['出2版初稿', '含3次修改']),
  mkSkill(OPENID.design, 'offer', 'PPT 美化排版（每 10 页）',
    '把内容交给我，负责配色、版式、图标、图表统一。答辩 PPT、课程汇报都适用。',
    'c8', 2, 60, ['答辩专用', '配色统一']),
  mkSkill(OPENID.pc, 'offer', '电脑清灰 / 系统重装 / 环境配置',
    '计算机协会技术部。清灰换硅脂、重装系统、装开发环境（Python/Java/Node）都能搞。\n宿舍楼下随叫随到，一般 1 小时内解决。',
    'c5', 1, 60, ['随叫随到', '当场解决']),
  mkSkill(OPENID.run, 'offer', '校园陪跑 + 体测突击训练',
    '校田径队，可以按你的配速陪跑，也能帮你制定 800/1000 米体测训练计划。\n早上 6:30 或晚上 8:00，操场集合。',
    'c6', 1, 60, ['配速陪跑', '体测突击']),
  mkSkill(OPENID.run, 'offer', '英语口语陪练（雅思 7.0）',
    '全英文对话陪练，纠正发音和表达。也可以帮你模拟雅思口语 Part 1-3。',
    'c9', 2, 60, ['全英文', '可模拟雅思']),
  mkSkill(OPENID.math, 'need', '求一位会剪辑的同学教我用剪映',
    '毕设要做一个演示视频，完全不会剪辑。希望有人能带我过一遍剪映的基本操作：分割、转场、字幕、配乐。一次就够，我自己练。',
    'c5', 2, 90, ['求教学', '一次即可']),
  mkSkill(OPENID.photo, 'need', '求带一次羽毛球，想找固定球友',
    '刚学羽毛球，想找个水平差不多的同学每周打两次，顺便教我基本步伐和发球。场地我可以订。',
    'c6', 1, 90, ['找球友', '长期']),
  mkSkill(OPENID.me, 'offer', '小程序 / 网页开发答疑（毕业设计也行）',
    '移动应用开发专业，做过 5 个小程序和 2 个后台。可以帮你排查 bug、讲清原理、改答辩 PPT 里的技术部分。',
    'c5', 3, 120, ['毕业设计', '可帮排查bug']),
  mkSkill(OPENID.me, 'offer', '羽毛球陪打（会一点点，主要是陪练）',
    '水平一般但体力好，可以陪你练多球、捡球、当固定球友。东区球场或者体育馆都行。',
    'c6', 1, 60, ['陪练', '体力好'])
]


/* 给演示技能挂上校内真实地点（与云端 DEMO_SKILLS 一一对应） */
skills.forEach((s, i) => {
  const p = CAMPUS[DEMO_SKILL_LOCS[i]]
  if (!p) return
  s.address = p.address
  s.locationName = p.locationName
  // mock 没有 db.Geo.Point，用等价的 GeoJSON 结构（JSON clone 友好）
  s.location = { type: 'Point', coordinates: [p.lng, p.lat] }
})

/* ============================ 订单 ============================ */
function mkOrder(no, skill, buyerOpenid, sellerOpenid, status, extra) {
  const buyer = userMap[buyerOpenid]
  const seller = userMap[sellerOpenid]
  const created = daysAgo(extra && extra.days != null ? extra.days : 1)
  return Object.assign({
    _id: rid('order'),
    orderNo: no,
    skillId: skill._id,
    skillSnapshot: {
      title: skill.title, price: skill.price, duration: skill.duration,
      categoryName: skill.categoryName, images: skill.images, type: skill.type
    },
    buyerId: buyerOpenid,
    buyerInfo: { nickName: buyer.nickName, avatarUrl: buyer.avatarUrl, creditScore: buyer.creditScore },
    sellerId: sellerOpenid,
    sellerInfo: { nickName: seller.nickName, avatarUrl: seller.avatarUrl, creditScore: seller.creditScore },
    amount: skill.price,
    status,
    remark: '',
    expectTime: '',
    contact: '',
    timeline: [{ status: 'waiting', time: created, remark: '买家下单，时间币已冻结', operator: buyerOpenid }],
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

const s = i => skills[i]
const orders = [
  // 我是买家
  mkOrder('TB20250601120001', s(0), OPENID.me, OPENID.guitar, 'waiting',
    { days: 0.1, remark: '想学《晴天》，周末下午有空', expectTime: '周六 15:00 之后' }),
  mkOrder('TB20250530143002', s(2), OPENID.me, OPENID.photo, 'ongoing',
    { days: 2, remark: '考研报名用的证件照', acceptTime: daysAgo(2), expectTime: '周五上午' }),
  mkOrder('TB20250528110003', s(4), OPENID.me, OPENID.math, 'confirming',
    { days: 4, acceptTime: daysAgo(4), finishTime: hoursAgo(6), remark: '概率论期末救命' }),
  mkOrder('TB20250520153004', s(6), OPENID.me, OPENID.design, 'finished',
    { days: 12, acceptTime: daysAgo(12), finishTime: daysAgo(11), confirmTime: daysAgo(11), isRatedBuyer: true, buyerScore: 5, isRatedSeller: true, sellerScore: 5 }),
  mkOrder('TB20250515203005', s(8), OPENID.me, OPENID.pc, 'finished',
    { days: 17, acceptTime: daysAgo(17), finishTime: daysAgo(17), confirmTime: daysAgo(17), isRatedBuyer: true, buyerScore: 4 }),
  mkOrder('TB20250510101506', s(9), OPENID.me, OPENID.run, 'canceled',
    { days: 22, cancelBy: 'buyer', cancelReason: '临时有事，改天再约', cancelTime: daysAgo(21) }),
  // 我是卖家
  mkOrder('TB20250601180007', s(13), OPENID.guitar, OPENID.me, 'ongoing',
    { days: 1.2, acceptTime: hoursAgo(20), remark: '小程序开发遇到个 bug，想请你看看' }),
  mkOrder('TB20250529100008', s(12), OPENID.design, OPENID.me, 'finished',
    { days: 5, acceptTime: daysAgo(5), finishTime: daysAgo(4), confirmTime: daysAgo(4), isRatedBuyer: true, buyerScore: 5, isRatedSeller: false }),
  mkOrder('TB20250525142009', s(14), OPENID.math, OPENID.me, 'confirming',
    { days: 7, acceptTime: daysAgo(6), finishTime: daysAgo(1), remark: '陪我打两小时羽毛球' })
]

/* ------------------------------------------------------------------
 * ⑤ 批量生成历史订单，撑起看板的订单量、热门技能、分类分布与 30 天趋势
 *
 * ★ 必须用 push 追加到末尾，绝不能用 unshift：
 *   下面的 reviews / walletLogs / chats 都是按 orders[3]、orders[4]
 *   这类**下标**引用的，插到前面会把它们全部指错对象。
 * ------------------------------------------------------------------ */
const DEMO_ORDER_STATUS = [
  'finished', 'finished', 'finished', 'finished', 'finished',
  'finished', 'finished', 'finished', 'finished', 'finished',
  'ongoing', 'confirming', 'canceled'
]
let demoSeq = 0
for (let dayOffset = 29; dayOffset >= 0; dayOffset--) {
  // ★ 天数越近单量越多，且今天特意安排得最多 —— 目的是让看板头部的
  //   「今日新增 / 增长率」呈现正向。纯随机撒点会出现「今天恰好比昨天少」
  //   的向下红箭头，答辩演示时没有说服力。
  //   （这是演示数据的设计取向；真实部署时完全由实际数据决定。）
  const perDay = dayOffset === 0 ? 8 : 1 + Math.floor((29 - dayOffset) / 5)
  for (let k = 0; k < perDay; k++) {
  const buyer = users[rndInt(0, users.length - 1)]
  let seller = users[rndInt(0, users.length - 1)]
  if (seller._openid === buyer._openid) {
    seller = users[(users.indexOf(buyer) + 1) % users.length]
  }
  const sk = skills[rndInt(0, skills.length - 1)]
  const status = pickOne(DEMO_ORDER_STATUS)
  const created = demoTime(dayOffset)
  const amount = rndInt(1, 4)

  const o = mkOrder('TBD' + String(100000 + (demoSeq++)), sk, buyer._openid, seller._openid, status, { days: 0 })
  o.amount = amount
  o.skillSnapshot.price = amount
  o.createTime = created
  o.expireTime = new Date(created.getTime() + 86400000)
  o.timeline = [{ status: 'waiting', time: created, remark: '买家下单，时间币已冻结', operator: buyer._openid }]

  if (status !== 'waiting') {
    o.acceptTime = new Date(created.getTime() + 3600000)
    o.timeline.push({ status: 'ongoing', time: o.acceptTime, remark: '服务者已接单', operator: seller._openid })
  }
  if (status === 'confirming' || status === 'finished') {
    o.finishTime = new Date(created.getTime() + 7200000)
    o.timeline.push({ status: 'confirming', time: o.finishTime, remark: '服务者标记服务完成', operator: seller._openid })
  }
  if (status === 'finished') {
    o.confirmTime = new Date(created.getTime() + 10800000)
    o.timeline.push({ status: 'finished', time: o.confirmTime, remark: '买家确认完成，时间币已结算', operator: buyer._openid })
    o.isRatedBuyer = true
    o.buyerScore = rndInt(4, 5)
    o.isRatedSeller = rnd() > 0.3
    o.sellerScore = rndInt(4, 5)
  }
  if (status === 'canceled' || status === 'closed') {
    o.cancelBy = status === 'closed' ? 'system' : 'buyer'
    o.cancelReason = status === 'closed' ? '超时未接单，系统自动取消' : '用户取消'
    o.cancelTime = new Date(created.getTime() + 5400000)
    o.timeline.push({ status, time: o.cancelTime, remark: o.cancelReason, operator: buyer._openid })
  }
  orders.push(o)
  }
}

/* ============================ 评价 ============================ */
const reviews = [
  {
    _id: rid('rv'), orderId: orders[3]._id, skillId: s(6)._id,
    fromId: OPENID.me, fromInfo: { nickName: '张小明', avatarUrl: '' },
    toId: OPENID.design, toInfo: { nickName: '刘佳怡', avatarUrl: '' },
    role: 'buyer', score: 5, tags: ['专业靠谱', '态度超好', '效率很高'],
    content: '海报改了两版就完全达到我想要的风格，社团招新那天好多人问是谁做的。强烈推荐！',
    anonymous: false, reply: { content: '谢谢你！下次社团活动图还找我～', time: daysAgo(10) },
    createTime: daysAgo(11)
  },
  {
    _id: rid('rv'), orderId: orders[4]._id, skillId: s(8)._id,
    fromId: OPENID.me, fromInfo: { nickName: '张小明', avatarUrl: '' },
    toId: OPENID.pc, toInfo: { nickName: '赵一鸣', avatarUrl: '' },
    role: 'buyer', score: 4, tags: ['准时守约', '效率很高'],
    content: '清灰很利索，装环境也顺手帮我搞定了。就是约的时间稍微晚了一点，整体还是很满意。',
    anonymous: false, reply: null, createTime: daysAgo(17)
  },
  {
    _id: rid('rv'), orderId: orders[7]._id, skillId: s(12)._id,
    fromId: OPENID.design, fromInfo: { nickName: '刘佳怡', avatarUrl: '' },
    toId: OPENID.me, toInfo: { nickName: '张小明', avatarUrl: '' },
    role: 'seller', score: 5, tags: ['专业靠谱', '讲解细致'],
    content: '帮我理清了小程序里云函数的调用顺序，讲得特别清楚，还顺手帮我看了数据库权限。',
    anonymous: false, reply: null, createTime: daysAgo(4)
  },
  {
    _id: rid('rv'), skillId: s(0)._id,
    fromId: OPENID.math, fromInfo: { nickName: '陈子豪', avatarUrl: '' },
    toId: OPENID.guitar, toInfo: { nickName: '李思远', avatarUrl: '' },
    role: 'buyer', score: 5, tags: ['准时守约', '讲解细致', '物超所值'],
    content: '第一节课就学会了按和弦，社长特别有耐心，我这种手残都能弹出来。',
    anonymous: false, reply: null, createTime: daysAgo(8)
  },
  {
    _id: rid('rv'), skillId: s(2)._id,
    fromId: OPENID.run, fromInfo: { nickName: '孙晓雯', avatarUrl: '' },
    toId: OPENID.photo, toInfo: { nickName: '王雨桐', avatarUrl: '' },
    role: 'buyer', score: 5, tags: ['专业靠谱', '效率很高', '态度超好'],
    content: '证件照拍得很好看，当天晚上就把修好的图发我了，办证直接用，一次通过。',
    anonymous: true, reply: null, createTime: daysAgo(6)
  },
  {
    _id: rid('rv'), skillId: s(4)._id,
    fromId: OPENID.pc, fromInfo: { nickName: '赵一鸣', avatarUrl: '' },
    toId: OPENID.math, toInfo: { nickName: '陈子豪', avatarUrl: '' },
    role: 'buyer', score: 5, tags: ['讲解细致', '物超所值'],
    content: '概率论本来要挂了，两小时被他讲明白，期末考了 82 分。救命的辅导。',
    anonymous: false, reply: null, createTime: daysAgo(3)
  }
]

/* ============================ 时间币流水 ============================ */
let walletLogs = [
  { _id: rid('wl'), type: 'bonus', amount: 5, balance: 5, frozen: 0, orderId: '', orderNo: '', remark: '新用户注册赠送', createTime: daysAgo(40) },
  { _id: rid('wl'), type: 'freeze', amount: -2, balance: 10, frozen: 2, orderId: orders[0]._id, orderNo: orders[0].orderNo, remark: '下单冻结：' + orders[0].skillSnapshot.title, createTime: orders[0].createTime },
  { _id: rid('wl'), type: 'freeze', amount: -2, balance: 8, frozen: 4, orderId: orders[1]._id, orderNo: orders[1].orderNo, remark: '下单冻结：' + orders[1].skillSnapshot.title, createTime: orders[1].createTime },
  { _id: rid('wl'), type: 'unfreeze', amount: 2, balance: 10, frozen: 2, orderId: orders[5]._id, orderNo: orders[5].orderNo, remark: '订单取消，时间币退回', createTime: daysAgo(21) },
  { _id: rid('wl'), type: 'income', amount: 3, balance: 13, frozen: 0, orderId: orders[7]._id, orderNo: orders[7].orderNo, remark: '服务收入：小程序开发答疑', createTime: daysAgo(4) },
  { _id: rid('wl'), type: 'expense', amount: -3, balance: 10, frozen: 0, orderId: orders[3]._id, orderNo: orders[3].orderNo, remark: '服务支出：海报设计', createTime: daysAgo(11) },
  { _id: rid('wl'), type: 'income', amount: 3, balance: 13, frozen: 0, orderId: orders[8]._id, orderNo: orders[8].orderNo, remark: '服务收入：羽毛球陪打', createTime: daysAgo(1) },
  { _id: rid('wl'), type: 'expense', amount: -1, balance: 12, frozen: 0, orderId: orders[4]._id, orderNo: orders[4].orderNo, remark: '服务支出：电脑清灰', createTime: daysAgo(17) }
]

/* ============================ 信用分流水 ============================ */
const creditLogs = [
  { _id: rid('cl'), change: 2, score: 112, reason: 'order_finish', reasonText: '订单顺利完成', orderId: orders[7]._id, createTime: daysAgo(4) },
  { _id: rid('cl'), change: 1, score: 110, reason: 'review_5', reasonText: '收到 5 星好评', orderId: orders[7]._id, createTime: daysAgo(4) },
  { _id: rid('cl'), change: 2, score: 109, reason: 'order_finish', reasonText: '订单顺利完成', orderId: orders[3]._id, createTime: daysAgo(11) },
  { _id: rid('cl'), change: 1, score: 107, reason: 'review_5', reasonText: '收到 5 星好评', orderId: orders[3]._id, createTime: daysAgo(11) },
  { _id: rid('cl'), change: 3, score: 106, reason: 'ontime_streak', reasonText: '连续 5 单按时完成', orderId: '', createTime: daysAgo(12) },
  { _id: rid('cl'), change: -5, score: 103, reason: 'cancel_after_accept', reasonText: '接单后取消 / 爽约', orderId: orders[5]._id, createTime: daysAgo(21) },
  { _id: rid('cl'), change: 2, score: 108, reason: 'order_finish', reasonText: '订单顺利完成', orderId: orders[4]._id, createTime: daysAgo(17) }
]

/* ============================ 会话与消息 ============================ */
const chats = [
  {
    _id: 'chat_guitar',
    members: [OPENID.me, OPENID.guitar].sort(),
    memberInfos: {
      [OPENID.me]: { nickName: '张小明', avatarUrl: '', creditScore: 112 },
      [OPENID.guitar]: { nickName: '李思远', avatarUrl: '', creditScore: 128 }
    },
    orderId: orders[0]._id, orderNo: orders[0].orderNo,
    lastMsg: '好的，那就周六下午三点，艺术楼琴房见～',
    lastMsgType: 'text', lastTime: minsAgo(25),
    unread: { [OPENID.me]: 2 }, createTime: daysAgo(0.1), updateTime: minsAgo(25)
  },
  {
    _id: 'chat_photo',
    members: [OPENID.me, OPENID.photo].sort(),
    memberInfos: {
      [OPENID.me]: { nickName: '张小明', avatarUrl: '', creditScore: 112 },
      [OPENID.photo]: { nickName: '王雨桐', avatarUrl: '', creditScore: 121 }
    },
    orderId: orders[1]._id, orderNo: orders[1].orderNo,
    lastMsg: '照片我已经修好了，你看看还满意吗？',
    lastMsgType: 'text', lastTime: hoursAgo(5),
    unread: { [OPENID.me]: 1 }, createTime: daysAgo(2), updateTime: hoursAgo(5)
  },
  {
    _id: 'chat_math',
    members: [OPENID.me, OPENID.math].sort(),
    memberInfos: {
      [OPENID.me]: { nickName: '张小明', avatarUrl: '', creditScore: 112 },
      [OPENID.math]: { nickName: '陈子豪', avatarUrl: '', creditScore: 133 }
    },
    orderId: orders[2]._id, orderNo: orders[2].orderNo,
    lastMsg: '我这边已经标记服务完成了，你确认一下就能收到时间币。',
    lastMsgType: 'text', lastTime: hoursAgo(6),
    unread: {}, createTime: daysAgo(4), updateTime: hoursAgo(6)
  },
  {
    _id: 'chat_design',
    members: [OPENID.me, OPENID.design].sort(),
    memberInfos: {
      [OPENID.me]: { nickName: '张小明', avatarUrl: '', creditScore: 112 },
      [OPENID.design]: { nickName: '刘佳怡', avatarUrl: '', creditScore: 109 }
    },
    orderId: '', orderNo: '',
    lastMsg: '下次有海报需求随时找我！',
    lastMsgType: 'text', lastTime: daysAgo(4),
    unread: {}, createTime: daysAgo(12), updateTime: daysAgo(4)
  }
]

const messages = [
  { _id: rid('m'), _openid: OPENID.me, chatId: 'chat_guitar', fromId: OPENID.me, toId: OPENID.guitar, type: 'text', content: '你好！我在广场看到你的吉他课，零基础真的能学会吗？', read: true, createTime: hoursAgo(3) },
  { _id: rid('m'), _openid: OPENID.guitar, chatId: 'chat_guitar', fromId: OPENID.guitar, toId: OPENID.me, type: 'text', content: '完全可以！第一节课先认识琴和基本指法，第二节课就能按和弦了。你之前完全没接触过吗？', read: true, createTime: hoursAgo(2.8) },
  { _id: rid('m'), _openid: OPENID.me, chatId: 'chat_guitar', fromId: OPENID.me, toId: OPENID.guitar, type: 'text', content: '完全零基础，就想学会弹一首《晴天》。', read: true, createTime: hoursAgo(2.5) },
  { _id: rid('m'), _openid: OPENID.guitar, chatId: 'chat_guitar', fromId: OPENID.guitar, toId: OPENID.me, type: 'text', content: '《晴天》很适合入门，三个和弦就能弹下来。我这边有谱子，到时候直接给你。琴我带两把，你不用准备。', read: true, createTime: hoursAgo(1) },
  { _id: rid('m'), _openid: OPENID.me, chatId: 'chat_guitar', fromId: OPENID.me, toId: OPENID.guitar, type: 'text', content: '太好了，那我需要提前练什么吗？', read: true, createTime: minsAgo(40) },
  { _id: rid('m'), _openid: OPENID.guitar, chatId: 'chat_guitar', fromId: OPENID.guitar, toId: OPENID.me, type: 'text', content: '不用，手洗干净剪好指甲就行 😄', read: false, createTime: minsAgo(30) },
  { _id: rid('m'), _openid: OPENID.guitar, chatId: 'chat_guitar', fromId: OPENID.guitar, toId: OPENID.me, type: 'text', content: '好的，那就周六下午三点，艺术楼琴房见～', read: false, createTime: minsAgo(25) },

  { _id: rid('m'), _openid: OPENID.me, chatId: 'chat_photo', fromId: OPENID.me, toId: OPENID.photo, type: 'text', content: '你好，我想拍考研报名用的证件照，这两天方便吗？', read: true, createTime: daysAgo(2) },
  { _id: rid('m'), _openid: OPENID.photo, chatId: 'chat_photo', fromId: OPENID.photo, toId: OPENID.me, type: 'text', content: '方便的，我周五上午在宿舍，带白底和蓝底都可以。你穿深色上衣会比较好看。', read: true, createTime: daysAgo(2) },
  { _id: rid('m'), _openid: OPENID.photo, chatId: 'chat_photo', fromId: OPENID.photo, toId: OPENID.me, type: 'text', content: '照片我已经修好了，你看看还满意吗？', read: false, createTime: hoursAgo(5) },

  { _id: rid('m'), _openid: OPENID.math, chatId: 'chat_math', fromId: OPENID.math, toId: OPENID.me, type: 'text', content: '今晚把概率论最后两章给你过一下，带上你的往年卷子。', read: true, createTime: daysAgo(4) },
  { _id: rid('m'), _openid: OPENID.me, chatId: 'chat_math', fromId: OPENID.me, toId: OPENID.math, type: 'text', content: '好的，图书馆三楼研讨间，晚上七点。', read: true, createTime: daysAgo(4) },
  { _id: rid('m'), _openid: OPENID.math, chatId: 'chat_math', fromId: OPENID.math, toId: OPENID.me, type: 'text', content: '我这边已经标记服务完成了，你确认一下就能收到时间币。', read: true, createTime: hoursAgo(6) },

  { _id: rid('m'), _openid: OPENID.design, chatId: 'chat_design', fromId: OPENID.design, toId: OPENID.me, type: 'text', content: '下次有海报需求随时找我！', read: true, createTime: daysAgo(4) }
]

/* ============================ 系统通知 ============================ */
const notices = [
  { _id: rid('n'), _openid: OPENID.me, type: 'order', title: '服务已完成，请确认', content: '陈子豪 已标记「高数期末突击辅导」服务完成，确认后时间币将结算给 TA。', orderId: orders[2]._id, read: false, createTime: hoursAgo(6) },
  { _id: rid('n'), _openid: OPENID.me, type: 'order', title: '有人接单啦', content: '李思远 已接下你的「吉他入门一对一」订单，快去聊聊具体时间吧。', orderId: orders[0]._id, read: false, createTime: minsAgo(28) },
  { _id: rid('n'), _openid: OPENID.me, type: 'credit', title: '信用分 +2', content: '订单顺利完成，信用分从 110 提升到 112。继续保持！', orderId: orders[7]._id, read: true, createTime: daysAgo(4) },
  { _id: rid('n'), _openid: OPENID.me, type: 'audit', title: '校园认证已通过', content: '你的校园认证资料已通过审核，现在可以发布技能和下单了。', orderId: '', read: true, createTime: daysAgo(30) },
  { _id: rid('n'), _openid: OPENID.me, type: 'system', title: '欢迎加入校园时间银行', content: '我们已赠送 5 枚时间币作为起步资金。时间币不可充值、不可提现，只能通过帮助他人获得。', orderId: '', read: true, createTime: daysAgo(40) }
]

/* ============================ 举报 ============================ */
const reports = [
  { _id: rid('rp'), _openid: OPENID.run, targetType: 'skill', targetId: skills[5]._id, targetTitle: '线性代数 / 概率论 答疑', targetUserId: OPENID.math, reason: '虚假信息 / 与描述不符', remark: '描述里写「考前突击」，实际约了两次都临时放我鸽子，希望能核实一下。', images: [], status: 0, handleRemark: '', handlerId: '', handleTime: null, createTime: hoursAgo(10) },
  { _id: rid('rp'), _openid: OPENID.pc, targetType: 'user', targetId: OPENID.design, targetTitle: '刘佳怡', targetUserId: OPENID.design, reason: '爽约 / 服务态度恶劣', remark: '约定时间没出现，也没提前说明。', images: [], status: 1, handleRemark: '已联系双方核实，对被举报人信用分扣除 5 分并警告。', handlerId: OPENID.me, handleTime: daysAgo(2), createTime: daysAgo(5) }
]

/* ============================ 轮播 ============================ */
const banners = [
  { _id: 'b1', image: '', title: '广职院技能互助：山上山下都能约到帮手', link: '', sort: 1, status: 1 },
  { _id: 'b2', image: '', title: '时间币不可充值、不可提现，只能靠帮助他人获得', link: '', sort: 2, status: 1 },
  { _id: 'b3', image: '', title: '完成校园认证解锁全部功能；约在饭堂、图书馆等公共场所更安心', link: '/pages/auth/campus/campus', sort: 3, status: 1 }
]

/* ============================ 收藏（第 14 个集合） ============================
 * 与云端 favorites 集合等价：{ _openid, skillId, createTime }
 * 单独建集合而不是在 skills 上挂数组，技能文档不会随收藏人数膨胀。
 * ========================================================================== */
const favorites = []

/* ============================ 全局配置 ============================ */
const config = {
  _id: 'global',
  registerBonus: 5,
  orderExpireHours: 24,
  confirmExpireHours: 72,
  minCreditToOrder: 60,
  serviceFee: 0,
  hotCategories: ['c1', 'c2', 'c3'],
  aboutUs: '广东职业技术学院（广职院）校园时间银行：用「时间币」衡量每一次帮助，1 次服务 = 若干时间币。时间币不可充值、不可提现，只能通过帮助他人获得。山上山下、饭堂图书馆，约在公共区域见面更安心。',
  updateTime: daysAgo(3)
}

/* ==================================================================
 * 派发器
 * ================================================================== */
const PAGE_SIZE = 10

function paginate(list, page, size) {
  const p = Math.max(1, Number(page) || 1)
  const n = Number(size) || PAGE_SIZE
  const start = (p - 1) * n
  const slice = list.slice(start, start + n)
  return { list: clone(slice), total: list.length, hasMore: start + n < list.length }
}

/** 取当前用户（模拟环境恒为 me） */
const me = () => userMap[OPENID.me]

/** 给订单补上「对我而言的角色」 */
function withRole(o) {
  const r = clone(o)
  r.role = o.buyerId === OPENID.me ? 'buyer' : 'seller'
  r.roleText = r.role === 'buyer' ? '我买到的' : '我接的单'
  r.counterpart = r.role === 'buyer' ? o.sellerInfo : o.buyerInfo
  r.counterpartId = r.role === 'buyer' ? o.sellerId : o.buyerId
  return r
}

const handlers = {

  /* ================= login ================= */
  'login.login': () => ({ user: clone(me()), isNew: false, config: clone(config) }),

  'login.updateProfile': d => {
    Object.assign(me(), d || {})
    me().updateTime = now()
    return { user: clone(me()) }
  },

  'login.submitCampusAuth': d => {
    if (!d.realName || !d.studentNo) fail(400, '请填写姓名与学号')
    me().authStatus = 1
    me().authImages = d.authImages || []
    return { authStatus: 1 }
  },

  'login.bindPhone': () => ({ phone: '138****8888' }),

  'login.getUser': d => {
    const u = userMap[d.openid]
    if (!u) fail(404, '用户不存在')
    return { user: clone(u) }
  },

  'login.updateLocation': () => ({ ok: true }),

  /* ================= skill ================= */
  'skill.list': d => {
    let list = skills.filter(x => x.status === 1 || (d.includeMine && x.authorId === OPENID.me))
    if (d.categoryId) list = list.filter(x => x.categoryId === d.categoryId)
    if (d.type) list = list.filter(x => x.type === d.type)
    if (d.keyword) {
      const k = String(d.keyword).toLowerCase()
      list = list.filter(x =>
        x.title.toLowerCase().indexOf(k) > -1 ||
        x.desc.toLowerCase().indexOf(k) > -1 ||
        x.categoryName.indexOf(k) > -1 ||
        (x.tags || []).some(t => t.toLowerCase().indexOf(k) > -1)
      )
    }
    if (d.onlyVerified) list = list.filter(x => x.authorInfo && x.authorInfo.authStatus === 2)
    if (d.authorId) list = list.filter(x => x.authorId === d.authorId)

    const sort = d.sort || 'new'
    list = list.slice()

    if (sort === 'near') {
      // 附近排序：真实环境由 geoNear 按距离升序（**不看 isTop**）；
      // 模拟环境没有真实定位，按索引造一个递增的假距离
      list.forEach((x, i) => { x.distance = 200 + i * 180 })
    } else {
      // ★ 排序键必须与 skill 云函数**逐条一致**：
      //   云函数对 hot / priceAsc / priceDesc / new 都以 `isTop desc` 为第一排序键
      //   （见 cloudfunctions/skill/index.js 的 ORDER_BY 映射）。
      //   这里如果漏了 isTop，管理端点「置顶」在离线演示里就完全没反应，
      //   会被误判成按钮坏了。
      const byMode = {
        hot: (a, b) => b.viewCount - a.viewCount,
        priceAsc: (a, b) => a.price - b.price,
        priceDesc: (a, b) => b.price - a.price
      }[sort] || ((a, b) => new Date(b.createTime) - new Date(a.createTime))

      list.sort((a, b) =>
        ((b.isTop ? 1 : 0) - (a.isTop ? 1 : 0)) || byMode(a, b)
      )
    }
    const res = paginate(list, d.page, d.size)
    res.list.forEach(x => { if (x.distance === undefined) x.distance = 300 + Math.floor(Math.random() * 1500) })
    return res
  },

  'skill.detail': d => {
    const sk = skills.find(x => x._id === d.id)
    if (!sk) fail(404, '技能不存在或已被删除')
    sk.viewCount += 1
    return {
      skill: clone(sk),
      author: clone(userMap[sk.authorId] || {}),
      isOwner: sk.authorId === OPENID.me,
      // ★ 真实收藏态（不要硬编码 false —— 那样「收藏」功能等于没接）
      isCollected: favorites.some(f => f._openid === OPENID.me && f.skillId === sk._id)
    }
  },

  /** 收藏 / 取消收藏（契约与 skill.collect 一致；collected 缺省时 toggle） */
  'skill.collect': d => {
    const sk = skills.find(x => x._id === d.id)
    if (!sk) fail(404, '技能不存在')
    if (sk.status !== 1) fail(409, '该技能已下架，无法收藏')
    if (sk.authorId === OPENID.me) fail(400, '不能收藏自己发布的技能')

    const i = favorites.findIndex(f => f._openid === OPENID.me && f.skillId === d.id)
    const want = d.collected === undefined ? i < 0 : !!d.collected
    if (want && i < 0) {
      favorites.push({ _id: rid('fav'), _openid: OPENID.me, skillId: d.id, createTime: now() })
    } else if (!want && i > -1) {
      // 幂等：重复取消不报错
      favorites.splice(i, 1)
    }
    return { collected: want }
  },

  /** 我的收藏（按收藏时间倒序，附带 collectedTime） */
  'skill.myFavorites': d => {
    const mine = favorites.filter(f => f._openid === OPENID.me)
      .slice().sort((a, b) => new Date(b.createTime) - new Date(a.createTime))
    const list = mine
      .map(f => {
        const sk = skills.find(x => x._id === f.skillId)
        return sk ? Object.assign(clone(sk), { collectedTime: f.createTime }) : null
      })
      .filter(Boolean)
    const res = paginate(list, d.page, d.size)
    return Object.assign({}, res, { page: Math.max(1, Number(d.page) || 1) })
  },

  'skill.create': d => {
    if (!me().authStatus || me().authStatus !== 2) fail(403, '请先完成校园认证')
    // ★ 安全策略：必须带校内地点（与云端 skill.create 逐字对齐）
    const cLng = Number(d.longitude)
    const cLat = Number(d.latitude)
    if (!isFinite(cLng) || !isFinite(cLat)) fail(400, '请选择服务地点：只能发布校内的任务')
    if (!campus.isInside(cLat, cLng).inside) {
      fail(400, '只能发布校内地点。校外的任务一旦出现纠纷或意外，校方无法及时处理，请重新选择校内的位置')
    }
    const c = catMap[d.categoryId]
    const item = {
      _id: rid('skill'), _openid: OPENID.me, authorId: OPENID.me,
      authorInfo: {
        nickName: me().nickName, avatarUrl: me().avatarUrl,
        creditScore: me().creditScore, creditLevel: me().creditLevel, authStatus: me().authStatus
      },
      type: d.type || 'offer', title: d.title, desc: d.desc || '',
      categoryId: d.categoryId, categoryName: c ? c.name : '其他', categoryIcon: c ? c.icon : '✨',
      price: Number(d.price) || 1, duration: Number(d.duration) || 60,
      images: d.images || [], tags: d.tags || [],
      location: { type: 'Point', coordinates: [cLng, cLat] },
      address: d.address || '', locationName: d.locationName || '',
      status: 1, auditRemark: '', viewCount: 0, orderCount: 0, isTop: false,
      createTime: now(), updateTime: now()
    }
    skills.unshift(item)
    me().stats.publishCount += 1
    return { id: item._id }
  },

  'skill.update': d => {
    const sk = skills.find(x => x._id === d.id)
    if (!sk) fail(404, '技能不存在')
    if (sk.authorId !== OPENID.me) fail(403, '只能编辑自己发布的技能')
    Object.assign(sk, d, { _id: sk._id, updateTime: now() })
    if (d.categoryId) {
      const c = catMap[d.categoryId]
      sk.categoryName = c ? c.name : '其他'
      sk.categoryIcon = c ? c.icon : '✨'
    }
    return { ok: true }
  },

  'skill.remove': d => {
    const idx = skills.findIndex(x => x._id === d.id)
    if (idx < 0) fail(404, '技能不存在')
    if (skills[idx].authorId !== OPENID.me) fail(403, '只能删除自己发布的技能')
    const hasOrder = orders.some(o => o.skillId === d.id && ['waiting', 'ongoing', 'confirming'].indexOf(o.status) > -1)
    if (hasOrder) fail(409, '该技能有进行中的订单，暂时不能删除')
    skills.splice(idx, 1)
    return { ok: true }
  },

  'skill.myList': d => {
    let list = skills.filter(x => x.authorId === OPENID.me)
    if (d.type) list = list.filter(x => x.type === d.type)
    if (d.status !== undefined && d.status !== null && d.status !== '') list = list.filter(x => x.status === Number(d.status))
    list = list.slice().sort((a, b) => new Date(b.createTime) - new Date(a.createTime))
    return paginate(list, d.page, d.size)
  },

  'skill.categories': () => ({ list: clone(categories.filter(c => c.status === 1).sort((a, b) => a.sort - b.sort)) }),
  'skill.banners': () => ({ list: clone(banners.filter(b => b.status === 1)) }),

  'skill.report': d => {
    reports.unshift({
      _id: rid('rp'), _openid: OPENID.me,
      targetType: d.targetType, targetId: d.targetId, targetTitle: d.targetTitle || '',
      targetUserId: d.targetUserId || '', reason: d.reason,
      remark: String(d.remark || '').slice(0, 200),   // 举报页的「补充说明」
      images: d.images || [],
      status: 0, handleRemark: '', handlerId: '', handleTime: null, createTime: now()
    })
    return { ok: true }
  },

  /* ================= order ================= */
  'order.create': d => {
    const sk = skills.find(x => x._id === d.skillId)
    if (!sk) fail(404, '技能不存在')
    if (sk.authorId === OPENID.me) fail(409, '不能购买自己发布的服务')
    const u = me()
    if (u.authStatus !== 2) fail(403, '请先完成校园认证')
    if (u.creditScore < config.minCreditToOrder) fail(403, `信用分低于 ${config.minCreditToOrder}，暂不能下单`)
    if (u.coins < sk.price) fail(409, `时间币不足，还差 ${sk.price - u.coins} 枚`)

    u.coins -= sk.price
    u.frozenCoins += sk.price
    const orderNo = 'TB' + Date.now() + String(Math.floor(1000 + Math.random() * 9000))
    const o = mkOrder(orderNo, sk, OPENID.me, sk.authorId, 'waiting', {
      remark: d.remark || '', expectTime: d.expectTime || '', contact: d.contact || ''
    })
    orders.unshift(o)
    walletLogs.unshift({
      _id: rid('wl'), type: 'freeze', amount: -sk.price,
      balance: u.coins, frozen: u.frozenCoins,
      orderId: o._id, orderNo, remark: '下单冻结：' + sk.title, createTime: now()
    })
    notices.unshift({
      _id: rid('n'), _openid: sk.authorId, type: 'order', title: '收到新订单',
      content: `${u.nickName} 想要你的「${sk.title}」，快去看看吧。`,
      orderId: o._id, read: false, createTime: now()
    })
    return { orderId: o._id, orderNo }
  },

  'order.accept': d => {
    const o = orders.find(x => x._id === d.orderId)
    if (!o) fail(404, '订单不存在')
    if (o.sellerId !== OPENID.me && !isMockManager()) fail(403, '只有服务者可以接单')
    if (o.status !== 'waiting') fail(409, '该订单已被处理')
    o.status = 'ongoing'
    o.acceptTime = now()
    o.timeline.push({ status: 'ongoing', time: now(), remark: '服务者已接单', operator: OPENID.me })
    notices.unshift({
      _id: rid('n'), _openid: o.buyerId, type: 'order', title: '有人接单啦',
      content: `${o.sellerInfo.nickName} 已接下你的「${o.skillSnapshot.title}」。`,
      orderId: o._id, read: false, createTime: now()
    })
    return { ok: true }
  },

  'order.reject': d => {
    const o = orders.find(x => x._id === d.orderId)
    if (!o) fail(404, '订单不存在')
    if (o.sellerId !== OPENID.me) fail(403, '只有服务者可以拒单')
    if (o.status !== 'waiting') fail(409, '该订单已被处理')
    o.status = 'closed'
    o.cancelBy = 'seller'
    o.cancelReason = d.reason || '服务者暂时无法接单'
    o.cancelTime = now()
    o.timeline.push({ status: 'closed', time: now(), remark: '服务者拒绝接单：' + o.cancelReason, operator: OPENID.me })
    refund(o)
    return { ok: true }
  },

  'order.cancel': d => {
    const o = orders.find(x => x._id === d.orderId)
    if (!o) fail(404, '订单不存在')
    if ([o.buyerId, o.sellerId].indexOf(OPENID.me) < 0) fail(403, '无权操作该订单')
    if (['waiting', 'ongoing'].indexOf(o.status) < 0) fail(409, '当前状态不能取消')
    const by = o.buyerId === OPENID.me ? 'buyer' : 'seller'
    const wasOngoing = o.status === 'ongoing'
    o.status = 'canceled'
    o.cancelBy = by
    o.cancelReason = d.reason || '用户取消'
    o.cancelTime = now()
    o.timeline.push({ status: 'canceled', time: now(), remark: `${by === 'buyer' ? '买家' : '服务者'}取消：${o.cancelReason}`, operator: OPENID.me })
    refund(o)
    // 已接单后取消 = 爽约，取消方扣 5 分信用分
    if (wasOngoing) addCredit(OPENID.me, -5, 'cancel_after_accept', '接单后取消 / 爽约', o._id)
    return { ok: true }
  },

  'order.finish': d => {
    const o = orders.find(x => x._id === d.orderId)
    if (!o) fail(404, '订单不存在')
    if (o.sellerId !== OPENID.me) fail(403, '只有服务者可以标记完成')
    if (o.status !== 'ongoing') fail(409, '当前状态不能标记完成')
    o.status = 'confirming'
    o.finishTime = now()
    o.timeline.push({ status: 'confirming', time: now(), remark: '服务者标记服务完成，等待买家确认', operator: OPENID.me })
    notices.unshift({
      _id: rid('n'), _openid: o.buyerId, type: 'order', title: '服务已完成，请确认',
      content: `${o.sellerInfo.nickName} 已标记「${o.skillSnapshot.title}」服务完成，确认后时间币将结算给 TA。`,
      orderId: o._id, read: false, createTime: now()
    })
    return { ok: true }
  },

  'order.confirm': d => {
    const o = orders.find(x => x._id === d.orderId)
    if (!o) fail(404, '订单不存在')
    if (o.buyerId !== OPENID.me) fail(403, '只有买家可以确认完成')
    if (o.status !== 'confirming') fail(409, '当前状态不能确认')

    const buyer = userMap[o.buyerId]
    const seller = userMap[o.sellerId]
    buyer.frozenCoins = Math.max(0, buyer.frozenCoins - o.amount)
    buyer.totalSpent += o.amount
    seller.coins += o.amount
    seller.totalEarned += o.amount
    seller.stats.serveCount += 1
    buyer.stats.buyCount += 1

    o.status = 'finished'
    o.confirmTime = now()
    o.timeline.push({ status: 'finished', time: now(), remark: '买家确认完成，时间币已结算', operator: OPENID.me })

    walletLogs.unshift({
      _id: rid('wl'), type: 'expense', amount: -o.amount,
      balance: buyer.coins, frozen: buyer.frozenCoins,
      orderId: o._id, orderNo: o.orderNo, remark: '完成结算：' + o.skillSnapshot.title, createTime: now()
    })
    walletLogs.unshift({
      _id: rid('wl'), type: 'income', amount: o.amount,
      balance: seller.coins, frozen: seller.frozenCoins,
      orderId: o._id, orderNo: o.orderNo, remark: '服务收入：' + o.skillSnapshot.title, createTime: now()
    })
    addCredit(o.buyerId, 2, 'order_finish', '订单顺利完成', o._id)
    addCredit(o.sellerId, 2, 'order_finish', '订单顺利完成', o._id)
    notices.unshift({
      _id: rid('n'), _openid: o.sellerId, type: 'order', title: '时间币已到账',
      content: `「${o.skillSnapshot.title}」已完成，${o.amount} 枚时间币已到账。记得和对方互评哦～`,
      orderId: o._id, read: false, createTime: now()
    })
    return { ok: true }
  },

  'order.list': d => {
    const role = d.role || 'buyer'
    let list = orders.filter(o => (role === 'buyer' ? o.buyerId : o.sellerId) === OPENID.me)
    if (d.status && d.status !== 'all') {
      if (d.status === 'canceled') list = list.filter(o => ['canceled', 'closed'].indexOf(o.status) > -1)
      else list = list.filter(o => o.status === d.status)
    }
    list = list.slice().sort((a, b) => new Date(b.createTime) - new Date(a.createTime))
    const res = paginate(list, d.page, d.size)
    res.list = res.list.map(withRole)
    return res
  },

  'order.detail': d => {
    const o = orders.find(x => x._id === d.orderId || x.orderNo === d.orderId)
    if (!o) fail(404, '订单不存在')
    const isBuyer = o.buyerId === OPENID.me
    const isSeller = o.sellerId === OPENID.me
    const isParty = isBuyer || isSeller
    if (!isParty && !isMockManager()) fail(403, '无权查看该订单')
    // ★ 非参与方的管理员：role 返回 'admin'，与 order 云函数保持一致，
    //   前端据此隐藏所有状态操作按钮（不能代替买卖双方操作）
    if (!isParty) return { order: clone(o), role: 'admin', roleText: '订单详情' }
    return { order: withRole(o), role: isBuyer ? 'buyer' : 'seller' }
  },

  'order.counts': () => {
    const mine = orders.filter(o => o.buyerId === OPENID.me || o.sellerId === OPENID.me)
    const c = { waiting: 0, ongoing: 0, confirming: 0, finished: 0, canceled: 0 }
    mine.forEach(o => {
      if (o.status === 'closed') c.canceled += 1
      else if (c[o.status] !== undefined) c[o.status] += 1
    })
    return c
  },

  /* ================= wallet ================= */
  'wallet.info': () => {
    const u = me()
    return {
      coins: u.coins, frozenCoins: u.frozenCoins,
      totalEarned: u.totalEarned, totalSpent: u.totalSpent,
      income7d: 6, expense7d: 3
    }
  },

  'wallet.logs': d => {
    let list = walletLogs.filter(x => !x._openid || x._openid === OPENID.me)
    if (d.type && d.type !== 'all') {
      if (d.type === 'income') list = list.filter(x => ['income', 'bonus', 'unfreeze', 'refund'].indexOf(x.type) > -1)
      else if (d.type === 'expense') list = list.filter(x => ['expense', 'settle'].indexOf(x.type) > -1)
      else list = list.filter(x => x.type === d.type)
    }
    list = list.slice().sort((a, b) => new Date(b.createTime) - new Date(a.createTime))
    return paginate(list, d.page, d.size)
  },

  'wallet.stats': () => {
    // ★ 用固定值而不是随机数：下拉刷新时柱图数字不能跳动，
    //   否则答辩演示时每次刷新都变，看起来像 bug。
    const income = [0, 2, 0, 3, 1, 0, 2]
    const expense = [1, 0, 2, 0, 0, 2, 1]
    const trend = []
    for (let i = 6; i >= 0; i--) {
      const d = new Date(Date.now() - i * 86400000)
      const key = `${d.getMonth() + 1}/${d.getDate()}`
      const idx = 6 - i
      trend.push({ date: key, income: income[idx], expense: expense[idx] })
    }
    return {
      trend,
      byCategory: [
        { name: '技能教学', value: 8 },
        { name: '学业辅导', value: 5 },
        { name: '摄影修图', value: 4 },
        { name: '电脑技术', value: 3 },
        { name: '运动健身', value: 2 }
      ]
    }
  },

  /* ================= user ================= */
  'user.mine': () => {
    const u = me()
    const mineOrders = orders.filter(o => o.buyerId === OPENID.me || o.sellerId === OPENID.me)
    return {
      user: clone(u),
      counts: {
        publish: skills.filter(x => x.authorId === OPENID.me).length,
        serve: u.stats.serveCount,
        buy: u.stats.buyCount,
        // ★ 与云函数对齐：必须按 _openid 过滤，否则未读数会把别人的通知算进来
        unreadNotice: notices.filter(n => n._openid === OPENID.me && !n.read).length,
        collected: favorites.filter(f => f._openid === OPENID.me).length,
        waitingOrder: mineOrders.filter(o => ['waiting', 'confirming'].indexOf(o.status) > -1).length,
        review: u.stats.reviewCount
      },
      badges: clone((u.badges || []).map(id => require('./constants').BADGE_MAP[id]).filter(Boolean))
    }
  },

  'user.home': d => {
    const openid = d.openid || OPENID.me
    const u = userMap[openid]
    if (!u) fail(404, '用户不存在')
    const pub = clone(u)
    delete pub.phone
    delete pub.studentNo
    delete pub.authImages
    return {
      user: pub,
      skills: clone(skills.filter(x => x.authorId === openid && x.status === 1).slice(0, 6)),
      reviews: clone(reviews.filter(r => r.toId === openid).slice(0, 3)),
      stats: clone(u.stats)
    }
  },

  'user.creditLogs': d => {
    const list = creditLogs.slice().sort((a, b) => new Date(b.createTime) - new Date(a.createTime))
    return paginate(list, d.page, d.size)
  },

  'user.badges': d => {
    const target = d.openid ? userMap[d.openid] : me()
    const { BADGES } = require('./constants')
    const owned = (target && target.badges) || []
    return {
      owned: clone(BADGES.filter(b => owned.indexOf(b.id) > -1)),
      all: clone(BADGES.map(b => Object.assign({}, b, { owned: owned.indexOf(b.id) > -1 })))
    }
  },

  'user.reviews': d => {
    const openid = d.openid || OPENID.me
    const role = d.role || 'received'
    const list = reviews.filter(r => (role === 'received' ? r.toId : r.fromId) === openid)
      .slice().sort((a, b) => new Date(b.createTime) - new Date(a.createTime))
    return paginate(list, d.page, d.size)
  },

  'user.reviewCreate': d => {
    const o = orders.find(x => x._id === d.orderId)
    if (!o) fail(404, '订单不存在')
    if (o.status !== 'finished') fail(409, '订单完成后才能评价')
    const isBuyer = o.buyerId === OPENID.me
    if (!isBuyer && o.sellerId !== OPENID.me) fail(403, '无权评价该订单')
    if (isBuyer && o.isRatedBuyer) fail(409, '你已经评价过了')
    if (!isBuyer && o.isRatedSeller) fail(409, '你已经评价过了')

    const toId = isBuyer ? o.sellerId : o.buyerId
    const fromInfo = isBuyer ? o.buyerInfo : o.sellerInfo
    const toInfo = isBuyer ? o.sellerInfo : o.buyerInfo
    reviews.unshift({
      _id: rid('rv'), orderId: o._id, skillId: o.skillId,
      fromId: OPENID.me, fromInfo: clone(fromInfo),
      toId, toInfo: clone(toInfo),
      role: isBuyer ? 'buyer' : 'seller',
      score: Number(d.score) || 5, tags: d.tags || [], content: d.content || '',
      anonymous: !!d.anonymous, reply: null, createTime: now()
    })
    if (isBuyer) { o.isRatedBuyer = true; o.buyerScore = Number(d.score) || 5 }
    else { o.isRatedSeller = true; o.sellerScore = Number(d.score) || 5 }

    const t = userMap[toId]
    if (t) {
      t.stats.reviewCount += 1
      t.stats.ratingSum += Number(d.score) || 5
      t.stats.avgRating = Math.round(t.stats.ratingSum / t.stats.reviewCount * 10) / 10
    }
    const delta = { 5: 1, 4: 0, 3: -1, 2: -2, 1: -3 }[Number(d.score) || 5]
    if (delta) addCredit(toId, delta, 'review_' + (Number(d.score) || 5), `收到 ${d.score} 星评价`, o._id)
    return { ok: true }
  },

  'user.reviewReply': d => {
    const r = reviews.find(x => x._id === d.reviewId)
    if (!r) fail(404, '评价不存在')
    if (r.toId !== OPENID.me) fail(403, '只能回复给自己的评价')
    r.reply = { content: d.content, time: now() }
    return { ok: true }
  },

  /* ================= message ================= */
  'message.conversations': d => {
    const list = chats.filter(c => c.members.indexOf(OPENID.me) > -1)
      .slice().sort((a, b) => new Date(b.lastTime) - new Date(a.lastTime))
    const mapped = list.map(c => {
      const other = c.members.find(m => m !== OPENID.me)
      return Object.assign(clone(c), {
        otherId: other,
        otherInfo: c.memberInfos[other] || { nickName: '用户', avatarUrl: '' },
        unreadCount: (c.unread && c.unread[OPENID.me]) || 0
      })
    })
    return paginate(mapped, d.page, d.size)
  },

  'message.openChat': d => {
    let c = chats.find(x => x.members.indexOf(OPENID.me) > -1 && x.members.indexOf(d.toId) > -1)
    if (!c) {
      const other = userMap[d.toId] || { nickName: '用户', avatarUrl: '', creditScore: 100 }
      c = {
        _id: rid('chat'),
        members: [OPENID.me, d.toId].sort(),
        memberInfos: {
          [OPENID.me]: { nickName: me().nickName, avatarUrl: me().avatarUrl, creditScore: me().creditScore },
          [d.toId]: { nickName: other.nickName, avatarUrl: other.avatarUrl, creditScore: other.creditScore }
        },
        orderId: d.orderId || '', orderNo: '',
        lastMsg: '', lastMsgType: 'text', lastTime: now(),
        unread: {}, createTime: now(), updateTime: now()
      }
      chats.unshift(c)
    }
    if (d.orderId && !c.orderId) c.orderId = d.orderId
    return { chatId: c._id }
  },

  'message.history': d => {
    // ★ 与云函数 §4.6 对齐：page=1 是**最新**一页，页内升序，hasMore 表示还有更早的。
    //   必须真实分页：恒返回全部消息且 hasMore:false，会让「上滑加载历史」这条分支
    //   在离线模式下永远走不到（mock / 云端行为分叉）。
    const all = messages.filter(m => m.chatId === d.chatId)
      .slice().sort((a, b) => new Date(a.createTime) - new Date(b.createTime))
    const page = Math.max(1, parseInt(d.page, 10) || 1)
    const size = Math.min(50, Math.max(1, parseInt(d.size, 10) || 20))
    const end = Math.max(0, all.length - (page - 1) * size)
    const start = Math.max(0, end - size)
    return { list: clone(all.slice(start, end)), hasMore: start > 0 }
  },

  'message.send': d => {
    const c = chats.find(x => x._id === d.chatId)
    if (!c) fail(404, '会话不存在')
    if (c.members.indexOf(OPENID.me) < 0) fail(403, '你不在该会话中')
    const m = {
      _id: rid('m'), _openid: OPENID.me, chatId: d.chatId,
      fromId: OPENID.me, toId: d.toId, type: d.type || 'text',
      content: d.content, read: false, createTime: now()
    }
    messages.push(m)
    c.lastMsg = d.type === 'image' ? '[图片]' : d.content
    c.lastMsgType = d.type || 'text'
    c.lastTime = now()
    c.updateTime = now()
    c.unread = c.unread || {}
    c.unread[d.toId] = (c.unread[d.toId] || 0) + 1
    return { msgId: m._id, createTime: m.createTime }
  },

  'message.read': d => {
    const c = chats.find(x => x._id === d.chatId)
    if (c) { c.unread = c.unread || {}; c.unread[OPENID.me] = 0 }
    messages.forEach(m => { if (m.chatId === d.chatId && m.toId === OPENID.me) m.read = true })
    return { ok: true }
  },

  'message.unreadTotal': () => ({
    chat: chats.reduce((n, c) => n + ((c.unread && c.unread[OPENID.me]) || 0), 0),
    notice: notices.filter(n => !n.read).length
  }),

  'message.notices': d => {
    let list = notices.filter(n => n._openid === OPENID.me)
    if (d.type && d.type !== 'all') list = list.filter(n => n.type === d.type)
    list = list.slice().sort((a, b) => new Date(b.createTime) - new Date(a.createTime))
    return paginate(list, d.page, d.size)
  },

  'message.readNotice': d => {
    if (d.all) notices.forEach(n => { if (n._openid === OPENID.me) n.read = true })
    else {
      const n = notices.find(x => x._id === d.id)
      if (n) n.read = true
    }
    return { ok: true }
  },

  'message.subConfig': () => ({
    templates: [
      { id: 'ORDER_CREATE', title: '新订单提醒', key: 'ORDER_CREATE' },
      { id: 'ORDER_ACCEPT', title: '接单成功通知', key: 'ORDER_ACCEPT' },
      { id: 'ORDER_FINISH', title: '服务完成待确认', key: 'ORDER_FINISH' },
      { id: 'ORDER_CONFIRM', title: '确认完成到账', key: 'ORDER_CONFIRM' }
    ]
  }),

  /* ================= admin ================= */
  'admin.check': () => ({ isAdmin: me().role === 'admin' || me().role === 'debugger', isDebugger: me().role === 'debugger', role: me().role }),

  'admin.stats': d => {
    const range = [7, 14, 30].indexOf(Number(d && d.range)) > -1 ? Number(d.range) : 7
    const today = new Date()
    const yest = new Date(Date.now() - 86400000)

    // ★ 所有指标都由数据集**真实统计**得出，而不是硬编码一个大数字。
    //   这样「看板总数」与「列表页条数」永远一致 —— 否则看板显示 139 个用户、
    //   点进用户列表只有 9 条，答辩时这是必被追问的破绽。
    const trend = []
    for (let i = range - 1; i >= 0; i--) {
      const day = new Date(Date.now() - i * 86400000)
      const onDay = list => list.filter(x => x.createTime && sameDay(x.createTime, day))
      trend.push({
        date: `${day.getMonth() + 1}/${day.getDate()}`,
        users: onDay(users).length,
        orders: onDay(orders).length,
        coins: onDay(orders).reduce((n, o) => n + (o.amount || 0), 0)
      })
    }

    const countBy = (list, keyFn) => {
      const m = {}
      list.forEach(x => {
        const k = keyFn(x) || '其他'
        m[k] = (m[k] || 0) + 1
      })
      return Object.keys(m)
        .map(k => ({ name: k, value: m[k] }))
        .sort((a, b) => b.value - a.value)
    }

    const finished = orders.filter(o => o.status === 'finished')
    const totalRc = users.reduce((n, u) => n + ((u.stats && u.stats.reviewCount) || 0), 0)
    const totalRs = users.reduce((n, u) => n + ((u.stats && u.stats.ratingSum) || 0), 0)

    // 今日 / 昨日增长率（昨日为 0 时不返回 Infinity）
    const growth = (t, y) => (y ? Math.round((t - y) / y * 1000) / 10 : (t > 0 ? 100 : 0))
    const usersToday = users.filter(u => u.createTime && sameDay(u.createTime, today)).length
    const usersYest = users.filter(u => u.createTime && sameDay(u.createTime, yest)).length
    const ordersToday = orders.filter(o => o.createTime && sameDay(o.createTime, today)).length
    const ordersYest = orders.filter(o => o.createTime && sameDay(o.createTime, yest)).length

    // 订单状态分布：name 用中文，且**六个状态全部列出（含 0）**，
    // 保证前端饼图图例稳定，不会因为某状态无数据而抖动
    const orderStatusText = {
      finished: '已完成', ongoing: '服务中', waiting: '待接单',
      confirming: '待确认', canceled: '已取消', closed: '已关闭'
    }
    const orderStatusDist = ['finished', 'ongoing', 'waiting', 'confirming', 'canceled', 'closed']
      .map(k => ({ name: orderStatusText[k], value: orders.filter(o => o.status === k).length }))

    // 信用分区间：name 固定五档，与 constants.CREDIT_LEVELS 边界一致
    const creditBands = [
      [0, 59, '0-59'], [60, 79, '60-79'], [80, 99, '80-99'],
      [100, 119, '100-119'], [120, 150, '120-150']
    ]
    const creditDist = creditBands.map(([lo, hi, name]) => ({
      name,
      value: users.filter(u => (u.creditScore || 0) >= lo && (u.creditScore || 0) <= hi).length
    }))

    return {
      overview: {
        userTotal: users.length,
        userToday: usersToday,
        userGrowthRate: growth(usersToday, usersYest),
        orderTotal: orders.length,
        orderToday: ordersToday,
        orderGrowthRate: growth(ordersToday, ordersYest),
        coinCirculation: users.reduce((n, u) => n + (u.coins || 0), 0),
        coinFrozen: users.reduce((n, u) => n + (u.frozenCoins || 0), 0),
        coinEarned: users.reduce((n, u) => n + (u.totalEarned || 0), 0),
        finishRate: orders.length ? Math.round(finished.length / orders.length * 1000) / 10 : 0,
        avgRating: totalRc ? Math.round(totalRs / totalRc * 100) / 100 : 0,
        authPending: users.filter(u => u.authStatus === 1).length,
        reportPending: reports.filter(r => r.status === 0).length
      },
      trend,
      hotSkills: countBy(orders, o => o.skillSnapshot && o.skillSnapshot.title).slice(0, 8),
      categoryDist: countBy(orders, o => o.skillSnapshot && o.skillSnapshot.categoryName).slice(0, 8),
      orderStatusDist,
      creditDist,
      topUsers: clone(users.slice()
        .sort((a, b) => ((b.stats && b.stats.serveCount) || 0) - ((a.stats && a.stats.serveCount) || 0))
        .slice(0, 5)
        .map(u => ({
          openid: u._openid,
          nickName: u.nickName,
          avatarUrl: u.avatarUrl,
          serveCount: (u.stats && u.stats.serveCount) || 0,
          creditScore: u.creditScore,
          avgRating: (u.stats && u.stats.avgRating) || 0
        })))
    }
  },

  'admin.users': d => {
    let list = users.slice()
    if (d.keyword) {
      const k = String(d.keyword).toLowerCase()
      list = list.filter(u => u.nickName.toLowerCase().indexOf(k) > -1 || String(u.studentNo).indexOf(k) > -1)
    }
    if (d.authStatus !== undefined && d.authStatus !== null && d.authStatus !== '') list = list.filter(u => u.authStatus === Number(d.authStatus))
    if (d.status !== undefined && d.status !== null && d.status !== '') list = list.filter(u => u.status === Number(d.status))
    return paginate(list, d.page, d.size)
  },

  'admin.auditUser': d => {
    const u = users.find(x => x._openid === d.userId || x._id === d.userId)
    if (!u) fail(404, '用户不存在')
    u.authStatus = d.pass ? 2 : 3
    u.authRemark = d.remark || ''
    u.authTime = now()
    if (d.pass) {
      notices.unshift({
        _id: rid('n'), _openid: u._openid, type: 'audit', title: '校园认证已通过',
        content: '你的校园认证资料已通过审核，现在可以发布技能和下单了。',
        orderId: '', read: false, createTime: now()
      })
    }
    return { ok: true }
  },

  'admin.setUserStatus': d => {
    const u = users.find(x => x._openid === d.userId || x._id === d.userId)
    if (!u) fail(404, '用户不存在')
    u.status = Number(d.status)
    return { ok: true }
  },

  'admin.setUserRole': d => {
    const u = users.find(x => x._openid === d.userId || x._id === d.userId)
    if (!u) fail(404, '用户不存在')
    // 与云端 admin.setUserRole 同一套规则：调试员的授予/撤销只有调试员能做
  const wanted = ['user', 'admin', 'debugger'].indexOf(d.role) >= 0 ? d.role : 'user'
  if ((wanted === 'debugger' || u.role === 'debugger') && !isMockDebugger()) fail(403, '无管理员权限')
  u.role = wanted
    return { ok: true }
  },

  'admin.adjustCoins': d => {
    const u = users.find(x => x._openid === d.userId || x._id === d.userId)
    if (!u) fail(404, '用户不存在')
    const amount = Number(d.amount) || 0
    if (u.coins + amount < 0) fail(409, '调整后余额不能为负')
    u.coins += amount
    walletLogs.unshift({
      _id: rid('wl'), _openid: u._openid, type: 'admin', amount,
      balance: u.coins, frozen: u.frozenCoins, orderId: '', orderNo: '',
      remark: d.remark || '管理员调整', createTime: now()
    })
    return { ok: true }
  },

  'admin.categories': () => ({ list: clone(categories.slice().sort((a, b) => a.sort - b.sort)) }),

  'admin.saveCategory': d => {
    if (d._id) {
      const c = categories.find(x => x._id === d._id)
      if (!c) fail(404, '分类不存在')
      Object.assign(c, { name: d.name, icon: d.icon, sort: Number(d.sort) || 99, status: d.status === undefined ? c.status : Number(d.status) })
      return { id: c._id }
    }
    const c = { _id: rid('c'), name: d.name, icon: d.icon || '✨', sort: Number(d.sort) || 99, status: 1 }
    categories.push(c)
    return { id: c._id }
  },

  'admin.deleteCategory': d => {
    const used = skills.some(x => x.categoryId === d._id)
    if (used) fail(409, '该分类下还有技能，不能删除')
    const i = categories.findIndex(x => x._id === d._id)
    if (i < 0) fail(404, '分类不存在')
    categories.splice(i, 1)
    return { ok: true }
  },

  'admin.skills': d => {
    let list = skills.slice()
    if (d.status !== undefined && d.status !== null && d.status !== '') list = list.filter(x => x.status === Number(d.status))
    if (d.keyword) {
      const k = String(d.keyword).toLowerCase()
      list = list.filter(x => x.title.toLowerCase().indexOf(k) > -1)
    }
    list.sort((a, b) => new Date(b.createTime) - new Date(a.createTime))
    return paginate(list, d.page, d.size)
  },

  'admin.auditSkill': d => {
    const sk = skills.find(x => x._id === d.id)
    if (!sk) fail(404, '技能不存在')
    sk.status = Number(d.status)
    // remark 传了才更新（与 admin 云函数保持一致）：
    // 否则「只切置顶」会把原有的违规下架原因清空
    if (d.remark !== undefined) sk.auditRemark = String(d.remark || '')
    // ★ 必须支持 isTop：管理端「置顶」按钮走的就是这个 action，
    //   这里不处理的话离线模式点置顶会「没反应」
    if (d.isTop !== undefined) sk.isTop = !!d.isTop
    sk.updateTime = now()
    return { ok: true }
  },

  'admin.orders': d => {
    let list = orders.slice()
    if (d.status && d.status !== 'all') list = list.filter(x => x.status === d.status)
    if (d.keyword) {
      const k = String(d.keyword).toLowerCase()
      list = list.filter(x => x.orderNo.toLowerCase().indexOf(k) > -1 || x.skillSnapshot.title.toLowerCase().indexOf(k) > -1)
    }
    list.sort((a, b) => new Date(b.createTime) - new Date(a.createTime))
    return paginate(list, d.page, d.size)
  },

  'admin.reports': d => {
    let list = reports.slice()
    if (d.status !== undefined && d.status !== null && d.status !== '') list = list.filter(x => x.status === Number(d.status))
    list.sort((a, b) => new Date(b.createTime) - new Date(a.createTime))
    return paginate(list, d.page, d.size)
  },

  'admin.handleReport': d => {
    const r = reports.find(x => x._id === d.id)
    if (!r) fail(404, '举报不存在')
    const result = Number(d.result)
    // ★ 与云端对齐①：幂等 —— 已处理过的举报再次处理不再重复扣分、不再重复发通知。
    //   必须幂等：每调一次就 addCredit(-10) 一次的话，重复点击会把被举报人扣到 0 分。
    if (r.status === 1 || r.status === 2) {
      if (d.remark) r.handleRemark = d.remark
      return { ok: true }
    }
    r.status = result
    r.handleRemark = d.remark || ''
    r.handlerId = OPENID.me
    r.handleTime = now()
    if (result === 1) {
      addCredit(r.targetUserId, -10, 'report_valid', '举报核实成立', '')
      notices.unshift({
        _id: rid('n'), _openid: r._openid, type: 'report', title: '举报已处理',
        content: `你提交的举报「${r.reason}」已核实成立，我们已对被举报方做出处理。感谢你的监督！`,
        orderId: '', read: false, createTime: now()
      })
    } else {
      // ★ 与云端对齐②：驳回也要通知举报人 ——
      //   驳回也必须发通知：只通知「成立」的话，举报人会永远等不到结果。
      notices.unshift({
        _id: rid('n'), _openid: r._openid, type: 'report', title: '举报已处理',
        content: `你提交的举报「${r.reason}」经核实未予采纳，感谢你的监督。`,
        orderId: '', read: false, createTime: now()
      })
    }
    return { ok: true }
  },

  'admin.banners': () => ({ list: clone(banners.slice().sort((a, b) => a.sort - b.sort)) }),
  'admin.saveBanner': d => {
    if (d._id) {
      const b = banners.find(x => x._id === d._id)
      if (b) Object.assign(b, d)
      return { id: d._id }
    }
    const b = { _id: rid('b'), image: d.image || '', title: d.title || '', link: d.link || '', sort: Number(d.sort) || 99, status: 1 }
    banners.push(b)
    return { id: b._id }
  },
  'admin.deleteBanner': d => {
    const i = banners.findIndex(x => x._id === d._id)
    if (i > -1) banners.splice(i, 1)
    return { ok: true }
  },
  'admin.config': () => clone(config),
  'admin.saveConfig': d => { Object.assign(config, d, { _id: 'global' }); return { ok: true } }
}

/** 内部：退回冻结的时间币 */
function refund(o) {
  const buyer = userMap[o.buyerId]
  if (!buyer) return
  buyer.frozenCoins = Math.max(0, buyer.frozenCoins - o.amount)
  buyer.coins += o.amount
  walletLogs.unshift({
    _id: rid('wl'), _openid: o.buyerId, type: 'unfreeze', amount: o.amount,
    balance: buyer.coins, frozen: buyer.frozenCoins,
    orderId: o._id, orderNo: o.orderNo, remark: '订单取消，时间币退回', createTime: now()
  })
}

/** 内部：信用分变动 */
function addCredit(openid, change, reason, reasonText, orderId) {
  const u = userMap[openid]
  if (!u) return
  u.creditScore = Math.min(150, Math.max(0, u.creditScore + change))
  const { CREDIT_LEVELS } = require('./constants')
  const lv = CREDIT_LEVELS.find(l => u.creditScore >= l.min && u.creditScore <= l.max)
  u.creditLevel = lv ? lv.key : 'normal'
  creditLogs.unshift({
    _id: rid('cl'), _openid: openid, change, score: u.creditScore,
    reason, reasonText, orderId: orderId || '', createTime: now()
  })
}

/**
 * 统一派发入口（由 utils/cloud.js 在 MOCK 模式调用）
 * @param {String} name   云函数名
 * @param {Object} data   { action, ...payload }
 */
async function dispatch(name, data) {
  const key = `${name}.${data.action}`
  const fn = handlers[key]
  if (!fn) {
    throw new MockError(400, `[离线模拟] 未实现的接口 ${key}，请在 utils/mock.js 中补充，或配置真实云环境`)
  }
  // 模拟网络延迟，便于观察 loading 态
  await new Promise(r => setTimeout(r, 120 + Math.floor(Math.random() * 180)))
  return fn(data || {})
}

module.exports = { dispatch, MockError, store: { users, skills, orders, reviews, chats, messages, notices, categories, reports, banners, config, walletLogs, creditLogs } }
