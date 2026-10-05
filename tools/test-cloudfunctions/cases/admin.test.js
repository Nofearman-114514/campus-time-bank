/**
 * 案例组 21-34：admin 全部 20 个 action
 * ==================================================================
 * 契约来源：
 *   docs/ARCHITECTURE.md §4.7（action 表）/ §4.8（看板返回结构）
 *   §3.1 users / §3.2 categories / §3.3 skills / §3.4 orders
 *   §3.6 wallet_logs / §3.7 credit_logs / §3.10 notices / §3.11 reports
 *   §9.5（离线层 mock.js 与云函数「行为等价」要求）
 *
 * 覆盖重点：
 *   1) 权限：除 check 外 **19 个 action** 一律「非管理员 → 403」（循环断言，逐条可按 action 定位）
 *   2) stats 的看板口径与交叉一致性（overview ↔ 各分布合计 ↔ 列表 total）
 *   3) auditUser 幂等（同结论重复审核不重复发通知）
 *   4) adjustCoins 必写 wallet_logs（type='admin'）、负数不得穿透余额
 *   5) handleReport 幂等（同一举报重复处理不重复扣分）
 *   6) deleteCategory 有技能引用 → 409；saveConfig 白名单 + 数值兜底
 *
 * ★ 组 34 是「契约偏差」组：那里的断言按契约写，**当前实现不满足 → 故意为红**，
 *   每条消息以 【缺陷】 开头，报告里可直接定位到具体是哪个 action 的哪个口径。
 *   红 ≠ 用例写错，红 = 实现缺陷（Lead 确认这 3 条为真缺陷，将在用例交付后统一修，
 *   届时本组应当全绿 —— 「修前红 / 修后绿」就是最硬的验证证据）。
 */
module.exports = async function (t) {
  const ADMIN = 'o_adm'
  const D = t.D

  /* ==================================================================
   * 夹具
   * ================================================================== */
  const BASE_STATS = () => ({
    publishCount: 0, serveCount: 0, buyCount: 0,
    reviewCount: 0, ratingSum: 0, avgRating: 0, ontimeStreak: 0
  })
  const mkUser = (id, openid, over) => Object.assign({
    _id: id, _openid: openid, nickName: '用户' + id, avatarUrl: '',
    authStatus: 2, coins: 0, frozenCoins: 0, totalEarned: 0, totalSpent: 0,
    creditScore: 100, creditLevel: 'good', badges: [], role: 'user', status: 1,
    stats: BASE_STATS(), createTime: D(200)
  }, over)
  const snap = (title, cat, price) => ({
    title, price, duration: 60, categoryName: cat, images: [], type: 'offer'
  })
  const mkOrder = (over) => Object.assign({
    _id: 'o0', orderNo: 'TB20261000', skillId: 'sk1',
    skillSnapshot: snap('吉他入门', '技能教学', 3),
    buyerId: 'o_buy', buyerInfo: { nickName: '买家小明', avatarUrl: '', creditScore: 100 },
    sellerId: 'o_sel', sellerInfo: { nickName: '卖家思远', avatarUrl: '', creditScore: 110 },
    amount: 2, status: 'waiting', remark: '', timeline: [],
    isRatedBuyer: false, isRatedSeller: false, buyerScore: 0, sellerScore: 0,
    createTime: new Date(),
    acceptTime: null, finishTime: null, confirmTime: null, cancelTime: null, expireTime: null
  }, over)

  /**
   * 标准管理端夹具。人数 / 订单状态 / 信用分档 / 金额都刻意做成可手算：
   *   users 7：userTotal=7, userToday=1, userYest=0 → userGrowthRate=100
   *     creditDist 0-59:1(55) 60-79:0 80-99:0 100-119:5 120-150:1
   *     coinCirculation=25  coinFrozen=3  coinEarned=82  authPending=1
   *     avgRating = (9+9)/(2+2) = 4.5
   *   orders 9：today 7（其中昨日 1、3 天前 1）
   *     status: finished3 ongoing1 waiting2 confirming1 canceled1 closed1
   *     finishRate = 3/9 = 33.3    orderGrowthRate = (7-1)/1 = 600
   *     trend[6]={users1,orders7,coins19} trend[5]={orders1,coins3} trend[3]={orders1,coins2}
   */
  function seedAdmin (opts) {
    const o = opts || {}
    const s = t.seed({ subscribe: o.subscribe || { ORDER_CREATE: 'TPL_C', ORDER_FINISH: 'TPL_F' } })

    s.users = [
      mkUser('u_buy', 'o_buy', { nickName: '买家小明', studentNo: '2021001', coins: 10, totalEarned: 12, stats: Object.assign(BASE_STATS(), { serveCount: 3 }) }),
      mkUser('u_sel', 'o_sel', { nickName: '卖家思远', studentNo: '2021002', frozenCoins: 3, creditScore: 110, totalEarned: 30, stats: Object.assign(BASE_STATS(), { serveCount: 5, reviewCount: 2, ratingSum: 9, avgRating: 4.5 }) }),
      mkUser('u_weak', 'o_weak', { nickName: '路人同学', coins: 10 }),
      mkUser('u_adm', 'o_adm', { nickName: '管理员A', role: 'admin' }),
      mkUser('u_adm2', 'o_adm2', { nickName: '管理员B', role: 'admin' }),
      mkUser('u_new', 'o_new', { nickName: '新同学', coins: 5, totalEarned: 40, creditScore: 130, creditLevel: 'excellent', createTime: new Date(), stats: Object.assign(BASE_STATS(), { serveCount: 9, reviewCount: 2, ratingSum: 9, avgRating: 4.5 }) }),
      mkUser('u_pend', 'o_pend', { nickName: '待审核同学', authStatus: 1, creditScore: 55, creditLevel: 'limited', createTime: D(72) })
    ]

    s.categories = [
      { _id: 'c1', name: '学业辅导', icon: '📚', sort: 1, status: 1, createTime: D(300) },
      { _id: 'c2', name: '技能教学', icon: '🎸', sort: 2, status: 1, createTime: D(300) },
      { _id: 'c3', name: '生活服务', icon: '📦', sort: 3, status: 0, createTime: D(300) }
    ]

    s.skills = [
      { _id: 'sk1', _openid: 'o_sel', authorId: 'o_sel', authorInfo: { nickName: '卖家思远' }, type: 'offer', title: '吉他入门一对一', categoryId: 'c2', categoryName: '技能教学', price: 3, duration: 60, images: [], status: 1, orderCount: 0, createTime: D(50) },
      { _id: 'sk2', _openid: 'o_buy', authorId: 'o_buy', authorInfo: { nickName: '买家小明' }, type: 'offer', title: '数学辅导', categoryId: 'c1', categoryName: '学业辅导', price: 1, duration: 60, images: [], status: 4, orderCount: 0, createTime: D(10) },
      { _id: 'sk3', _openid: 'o_sel', authorId: 'o_sel', authorInfo: { nickName: '卖家思远' }, type: 'offer', title: '吉他调音', categoryId: 'c2', categoryName: '技能教学', price: 2, duration: 30, images: [], status: 3, auditRemark: '含违规联系方式', isTop: true, orderCount: 0, createTime: D(30) }
    ]

    s.orders = [
      mkOrder({ _id: 'o1', orderNo: 'TB20261001', status: 'finished', amount: 3 }),
      mkOrder({ _id: 'o2', orderNo: 'TB20261002', status: 'finished', amount: 2 }),
      mkOrder({ _id: 'o3', orderNo: 'TB20261003', status: 'ongoing', amount: 4 }),
      mkOrder({ _id: 'o4', orderNo: 'TB20261004', status: 'waiting', amount: 1, skillSnapshot: snap('数学辅导', '学业辅导', 1) }),
      mkOrder({ _id: 'o5', orderNo: 'TB20261005', status: 'confirming', amount: 5, skillSnapshot: snap('数学辅导', '学业辅导', 5) }),
      mkOrder({ _id: 'o6', orderNo: 'TB20261006', status: 'canceled', amount: 2, skillSnapshot: snap('快递代取', '生活服务', 2) }),
      mkOrder({ _id: 'o7', orderNo: 'TB20261007', status: 'closed', amount: 2, skillSnapshot: snap('快递代取', '生活服务', 2) }),
      mkOrder({ _id: 'o8', orderNo: 'TB20261008', status: 'finished', amount: 3, createTime: D(24) }),
      mkOrder({ _id: 'o9', orderNo: 'TB20261009', status: 'waiting', amount: 2, createTime: D(72), skillSnapshot: snap('数学辅导', '学业辅导', 2) })
    ]

    s.reports = [
      { _id: 'rp1', _openid: 'o_buy', targetType: 'user', targetId: 'o_sel', targetUserId: 'o_sel', reason: '虚假信息', remark: '', images: [], status: 0, createTime: D(5) },
      { _id: 'rp2', _openid: 'o_weak', targetType: 'skill', targetId: 'sk1', targetUserId: 'o_sel', reason: '态度恶劣', remark: '', images: [], status: 0, createTime: D(4) },
      { _id: 'rp3', _openid: 'o_buy', targetType: 'order', targetId: 'o1', targetUserId: 'o_sel', reason: '爽约', remark: '', images: [], status: 1, handleRemark: '已警告', handlerId: 'o_adm', handleTime: D(2), createTime: D(50) }
    ]

    s.banners = [
      { _id: 'b1', image: 'cloud://a.png', title: '首单有礼', link: '/pages/index/index', sort: 1, status: 1, createTime: D(100) },
      { _id: 'b2', image: 'cloud://b.png', title: '期末互助', link: '', sort: 2, status: 0, createTime: D(100) }
    ]

    s.credit_logs = []
    s.notices = []
    return s
  }

  /** 提交一组举报（组 31 专用，逐条对应一个独立被举报人/结论） */
  function seedReports () {
    const s = seedAdmin()
    s.users.forEach(u => {
      if (u._openid === 'o_weak') u.creditScore = 85
      if (u._openid === 'o_buy') u.creditScore = 5
      if (u._openid === 'o_sel') u.creditScore = 110
    })
    s.reports = [
      { _id: 'rp1', _openid: 'o_buy', targetType: 'user', targetId: 'o_sel', targetUserId: 'o_sel', reason: '虚假信息', remark: '', images: [], status: 0, createTime: D(5) },
      { _id: 'rp2', _openid: 'o_weak', targetType: 'user', targetId: 'o_sel', targetUserId: 'o_weak', reason: '态度恶劣', remark: '', images: [], status: 0, createTime: D(4) },
      { _id: 'rp3', _openid: 'o_buy', targetType: 'order', targetId: 'o1', targetUserId: 'o_sel', reason: '爽约', remark: '', images: [], status: 1, handleRemark: '已警告', handlerId: 'o_adm', handleTime: D(2), createTime: D(50) },
      { _id: 'rp4', _openid: 'o_weak', targetType: 'user', targetId: 'o_buy', targetUserId: 'o_buy', reason: '恶意刷单', remark: '', images: [], status: 0, createTime: D(3) },
      { _id: 'rp5', _openid: 'o_weak', targetType: 'skill', targetId: 'sk1', targetUserId: '', reason: '内容不实', remark: '', images: [], status: 0, createTime: D(2) },
      { _id: 'rp6', _openid: 'o_weak', targetType: 'user', targetId: 'o_sel', targetUserId: 'o_sel', reason: '重复举报', remark: '', images: [], status: 0, createTime: D(1) },
      { _id: 'rp7', _openid: 'o_weak', targetType: 'user', targetId: 'o_ghost', targetUserId: 'o_ghost', reason: '已注销用户', remark: '', images: [], status: 0, createTime: D(1) }
    ]
    return s
  }

  const A = (action, payload) => t.call('admin', ADMIN, action, payload)

  /* ==================================================================
   * 组 21 · admin.check —— 唯一不需要管理员身份的 action
   * ================================================================== */
  t.group('组 21 · admin.check：唯一不抛 403 的 action（未登录也给 code 0）')

  seedAdmin()
  let r = await A('check', {})
  t.eq(r.code, 0, 'check：管理员调用 code 0')
  t.eq(r.data.isAdmin, true, 'check：管理员 isAdmin=true')
  t.eq(r.data.isDebugger, false, '★ 普通管理员 isDebugger=false（碰不到调试功能）')
  t.eq(r.data.role, 'admin', 'check：回传当前角色')
  t.eq(Object.keys(r.data).sort().join(','), 'isAdmin,isDebugger,role', 'check 返回 { isAdmin, isDebugger, role }')

  /* ★ 调试员（校方）：管理后台进得去，调试功能也碰得到 ——
     权限是包含关系 debugger ⊃ admin */
  seedAdmin()
  t.user(ADMIN).role = 'debugger'
  r = await A('check', {})
  t.eq(r.data.isAdmin, true, '★ 调试员 isAdmin=true（能接触所有数据 → 后台也进得去）')
  t.eq(r.data.isDebugger, true, '★ 调试员 isDebugger=true（能接触调试功能）')
  t.eq(r.data.role, 'debugger', 'check：回传 debugger')

  r = await t.call('admin', 'o_buy', 'check', {})
  t.eq(r.code, 0, 'check：普通用户不返回 403（前端靠 isAdmin 渲染入口）')
  t.eq(r.data.isAdmin, false, 'check：普通用户 isAdmin=false')
  t.eq(r.data.isDebugger, false, 'check：普通用户 isDebugger=false')
  t.eq(r.data.role, 'user', 'check：普通用户 role=user')

  r = await t.call('admin', '', 'check', {})
  t.eq(r.code, 0, 'check：未登录也 code 0（不抛异常）')
  t.eq(r.data.isAdmin, false, 'check：未登录 isAdmin=false')
  t.eq(r.data.role, 'user', 'check：未登录 role 兜底为 user')

  r = await t.call('admin', 'o_ghost', 'check', {})
  t.eq(r.data.isAdmin, false, 'check：openid 未注册 isAdmin=false')

  t.user('o_buy').status = 0
  r = await t.call('admin', 'o_buy', 'check', {})
  t.eq(r.data.isAdmin, false, 'check：被封禁用户 isAdmin=false（check 不查 status）')

  /* ==================================================================
   * 组 22 · 权限矩阵：19 个 action × 非管理员 → 403
   * ================================================================== */
  t.group('组 22 · 权限矩阵：除 check 外 19 个 action 非管理员一律 403')

  const ADMIN_ACTIONS = [
    'stats', 'users', 'auditUser', 'setUserStatus', 'setUserRole', 'adjustCoins',
    'categories', 'saveCategory', 'deleteCategory', 'skills', 'auditSkill',
    'orders', 'reports', 'handleReport', 'banners', 'saveBanner', 'deleteBanner',
    'config', 'saveConfig'
  ]

  seedAdmin()
  for (const action of ADMIN_ACTIONS) {
    const res = await t.call('admin', 'o_buy', action, {})
    t.eq(res.code, 403, `★ admin.${action}：非管理员调用 → 403`)
  }

  seedAdmin()
  r = await t.call('admin', 'o_buy', 'stats', {})
  t.eq(r.msg, '无管理员权限', '403 的 msg 是面向用户的中文文案')

  r = await t.call('admin', 'o_ghost', 'stats', {})
  t.eq(r.code, 401, '未注册调用者：requireUser 先于角色判断 → 401（不是 403）')

  const banned = seedAdmin()
  banned.users.find(u => u._openid === 'o_buy').status = 0
  r = await t.call('admin', 'o_buy', 'stats', {})
  t.eq(r.code, 403, '被封禁的非管理员 → 403')
  t.eq(r.msg, '账号已被封禁，如有疑问请联系管理员', '封禁用户的 403 文案与「无权限」区分开')

  /* ==================================================================
   * 组 23 · admin.stats：看板口径与交叉一致性
   * ================================================================== */
  t.group('组 23 · admin.stats：overview / trend / 三种分布的口径与交叉一致性')

  let s = seedAdmin()
  let res = await A('stats', {})
  t.eq(res.code, 0, 'admin.stats 调用成功')
  const ov = res.data.overview
  const st = res.data

  /* ---- overview 逐项 ---- */
  t.eq(Object.keys(ov).sort().join(','),
    'authPending,avgRating,coinCirculation,coinEarned,coinFrozen,finishRate,orderGrowthRate,orderToday,orderTotal,reportPending,userGrowthRate,userToday,userTotal',
    'overview 恰好是 §4.8 的 13 个字段')
  t.eq(ov.userTotal, 7, 'userTotal = 7（users 全量计数）')
  t.eq(ov.userToday, 1, 'userToday = 1（今天新增 u_new）')
  t.eq(ov.userGrowthRate, 100, 'userGrowthRate：昨日 0、今日 1 → 100（不返回 Infinity）')
  t.eq(ov.orderTotal, 9, 'orderTotal = 9（orders 全量计数）')
  t.eq(ov.orderToday, 7, 'orderToday = 7')
  t.eq(ov.orderGrowthRate, 600, 'orderGrowthRate = (7-1)/1*100 = 600')
  t.eq(ov.finishRate, 33.3, 'finishRate = 3/9 → 33.3（1 位小数）')
  t.eq(ov.avgRating, 4.5, 'avgRating = ΣratingSum/ΣreviewCount = 18/4 = 4.5')
  t.eq(ov.authPending, 1, 'authPending = authStatus===1 的数量（u_pend）')
  t.eq(ov.reportPending, 2, 'reportPending = reports.status===0 的数量')
  t.eq(ov.coinCirculation, 25, 'coinCirculation = Σ coins = 10+0+10+0+0+5+0')
  t.eq(ov.coinFrozen, 3, 'coinFrozen = Σ frozenCoins = 3')
  t.eq(ov.coinEarned, 82, 'coinEarned = Σ totalEarned = 12+30+40')

  /* ★ 聚合口径 vs 内存直算：同一份数据不能两个口径 */
  const sumOf = (key) => s.users.reduce((n, u) => n + (Number(u[key]) || 0), 0)
  t.eq(ov.coinCirculation, sumOf('coins'), '★ coinCirculation 与内存直算 Σcoins 一致（聚合 vs 全量）')
  t.eq(ov.coinFrozen, sumOf('frozenCoins'), '★ coinFrozen 与内存直算 ΣfrozenCoins 一致')
  t.eq(ov.coinEarned, sumOf('totalEarned'), '★ coinEarned 与内存直算 ΣtotalEarned 一致')
  t.eq(ov.authPending, s.users.filter(u => u.authStatus === 1).length, 'authPending 与内存直算一致')
  t.eq(ov.reportPending, s.reports.filter(x => x.status === 0).length, 'reportPending 与内存直算一致')

  /* ---- ★ 跨 action 口径：overview.userTotal 必须等于 admin.users.total ---- */
  const usersRes = await A('users', {})
  t.eq(ov.userTotal, usersRes.data.total, '★ overview.userTotal === admin.users.total（同一份数据不能两个口径）')

  /* ---- trend ---- */
  t.eq(st.trend.length, 7, 'trend 默认 7 个点')
  t.eq(Object.keys(st.trend[0]).sort().join(','), 'coins,date,orders,users', 'trend 每项恰好 date/users/orders/coins')
  const todayLabel = `${new Date().getMonth() + 1}/${new Date().getDate()}`
  t.eq(st.trend[6].date, todayLabel, "trend 末项是今天，date 形如 '10/3'（M/D 不补零）")
  t.ok(/^\d{1,2}\/\d{1,2}$/.test(st.trend[0].date), 'trend[].date 全部匹配 ^\\d{1,2}/\\d{1,2}$', st.trend[0].date)
  t.eq(st.trend.filter(d => /\/0\d$/.test(d.date)).length, 0, "date 的日不补零（不出现 '10/03'）")
  t.eq(st.trend[6].users, 1, 'trend 今天新增用户 1（u_new）')
  t.eq(st.trend[6].orders, 7, 'trend 今天订单 7')
  t.eq(st.trend[6].coins, 19, 'trend 今天 coins = 当日订单 amount 合计 = 3+2+4+1+5+2+2')
  t.eq(st.trend[5].orders, 1, 'trend 昨天订单 1')
  t.eq(st.trend[5].coins, 3, 'trend 昨天 coins 3')
  t.eq(st.trend[5].users, 0, 'trend 昨天新增用户 0（无数据补 0，不是缺项）')
  t.eq(st.trend[3].orders, 1, 'trend 3 天前订单 1（按天归集的桶位正确）')
  t.eq(st.trend[3].coins, 2, 'trend 3 天前 coins 2')
  t.eq(st.trend.reduce((n, d) => n + d.orders, 0), 9, '★ trend 7 天订单合计 = orderTotal 9（全部订单都在窗口内）')
  t.eq(st.trend.reduce((n, d) => n + d.coins, 0), 24, 'trend 7 天 coins 合计 = 19+3+2')
  t.eq(st.trend.reduce((n, d) => n + d.users, 0), 2, 'trend 7 天新增用户合计 = 2（今天 1 + 3 天前 1；200 天前的老用户不计入）')
  t.eq(st.trend[3].users, 1, 'trend 3 天前的桶里有 u_pend（新增用户按天归集正确）')

  const t14 = await A('stats', { range: 14 })
  t.eq(t14.data.trend.length, 14, 'range=14 → trend 14 个点')
  const t30 = await A('stats', { range: 30 })
  t.eq(t30.data.trend.length, 30, 'range=30 → trend 30 个点')
  t.eq((await A('stats', { range: '14' })).data.trend.length, 14, "range 传字符串 '14' 也生效（Number 转换）")
  t.eq((await A('stats', { range: 0 })).data.trend.length, 7, 'range=0 非法 → 回落 7')
  t.eq((await A('stats', { range: 99 })).data.trend.length, 7, 'range=99 非法 → 回落 7')
  t.eq((await A('stats', {})).data.trend.length, 7, 'range 缺省 → 7')

  /* ---- hotSkills / categoryDist ---- */
  t.eq(st.hotSkills.length, 3, 'hotSkills 3 项（按订单数分组）')
  t.eq(st.hotSkills[0].name, '吉他入门', 'hotSkills 按 value 降序，第一项吉他入门')
  t.eq(st.hotSkills[0].value, 4, 'hotSkills 吉他入门 = 4 单')
  t.eq(st.hotSkills[1].value, 3, 'hotSkills 第二项 数学辅导 = 3')
  t.eq(st.categoryDist.length, 3, 'categoryDist 3 项')
  t.eq(st.categoryDist[0].name, '技能教学', 'categoryDist 降序，第一项技能教学')
  t.eq(st.categoryDist[0].value, 4, 'categoryDist 技能教学 = 4')
  t.eq(st.categoryDist.reduce((n, c) => n + c.value, 0), 9, '★ categoryDist 合计 = orderTotal 9（每条订单都有分类）')

  /* ---- orderStatusDist：口径（六状态固定项在组 34 单独判） ---- */
  const VALID_STATUS_NAMES = ['已完成', '服务中', '待接单', '待确认', '已取消', '已关闭']
  const od = st.orderStatusDist
  t.ok(od.every(x => VALID_STATUS_NAMES.indexOf(x.name) > -1), 'orderStatusDist 的 name 只用合法中文状态名', JSON.stringify(od))
  t.ok(od.every(x => typeof x.value === 'number' && x.value >= 0), 'orderStatusDist 每项 value 是非负数字')
  t.eq(od.reduce((n, x) => n + x.value, 0), ov.orderTotal, '★ orderStatusDist 合计 === overview.orderTotal')
  const odVal = (name) => (od.filter(x => x.name === name)[0] || {}).value
  t.eq(odVal('已完成'), 3, 'orderStatusDist 已完成 = 3')
  t.eq(odVal('服务中'), 1, 'orderStatusDist 服务中 = 1')
  t.eq(odVal('待接单'), 2, 'orderStatusDist 待接单 = 2')
  t.eq(odVal('待确认'), 1, 'orderStatusDist 待确认 = 1')
  t.eq(odVal('已完成'), Math.round(ov.finishRate / 100 * ov.orderTotal), '★ 已完成数与 finishRate 自洽（3 = 33.3% × 9）')

  /* ---- creditDist ---- */
  const cd = st.creditDist
  t.eq(cd.length, 5, 'creditDist 固定 5 档')
  t.eq(cd.map(x => x.name).join(','), '0-59,60-79,80-99,100-119,120-150', 'creditDist 档位名与 constants.CREDIT_LEVELS 边界一致')
  t.eq(cd.map(x => x.value).join(','), '1,0,0,5,1', 'creditDist 每档人数（1/0/0/5/1）')
  t.eq(cd.reduce((n, x) => n + x.value, 0), ov.userTotal, '★ creditDist 合计 === overview.userTotal（每个用户恰好落一档）')
  t.eq(cd.filter(x => x.value === 0).length, 2, 'creditDist 空档保留（值为 0 也输出，图例不抖）')

  /* ---- topUsers ---- */
  t.eq(st.topUsers.length, 5, 'topUsers TOP5')
  t.eq(st.topUsers[0].openid, 'o_new', 'topUsers 按 stats.serveCount 降序，第一是 o_new(9)')
  t.eq(st.topUsers[0].serveCount, 9, 'topUsers[0].serveCount = 9')
  t.eq(st.topUsers[1].openid, 'o_sel', 'topUsers[1] 是 o_sel(5)')
  t.eq(st.topUsers[0].creditScore, 130, 'topUsers 带 creditScore')
  t.eq(st.topUsers[0].avgRating, 4.5, 'topUsers 带 avgRating')
  t.eq(st.topUsers[0].nickName, '新同学', 'topUsers 带 nickName')

  /* ---- 零业务数据边界：只有管理员一个用户，其余集合为空 ----
   *   （不能真的把 users 清空：stats 自身要先过 requireAdmin，
   *     而管理员必须是一个用户文档；这也是「空集合上 $group 返回空数组」的实测点） */
  s = seedAdmin()
  const admOnly = s.users.filter(x => x._openid === 'o_adm')[0]
  s.users = [admOnly]
  s.orders = []
  s.reports = []
  res = await A('stats', {})
  t.eq(res.code, 0, '零业务数据调用 stats 不崩（空 orders/reports 上 $group 返回空数组）')
  t.eq(res.data.overview.userTotal, 1, '只有管理员 → userTotal = 1')
  t.eq(res.data.overview.orderTotal, 0, '零业务数据 orderTotal = 0')
  t.eq(res.data.overview.finishRate, 0, '零业务数据 finishRate = 0（不出现 NaN）')
  t.eq(res.data.overview.avgRating, 0, '零业务数据 avgRating = 0（不出现 NaN）')
  t.eq(res.data.overview.coinCirculation, 0, '零业务数据 coinCirculation = 0（管理员 coins=0）')
  t.eq(res.data.overview.reportPending, 0, '零业务数据 reportPending = 0')
  t.eq(res.data.trend.length, 7, '零业务数据 trend 仍补满 7 个 0 点')
  t.eq(res.data.trend.reduce((n, d) => n + d.orders, 0), 0, '零业务数据 trend 订单合计 0')
  t.eq(res.data.trend.reduce((n, d) => n + d.users, 0), 0, '零业务数据 trend 新增用户 0')
  t.eq(res.data.creditDist.reduce((n, x) => n + x.value, 0), 1, '★ creditDist 合计 === userTotal 1')
  t.eq(res.data.orderStatusDist.reduce((n, x) => n + x.value, 0), 0, '★ orderStatusDist 合计 === orderTotal 0')
  t.ok(res.data.orderStatusDist.every(x => x.value === 0), '空订单集合 → orderStatusDist 全为 0（骨架补零）')
  t.eq(res.data.hotSkills.length, 0, '空订单集合 → hotSkills 空数组')
  t.eq(res.data.categoryDist.length, 0, '空订单集合 → categoryDist 空数组')
  t.eq(res.data.topUsers.length, 1, 'topUsers 只有管理员 1 人')

  /* ==================================================================
   * 组 24 · admin.users：筛选 / 关键字转义 / 分页
   * ================================================================== */
  t.group('组 24 · admin.users：关键字转义、状态筛选、分页与排序')

  seedAdmin()
  let u = await A('users', {})
  t.eq(u.code, 0, 'admin.users 调用成功')
  t.eq(u.data.total, 7, '无筛选 total = 7')
  t.eq(u.data.list.length, 7, '无筛选 list = 7（默认 size 10）')
  t.eq(u.data.hasMore, false, '7 条 < size 10 → hasMore=false')
  t.eq(u.data.list[0]._id, 'u_new', '按 createTime desc，第一位是今天注册的 u_new')
  t.eq(u.data.list[1]._id, 'u_pend', '第二位是 3 天前的 u_pend')
  t.ok(u.data.list[0].createTime instanceof Date, 'list 返回原始文档（createTime 是 Date）')

  t.eq((await A('users', { authStatus: 2 })).data.total, 6, 'authStatus=2 → 6 人')
  t.eq((await A('users', { authStatus: 1 })).data.total, 1, 'authStatus=1 → 1 人（u_pend）')
  t.eq((await A('users', { authStatus: 0 })).data.total, 0, 'authStatus=0 → 0 人（注意 0 必须生效，不能被当空值吞掉）')
  t.eq((await A('users', { authStatus: '' })).data.total, 7, 'authStatus=空串 → 视为不筛选')
  t.eq((await A('users', { status: 1 })).data.total, 7, 'status=1 → 7 人')
  t.eq((await A('users', { status: 0 })).data.total, 0, 'status=0 → 0 人（0 必须生效）')
  t.eq((await A('users', { keyword: '卖家' })).data.total, 1, 'keyword 匹配 nickName')
  t.eq((await A('users', { keyword: '2021001' })).data.total, 1, 'keyword 匹配 studentNo')
  t.eq((await A('users', { keyword: '2021' })).data.total, 2, 'keyword 同时命中两个学号')
  t.eq((await A('users', { keyword: '管理' })).data.total, 2, 'keyword 命中两个管理员昵称')
  t.eq((await A('users', { keyword: '.' })).data.total, 0, '★ keyword=. 不匹配任何人（正则元字符被转义，无注入）')
  t.eq((await A('users', { keyword: '(' })).data.total, 0, '★ keyword=( 不会抛正则语法错（escapeReg 生效）')
  t.eq((await A('users', { keyword: '.*' })).data.total, 0, '★ keyword=.* 不变成通配（转义生效）')
  t.eq((await A('users', { authStatus: 1, keyword: '待审核' })).data.total, 1, '组合条件：authStatus=1 且 keyword 命中 → 1')
  t.eq((await A('users', { authStatus: 2, keyword: '待审核' })).data.total, 0, '组合条件：authStatus=2 且 keyword 命中待审核 → 0')

  const p1 = await A('users', { page: 1, size: 3 })
  t.eq(p1.data.list.length, 3, 'size=3 第一页 3 条')
  t.eq(p1.data.total, 7, '分页时 total 是筛选后总数（不是当页数）')
  t.eq(p1.data.hasMore, true, '第一页 hasMore=true')
  t.eq((await A('users', { page: 2, size: 3 })).data.list.length, 3, '第二页 3 条')
  const p3 = await A('users', { page: 3, size: 3 })
  t.eq(p3.data.list.length, 1, '第三页 1 条')
  t.eq(p3.data.hasMore, false, '最后一页 hasMore=false')
  const p2 = await A('users', { page: 2, size: 3 })
  const allIds = [].concat(p1.data.list, p2.data.list, p3.data.list).map(x => x._id)
  t.eq(allIds.length, 7, '三页合计 7 条记录')
  t.eq(new Set(allIds).size, 7, '翻页不重不漏：三页恰好覆盖 7 个唯一用户')

  /* ==================================================================
   * 组 25 · admin.auditUser：状态迁移 + 通知 + 幂等
   * ================================================================== */
  t.group('组 25 · admin.auditUser：认证状态迁移、通知副作用、同结论幂等')

  seedAdmin()
  r = await A('auditUser', { userId: 'o_pend', pass: true })
  t.eq(r.code, 0, 'auditUser pass=true 成功')
  t.eq(r.data.ok, true, '返回 { ok: true }')
  t.eq(t.user('o_pend').authStatus, 2, '★ 通过 → authStatus=2')
  t.eq(t.user('o_pend').authRemark, '', '通过时清空 authRemark')
  t.ok(t.user('o_pend').authTime instanceof Date, '写入 authTime')
  t.eq(t.notices('o_pend').length, 1, '★ 通过 → 写 1 条 notices')
  t.eq(t.notices('o_pend')[0].type, 'audit', '通知 type=audit')
  t.eq(t.notices('o_pend')[0].title, '校园认证已通过', '通知标题')
  t.eq(t.notices('o_pend')[0].read, false, '通知未读')
  t.eq(t.logs('o_pend').length, 0, '审核不写 wallet_logs（副作用干净）')

  r = await A('auditUser', { userId: 'o_pend', pass: true })
  t.eq(r.code, 0, '重复 pass=true 仍返回成功')
  t.eq(t.notices('o_pend').length, 1, '★ 幂等：同结论重复审核不再发通知')
  t.eq(t.user('o_pend').authStatus, 2, '幂等：状态不变')

  const authTime1 = t.user('o_pend').authTime
  await A('auditUser', { userId: 'o_pend', pass: true })
  t.eq(t.user('o_pend').authTime, authTime1, '★ 幂等：重复审核连 authTime 都不再改写')

  r = await A('auditUser', { userId: 'o_pend', pass: false, remark: '学生证照片模糊' })
  t.eq(t.user('o_pend').authStatus, 3, '驳回 → authStatus=3')
  t.eq(t.user('o_pend').authRemark, '学生证照片模糊', '驳回写入 authRemark')
  t.eq(t.notices('o_pend').length, 2, '驳回写第 2 条通知')
  t.eq(t.notices('o_pend')[1].title, '校园认证未通过', '驳回通知标题')
  t.ok(t.notices('o_pend')[1].content.indexOf('学生证照片模糊') > -1, '驳回通知正文带上驳回原因')

  await A('auditUser', { userId: 'o_pend', pass: false, remark: '换个原因' })
  t.eq(t.notices('o_pend').length, 2, '★ 幂等：同结论重复驳回不重复发通知')
  t.eq(t.user('o_pend').authRemark, '学生证照片模糊', '幂等：连 authRemark 也不覆盖（提前 return）')

  await A('auditUser', { userId: 'o_pend', pass: true })
  t.eq(t.notices('o_pend').length, 3, '结论变化（3→2）→ 正常发新通知')
  t.eq(t.user('o_pend').authStatus, 2, '结论变化后状态更新为 2')
  t.eq(t.user('o_pend').authRemark, '', '结论变化通过后清空驳回原因')

  await A('auditUser', { userId: 'u_weak', pass: true })
  t.eq(t.user('o_weak').authStatus, 2, 'userId 传 _id（u_weak）也能定位（findUser 兼容两种标识）')

  r = await A('auditUser', { userId: 'o_ghost', pass: true })
  t.eq(r.code, 404, '不存在的用户 → 404')
  r = await A('auditUser', {})
  t.eq(r.code, 400, '缺少 userId → 400')
  t.eq(r.msg, '缺少用户标识', '缺参 msg 是中文')

  seedAdmin()
  await A('auditUser', { userId: 'o_pend', pass: 1 })
  t.eq(t.user('o_pend').authStatus, 2, 'pass=1（真值）也视为通过')

  seedAdmin()
  await A('auditUser', { userId: 'o_pend', pass: false, remark: '原'.repeat(300) })
  t.eq(t.user('o_pend').authRemark.length, 200, 'remark 超长截断到 200 字')

  /* ==================================================================
   * 组 26 · setUserStatus / setUserRole
   * ================================================================== */
  t.group('组 26 · admin.setUserStatus / setUserRole：封禁边界与提权')

  seedAdmin()
  r = await A('setUserStatus', { userId: 'o_buy', status: 0 })
  t.eq(r.code, 0, '封禁成功')
  t.eq(t.user('o_buy').status, 0, '★ status=0 落库')
  t.eq(t.notices('o_buy').length, 1, '封禁写 1 条通知')
  t.eq(t.notices('o_buy')[0].title, '账号已被封禁', '封禁通知标题')
  t.eq(t.notices('o_buy')[0].type, 'system', '封禁通知 type=system')

  r = await t.call('admin', 'o_buy', 'users', {})
  t.eq(r.code, 403, '被封禁用户调管理端 → 403（requireUser 拦在角色判断之前）')

  await A('setUserStatus', { userId: 'o_buy', status: 0 })
  t.eq(t.notices('o_buy').length, 2, '重复封禁会再发一条通知（显式操作，非幂等；与 auditUser 的幂等约定不同）')

  await A('setUserStatus', { userId: 'o_buy', status: 1 })
  t.eq(t.user('o_buy').status, 1, '解封 status=1')
  t.eq(t.notices('o_buy').length, 2, '解封不写通知')

  await A('setUserStatus', { userId: 'o_buy', status: 7 })
  t.eq(t.user('o_buy').status, 1, 'status 非 0 一律归一为 1（解封）')
  await A('setUserStatus', { userId: 'o_buy', status: '0' })
  t.eq(t.user('o_buy').status, 0, "status='0' 字符串也归一为封禁")

  seedAdmin()
  r = await A('setUserStatus', { userId: 'o_adm', status: 0 })
  t.eq(r.code, 409, '不能封禁自己 → 409')
  t.eq(r.msg, '不能封禁自己', '封禁自己 msg')
  t.eq(t.user('o_adm').status, 1, '拒绝封禁自己后管理员仍是启用状态')
  r = await A('setUserStatus', { userId: 'o_adm2', status: 0 })
  t.eq(r.code, 409, '不能封禁其他管理员 → 409')
  t.eq(r.msg, '不能封禁管理员账号', '封禁管理员 msg')
  r = await A('setUserStatus', { userId: 'o_ghost', status: 0 })
  t.eq(r.code, 404, '用户不存在 → 404')
  r = await A('setUserStatus', { status: 0 })
  t.eq(r.code, 400, '缺少 userId → 400')

  seedAdmin()
  r = await A('setUserRole', { userId: 'o_buy', role: 'admin' })
  t.eq(r.code, 0, '提权成功')
  t.eq(t.user('o_buy').role, 'admin', "role='admin' 落库")
  t.eq((await t.call('admin', 'o_buy', 'users', {})).code, 0, '★ 提权后该用户立刻能调管理端（权限实时生效）')
  t.eq((await t.call('admin', 'o_buy', 'check', {})).data.isAdmin, true, '提权后 check.isAdmin=true')

  await A('setUserRole', { userId: 'o_adm2', role: 'user' })
  t.eq(t.user('o_adm2').role, 'user', '降权其他管理员成功')
  r = await A('setUserRole', { userId: 'o_adm', role: 'user' })
  t.eq(r.code, 409, '不能取消自己的管理员身份 → 409')
  t.eq(t.user('o_adm').role, 'admin', '拒绝后角色不变')
  await A('setUserRole', { userId: 'o_buy', role: 'superadmin' })
  t.eq(t.user('o_buy').role, 'user', "非法 role 归一为 'user'（不是提权）")
  r = await A('setUserRole', { userId: 'o_ghost', role: 'admin' })
  t.eq(r.code, 404, 'setUserRole 用户不存在 → 404')
  r = await A('setUserRole', {})
  t.eq(r.code, 400, 'setUserRole 缺少 userId → 400')

  /* ==================================================================
   * 组 27 · admin.adjustCoins：必写流水 + 余额不穿透
   * ================================================================== */
  t.group('组 27 · admin.adjustCoins：wallet_logs 流水、余额下限、通知')

  seedAdmin()
  r = await A('adjustCoins', { userId: 'o_weak', amount: 5, remark: '活动补偿' })
  t.eq(r.code, 0, 'adjustCoins +5 成功')
  t.eq(t.user('o_weak').coins, 15, '★ 余额 10 → 15')
  t.eq(t.logs('o_weak', 'admin').length, 1, '★ 写 1 条 wallet_logs（type=admin）')
  let lg = t.logs('o_weak', 'admin')[0]
  t.eq(lg.amount, 5, '流水 amount = +5')
  t.eq(lg.balance, 15, '流水 balance = 变动后余额')
  t.eq(lg.frozen, 0, '流水 frozen = 变动后冻结额')
  t.eq(lg.orderId, '', '管理员调整无关联订单')
  t.eq(lg.remark.indexOf('活动补偿') > -1, true, '流水 remark 保留调整原因')
  t.eq(lg.remark.indexOf('管理员A') > -1, true, '流水 remark 记录操作人昵称')
  t.eq(Object.keys(lg).sort().join(','), '_id,_openid,amount,balance,createTime,frozen,orderId,orderNo,remark,type', '流水字段与 §3.6 契约一致')
  t.eq(t.notices('o_weak').length, 1, '调整写 1 条通知')
  t.ok(t.notices('o_weak')[0].content.indexOf('增加') > -1, '通知正文说明增加')
  t.ok(t.notices('o_weak')[0].content.indexOf('5') > -1, '通知正文带调整数量')

  r = await A('adjustCoins', { userId: 'o_weak', amount: -3 })
  t.eq(t.user('o_weak').coins, 12, '扣减 15 → 12')
  t.eq(t.logs('o_weak', 'admin').length, 2, '扣减再写一条流水')
  t.eq(t.logs('o_weak', 'admin')[1].amount, -3, '负数流水 amount=-3')
  t.eq(t.logs('o_weak', 'admin')[1].balance, 12, '负数流水 balance=12')
  t.eq(t.logs('o_weak', 'admin')[1].remark.indexOf('管理员调整') > -1, true, '未传 remark 时默认「管理员调整」')

  seedAdmin()
  r = await A('adjustCoins', { userId: 'o_weak', amount: -11 })
  t.eq(r.code, 409, '★ 扣成负数 → 409')
  t.eq(r.msg, '调整后余额不能为负', '拒绝文案')
  t.eq(t.user('o_weak').coins, 10, '拒绝后余额不变')
  t.eq(t.logs('o_weak').length, 0, '拒绝后不写流水（不能出现凭空流水）')
  t.eq(t.notices('o_weak').length, 0, '拒绝后不发通知')

  r = await A('adjustCoins', { userId: 'o_weak', amount: -10 })
  t.eq(r.code, 0, '恰好扣到 0 → 允许（边界）')
  t.eq(t.user('o_weak').coins, 0, '余额为 0')

  seedAdmin()
  t.eq((await A('adjustCoins', { userId: 'o_weak', amount: 0 })).code, 400, 'amount=0 → 400')
  t.eq((await A('adjustCoins', { userId: 'o_weak', amount: 'abc' })).code, 400, 'amount 非数字 → 400')
  t.eq((await A('adjustCoins', { userId: 'o_weak', amount: Infinity })).code, 400, 'amount=Infinity → 400（Number.isFinite 拦下）')
  t.eq((await A('adjustCoins', { userId: 'o_weak' })).code, 400, '缺少 amount → 400')
  t.eq((await A('adjustCoins', { userId: 'o_ghost', amount: 5 })).code, 404, '用户不存在 → 404')
  t.eq((await A('adjustCoins', { amount: 5 })).code, 400, '缺少 userId → 400')

  seedAdmin()
  await A('adjustCoins', { userId: 'o_weak', amount: '5' })
  t.eq(t.user('o_weak').coins, 15, "amount 字符串 '5' 被 Number 转换后生效")
  await A('adjustCoins', { userId: 'o_weak', amount: 2 })
  t.eq(t.user('o_weak').coins, 17, '连续调整累加（每次调用都是一次显式操作，不做幂等）')
  t.eq(t.logs('o_weak', 'admin').length, 2, '两次调用两条流水')
  const before = t.user('o_sel').frozenCoins
  await A('adjustCoins', { userId: 'o_sel', amount: 3 })
  t.eq(t.user('o_sel').frozenCoins, before, '调整可用余额不动 frozenCoins')
  const frozenLog = t.logs('o_sel', 'admin')[0]
  t.eq(frozenLog.frozen, before, '流水的 frozen 记录当前冻结额')
  await A('adjustCoins', { userId: 'o_weak', amount: 1, remark: '备'.repeat(150) })
  t.eq(t.logs('o_weak', 'admin')[2].remark.length <= 120, true, 'remark 超长被截断（100 字 + 操作人后缀）')

  /* ==================================================================
   * 组 28 · categories / saveCategory / deleteCategory
   * ================================================================== */
  t.group('组 28 · admin.categories / saveCategory / deleteCategory')

  s = seedAdmin()
  r = await A('categories', {})
  t.eq(r.code, 0, 'categories 调用成功')
  t.eq(r.data.list.length, 3, '返回 3 个分类')
  t.eq(r.data.list.map(x => x.name).join(','), '学业辅导,技能教学,生活服务', '按 sort 升序返回')

  r = await A('saveCategory', { name: '运动健身', icon: '🏀', sort: 4 })
  t.eq(r.code, 0, '新建分类成功')
  t.ok(!!r.data.id, '返回新分类 id')
  t.eq(s.categories.length, 4, '库里新增 1 个分类')
  const fresh = s.categories.filter(x => x.name === '运动健身')[0]
  t.eq(fresh.status, 1, '未传 status → 默认 1（启用）')
  t.eq(fresh.icon, '🏀', 'icon 生效')
  t.eq(fresh.sort, 4, 'sort 生效')
  t.ok(fresh.createTime instanceof Date, '写入 createTime')

  r = await A('saveCategory', { name: '临时分类' })
  const tmp = s.categories.filter(x => x.name === '临时分类')[0]
  t.eq(tmp.icon, '✨', "未传 icon → 默认 '✨'")
  t.eq(tmp.sort, 99, '未传 sort → 默认 99')

  t.eq((await A('saveCategory', {})).code, 400, 'name 缺失 → 400')
  t.eq((await A('saveCategory', { name: '   ' })).code, 400, 'name 全空格 → 400（先 trim）')
  t.eq((await A('saveCategory', { name: '一二三四五六七八九十' })).code, 0, 'name 恰好 10 字 → 允许')
  t.eq((await A('saveCategory', { name: '一二三四五六七八九十一' })).code, 400, 'name 11 字 → 400')

  s = seedAdmin()
  r = await A('saveCategory', { _id: 'c3', name: '生活服务(改)', icon: '📦' })
  t.eq(r.code, 0, '更新分类成功')
  t.eq(r.data.id, 'c3', '更新返回原 id')
  t.eq(s.categories.filter(x => x._id === 'c3')[0].name, '生活服务(改)', 'name 已更新')
  t.eq(s.categories.filter(x => x._id === 'c3')[0].status, 0, '未传 status → 保留原值 0（不擅自启用）')
  r = await A('saveCategory', { _id: 'c_ghost', name: '幽灵分类' })
  t.eq(r.code, 404, '更新不存在的分类 → 404')
  t.eq(r.msg, '分类不存在', '404 文案')

  s = seedAdmin()
  r = await A('deleteCategory', { _id: 'c2' })
  t.eq(r.code, 409, '★ 分类下有技能引用 → 409')
  t.eq(r.msg, '该分类下还有技能，不能删除', '409 文案')
  t.eq(s.categories.length, 3, '拒绝后分类仍在库里')
  r = await A('deleteCategory', { _id: 'c3' })
  t.eq(r.code, 0, '无技能引用的分类可删除')
  t.eq(s.categories.length, 2, '删除后少 1 个分类')
  t.eq(s.categories.filter(x => x._id === 'c3').length, 0, 'c3 确实被删掉')
  r = await A('deleteCategory', {})
  t.eq(r.code, 400, '缺少 _id → 400')
  r = await A('deleteCategory', { _id: 'c_ghost' })
  t.eq(r.code, 404, '分类不存在 → 404')

  /* ==================================================================
   * 组 29 · skills / auditSkill
   * ================================================================== */
  t.group('组 29 · admin.skills / auditSkill：状态机、增量更新、下架通知幂等')

  seedAdmin()
  r = await A('skills', {})
  t.eq(r.code, 0, 'skills 调用成功')
  t.eq(r.data.total, 3, '技能总数 3')
  t.eq(r.data.list[0]._id, 'sk2', '按 createTime desc，最新是 sk2')
  t.eq((await A('skills', { status: 1 })).data.total, 1, 'status=1 → 1 条')
  t.eq((await A('skills', { status: 4 })).data.total, 1, 'status=4（待审核）→ 1 条')
  t.eq((await A('skills', { status: 3 })).data.total, 1, 'status=3（违规下架）→ 1 条')
  t.eq((await A('skills', { status: 0 })).data.total, 0, 'status=0 → 0 条（0 必须生效）')
  t.eq((await A('skills', { status: '' })).data.total, 3, 'status=空串 → 不筛选')
  t.eq((await A('skills', { keyword: '吉他' })).data.total, 2, 'keyword 命中标题')
  t.eq((await A('skills', { keyword: '.' })).data.total, 0, '★ keyword=. 无命中（转义生效）')
  t.eq((await A('skills', { status: 1, keyword: '吉他' })).data.total, 1, '组合筛选：status=1 且标题含吉他')
  const skp = await A('skills', { page: 1, size: 2 })
  t.eq(skp.data.list.length, 2, 'size=2 生效')
  t.eq(skp.data.hasMore, true, 'hasMore=true')
  t.eq((await A('skills', { page: 2, size: 2 })).data.hasMore, false, '第二页 hasMore=false')

  seedAdmin()
  r = await A('auditSkill', { id: 'sk1', status: 9 })
  t.eq(r.code, 400, '非法 status=9 → 400')
  t.eq(r.msg, '非法的技能状态', '400 文案')
  t.eq((await A('auditSkill', { id: 'sk1' })).code, 400, 'status 缺失 → 400')
  t.eq((await A('auditSkill', { id: 'sk_ghost', status: 1 })).code, 404, '技能不存在 → 404')
  t.eq((await A('auditSkill', { status: 1 })).code, 404, 'id 缺失 → doc(undefined) 取不到 → 404')

  r = await A('auditSkill', { id: 'sk1', status: 3, remark: '含违规联系方式' })
  t.eq(r.code, 0, '违规下架成功')
  t.eq(t.skill('sk1').status, 3, '★ status=3 落库')
  t.eq(t.skill('sk1').auditRemark, '含违规联系方式', 'auditRemark 落库')
  t.eq(t.notices('o_sel').length, 1, '★ 下架通知作者（authorId 优先）')
  t.eq(t.notices('o_sel')[0].type, 'system', '下架通知 type=system')
  t.ok(t.notices('o_sel')[0].content.indexOf('吉他入门一对一') > -1, '通知正文带技能标题')
  t.ok(t.notices('o_sel')[0].content.indexOf('含违规联系方式') > -1, '通知正文带下架原因')

  await A('auditSkill', { id: 'sk1', status: 3, remark: '再下一次' })
  t.eq(t.notices('o_sel').length, 1, '★ 幂等：已是 3 再下架不重复发通知')
  t.eq(t.skill('sk1').auditRemark, '再下一次', '但 remark 仍按「显式传了才更新」写入')

  await A('auditSkill', { id: 'sk1', status: 1 })
  t.eq(t.skill('sk1').status, 1, '恢复上架 status=1')
  t.eq(t.skill('sk1').auditRemark, '再下一次', '★ 未传 remark → 保留原违规原因（不被清空）')
  t.eq(t.notices('o_sel').length, 1, '恢复上架不发通知')
  await A('auditSkill', { id: 'sk1', status: 1, remark: '' })
  t.eq(t.skill('sk1').auditRemark, '', '显式传 remark:"" → 清空（显式才更新）')

  await A('auditSkill', { id: 'sk1', status: 1, isTop: true })
  t.eq(t.skill('sk1').isTop, true, 'isTop=true 落库')
  await A('auditSkill', { id: 'sk1', status: 1 })
  t.eq(t.skill('sk1').isTop, true, '★ 未传 isTop → 保留置顶态（只改状态不会意外取消置顶）')
  await A('auditSkill', { id: 'sk1', status: 1, isTop: false })
  t.eq(t.skill('sk1').isTop, false, '显式 isTop=false → 取消置顶')
  await A('auditSkill', { id: 'sk1', status: 1, remark: '违'.repeat(300) })
  t.eq(t.skill('sk1').auditRemark.length, 200, 'remark 超长截断到 200 字')

  /* ==================================================================
   * 组 30 · admin.orders
   * ================================================================== */
  t.group('组 30 · admin.orders：全站列表、状态筛选、买卖双方昵称提顶层')

  seedAdmin()
  r = await A('orders', {})
  t.eq(r.code, 0, 'admin.orders 调用成功')
  t.eq(r.data.total, 9, '全站订单 9 条（不是只看自己的）')
  t.eq(r.data.list.length, 9, '默认 size 10 → 9 条')
  t.eq(r.data.hasMore, false, '9 < 10 → hasMore=false')
  t.eq(r.data.list[0]._id, 'o1', '按 createTime desc：今天的订单在前')
  t.eq(r.data.list[8]._id, 'o9', '最旧的是 3 天前的 o9')
  t.eq(r.data.list[0].buyerNickName, '买家小明', '买家昵称从 buyerInfo 提到顶层')
  t.eq(r.data.list[0].sellerNickName, '卖家思远', '卖家昵称从 sellerInfo 提到顶层')
  t.eq(r.data.list[0].buyerInfo.nickName, '买家小明', '原始 buyerInfo 快照未被破坏')

  t.eq((await A('orders', { status: 'waiting' })).data.total, 2, 'status=waiting → 2 条')
  t.eq((await A('orders', { status: 'finished' })).data.total, 3, 'status=finished → 3 条')
  t.eq((await A('orders', { status: 'all' })).data.total, 9, "status='all' → 不筛选")
  t.eq((await A('orders', { status: '' })).data.total, 9, 'status 空串 → 不筛选')
  t.eq((await A('orders', { orderNo: 'TB20261005' })).data.total, 1, 'orderNo 精确命中')
  t.eq((await A('orders', { orderNo: 'TB2026100' })).data.total, 9, 'orderNo 模糊命中全部')
  t.eq((await A('orders', { keyword: '吉他' })).data.total, 4, 'keyword 匹配 skillSnapshot.title')
  t.eq((await A('orders', { keyword: 'TB20261003' })).data.total, 1, 'keyword 匹配 orderNo')
  t.eq((await A('orders', { keyword: '.' })).data.total, 0, '★ keyword=. 无命中（转义生效）')
  const op = await A('orders', { page: 1, size: 4 })
  t.eq(op.data.list.length, 4, 'size=4 第一页 4 条')
  t.eq(op.data.hasMore, true, 'hasMore=true')
  t.eq((await A('orders', { page: 3, size: 4 })).data.list.length, 1, '第三页 1 条')
  t.eq((await A('orders', { page: 3, size: 4 })).data.hasMore, false, '第三页 hasMore=false')

  /* ==================================================================
   * 组 31 · reports / handleReport
   * ================================================================== */
  t.group('组 31 · admin.reports / handleReport：扣分、通知、重复处理幂等')

  seedReports()
  r = await A('reports', {})
  t.eq(r.code, 0, 'admin.reports 调用成功')
  t.eq(r.data.total, 7, '举报总数 7')
  t.ok(['rp6', 'rp7'].indexOf(r.data.list[0]._id) > -1, '按 createTime desc：最新的是 rp6/rp7（同一小时内构造）')
  t.ok(r.data.list.every((x, i, a) => i === 0 || new Date(a[i - 1].createTime) >= new Date(x.createTime)), 'reports 按 createTime 倒序')
  t.eq(r.data.list[6]._id, 'rp3', '最旧的是 rp3')
  t.eq((await A('reports', { status: 0 })).data.total, 6, '待处理 6 条')
  t.eq((await A('reports', { status: 1 })).data.total, 1, '已处理 1 条')
  t.eq((await A('reports', { status: 2 })).data.total, 0, '已驳回 0 条')
  t.eq((await A('reports', { status: '' })).data.total, 7, 'status 空串 → 不筛选')
  t.eq((await A('reports', { status: 0, page: 1, size: 4 })).data.list.length, 4, '分页生效')
  t.eq((await A('reports', { status: 0, page: 2, size: 4 })).data.hasMore, false, '第二页 hasMore=false')

  t.eq((await A('handleReport', {})).code, 400, '缺少举报 id → 400')
  t.eq((await A('handleReport', { id: 'rp_ghost', result: 1 })).code, 404, '举报不存在 → 404')

  seedReports()
  s = t.store()
  r = await A('handleReport', { id: 'rp1', result: 1, remark: '证据充分' })
  t.eq(r.code, 0, 'handleReport result=1 成功')
  t.eq(s.reports.filter(x => x._id === 'rp1')[0].status, 1, '★ 举报状态 → 1（已处理）')
  t.eq(s.reports.filter(x => x._id === 'rp1')[0].handleRemark, '证据充分', '写入 handleRemark')
  t.eq(s.reports.filter(x => x._id === 'rp1')[0].handlerId, 'o_adm', '写入 handlerId')
  t.ok(s.reports.filter(x => x._id === 'rp1')[0].handleTime instanceof Date, '写入 handleTime')
  t.eq(t.user('o_sel').creditScore, 100, '★ 被举报人 110 → 100（changeCredit -10）')
  t.eq(t.user('o_sel').creditLevel, 'good', '信用等级随分数重算')
  t.eq(t.credits('o_sel').length, 1, '★ 写 1 条 credit_logs')
  t.eq(t.credits('o_sel')[0].change, -10, '信用流水 change=-10')
  t.eq(t.credits('o_sel')[0].score, 100, '信用流水 score=变动后分数')
  t.eq(t.credits('o_sel')[0].reason, 'report_valid', "信用流水 reason='report_valid'")
  t.eq(t.notices('o_buy').length, 1, '举报人收到处理结果通知')
  t.eq(t.notices('o_buy')[0].type, 'report', '通知 type=report')
  t.eq(t.notices('o_buy')[0].title, '举报已处理', '通知标题')
  t.ok(t.notices('o_buy')[0].content.indexOf('虚假信息') > -1, '通知正文带举报原因')

  r = await A('handleReport', { id: 'rp1', result: 1, remark: '再点一次' })
  t.eq(r.code, 0, '重复处理仍返回成功（幂等，不报错）')
  t.eq(t.user('o_sel').creditScore, 100, '★ 幂等：不重复扣分')
  t.eq(t.credits('o_sel').length, 1, '★ 幂等：不重复写 credit_logs')
  t.eq(t.notices('o_buy').length, 1, '★ 幂等：不重复发通知')
  t.eq(s.reports.filter(x => x._id === 'rp1')[0].handleRemark, '证据充分', '幂等：不覆盖首次处理结论')

  r = await A('handleReport', { id: 'rp3', result: 1 })
  t.eq(r.code, 0, '已处理过的举报再处理不报错')
  t.eq(t.credits('o_sel').length, 1, '★ 幂等：status!==0 的举报不扣分（rp3 已处理）')

  r = await A('handleReport', { id: 'rp2', result: 1 })
  t.eq(t.user('o_weak').creditScore, 75, '★ 被举报人 85 → 75')
  t.eq(t.user('o_weak').creditLevel, 'weak', '信用分跨档：good → weak（60-79）')
  t.eq(t.credits('o_weak')[0].score, 75, '信用流水记录的分数与用户文档一致')

  r = await A('handleReport', { id: 'rp4', result: 1 })
  t.eq(t.user('o_buy').creditScore, 0, '★ 信用分下限：5 - 10 被 clamp 到 0（不是 -5）')
  t.eq(t.credits('o_buy')[0].change, -10, '流水仍记录请求的变化量 -10')
  t.eq(t.credits('o_buy')[0].score, 0, '流水记录 clamp 后的分数 0')

  r = await A('handleReport', { id: 'rp5', result: 1 })
  t.eq(r.code, 0, 'targetUserId 为空时不崩（changeCredit 直接跳过）')
  t.eq(t.store().reports.filter(x => x._id === 'rp5')[0].status, 1, 'targetUserId 为空也照常结案')
  t.eq(t.notices('o_weak').length >= 1, true, 'targetUserId 为空仍通知举报人')

  r = await A('handleReport', { id: 'rp7', result: 1 })
  t.eq(r.code, 0, '被举报人已不存在时不崩')
  t.eq(t.store().reports.filter(x => x._id === 'rp7')[0].status, 1, '被举报人不存在也照常结案')
  t.eq(t.credits('o_ghost').length, 0, '被举报人不存在 → 不写孤儿信用流水')

  seedReports()
  r = await A('handleReport', { id: 'rp6', result: 2, remark: '证据不足' })
  t.eq(r.code, 0, 'handleReport result=2 成功')
  t.eq(t.store().reports.filter(x => x._id === 'rp6')[0].status, 2, '★ 驳回 → status=2')
  t.eq(t.store().reports.filter(x => x._id === 'rp6')[0].handleRemark, '证据不足', '驳回写入 handleRemark')
  t.eq(t.user('o_sel').creditScore, 110, '驳回不扣信用分')
  t.eq(t.credits('o_sel').length, 0, '驳回不写 credit_logs')
  t.eq(t.notices('o_weak').length, 1, '驳回也通知举报人（mock 侧没有这条，云函数更完整）')
  t.eq(t.notices('o_weak')[0].title, '举报处理结果', '驳回通知标题')
  t.ok(t.notices('o_weak')[0].content.indexOf('证据不足') > -1, '驳回通知正文带驳回说明')

  seedReports()
  const bad1 = await A('handleReport', { id: 'rp6' })
  t.eq(bad1.code, 400, '★ result 缺失 → 400（修复前会被静默当作「驳回」）')
  t.eq(t.store().reports.filter(x => x._id === 'rp6')[0].status, 0, '★ 非法调用不改动举报状态')
  t.eq(t.credits('o_sel').length, 0, 'result 缺失不会误扣分')
  seedReports()
  const bad2 = await A('handleReport', { id: 'rp6', result: 3 })
  t.eq(bad2.code, 400, '★ result=3 非法 → 400（修复前静默驳回）')
  t.eq(t.store().reports.filter(x => x._id === 'rp6')[0].status, 0, '★ 非法 result 不改动举报状态')

  /* ==================================================================
   * 组 32 · banners / saveBanner / deleteBanner
   * ================================================================== */
  t.group('组 32 · admin.banners / saveBanner / deleteBanner')

  s = seedAdmin()
  r = await A('banners', {})
  t.eq(r.code, 0, 'banners 调用成功')
  t.eq(r.data.list.length, 2, '返回 2 条轮播')
  t.eq(r.data.list.map(x => x._id).join(','), 'b1,b2', '按 sort 升序')

  r = await A('saveBanner', { image: 'cloud://c.png', title: '新学期', link: '/pages/index/index', sort: 3 })
  t.eq(r.code, 0, '新建轮播成功')
  t.ok(!!r.data.id, '返回新 id')
  t.eq(s.banners.length, 3, '库里新增 1 条')
  const nb = s.banners.filter(x => x._id === r.data.id)[0]
  t.eq(nb.status, 1, '新建未传 status → 默认 1')
  t.eq(nb.sort, 3, 'sort 生效')
  t.eq(nb.image, 'cloud://c.png', 'image 生效')
  t.ok(nb.createTime instanceof Date, '写入 createTime')

  r = await A('saveBanner', { title: '标'.repeat(60) })
  t.eq(s.banners.filter(x => x._id === r.data.id)[0].title.length, 40, 'title 超长截断到 40 字')

  r = await A('saveBanner', { _id: 'b1', title: '首单有礼(改)', link: '/pages/index/index', image: 'cloud://a.png', sort: 1, status: 1 })
  t.eq(r.code, 0, '更新轮播成功')
  t.eq(r.data.id, 'b1', '更新返回原 id')
  t.eq(s.banners.filter(x => x._id === 'b1')[0].title, '首单有礼(改)', 'title 已更新')
  r = await A('saveBanner', { _id: 'b_ghost', title: '幽灵' })
  t.eq(r.code, 404, '更新不存在的轮播 → 404')

  r = await A('deleteBanner', { _id: 'b2' })
  t.eq(r.code, 0, '删除轮播成功')
  t.eq(s.banners.length, 3, '删除后 4 → 3 条（新建成过 2 条 + 原有 2 条）')
  t.eq(s.banners.filter(x => x._id === 'b2').length, 0, 'b2 确实被删掉')
  r = await A('deleteBanner', { _id: 'b_ghost' })
  t.eq(r.code, 0, '删除不存在的轮播仍返回 ok（幂等，与 mock 行为一致）')
  r = await A('deleteBanner', {})
  t.eq(r.code, 400, '缺少 _id → 400')

  /* ==================================================================
   * 组 33 · config / saveConfig
   * ================================================================== */
  t.group('组 33 · admin.config / saveConfig：白名单、数值兜底、部分更新')

  seedAdmin()
  r = await A('config', {})
  t.eq(r.code, 0, 'config 调用成功')
  const cfg = r.data
  t.eq(cfg.config, undefined, '不包一层 { config }（字段平铺）')
  t.eq(cfg.registerBonus, 5, 'registerBonus 来自库（5）')
  t.eq(cfg.orderExpireHours, 24, 'orderExpireHours = 24')
  t.eq(cfg.confirmExpireHours, 72, 'confirmExpireHours = 72')
  t.eq(cfg.minCreditToOrder, 60, 'minCreditToOrder = 60')
  t.eq(cfg.serviceFee, 0, 'serviceFee = 0')
  t.ok(Array.isArray(cfg.hotCategories), 'hotCategories 缺省兜底为数组')
  t.eq(cfg.aboutUs, '', 'aboutUs 缺省兜底为空串')
  t.eq(cfg.subscribeTemplates.ORDER_CREATE, 'TPL_C', 'config 透出 subscribeTemplates')
  t.eq(Object.keys(cfg).sort().join(','),
    '_id,aboutUs,confirmExpireHours,hotCategories,minCreditToOrder,orderExpireHours,registerBonus,serviceFee,subscribeTemplates',
    'config 返回字段集合（含 _id 与 subscribeTemplates）')

  s = seedAdmin()
  s.config = []
  r = await A('config', {})
  t.eq(r.data.registerBonus, 5, 'config 文档缺失 → 回落 DEFAULT_CONFIG.registerBonus=5')
  t.eq(r.data.minCreditToOrder, 60, 'config 文档缺失 → DEFAULT_CONFIG.minCreditToOrder=60')

  seedAdmin()
  r = await A('saveConfig', { registerBonus: 8 })
  t.eq(r.code, 0, 'saveConfig 部分更新成功')
  let after = (await A('config', {})).data
  t.eq(after.registerBonus, 8, 'registerBonus 8 生效')
  t.eq(after.orderExpireHours, 24, '★ 未传的 orderExpireHours 保留原值 24（只更新传入字段）')
  t.eq(after.confirmExpireHours, 72, '未传的 confirmExpireHours 保留 72')
  t.eq(after.minCreditToOrder, 60, '未传的 minCreditToOrder 保留 60')
  t.eq(after.serviceFee, 0, '未传的 serviceFee 保留 0')

  seedAdmin()
  await A('saveConfig', { registerBonus: -5, orderExpireHours: 'abc', serviceFee: 2.5 })
  after = (await A('config', {})).data
  t.eq(after.registerBonus, 5, '★ 数值兜底：负数 registerBonus 不写入，保留 5')
  t.eq(after.orderExpireHours, 24, "★ 数值兜底：'abc' 不写入，保留 24")
  t.eq(after.serviceFee, 2.5, '合法数值 2.5 正常写入')

  seedAdmin()
  await A('saveConfig', { aboutUs: 123, hotCategories: 'not-array' })
  after = (await A('config', {})).data
  t.eq(after.aboutUs, '', 'aboutUs 非字符串 → 保留原值')
  t.eq(after.hotCategories.length, 0, 'hotCategories 非数组 → 保留原值（[]）')

  seedAdmin()
  await A('saveConfig', { hotCategories: Array.from({ length: 25 }, (_, i) => 'c' + i), aboutUs: '说'.repeat(2500) })
  after = (await A('config', {})).data
  t.eq(after.hotCategories.length, 20, 'hotCategories 超 20 项截断')
  t.eq(after.aboutUs.length, 2000, 'aboutUs 超 2000 字截断')

  seedAdmin()
  r = await A('saveConfig', { registerBonus: 7, hacked: 'x', _id: 'evil' })
  after = (await A('config', {})).data
  t.eq(r.code, 0, '带非法字段仍成功（白名单外直接忽略）')
  t.eq(after.hacked, undefined, '★ 白名单：unknown 字段不落库')
  t.eq(after._id, 'global', "★ 白名单：_id 不能被改写（仍是 'global'）")
  t.eq(after.registerBonus, 7, '白名单内字段正常写入')
  t.eq(Object.keys(after).sort().join(','),
    '_id,aboutUs,confirmExpireHours,hotCategories,minCreditToOrder,orderExpireHours,registerBonus,serviceFee,subscribeTemplates,updateTime',
    '保存后 config 文档恰好是白名单字段 + updateTime（subscribeTemplates 已纳入白名单，缺陷已修，见组 34）')

  s = seedAdmin()
  const beforeUpd = s.config[0].updateTime
  await A('saveConfig', { serviceFee: 1 })
  after = (await A('config', {})).data
  t.ok(after.updateTime instanceof Date, 'saveConfig 刷新 updateTime')
  t.eq(t.store().users.length, 7, 'saveConfig 不影响其他集合')
  t.eq(beforeUpd === undefined, true, '夹具 config 原本没有 updateTime（对照用）')

  /* ==================================================================
   * 组 34 · ★ 契约偏差：以下为「实现缺陷」，故意留红
   *   判定依据：docs/ARCHITECTURE.md §4.8 / §9.5 + utils/mock.js 离线镜像
   *   + packageAdmin/pages/orders/orders.js 的 DIST_NAME_TO_KEY
   *   缺陷 1-3 已由 Lead 确认为真缺陷并计划修复；缺陷 4-5 为本次补充、待裁定。
   * ================================================================== */
  t.group('组 34 · ★契约偏差（红=实现缺陷）：缺陷1-3 已确认，缺陷4-5 待裁定')

  seedAdmin()
  s = t.store()
  res = await A('stats', {})
  const bad = res.data.orderStatusDist
  t.log('[缺陷1] orderStatusDist = ' + JSON.stringify(bad))
  t.eq(bad.length, 6,
    '【缺陷1】orderStatusDist 必须固定输出 6 个中文状态（含 0），实际只有 ' + bad.length +
    ' 个：closed 被并进「已取消」→ 前端「已关闭」恒为 0、「已取消」虚高')
  t.eq((bad.filter(x => x.name === '已关闭')[0] || {}).value, 1,
    '【缺陷1】「已关闭」应有独立一项且值为 1（closed 订单 1 条），实际该字段不存在')
  t.eq((bad.filter(x => x.name === '已取消')[0] || {}).value, 1,
    '【缺陷1】「已取消」只应统计 canceled（1 条），实际值 ' +
    ((bad.filter(x => x.name === '已取消')[0] || {}).value) + '（把 closed 也算进来了）')

  s = seedAdmin()
  await A('saveBanner', { _id: 'b2', title: '期末互助(改)' })
  const b2 = s.banners.filter(x => x._id === 'b2')[0]
  t.log('[缺陷2] saveBanner 更新后 b2 = ' + JSON.stringify({ status: b2.status, sort: b2.sort, title: b2.title }))
  t.eq(b2.status, 0,
    '【缺陷2】saveBanner 更新时未传 status 应保留原值 0（停用），实际被重置为 ' + b2.status +
    '（启用）—— saveCategory 与 mock 的 Object.assign 都保留原值')

  seedAdmin({ subscribe: { ORDER_CREATE: 'TPL_C', ORDER_FINISH: 'TPL_F' } })
  await A('saveConfig', { registerBonus: 6 })
  const cfg2 = (await A('config', {})).data
  t.log('[缺陷3] saveConfig 后 subscribeTemplates = ' + JSON.stringify(cfg2.subscribeTemplates))
  t.eq(cfg2.subscribeTemplates && cfg2.subscribeTemplates.ORDER_CREATE, 'TPL_C',
    '【缺陷3·高危】saveConfig 白名单漏了 subscribeTemplates，而收尾 set() 整篇覆盖 → 保存任意配置即永久删除 4 个订阅模板 ID；' +
    'order/index.js:86 的 tplId() 正是优先读 config.subscribeTemplates[key] → 订阅消息静默失效')

  seedAdmin()
  await A('saveConfig', { minCreditToOrder: '' })
  const cfg3 = (await A('config', {})).data
  t.eq(cfg3.minCreditToOrder, 60,
    "【缺陷4】saveConfig 数值兜底对空串/null 失效：Number('')===0 且 >=0 通过校验 → minCreditToOrder 被静默写成 " +
    cfg3.minCreditToOrder + '（等于关闭信用门槛），而不是保留原值 60')

  const s2 = seedAdmin()
  s2.users.find(x => x._openid === 'o_new').creditScore = 0
  s2.users.find(x => x._openid === 'o_new').creditLevel = 'limited'
  s2.users.find(x => x._openid === 'o_new').stats.serveCount = 9
  const st2 = (await A('stats', {})).data
  const top = st2.topUsers.filter(x => x.openid === 'o_new')[0] || {}
  t.log('[缺陷5] topUsers 里 0 分用户的 creditScore = ' + top.creditScore)
  t.eq(top.creditScore, 0,
    '★ topUsers 原样透出 0 分（修复前 `|| 100` 会显示成 ' + top.creditScore + '；mock.js 侧无此兜底）')

  /* ==================================================================
   * 组 35：★ check —— 封禁账号不应被识别为管理员
   * ================================================================== */
  t.group('组 35 · ★ check：封禁账号不算管理员')

  const s3 = seedAdmin()
  t.eq((await A('check', {})).data.isAdmin, true, '正常管理员 isAdmin=true')

  s3.users.find(x => x._openid === ADMIN).status = 0
  const chk = await A('check', {})
  t.eq(chk.code, 0, 'check 不抛错（契约：未登录/非管理员都返回 isAdmin=false）')
  t.eq(chk.data.isAdmin, false,
    '★ 被封禁的管理员 isAdmin=false（修复前仍返回 true：后台入口可见，但每个 action 都 403，无从解释）')


  /* ==================================================================
   * 组 27 · ★ 调试员权限隔离（debugger ⊃ admin）
   * ------------------------------------------------------------------
   * 这是本次改动里**最要紧的安全断言**：
   * 如果普通管理员能给自己升级成调试员，整套隔离就是纸糊的。
   * ================================================================== */
  t.group('组 27 · ★ 调试员权限隔离：管理员不能自己升级')

  seedAdmin()
  r = await A('setUserRole', { userId: 'o_adm', role: 'debugger' })
  t.eq(r.code, 403, '★ 普通管理员不能把自己设为调试员')
  t.eq(t.user('o_adm').role, 'admin', '★ 被拒后角色没变（没有半途写入）')

  seedAdmin()
  r = await A('setUserRole', { userId: 'o_buy', role: 'debugger' })
  t.eq(r.code, 403, '★ 普通管理员不能把别人设为调试员（否则可找同伙绕过）')
  t.eq(t.user('o_buy').role, 'user', '被拒后目标角色没变')

  seedAdmin()
  r = await A('setUserRole', { userId: 'o_buy', role: 'admin' })
  t.eq(r.code, 0, '普通管理员设/撤普通管理员不受影响')
  t.eq(t.user('o_buy').role, 'admin', '设为管理员成功')

  seedAdmin()
  t.user('o_adm').role = 'debugger'
  r = await A('setUserRole', { userId: 'o_buy', role: 'debugger' })
  t.eq(r.code, 0, '★ 调试员可以授予调试员身份')
  t.eq(t.user('o_buy').role, 'debugger', '设为调试员成功')

  seedAdmin()
  t.user('o_buy').role = 'debugger'
  r = await A('setUserRole', { userId: 'o_buy', role: 'user' })
  t.eq(r.code, 403, '★ 普通管理员不能撤销调试员（不能把校方踢下来）')
  t.eq(t.user('o_buy').role, 'debugger', '被拒后仍是调试员')

  seedAdmin()
  t.user('o_buy').role = 'debugger'
  r = await A('setUserStatus', { userId: 'o_buy', status: 0 })
  t.eq(r.code, 403, '★ 普通管理员不能封禁调试员')
  t.eq(t.user('o_buy').status, 1, '被拒后调试员未被封禁')

  seedAdmin()
  t.user('o_adm').role = 'debugger'
  t.user('o_buy').role = 'debugger'
  r = await A('setUserStatus', { userId: 'o_buy', status: 0 })
  t.eq(r.code, 0, '调试员之间可以互相封禁')

  seedAdmin()
  t.user('o_adm').role = 'debugger'
  r = await A('users', {})
  t.eq(r.code, 0, '★ 调试员能进管理后台（能接触所有数据）')

  /* admin.debugInfo —— 云端真正被 requireDebugger 守住的接口 */
  seedAdmin()
  r = await A('debugInfo', {})
  t.eq(r.code, 403, '★ 普通管理员调 debugInfo → 403（云端有真实边界，不只是前端隐藏）')
  t.eq(r.msg, '无管理员权限', '★ 文案与 requireAdmin 一致，不透露上层存在')

  seedAdmin()
  t.user('o_adm').role = 'debugger'
  r = await A('debugInfo', {})
  t.eq(r.code, 0, '★ 调试员调 debugInfo → 0')
  t.eq(r.data.role, 'debugger', 'debugInfo 回传角色')
  t.ok(r.data.serverTime > 0, 'debugInfo 回传服务器时间')
  t.ok(r.data.config && r.data.config.minCreditToOrder !== undefined, 'debugInfo 回传全局配置')
}
