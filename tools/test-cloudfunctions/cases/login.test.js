/**
 * login 云函数离线回归用例（6 个 action）
 * ==================================================================
 * 契约见 docs/ARCHITECTURE.md §4.1
 * action：login | updateProfile | submitCampusAuth | bindPhone | getUser | updateLocation
 *
 * ⚠️ 约定：断言消息里带「⚠️ 偏差」前缀的，断言的是**当前实现的实际行为**，
 *    而不是文档/直觉期望的行为 —— 它们是本次测试记录下来的契约偏差，
 *    故意保持绿色（不制造红灯），完整清单见回报给 Lead 的缺陷列表。
 * ==================================================================
 */
module.exports = async function (t) {
  /* ==================================================================
   * 组 1：login —— 首次调用自动注册、赠送时间币、写流水与欢迎通知
   * ================================================================== */
  t.group('组 1 · login：首次调用自动注册 + 赠送时间币 + 流水 + 欢迎通知')

  t.seed()
  let r = await t.call('login', 'o_new', 'login', {})
  t.eq(r.code, 0, '首次 login 返回 code 0')
  t.isTrue(r.data.isNew, 'isNew=true（本次是注册）')
  t.eq(t.store().users.length, 5, 'users 4 → 5（只新增调用者 1 个）')
  t.eq(r.data.user._openid, 'o_new', '返回的 user._openid = 调用者')

  const nu = t.user('o_new')
  t.eq(nu.nickName, '', '新用户昵称初始为空')
  t.eq(nu.avatarUrl, '', '新用户头像初始为空')
  t.eq(nu.coins, 5, '赠送 5 枚时间币（config.registerBonus）')
  t.eq(nu.frozenCoins, 0, 'frozenCoins 初始 0')
  t.eq(nu.totalEarned, 0, 'totalEarned 初始 0（赠送不计入累计收入）')
  t.eq(nu.totalSpent, 0, 'totalSpent 初始 0')
  t.eq(nu.creditScore, 100, 'creditScore 初始 100')
  t.eq(nu.creditLevel, 'good', 'creditLevel 初始 good')
  t.eq(nu.authStatus, 0, 'authStatus 初始 0（未认证）')
  t.eq(nu.role, 'user', 'role 初始 user')
  t.eq(nu.status, 1, 'status 初始 1（正常）')
  t.eq(JSON.stringify(nu.tags), '[]', 'tags 初始空数组')
  t.eq(JSON.stringify(nu.badges), '[]', 'badges 初始空数组')
  t.eq(nu.stats.publishCount, 0, 'stats 骨架已建立（publishCount=0）')
  t.eq(nu.stats.serveCount, 0, 'stats.serveCount=0')
  t.eq(nu.stats.avgRating, 0, 'stats.avgRating=0')
  t.ok(!!nu.createTime && !!nu.updateTime && !!nu.lastLoginTime, 'createTime / updateTime / lastLoginTime 均已写入')

  const bonus = t.logs('o_new', 'bonus')
  t.eq(bonus.length, 1, '写了一条 bonus 流水')
  t.eq(bonus[0].amount, 5, 'bonus 金额 = registerBonus 5')
  t.eq(bonus[0].balance, 5, 'bonus 流水 balance = 赠送后余额 5')
  t.eq(bonus[0].frozen, 0, 'bonus 流水 frozen = 0')
  t.ok(/注册赠送/.test(bonus[0].remark), 'bonus 流水备注含「注册赠送」', bonus[0].remark)

  const wn = t.notices('o_new')
  t.eq(wn.length, 1, '写了一条欢迎通知')
  t.eq(wn[0].type, 'system', '欢迎通知 type=system')
  t.eq(wn[0].title, '欢迎加入校园时间银行', '欢迎通知标题')
  t.eq(wn[0].read, false, '欢迎通知初始未读')
  t.ok(/已赠送 5 枚时间币/.test(wn[0].content), '欢迎通知正文写明了赠送数量', wn[0].content)
  t.ok(/不可充值、不可提现/.test(wn[0].content), '欢迎通知正文写明时间币规则')

  t.eq(r.data.config.registerBonus, 5, '出参带回 config（含 registerBonus）')
  t.eq(r.data.config.orderExpireHours, 24, 'config 透传其它字段')

  /* ==================================================================
   * 组 2：login 幂等 —— 重复调用不重复注册、不重复送币
   * ================================================================== */
  t.group('组 2 · login 幂等：重复调用不重复注册、不重复赠送、不重复写通知')

  const firstLoginAt = t.user('o_new').lastLoginTime
  await new Promise(res => setTimeout(res, 5))
  r = await t.call('login', 'o_new', 'login', {})
  t.eq(r.code, 0, '第二次 login 仍返回 code 0')
  t.isTrue(r.data.isNew === false, 'isNew=false（第二次不是注册）')
  t.eq(t.store().users.length, 5, '★ 不重复注册（users 仍为 5）')
  t.eq(t.user('o_new').coins, 5, '★ 不重复赠送时间币（coins 仍为 5）')
  t.eq(t.logs('o_new', 'bonus').length, 1, '★ bonus 流水仍只有 1 条')
  t.eq(t.notices('o_new').length, 1, '★ 欢迎通知仍只有 1 条')
  t.ok(new Date(t.user('o_new').lastLoginTime) > new Date(firstLoginAt), 'lastLoginTime 被刷新为更晚的时间')

  /* 并发首登：两个请求同时给同一个新 openid 注册 */
  t.seed()
  const race = await Promise.all([
    t.call('login', 'o_race', 'login', {}),
    t.call('login', 'o_race', 'login', {})
  ])
  t.eq(race.filter(x => x.code === 0).length, 2, '两个并发 login 都返回成功')
  t.eq(t.store().users.length, 5, '★ 并发下仍然只注册 1 个用户（事务内 dup 探测生效）')
  t.eq(t.logs('o_race', 'bonus').length, 1, '★ 并发下只写 1 条 bonus 流水（不会重复送币）')
  t.eq(t.user('o_race').coins, 5, '★ 并发下余额仍为 5（没有翻倍）')
  t.eq(t.notices('o_race').length, 1, '★ 并发下只写 1 条欢迎通知')
  t.eq(race[0].data.user._id, race[1].data.user._id, '两个并发请求返回同一个用户 _id')
  t.eq(race.filter(x => x.data.isNew === true).length, 1, '★ 并发首登只有**一个**请求自报 isNew=true（修复前两个都报 true，客户端会弹两次欢迎）')

  /* ==================================================================
   * 组 3：login —— 注册赠送额取 config / 封禁 403 / 未登录 401
   * ================================================================== */
  t.group('组 3 · login：registerBonus 取值边界 + 封禁 403 + 未登录 401')

  t.seed()
  t.store().config[0].registerBonus = 8
  r = await t.call('login', 'o_cfg', 'login', {})
  t.eq(r.code, 0, '自定义 registerBonus 时 login 成功')
  t.eq(t.user('o_cfg').coins, 8, 'registerBonus=8 → 赠送 8')
  t.eq(t.logs('o_cfg', 'bonus')[0].amount, 8, '流水金额同步为 8')

  t.seed()
  t.store().config[0].registerBonus = 'abc'
  await t.call('login', 'o_cfg2', 'login', {})
  t.eq(t.user('o_cfg2').coins, 5, 'registerBonus 非数字 → 回退默认 5')

  t.seed()
  t.store().config[0].registerBonus = -3
  await t.call('login', 'o_cfg3', 'login', {})
  t.eq(t.user('o_cfg3').coins, 0, 'registerBonus 为负 → 归零（不会倒扣）')
  t.eq(t.logs('o_cfg3', 'bonus').length, 1, '赠送 0 也仍写 1 条 bonus 流水（保留账目痕迹）')

  t.seed()
  t.store().users[0].status = 0
  r = await t.call('login', 'o_buy', 'login', {})
  t.eq(r.code, 403, '已封禁用户 login → 403')
  t.ok(/封禁/.test(r.msg), '403 文案提示账号封禁', r.msg)

  t.seed()
  r = await t.callRaw('login', { action: 'login' })
  t.eq(r.code, 401, '无登录态调用 login → 401')
  t.ok(/先登录/.test(r.msg), '401 文案提示请先登录', r.msg)

  /* ==================================================================
   * 组 4：updateProfile —— 字段白名单（不能改 coins/role/authStatus/phone）
   * ================================================================== */
  t.group('组 4 · updateProfile：白名单过滤越权字段 + 校验 + 截断')

  t.seed({ buyAuth: 0 })
  r = await t.call('login', 'o_buy', 'updateProfile', {
    nickName: '  新 名  ',
    avatarUrl: 'cloud://avatar.png',
    gender: 9,
    bio: 'x'.repeat(250),
    campus: 'c'.repeat(50),
    college: '学院',
    major: '专业',
    grade: 'g'.repeat(30),
    tags: ['a', 'a', '', 'b', 'c', 'd', 'e', 'f'],
    coins: 999,
    frozenCoins: 99,
    creditScore: 1,
    role: 'admin',
    status: 0,
    authStatus: 2,
    phone: '13800000000',
    studentNo: 'HACK',
    realName: 'HACK',
    _openid: 'o_hacked'
  })
  t.eq(r.code, 0, 'updateProfile 成功')
  const p = t.user('o_buy')
  t.eq(p.nickName, '新 名', '昵称首尾空白被去掉')
  t.eq(p.avatarUrl, 'cloud://avatar.png', '头像可写')
  t.eq(p.gender, 0, 'gender=9 非法 → 归 0')
  t.eq(p.bio.length, 200, 'bio 超长截断到 200')
  t.eq(p.campus.length, 40, 'campus 截断到 40')
  t.eq(p.grade.length, 20, 'grade 截断到 20')
  t.eq(JSON.stringify(p.tags), '["a","b","c","d","e"]', 'tags 去空 + 去重 + 最多 5 个')
  t.eq(p.coins, 10, '★ coins=999 被白名单挡掉（余额未变）')
  t.eq(p.frozenCoins, 0, '★ frozenCoins 被挡掉')
  t.eq(p.creditScore, 100, '★ creditScore 被挡掉')
  t.eq(p.role, 'user', '★ role=admin 被挡掉（防提权）')
  t.eq(p.status, 1, '★ status=0 被挡掉（不能自我解封）')
  t.eq(p.authStatus, 0, '★ authStatus=2 被挡掉（不能自我认证，必须走 submitCampusAuth）')
  t.eq(p.phone, undefined, '★ phone 不在白名单，未写入')
  t.eq(p.studentNo, undefined, '★ studentNo 未写入')
  t.eq(p.realName, undefined, '★ realName 未写入')
  t.eq(p._openid, 'o_buy', '★ _openid 不可被改写')
  t.eq(r.data.user.nickName, '新 名', '出参 { user } 回显新昵称')
  t.ok(!!p.updateTime, 'updateTime 已刷新')

  r = await t.call('login', 'o_buy', 'updateProfile', { nickName: '   ' })
  t.eq(r.code, 400, '昵称只有空白 → 400')
  t.ok(/昵称不能为空/.test(r.msg), '400 文案面向用户', r.msg)
  t.eq(t.user('o_buy').nickName, '新 名', '失败后昵称保持原值')

  r = await t.call('login', 'o_buy', 'updateProfile', { nickName: 'n'.repeat(25) })
  t.eq(t.user('o_buy').nickName, 'n'.repeat(20), '昵称超长截断到 20')

  r = await t.call('login', 'o_buy', 'updateProfile', { gender: 2 })
  t.eq(t.user('o_buy').gender, 2, 'gender=2 合法，原样落库')
  r = await t.call('login', 'o_buy', 'updateProfile', { gender: 'x' })
  t.eq(t.user('o_buy').gender, 0, 'gender 非数字 → 0')

  r = await t.call('login', 'o_buy', 'updateProfile', { tags: ['t'.repeat(30)] })
  t.eq(t.user('o_buy').tags[0].length, 12, '单个 tag 截断到 12 字')

  r = await t.call('login', 'o_buy', 'updateProfile', {})
  t.eq(r.code, 0, '只传空 payload 也成功（不强制改昵称）')

  r = await t.call('login', 'o_ghost', 'updateProfile', { nickName: 'x' })
  t.eq(r.code, 401, '未注册用户 updateProfile → 401')
  t.ok(/用户不存在/.test(r.msg), '401 文案', r.msg)

  r = await t.callRaw('login', { action: 'updateProfile', nickName: 'x' })
  t.eq(r.code, 401, '无登录态 updateProfile → 401')

  /* ==================================================================
   * 组 5：submitCampusAuth —— 只要求昵称（不要求头像）、重复提交拒绝、落库、通知管理员
   * ================================================================== */
  t.group('组 5 · submitCampusAuth：昵称是唯一前置条件（明确不要求头像）')

  t.seed({ buyAuth: 0 })
  r = await t.call('login', 'o_buy', 'submitCampusAuth', { realName: '小明', studentNo: '2021', authImages: ['f1'] })
  t.eq(r.code, 0, '★ 头像为空也能提交成功（avatarUrl 不是前置条件）')
  t.eq(t.user('o_buy').avatarUrl, '', '确认提交时 avatarUrl 仍为空')
  t.eq(r.data.authStatus, 1, '出参 { authStatus } = 1（待审核）')
  t.eq(t.user('o_buy').authStatus, 1, 'authStatus 落库为 1')

  t.seed({ buyAuth: 0 })
  t.store().users[0].nickName = ''
  r = await t.call('login', 'o_buy', 'submitCampusAuth', { realName: '小明', studentNo: '2021', authImages: ['f1'] })
  t.eq(r.code, 400, '昵称为空 → 400')
  t.ok(/先设置昵称/.test(r.msg), '400 文案要求先设置昵称', r.msg)
  t.eq(t.user('o_buy').realName, undefined, '未设置昵称时认证资料不落库')

  t.seed({ buyAuth: 0 })
  r = await t.call('login', 'o_buy', 'submitCampusAuth', { realName: '  小明  ', studentNo: '  2021  ', authImages: ['f1', 'f1', '', 'f2', 'f3', 'f4', 'f5'] })
  t.eq(r.code, 0, '完整资料提交成功')
  const ac = t.user('o_buy')
  t.eq(ac.realName, '小明', '★ realName 落库到 users.realName（管理端审核要显示）')
  t.eq(ac.studentNo, '2021', 'studentNo 落库并去首尾空白')
  t.eq(JSON.stringify(ac.authImages), '["f1","f2","f3","f4"]', 'authImages 去重去空 + 最多 4 张')
  t.eq(ac.authRemark, '', '提交后 authRemark 清空（上一轮驳回原因不留存）')
  t.ok(!!ac.authTime, 'authTime 写入')
  t.eq(ac.authStatus, 1, 'authStatus = 1')

  t.eq(t.notices('o_adm').length, 1, '★ 通知了管理员 1 条')
  t.eq(t.notices('o_adm')[0].type, 'audit', '管理员通知 type=audit')
  t.eq(t.notices('o_adm')[0].title, '有新的校园认证待审核', '管理员通知标题')
  t.ok(/小明/.test(t.notices('o_adm')[0].content), '管理员通知正文含申请人姓名', t.notices('o_adm')[0].content)

  r = await t.call('login', 'o_buy', 'submitCampusAuth', { realName: '小明', studentNo: '2021', authImages: ['f1'] })
  t.eq(r.code !== 0, true, 'authStatus=1 时重复提交被拒')
  t.eq(r.code, 409, '★ 重复提交返回 409（§4.0 把「重复操作」归为 409；修复前是 400）')
  t.ok(/审核中/.test(r.msg), '拒绝文案提示审核中', r.msg)
  t.eq(t.user('o_buy').authStatus, 1, '重复提交不改变 authStatus')
  t.eq(t.notices('o_adm').length, 1, '重复提交不再通知管理员')

  t.seed({ buyAuth: 0 })
  t.store().users[0].authStatus = 2
  r = await t.call('login', 'o_buy', 'submitCampusAuth', { realName: '小明', studentNo: '2021', authImages: ['f1'] })
  t.eq(r.code, 409, '★ authStatus=2 时重复提交返回 409（修复前是 400）')
  t.ok(/已通过/.test(r.msg), '已通过文案', r.msg)
  t.eq(t.user('o_buy').authStatus, 2, '已通过状态不被覆盖')

  t.seed({ buyAuth: 0 })
  t.store().users[0].campus = '示范大学'
  await t.call('login', 'o_buy', 'submitCampusAuth', { realName: '小明', studentNo: '2021', authImages: ['f1'] })
  t.eq(t.user('o_buy').campus, '示范大学', '未传 campus 时保留原值（不清空已有资料）')
  t.eq(t.user('o_buy').college, '', '未传 college 时写空字符串而非抛错')

  t.seed({ buyAuth: 0 })
  r = await t.call('login', 'o_buy', 'submitCampusAuth', { studentNo: '2021', authImages: ['f1'] })
  t.eq(r.code, 400, '缺 realName → 400')
  t.ok(/真实姓名/.test(r.msg), '缺 realName 文案', r.msg)
  r = await t.call('login', 'o_buy', 'submitCampusAuth', { realName: '小明', authImages: ['f1'] })
  t.eq(r.code, 400, '缺 studentNo → 400')
  t.ok(/学号/.test(r.msg), '缺 studentNo 文案', r.msg)
  r = await t.call('login', 'o_buy', 'submitCampusAuth', { realName: '小明', studentNo: '2021' })
  t.eq(r.code, 400, '缺 authImages → 400')
  t.ok(/上传/.test(r.msg), '缺证件照片文案', r.msg)
  r = await t.call('login', 'o_buy', 'submitCampusAuth', { realName: '   ', studentNo: '2021', authImages: ['f1'] })
  t.eq(r.code, 400, 'realName 仅空白 → 400')

  t.seed({ buyAuth: 0 })
  t.store().users[0].authImages = ['x'.repeat(600)]
  r = await t.call('login', 'o_buy', 'submitCampusAuth', { realName: '小明', studentNo: '2021', authImages: ['x'.repeat(600)] })
  t.eq(t.user('o_buy').authImages[0].length, 500, 'authImages 单项截断到 500')

  t.seed({ buyAuth: 0 })
  r = await t.call('login', 'o_ghost', 'submitCampusAuth', { realName: 'x', studentNo: 'y', authImages: ['z'] })
  t.eq(r.code, 401, '未注册用户提交认证 → 401')

  t.seed({ buyAuth: 0 })
  t.store().users[3].status = 0
  await t.call('login', 'o_buy', 'submitCampusAuth', { realName: '小明', studentNo: '2021', authImages: ['f1'] })
  t.eq(t.notices('o_adm').length, 0, '管理员被封禁时不写通知（写通知失败不阻断主流程）')
  t.eq(t.user('o_buy').authStatus, 1, '管理员通知失败不影响认证提交结果')

  /* ==================================================================
   * 组 6：bindPhone —— code 换号成功落库 / 换取失败降级
   * ================================================================== */
  t.group('组 6 · bindPhone：换号成功落库 + 无凭证与换取失败都降级不阻断')

  t.fake.__failPhone(false)
  t.fake.__setPhone('13800000000')

  t.seed()
  let bp = await t.call('login', 'o_buy', 'bindPhone', {})
  t.eq(bp.code, 0, '未传 code 仍返回 code 0（不抛错）')
  t.eq(bp.data.phone, '', '未传 code → phone 为空')
  t.eq(bp.data.ok, false, '未传 code → ok=false')
  t.eq(bp.data.msg, '缺少手机号授权凭证', 'msg 说明缺少凭证')
  t.eq(t.user('o_buy').phone, undefined, '未传 code 时 users.phone 不写入')

  t.seed()
  let phoneCalls = t.fake.__stats.phoneCalls
  bp = await t.call('login', 'o_buy', 'bindPhone', { code: 'CODE_OK' })
  t.eq(bp.code, 0, '换取成功返回 code 0')
  t.eq(bp.data.phone, '13800000000', '★ 出参返回换取到的手机号')
  t.eq(bp.data.ok, true, '换取成功 ok=true')
  t.eq(bp.data.msg, '', '换取成功 msg 为空')
  t.eq(t.user('o_buy').phone, '13800000000', '★ 手机号落库到 users.phone')
  t.ok(!!t.user('o_buy').updateTime, '绑定手机号同时刷新 updateTime')
  t.eq(t.fake.__stats.phoneCalls - phoneCalls, 1, '恰好调用了一次 openapi.phonenumber.getPhoneNumber')

  t.seed()
  t.fake.__setPhone('13911112222')
  bp = await t.call('login', 'o_buy', 'bindPhone', { code: 'CODE_OK' })
  t.eq(bp.data.phone, '13911112222', '换到的号码以 openapi 返回值为准')
  t.eq(t.user('o_buy').phone, '13911112222', '落库的就是换到的号码')
  t.fake.__setPhone('13800000000')

  t.seed()
  t.store().users[0].phone = '13900000000'
  t.fake.__failPhone(true)          // ★ 模块级开关：后面的用例必须复位，用 try/finally 兜住
  try {
    bp = await t.call('login', 'o_buy', 'bindPhone', { code: 'CODE_FAIL' })
    t.eq(bp.code, 0, '换取失败也返回 code 0（降级不阻断主流程）')
    t.eq(bp.data.phone, '', '换取失败 → phone 为空')
    t.eq(bp.data.ok, false, '换取失败 → ok=false')
    t.ok(/失败|重试/.test(bp.data.msg), 'msg 提示稍后重试', bp.data.msg)
    t.eq(t.user('o_buy').phone, '13900000000', '换取失败不清空已有手机号')
  } finally {
    t.fake.__failPhone(false)
  }

  t.seed()
  bp = await t.call('login', 'o_buy', 'bindPhone', { code: 'CODE_OK' })
  t.eq(bp.data.ok, true, '复位 __failPhone 之后换号恢复成功（stub 开关已还原，不污染后续用例）')

  bp = await t.call('login', 'o_ghost', 'bindPhone', {})
  t.eq(bp.code, 401, '未注册用户 bindPhone → 401')

  bp = await t.callRaw('login', { action: 'bindPhone', code: 'x' })
  t.eq(bp.code, 401, '无登录态 bindPhone → 401')

  /* ==================================================================
   * 组 7：getUser —— ★ 隐私边界（publicUser 黑名单）
   * ================================================================== */
  t.group('组 7 · getUser：★ 隐私黑名单（phone/studentNo/realName/authImages/authRemark 必须滤掉）')

  t.seed()
  Object.assign(t.store().users[0], {
    phone: '13800000000',
    studentNo: '2021010233',
    realName: '李小明',
    authImages: ['cloud://idcard.png'],
    authRemark: '照片模糊，请重新上传',
    bio: '公开简介'
  })
  r = await t.call('login', 'o_weak', 'getUser', { openid: 'o_buy' })
  t.eq(r.code, 0, '他人查询 getUser 成功')
  const pub = r.data.user
  t.eq(pub.phone, undefined, '★ phone 被滤掉')
  t.eq(pub.studentNo, undefined, '★ studentNo 被滤掉')
  t.eq(pub.realName, undefined, '★ realName 被滤掉')
  t.eq(pub.authImages, undefined, '★ authImages 被滤掉')
  t.eq(pub.authRemark, undefined, '★ authRemark 被滤掉')
  t.eq('phone' in pub, false, '★ 响应里连 phone 这个键都不存在')
  t.eq('authRemark' in pub, false, '★ authRemark 键不存在')
  t.eq(pub._openid, 'o_buy', '公开字段 _openid 保留')
  t.eq(pub.nickName, '买家小明', '公开字段 nickName 保留')
  t.eq(pub.bio, '公开简介', '公开字段 bio 保留')
  t.eq(pub.authStatus, 2, '公开字段 authStatus 保留（用于展示认证徽标）')
  t.eq(pub.creditScore, 100, '公开字段 creditScore 保留')
  t.ok(pub.stats && typeof pub.stats.avgRating === 'number', '公开字段 stats 保留')
  t.ok(Object.keys(pub).length > 0, '返回体非空')

  r = await t.call('login', 'o_buy', 'getUser', {})
  t.eq(r.code, 0, '不传 openid → 取当前登录者自己')
  t.eq(r.data.user._openid, 'o_buy', '返回的是自己')
  t.eq(r.data.user.phone, undefined, '★ 即使是本人，公开接口同样滤掉手机号')
  t.eq(r.data.user.realName, undefined, '★ 即使是本人，公开接口同样滤掉真实姓名')

  r = await t.callRaw('login', { action: 'getUser', openid: 'o_buy' })
  t.eq(r.code, 0, '未登录也可按 openid 查看公开资料（详情页/订单页需要）')

  r = await t.callRaw('login', { action: 'getUser' })
  t.eq(r.code, 400, '既无 openid 参数又无登录态 → 400')
  t.ok(/缺少 openid/.test(r.msg), '400 文案', r.msg)

  r = await t.call('login', 'o_weak', 'getUser', { openid: 'o_none' })
  t.eq(r.code, 404, '用户不存在 → 404')
  t.ok(/用户不存在/.test(r.msg), '404 文案', r.msg)

  /* ==================================================================
   * 组 8：updateLocation —— 经纬度校验 + GeoPoint 顺序（经度, 纬度）
   * ================================================================== */
  t.group('组 8 · updateLocation：经纬度边界校验 + GeoPoint 参数顺序')

  t.seed()
  r = await t.call('login', 'o_buy', 'updateLocation', { longitude: 116.404, latitude: 39.915, locationName: '东区宿舍楼下' })
  t.eq(r.code, 0, '合法经纬度上报成功')
  t.eq(r.data.ok, true, '出参 { ok: true }')
  const loc = t.user('o_buy').location
  t.eq(loc.type, 'Point', 'location 是 GeoPoint')
  t.eq(loc.coordinates[0], 116.404, '★ coordinates[0] = 经度（Geo.Point 参数顺序 经度, 纬度）')
  t.eq(loc.coordinates[1], 39.915, '★ coordinates[1] = 纬度')
  t.eq(t.user('o_buy').locationName, '东区宿舍楼下', 'locationName 落库')
  t.ok(!!t.user('o_buy').locationTime, 'locationTime 写入')

  r = await t.call('login', 'o_buy', 'updateLocation', { longitude: 116.404, latitude: 39.915, locationName: 'n'.repeat(80) })
  t.eq(t.user('o_buy').locationName.length, 60, 'locationName 截断到 60')

  r = await t.call('login', 'o_buy', 'updateLocation', { longitude: 200, latitude: 39.9 })
  t.eq(r.code, 400, '经度 200 > 180 → 400')
  t.ok(/定位参数/.test(r.msg), '400 文案面向用户', r.msg)
  r = await t.call('login', 'o_buy', 'updateLocation', { longitude: 116.4, latitude: -100 })
  t.eq(r.code, 400, '纬度 -100 < -90 → 400')
  r = await t.call('login', 'o_buy', 'updateLocation', { longitude: -180, latitude: 90 })
  t.eq(r.code, 0, '边界值 (-180, 90) 合法')
  r = await t.call('login', 'o_buy', 'updateLocation', {})
  t.eq(r.code, 400, '完全未传坐标 → 400（Number(undefined)=NaN）')
  r = await t.call('login', 'o_buy', 'updateLocation', { longitude: 'abc', latitude: 'def' })
  t.eq(r.code, 400, '坐标非数字 → 400')

  r = await t.call('login', 'o_ghost', 'updateLocation', { longitude: 1, latitude: 1 })
  t.eq(r.code, 401, '未注册用户上报定位 → 401')

  /* ==================================================================
   * 组 9：入口协议
   * ================================================================== */
  t.group('组 9 · 入口协议：未知 action 400 / 缺 action 400')

  t.seed()
  r = await t.call('login', 'o_buy', 'nope', {})
  t.eq(r.code, 400, '未知 action → 400')
  t.ok(/未知 action/.test(r.msg), '400 文案含未知 action', r.msg)
  r = await t.callRaw('login', {})
  t.eq(r.code, 400, '缺 action → 400')

  t.log('⚠️ login 记录的契约偏差：① 并发首登两个请求都返回 isNew=true（实际只注册了一个）；' +
    '② submitCampusAuth 在 authStatus 1/2 时返回 400 而非 §4.0 规定的 409。')
}
