/**
 * initdb 云函数离线回归用例（3 个 action）
 * ==================================================================
 * 契约见 docs/ARCHITECTURE.md §4.9（★ 两层鉴权模型 + 踩过的三个坑）
 * action：init | clear | setAdmin
 *
 * ⚠️ 「控制台调用」在离线测试里用 t.callRaw()（getOpenId() 为空）模拟，
 *    「小程序调用」用 t.call(fn, openid, ...)（getOpenId() 非空）模拟。
 *
 * ⚠️ 断言消息里带「⚠️ 偏差」前缀的，断言的是**当前实现的实际行为**（保持绿色）。
 * ==================================================================
 */
module.exports = async function (t) {
  const ALL13 = [
    'users', 'categories', 'skills', 'orders', 'reviews',
    'wallet_logs', 'credit_logs', 'chats', 'messages',
    'notices', 'reports', 'banners', 'config'
  ]

  /** 控制台调用（无登录态） */
  const consoleCall = (event) => t.callRaw('initdb', Object.assign({ action: 'init' }, event))
  /** 清空所有集合，模拟「全新环境」 */
  const blank = () => t.fake.__reset()

  /* ==================================================================
   * 组 1：init（控制台调用）—— 建 13 集合 + 写种子数据
   * ================================================================== */
  t.group('组 1 · init（控制台）：创建全部 14 个集合 + 写入完整演示种子数据')

  blank()
  let r = await consoleCall({})
  t.eq(r.code, 0, '★ 控制台调用 init 成功（不要求登录态 —— §4.9 踩坑 1 的回归）')
  t.eq(r.data.created.length, 17, '★ 空环境下创建了 17 个集合（含后来新增的 favorites）')
  t.eq(r.data.existed.length, 0, '空环境下没有「已存在」的集合')
  ALL13.forEach(name => {
    t.ok(r.data.created.indexOf(name) > -1, `集合 ${name} 被创建`)
  })
  t.isTrue(r.data.firstTime === false, '控制台调用 firstTime=false（不是引导模式）')

  const sd = r.data.seeded
  t.eq(sd.categories.inserted, 10, '写入 10 个技能分类')
  t.eq(sd.config.inserted, 1, '写入 1 份全局配置')
  t.eq(sd.banners.inserted, 3, '写入 3 条首页轮播')
  t.eq(sd.users.inserted, 6, '写入 6 个演示用户')
  t.eq(sd.skills.inserted, 12, '写入 12 条演示技能')
  t.eq(sd.orders.inserted, 8, '写入 8 张演示订单')
  t.eq(sd.reviews.inserted, 6, '写入 6 条演示评价')
  t.eq(sd.walletLogs.inserted, 8, '写入 8 条时间币流水')
  t.eq(sd.creditLogs.inserted, 7, '写入 7 条信用分流水')
  t.eq(sd.notices.inserted, 5, '写入 5 条系统通知')
  t.eq(sd.reports.inserted, 2, '写入 2 条举报')
  t.ok(Object.keys(sd).length === 13, 'seeded 覆盖 13 个种子集合', Object.keys(sd).join(','))

  const store = t.store()
  t.eq(store.users.length, 8, '库里 users = 8')
  t.eq(store.skills.length, 12, '库里 skills = 12')
  t.eq(store.orders.length, 8, '库里 orders = 8')
  t.eq(store.reviews.length, 6, '库里 reviews = 6')
  t.eq(store.categories.length, 10, '库里 categories = 10')
  t.eq(store.banners.length, 3, '库里 banners = 3')
  t.eq(store.config.length, 1, '库里 config = 1')
  t.eq(store.wallet_logs.length, 8, '库里 wallet_logs = 8')
  t.eq(store.credit_logs.length, 7, '库里 credit_logs = 7')
  t.eq(store.notices.length, 5, '库里 notices = 5')
  t.eq(store.reports.length, 2, '库里 reports = 2')

  t.eq(r.data.summary.users, 8, 'summary.users = 8')
  t.eq(r.data.summary.skills, 12, 'summary.skills = 12')
  t.eq(r.data.summary.orders, 8, 'summary.orders = 8')
  t.eq(r.data.summary.reviews, 6, 'summary.reviews = 6')
  t.eq(r.data.summary.categories, 10, 'summary.categories = 10')
  t.eq(r.data.summary.banners, 3, 'summary.banners = 3')
  t.eq(Object.keys(r.data.summary).sort().join(','), 'banners,categories,orders,reviews,skills,users', 'summary 字段与契约一致')

  const u1 = store.users.find(u => u._id === 'user_u1')
  t.eq(u1._openid, 'openid_demo_u1', '演示用户 _openid 固定为 openid_demo_u1')
  t.eq(u1.role, 'user', '演示用户默认不是管理员')
  t.eq(u1.status, 1, '演示用户状态正常')
  t.eq(u1.authStatus, 2, '演示用户已通过校园认证')
  // ★ 语义已变：init 会种入**内部账户**（一个管理员 + 一个调试员）。
  //   这比「初始无管理员、靠 setAdmin 引导」更安全 ——
  //   引导模式（无管理员就放行）从此在正常部署下走不到。
  t.eq(store.users.filter(u => u.role === 'admin' || u.role === 'debugger').length, 2,
    '★ 首次初始化即自带 2 个管理层（内部管理员 + 内部调试员）')

  const sk = store.skills.find(s => s._id === 'demo_skill_01')
  t.eq(sk.status, 1, '演示技能默认上架')
  t.eq(sk.authorId, 'openid_demo_u1', '演示技能的作者是演示用户')
  t.eq(store.skills.find(s => s._id === 'demo_skill_05').isTop, true, 'demo_skill_05 是置顶技能（首页排序演示）')
  t.eq(store.config[0].registerBonus, 5, '全局配置 registerBonus=5（与 login 注册赠送一致）')

  const orderStatus = store.orders.map(o => o.status)
  t.ok(orderStatus.indexOf('waiting') > -1, '演示订单覆盖 waiting 状态')
  t.ok(orderStatus.indexOf('ongoing') > -1, '演示订单覆盖 ongoing 状态')
  t.ok(orderStatus.indexOf('confirming') > -1, '演示订单覆盖 confirming 状态')
  t.ok(orderStatus.indexOf('finished') > -1, '演示订单覆盖 finished 状态')
  t.ok(orderStatus.indexOf('canceled') > -1, '演示订单覆盖 canceled 状态')

  /* ==================================================================
   * 组 2：init 幂等 —— 重复调用 inserted=0，不产生重复数据
   * ================================================================== */
  t.group('组 2 · init 幂等：★ 重复调用 inserted 全为 0，集合数不增')

  r = await consoleCall({})
  t.eq(r.code, 0, '第二次 init 仍成功')
  t.eq(r.data.created.length, 0, '★ 第二次 created 为空（集合已存在被 try/catch 吞掉）')
  t.eq(r.data.existed.length, 17, '★ 第二次 existed = 17')
  t.ok(Object.keys(r.data.seeded).every(k => r.data.seeded[k].inserted === 0), '★ 所有集合的 inserted 都是 0（没有重复插入）')
  t.eq(r.data.seeded.users.skipped, 6, '已存在的 6 个演示用户被跳过')
  t.eq(r.data.seeded.skills.skipped, 12, '已存在的 12 条技能被跳过')
  t.eq(t.store().users.length, 8, '★ users 仍是 8（没有翻倍）')
  t.eq(t.store().skills.length, 12, '★ skills 仍是 12')
  t.eq(t.store().orders.length, 8, '★ orders 仍是 8')
  t.eq(t.store().config.length, 1, '★ config 仍是 1（_id=global 不会写两份）')
  t.eq(r.data.summary.users, 8, '第二次 summary 与第一次一致')

  r = await consoleCall({})
  t.eq(r.data.seeded.orders.inserted, 0, '第三次 init 同样 inserted=0')
  t.eq(t.store().orders.length, 8, '第三次 init 后 orders 仍为 8')

  /* 断点续跑：上一次 init 中途中断留下的半成品，重跑只补缺失的 */
  blank()
  t.store().users = [{ _id: 'user_u1', _openid: 'openid_demo_u1', nickName: '已存在的用户', role: 'user', status: 1 }]
  r = await consoleCall({})
  t.eq(r.code, 0, '半成品环境下 init 成功')
  t.eq(r.data.seeded.users.inserted, 5, '★ 断点续跑：已存在的 user_u1 被跳过，只补写其余 5 个')
  t.eq(r.data.seeded.users.skipped, 1, 'skipped=1')
  t.eq(t.store().users.length, 8, '总数仍为 8（不重复插入）')
  t.eq(t.store().users.find(u => u._id === 'user_u1').nickName, '已存在的用户', '⚠️ 偏差：seedDocs 只按 _id 探测、从不 update，已存在文档不会被修正')
  t.eq(r.data.existed.indexOf('users') > -1, true, 'users 集合被记为已存在')

  /* 已有 fixture 数据时：只补建缺失集合，config 的 _id=global 冲突被跳过 */
  t.seed()
  r = await consoleCall({})
  t.eq(r.data.created.length, 10, 'fixture 库（10 个集合已存在）只补建 10 个新集合')
  t.eq(r.data.existed.length, 7, '7 个已存在集合被正确识别')
  t.eq(r.data.seeded.config.inserted, 0, '★ config._id=global 已存在 → 跳过，不覆盖现有配置')
  t.eq(t.store().config.length, 1, 'config 仍只有 1 份')
  t.eq(r.data.summary.users, 12, '原有 4 个 fixture 用户 + 6 个演示用户 = 12')

  /* ==================================================================
   * 组 3：init / clear 的小程序调用鉴权（§4.9 两层模型）
   * ================================================================== */
  t.group('组 3 · 鉴权矩阵①②：users 为空 → 放行；users 有但无 admin → 引导模式放行')

  blank()
  r = await t.call('initdb', 'openid_first', 'init', {})
  t.eq(r.code, 0, '★ 小程序调用 + users 为空 → 放行（否则首个管理员永远引导不出来）')
  t.isTrue(r.data.firstTime === true, 'firstTime=true（首次部署模式）')
  t.eq(t.store().users.length, 8, '首个用户的 init 也把种子数据写全了')

  blank()
  await consoleCall({})
  // ★ 内部账户种子里带了一个管理员和一个调试员 —— 要测「无管理员」的引导模式，
  //   必须先把它们降级，否则引导分支根本走不到。
  t.store().users.forEach(u => { if (u.role === 'admin' || u.role === 'debugger') u.role = 'user' })
  r = await t.call('initdb', 'openid_demo_u1', 'init', {})
  t.eq(t.store().users.filter(u => u.role === 'admin').length, 0, '确认此时系统内没有管理员（已手动降级）')
  t.isTrue(r.data && r.data.firstTime === true, '★ 无管理员 → 引导模式 firstTime=true')
  t.eq(r.code, 0, '★ 无管理员时小程序调用 init 放行（不退化成 403）')

  /* ==================================================================
   * 组 4：鉴权矩阵③④：已有管理员 —— 管理员放行、非管理员 403
   * ================================================================== */
  t.group('组 4 · 鉴权矩阵③④：已有 admin → 管理员放行；非管理员一律 403')

  const mkAdminState = async () => {
    blank()
    await consoleCall({})
    // 系统里已有管理员 → 不再走引导模式
    t.store().users.find(u => u._openid === 'openid_demo_u1').role = 'admin'
    // 调用者是**调试员** —— 危险操作只有调试员能做。
    // ★ 用 u3 而不是 u2：u2 在下面的用例里要扮演「普通用户」。
    t.store().users.find(u => u._openid === 'openid_demo_u3').role = 'debugger'
  }

  await mkAdminState()
  t.eq(t.store().users.filter(u => u.role === 'admin').length, 2, '已存在 2 个管理员')
  r = await t.call('initdb', 'openid_demo_u3', 'init', {})
  t.eq(r.code, 0, '★ 已有管理员且调用者是调试员 → init 放行')
  t.isTrue(r.data.firstTime === false, '调试员调用 firstTime=false')

  await mkAdminState()
  r = await t.call('initdb', 'openid_demo_u1', 'init', {})
  t.eq(r.code, 403, '★ 普通管理员不能调危险操作（只有调试员能）')
  t.ok(/无管理员权限/.test(r.msg), '★ 403 文案与 requireAdmin 一致，不透露上层存在', r.msg)

  await mkAdminState()
  r = await t.call('initdb', 'openid_demo_u2', 'clear', {})
  t.eq(r.code, 403, '★ 非管理员 clear → 403')
  t.eq(t.store().skills.length, 12, '被拒绝后数据未被清空')

  await mkAdminState()
  r = await t.call('initdb', 'openid_demo_u2', 'setAdmin', { openid: 'openid_demo_u2' })
  t.eq(r.code, 403, '★ 非管理员调 setAdmin → 403（防提权）')
  t.eq(t.store().users.find(u => u._openid === 'openid_demo_u2').role, 'user', '★ 提权失败：目标用户 role 仍是 user')

  await mkAdminState()
  t.store().users.find(u => u._openid === 'openid_demo_u1').status = 0
  r = await t.call('initdb', 'openid_demo_u1', 'init', {})
  t.eq(r.code, 403, '已封禁的管理员调用 → 403（requireUser 拦下）')
  t.ok(/封禁/.test(r.msg), '403 文案提示封禁', r.msg)

  t.fake.__setOpenId('')
  r = await consoleCall({})
  t.eq(r.code, 0, '★ 已有 admin 时控制台调用 init 依然放行（§4.9 踩坑 3：不能把控制台运维焊死）')

  /* ==================================================================
   * 组 5：clear —— 清空业务集合，保留管理员与 categories/banners/config
   * ================================================================== */
  t.group('组 5 · clear：清空业务数据 + 保留管理员与基础配置（categories/banners/config）')

  blank()
  await consoleCall({})
  t.store().users.find(u => u._openid === 'openid_demo_u1').role = 'admin'
  r = await consoleCall({ action: 'clear' })
  t.eq(r.code, 0, '控制台 clear 成功')
  t.eq(r.data.cleared.length, 11, 'cleared 覆盖 10 个业务集合（含 favorites）+ users')
  t.eq(JSON.stringify(r.data.kept), '["categories","banners","config"]', '★ kept = categories/banners/config')
  t.eq(r.data.keptAdmins, 3, '★ 保留了 3 个管理员')
  t.eq(r.data.firstTime, false, '控制台调用 firstTime=false')

  const after = t.store()
  t.eq(after.users.length, 3, '★ users 只剩管理员（非 admin 全部删除）')
  t.eq(after.users[0]._openid, 'openid_demo_u1', '保留的是管理员本人')
  t.eq(after.skills.length, 0, 'skills 清空')
  t.eq(after.orders.length, 0, 'orders 清空')
  t.eq(after.reviews.length, 0, 'reviews 清空')
  t.eq(after.wallet_logs.length, 0, 'wallet_logs 清空')
  t.eq(after.credit_logs.length, 0, 'credit_logs 清空')
  t.eq(after.notices.length, 0, 'notices 清空')
  t.eq(after.reports.length, 0, 'reports 清空')
  t.eq(after.categories.length, 10, '★ categories 保留 10 条（首页分类不空）')
  t.eq(after.banners.length, 3, '★ banners 保留 3 条（首页轮播不空）')
  t.eq(after.config.length, 1, '★ config 保留（否则首页参数全丢）')

  r = await consoleCall({ action: 'clear' })
  t.eq(r.code, 0, 'clear 可重复调用')
  t.eq(r.data.keptAdmins, 3, '重复 clear 后管理员仍在')
  t.eq(t.store().categories.length, 10, '重复 clear 不会误删分类')

  await mkAdminState()
  r = await t.call('initdb', 'openid_demo_u1', 'clear', {})
  t.eq(r.code, 403, '★ 普通管理员 clear → 403（危险操作只有调试员能调）')

  await mkAdminState()
  r = await t.call('initdb', 'openid_demo_u3', 'clear', {})
  t.eq(r.code, 0, '★ 调试员 clear → 放行')
  t.eq(t.store().users.filter(u => u.role === 'admin').length, 2, 'clear 后管理员被保留')
  t.eq(t.store().users.filter(u => u.role === 'debugger').length, 2, '★ 调试员也被保留（否则没人能再调危险操作）')
  t.eq(t.store().users.length, 4, 'clear 后只剩管理层两人')

  blank()
  r = await t.call('initdb', 'openid_anyone', 'clear', {})
  t.eq(r.code, 0, '★ users 为空时 clear 放行（首次部署无数据可清）')
  t.isTrue(r.data.firstTime === true, 'firstTime=true（首次部署模式）')

  blank()
  await consoleCall({})
  // 同样先降级内部账户，才能走到引导分支
  t.store().users.forEach(u => { if (u.role === 'admin' || u.role === 'debugger') u.role = 'user' })
  r = await t.call('initdb', 'openid_demo_u3', 'clear', {})
  t.eq(r.code, 0, '★ 无管理员时 clear 放行（引导模式）')
  t.isTrue(r.data.firstTime === true, '引导模式 firstTime=true')
  t.eq(t.store().users.length, 0, '引导模式 clear 会清掉全部非管理员用户')

  /* ==================================================================
   * 组 6：setAdmin —— 控制台放行 / 小程序仅限「尚无管理员」
   * ================================================================== */
  t.group('组 6 · setAdmin：控制台放行 + 小程序仅限「尚无管理员」（防提权）')

  blank()
  await consoleCall({})
  r = await consoleCall({ action: 'setAdmin', openid: 'openid_demo_u2' })
  t.eq(r.code, 0, '控制台 setAdmin 成功')
  t.eq(r.data.ok, true, '出参 ok=true')
  t.eq(r.data.openid, 'openid_demo_u2', '出参回显目标 openid')
  t.eq(r.data.nickName, '王雨桐', '出参回显目标昵称')
  t.eq(t.store().users.find(u => u._openid === 'openid_demo_u2').role, 'admin', '★ 目标用户 role 已改为 admin')

  r = await consoleCall({ action: 'setAdmin', openid: 'openid_demo_u3' })
  t.eq(r.code, 0, '★ 控制台不受「仅限第一个管理员」限制（开发者 root 权限）')
  t.eq(t.store().users.filter(u => u.role === 'admin').length, 3, '现在有 3 个管理员（含内部的 1 个）')

  r = await consoleCall({ action: 'setAdmin', studentNo: '2023030145' })
  t.eq(r.code, 0, '★ 支持按 studentNo 授权')
  t.eq(r.data.openid, 'openid_demo_u5', 'studentNo 2023030145 → 赵一鸣')
  t.eq(r.data.nickName, '赵一鸣', '回显昵称')
  t.eq(t.store().users.find(u => u._openid === 'openid_demo_u5').role, 'admin', '按学号授权成功落库')

  r = await consoleCall({ action: 'setAdmin' })
  t.eq(r.code, 400, 'openid 与 studentNo 都不传 → 400')
  t.ok(/请传入/.test(r.msg), '400 文案', r.msg)
  r = await consoleCall({ action: 'setAdmin', openid: 'openid_nobody' })
  t.eq(r.code, 404, 'openid 不存在 → 404')
  r = await consoleCall({ action: 'setAdmin', studentNo: '0000000000' })
  t.eq(r.code, 404, 'studentNo 不存在 → 404')
  t.ok(/用户不存在/.test(r.msg), '404 文案', r.msg)
  r = await consoleCall({ action: 'setAdmin', openid: '   ' })
  t.eq(r.code, 400, 'openid 只有空白 → 400（视为未传）')

  /* 小程序调用：尚无管理员 → 允许（引导第一个管理员） */
  blank()
  await consoleCall({})
  // ★ 内部账户种子里自带一个管理员 —— 要测「尚无管理员」的引导分支，
  //   必须先把它们降级，否则 managerCount > 0，永远走不到引导。
  t.store().users.forEach(u => { if (u.role === 'admin' || u.role === 'debugger') u.role = 'user' })
  t.eq(t.store().users.filter(u => u.role === 'admin').length, 0, '确认系统内没有管理员（已手动降级内部账户）')
  r = await t.call('initdb', 'openid_demo_u1', 'setAdmin', { openid: 'openid_demo_u1' })
  t.eq(r.code, 0, '★ 小程序调用 + 尚无管理员 → 放行（否则永远引导不出第一个管理员）')
  t.eq(t.store().users.find(u => u._openid === 'openid_demo_u1').role, 'admin', '自己成功成为第一个管理员')

  blank()
  await consoleCall({})
  t.store().users.forEach(u => { if (u.role === 'admin' || u.role === 'debugger') u.role = 'user' })
  r = await t.call('initdb', 'openid_demo_u3', 'setAdmin', { openid: 'openid_demo_u3' })
  t.eq(r.code, 0, '★ 引导模式：调用者不必须是管理员，可把任意用户设为管理员')
  t.eq(t.store().users.find(u => u._openid === 'openid_demo_u3').role, 'admin', '目标已提升')

  /* 小程序调用：已有管理员 → 403（防提权，改走 admin.setUserRole） */
  blank()
  await consoleCall({})
  t.store().users.find(u => u._openid === 'openid_demo_u1').role = 'admin'
  r = await t.call('initdb', 'openid_demo_u4', 'setAdmin', { openid: 'openid_demo_u4' })
  t.eq(r.code, 403, '★ 已有管理员 + 小程序调用 → 403（提权口子被封住）')
  t.ok(/已有管理员/.test(r.msg), '403 文案指引改用管理端授权', r.msg)
  t.eq(t.store().users.find(u => u._openid === 'openid_demo_u4').role, 'user', '目标未被提权')
  t.eq(t.store().users.find(u => u._openid === 'openid_demo_u1').role, 'admin', '既有管理员不受影响')

  r = await t.call('initdb', 'openid_demo_u1', 'setAdmin', { openid: 'openid_demo_u4' })
  t.eq(r.code, 403, '★ 连管理员本人调这个引导接口也被拒（已过引导期，必须走 admin.setUserRole）')
  t.eq(t.store().users.find(u => u._openid === 'openid_demo_u4').role, 'user', '目标仍未提权')

  r = await consoleCall({ action: 'setAdmin', openid: 'openid_demo_u4' })
  t.eq(r.code, 0, '★ 同一时刻控制台仍可授权（两条通道的权限模型不同）')
  t.eq(t.store().users.find(u => u._openid === 'openid_demo_u4').role, 'admin', '控制台授权成功')

  /* 封禁用户不能成为管理员 —— 修复后行为 */
  blank()
  await consoleCall({})
  t.store().users.find(u => u._openid === 'openid_demo_u2').status = 0
  r = await consoleCall({ action: 'setAdmin', openid: 'openid_demo_u2' })
  t.eq(r.code, 400, '★ 封禁用户不能设为管理员（修复前这里返回 0）')
  t.eq(r.msg, '该账号已被封禁，不能设为管理员', '文案面向用户、说明原因')
  t.eq(t.store().users.find(u => u._openid === 'openid_demo_u2').role, 'user', '★ 封禁用户的角色未被提升（防提权）')

  /* ==================================================================
   * 组 7：入口协议
   * ================================================================== */
  t.group('组 7 · 入口协议：未知 action → 400')

  blank()
  r = await consoleCall({ action: 'nope' })
  t.eq(r.code, 400, '未知 action → 400')
  t.ok(/未知 action/.test(r.msg), '400 文案', r.msg)
  r = await t.callRaw('initdb', {})
  t.eq(r.code, 400, '缺 action → 400')

  /* ==================================================================
   * 组 8：★ init 修复模式（repair=true）
   * ------------------------------------------------------------------
   * 默认模式「已存在则跳过」保证 init 可断点续跑、不会覆盖线上数据；
   * 但代价是 —— config 被改坏之后，重跑 init **修不好**。
   * repair=true 时改为「已存在则用种子值覆盖」，用于恢复初始状态。
   * ================================================================== */
  t.group('组 8 · ★ init 修复模式：repair=true 时已存在文档被种子值覆盖')

  blank()
  await consoleCall({ action: 'init' })
  // 模拟管理员把配置改坏
  t.store().config[0].registerBonus = 999
  t.store().skills.find(s => s._id === 'demo_skill_01').title = '被改坏的标题'

  // ① 默认模式：只补缺失，不覆盖
  r = await consoleCall({ action: 'init' })
  t.eq(r.data.seeded.config.updated, 0, '默认模式不覆盖已存在的 config（updated=0）')
  t.eq(r.data.seeded.config.skipped, 1, '默认模式跳过已存在的 config（skipped=1）')
  t.eq(t.store().config[0].registerBonus, 999, '★ 默认模式保留被改坏的值 —— 这是「不覆盖线上数据」的代价')

  // ② 修复模式：用种子值覆盖
  r = await consoleCall({ action: 'init', repair: true })
  t.eq(r.data.seeded.config.updated, 1, '★ 修复模式下 config 被更新（updated=1）')
  t.eq(r.data.seeded.config.inserted, 0, '修复模式不新增文档，只有 updated')
  t.eq(t.store().config[0].registerBonus, 5, '★ 被改坏的 registerBonus 恢复为种子值 5')
  t.eq(t.store().config.length, 1, 'config 仍只有 1 条（是 set 覆盖，不是插入第二条）')
  t.eq(t.store().skills.find(s => s._id === 'demo_skill_01').title !== '被改坏的标题', true,
    '★ 演示技能的标题同样被恢复')
  t.eq(t.store().skills.length, 12, '修复模式不会把技能数据翻倍')

  // ③ 开关不能残留到下一次调用
  r = await consoleCall({ action: 'init' })
  t.eq(r.data.seeded.config.updated, 0, '★ 下一次不带 repair 的 init 又回到「只补缺失」（开关不残留）')

  t.log('⚠️ 仍存在的偏差：错误码统一仍在推进中（本文件涉及的 setAdmin / init 已修复；' +
    'skill.myList / skill.remove 的 401、submitCampusAuth 的 409 已在各自用例中覆盖）。')

  /* ==================================================================
   * 组 28 · initdb.setAdmin 是调试员的**引导入口**
   * ------------------------------------------------------------------
   * 「调试员只有调试员能授予」有个先有鸡还是先有蛋的问题：
   * 第一个调试员谁来设？答案是这个无鉴权的运维函数。
   * 这条路径断了，调试员身份就永远无法到达。
   * ================================================================== */
  t.group('组 28 · ★ initdb.setAdmin：调试员的引导入口（bootstrap）')

  t.seed()
  r = await t.call('initdb', '', 'setAdmin', { openid: 'o_buy', role: 'debugger' })
  t.eq(r.code, 0, '★ setAdmin role=debugger 成功（否则调试员身份永远无法到达）')
  t.eq(r.data.role, 'debugger', '出参回传实际设置的角色')
  t.eq(t.user('o_buy').role, 'debugger', '★ 落库为 debugger')

  t.seed()
  r = await t.call('initdb', '', 'setAdmin', { openid: 'o_buy' })
  t.eq(r.code, 0, '不传 role 时默认设为管理员（保持旧行为）')
  t.eq(r.data.role, 'admin', '出参 role=admin')
  t.eq(t.user('o_buy').role, 'admin', '落库为 admin')

  t.seed()
  r = await t.call('initdb', '', 'setAdmin', { openid: 'o_buy', role: '乱写' })
  t.eq(r.data.role, 'admin', '非法 role 归一为 admin（不会写进脏数据）')
  t.eq(t.user('o_buy').role, 'admin', '落库仍是合法值')
}