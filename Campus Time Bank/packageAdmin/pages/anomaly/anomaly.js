/**
 * 异常增长监控（风控）
 * ==================================================================
 * 接口：api.admin.anomalies
 *
 * ★ 为什么不看「排名突然上升」：卖出一个 20 枚的高价技能同样会让排名暴涨 ——
 *   那完全合法。排名只说明**结果**，说明不了**来源**。
 *   所以这里看的是**增长的结构**，核心判据是「前 2 个买家占总收入的比例」：
 *     · 收入来自 5 个不同买家 → 正常，他服务了 5 个人
 *     · 收入来自 2 个买家且占 80% 以上 → 可疑，这是「5 人供 1 人」的特征
 *
 * ★ 本页**只展示证据，不做处罚**。是否刷单要看聊天记录、评价内容才能判断 ——
 *   自动处罚一定会误伤良性固定搭子（长期教同一个学生，数据上和刷单一样）。
 *   判断权在管理员手里，处理去「用户管理 / 技能审核」。
 * ==================================================================
 */
const api = require('../../../utils/api')
const util = require('../../../utils/util')
const guard = require('../../utils/guard')

const RANGE_OPTIONS = [
  { v: 7, t: '近 7 天' },
  { v: 14, t: '近 14 天' },
  { v: 30, t: '近 30 天' }
]

Page({
  data: {
    days: 7,
    rangeOptions: RANGE_OPTIONS,
    list: [],
    scanned: 0,
    loading: true
  },

  onLoad() { this._boot() },

  async _boot() {
    const ok = await guard.requireAdmin(this)
    if (!ok) return
    this.load()
  },

  async load() {
    this.setData({ loading: true })
    try {
      const res = (await api.admin.anomalies({ days: this.data.days })) || {}
      const list = (res.list || []).map(it => Object.assign({}, it, {
        avatarText: (it.nickName || '?').slice(0, 1),
        shortId: (it.openid || '').slice(-6)
      }))
      this.setData({ list: list, scanned: Number(res.scanned || 0), loading: false })
    } catch (e) {
      this.setData({ loading: false })
      util.toast((e && e.message) || '加载失败')
    }
  },

  onRange(e) {
    const v = Number(e.currentTarget.dataset.v)
    if (v === this.data.days) return
    this.setData({ days: v, list: [] })
    this.load()
  },

  onPullDownRefresh() {
    this.load().then(() => wx.stopPullDownRefresh())
  },

  /** 看这个人 → 跳用户管理 */
  goUser(e) {
    const id = e.currentTarget.dataset.id
    wx.navigateTo({ url: '/packageAdmin/pages/users/users?keyword=' + encodeURIComponent(id) })
  },

  onShareAppMessage() {
    return { title: '校园时间银行 · 管理端', path: '/pages/square/square' }
  }
})
