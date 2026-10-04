/**
 * 自定义 tabBar
 * ------------------------------------------------------------------
 * 4 个真实 tab（广场 / 订单 / 时间币 / 我的）+ 中间凸起的「发布」按钮。
 * 「发布」不是 tab 页，点击后 navigateTo 到 pages/publish/publish。
 *
 * 页面里要同步选中态：
 *   onShow() { const app = getApp(); app.selectTab(this, 0) }
 * ------------------------------------------------------------------
 */
const app = getApp()

Component({
  options: {
    addGlobalClass: true
  },

  data: {
    selected: 0,
    badge: {},          // { 1: 待办数, 3: 未读数 }
    list: [
      { index: 0, pagePath: '/pages/square/square', text: '广场', icon: '🔍' },
      { index: 1, pagePath: '/pages/order/list/list', text: '订单', icon: '📋' },
      { index: 2, pagePath: '/pages/wallet/wallet', text: '时间币', icon: '🪙' },
      { index: 3, pagePath: '/pages/mine/mine', text: '我的', icon: '👤' }
    ]
  },

  lifetimes: {
    attached() {
      // 挂载后拉一次角标（只拉一次，避免每个 tab 页都请求）
      const a = getApp()
      if (a && a.refreshTabBadge) a.refreshTabBadge()
    }
  },

  methods: {
    onTab(e) {
      const index = Number(e.currentTarget.dataset.index)
      const path = e.currentTarget.dataset.path
      if (index === this.data.selected) return
      wx.switchTab({
        url: path,
        success: () => this.setData({ selected: index })
      })
    },

    onPublish() {
      wx.navigateTo({
        url: '/pages/publish/publish',
        fail: err => {
          console.warn('[tabbar] 跳转发布页失败', err)
          wx.showToast({ title: '发布页打开失败', icon: 'none' })
        }
      })
    }
  }
})
