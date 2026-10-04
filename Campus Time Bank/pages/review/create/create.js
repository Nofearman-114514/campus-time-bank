/**
 * 发表评价
 * ------------------------------------------------------------------
 * 入口：/pages/review/create/create?orderId=xxx
 * 规则（与 cloudfunctions/user.reviewCreate 一致）：
 *   · 订单必须已完成，且「我」还没评过（前端先友好拦截，后端也会拦）
 *   · 评分 1-5，标签随分数在好评/差评两套里切换
 *   · 选中的标签可直接作为评价内容（快捷输入）
 * ------------------------------------------------------------------
 */
const api = require('../../../utils/api')
const util = require('../../../utils/util')
const constants = require('../../../utils/constants')

/** 分数 → 文案 */
const SCORE_TEXT = {
  1: '很不满意',
  2: '不太满意',
  3: '一般',
  4: '满意',
  5: '非常满意'
}

const CONTENT_MAX = 200

Page({
  data: {
    orderId: '',
    loading: true,
    order: {},
    role: 'buyer',

    /* 被评价人 */
    target: {},
    targetTitle: '',
    skillTitle: '',

    /* 评分 */
    score: 5,
    scoreText: SCORE_TEXT[5],

    /* 标签 */
    tags: constants.REVIEW_TAGS_GOOD,
    selectedTags: [],

    /* 内容与匿名 */
    content: '',
    anonymous: false,

    CONTENT_MAX,
    /** switch 组件的 color 属性只接受色值、不支持 CSS 变量，取值同 token --c-primary */
    switchColor: '#0EA47A',
    submitting: false
  },

  onLoad(options) {
    const orderId = (options && options.orderId) || ''
    if (!orderId) {
      util.toast('缺少订单参数')
      setTimeout(() => wx.navigateBack(), 800)
      return
    }
    this.setData({ orderId })
    this.loadOrder()
  },

  /* ================================================================
   * 数据加载
   * ================================================================ */
  async loadOrder() {
    try {
      const res = await api.order.detail({ orderId: this.data.orderId })
      const order = (res && res.order) || {}
      const role = (res && res.role) || order.role || 'buyer'
      const isBuyer = role === 'buyer'

      // 订单必须已完成
      if (order.status !== 'finished') {
        this.setData({ loading: false })
        util.toast('订单完成后才能评价')
        return setTimeout(() => wx.navigateBack(), 900)
      }
      // 已评价过：友好拦截（后端也会拦）
      const rated = isBuyer ? !!order.isRatedBuyer : !!order.isRatedSeller
      if (rated) {
        this.setData({ loading: false })
        util.toast('你已经评价过这一单啦')
        return setTimeout(() => wx.navigateBack(), 900)
      }

      this.setData({
        loading: false,
        order,
        role,
        target: (isBuyer ? order.sellerInfo : order.buyerInfo) || {},
        targetTitle: isBuyer ? '服务者' : '买家',
        skillTitle: (order.skillSnapshot && order.skillSnapshot.title) || ''
      })
    } catch (e) {
      this.setData({ loading: false })
      util.toast(e.message)
    }
  },

  /* ================================================================
   * 评分
   * ================================================================ */
  onRate(e) {
    const score = Number((e.detail && e.detail.value) || 5)
    this.applyScore(score)
  },

  /** 切分：联动文案与标签池 */
  applyScore(score) {
    const s = Math.min(Math.max(Number(score) || 5, 1), 5)
    const tags = s >= 4 ? constants.REVIEW_TAGS_GOOD : constants.REVIEW_TAGS_BAD
    // 已经在文本里的旧标签保留选中态展示（不强制清空内容）
    this.setData({
      score: s,
      scoreText: SCORE_TEXT[s],
      tags,
      selectedTags: []
    })
  },

  /* ================================================================
   * 标签（点选即写入评价内容，作为快捷输入）
   * ================================================================ */
  onToggleTag(e) {
    const tag = e.currentTarget.dataset.tag
    if (!tag) return
    const selected = this.data.selectedTags.slice()
    const idx = selected.indexOf(tag)
    const content = this.data.content || ''

    if (idx > -1) {
      // 取消：同时从内容里移除该标签
      selected.splice(idx, 1)
      const next = content
        .split('，')
        .map(x => x.trim())
        .filter(x => x && x !== tag)
        .join('，')
      this.setData({ selectedTags: selected, content: next })
      return
    }

    selected.push(tag)
    const merged = content ? `${content}，${tag}` : tag
    this.setData({ selectedTags: selected, content: merged.slice(0, CONTENT_MAX) })
  },

  /* ================================================================
   * 文字与匿名
   * ================================================================ */
  onContentInput(e) {
    this.setData({ content: e.detail.value || '' })
  },
  onAnonymousChange(e) {
    this.setData({ anonymous: !!(e.detail && e.detail.value) })
  },

  /* ================================================================
   * 提交
   * ================================================================ */
  async onSubmit() {
    if (this.data.submitting) return
    if (!this.data.score) return util.toast('请先给出评分')

    const ok = await util.confirm(
      this.data.anonymous
        ? '确认提交这条匿名评价吗？提交后对方看不到你的昵称和头像，且不可修改。'
        : '确认提交这条评价吗？提交后不可修改，并会影响对方的信用分。',
      '提交评价'
    )
    if (!ok) return

    this.setData({ submitting: true })
    util.loading('提交中')
    try {
      await api.user.reviewCreate({
        orderId: this.data.orderId,
        score: this.data.score,
        tags: this.data.selectedTags,
        content: util.trimAll(this.data.content),
        anonymous: this.data.anonymous
      })
      util.hideLoading()
      util.toastOk('评价成功')
      getApp().emit('reviewChange')
      setTimeout(() => wx.navigateBack(), 700)
    } catch (e) {
      util.hideLoading()
      util.toast(e.message)
    } finally {
      this.setData({ submitting: false })
    }
  }
})
