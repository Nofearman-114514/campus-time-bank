/**
 * 通用工具方法
 */

/* ============================ 时间格式化 ============================ */
function pad(n) { return n < 10 ? '0' + n : '' + n }

/** Date | number | string → Date */
function toDate(v) {
  if (!v) return null
  if (v instanceof Date) return v
  if (typeof v === 'number') return new Date(v)
  // 兼容 iOS 不识别 "2025-06-01 12:00:00"
  return new Date(String(v).replace(/-/g, '/').replace(/T/, ' ').replace(/\..+/, ''))
}

/** 2025-06-01 */
function formatDate(v) {
  const d = toDate(v)
  if (!d || isNaN(d.getTime())) return ''
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

/** 2025-06-01 12:30 */
function formatTime(v, withSecond) {
  const d = toDate(v)
  if (!d || isNaN(d.getTime())) return ''
  const base = `${formatDate(d)} ${pad(d.getHours())}:${pad(d.getMinutes())}`
  return withSecond ? `${base}:${pad(d.getSeconds())}` : base
}

/** 06-01 12:30 */
function formatShort(v) {
  const d = toDate(v)
  if (!d || isNaN(d.getTime())) return ''
  return `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}

/** 12:30 */
function formatClock(v) {
  const d = toDate(v)
  if (!d || isNaN(d.getTime())) return ''
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`
}

/** 刚刚 / 5 分钟前 / 3 小时前 / 昨天 12:30 / 06-01 */
function fromNow(v) {
  const d = toDate(v)
  if (!d || isNaN(d.getTime())) return ''
  const diff = Date.now() - d.getTime()
  if (diff < 0) return formatShort(d)
  const min = Math.floor(diff / 60000)
  if (min < 1) return '刚刚'
  if (min < 60) return `${min} 分钟前`
  const hour = Math.floor(min / 60)
  if (hour < 24) return `${hour} 小时前`
  const day = Math.floor(hour / 24)
  if (day === 1) return `昨天 ${formatClock(d)}`
  if (day < 7) return `${day} 天前`
  return formatDate(d).slice(5)
}

/** 聊天时间分隔：今天 12:30 / 昨天 12:30 / 06-01 12:30 */
function chatTime(v) {
  const d = toDate(v)
  if (!d || isNaN(d.getTime())) return ''
  const now = new Date()
  const isSameDay = d.toDateString() === now.toDateString()
  if (isSameDay) return formatClock(d)
  const y = new Date(now.getTime() - 86400000)
  if (d.toDateString() === y.toDateString()) return `昨天 ${formatClock(d)}`
  return formatShort(d)
}

/** 倒计时文案：剩余 3 小时 20 分 */
function countdown(deadline) {
  const d = toDate(deadline)
  if (!d) return ''
  let diff = d.getTime() - Date.now()
  if (diff <= 0) return '已超时'
  const h = Math.floor(diff / 3600000)
  const m = Math.floor((diff % 3600000) / 60000)
  if (h >= 24) return `剩余 ${Math.floor(h / 24)} 天 ${h % 24} 小时`
  if (h > 0) return `剩余 ${h} 小时 ${m} 分`
  return `剩余 ${m} 分钟`
}

/* ============================ 交互封装 ============================ */
function toast(title, icon) {
  if (!title) return
  wx.showToast({ title: String(title).slice(0, 30), icon: icon || 'none', duration: 1800 })
}
function toastOk(title) { wx.showToast({ title: title || '操作成功', icon: 'success' }) }
function loading(title) { wx.showLoading({ title: title || '加载中', mask: true }) }
function hideLoading() { try { wx.hideLoading() } catch (e) {} }

/** 确认弹窗 → Promise<boolean> */
function confirm(content, title) {
  return new Promise(resolve => {
    wx.showModal({
      title: title || '提示',
      content: content || '',
      confirmColor: '#0EA47A',
      success: res => resolve(!!res.confirm),
      fail: () => resolve(false)
    })
  })
}

/** 输入弹窗 → Promise<string|null> */
function prompt(content, title, placeholder) {
  return new Promise(resolve => {
    wx.showModal({
      title: title || '请输入',
      content: content || '',
      editable: true,
      placeholderText: placeholder || '',
      confirmColor: '#0EA47A',
      success: res => resolve(res.confirm ? (res.content || '') : null),
      fail: () => resolve(null)
    })
  })
}

/** 底部动作菜单 → Promise<index|null> */
function actionSheet(itemList, itemColor) {
  return new Promise(resolve => {
    wx.showActionSheet({
      itemList,
      itemColor,
      success: res => resolve(res.tapIndex),
      fail: () => resolve(null)
    })
  })
}

/* ============================ 函数工具 ============================ */
function debounce(fn, wait) {
  let timer = null
  return function () {
    const args = arguments
    const ctx = this
    if (timer) clearTimeout(timer)
    timer = setTimeout(() => { timer = null; fn.apply(ctx, args) }, wait || 300)
  }
}
function throttle(fn, wait) {
  let last = 0
  return function () {
    const now = Date.now()
    if (now - last < (wait || 500)) return
    last = now
    return fn.apply(this, arguments)
  }
}
function sleep(ms) { return new Promise(r => setTimeout(r, ms)) }
function deepClone(obj) { return obj === undefined ? obj : JSON.parse(JSON.stringify(obj)) }

/* ============================ 校验 ============================ */
/** 手机号（中国大陆） */
function isPhone(v) { return /^1[3-9]\d{9}$/.test(String(v || '')) }
/** 学号：4~20 位数字或字母 */
function isStudentNo(v) { return /^[A-Za-z0-9]{4,20}$/.test(String(v || '')) }
/** 时间币金额：1~999 的整数 */
function isValidCoin(v) { return /^\d+$/.test(String(v)) && +v >= 1 && +v <= 999 }
/** 去除首尾空白与连续空格 */
function trimAll(v) { return String(v == null ? '' : v).trim().replace(/\s+/g, ' ') }

/* ============================ 云存储上传 ============================ */
/**
 * 上传图片到云存储
 * @param {String} filePath 本地临时路径
 * @param {String} dir      云端目录，如 'skill' | 'auth' | 'chat'
 * @returns {Promise<String>} fileID
 */
async function uploadFile(filePath, dir) {
  const ext = (filePath.split('.').pop() || 'png').toLowerCase()
  const cloudPath = `${dir || 'common'}/${Date.now()}-${Math.floor(Math.random() * 1e6)}.${ext}`
  const res = await wx.cloud.uploadFile({ cloudPath, filePath })
  return res.fileID
}

/**
 * 选择图片（含压缩提示）
 * @returns {Promise<String[]>} 本地临时路径数组
 */
function chooseImage(count, sourceType) {
  return new Promise((resolve, reject) => {
    wx.chooseMedia({
      count: count || 1,
      mediaType: ['image'],
      sourceType: sourceType || ['album', 'camera'],
      sizeType: ['compressed'],
      success: res => resolve(res.tempFiles.map(f => f.tempFilePath)),
      fail: err => {
        if (err && /cancel/.test(err.errMsg || '')) resolve([])
        else reject(err)
      }
    })
  })
}

/** fileID / cloud:// 批量转临时链接（image 组件可直接用 cloud://，此处供 canvas 等场景） */
async function getTempFileURL(fileIDs) {
  const ids = (Array.isArray(fileIDs) ? fileIDs : [fileIDs]).filter(Boolean)
  if (!ids.length) return {}
  const res = await wx.cloud.getTempFileURL({ fileList: ids })
  const map = {}
  res.fileList.forEach(f => { map[f.fileID] = f.tempFileURL })
  return map
}

/* ============================ 位置 ============================ */
/** 获取当前位置 → { longitude, latitude } */
function getLocation() {
  return new Promise((resolve, reject) => {
    wx.getLocation({
      type: 'gcj02',
      isHighAccuracy: false,
      success: res => resolve({ longitude: res.longitude, latitude: res.latitude }),
      fail: err => reject(err)
    })
  })
}
/** 地图选点 → { name, address, latitude, longitude } */
function chooseLocation() {
  return new Promise((resolve, reject) => {
    wx.chooseLocation({
      success: res => resolve({
        name: res.name || '',
        address: res.address || '',
        latitude: res.latitude,
        longitude: res.longitude
      }),
      fail: err => {
        if (err && /cancel/.test(err.errMsg || '')) resolve(null)
        else reject(err)
      }
    })
  })
}

/** 两个坐标间直线距离（米） */
function distance(lat1, lng1, lat2, lng2) {
  if ([lat1, lng1, lat2, lng2].some(v => v === undefined || v === null || isNaN(v))) return null
  const R = 6371000
  const rad = d => d * Math.PI / 180
  const dLat = rad(lat2 - lat1)
  const dLng = rad(lng2 - lng1)
  const a = Math.sin(dLat / 2) ** 2 +
    Math.cos(rad(lat1)) * Math.cos(rad(lat2)) * Math.sin(dLng / 2) ** 2
  return Math.round(R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a)))
}

/** 距离友好文案 */
function distanceText(meters) {
  if (meters === null || meters === undefined) return ''
  if (meters < 100) return '100m 内'
  if (meters < 1000) return `${Math.round(meters / 10) * 10}m`
  return `${(meters / 1000).toFixed(1)}km`
}

/* ============================ 导航 ============================ */
function navTo(url) {
  if (!url) return
  wx.navigateTo({ url, fail: () => wx.switchTab({ url }) })
}
function redirectTo(url) { wx.redirectTo({ url }) }
function navBack(delta) { wx.navigateBack({ delta: delta || 1 }) }
function switchTab(url) { wx.switchTab({ url }) }

/* ============================ 其它 ============================ */
function copyText(text, tip) {
  wx.setClipboardData({
    data: String(text || ''),
    success: () => toast(tip || '已复制')
  })
}
function callPhone(phone) {
  if (!phone) return toast('暂无联系方式')
  wx.makePhoneCall({ phoneNumber: String(phone), fail: () => {} })
}
/** 预览图片，支持 cloud:// */
function previewImage(urls, current) {
  const list = (Array.isArray(urls) ? urls : [urls]).filter(Boolean)
  if (!list.length) return
  wx.previewImage({ urls: list, current: current || list[0] })
}
/** 数组去重（基本类型） */
function unique(arr) { return Array.from(new Set(arr || [])) }
/** 数字限幅 */
function clamp(n, min, max) { return Math.min(Math.max(Number(n) || 0, min), max) }
/** 星星数组，用于 wxml 渲染 */
function starArray(score) {
  const s = Math.round(Number(score) || 0)
  return [1, 2, 3, 4, 5].map(i => i <= s)
}

module.exports = {
  pad, toDate, formatDate, formatTime, formatShort, formatClock, fromNow, chatTime, countdown,
  toast, toastOk, loading, hideLoading, confirm, prompt, actionSheet,
  debounce, throttle, sleep, deepClone,
  isPhone, isStudentNo, isValidCoin, trimAll,
  uploadFile, chooseImage, getTempFileURL,
  getLocation, chooseLocation, distance, distanceText,
  navTo, redirectTo, navBack, switchTab,
  copyText, callPhone, previewImage, unique, clamp, starArray
}
