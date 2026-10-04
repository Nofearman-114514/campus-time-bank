/**
 * 时间币钱包（tab ③）
 * ------------------------------------------------------------------
 * 结构：橙色渐变资产卡（余额/冻结/累计）→ 信用分入口 → 近 7 天收支柱图
 *       → 明细 tab（全部/收入/支出/冻结）+ 分页列表
 *
 * ★ 合规点（答辩必讲）：时间币不可充值、不可提现，
 *   只能通过帮助他人获得 —— 页面里不存在任何充值/提现/支付入口。
 * 图表：**不引入任何图表库**，近 7 天收支用 WXSS 手绘柱子（高度百分比）。
 * ------------------------------------------------------------------
 */
const api = require('../../utils/api')
const util = require('../../utils/util')
const constants = require('../../utils/constants')
const credit = require('../../utils/credit')

const PAGE_SIZE = 15

/** 流水行展示字段兜底（顶层函数，map 回调里不依赖 this） */
function decorateLog(log) {
  const l = log || {}
  const meta = constants.WALLET_LOG_TYPES[l.type] || { text: '其他变动', icon: '•', color: 'var(--c-t2)' }
  const amount = Number(l.amount) || 0
  return {
    _id: l._id || '',
    type: l.type || 'admin',
    typeText: meta.text,
    typeIcon: meta.icon,
    typeColor: meta.color,
    remark: l.remark || '—',
    orderId: l.orderId || '',
    timeText: util.formatShort(l.createTime),
    amount: amount,
    amountText: (amount > 0 ? '+' : '') + amount,
    isIncome: amount > 0
  }
}

Page({
  data: {
    /* 资产 */
    coins: 0,
    frozenCoins: 0,
    totalAssets: 0,
    totalEarned: 0,
    totalSpent: 0,
    income7d: 0,
    expense7d: 0,

    /* 信用分入口小卡 */
    creditScore: 100,
    creditLevelText: '',
    creditPercent: 0,

    /* 近 7 天柱图 */
    trend: [],

    /* 明细 */
    tabs: constants.WALLET_LOG_TABS,
    activeTab: 'all',
    list: [],
    page: 1,
    hasMore: true,
    total: 0,
    loading: false,
    loadingMore: false,
    firstLoaded: false
  },

  /* ================================================================
   * 生命周期
   * ================================================================ */
  onShow() {
    // ★ tab 页必须同步自定义 tabBar 选中态
    const app = getApp()
    app.selectTab(this, 2)
    this.loadAll(true)
  },

  /* ================================================================
   * 数据加载
   * ================================================================ */
  loadAll(reset) {
    return Promise.all([
      this.loadInfo(),
      this.loadStats(),
      this.loadLogs(reset)
    ])
  },

  /** 余额与累计 */
  async loadInfo() {
    try {
      const res = await api.wallet.info({}) || {}
      const coins = Number(res.coins) || 0
      const frozen = Number(res.frozenCoins) || 0
      this.setData({
        coins: coins,
        frozenCoins: frozen,
        totalAssets: coins + frozen,
        totalEarned: Number(res.totalEarned) || 0,
        totalSpent: Number(res.totalSpent) || 0,
        income7d: Number(res.income7d) || 0,
        expense7d: Number(res.expense7d) || 0
      })
      this.syncCreditFromUser()
    } catch (e) {
      util.toast(e.message)
    }
  },

  /** 信用分入口：优先用全局用户态，没有再拉一次 */
  async syncCreditFromUser() {
    const app = getApp()
    let user = app.globalData.userInfo
    if (!user || !user.creditScore) {
      try {
        const res = await api.login.login({})
        user = (res && res.user) || null
      } catch (e) {
        user = null
      }
    }
    const score = (user && Number(user.creditScore)) || credit.BASE_SCORE
    const level = credit.getLevel(score)
    this.setData({
      creditScore: score,
      creditLevelText: level ? level.text : '',
      creditPercent: credit.scorePercent(score)
    })
  },

  /** 近 7 天收支趋势 → 手绘柱子数据（高度按当周最大值归一化） */
  async loadStats() {
    try {
      const res = await api.wallet.stats({}) || {}
      const raw = res.trend || []
      let max = 1
      raw.forEach(t => {
        max = Math.max(max, Number(t.income) || 0, Number(t.expense) || 0)
      })
      const trend = raw.map(t => {
        const income = Number(t.income) || 0
        const expense = Number(t.expense) || 0
        return {
          date: String(t.date || '').slice(-5),
          income: income,
          expense: expense,
          // 柱子高度百分比（最低留 4% 保证空数据也有一条基线）
          incomeH: Math.max(4, Math.round(income / max * 100)),
          expenseH: Math.max(4, Math.round(expense / max * 100))
        }
      })
      this.setData({ trend: trend })
    } catch (e) {
      this.setData({ trend: [] })
      util.toast(e.message)
    }
  },

  /** 明细列表 */
  async loadLogs(reset) {
    if (this.data.loading) return
    const page = reset ? 1 : this.data.page + 1
    this.setData({ loading: true, loadingMore: !reset && this.data.list.length > 0 })

    try {
      const res = await api.wallet.logs({
        page: page,
        size: PAGE_SIZE,
        type: this.data.activeTab
      })
      const rows = ((res && res.list) || []).map(decorateLog)
      const list = reset ? rows : this.data.list.concat(rows)
      this.setData({
        list: list,
        page: page,
        total: (res && res.total) || list.length,
        hasMore: !!(res && res.hasMore)
      })
    } catch (e) {
      util.toast(e.message)
    } finally {
      this.setData({ loading: false, loadingMore: false, firstLoaded: true })
    }
  },

  /* ================================================================
   * 交互
   * ================================================================ */
  onTab(e) {
    const key = e.currentTarget.dataset.key || 'all'
    if (key === this.data.activeTab) return
    this.setData({ activeTab: key, list: [], page: 1, hasMore: true })
    this.loadLogs(true)
  },

  /** → 信用分详情 */
  goCredit() {
    wx.navigateTo({ url: '/pages/credit/detail/detail' })
  },

  /** 流水关联订单 → 订单详情 */
  goOrder(e) {
    const id = e.currentTarget.dataset.id
    if (!id) return
    wx.navigateTo({ url: '/pages/order/detail/detail?orderId=' + id })
  },

  /** → 平台规则说明（不可充值不可提现的完整解释） */
  goAbout() {
    wx.navigateTo({ url: '/pages/about/about' })
  },

  /* ================================================================
   * 下拉刷新 / 触底加载
   * ================================================================ */
  async onPullDownRefresh() {
    this.setData({ page: 1, hasMore: true })
    await this.loadAll(true)
    wx.stopPullDownRefresh()
  },

  onReachBottom() {
    if (!this.data.hasMore || this.data.loading) return
    this.loadLogs(false)
  },

  onShareAppMessage() {
    return { title: '校园时间银行 · 用技能换技能', path: '/pages/square/square' }
  }
})
