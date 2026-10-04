/**
 * 广职院校内地点表（前端共用）
 * ------------------------------------------------------------------
 * ★ 坐标基准：1 栋（山下男生宿舍）北纬 23°0'13"、东经 112°49'6"
 *   → 纬度 23.003611、经度 112.818333。
 *   其余地点按「山下（南）/ 中区 / 山上（北）」的相对关系推出，校园跨度约 600 米。
 *   ⚠️ 若山上与山下的实际方位与此相反，只改本文件的 lat 即可。
 *
 * ★ 这里为什么需要它：地图选点页如果只让用户看经纬度，等于要求人肉当 GPS。
 *   有了本表，选点页就能做两件「人能懂」的事：
 *     ① 点地图后**就近推断**出「山下饭堂」这种中文名，而不是一串数字；
 *     ② 提供一排「校内常用地点」快捷按钮，点一下直接选中。
 *
 * ★ 与云端的 DEMO_SKILLS 用同一套坐标（那边在 initdb/mock 的 CAMPUS 常量里），
 *   改坐标时请两处一起改。
 * ================================================================== */

/** 校园中心（1 栋）—— 地图默认中心，定位失败时也不会飘到别的城市 */
const CENTER = { lat: 23.003611, lng: 112.818333 }

/**
 * 校园有效范围（米）：以校园中心为圆心的半径。
 *
 * ★ 这是一条**安全策略**，不是普通校验：任务只能发在校内 ——
 *   校外的地点一旦出现纠纷或意外，学校无法及时介入处理。
 *   最远的校内地点（新操场）距中心约 677 米，半径取 1200 米留出余量。
 *
 * ★ 与云端 `cloudfunctions/_shared/index.js` 的 CAMPUS_RADIUS 必须一致；
 *   云端的校验是最后一道防线（客户端校验可被绕过）。
 */
const RADIUS = 1200

/** 校内地点：key 唯一，name 是短标签（按钮上显示），locationName/address 与技能字段对齐 */
const SPOTS = [
  // —— 山下（南侧）：男生宿舍 1~6 栋、山下饭堂、旧操场 ——
  { key: 'canteenS', name: '山下饭堂', locationName: '山下饭堂一楼', address: '广职院 · 山下饭堂', lat: 23.004200, lng: 112.818700 },
  { key: 'oldField', name: '旧操场', locationName: '旧操场看台', address: '广职院 · 旧操场', lat: 23.003400, lng: 112.817700 },
  { key: 'dorm1', name: '山下1栋', locationName: '山下 1 栋楼下', address: '广职院 · 山下 1 栋', lat: 23.003611, lng: 112.818333 },
  { key: 'dorm3', name: '山下3栋', locationName: '山下 3 栋门口', address: '广职院 · 山下 3 栋', lat: 23.003950, lng: 112.818100 },
  { key: 'dorm6', name: '山下6栋', locationName: '山下 6 栋楼下', address: '广职院 · 山下 6 栋', lat: 23.003300, lng: 112.818900 },
  // —— 中区：图书馆 / 学子湖（相邻）/ ABCD 栋 / 实训 1-2-3 ——
  { key: 'library', name: '图书馆', locationName: '图书馆一楼大厅', address: '广职院 · 图书馆', lat: 23.005600, lng: 112.819600 },
  { key: 'lake', name: '学子湖', locationName: '学子湖边', address: '广职院 · 学子湖', lat: 23.005500, lng: 112.820100 },
  { key: 'bldgA', name: 'A栋', locationName: 'A 栋自习室', address: '广职院 · A 栋', lat: 23.005000, lng: 112.819200 },
  { key: 'bldgB', name: 'B栋', locationName: 'B 栋 301 教室', address: '广职院 · B 栋', lat: 23.004800, lng: 112.819500 },
  { key: 'bldgC', name: 'C栋', locationName: 'C 栋门口', address: '广职院 · C 栋', lat: 23.004900, lng: 112.819800 },
  { key: 'bldgD', name: 'D栋', locationName: 'D 栋中庭', address: '广职院 · D 栋', lat: 23.005100, lng: 112.820000 },
  { key: 'train1', name: '实训1', locationName: '实训 1 楼机房', address: '广职院 · 实训 1 楼', lat: 23.004600, lng: 112.820300 },
  { key: 'train2', name: '实训2', locationName: '实训 2 楼', address: '广职院 · 实训 2 楼', lat: 23.004700, lng: 112.820600 },
  { key: 'train3', name: '实训3', locationName: '实训 3 楼', address: '广职院 · 实训 3 楼', lat: 23.004800, lng: 112.820900 },
  // —— 山上（北侧）：女生宿舍 7~14 栋、山上饭堂、新操场 ——
  { key: 'canteenN', name: '山上饭堂', locationName: '山上饭堂二楼', address: '广职院 · 山上饭堂', lat: 23.007600, lng: 112.820800 },
  { key: 'newField', name: '新操场', locationName: '新操场田径场', address: '广职院 · 新操场', lat: 23.008800, lng: 112.821800 },
  { key: 'dorm8', name: '山上8栋', locationName: '山上 8 栋楼下', address: '广职院 · 山上 8 栋', lat: 23.007200, lng: 112.820500 },
  { key: 'dorm12', name: '山上12栋', locationName: '山上 12 栋门口', address: '广职院 · 山上 12 栋', lat: 23.008100, lng: 112.821300 }
]

/** 两点间球面距离（米） */
function distanceMeters(lat1, lng1, lat2, lng2) {
  const R = 6371000
  const rad = d => (d * Math.PI) / 180
  const dLat = rad(lat2 - lat1)
  const dLng = rad(lng2 - lng1)
  const a = Math.sin(dLat / 2) ** 2 +
    Math.cos(rad(lat1)) * Math.cos(rad(lat2)) * Math.sin(dLng / 2) ** 2
  return Math.round(R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a)))
}

/**
 * 找离 (lat,lng) 最近的校内地点
 * @returns {{ spot: Object, distance: Number }}
 */
function nearest(lat, lng) {
  let best = null
  let bestD = Infinity
  SPOTS.forEach(s => {
    const d = distanceMeters(lat, lng, s.lat, s.lng)
    if (d < bestD) { bestD = d; best = s }
  })
  return best ? { spot: best, distance: bestD } : null
}

/** 按 key 取地点 */
function byKey(key) {
  return SPOTS.find(s => s.key === key) || null
}

/**
 * 判断坐标是否在校园范围内。
 *
 * ★ 安全策略：任务只能发布在校内。校外地点一旦出问题，校方无法及时处理。
 * @returns {{ inside: Boolean, distance: Number, radius: Number }}
 */
function isInside(lat, lng) {
  const d = distanceMeters(CENTER.lat, CENTER.lng, lat, lng)
  return { inside: d <= RADIUS, distance: d, radius: RADIUS }
}

module.exports = { CENTER, RADIUS, SPOTS, distanceMeters, nearest, byKey, isInside }
