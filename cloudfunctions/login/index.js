/**
 * login —— 登录 / 资料 / 校园认证（ARCHITECTURE.md §4.1）
 * ==================================================================
 * action：login | updateProfile | submitCampusAuth | bindPhone | getUser | updateLocation
 *
 * 约定：
 *  · 全库以 _openid 作为用户唯一标识（§3.1）
 *  · 返回结构必须与 Campus Time Bank/utils/mock.js 的对应 handler 完全一致
 * ==================================================================
 */
const {
  cloud, db, C, _,
  wrap, bizError, assert,
  now, getOpenId, getUser, getConfig,
  publicUser, authorSnapshot, addWalletLog, addNotice
} = require('./shared')

/* ============================ 常量 ============================ */

/** 资料可编辑字段白名单（其它字段一律忽略，防止越权改写 coins/role） */
const PROFILE_FIELDS = [
  'nickName', 'avatarUrl', 'gender', 'bio', 'campus', 'college', 'major', 'grade', 'tags'
]

/** 校园认证字段白名单 */
const AUTH_FIELDS = ['realName', 'studentNo', 'campus', 'college', 'major', 'grade', 'authImages']

const MAX_TAGS = 5
const MAX_AUTH_IMAGES = 4

/* ============================ 工具 ============================ */

/** 学号可能带前后空格 */
const str = v => (v === undefined || v === null ? '' : String(v).trim())

/** 截断，避免超长文本写库 */
const cut = (s, n) => (s.length > n ? s.slice(0, n) : s)

const num = (v, dft) => {
  const n = Number(v)
  return isFinite(n) ? n : dft
}

/** 当前调用者的 openid，没有则抛 401 */
function requireOpenId() {
  const openid = getOpenId()
  if (!openid) throw bizError(401, '请先登录')
  return openid
}

/** 取用户，不存在则抛 401（比 requireUser 更贴近「未注册」的语义） */
async function requireAccount(openid) {
  const user = await getUser(openid)
  if (!user) throw bizError(401, '用户不存在，请重新登录')
  return user
}

/** 数组字段清洗：去空、去重、限量 */
function cleanArray(v, max, itemMax) {
  if (!Array.isArray(v)) return []
  const out = []
  v.forEach(item => {
    const s = str(item)
    if (!s) return
    const t = cut(s, itemMax || 40)
    if (out.indexOf(t) < 0 && out.length < max) out.push(t)
  })
  return out
}

/** 仅保留白名单字段且已有值的键 */
function pick(obj, fields) {
  const out = {}
  fields.forEach(k => {
    if (obj[k] !== undefined && obj[k] !== null) out[k] = obj[k]
  })
  return out
}

/** 新建用户文档（字段全集见 ARCHITECTURE.md §3.1） */
function newUserDoc(openid, bonus) {
  const t = now()
  return {
    _openid: openid,
    nickName: '',
    avatarUrl: '',
    gender: 0,
    phone: '',
    campus: '',
    college: '',
    major: '',
    grade: '',
    studentNo: '',
    realName: '',
    bio: '',
    tags: [],

    authStatus: 0,
    authImages: [],
    authRemark: '',
    authTime: null,

    coins: bonus,
    frozenCoins: 0,
    totalEarned: 0,
    totalSpent: 0,

    creditScore: 100,
    creditLevel: 'good',

    badges: [],
    stats: {
      publishCount: 0,
      serveCount: 0,
      buyCount: 0,
      reviewCount: 0,
      ratingSum: 0,
      avgRating: 0,
      ontimeStreak: 0
    },

    location: null,
    locationName: '',
    locationTime: null,

    role: 'user',
    status: 1,

    createTime: t,
    updateTime: t,
    lastLoginTime: t
  }
}

/**
 * 给指定用户写通知；用户不存在或写失败都不影响主流程
 * （重复实现是刻意的：共享层 addNotice 不校验接收者，认证审核场景必须容错）
 */
async function noticeSafe(openid, type, title, content, orderId) {
  if (!openid) return false
  try {
    const u = await getUser(openid)
    if (!u || u.status === 0) return false
    await addNotice({ openid, type, title, content, orderId: orderId || '' })
    return true
  } catch (e) {
    console.warn('[login] 写通知失败：', openid, e && e.message)
    return false
  }
}

/** 通知全部管理员 */
async function noticeAdmins(type, title, content) {
  const res = await db.collection(C.USERS)
    .where({ role: 'admin', status: 1, _openid: _.neq('') })
    .limit(50)
    .get()
  const admins = res.data || []
  let sent = 0
  for (const a of admins) {
    if (await noticeSafe(a._openid, type, title, content)) sent++
  }
  return sent
}

/* ============================ action ============================ */

/** login —— 首次调用自动注册并赠送 registerBonus 时间币 */
async function actionLogin() {
  const openid = requireOpenId()
  const config = await getConfig()
  const bonus = Math.max(0, num(config.registerBonus, 5))
  const t = now()

  const existed = await getUser(openid)

  let user
  let isNew = false

  if (existed) {
    // 老用户：只刷新登录时间
    await db.collection(C.USERS).doc(existed._id).update({ data: { lastLoginTime: t } })
    user = Object.assign({}, existed, { lastLoginTime: t })
  } else {
    // 新用户：注册（事务内建号 + 写流水 + 写欢迎通知，避免并发重复注册）
    const doc = newUserDoc(openid, bonus)
    let uid = ''
    // ★ 关键：用事务的**返回值**来决定 isNew，不要写闭包外变量。
    //   事务因写冲突重试时，回调会整段重跑；闭包外的 isNew 会保留上一次（已作废）
    //   尝试里写入的 true，于是并发首登会「两个请求都返回 isNew:true」，
    //   客户端弹两次「注册成功/欢迎」——数据是对的，但提示是错的。
    const txResult = await db.runTransaction(async tx => {
      const dup = await tx.collection(C.USERS).where({ _openid: openid }).limit(1).get()
      if (dup.data && dup.data.length) {
        // 并发下已被另一个请求注册，直接复用（本次不是「新建」）
        const dupId = dup.data[0]._id
        await tx.collection(C.USERS).doc(dupId).update({ data: { lastLoginTime: t } })
        return { isNew: false, uid: dupId }
      }
      const added = await tx.collection(C.USERS).add({ data: doc })
      const newId = added._id
      await tx.collection(C.WALLET_LOGS).add({
        data: {
          _openid: openid,
          type: 'bonus',
          amount: bonus,
          balance: bonus,
          frozen: 0,
          orderId: '',
          orderNo: '',
          remark: '新用户注册赠送',
          createTime: t
        }
      })
      await tx.collection(C.NOTICES).add({
        data: {
          _openid: openid,
          type: 'system',
          title: '欢迎加入校园时间银行',
          content: `我们已赠送 ${bonus} 枚时间币作为起步资金。时间币不可充值、不可提现，只能通过帮助他人获得。完成校园认证后即可发布技能和下单。`,
          orderId: '',
          read: false,
          createTime: t
        }
      })
      return { isNew: true, uid: newId }
    })
    if (txResult) {
      isNew = !!txResult.isNew
      uid = txResult.uid || uid
    }

    user = Object.assign({}, doc, { _id: uid, lastLoginTime: t })
    if (!isNew) {
      const fresh = await getUser(openid)
      if (fresh) user = fresh
    }
  }

  if (user.status === 0) throw bizError(403, '账号已被封禁，如有疑问请联系管理员')

  return { user, isNew, config }
}

/** updateProfile —— 完善资料 */
async function actionUpdateProfile(event) {
  const openid = requireOpenId()
  const user = await requireAccount(openid)

  const data = pick(event, PROFILE_FIELDS)

  if (data.nickName !== undefined) {
    const nick = cut(str(data.nickName), 20)
    assert(nick.length > 0, '昵称不能为空')
    data.nickName = nick
  }
  if (data.avatarUrl !== undefined) data.avatarUrl = cut(str(data.avatarUrl), 500)
  if (data.gender !== undefined) data.gender = [0, 1, 2].indexOf(num(data.gender, 0)) > -1 ? num(data.gender, 0) : 0
  if (data.bio !== undefined) data.bio = cut(str(data.bio), 200)
  if (data.campus !== undefined) data.campus = cut(str(data.campus), 40)
  if (data.college !== undefined) data.college = cut(str(data.college), 40)
  if (data.major !== undefined) data.major = cut(str(data.major), 40)
  if (data.grade !== undefined) data.grade = cut(str(data.grade), 20)
  if (data.tags !== undefined) data.tags = cleanArray(data.tags, MAX_TAGS, 12)

  data.updateTime = now()
  await db.collection(C.USERS).doc(user._id).update({ data })

  return { user: Object.assign({}, user, data) }
}

/** submitCampusAuth —— 提交校园认证 */
async function actionSubmitCampusAuth(event) {
  const openid = requireOpenId()
  const user = await requireAccount(openid)

  // ① 必须先设置昵称。
  //    只校验昵称、**不校验头像**：小程序端在 avatarUrl 为空时会渲染
  //    「昵称首字 + 稳定渐变色」的降级头像，所以「没有头像」是合法状态；
  //    强行要求先上传头像会挡住演示种子用户，也没有实际产品价值。
  assert(str(user.nickName).length > 0, '请先设置昵称再提交认证')

  // ② 状态校验
  // ★ 契约统一：§4.0 把「重复操作」归 409，而 assert 默认码是 400。
  //   这里文案是重复提交场景，错误码应与之匹配。
  assert(user.authStatus !== 2, '你的校园认证已通过，无需重复提交', 409)
  assert(user.authStatus !== 1, '认证资料审核中，请耐心等待', 409)

  // ③ 字段校验
  const data = pick(event, AUTH_FIELDS)
  const realName = cut(str(data.realName), 20)
  const studentNo = cut(str(data.studentNo), 30)
  assert(realName.length > 0, '请填写真实姓名')
  assert(studentNo.length > 0, '请填写学号')

  const authImages = cleanArray(data.authImages, MAX_AUTH_IMAGES, 500)
  assert(authImages.length > 0, '请上传学生证或校园卡照片')

  const t = now()
  const patch = {
    realName,
    studentNo,
    campus: cut(str(data.campus || user.campus), 40),
    college: cut(str(data.college || user.college), 40),
    authStatus: 1,
    authImages,
    authRemark: '',
    authTime: t,
    updateTime: t
  }
  // 专业 / 年级：表单可传；为空时保留原值（老用户可能没有这两个字段）
  if (data.major !== undefined) patch.major = cut(str(data.major || user.major), 40)
  if (data.grade !== undefined) patch.grade = cut(str(data.grade || user.grade), 20)

  await db.collection(C.USERS).doc(user._id).update({ data: patch })

  // ④ 提醒管理员审核（共享层 addNotice 不做接收者校验，此处用容错版本）
  await noticeAdmins(
    'audit',
    '有新的校园认证待审核',
    `${patch.realName || '一位同学'}（${studentNo}）提交了校园认证资料，请前往「校园认证审核」处理。`
  )

  return { authStatus: 1 }
}

/** bindPhone —— 用 getPhoneNumber 的 code 换手机号（失败降级为空字符串，不抛错） */
async function actionBindPhone(event) {
  const openid = requireOpenId()
  const user = await requireAccount(openid)

  const code = str(event.code)
  let phone = ''
  let msg = ''

  if (!code) {
    msg = '缺少手机号授权凭证'
  } else {
    try {
      const res = await cloud.openapi.phonenumber.getPhoneNumber({ code })
      phone = str(
        (res && res.phoneInfo && res.phoneInfo.phoneNumber) ||
        (res && res.phoneInfo && res.phoneInfo.purePhoneNumber) ||
        ''
      )
    } catch (e) {
      // 降级：不阻断主流程
      console.warn('[login] bindPhone 换取手机号失败：', e && (e.errCode || e.errMsg || e.message))
      msg = '手机号获取失败，请稍后重试'
    }
  }

  if (phone) {
    await db.collection(C.USERS).doc(user._id).update({
      data: { phone, updateTime: now() }
    })
  }

  return { phone, ok: !!phone, msg }
}

/** getUser —— 公开资料（隐藏 phone / studentNo / authImages） */
async function actionGetUser(event) {
  const openid = str(event.openid) || getOpenId()
  if (!openid) throw bizError(400, '缺少 openid')
  const user = await getUser(openid)
  if (!user) throw bizError(404, '用户不存在')
  return { user: publicUser(user) }
}

/** updateLocation —— 上报定位（GeoPoint 参数顺序为 经度, 纬度） */
async function actionUpdateLocation(event) {
  const openid = requireOpenId()
  const user = await requireAccount(openid)

  const lng = Number(event.longitude)
  const lat = Number(event.latitude)
  assert(
    isFinite(lng) && isFinite(lat) && lng >= -180 && lng <= 180 && lat >= -90 && lat <= 90,
    '定位参数不正确'
  )

  const t = now()
  await db.collection(C.USERS).doc(user._id).update({
    data: {
      location: db.Geo.Point(lng, lat),
      locationName: cut(str(event.locationName), 60),
      locationTime: t,
      updateTime: t
    }
  })

  return { ok: true }
}

/* ============================ 入口 ============================ */
exports.main = wrap(async (event, context) => {
  const action = event.action
  switch (action) {
    case 'login': return actionLogin(event, context)
    case 'updateProfile': return actionUpdateProfile(event, context)
    case 'submitCampusAuth': return actionSubmitCampusAuth(event, context)
    case 'bindPhone': return actionBindPhone(event, context)
    case 'getUser': return actionGetUser(event, context)
    case 'updateLocation': return actionUpdateLocation(event, context)
    default: throw bizError(400, `未知 action: ${action}`)
  }
})

/* 供其它云函数 or 单元测试复用（不影响云函数运行） */
exports.newUserDoc = newUserDoc
exports.authorSnapshotOf = authorSnapshot
