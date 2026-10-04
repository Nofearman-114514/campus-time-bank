/**
 * 腾讯位置服务（可选增强）
 * ------------------------------------------------------------------
 * 本项目「附近技能」与「地图选点」全部使用云开发原生地理能力 +
 * wx.chooseLocation，**不依赖任何第三方 Key 即可完整运行**。
 *
 * 只有需要「坐标 → 中文地址」的逆地址解析时才用到这里。
 * 在 miniprogram/envList.js 填入 QQMAP_KEY 后自动生效；未填则返回 null。
 * ------------------------------------------------------------------
 */
const { QQMAP_KEY } = require('../envList')

const HOST = 'https://apis.map.qq.com'

function available() { return !!QQMAP_KEY }

/** 通用请求（域名需在「开发设置 → 服务器域名 → request 合法域名」中配置） */
function request(path, data) {
  return new Promise((resolve, reject) => {
    if (!QQMAP_KEY) {
      return reject(new Error('未配置腾讯位置服务 Key'))
    }
    wx.request({
      url: HOST + path,
      data: Object.assign({ key: QQMAP_KEY }, data || {}),
      method: 'GET',
      success(res) {
        const d = res.data || {}
        if (d.status === 0) resolve(d)
        else reject(new Error(d.message || '位置服务请求失败'))
      },
      fail(err) {
        reject(new Error(err.errMsg || '位置服务网络异常'))
      }
    })
  })
}

/**
 * 逆地址解析：坐标 → 地址文案
 * @returns {Promise<{address:String, shortName:String, city:String}|null>} 失败返回 null（不抛错）
 */
async function reverseGeocoder(latitude, longitude) {
  try {
    const res = await request('/ws/geocoder/v1/', {
      location: `${latitude},${longitude}`,
      get_poi: 0
    })
    const r = res.result || {}
    return {
      address: r.address || '',
      shortName: (r.formatted_addresses && r.formatted_addresses.recommend) || r.address || '',
      city: (r.address_component && r.address_component.city) || ''
    }
  } catch (e) {
    console.warn('[qqmap] 逆地址解析失败：', e.message)
    return null
  }
}

/**
 * 关键词 → 地点联想（地图选点增强，一般用不到，wx.chooseLocation 已够用）
 */
async function suggestion(keyword, city) {
  try {
    const res = await request('/ws/place/v1/suggestion/', {
      keyword,
      region: city || '',
      page_size: 10
    })
    return (res.data || []).map(i => ({
      title: i.title,
      address: i.address,
      latitude: i.location.lat,
      longitude: i.location.lng
    }))
  } catch (e) {
    return []
  }
}

module.exports = { available, request, reverseGeocoder, suggestion }
