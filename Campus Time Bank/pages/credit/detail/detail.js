/**
 * 信用分详情
 * ------------------------------------------------------------------
 * 顶部蓝色渐变卡（分数 / 等级 / 进度条 / 距下一等级）
 * → 权益说明卡（constants.CREDIT_LEVELS 5 档，当前档高亮，显示可同时进行 N 单）
 * → 加减分规则表（constants.CREDIT_RULES）
 * → 变动明细（api.user.creditLogs 分页）
 * ------------------------------------------------------------------
 */
// 本页在 pages/<目录>/<子目录>/ 下（深度 3 层），回 miniprogram/ 需 3 个 ..
const api = require('../../../utils/api')
const util = require('../../../utils/util')
const constants = require('../../../utils/constants')
const credit = require('../../../utils/credit')

const PAGE_SIZE = 15

/** 明细行兜底：reason 映射不到时用服务端 reasonText（顶层函数，map 回调不依赖 this） */
function decorateCreditLog(log) {
  const l = log || {}
  const rule = constants.CREDIT_RULES.find(r => r.key === l.reason)
  const change = Number(l.change) || 0
  return {
    _id: l._id || '',
    reasonText: l.reasonText || (rule ? rule.text : '信用分变动'),
    orderId: l.orderId || '',
    timeText: util.formatShort(l.createTime),
    score: Number(l.score) || 0,
    change: change,
    changeText: (change > 0 ? '+' : '') + change,
    isUp: change > 0,
    isZero: change === 0
  }
}

Page({
  data: {
    /* 顶部卡 */
    score: credit.BASE_SCORE,
    levelText: '',
    levelDesc: '',
    levelColor: 'var(--c-success)',
    percent: 0,
    minText: '',
    maxText: '',
    nextText: '',
    nextGap: 0,

    /* 权益档位（当前档高亮） */
    levels: [],

    /* 规则表 */
    rules: [],

    /* 明细 */
    list: [],
    page: 1,
    hasMore: true,
    total: 0,
    loading: false,
    loadingMore: false,
    firstLoaded: false
  },

  onLoad() {
    this.loadScore()
    this.loadLogs(true)
  },

  /* ================================================================
   * 顶部卡片：分数 / 等级 / 进度
   * ================================================================ */
  async loadScore() {
    const app = getApp()
    let user = app.globalData.userInfo
    if (!user || !user.creditScore) {
      try {
        const res = await api.login.login({})
        user = (res && res.user) || null
      } catch (e) {
        user = null
        // 拿不到用户信息时用初始分兜底，不阻断页面
      }
    }
    const score = credit.clampScore((user && user.creditScore) || credit.BASE_SCORE)
    this.applyScore(score)
  },

  /** 把分数换算成页面需要的所有文案与百分比 */
  applyScore(score) {
    const level = credit.getLevel(score)
    const next = credit.nextLevel(score)
    const levels = constants.CREDIT_LEVELS.map(l => Object.assign({}, l, { current: !!level && l.key === level.key }))

    this.setData({
      score: score,
      levelText: level ? level.text : '',
      levelDesc: level ? level.desc : '',
      levelColor: level ? level.color : 'var(--c-success)',
      percent: credit.scorePercent(score),
      minText: level ? String(level.min) : '0',
      maxText: level ? String(level.max) : '150',
      nextText: next.text,
      nextGap: next.gap || 0,
      levels: levels,
      rules: constants.CREDIT_RULES.map(r => Object.assign({}, r, {
        changeText: (r.change > 0 ? '+' : '') + r.change,
        isUp: r.change > 0,
        isZero: r.change === 0
      }))
    })
  },

  /* ================================================================
   * 变动明细
   * ================================================================ */
  async loadLogs(reset) {
    if (this.data.loading) return
    const page = reset ? 1 : this.data.page + 1
    this.setData({ loading: true, loadingMore: !reset && this.data.list.length > 0 })

    try {
      const res = await api.user.creditLogs({ page: page, size: PAGE_SIZE })
      const rows = ((res && res.list) || []).map(decorateCreditLog)
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

  /** 明细行兜底：见文件顶部 decorateCreditLog */

  /* ================================================================
   * 交互
   * ================================================================ */
  /** 明细关联订单 → 订单详情 */
  goOrder(e) {
    const id = e.currentTarget.dataset.id
    if (!id) return
    wx.navigateTo({ url: '/pages/order/detail/detail?orderId=' + id })
  },

  /** → 去广场做一单，涨信用分 */
  goSquare() {
    wx.switchTab({ url: '/pages/square/square' })
  },

  /* ================================================================
   * 下拉刷新 / 触底加载
   * ================================================================ */
  async onPullDownRefresh() {
    this.setData({ page: 1, hasMore: true })
    await Promise.all([this.loadScore(), this.loadLogs(true)])
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
