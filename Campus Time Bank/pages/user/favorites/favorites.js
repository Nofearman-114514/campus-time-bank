/**
 * 我的收藏
 * ------------------------------------------------------------------
 * 入口：个人中心 → 我的收藏
 *   api.skill.myFavorites({ page, size }) → { list, total, hasMore, page }
 *
 * 列表按**收藏时间倒序**，每条技能附带 collectedTime（前端渲染成「x 天前收藏」）。
 * 取消收藏**就地移除**而不是整页重载 —— 用户可能已经翻了好几页，
 * 重载会把滚动位置和已加载的分页全丢掉。
 * ------------------------------------------------------------------
 */
const api = require('../../../utils/api')
const util = require('../../../utils/util')

const PAGE_SIZE = 10

Page({
  data: {
    list: [],
    page: 1,
    total: 0,
    hasMore: true,
    firstLoaded: false,
    loading: false,
    loadingMore: false,
    removing: false
  },

  /* ================================================================
   * 生命周期
   * ================================================================ */
  onLoad() {
    wx.setNavigationBarTitle({ title: '我的收藏' })
    this.loadList(true)
  },

  onPullDownRefresh() {
    this.loadList(true).then(() => wx.stopPullDownRefresh())
  },

  onReachBottom() {
    if (!this.data.hasMore || this.data.loading) return
    this.loadList(false)
  },

  /* ================================================================
   * 数据
   * ================================================================ */
  async loadList(reset) {
    if (this.data.loading) return
    const page = reset ? 1 : this.data.page + 1

    this.setData({ loading: true, loadingMore: !reset && this.data.list.length > 0 })

    try {
      const res = (await api.skill.myFavorites({ page: page, size: PAGE_SIZE })) || {}
      const rows = this.decorate(res.list || [])
      this.setData({
        list: reset ? rows : this.data.list.concat(rows),
        page: page,
        total: typeof res.total === 'number' ? res.total : rows.length,
        hasMore: !!res.hasMore
      })
    } catch (e) {
      util.toast(e.message)
      if (reset) this.setData({ list: [], hasMore: false })
    } finally {
      this.setData({ loading: false, loadingMore: false, firstLoaded: true })
    }
  },

  /** 补上「x 天前收藏」文案 */
  decorate(list) {
    return (list || []).map((item) => {
      const it = item || {}
      return Object.assign({}, it, { collectedText: agoText(it.collectedTime) })
    })
  },

  /* ================================================================
   * 交互
   * ================================================================ */
  onCard(e) {
    const item = (e.detail && e.detail.item) || {}
    if (!item._id) return
    wx.navigateTo({ url: `/pages/skill/detail/detail?id=${item._id}` })
  },

  async onRemove(e) {
    const id = e.currentTarget.dataset.id
    if (!id || this.data.removing) return

    this.setData({ removing: true })
    try {
      await api.skill.collect({ id: id, collected: false })
      util.toastOk('已取消收藏')
      const list = this.data.list.filter((x) => x._id !== id)
      this.setData({ list: list, total: Math.max(0, this.data.total - 1) })
    } catch (err) {
      util.toast(err.message)
    } finally {
      this.setData({ removing: false })
    }
  },

  onEmptyAction() {
    util.switchTab('/pages/square/square')
  }
})

/** 相对时间文案（列表里只需要天粒度的粗略感） */
function agoText(t) {
  if (!t) return ''
  const diff = Date.now() - new Date(t).getTime()
  if (isNaN(diff) || diff < 0) return ''
  const day = Math.floor(diff / 86400000)
  if (day <= 0) return '今天收藏'
  if (day === 1) return '昨天收藏'
  if (day < 30) return day + ' 天前收藏'
  return Math.floor(day / 30) + ' 个月前收藏'
}
