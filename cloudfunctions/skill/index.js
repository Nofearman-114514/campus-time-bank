/**
 * skill —— 技能域（ARCHITECTURE.md §4.2 / §3.3）
 * ==================================================================
 * action：list | detail | create | update | remove | myList | categories | banners | report
 *
 * 返回结构必须与 Campus Time Bank/utils/mock.js 的对应 handler 完全一致。
 * 附近排序用云开发原生 geoNear（§10），不依赖任何第三方 SDK。
 * ==================================================================
 */
const {
  db, C, _,
  wrap, bizError, assert,
  now, getOpenId, getUser, requireVerified,
  parsePage, paginateQuery,
  authorSnapshot, publicUser,
  assertInsideCampus
} = require('./shared')

/* ============================ 常量 ============================ */

const SKILL_TYPES = ['offer', 'need']
const SKILL_STATUS = [0, 1, 2, 3, 4]
const SORTS = ['new', 'hot', 'near', 'priceAsc', 'priceDesc']

const DEFAULT_RADIUS = 3000
const MIN_RADIUS = 100
const MAX_RADIUS = 50000
const MAX_PRICE = 999
const MAX_TITLE = 30
const MAX_DESC = 500
const MAX_IMAGES = 3
const MAX_TAGS = 5
const MAX_REPORT_IMAGES = 3

/** 会阻塞删除的进行中订单状态 */
const BLOCKING_ORDER_STATUS = ['waiting', 'ongoing', 'confirming']

/* ============================ 工具 ============================ */

const str = v => (v === undefined || v === null ? '' : String(v).trim())
const cut = (s, n) => (s.length > n ? s.slice(0, n) : s)
/** 去除首尾空白并折叠连续空白（与 Campus Time Bank/utils/util.js 的 trimAll 行为一致） */
const trimAll = v => String(v == null ? '' : v).trim().replace(/\s+/g, ' ')

function requireOpenId() {
  const openid = getOpenId()
  if (!openid) throw bizError(401, '请先登录')
  return openid
}

/** 正则模糊匹配（options i = 忽略大小写） */
const like = q => db.RegExp({ regexp: q, options: 'i' })

/** 数组字段清洗：去空、去重、限量 */
function cleanArray(v, max, itemMax) {
  if (!Array.isArray(v)) return []
  const out = []
  v.forEach(item => {
    const s = str(item)
    if (!s) return
    const t = cut(s, itemMax || 300)
    if (out.indexOf(t) < 0 && out.length < max) out.push(t)
  })
  return out
}

/** 解析经纬度；两者都非法时返回 null */
function parseGeo(event) {
  const lng = Number(event.longitude)
  const lat = Number(event.latitude)
  if (!isFinite(lng) || !isFinite(lat)) return null
  if (lng < -180 || lng > 180 || lat < -90 || lat > 90) return null
  return { lng, lat }
}

/** 分类文档 → { _id, name, icon }，取不到时降级为「其他」 */
async function resolveCategory(categoryId) {
  const id = str(categoryId)
  if (!id) return { _id: '', name: '其他', icon: '✨' }
  try {
    const res = await db.collection(C.CATEGORIES).doc(id).get()
    const c = res.data
    if (c) return { _id: id, name: c.name || '其他', icon: c.icon || '✨' }
  } catch (e) { /* 分类不存在不阻断发布 */ }
  return { _id: id, name: '其他', icon: '✨' }
}

/**
 * 构造技能查询条件
 * ------------------------------------------------------------------
 * 云数据库的 _.and() / _.or() 是「跨字段」逻辑命令，必须和普通 where 对象
 * 平级使用（where(_.and([{a:1},{b:2}]))），不能把 _.or() 塞进某个字段的值里。
 * 因此这里统一返回「条件对象数组」，最后由 combine() 合成。
 *
 * @param {Object} event 入参
 * @param {Object} o { openid, authorId, forceStatus1 }
 * @returns {Array<Object>}
 */
function buildConds(event, o) {
  const opt = o || {}
  const conds = []
  const flat = {}

  if (opt.openid) flat._openid = opt.openid
  if (opt.authorId) flat.authorId = opt.authorId
  if (event.categoryId) flat.categoryId = str(event.categoryId)

  if (event.type && SKILL_TYPES.indexOf(str(event.type)) > -1) flat.type = str(event.type)

  const hasStatus = event.status !== undefined && event.status !== null && String(event.status) !== ''
  if (hasStatus) {
    const st = Number(event.status)
    assert(SKILL_STATUS.indexOf(st) > -1, '技能状态参数不正确')
    flat.status = st
  }

  // 广场只展示上架（status === 1）的技能。
  // ★ 修复：调用方**显式传了 status 就尊重它**，不要无条件覆盖 ——
  //   原先 forceStatus1 会把 event.status 静默吃掉，于是传 status:0 不报错、
  //   却只返回上架技能，前端若复用 list 查「已下架」会拿到错数据。
  if (opt.forceStatus1 && !hasStatus) flat.status = 1

  if (event.onlyVerified) flat['authorInfo.authStatus'] = 2

  if (Object.keys(flat).length) conds.push(flat)

  // 关键词：正则模糊匹配 title + desc + tags + categoryName
  // 空格分词 = AND；单次词内 4 个字段任一命中 = OR
  const kw = str(event.keyword)
  if (kw) {
    const words = kw.split(/\s+/).filter(Boolean).slice(0, 3)
    words.forEach(w => {
      const rx = like(w)
      conds.push(_.or([{ title: rx }, { desc: rx }, { tags: rx }, { categoryName: rx }]))
    })
  }

  return conds
}

/** 合成最终 where 条件（空条件 → 恒真对象） */
function combine(conds) {
  if (!conds.length) return { _id: _.neq('') }
  if (conds.length === 1) return conds[0]
  return _.and(conds)
}

/**
 * 在已有 where 条件上追加一个字段条件（用于 geoNear）
 * 已有多条件时展开 _.and 数组再追加，避免 _.and 嵌套
 */
function withCondition(where, extra) {
  if (where && where.__cmd && where.__op === 'and') {
    return _.and(where.__v.concat([extra]))
  }
  return _.and([where, extra])
}

/** 排序权重（置顶优先） */
function orderOf(sort) {
  switch (sort) {
    case 'hot': return [['isTop', 'desc'], ['viewCount', 'desc'], ['createTime', 'desc']]
    case 'priceAsc': return [['isTop', 'desc'], ['price', 'asc'], ['createTime', 'desc']]
    case 'priceDesc': return [['isTop', 'desc'], ['price', 'desc'], ['createTime', 'desc']]
    default: return [['isTop', 'desc'], ['createTime', 'desc']]
  }
}

/** 按 sort 升序 */
const bySort = (a, b) => (a.sort || 0) - (b.sort || 0)

/* ============================ action ============================ */

/**
 * list —— 技能广场
 * { page, size, categoryId, keyword, type, sort, longitude, latitude, radius, onlyVerified }
 */
async function actionList(event) {
  const { page, size } = parsePage(event, 10)
  const sort = SORTS.indexOf(str(event.sort)) > -1 ? str(event.sort) : 'new'
  // ★ 修复：把 authorId 透传进 buildConds —— §4.2 声明支持、mock.js 也支持，
  //   原先只传 forceStatus1，导致「按作者筛选」在云端静默失效
  //   （离线演示能按作者筛、真机不能，属 mock/云端行为分叉）。
  const where = combine(buildConds(event, {
    forceStatus1: true,
    authorId: str(event.authorId)
  }))

  /* ---------- 附近：geoNear（结果自带 distance，且天然按距离升序） ---------- */
  const geo = sort === 'near' ? parseGeo(event) : null
  if (sort === 'near' && geo) {
    const radius = Math.min(MAX_RADIUS, Math.max(
      MIN_RADIUS,
      Number(event.radius) > 0 ? Number(event.radius) : DEFAULT_RADIUS
    ))

    const near = withCondition(where, {
      location: _.geoNear({
        geometry: db.Geo.Point(geo.lng, geo.lat),
        maxDistance: radius
      })
    })

    const query = db.collection(C.SKILLS).where(near)
    const countRes = await query.count()
    const total = countRes.total || 0

    const res = await query
      .orderBy('location', 'asc')
      .skip((page - 1) * size)
      .limit(size)
      .get()

    // ★ geoNear 必须返回 distance（单位：米，取整）
    const list = (res.data || []).map(item => Object.assign({}, item, {
      distance: Math.round(Number(item.distance) || 0)
    }))

    return { list, total, hasMore: (page - 1) * size + size < total, page }
  }

  // sort='near' 但没带经纬度（前端翻页时可能不传定位）→ 优雅降级为最新发布，不报错、不返空
  const effectiveSort = sort === 'near' ? 'new' : sort

  /* ---------- 其余排序：标准分页查询 ---------- */
  const query = db.collection(C.SKILLS).where(where)
  const paged = await paginateQuery(query, {
    page,
    size,
    orderBy: orderOf(effectiveSort)
  })

  return {
    list: paged.list,
    total: paged.total,
    hasMore: paged.hasMore,
    page: paged.page
  }
}

/** detail —— 详情，viewCount + 1 */
async function actionDetail(event) {
  const id = str(event.id)
  assert(id, '缺少技能 id')

  let skill = null
  try {
    const res = await db.collection(C.SKILLS).doc(id).get()
    skill = res.data || null
  } catch (e) {
    skill = null
  }
  if (!skill) {
    // 兜底：部分场景会传 _id 以外的业务 id
    const alt = await db.collection(C.SKILLS).where({ _id: id }).limit(1).get()
    skill = (alt.data && alt.data[0]) || null
  }
  if (!skill) throw bizError(404, '技能不存在或已被删除')

  const openid = getOpenId()
  const isOwner = !!openid && skill.authorId === openid

  // 浏览量自增（失败不影响详情返回）
  let viewCount = Number(skill.viewCount) || 0
  try {
    await db.collection(C.SKILLS).doc(skill._id).update({
      data: { viewCount: _.inc(1) }
    })
    viewCount += 1
  } catch (e) {
    console.warn('[skill] viewCount 自增失败：', e && e.message)
  }

  // 作者信息：公开字段 + stats（技能详情页作者卡要展示平均评分 / 评价数）
  const authorDoc = await getUser(skill.authorId)
  const author = Object.assign(publicUser(authorDoc) || {}, {
    stats: Object.assign(
      { avgRating: 0, reviewCount: 0, serveCount: 0, buyCount: 0 },
      (authorDoc && authorDoc.stats) || {}
    )
  })

  // ★ 收藏态：真实读 favorites 集合。
  //   此前恒为 false（前端「收藏」是个半成品），现在接入真实数据。
  let isCollected = false
  if (openid) {
    try {
      const fav = await db.collection(C.FAVORITES)
        .where({ _openid: openid, skillId: skill._id })
        .limit(1)
        .get()
      isCollected = !!((fav.data || [])[0])
    } catch (e) {
      console.warn('[skill] 查询收藏态失败：', e && e.message)
    }
  }

  return {
    skill: Object.assign({}, skill, { viewCount }),
    author,
    isOwner,
    isCollected
  }
}

/** create —— 发布技能 / 求助（要求已通过校园认证） */
async function actionCreate(event) {
  const user = await requireVerified()

  const type = SKILL_TYPES.indexOf(str(event.type)) > -1 ? str(event.type) : 'offer'

  const titleRaw = str(event.title)
  assert(titleRaw.length > 0, '请填写标题')
  assert(titleRaw.length <= MAX_TITLE, `标题不能超过 ${MAX_TITLE} 字`)
  const title = titleRaw

  const desc = cut(str(event.desc), MAX_DESC)
  assert(desc.length > 0, '请填写技能详情')

  const categoryId = str(event.categoryId)
  assert(categoryId, '请选择技能分类')
  const cat = await resolveCategory(categoryId)

  // 价格：1 ~ 999 的整数
  const price = Number(event.price)
  assert(isFinite(price) && price >= 1 && price <= MAX_PRICE, `时间币数需为 1~${MAX_PRICE} 的整数`)
  assert(Math.floor(price) === price, `时间币数需为 1~${MAX_PRICE} 的整数`)

  // 时长：正整数分钟
  const duration = Number(event.duration)
  assert(isFinite(duration) && duration > 0, '服务时长必须大于 0')
  const durationInt = Math.round(duration)

  const geo = parseGeo(event)

  // ★ 安全策略：新任务**必须**带校内地点。
  //   校外的任务一旦出现纠纷或意外，校方无法及时处理 —— 所以这里硬拦，
  //   文案把「为什么」说清楚，而不是干巴巴一句「参数错误」。
  //   客户端（选点页/发布页）也会拦，但客户端可被绕过，这里是最后一道防线。
  assert(geo, '请选择服务地点：只能发布校内的任务', 400)
  assertInsideCampus(geo.lat, geo.lng)

  const t = now()

  const doc = {
    _openid: user._openid,
    authorId: user._openid,
    authorInfo: authorSnapshot(user),
    type,
    title,
    desc,
    categoryId,
    categoryName: cat.name,
    categoryIcon: cat.icon,
    price: Math.floor(price),
    duration: durationInt,
    images: cleanArray(event.images, MAX_IMAGES, 500),
    tags: cleanArray(event.tags, MAX_TAGS, 12),

    location: geo ? db.Geo.Point(geo.lng, geo.lat) : null,
    address: cut(str(event.address), 120),
    locationName: cut(str(event.locationName), 60),

    status: 1,
    auditRemark: '',
    viewCount: 0,
    orderCount: 0,
    isTop: false,

    createTime: t,
    updateTime: t
  }

  const res = await db.collection(C.SKILLS).add({ data: doc })

  // 维护 users.stats.publishCount（失败不影响发布结果）
  try {
    await db.collection(C.USERS).doc(user._id).update({
      data: { 'stats.publishCount': _.inc(1), updateTime: t }
    })
  } catch (e) {
    console.warn('[skill] publishCount 自增失败：', e && e.message)
  }

  return { id: res._id }
}

/** update —— 编辑自己的技能 */
async function actionUpdate(event) {
  const openid = requireOpenId()
  const creator = await getUser(openid)
  if (!creator) throw bizError(401, '用户不存在，请重新登录')

  const id = str(event.id)
  assert(id, '缺少技能 id')

  let skill = null
  try {
    const res = await db.collection(C.SKILLS).doc(id).get()
    skill = res.data || null
  } catch (e) { skill = null }
  if (!skill) throw bizError(404, '技能不存在')
  if (skill.authorId !== openid) throw bizError(403, '只能编辑自己发布的技能')

  const data = { updateTime: now() }

  if (event.type !== undefined) {
    data.type = SKILL_TYPES.indexOf(str(event.type)) > -1 ? str(event.type) : skill.type
  }

  if (event.title !== undefined) {
    const titleRaw = str(event.title)
    assert(titleRaw.length > 0, '请填写标题')
    assert(titleRaw.length <= MAX_TITLE, `标题不能超过 ${MAX_TITLE} 字`)
    data.title = titleRaw
  }

  if (event.desc !== undefined) {
    const desc = cut(str(event.desc), MAX_DESC)
    assert(desc.length > 0, '请填写技能详情')
    data.desc = desc
  }

  if (event.categoryId !== undefined) {
    const categoryId = str(event.categoryId)
    assert(categoryId, '请选择技能分类')
    const cat = await resolveCategory(categoryId)
    data.categoryId = categoryId
    data.categoryName = cat.name   // ★ 分类变更必须同步冗余名
    data.categoryIcon = cat.icon
  }

  if (event.price !== undefined) {
    const price = Number(event.price)
    assert(isFinite(price) && price >= 1 && price <= MAX_PRICE && Math.floor(price) === price,
      `时间币数需为 1~${MAX_PRICE} 的整数`)
    data.price = Math.floor(price)
  }

  if (event.duration !== undefined) {
    const duration = Number(event.duration)
    assert(isFinite(duration) && duration > 0, '服务时长必须大于 0')
    data.duration = Math.round(duration)
  }

  if (event.images !== undefined) data.images = cleanArray(event.images, MAX_IMAGES, 500)
  if (event.tags !== undefined) data.tags = cleanArray(event.tags, MAX_TAGS, 12)

  if (event.longitude !== undefined || event.latitude !== undefined) {
    const geo = parseGeo(event)
    if (geo) {
      // ★ 安全策略：编辑不能让任务跑到校外去（编辑旧任务时不强制补地点，
      //   但一旦传了坐标就必须在校内）
      assertInsideCampus(geo.lat, geo.lng)
      data.location = db.Geo.Point(geo.lng, geo.lat)
    }
  }
  if (event.address !== undefined) data.address = cut(str(event.address), 120)
  if (event.locationName !== undefined) data.locationName = cut(str(event.locationName), 60)

  await db.collection(C.SKILLS).doc(skill._id).update({ data })

  return { ok: true }
}

/** remove —— 下架/删除（有进行中订单时拒绝，409） */
async function actionRemove(event) {
  const openid = requireOpenId()
  // ★ 契约统一：先判账号存在（401）再判归属（403）——
  //   原先未注册用户直接拿到 403，语义不对。
  const me = await getUser(openid)
  assert(me, '请先登录', 401)
  const id = str(event.id)
  assert(id, '缺少技能 id')

  let skill = null
  try {
    const res = await db.collection(C.SKILLS).doc(id).get()
    skill = res.data || null
  } catch (e) { skill = null }
  if (!skill) throw bizError(404, '技能不存在')
  if (skill.authorId !== openid) throw bizError(403, '只能删除自己发布的技能')

  const busy = await db.collection(C.ORDERS)
    .where({ skillId: skill._id, status: _.in(BLOCKING_ORDER_STATUS) })
    .count()
  if ((busy.total || 0) > 0) {
    throw bizError(409, '该技能有进行中的订单，暂时不能删除')
  }

  await db.collection(C.SKILLS).doc(skill._id).remove()

  try {
    const u = await getUser(openid)
    if (u) {
      await db.collection(C.USERS).doc(u._id).update({
        data: { 'stats.publishCount': _.inc(-1), updateTime: now() }
      })
    }
  } catch (e) {
    console.warn('[skill] publishCount 回退失败：', e && e.message)
  }

  return { ok: true }
}

/** myList —— 我的发布（不看 status 限制，默认全部） */
async function actionMyList(event) {
  const openid = requireOpenId()
  // ★ 契约统一：未注册用户应返回 401，而不是「code 0 + 空列表」——
  //   后者让前端拿不到「你需要先登录」的信号，与其它 action 也不一致。
  const me = await getUser(openid)
  assert(me, '请先登录', 401)
  const { page, size } = parsePage(event, 10)

  const where = combine(buildConds(event, { openid }))

  const paged = await paginateQuery(db.collection(C.SKILLS).where(where), {
    page,
    size,
    orderBy: orderOf('new')
  })

  return { list: paged.list, total: paged.total, hasMore: paged.hasMore, page: paged.page }
}

/**
 * collect —— 收藏 / 取消收藏技能
 * { id, collected? }
 *   collected 显式传 true/false 时按值执行；缺省则按当前状态取反（toggle）。
 * → { collected: Boolean }
 */
async function actionCollect(event) {
  const openid = requireOpenId()
  const me = await getUser(openid)
  assert(me, '请先登录', 401)

  const id = str(event.id)
  assert(id, '缺少技能 id', 400)

  let skill = null
  try {
    const res = await db.collection(C.SKILLS).doc(id).get()
    skill = res.data || null
  } catch (e) { skill = null }
  if (!skill) throw bizError(404, '技能不存在')
  // 已下架的技能不再允许收藏（与 list 只出上架技能的口径一致）
  assert(skill.status === 1, '该技能已下架，无法收藏', 409)
  assert(skill.authorId !== openid, '不能收藏自己发布的技能', 400)

  const existed = await db.collection(C.FAVORITES)
    .where({ _openid: openid, skillId: id })
    .limit(1)
    .get()
  const hit = (existed.data || [])[0] || null
  const want = event.collected === undefined ? !hit : !!event.collected

  if (want && !hit) {
    await db.collection(C.FAVORITES).add({
      data: { _openid: openid, skillId: id, createTime: now() }
    })
  } else if (!want && hit) {
    // 幂等：重复取消不报错
    await db.collection(C.FAVORITES).doc(hit._id).remove()
  }
  return { collected: want }
}

/**
 * myFavorites —— 我的收藏（按收藏时间倒序，返回技能本身）
 * { page, size } → { list, total, hasMore, page }
 * 每条附带 collectedTime，前端可显示「x 天前收藏」。
 */
async function actionMyFavorites(event) {
  const openid = requireOpenId()
  const me = await getUser(openid)
  assert(me, '请先登录', 401)
  const { page, size, skip } = parsePage(event, 10)

  const favRes = await db.collection(C.FAVORITES)
    .where({ _openid: openid })
    .orderBy('createTime', 'desc')
    .skip(skip)
    .limit(size)
    .get()
  const favs = favRes.data || []

  let list = []
  if (favs.length) {
    const skRes = await db.collection(C.SKILLS)
      .where({ _id: _.in(favs.map(f => f.skillId)) })
      .limit(100)
      .get()
    const map = {}
    ;(skRes.data || []).forEach(s => { map[s._id] = s })
    // 保持「收藏时间倒序」；技能若已被删除就跳过该条，不返回空洞
    list = favs
      .map(f => {
        const s = map[f.skillId]
        return s ? Object.assign({}, s, { collectedTime: f.createTime }) : null
      })
      .filter(Boolean)
  }

  const totalRes = await db.collection(C.FAVORITES).where({ _openid: openid }).count()
  const total = (totalRes && totalRes.total) || 0
  return { list, total, hasMore: skip + favs.length < total, page }
}

/** categories —— 只返回启用的分类 */
async function actionCategories() {
  const res = await db.collection(C.CATEGORIES)
    .where({ status: 1 })
    .limit(100)
    .get()
  const list = (res.data || []).slice().sort(bySort)
  return { list }
}

/** banners —— 只返回启用的轮播 */
async function actionBanners() {
  const res = await db.collection(C.BANNERS)
    .where({ status: 1 })
    .limit(20)
    .get()
  const list = (res.data || []).slice().sort(bySort)
  return { list }
}

/** report —— 举报（§3.11 / §4.2） */
async function actionReport(event) {
  const openid = requireOpenId()
  const user = await getUser(openid)
  if (!user) throw bizError(401, '用户不存在，请重新登录')

  // ① 入参校验
  const targetType = str(event.targetType)
  assert(['skill', 'user', 'order', 'review'].indexOf(targetType) > -1, '举报对象类型不正确')

  const targetId = str(event.targetId)
  assert(targetId, '缺少举报对象')

  const reason = trimAll(event.reason).slice(0, 60)
  assert(reason, '请选择举报原因')

  // 补充说明：≤200 字，超出直接截断（避免用户填多了提交失败）
  const remark = trimAll(event.remark).slice(0, 200)

  const images = cleanArray(event.images, MAX_REPORT_IMAGES, 500)

  // ② 冗余被举报人 / 标题，便于管理端列表直接展示
  let targetTitle = cut(str(event.targetTitle), 60)
  let targetUserId = str(event.targetUserId)

  try {
    if (targetType === 'skill') {
      let sk = null
      try { sk = (await db.collection(C.SKILLS).doc(targetId).get()).data } catch (e) { sk = null }
      if (sk) {
        targetTitle = targetTitle || cut(str(sk.title), 60)
        targetUserId = targetUserId || sk.authorId || ''
      }
    } else if (targetType === 'user') {
      const u = await getUser(targetId)
      if (u) {
        targetTitle = targetTitle || cut(str(u.nickName), 60)
        targetUserId = targetUserId || u._openid
      }
    } else if (targetType === 'order') {
      let od = null
      try { od = (await db.collection(C.ORDERS).doc(targetId).get()).data } catch (e) { od = null }
      if (od) {
        targetTitle = targetTitle || cut(str(od.orderNo), 60)
        targetUserId = targetUserId || (od.sellerId === openid ? od.buyerId : od.sellerId) || ''
      }
    } else if (targetType === 'review') {
      let rv = null
      try { rv = (await db.collection(C.REVIEWS).doc(targetId).get()).data } catch (e) { rv = null }
      if (rv) {
        targetTitle = targetTitle || cut(str(rv.content), 60)
        targetUserId = targetUserId || rv.fromId || ''
      }
    }

    // ★ 自己不能举报自己
    if (targetType === 'user' && targetId === openid) {
      throw bizError(409, '不能举报自己')
    }
    if (targetUserId && targetUserId === openid) {
      throw bizError(409, '不能举报自己')
    }
  } catch (e) {
    if (e && e.__biz) throw e
    console.warn('[skill] report 冗余信息补充失败：', e && e.message)
  }

  // ③ 防刷：同一用户对同一对象只允许一条待处理举报
  const dup = await db.collection(C.REPORTS)
    .where({ _openid: openid, targetId, status: 0 })
    .count()
  if ((dup.total || 0) > 0) throw bizError(409, '你已举报过该内容，我们正在处理中')

  const t = now()
  const res = await db.collection(C.REPORTS).add({
    data: {
      _openid: openid,
      targetType,
      targetId,
      targetTitle,
      targetUserId,
      reason,
      images,
      remark,
      status: 0,
      handleRemark: '',
      handlerId: '',
      handleTime: null,
      createTime: t
    }
  })

  return { ok: true, id: res._id }
}

/* ============================ 入口 ============================ */
exports.main = wrap(async (event, context) => {
  const action = event.action
  switch (action) {
    case 'list': return actionList(event, context)
    case 'detail': return actionDetail(event, context)
    case 'create': return actionCreate(event, context)
    case 'update': return actionUpdate(event, context)
    case 'remove': return actionRemove(event, context)
    case 'myList': return actionMyList(event, context)
    case 'collect': return actionCollect(event, context)
    case 'myFavorites': return actionMyFavorites(event, context)
    case 'categories': return actionCategories(event, context)
    case 'banners': return actionBanners(event, context)
    case 'report': return actionReport(event, context)
    default: throw bizError(400, `未知 action: ${action}`)
  }
})
