/**
 * 内部账户（account 云函数）
 * ==================================================================
 * 这是**唯一**的密码登录入口，只为「不属于任何个人微信号」的内部账户服务。
 *
 * 覆盖要点：
 *  · 登录成功 / 失败，且失败不区分「账号不存在」与「密码错误」（防枚举）
 *  · 连续失败锁定（防爆破）
 *  · ★ 核心：带令牌调用**其它**云函数时，身份被替换为该账户的合成 openid
 *  · ★ 伪造 / 过期令牌**不会**提升权限，只是回退微信身份
 *  · logout 让令牌立刻失效
 * ==================================================================
 */
module.exports = async function (t) {
  const A = (openid, payload) => t.call('account', openid, 'login', payload)

  /** 种一份干净数据，并造一个可用的内部账户 */
  async function seedAccount(username, password, openid, role) {
    t.seed()
    t.store().accounts = []
    t.store().sessions = []
    const salt = t.shared.newSalt()
    t.store().accounts.push({
      _id: 'acc_' + username,
      username,
      salt,
      passwordHash: t.shared.hashPassword(password, salt),
      openid,
      nickName: '内部' + username,
      status: 1,
      failCount: 0,
      lockUntil: 0,
      createTime: Date.now(),
      lastLoginTime: 0
    })
    t.store().users.push({
      _id: 'u_' + username, _openid: openid, nickName: '内部' + username,
      coins: 10, frozenCoins: 0, creditScore: 100, creditLevel: 'good',
      authStatus: 2, status: 1, role,
      badges: [], stats: {}, createTime: Date.now(), updateTime: Date.now()
    })
  }

  /* ==================================================================
   * 组 1 · 登录：成功与失败
   * ================================================================== */
  t.group('组 1 · account.login：账号密码登录（内部账户不绑定微信号）')

  await seedAccount('admin', 'test-only-pass-A', 'acct_internal_admin', 'admin')

  let r = await A('o_buy', { username: 'admin', password: 'test-only-pass-A' })
  t.eq(r.code, 0, '★ 账号密码正确 → 登录成功')
  t.ok(typeof r.data.token === 'string' && r.data.token.length === 64, '★ 发下 64 位十六进制令牌（32 字节随机数）')
  t.ok(r.data.expireTime > Date.now(), '令牌有有效期')
  t.eq(r.data.role, 'admin', '★ 返回该账户的角色')
  t.eq(r.data.user._openid, 'acct_internal_admin', '★ 返回的身份是**合成 openid**，不是微信号')
  t.eq(t.store().sessions.length, 1, '建立 1 条会话')

  r = await A('o_buy', { username: 'ADMIN', password: 'test-only-pass-A' })
  t.eq(r.code, 0, '账号大小写不敏感（统一转小写）')

  r = await A('o_buy', { username: 'admin', password: '错的密码' })
  t.eq(r.code, 401, '密码错误 → 401')

  r = await A('o_buy', { username: '不存在的账号', password: 'whatever' })
  t.eq(r.code, 401, '★ 账号不存在 → **同样是 401**')
  t.eq(r.msg, '账号或密码不正确', '★ 文案完全相同 —— 否则可用来枚举账号')

  r = await A('o_buy', { username: '', password: 'x' })
  t.eq(r.code, 400, '账号为空 → 400')
  r = await A('o_buy', { username: 'admin', password: '' })
  t.eq(r.code, 400, '密码为空 → 400')

  /* ==================================================================
   * 组 2 · 防爆破：连续失败锁定
   * ================================================================== */
  t.group('组 2 · 防爆破：连续 5 次失败锁定 15 分钟')

  await seedAccount('admin', 'test-only-pass-A', 'acct_internal_admin', 'admin')

  for (let i = 0; i < 4; i++) {
    r = await A('o_buy', { username: 'admin', password: 'x' })
    t.eq(r.code, 401, '第 ' + (i + 1) + ' 次失败仍是 401（还没到阈值）')
  }
  t.eq(t.store().accounts[0].failCount, 4, '失败次数累加')

  r = await A('o_buy', { username: 'admin', password: 'x' })
  t.eq(r.code, 401, '第 5 次失败返回 401')
  t.eq(t.store().accounts[0].failCount, 0, '★ 达到阈值后计数清零并进入锁定')
  t.ok(t.store().accounts[0].lockUntil > Date.now(), '★ 已写入锁定截止时间')

  r = await A('o_buy', { username: 'admin', password: 'test-only-pass-A' })
  t.eq(r.code, 429, '★★ 锁定期间**即使密码正确**也拒绝（否则锁定形同虚设）')
  t.ok(/尝试次数过多/.test(r.msg), '429 文案提示稍后再试', r.msg)

  t.store().accounts[0].lockUntil = 0
  r = await A('o_buy', { username: 'admin', password: 'test-only-pass-A' })
  t.eq(r.code, 0, '锁定解除后可正常登录')

  r = await A('o_buy', { username: 'admin', password: 'test-only-pass-A' })
  t.eq(t.store().accounts[0].failCount, 0, '登录成功后失败计数保持 0')

  /* ==================================================================
   * 组 3 · ★ 核心：带令牌调用其它云函数，身份被替换
   * ================================================================== */
  t.group('组 3 · ★ 令牌身份替换：带令牌调用其它云函数时以该账户身份操作')

  await seedAccount('debugger', 'test-only-pass-D', 'acct_internal_debugger', 'debugger')
  r = await A('o_buy', { username: 'debugger', password: 'test-only-pass-D' })
  t.eq(r.code, 0, '内部调试员登录成功')
  const token = r.data.token

  // 不带令牌 → 微信身份（o_buy）
  let me = await t.call('login', 'o_buy', 'login', {})
  t.eq(me.data.user._openid, 'o_buy', '不带令牌 → 回退微信身份')

  // 带令牌 → 合成 openid（身份被替换）
  me = await t.call('login', 'o_buy', 'login', { __token: token })
  t.eq(me.data.user._openid, 'acct_internal_debugger', '★★ 带令牌 → 身份被替换为该账户')
  t.eq(me.data.user.role, 'debugger', '★★ 角色随之变成调试员')

  // 管理员权限也随令牌走
  let ck = await t.call('admin', 'o_buy', 'check', {})
  t.eq(ck.data.isAdmin, false, '不带令牌：普通用户不是管理员')
  ck = await t.call('admin', 'o_buy', 'check', { __token: token })
  t.eq(ck.data.isAdmin, true, '★★ 带令牌：以调试员身份 → 是管理员')
  t.eq(ck.data.isDebugger, true, '★★ 带令牌：isDebugger=true')

  /* ==================================================================
   * 组 4 · ★ 伪造 / 过期令牌不会提升权限
   * ================================================================== */
  t.group('组 4 · ★ 伪造 / 过期令牌只回退微信身份，不提升权限')

  await seedAccount('debugger', 'test-only-pass-D', 'acct_internal_debugger', 'debugger')
  r = await A('o_buy', { username: 'debugger', password: 'test-only-pass-D' })
  const good = r.data.token

  me = await t.call('login', 'o_buy', 'login', { __token: 'f'.repeat(64) })
  t.eq(me.data.user._openid, 'o_buy', '★ 伪造令牌 → 回退微信身份（不报错、不提升）')
  ck = await t.call('admin', 'o_buy', 'check', { __token: 'f'.repeat(64) })
  t.eq(ck.data.isAdmin, false, '★★ 伪造令牌拿不到管理员权限')

  t.store().sessions[0].expireTime = Date.now() - 1000
  me = await t.call('login', 'o_buy', 'login', { __token: good })
  t.eq(me.data.user._openid, 'o_buy', '★ 过期令牌 → 回退微信身份')

  t.store().sessions[0].expireTime = Date.now() + 100000
  me = await t.call('login', 'o_buy', 'login', { __token: good })
  t.eq(me.data.user._openid, 'acct_internal_debugger', '未过期令牌仍然有效')

  me = await t.call('login', 'o_buy', 'login', { __token: '短' })
  t.eq(me.data.user._openid, 'o_buy', '长度异常的令牌直接忽略（不做无谓查询）')

  /* ==================================================================
   * 组 5 · logout / me
   * ================================================================== */
  t.group('组 5 · account.logout / me')

  await seedAccount('admin', 'test-only-pass-A', 'acct_internal_admin', 'admin')
  r = await A('o_buy', { username: 'admin', password: 'test-only-pass-A' })
  const tk2 = r.data.token

  let who = await t.call('account', 'o_buy', 'me', { __token: tk2 })
  t.eq(who.code, 0, 'me 正常返回')
  t.ok(who.data.account, '带令牌时 me 返回 account')
  t.eq(who.data.user._openid, 'acct_internal_admin', 'me 返回当前账户身份')
  t.eq(who.data.role, 'admin', 'me 返回角色')

  who = await t.call('account', 'o_buy', 'me', {})
  t.eq(who.code, 0, '不带令牌 me 也不报错')
  t.eq(who.data.account, null, '不带令牌 account 为 null')
  t.eq(who.data.role, 'user', '不带令牌 role 兜底 user')

  r = await t.call('account', 'o_buy', 'logout', { __token: tk2 })
  t.eq(r.code, 0, 'logout 成功')
  t.eq(t.store().sessions.length, 0, '★ logout 删除会话')

  me = await t.call('login', 'o_buy', 'login', { __token: tk2 })
  t.eq(me.data.user._openid, 'o_buy', '★★ 退出后原令牌立即失效（回退微信身份）')

  r = await t.call('account', 'o_buy', 'nope', {})
  t.eq(r.code, 400, '未知 action → 400')

  /* ==================================================================
   * 组 6 · 账号被禁用
   * ================================================================== */
  t.group('组 6 · 被禁用的内部账户不能登录')

  await seedAccount('admin', 'test-only-pass-A', 'acct_internal_admin', 'admin')
  t.store().accounts[0].status = 0
  r = await A('o_buy', { username: 'admin', password: 'test-only-pass-A' })
  t.eq(r.code, 401, '★ 已禁用账号 → 401（与密码错误同文案，不透露账号存在）')
  t.eq(t.store().sessions.length, 0, '被拒后没有建立会话')
}
