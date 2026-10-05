/**
 * 个人中心（tab ④）
 * ------------------------------------------------------------------
 * 结构：渐变顶部 + 压在顶部的个人卡 → 认证状态条 → 数据三宫格
 *       → 徽章条 → 功能列表 → 时间币免责小字
 * 说明：认证状态 / 余额 / 未读数都会变，因此**每次 onShow 都刷新**。
 * 所有网络请求走 utils/api.js；样式只用 CSS 变量 + styles/common.wxss 原子类。
 * ------------------------------------------------------------------
 */
const api = require('../../utils/api')
const util = require('../../utils/util')
const credit = require('../../utils/credit')
const constants = require('../../utils/constants')

const TAB_WALLET = '/pages/wallet/wallet'
const TAB_ORDER = '/pages/order/list/list'

Page({
  data: {
    loading: true,

    user: {},
    counts: {},
    badges: [],          // 已获得的徽章（Badge 对象数组）
    badgeCount: 0,
    auth: constants.AUTH_STATUS[0],
    creditLevel: null,   // 信用等级（文案 + 配色 key）
    doneCount: 0,        // 完成订单数 = 提供服务 + 购买服务
    reviewCount: 0,      // 收到的评价数（counts.review 缺失时回落到 user.stats.reviewCount）
    schoolLine: '',
    isAdmin: false,

    unreadChat: 0,
    unreadNotice: 0
  },

  /* ================================================================
   * 生命周期
   * ================================================================ */
  onShow() {
    const app = getApp()
    // 自定义 tabBar 必须同步选中态
    app.selectTab(this, 3)
    this.refresh()
  },

  onPullDownRefresh() {
    this.refresh().then(() => wx.stopPullDownRefresh())
  },

  /* ================================================================
   * 数据
   * ================================================================ */
  async refresh() {
    const app = getApp()

    // ① 先强制刷新登录态：管理员可能刚审核通过认证 / 余额可能已变化
    try {
      await app.refreshUser()
    } catch (e) {
      // 登录失败不阻断，下面用 globalData.userInfo 兜底渲染
    }

    // ② 个人中心聚合数据
    try {
      const res = await api.user.mine({})
      this.apply(res || {})
    } catch (e) {
      util.toast(e.message)
      this.apply({ user: app.globalData.userInfo || {} })
    } finally {
      this.setData({ loading: false })
    }

    // ③ 未读数（消息 + 通知），失败静默，不影响主流程
    try {
      const un = await api.message.unreadTotal({})
      this.setData({
        unreadChat: (un && un.chat) || 0,
        unreadNotice: (un && un.notice) || 0
      })
    } catch (e) { /* 忽略 */ }

    // ④ 管理员标记（带缓存，内部已 try/catch）
    const isAdmin = await app.isAdminUser()
    this.setData({ isAdmin: !!isAdmin })

    // ⑤ 顺手刷新 tabBar 角标
    try { app.refreshTabBadge() } catch (e) { /* 忽略 */ }
  },

  /** 统一落数据（setData 前全部兜底，禁止 undefined 进 data） */
  apply(res) {
    const user = (res && res.user) || {}
    const counts = (res && res.counts) || {}
    const badges = ((res && res.badges) || []).filter(Boolean)
    const school = [user.campus, user.college, user.grade].filter(Boolean)
    const stats = user.stats || {}

    this.setData({
      user: user,
      counts: counts,
      badges: badges,
      badgeCount: badges.length,
      auth: constants.AUTH_STATUS[user.authStatus] || constants.AUTH_STATUS[0],
      creditLevel: credit.getLevel(user.creditScore === undefined ? 100 : user.creditScore),
      doneCount: (counts.serve || 0) + (counts.buy || 0),
      // 契约 §4.5 的 counts 未含 review，缺失时用 stats.reviewCount 兜底
      reviewCount: typeof counts.review === 'number' ? counts.review : (stats.reviewCount || 0),
      schoolLine: school.join(' · '),
      unreadNotice: typeof counts.unreadNotice === 'number' ? counts.unreadNotice : 0
    })
  },

  /* ================================================================
   * 跳转
   * ================================================================ */
  /** 默认导航式的跳转，失败时提示（避免点了没反应） */
  go(url) {
    wx.navigateTo({ url: url, fail: () => util.toast('页面打开失败') })
  },

  goProfile() { this.go('/pages/user/profile/profile') },
  goAuth() { this.go('/pages/auth/campus/campus') },
  goCredit() { this.go('/pages/credit/detail/detail') },
  goBadge() { this.go('/pages/badge/badge') },
  goAbout() { this.go('/pages/about/about') },
  goPublish() { this.go('/pages/user/skills/skills?type=publish') },
  goAccept() { this.go('/pages/user/skills/skills?type=accept') },
  goFavorites() { this.go('/pages/user/favorites/favorites') },
  goReview() { this.go('/pages/review/list/list') },
  goChat() { this.go('/pages/chat/list/list') },
  goNotice() { this.go('/pages/notice/list/list') },
  /** 管理端在分包里，同样用 navigateTo */
  goAdmin() { this.go('/packageAdmin/pages/dashboard/dashboard') },
  /** 内部账户登录（校方/运维）：账号密码，不绑定微信号 */
  goAccountLogin() { this.go('/pages/account/login/login') },

  /** 钱包 / 订单是 tab 页，必须 switchTab */
  goWallet() { util.switchTab(TAB_WALLET) },
  goOrders() { util.switchTab(TAB_ORDER) },

  /**
   * 退出登录。
   *
   * ★ 必须说清楚的技术事实：
   *   微信小程序**没有传统的登录态** —— 身份来自 wx.login 换到的 openid，
   *   它与你的微信号绑定，无法「登出」成另一个人。
   *   所以这里的「退出」= 清空本机业务缓存 + 清空内存里的用户态 + 强制重新登录一次。
   *   实际效果：拿到最新的用户资料（例如管理员刚通过了你的校园认证）。
   *   确认弹窗里把这一点如实告诉用户，避免造成「能换账号」的误解。
   */
  onLogout() {
    wx.showModal({
      title: '退出登录',
      content: '将清除本机缓存并重新获取你的微信身份。\n\n注意：小程序账号与你的微信号绑定，退出后再次进入仍是同一账号。',
      confirmText: '退出',
      confirmColor: '#E5484D',
      success: res => {
        if (!res.confirm) return
        // 只清业务缓存，保留设备级设置（例如管理员开的调试模式）
        try { wx.removeStorageSync('pickedLocation') } catch (e) { /* 忽略 */ }
        /*
         * ★ 内部账户令牌必须一起清。
         *   否则「退出登录」只是清了个缓存 —— 下一个请求仍会带着令牌，
         *   云端照样以那个内部账户的身份操作，等于没退。
         */
        try { require('../../utils/api').setToken('') } catch (e) { /* 忽略 */ }
        const app = getApp()
        if (app && app.globalData) {
          app.globalData.userInfo = null
          app.globalData.isAdmin = false
          app.globalData.openid = ''
        }
        util.toastOk('已退出')
        // reLaunch 回首页 → onLaunch 会重新走一次 login，身份与配置都刷新
        setTimeout(() => wx.reLaunch({ url: '/pages/square/square' }), 500)
      }
    })
  },

  onShareAppMessage() {
    return { title: '校园时间银行 · 用技能换技能', path: '/pages/square/square' }
  }
})
