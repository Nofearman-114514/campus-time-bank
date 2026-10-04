/**
 * 信用分与徽章算法（前端展示副本）
 * ------------------------------------------------------------------
 * ★ 真正的计算在云函数 cloudfunctions/order、user 中执行（服务端为准）。
 *   这里保留同一套公式，用于「信用分详情页」实时预览、
 *   以及在没有请求服务端时也能给出正确的等级/配色。
 * ------------------------------------------------------------------
 */
const { CREDIT_LEVELS, CREDIT_RULES, BADGES, BADGE_MAP } = require('./constants')

/** 初始信用分 */
const BASE_SCORE = 100
const MIN_SCORE = 0
const MAX_SCORE = 150

/** 分数限幅 */
function clampScore(n) {
  const v = Math.round(Number(n) || 0)
  return Math.min(Math.max(v, MIN_SCORE), MAX_SCORE)
}

/** 取信用等级对象 */
function getLevel(score) {
  const s = clampScore(score)
  return CREDIT_LEVELS.find(l => s >= l.min && s <= l.max) || CREDIT_LEVELS[CREDIT_LEVELS.length - 1]
}

/** 该分数最多可同时进行的订单数 */
function getOrderLimit(score) {
  return getLevel(score).limit
}

/**
 * 评价加权平均（时间衰减加权）
 * w_i = 0.9 ^ (距今天数)
 * @param {Array<{score:Number, createTime:Date|String}>} reviews
 * @returns {Number} 保留 1 位小数，无评价返回 0
 */
function weightedRating(reviews) {
  const list = (reviews || []).filter(r => r && r.score)
  if (!list.length) return 0
  let sw = 0
  let ss = 0
  const now = Date.now()
  list.forEach(r => {
    const t = r.createTime ? new Date(String(r.createTime).replace(/-/g, '/').replace(/T/, ' ')).getTime() : now
    const days = Math.max(0, (now - t) / 86400000)
    const w = Math.pow(0.9, days)
    sw += w
    ss += Number(r.score) * w
  })
  if (!sw) return 0
  return Math.round((ss / sw) * 10) / 10
}

/**
 * 模拟一次信用分变动（仅用于展示「如果…会怎样」）
 * @param {Number} current 当前分数
 * @param {String} reason  规则 key
 * @returns {{score:Number, change:Number, reasonText:String}}
 */
function previewChange(current, reason) {
  const rule = CREDIT_RULES.find(r => r.key === reason)
  const change = rule ? rule.change : 0
  return {
    score: clampScore(current + change),
    change,
    reasonText: rule ? rule.text : '未知规则'
  }
}

/**
 * 计算用户应获得的徽章 id 列表（服务端同款逻辑，前端可本地预判）
 * @param {Object} user  users 文档（或含 stats/creditScore 的对象）
 * @param {Object} extra { maxCategoryCount, totalViews }
 * @returns {String[]}
 */
function calcBadges(user, extra) {
  const u = user || {}
  const stats = u.stats || {}
  const ex = extra || {}
  const owned = []

  if ((stats.serveCount || 0) + (stats.buyCount || 0) >= 1) owned.push('newbie')
  if ((stats.ontimeStreak || 0) >= 5) owned.push('ontime')
  if ((stats.serveCount || 0) >= 10) owned.push('warm')
  if ((ex.maxCategoryCount || 0) >= 5 && (stats.avgRating || 0) >= 4.5) owned.push('expert')
  if ((u.creditScore || 0) >= 120) owned.push('trust')
  if ((ex.totalViews || 0) >= 500) owned.push('popular')
  if ((stats.reviewCount || 0) >= 20) owned.push('social')

  return owned
}

/** 徽章 id 数组 → 徽章对象数组 */
function toBadgeList(ids) {
  return (ids || []).map(id => BADGE_MAP[id]).filter(Boolean)
}

/** 全部徽章（含未获得状态），用于徽章墙 */
function badgeWall(ownedIds) {
  const owned = ownedIds || []
  return BADGES.map(b => Object.assign({}, b, { owned: owned.indexOf(b.id) > -1 }))
}

/** 已获得数量 / 总数，用于进度展示 */
function badgeProgress(ownedIds) {
  const n = (ownedIds || []).filter(id => BADGE_MAP[id]).length
  return { owned: n, total: BADGES.length, percent: Math.round(n / BADGES.length * 100) }
}

/** 信用分进度（相对 0~150） */
function scorePercent(score) {
  return Math.round(clampScore(score) / MAX_SCORE * 100)
}

/** 距离下一等级还差多少分 */
function nextLevel(score) {
  const s = clampScore(score)
  const higher = CREDIT_LEVELS.filter(l => l.min > s).sort((a, b) => a.min - b.min)[0]
  if (!higher) return { level: null, gap: 0, text: '已达最高等级' }
  const gap = higher.min - s
  return { level: higher, gap, text: `距离「${higher.text}」还需 ${gap} 分` }
}

module.exports = {
  BASE_SCORE, MIN_SCORE, MAX_SCORE,
  clampScore, getLevel, getOrderLimit,
  weightedRating, previewChange,
  calcBadges, toBadgeList, badgeWall, badgeProgress,
  scorePercent, nextLevel
}
