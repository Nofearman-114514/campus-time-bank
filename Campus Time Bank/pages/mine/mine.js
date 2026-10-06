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
  /** 贡献榜：按累计收入排名 */
  goRank() { this.go('/pages/rank/rank') },
  /** 我的申诉：查看已提交的申诉与处理结果 */
  goAppeal() { this.go('/pages/appeal/appeal') },

  /** 钱包 / 订单是 tab 页，必须 switchTab */
  goWallet() { util.switchTab(TAB_WALLET) },
  goOrders() { util.switchTab(TAB_ORDER) },

  /**
   * 注销账号（不可逆）。
   *
   * ★ 为什么不做成「退出登录」：
   *   微信小程序**没有登录态** —— 身份来自 wx.login 的 openid，与微信号绑定，
   *   退出后再次进入仍是同一人。所以「退出登录」本质上是个无效按钮。
   *   而「注销账号」是真正有意义、且法律上要求提供的功能（删除个人信息）。
   *
   * ★ 为什么三步确认，而且**每一步说不同的话**：
   *   如果三个弹窗都是「确定吗」，用户会形成连点三下的肌肉记忆 ——
   *   第三步反而变成最容易误点的一步，等于白加了两道关。
   *   真正打断反射的是中间那步「动手输入短语」。
   *   所以这里：① 讲清楚后果 → ② 输入短语 → ③ 不可撤回的最终确认。
   */
  async onCancelAccount() {
    if (this._canceling) return

    /* ---------- 第一步：说清楚会发生什么（不是笼统的「确定吗」） ---------- */
    const ok1 = await util.confirm(
      '【会被清除】\n' +
      '· 昵称、头像、姓名、学号、手机号\n' +
      '· 院系、专业、年级、简介、标签\n' +
      '· 校园认证材料\n' +
      '\n' +
      '【会被保留】\n' +
      '· 你参与过的订单与评价\n' +
      '  （对方的记录不能凭空消失）\n' +
      '· 时间币与信用分\n' +
      '\n' +
      '账号将无法再登录，且不可恢复。',
      '注销账号'
    )
    if (!ok1) return

    /* ---------- 第二步：输入短语（真正的那道关） ---------- */
    const PHRASE = '我确定要注销此账号'
    /*
     * ★ 说明必须放在 title 里 —— 放 content 会被预填进输入框，
     *   那样用户什么都不用输，这道关就没了。
     *   第三个参数是「初始值」，这里**不传**（留空）。
     *
     * 短语前加 \n：让它在单独一行，用户照着打的时候不会看串行。
     */
    const typed = await util.prompt('请输入下面的短语以确认：\n' + PHRASE, '在此输入', '')
    if (typed === null) return
    if (String(typed).trim() !== PHRASE) {
      return util.toast('输入不一致，已取消')
    }

    /* ---------- 第三步：不可撤回的最终确认 ---------- */
    const ok3 = await util.confirm(
      '此操作无法撤回。\n' +
      '\n' +
      '· 账号立即失效，无法再登录\n' +
      '· 本机缓存的资料一并清除\n' +
      '· 没有任何恢复途径',
      '最后确认'
    )
    if (!ok3) return

    this._canceling = true
    try {
      await api.user.cancel({})
      // 本地状态一并清掉，否则页面上还挂着已注销的资料
      const app = getApp()
      if (app && app.globalData) {
        app.globalData.userInfo = null
        app.globalData.isAdmin = false
        app.globalData.isDebugger = false
        app.globalData.openid = ''
        app.globalData.role = 'user'
        app.globalData._loginTask = null
      }
      try { wx.removeStorageSync('pickedLocation') } catch (e) { /* 忽略 */ }
      try { api.setToken('') } catch (e) { /* 忽略 */ }
      util.toastOk('账号已注销')
      setTimeout(() => wx.reLaunch({ url: '/pages/square/square' }), 900)
    } catch (e) {
      this._canceling = false
      // 例如「还有进行中的订单」—— 文案来自云端，直接透出
      util.toast((e && e.message) || '注销失败')
    }
  },

  onShareAppMessage() {
    return { title: '校园时间银行 · 用技能换技能', path: '/pages/square/square' }
  }
})
