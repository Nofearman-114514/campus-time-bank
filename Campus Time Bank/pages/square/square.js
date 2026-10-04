/**
 * 技能广场（首页 · tab①）
 * ------------------------------------------------------------------
 * 结构：渐变头部（定位 + 搜索）→ 轮播 → 分类横滑 → 吸顶筛选行 → 技能列表
 * 所有网络请求走 utils/api.js；样式只用 CSS 变量 + styles/common.wxss 原子类。
 * ------------------------------------------------------------------
 */
const api = require('../../utils/api')
const util = require('../../utils/util')
const constants = require('../../utils/constants')

const PAGE_SIZE = 10

Page({
  data: {
    /* 定位 */
    locationName: '',
    located: false,        // 是否已成功定位
    locationDenied: false,
    locating: false,

    /* 轮播 */
    banners: [],

    /* 分类 */
    categories: [],
    activeCategoryId: '',

    /* 筛选 */
    typeFilters: [
      { key: '', text: '全部' },
      { key: 'offer', text: '我能提供' },
      { key: 'need', text: '我要求助' }
    ],
    type: '',
    sorts: constants.SKILL_SORT,
    sort: 'new',

    /* 列表 */
    list: [],
    page: 1,
    hasMore: true,
    total: 0,
    firstLoaded: false,   // 首次加载完成前显示骨架屏
    loading: false,       // 正在请求
    loadingMore: false,   // 正在加载下一页
    loadError: false
  },

  /* ================================================================
   * 生命周期
   * ================================================================ */
  onLoad() {
    // 发布 / 编辑成功后自动刷新第一页
    const app = getApp()
    this._onSkillChange = () => this.resetAndLoad()
    app.on('skillChange', this._onSkillChange)

    this.loadBase()
    this.loadList(true)
    this.loadLocation()
  },

  onShow() {
    const app = getApp()
    app.selectTab(this, 0)
  },

  onUnload() {
    const app = getApp()
    app.off('skillChange', this._onSkillChange)
  },

  /* ================================================================
   * 基础数据：轮播 + 分类
   * ================================================================ */
  async loadBase() {
    // 分类
    try {
      const res = await api.skill.categories({})
      const list = (res && res.list) || []
      this.setData({ categories: list.length ? list : constants.DEFAULT_CATEGORIES })
    } catch (e) {
      // 分类拿不到不阻断，降级为内置默认分类
      this.setData({ categories: constants.DEFAULT_CATEGORIES })
    }
    // 轮播
    try {
      const res = await api.skill.banners({})
      this.setData({ banners: (res && res.list) || [] })
    } catch (e) {
      this.setData({ banners: [] })
    }
  },

  /* ================================================================
   * 列表
   * ================================================================ */
  /** 组装请求参数 */
  buildParams(page) {
    const app = getApp()
    const loc = app.globalData.location || null
    const p = {
      page: page,
      size: PAGE_SIZE,
      categoryId: this.data.activeCategoryId || '',
      type: this.data.type || '',
      sort: this.data.sort || 'new'
    }
    if (loc && (p.sort === 'near' || page === 1)) {
      p.longitude = loc.longitude
      p.latitude = loc.latitude
    }
    return p
  },

  /** 加载中时切换了筛选条件 → 记下待重刷标记 */
  _markDirty() {
    if (this.data.loading) this._pendingReset = true
  },

  /**
   * @param {Boolean} reset 是否重置到第 1 页
   */
  async loadList(reset) {
    if (this.data.loading) return
    this._pendingReset = false
    const page = reset ? 1 : this.data.page + 1
    const seq = (this._seq = (this._seq || 0) + 1)   // 请求序号：丢弃过期响应
    const params = this.buildParams(page)
    this.setData({ loading: true, loadingMore: !reset && this.data.list.length > 0 })

    try {
      const res = await api.skill.list(params)
      if (seq !== this._seq) return          // 已有更新的请求，本次结果作废
      const rows = (res && res.list) || []
      const list = reset ? rows : this.data.list.concat(rows)
      this.setData({
        list: list,
        page: page,
        total: (res && res.total) || list.length,
        hasMore: !!(res && res.hasMore),
        loadError: false
      })
    } catch (e) {
      if (seq !== this._seq) return
      this.setData({ loadError: true })
      util.toast(e.message)
    } finally {
      this.setData({ loading: false, loadingMore: false, firstLoaded: true })
      // 请求期间用户又改了筛选条件 → 用最新条件重刷一次
      if (this._pendingReset) this.loadList(true)
    }
  },

  /** 重置到第 1 页并加载 */
  resetAndLoad() {
    this.setData({ page: 1, hasMore: true })
    return this.loadList(true)
  },

  /* ================================================================
   * 交互
   * ================================================================ */
  /** 分类切换 */
  onCategory(e) {
    const id = e.currentTarget.dataset.id || ''
    if (id === this.data.activeCategoryId) return
    this._markDirty()
    this.setData({ activeCategoryId: id })
    this.resetAndLoad()
  },

  /** 类型筛选：全部 / 我能提供 / 我要求助 */
  onType(e) {
    const key = e.currentTarget.dataset.key || ''
    if (key === this.data.type) return
    this._markDirty()
    this.setData({ type: key })
    this.resetAndLoad()
  },

  /** 排序切换；未授权定位时禁止「离我最近」 */
  onSort(e) {
    const key = e.currentTarget.dataset.key || 'new'
    if (key === this.data.sort) return
    if (key === 'near' && this.data.locationDenied) {
      util.toast('未获取到定位，无法按距离排序')
      return
    }
    this._markDirty()
    this.setData({ sort: key })
    this.resetAndLoad()
  },

  /** 搜索框 → 搜索页 */
  onSearch() {
    wx.navigateTo({ url: '/pages/search/search' })
  },

  /** 位置 chip → 重新定位 */
  async onRelocate() {
    if (this.data.locating) return
    const app = getApp()
    this.setData({ locating: true })
    let loc = null
    try {
      loc = await app.getLocation(true)
    } catch (e) {
      loc = null
    }
    this.setData({ locating: false, locationDenied: !loc, located: !!loc })
    if (!loc) {
      util.toast('未获取到定位，可在设置中开启位置权限')
      return
    }
    util.toastOk('定位已更新')
    if (this.data.sort === 'near') this.resetAndLoad()
  },

  /** 首次定位：失败不反复弹窗，只置灰「离我最近」 */
  async loadLocation() {
    const app = getApp()
    const loc = await app.getLocation()
    this.setData({
      located: !!loc,
      locationDenied: !loc,
      locationName: app.globalData.locationName || ''
    })
  },

  /** 轮播点击（有 link 才跳转，站内路径用 navigateTo） */
  onBanner(e) {
    const link = e.currentTarget.dataset.link || ''
    if (!link) return
    if (/^\/pages\/square/.test(link)) {
      wx.switchTab({ url: link })
      return
    }
    wx.navigateTo({ url: link, fail: () => {} })
  },

  /** 技能卡片 → 详情 */
  onCard(e) {
    const item = (e.detail && e.detail.item) || {}
    if (!item._id) return
    wx.navigateTo({ url: `/pages/skill/detail/detail?id=${item._id}` })
  },

  /** 重试 */
  onRetry() {
    this.resetAndLoad()
  },

  /** 空态按钮 → 去发布 */
  onGoPublish() {
    wx.navigateTo({ url: '/pages/publish/publish', fail: () => {} })
  },

  /* ================================================================
   * 下拉刷新 / 触底加载
   * ================================================================ */
  async onPullDownRefresh() {
    this.setData({ page: 1, hasMore: true })
    await Promise.all([this.loadBase(), this.loadList(true)])
    wx.stopPullDownRefresh()
  },

  onReachBottom() {
    if (!this.data.hasMore || this.data.loading) return
    this.loadList(false)
  },

  /** 分享 */
  onShareAppMessage() {
    return { title: '校园时间银行 · 用技能换技能', path: '/pages/square/square' }
  }
})
