/**
 * 校园时间银行 —— 小程序入口
 * ==================================================================
 * 职责：
 *   1. 初始化云开发（离线模式下跳过）
 *   2. 全局登录态管理（并发登录合并、失败重试）
 *   3. 全局配置 / 定位 / 管理员标记缓存
 *   4. 简易事件总线，用于跨页刷新（如发布成功后广场刷新）
 * ==================================================================
 */
const envList = require('./envList')
const cloud = require('./utils/cloud')

App({
  globalData: {
    /* 运行环境 */
    // ★ 调试模式是运行时开关（管理员在设置页切换），所以每次读写都重新求值
  get MOCK() { return envList.isMock() },
    DEBUG: envList.DEBUG,

    /* 用户态 */
    userInfo: null,        // users 文档
    isAdmin: false,
    openid: '',

    /* 全局配置（config 集合） */
    config: {
      registerBonus: 5,
      orderExpireHours: 24,
      confirmExpireHours: 72,
      minCreditToOrder: 60,
      serviceFee: 0,
      aboutUs: ''
    },

    /* 定位 */
    location: null,        // { longitude, latitude }
    locationName: '',
    locationDenied: false,

    /* 设备信息 */
    systemInfo: null,
    statusBarHeight: 20,
    navBarHeight: 44,
    safeBottom: 0,

    /* 订阅消息模板 */
    templates: {},

    /* 内部：并发登录合并 */
    _loginTask: null,
    /* 内部：事件总线 */
    _bus: {}
  },

  /* ================================================================
   * 生命周期
   * ================================================================ */
  onLaunch() {
    this._initSystem()
    cloud.initCloud()

    if (this.globalData.MOCK) {
      console.warn(
        '%c[校园时间银行] 当前为【离线预览模式】\n' +
        '未检测到云开发环境 ID，正在使用内置模拟数据。\n' +
        '接入真实后端：打开 miniprogram/envList.js 填写 ENV_ID。',
        'color:#0EA47A;font-weight:bold'
      )
    }

    // 静默登录（不阻塞首屏，失败也不弹窗）
    this.login().catch(e => {
      console.warn('[app] 静默登录失败：', e.message)
    })

    this._watchNetwork()
  },

  onShow() {
    // 从后台回前台，刷新一次用户信息（可能有管理员审核结果）
    if (this.globalData.userInfo) {
      this.refreshUser().catch(() => {})
    }
  },

  onError(err) {
    console.error('[app onError]', err)
  },

  onUnhandledRejection(res) {
    console.warn('[app unhandledRejection]', res && res.reason)
  },

  /* ================================================================
   * 系统信息
   * ================================================================ */
  _initSystem() {
    let win = {}
    let dev = {}
    let base = {}
    try {
      win = wx.getWindowInfo ? wx.getWindowInfo() : wx.getSystemInfoSync()
      dev = wx.getDeviceInfo ? wx.getDeviceInfo() : wx.getSystemInfoSync()
      base = wx.getAppBaseInfo ? wx.getAppBaseInfo() : wx.getSystemInfoSync()
    } catch (e) {
      win = wx.getSystemInfoSync()
      dev = win
      base = win
    }

    const statusBarHeight = win.statusBarHeight || 20
    const safeArea = win.safeArea || {}
    const screenHeight = win.screenHeight || 0
    const safeBottom = safeArea.bottom && screenHeight ? Math.max(0, screenHeight - safeArea.bottom) : 0

    // 胶囊按钮位置 → 计算自定义导航栏高度
    let navBarHeight = 44
    try {
      const menu = wx.getMenuButtonBoundingClientRect()
      if (menu && menu.height) {
        navBarHeight = (menu.top - statusBarHeight) * 2 + menu.height
      }
    } catch (e) { /* ignore */ }

    this.globalData.systemInfo = Object.assign({}, dev, base, {
      windowWidth: win.windowWidth,
      windowHeight: win.windowHeight,
      screenHeight,
      safeArea
    })
    this.globalData.statusBarHeight = statusBarHeight
    this.globalData.navBarHeight = Math.round(navBarHeight)
    this.globalData.safeBottom = safeBottom
  },

  /* ================================================================
   * 登录
   * ================================================================ */
  /**
   * 登录（并发合并：同时多次调用只会真正请求一次）
   * @param {Boolean} force 强制重新拉取
   * @returns {Promise<Object>} user
   */
  login(force) {
    const g = this.globalData
    if (!force && g.userInfo && g.openid) return Promise.resolve(g.userInfo)
    if (!force && g._loginTask) return g._loginTask

    const api = require('./utils/api')
    const task = api.login.login({})
      .then(res => {
        g.userInfo = res.user || null
        g.openid = (res.user && res.user._openid) || ''
        g.isAdmin = !!(res.user && res.user.role === 'admin')
        if (res.config) g.config = Object.assign(g.config, res.config)
        g._loginTask = null
        this.emit('userChange', g.userInfo)
        return g.userInfo
      })
      .catch(err => {
        g._loginTask = null
        throw err
      })

    g._loginTask = task
    return task
  },

  /** 强制刷新用户信息（不改变登录态） */
  refreshUser() {
    return this.login(true)
  },

  /**
   * 是否已完善资料。
   * 只要求昵称：头像为空时会渲染「昵称首字 + 渐变色」的降级头像，
   * 属于合法状态，不应当作用户前进的门槛。
   */
  hasProfile() {
    const u = this.globalData.userInfo
    return !!(u && u.nickName)
  },

  /** 是否已通过校园认证 */
  isVerified() {
    const u = this.globalData.userInfo
    return !!(u && u.authStatus === 2)
  },

  /**
   * 页面守卫：要求已登录 → 已完善资料 →（可选）已认证
   * @param {Object} opts { profile:Boolean, verified:Boolean, silent:Boolean }
   * @returns {Promise<Object>} user
   */
  async requireUser(opts) {
    const o = Object.assign({ profile: true, verified: false }, opts || {})
    const util = require('./utils/util')
    const user = await this.login()

    if (o.profile && !this.hasProfile()) {
      const go = await util.confirm('还差一步！设置昵称后才能继续哦～', '完善资料')
      if (go) {
        wx.navigateTo({ url: '/pages/user/profile/profile?first=1' })
      }
      throw new Error('请先完善个人资料')
    }
    if (o.verified && !this.isVerified()) {
      const go = await util.confirm('该功能需要通过校园认证后才能使用', '校园认证')
      if (go) {
        wx.navigateTo({ url: '/pages/auth/campus/campus' })
      }
      throw new Error('请先完成校园认证')
    }
    return user
  },

  /** 是否管理员（带缓存，首次会请求） */
  async isAdminUser() {
    if (this.globalData.isAdmin) return true
    const api = require('./utils/api')
    try {
      const res = await api.admin.check({})
      this.globalData.isAdmin = !!res.isAdmin
      return this.globalData.isAdmin
    } catch (e) {
      return false
    }
  },

  /* ================================================================
   * 定位
   * ================================================================ */
  /**
   * 获取定位（带缓存，10 分钟内复用）
   * @param {Boolean} force
   * @returns {Promise<{longitude, latitude}|null>} 拒绝授权时返回 null，不抛错
   */
  async getLocation(force) {
    const g = this.globalData
    const util = require('./utils/util')
    if (!force && g.location && g._locTime && Date.now() - g._locTime < 600000) {
      return g.location
    }
    try {
      const loc = await util.getLocation()
      g.location = loc
      g._locTime = Date.now()
      g.locationDenied = false

      // 逆地址解析（可选增强）：配置了腾讯位置服务 Key 才能拿到中文地点名，
      // 没配置时页面会退化成显示「校园内」，不影响任何功能。
      try {
        const qqmap = require('./utils/qqmap')
        if (qqmap.available()) {
          qqmap.reverseGeocoder(loc.latitude, loc.longitude).then(r => {
            if (r && r.shortName) {
              g.locationName = r.shortName
              this.emit('locationName', r.shortName)
            }
          }).catch(() => {})
        }
      } catch (e) { /* 逆地址解析失败不影响定位本身 */ }

      // 异步上报服务端，失败无感
      const api = require('./utils/api')
      api.login.updateLocation({
        longitude: loc.longitude,
        latitude: loc.latitude,
        locationName: g.locationName || ''
      }).catch(() => {})
      return loc
    } catch (e) {
      g.locationDenied = true
      console.warn('[app] 定位失败：', e.errMsg || e.message)
      return null
    }
  },

  /* ================================================================
   * 事件总线（跨页刷新）
   * ================================================================ */
  on(evt, fn) {
    const bus = this.globalData._bus
    if (!bus[evt]) bus[evt] = []
    bus[evt].push(fn)
  },
  off(evt, fn) {
    const bus = this.globalData._bus
    if (!bus[evt]) return
    if (!fn) { delete bus[evt]; return }
    bus[evt] = bus[evt].filter(f => f !== fn)
  },
  emit(evt, data) {
    const bus = this.globalData._bus
    ;(bus[evt] || []).forEach(fn => {
      try { fn(data) } catch (e) { console.warn('[bus]', evt, e) }
    })
  },

  /* ================================================================
   * tabBar 选中态（配合 custom-tab-bar）
   * ================================================================ */
  /**
   * 同步自定义 tabBar 的选中态。
   * 用法：在 tab 页的 onShow 里 `app.selectTab(this, 0)`
   * @param {Object} page  页面实例（this）
   * @param {Number} index 0 广场 / 1 订单 / 2 时间币 / 3 我的
   */
  selectTab(page, index) {
    this._currentTabIndex = index
    if (page && typeof page.getTabBar === 'function' && page.getTabBar()) {
      page.getTabBar().setData({ selected: index })
    }
  },

  /**
   * 刷新 tabBar 上的未读角标（订单待办 + 消息未读）
   * 任何会改变待办数量的操作后调用一次即可。
   */
  async refreshTabBadge() {
    // 未登录时不必请求
    if (!this.globalData.openid) return
    const api = require('./utils/api')
    try {
      const [counts, unread] = await Promise.all([
        api.order.counts({}).catch(() => null),
        api.message.unreadTotal({}).catch(() => null)
      ])
      const todo = counts ? (counts.waiting || 0) + (counts.confirming || 0) : 0
      const msg = unread ? (unread.chat || 0) + (unread.notice || 0) : 0
      const pages = getCurrentPages()
      const cur = pages[pages.length - 1]
      if (cur && typeof cur.getTabBar === 'function' && cur.getTabBar()) {
        cur.getTabBar().setData({ badge: { 1: todo, 3: msg > 99 ? 99 : msg } })
      }
    } catch (e) { /* 角标失败不影响主流程 */ }
  },

  /* ================================================================
   * 网络状态
   * ================================================================ */
  _watchNetwork() {
    wx.onNetworkStatusChange(res => {
      if (!res.isConnected) {
        wx.showToast({ title: '网络已断开', icon: 'none' })
      }
      this.emit('networkChange', res)
    })
  },

  /* ================================================================
   * 订阅消息
   * ================================================================ */
  /**
   * 请求订阅消息授权（静默失败，不阻断业务）
   * @param {String[]} keys envList.SUBSCRIBE_TEMPLATES 的 key
   */
  async requestSubscribe(keys) {
    const { SUBSCRIBE_TEMPLATES } = envList
    const tmplIds = (keys || [])
      .map(k => this.globalData.templates[k] || SUBSCRIBE_TEMPLATES[k])
      .filter(Boolean)
    if (!tmplIds.length) return { skipped: true }
    try {
      const res = await wx.requestSubscribeMessage({ tmplIds })
      return res
    } catch (e) {
      console.warn('[app] 订阅消息授权失败：', e.errMsg || e.message)
      return { error: e }
    }
  }
})
