/**
 * 我的评价
 * ------------------------------------------------------------------
 * 两个 tab：收到的评价（role=received）/ 我发出的评价（role=sent）
 * 顶部综合评分：
 *   ★ 优先使用 credit.weightedRating(reviews) —— 前端按 §6.2 的时间衰减加权公式算，
 *     w = 0.9 ^ 距今天数，越近的评价权重越高，突出「最近表现」。
 *   ★ 与后端 stats.avgRating 的区别：avgRating 是【全部评价的算术平均】，简单直观、
 *     但一条两年前的差评和昨天的差评权重相同；weightedRating 会自然「冲淡」旧评价，
 *     更适合做门面展示。两者口径不同、数值可能不一样，答辩时说明即可。
 * 收到的评价可回复（api.user.reviewReply）。
 * ------------------------------------------------------------------
 */
const api = require('../../../utils/api')
const util = require('../../../utils/util')
const credit = require('../../../utils/credit')
const envList = require('../../../envList')

const PAGE_SIZE = envList.PAGE_SIZE || 10
const REPLY_MAX = 100

Page({
  data: {
    role: 'received',
    list: [],
    page: 1,
    hasMore: false,
    total: 0,
    loading: true,
    loadingMore: false,

    /* 综合评分 */
    avgScore: 0,
    scoreSource: '',      // 'weighted' | 'backend'
    scoreCount: 0,

    /* 回复弹层 */
    replyVisible: false,
    replyContent: '',
    replyTarget: {},
    REPLY_MAX,

    replying: false
  },

  onLoad() {
    this.loadList(true)
  },

  onShow() {
    // 从评价页返回后刷新
    if (this._loaded) this.loadList(true)
    this._loaded = true
  },

  /* ================================================================
   * 数据加载
   * ================================================================ */
  async loadList(reset) {
    if (this._loading) return
    this._loading = true
    const page = reset ? 1 : this.data.page + 1
    const role = this.data.role
    this.setData(reset ? { loading: true } : { loadingMore: true })

    try {
      const res = await api.user.reviews({ role, page, size: PAGE_SIZE })
      const fresh = ((res && res.list) || []).map(r => this.decorate(r))
      const list = reset ? fresh : this.data.list.concat(fresh)
      const total = (res && res.total) || list.length

      const patch = {
        list,
        page,
        total,
        hasMore: !!(res && res.hasMore),
        loading: false,
        loadingMore: false
      }
      // 综合评分只在「收到的评价」页显示
      if (role === 'received') {
        if (reset) {
          const weighted = credit.weightedRating(fresh)
          const backend = this.backendAvg()
          patch.avgScore = weighted || backend || 0
          patch.scoreSource = weighted ? 'weighted' : (backend ? 'backend' : '')
        }
        patch.scoreCount = total
      }
      this.setData(patch)
    } catch (e) {
      this.setData({ loading: false, loadingMore: false })
      util.toast(e.message)
    } finally {
      this._loading = false
    }
  },

  /** 后端冗余的平均分（登录态里带的 stats.avgRating） */
  backendAvg() {
    const g = getApp().globalData || {}
    const stats = (g.userInfo && g.userInfo.stats) || {}
    return Number(stats.avgRating) || 0
  },

  /** 列表项预处理：匿名、时间、标签兜底 */
  decorate(r) {
    const item = Object.assign({}, r || {})
    item.tags = item.tags || []
    item.timeText = util.formatShort(item.createTime) || '—'
    item.skillName = item.skillName || (item.skillSnapshot && item.skillSnapshot.title) || ''
    item.fromName = item.anonymous ? '匿名同学' : ((item.fromInfo && item.fromInfo.nickName) || '同学')
    item.fromAvatar = item.anonymous ? '' : ((item.fromInfo && item.fromInfo.avatarUrl) || '')
    // 匿名时头像在 wxml 里加 .rv-avatar--anon 置灰
    item.replyContent = (item.reply && item.reply.content) || ''
    item.replyTimeText = item.reply && item.reply.time ? util.formatShort(item.reply.time) : ''
    return item
  },

  onPullDownRefresh() {
    this.loadList(true).then(() => wx.stopPullDownRefresh()).catch(() => wx.stopPullDownRefresh())
  },

  onReachBottom() {
    if (!this.data.hasMore || this.data.loadingMore || this.data.loading) return
    this.loadList(false)
  },

  onSwitchRole(e) {
    const role = e.currentTarget.dataset.role
    if (!role || role === this.data.role) return
    this.setData({ role, list: [], page: 1, hasMore: false, total: 0, avgScore: 0, scoreCount: 0 })
    this.loadList(true)
  },

  /* ================================================================
   * 回复
   * ================================================================ */
  onOpenReply(e) {
    const id = e.currentTarget.dataset.id
    const item = this.data.list.find(x => x._id === id) || {}
    this.setData({
      replyVisible: true,
      replyTarget: item,
      replyContent: item.replyContent || ''
    })
  },

  onCloseReply() {
    this.setData({ replyVisible: false, replyContent: '', replyTarget: {} })
  },

  onReplyInput(e) {
    this.setData({ replyContent: e.detail.value || '' })
  },

  /** 阻止弹层内部点击穿透到遮罩 */
  noop() {},

  async onSubmitReply() {
    if (this.data.replying) return
    const content = util.trimAll(this.data.replyContent)
    const target = this.data.replyTarget || {}
    if (!target._id) return
    if (!content) return util.toast('请填写回复内容')
    if (content.length > REPLY_MAX) return util.toast(`回复最多 ${REPLY_MAX} 个字`)

    this.setData({ replying: true })
    util.loading('提交中')
    try {
      await api.user.reviewReply({ reviewId: target._id, content })
      util.hideLoading()
      util.toastOk('回复成功')
      // 本地即时更新，避免整页重载
      const list = this.data.list.map(x => {
        if (x._id !== target._id) return x
        return Object.assign({}, x, {
          replyContent: content,
          replyTimeText: util.formatShort(new Date())
        })
      })
      this.setData({ list, replyVisible: false, replyContent: '', replyTarget: {} })
    } catch (e) {
      util.hideLoading()
      util.toast(e.message)
    } finally {
      this.setData({ replying: false })
    }
  }
})
