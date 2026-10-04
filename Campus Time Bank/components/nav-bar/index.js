/**
 * 自定义导航栏
 * ------------------------------------------------------------------
 * 仅用于需要彩色/渐变头部的页面（个人主页、徽章墙等）。
 * 使用前请在页面 json 里设置 `"navigationStyle": "custom"`。
 *
 * <nav-bar title="我的主页" bg="linear-gradient(135deg,#12B98A,#0B8A66)" color="#fff" showBack />
 * ------------------------------------------------------------------
 */
const app = getApp()

Component({
  options: { addGlobalClass: true, multipleSlots: true },

  properties: {
    title: { type: String, value: '' },
    /** 背景色 / 渐变 */
    bg: { type: String, value: '#FFFFFF' },
    color: { type: String, value: '#1A1D1F' },
    showBack: { type: Boolean, value: true },
    /** 是否固定定位 */
    fixed: { type: Boolean, value: true },
    /** 是否输出一个等高的占位块（固定定位时防止内容被遮挡） */
    placeholder: { type: Boolean, value: true },
    /** 首页样式：返回按钮变成「🏠」 */
    backIcon: { type: String, value: '‹' }
  },

  data: {
    statusBarHeight: 20,
    navBarHeight: 44,
    totalHeight: 64
  },

  lifetimes: {
    attached() {
      const g = (app && app.globalData) || {}
      const s = g.statusBarHeight || 20
      const n = g.navBarHeight || 44
      this.setData({
        statusBarHeight: s,
        navBarHeight: n,
        totalHeight: s + n
      })
    }
  },

  methods: {
    onBack() {
      const pages = getCurrentPages()
      if (pages.length > 1) wx.navigateBack({ delta: 1 })
      else wx.switchTab({ url: '/pages/square/square' })
    }
  }
})
