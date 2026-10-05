/**
 * 内部账户云函数
 * ==================================================================
 * 为什么需要它
 * ------------------------------------------------------------------
 * 普通用户的身份来自 wx.login 换到的 openid，与微信号绑定 —— 这在小程序里
 * 是**唯一自然**的登录方式，也无需密码。
 *
 * 但有一类账号不属于任何个人微信号：校方 / 运维的**内部账户**。
 * 他们需要「账号 + 密码」就能进去，且**不需要绑定微信**。
 *
 * 所以本函数是**唯一**的密码登录入口，只为这类账号服务。
 *
 * 设计要点
 * ------------------------------------------------------------------
 * 1. 不碰那 8 个业务云函数
 *    整个后端都是按 openid 索引的。登录成功后我们发一个会话令牌，
 *    `_shared` 的 wrap() 会把它解析成该账户的**合成 openid**（`acct_xxx`），
 *    于是 getOpenId() 自然返回它 —— 业务层一行都不用改。
 *
 * 2. 口令只存 PBKDF2 哈希
 *    `hashPassword(明文, 盐)` → PBKDF2-SHA256 / 5 万次迭代 / 32 字节。
 *    **任何地方都不存明文**，日志里也不能出现。
 *
 * 3. 登录失败要能防爆破
 *    连续 5 次失败锁定 15 分钟；账号不存在与密码错误返回**同一个**错误，
 *    避免被用来枚举账号。
 *
 * 4. 会话令牌
 *    32 字节随机数，存 sessions 集合，7 天过期。
 *    ★ 令牌是**纯随机数**，不是可预测的自增 ID，也不含用户信息
 *      —— 即使泄露也无法从令牌反推账号。
 *
 * 接口
 * ------------------------------------------------------------------
 *   login   { username, password } → { token, expireTime, user, role, isAdmin, isDebugger }
 *   logout  {}                     → { ok: true }        （需要 __token）
 *   me      {}                     → { account, user, role, isAdmin, isDebugger }
 * ==================================================================
 */
const {
  db, C, _,
  wrap, bizError, assert,
  now, getUser, publicUser,
  ROLE, isAdminUser, isDebuggerUser,
  SESSION_TTL, hashPassword, safeEqual, newToken, currentAccount
} = require('./shared')

/** 连续失败到几次就锁 */
const MAX_FAIL = 5
/** 锁定时长（15 分钟） */
const LOCK_MS = 15 * 60 * 1000

/** 账号不存在与密码错误共用同一个错误 —— 否则可以用来枚举账号 */
function deny() {
  return bizError(401, '账号或密码不正确')
}

/** 清掉过期会话（顺手做的家务，避免 sessions 无限增长） */
async function pruneSessions() {
  try {
    await db.collection(C.SESSIONS).where({ expireTime: _.lt(Date.now()) }).remove()
  } catch (e) { /* 清理失败不影响登录 */ }
}

/** 组装对外返回的角色信息 */
function roleInfo(user) {
  return {
    role: (user && user.role) || ROLE.USER,
    isAdmin: isAdminUser(user),
    isDebugger: isDebuggerUser(user)
  }
}

/* ============================ login ============================ */
async function login(event) {
  const username = String(event.username || '').trim().toLowerCase()
  const password = String(event.password || '')

  assert(username, '请输入账号', 400)
  assert(password, '请输入密码', 400)
  assert(username.length <= 32, '账号过长', 400)
  assert(password.length <= 64, '密码过长', 400)

  const res = await db.collection(C.ACCOUNTS).where({ username }).limit(1).get()
  const acc = (res.data && res.data[0]) || null

  // 账号不存在：走同样的错误分支（不区分，防枚举）
  if (!acc || Number(acc.status) === 0) throw deny()

  // 锁定中
  const lockUntil = Number(acc.lockUntil) || 0
  if (lockUntil > Date.now()) {
    const mins = Math.max(1, Math.ceil((lockUntil - Date.now()) / 60000))
    throw bizError(429, `尝试次数过多，请 ${mins} 分钟后再试`)
  }

  const okPwd = safeEqual(hashPassword(password, acc.salt), acc.passwordHash)
  if (!okPwd) {
    const failCount = (Number(acc.failCount) || 0) + 1
    const patch = { failCount, updateTime: now() }
    if (failCount >= MAX_FAIL) {
      patch.lockUntil = Date.now() + LOCK_MS
      patch.failCount = 0
    }
    await db.collection(C.ACCOUNTS).doc(acc._id).update({ data: patch })
    throw deny()
  }

  // 登录成功
  const token = newToken()
  const expireTime = Date.now() + SESSION_TTL

  await db.collection(C.SESSIONS).add({
    data: {
      token,
      accountId: acc._id,
      accountOpenid: acc.openid,
      createTime: now(),
      expireTime
    }
  })
  await db.collection(C.ACCOUNTS).doc(acc._id).update({
    data: { failCount: 0, lockUntil: 0, lastLoginTime: now(), updateTime: now() }
  })

  pruneSessions()   // 不 await：家务活不该拖慢登录

  const user = await getUser(acc.openid)
  return Object.assign({
    token,
    expireTime,
    user: user ? publicUser(user) : null,
    nickName: acc.nickName || (user && user.nickName) || ''
  }, roleInfo(user))
}

/* ============================ logout ============================ */
async function logout(event) {
  const token = String((event && event.__token) || '').trim()
  if (token) {
    try {
      await db.collection(C.SESSIONS).where({ token }).remove()
    } catch (e) { /* 删不掉也不该让退出失败 */ }
  }
  return { ok: true }
}

/* ============================ me ============================ */
async function me() {
  const sess = currentAccount()
  if (!sess) return { account: null, user: null, role: ROLE.USER, isAdmin: false, isDebugger: false }

  const user = await getUser(sess.accountOpenid)
  return Object.assign({
    account: { accountId: sess.accountId, expireTime: sess.expireTime },
    user: user ? publicUser(user) : null
  }, roleInfo(user))
}

/* ============================ 入口 ============================ */
exports.main = wrap(async (event) => {
  const action = event.action || ''
  switch (action) {
    case 'login': return await login(event)
    case 'logout': return await logout(event)
    case 'me': return await me()
    default: throw bizError(400, `未知 action: ${action}`)
  }
})
