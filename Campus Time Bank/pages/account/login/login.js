/**
 * 内部账户登录
 * ==================================================================
 * ★ 这条通道只给**内部账户**（校方 / 运维）用 —— 它们的账号不属于
 *   任何个人微信号，所以需要账号 + 密码。
 *
 *   普通用户不需要来这里：小程序启动时会用 wx.login 静默登录，
 *   身份与微信号绑定，没有密码这回事。
 *
 * ★ 登录成功后令牌存在本地（utils/api.js 的 TOKEN_KEY），
 *   api 层会自动把它附在每个请求上，云端据此把身份换成该账户。
 * ==================================================================
 */
const api = require('../../../utils/api')
const util = require('../../../utils/util')

Page({
  data: {
    username: '',
    password: '',
    showPwd: false,
    submitting: false,
    /** 当前是否已经以内部账户登录 */
    current: null
  },

  onLoad() {
    this.refreshCurrent()
  },

  /** 看看现在是不是已经以某个内部账户登录了 */
  async refreshCurrent() {
    try {
      const res = await api.account.me({})
      this.setData({ current: (res && res.account) ? res : null })
    } catch (e) {
      this.setData({ current: null })
    }
  },

  onUsername(e) { this.setData({ username: e.detail.value }) },
  onPassword(e) { this.setData({ password: e.detail.value }) },
  onTogglePwd() { this.setData({ showPwd: !this.data.showPwd }) },

  async onSubmit() {
    if (this.data.submitting) return
    const username = String(this.data.username || '').trim()
    const password = String(this.data.password || '')
    if (!username) return util.toast('请输入账号')
    if (!password) return util.toast('请输入密码')

    this.setData({ submitting: true })
    try {
      const res = await api.account.login({ username, password })
      util.toastOk('已登录：' + (res.nickName || username))
      // 身份变了，全局态要重来一遍：reLaunch 会重建页面并按新身份取数
      setTimeout(() => {
        const app = getApp()
        if (app && app.globalData) {
          app.globalData.isAdmin = !!res.isAdmin
          app.globalData.isDebugger = !!res.isDebugger
          app.globalData.role = res.role || 'user'
        }
        wx.reLaunch({ url: '/pages/mine/mine' })
      }, 600)
    } catch (e) {
      this.setData({ submitting: false })
      util.toast((e && e.message) || '登录失败')
    }
  },

  /** 退出当前内部账户，回到微信身份 */
  async onLogout() {
    const ok = await util.confirm(
      '将退出当前内部账户，回到你自己的微信身份。\n\n注意：微信身份与你的微信号绑定，无法切换成别人。',
      '退出内部账户'
    )
    if (!ok) return
    await api.account.logout()
    const app = getApp()
    if (app && app.globalData) {
      app.globalData.isAdmin = false
      app.globalData.isDebugger = false
      app.globalData.role = 'user'
    }
    util.toastOk('已退出')
    setTimeout(() => wx.reLaunch({ url: '/pages/mine/mine' }), 500)
  }
})
