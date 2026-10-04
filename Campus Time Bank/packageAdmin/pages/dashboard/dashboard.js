/**
 * 数据看板（管理端核心页）
 * ==================================================================
 * 数据来源：api.admin.stats({ range })，结构见 docs/ARCHITECTURE.md §4.8
 *
 * ★ ECharts 在分包里的正确用法（踩坑记录，修改前请先读）：
 *   1. json 里声明 ec-canvas（绝对路径，指向本分包内组件）
 *   2. js 里 require 分包内的 echarts（UMD 包，require 可直接拿到 exports）
 *   3. data.ec 必须是 { lazyLoad: true }，由页面在「数据回来之后」手动 init
 *   4. init 必须放在 setData 的回调里执行 —— setData 是异步的，
 *      同步 init 时 canvas 节点还没创建，selectComponent 会拿到 null 导致图表不显示
 *   5. 每个图表用不同的 id + canvas-id（重复 id 只会渲染一个）
 *   6. 容器必须有确定高度（见 wxss .chart-box），否则高度为 0
 *   7. onUnload 必须 dispose，否则快速返回会泄漏 canvas
 * ==================================================================
 */
const api = require('../../../utils/api')
const util = require('../../../utils/util')
const guard = require('../../utils/guard')
const chart = require('../../utils/chart')
const echarts = require('../../components/ec-canvas/echarts')

const RANGES = [
  { v: 7, t: '近 7 天' },
  { v: 14, t: '近 14 天' },
  { v: 30, t: '近 30 天' }
]

const EMPTY_OVERVIEW = {
  userTotal: 0, userToday: 0, userGrowthRate: 0,
  orderTotal: 0, orderToday: 0, orderGrowthRate: 0,
  coinCirculation: 0, coinFrozen: 0, coinEarned: 0,
  finishRate: 0, avgRating: 0,
  authPending: 0, reportPending: 0
}

/** 管理端入口（看板即管理端首页） */
const ENTRIES = [
  { icon: '👥', name: '用户管理', url: '/packageAdmin/pages/users/users' },
  { icon: '🪪', name: '认证审核', url: '/packageAdmin/pages/auth-audit/auth-audit' },
  { icon: '🗂', name: '分类管理', url: '/packageAdmin/pages/categories/categories' },
  { icon: '🧩', name: '技能审核', url: '/packageAdmin/pages/skills/skills' },
  { icon: '📦', name: '订单管理', url: '/packageAdmin/pages/orders/orders' },
  { icon: '🚨', name: '举报处理', url: '/packageAdmin/pages/reports/reports' },
  { icon: '⚙️', name: '参数配置', url: '/packageAdmin/pages/settings/settings' }
]

Page({
  data: {
    /** ★ 懒加载：必须 lazyLoad，否则组件 ready 时页面数据还没到 */
    ec: { lazyLoad: true },

    range: 7,
    ranges: RANGES,
    entries: ENTRIES,

    loading: true,      // 首屏骨架
    loaded: false,      // 已拿到数据（控制 ec-canvas 是否渲染）
    trendLoading: false,

    overview: EMPTY_OVERVIEW,
    finishRateText: '0%',
    avgRatingText: '—',
    userGrowth: { dir: 'flat', text: '0%' },
    orderGrowth: { dir: 'flat', text: '0%' },
    todoCount: 0,
    /** 每个图表是否有数据（无数据则不渲染 canvas，避免空白图） */
    show: { trend: false, category: false, hot: false, orderStatus: false, credit: false, radar: false, gauge: false },
    topUsers: []
  },

  onLoad() {
    // 本页需要异步鉴权，故用异步 onLoad
    this._boot()
  },

  async _boot() {
    const ok = await guard.requireAdmin(this)
    if (!ok) return
    this._disposed = false
    this.charts = {}
    this._initing = {}
    this._stats = { trend: [], categoryDist: [], hotSkills: [], orderStatusDist: [], creditDist: [], overview: EMPTY_OVERVIEW }
    this.loadStats()
  },

  onReady() {
    // 兜底：若数据在 onReady 之前就已返回，这里补一次渲染（renderCharts 幂等）
    if (this.data.loaded) this.renderCharts()
  },

  onUnload() {
    this.disposeCharts()
  },

  onPullDownRefresh() {
    if (!this._isAdmin) return wx.stopPullDownRefresh()
    this.loadStats(false).then(() => wx.stopPullDownRefresh()).catch(() => wx.stopPullDownRefresh())
  },

  /* ================================================================
   * 数据
   * ================================================================ */
  async loadStats(withSkeleton) {
    if (withSkeleton !== false) this.setData({ loading: true })
    try {
      const res = (await api.admin.stats({ range: this.data.range })) || {}
      const overview = Object.assign({}, EMPTY_OVERVIEW, res.overview || {})
      const trend = res.trend || []
      const categoryDist = res.categoryDist || []
      const hotSkills = res.hotSkills || []
      const orderStatusDist = res.orderStatusDist || []
      const creditDist = res.creditDist || []
      const topUsers = (res.topUsers || []).map(u => ({
        // §4.8 未声明 openid 字段，兼容后端可能返回 _openid 的情况
        openid: (u && (u.openid || u._openid)) || '',
        nickName: (u && u.nickName) || '匿名用户',
        avatarUrl: (u && u.avatarUrl) || '',
        serveCount: Number((u && u.serveCount) || 0),
        creditScore: Number((u && u.creditScore) || 0),
        avgRating: Number((u && u.avgRating) || 0)
      }))

      this._stats = { trend, categoryDist, hotSkills, orderStatusDist, creditDist, overview }

      this.setData({
        loading: false,
        loaded: true,
        overview,
        finishRateText: `${Number(overview.finishRate || 0).toFixed(1)}%`,
        avgRatingText: overview.avgRating ? Number(overview.avgRating).toFixed(1) : '—',
        userGrowth: this.growth(overview.userGrowthRate),
        orderGrowth: this.growth(overview.orderGrowthRate),
        todoCount: Number(overview.authPending || 0) + Number(overview.reportPending || 0),
        topUsers,
        show: {
          trend: trend.length > 0,
          category: categoryDist.length > 0,
          hot: hotSkills.length > 0,
          orderStatus: orderStatusDist.length > 0,
          credit: creditDist.length > 0,
          radar: true,
          gauge: true
        }
      }, () => {
        // ★ 必须在渲染完成后的回调里初始化，否则 canvas 节点还不存在
        this.renderCharts()
      })
    } catch (e) {
      this.setData({ loading: false, loaded: true })
      util.toast(e.message)
    }
  },

  /** 增长率 → ▲/▼ 展示对象 */
  growth(rate) {
    const n = Number(rate) || 0
    return {
      dir: n > 0 ? 'up' : (n < 0 ? 'down' : 'flat'),
      text: (n > 0 ? '+' : '') + n + '%'
    }
  },

  /** 切换 7 / 14 / 30 天：重新请求 → 只更新折线图 */
  async onRange(e) {
    const range = Number(e.currentTarget.dataset.v)
    if (!range || range === this.data.range) return
    this.setData({ range, trendLoading: true })
    try {
      const res = (await api.admin.stats({ range })) || {}
      const trend = res.trend || []
      this._stats.trend = trend
      this.setData({
        trendLoading: false,
        show: Object.assign({}, this.data.show, { trend: trend.length > 0 })
      }, () => this.renderCharts())
    } catch (err) {
      this.setData({ trendLoading: false })
      util.toast(err.message)
    }
  },

  /* ================================================================
   * 图表：初始化 / 更新 / 销毁
   * ================================================================ */
  /** 平台健康度雷达：契约 §4.8 未返回雷达字段，由 overview 派生（已归一化 0~100） */
  buildRadar(o) {
    const ov = o || {}
    const clamp = n => Math.max(0, Math.min(100, Math.round(n)))
    const flowTotal = Number(ov.coinCirculation || 0) + Number(ov.coinFrozen || 0)
    return [
      { name: '完成率', value: clamp(ov.finishRate), max: 100 },
      { name: '好评度', value: clamp((Number(ov.avgRating) || 0) / 5 * 100), max: 100 },
      { name: '用户增长', value: clamp(50 + (Number(ov.userGrowthRate) || 0) * 2), max: 100 },
      { name: '订单增长', value: clamp(50 + (Number(ov.orderGrowthRate) || 0) * 2), max: 100 },
      { name: '流通占比', value: flowTotal ? clamp(ov.coinCirculation / flowTotal * 100) : 0, max: 100 },
      { name: '待办清空', value: clamp(100 - (Number(ov.authPending || 0) + Number(ov.reportPending || 0)) * 5), max: 100 }
    ]
  },

  /** 幂等：已有实例 → setOption；没有 → init */
  renderCharts() {
    if (!this.charts) { this.charts = {}; this._initing = {} }
    const s = this._stats || {}
    const jobs = [
      { key: 'trend', id: 'chart-trend', option: chart.lineTrend(s.trend) },
      { key: 'category', id: 'chart-category', option: chart.pieCategory(s.categoryDist) },
      { key: 'hot', id: 'chart-hot', option: chart.barTop(s.hotSkills, true) },
      { key: 'orderStatus', id: 'chart-order-status', option: chart.pieCategory(s.orderStatusDist) },
      { key: 'credit', id: 'chart-credit', option: chart.barCredit(s.creditDist) },
      { key: 'radar', id: 'chart-radar', option: chart.radarPlatform(this.buildRadar(s.overview)) },
      { key: 'gauge', id: 'chart-gauge', option: chart.gaugeFinish(s.overview && s.overview.finishRate) }
    ]

    jobs.forEach(job => {
      if (!job.option) return                       // 无数据 → 不初始化空白图
      const exist = this.charts[job.key]
      if (exist) {
        try { exist.setOption(job.option, true) } catch (e) { console.warn('[dashboard] setOption 失败', job.key, e) }
        return
      }
      if (this._initing[job.key]) return
      const comp = this.selectComponent('#' + job.id)
      if (!comp) {
        console.warn('[dashboard] 未找到 ec-canvas：', job.id)
        return
      }
      this._initing[job.key] = true
      comp.init((canvas, width, height, dpr) => {
        // 页面已卸载：不要再创建图表实例（onUnload 已 dispose）
        if (this._disposed) return null
        const c = echarts.init(canvas, null, { width, height, devicePixelRatio: dpr })
        c.setOption(job.option)
        this.charts[job.key] = c
        this._initing[job.key] = false
        return c
      })
    })
  },

  disposeCharts() {
    this._disposed = true
    const charts = this.charts || {}
    Object.keys(charts).forEach(k => {
      try { charts[k] && charts[k].dispose() } catch (e) { /* 忽略销毁异常 */ }
    })
    this.charts = {}
    this._initing = {}
  },

  /* ================================================================
   * 交互
   * ================================================================ */
  goEntry(e) {
    const url = e.currentTarget.dataset.url
    if (url) util.navTo(url)
  },

  /** 待办提醒条 → 认证审核 / 举报处理 */
  goTodo(e) {
    const url = e.currentTarget.dataset.url
    if (url) util.navTo(url)
  },

  /** 活跃用户 → 用户主页（用户端页面） */
  goUser(e) {
    const openid = e.currentTarget.dataset.openid
    if (!openid) return util.toast('该用户信息不完整')
    util.navTo('/pages/user/home/home?openid=' + encodeURIComponent(openid))
  },

  onBack() {
    guard.backOrHome()
  }
})
