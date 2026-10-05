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
const CENTER = { lat: 23.001079, lng: 112.823601 }

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
const RADIUS = 700

/** 校内地点：key 唯一，name 是短标签（按钮上显示），locationName/address 与技能字段对齐 */
const SPOTS = [
  { key: 'dorm1', name: '1栋', locationName: '学生公寓 1 栋楼下', address: '广职院 · 学生公寓 1 栋', lat: 23.001079, lng: 112.823601 },
  { key: 'canteenS', name: '山下饭堂', locationName: '山下饭堂一楼', address: '广职院 · 山下饭堂', lat: 23.000554, lng: 112.823584 },
  { key: 'bldgB', name: '教学楼B1', locationName: '教学楼 B1 楼', address: '广职院 · 教学楼 B1', lat: 23.000751, lng: 112.821652 },
  { key: 'train1', name: '实训楼1号', locationName: '实训楼 1 号', address: '广职院 · 实训楼 1 号', lat: 22.999123, lng: 112.823408 },
  { key: 'canteenN', name: '山上饭堂', locationName: '山上饭堂二楼', address: '广职院 · 山上饭堂', lat: 23.001627, lng: 112.821381 },
  { key: 'lake', name: '学子湖', locationName: '学子湖边', address: '广职院 · 学子湖', lat: 22.999801, lng: 112.821641 },
  { key: 'newField', name: '新操场', locationName: '新操场田径场', address: '广职院 · 新操场', lat: 22.998165, lng: 112.823102 },
  { key: 'library', name: '图书馆', locationName: '图书馆一楼大厅', address: '广职院 · 图书馆', lat: 23.000436, lng: 112.820359 }
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

/**
 * 把各种「坐标」值统一成 { lng, lat }；没有有效坐标时返回 null。
 *
 * ★ 为什么必须有这个函数：
 *   云端 `db.Geo.Point(lng, lat)` 经 wx.cloud 序列化回来是 **GeoJSON**：
 *       { type: 'Point', coordinates: [经度, 纬度] }
 *   它**没有** `.latitude` / `.longitude` 属性 —— 直接读会永远是 undefined，
 *   于是 `hasGeo` 恒为 false、「在地图中查看」按钮永远不出现。
 *   （旧种子数据的 location 是 null，所以这个错配一直没被触发。）
 *
 * ★ 两种格式都要能吃：
 *   · GeoJSON：{ type:'Point', coordinates:[lng, lat] }  ← 云端数据库
 *   · 普通对象：{ latitude, longitude }                    ← wx.getLocation()
 *
 * ★ coordinates 是 **[经度, 纬度]**（GeoJSON 规范），顺序不能反。
 */
function parseGeoPoint(g) {
  if (!g) return null
  let lng, lat
  if (Array.isArray(g.coordinates) && g.coordinates.length >= 2) {
    lng = Number(g.coordinates[0])
    lat = Number(g.coordinates[1])
  } else {
    lng = Number(g.longitude)
    lat = Number(g.latitude)
  }
  if (!isFinite(lng) || !isFinite(lat)) return null
  if (lng < -180 || lng > 180 || lat < -90 || lat > 90) return null
  return { lng, lat }
}

module.exports = { CENTER, RADIUS, SPOTS, distanceMeters, nearest, byKey, isInside, parseGeoPoint }
