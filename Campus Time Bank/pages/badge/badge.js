/**
 * 徽章墙
 * ------------------------------------------------------------------
 * 顶部：已点亮 N / 总数 + 进度条（credit.badgeProgress）
 * 主体：<badge-wall cols="{{2}}" showDesc list all ownedList owned />
 *       2 列卡片式：大 emoji + 名称 + 获得条件；已获得彩色，未获得置灰
 * 数据：api.user.badges() → { owned, all }
 * ------------------------------------------------------------------
 */
const api = require('../../utils/api')
const util = require('../../utils/util')
const credit = require('../../utils/credit')

Page({
  data: {
    all: [],          // 全部徽章（带 owned 标记）
    owned: [],        // 已获得的徽章 id 数组
    ownedCount: 0,
    total: 0,
    percent: 0,
    loading: true
  },

  onLoad() {
    this.loadBadges()
  },

  async loadBadges() {
    this.setData({ loading: true })
    try {
      const res = await api.user.badges({}) || {}
      const all = res.all || []
      // owned 兼容两种返回：徽章对象数组 / id 字符串数组
      const ownedList = (res.owned || []).map(b => (typeof b === 'string' ? b : (b && b.id)))
      // 兜底：全空时用 credit.js 的本地规则生成一遍，保证页面永远有内容
      const finalAll = all.length ? all : credit.badgeWall(ownedList)
      const ids = finalAll.filter(b => b.owned || ownedList.indexOf(b.id) > -1).map(b => b.id)
      const progress = credit.badgeProgress(ids)

      this.setData({
        all: finalAll,
        owned: ids,
        ownedCount: progress.owned,
        total: progress.total,
        percent: progress.percent
      })
      wx.setNavigationBarTitle({ title: `徽章墙（${progress.owned}/${progress.total}）` })
    } catch (e) {
      // 接口失败时退化为「全部未点亮」，不影响页面展示
      const fallback = credit.badgeWall([])
      const p = credit.badgeProgress([])
      this.setData({
        all: fallback,
        owned: [],
        ownedCount: p.owned,
        total: p.total,
        percent: p.percent
      })
      util.toast(e.message)
    } finally {
      this.setData({ loading: false })
    }
  },

  /** 点击徽章：提示获取条件 */
  onBadge(e) {
    const b = (e.detail && e.detail.badge) || {}
    if (!b.name) return
    if (b.owned) util.toast(`已点亮「${b.name}」`)
    else util.toast(`未点亮：${b.desc || '继续互助即可获得'}`)
  },

  /** 去广场做一单，点亮更多徽章 */
  goSquare() {
    wx.switchTab({ url: '/pages/square/square' })
  },

  onShareAppMessage() {
    return {
      title: `我已经点亮 ${this.data.ownedCount} 枚校园时间银行徽章`,
      path: '/pages/square/square'
    }
  }
})
