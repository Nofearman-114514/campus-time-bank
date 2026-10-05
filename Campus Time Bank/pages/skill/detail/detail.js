/**
 * 技能详情
 * ------------------------------------------------------------------
 * api.skill.detail({ id }) → { skill, author, isOwner }
 * 底部固定操作条：本人可「编辑 / 下架」，他人可「举报 / 立即预约」。
 * 立即预约前必须过 app.requireUser({ profile: true, verified: true })。
 * ------------------------------------------------------------------
 */
const api = require('../../../utils/api')
const util = require('../../../utils/util')
const campus = require('../../../utils/campus')

/** 没有图片时的分类渐变（与 skill-card 的降级策略保持一致） */
const COVER_PALETTE = {
  c1: ['#4FA8FF', '#2563EB'],
  c2: ['#A78BFA', '#7C5CFF'],
  c3: ['#FB923C', '#EA580C'],
  c4: ['#34D399', '#059669'],
  c5: ['#22D3EE', '#0891B2'],
  c6: ['#F472B6', '#DB2777'],
  c7: ['#FBBF24', '#D97706'],
  c8: ['#F87171', '#DC2626'],
  c9: ['#60A5FA', '#3B82F6'],
  c10: ['#9CA3AF', '#6B7280']
}

const COVER_ICON = {
  学业辅导: '📚', 技能教学: '🎸', 摄影修图: '📷', 代取代买: '🛵',
  电脑技术: '💻', 运动健身: '🏃', 生活服务: '🧺', 设计美工: '🎨',
  语言互助: '🌏', 其他: '✨'
}

Page({
  data: {
    id: '',
    loading: true,
    loadError: false,

    skill: {},
    author: {},
    isOwner: false,
    isCollected: false,     // 封面右上角的收藏态（来自 skill.detail）
    collecting: false,      // 收藏防重入

    /* 封面降级 */
    hasImage: false,
    coverBg: 'linear-gradient(135deg,#9CA3AF,#6B7280)',
    coverIcon: '✨',

    /* 派生展示字段 */
    durationText: '',
    typeText: '提供',
    typeClass: 'is-offer',
    tags: [],
    createText: '',

    /* 作者卡 */
    authorOpenid: '',
    authorName: '匿名同学',
    authorCredit: 0,
    authorVerified: false,
    authorRating: 0,
    authorReviewCount: 0,

    /* 地点 */
    hasGeo: false,
    longitude: 0,
    latitude: 0,
    locationName: '',
    address: '',

    /* 评价 */
    reviews: [],
    reviewTotal: 0,

    submitting: false,
    chatting: false         // 「联系 TA」防重入
  },

  onLoad(options) {
    const id = (options && options.id) || ''
    this.setData({ id: id })
    if (!id) {
      this.setData({ loading: false, loadError: true })
      util.toast('缺少技能 ID')
      return
    }
    this.loadDetail()
  },

  /* ================================================================
   * 数据加载
   * ================================================================ */
  async loadDetail() {
    this.setData({ loading: true, loadError: false })
    try {
      const res = await api.skill.detail({ id: this.data.id })
      const skill = (res && res.skill) || {}
      const author = (res && res.author) || {}
      const app = getApp()
      const myOpenid = (app && app.globalData && app.globalData.openid) || ''
      const authorOpenid = author._openid || skill.authorId || ''
      const images = skill.images || []
      const pair = COVER_PALETTE[skill.categoryId] || COVER_PALETTE.c10
      const geo = campus.parseGeoPoint(skill.location)

      this.setData({
        loading: false,
        skill: skill,
        author: author,
        // 后端 isOwner 优先，兜底再比一次 openid
        isOwner: !!(res && res.isOwner) || (!!myOpenid && myOpenid === authorOpenid),
        isCollected: !!(res && res.isCollected),

        hasImage: images.length > 0,
        coverBg: `linear-gradient(135deg,${pair[0]},${pair[1]})`,
        coverIcon: skill.categoryIcon || COVER_ICON[skill.categoryName] || '✨',

        durationText: this._durationText(skill.duration),
        typeText: skill.type === 'need' ? '求助' : '提供',
        typeClass: skill.type === 'need' ? 'is-need' : 'is-offer',
        tags: skill.tags || [],
        createText: util.fromNow(skill.createTime),

        authorOpenid: authorOpenid,
        authorName: author.nickName || (skill.authorInfo && skill.authorInfo.nickName) || '匿名同学',
        authorCredit: author.creditScore || (skill.authorInfo && skill.authorInfo.creditScore) || 0,
        authorVerified: (author.authStatus === 2) || (skill.authorInfo && skill.authorInfo.authStatus === 2) || false,
        authorRating: (author.stats && author.stats.avgRating) || 0,
        authorReviewCount: (author.stats && author.stats.reviewCount) || 0,

        // ★ 云端返回的是 GeoJSON { type:'Point', coordinates:[lng,lat] }，
        //   没有 .latitude / .longitude —— 必须用 parseGeoPoint 统一（见 utils/campus.js）
        hasGeo: !!geo,
        longitude: geo ? geo.lng : 0,
        latitude: geo ? geo.lat : 0,
        locationName: skill.locationName || '',
        address: skill.address || ''
      })

      this.loadReviews(authorOpenid || skill.authorId || '')
    } catch (e) {
      this.setData({ loading: false, loadError: true })
      util.toast(e.message)
    }
  },

  /** TA 收到的评价（前 3 条） */
  async loadReviews(openid) {
    if (!openid) return
    try {
      const res = await api.user.reviews({ openid: openid, role: 'received', page: 1, size: 3 })
      const list = ((res && res.list) || []).map(r => this._fmtReview(r))
      this.setData({ reviews: list, reviewTotal: (res && res.total) || list.length })
    } catch (e) {
      // 评价加载失败不影响详情主体
      this.setData({ reviews: [], reviewTotal: 0 })
    }
  },

  _fmtReview(r) {
    const o = Object.assign({}, r || {})
    o.fromName = o.anonymous ? '匿名同学' : ((o.fromInfo && o.fromInfo.nickName) || '匿名同学')
    o.fromAvatar = o.anonymous ? '' : ((o.fromInfo && o.fromInfo.avatarUrl) || '')
    o.score = Number(o.score) || 0
    o.content = o.content || ''
    o.tags = o.tags || []
    o.replyText = (o.reply && o.reply.content) || ''
    o.timeText = util.fromNow(o.createTime)
    return o
  },

  _durationText(min) {
    const m = Number(min) || 0
    if (!m) return '时长面议'
    if (m < 60) return m + ' 分钟'
    const h = m / 60
    return (h % 1 === 0 ? h : h.toFixed(1)) + ' 小时'
  },

  /* ================================================================
   * 交互
   * ================================================================ */
  onBack() {
    if (getCurrentPages().length > 1) wx.navigateBack({ delta: 1 })
    else wx.switchTab({ url: '/pages/square/square' })
  },

  /** 作者卡 → 他人主页 */
  onAuthor() {
    const openid = this.data.authorOpenid
    if (!openid) return util.toast('暂时无法查看该用户主页')
    wx.navigateTo({ url: `/pages/user/home/home?openid=${openid}` })
  },

  /** 有经纬度时在微信地图中查看 */
  onOpenMap() {
    const d = this.data
    if (!d.hasGeo) return util.toast('该服务未设置具体位置')
    wx.openLocation({
      longitude: Number(d.longitude),
      latitude: Number(d.latitude),
      name: d.locationName || '服务地点',
      address: d.address || '',
      scale: 17,
      fail: () => util.toast('打开地图失败')
    })
  },

  /** 查看全部评价 */
  onMoreReviews() {
    const openid = this.data.authorOpenid
    if (!openid) return
    wx.navigateTo({ url: `/pages/user/home/home?openid=${openid}` })
  },

  /** 复制地址（无经纬度时的兜底） */
  onCopyAddress() {
    const t = [this.data.locationName, this.data.address].filter(Boolean).join(' ')
    if (!t) return util.toast('该服务未填写地点')
    util.copyText(t, '地址已复制')
  },

  /** 举报 */
  onReport() {
    const s = this.data.skill
    wx.navigateTo({
      url: `/pages/report/report?targetType=skill&targetId=${s._id}&targetTitle=${encodeURIComponent(s.title || '')}`,
      fail: () => util.toast('举报页暂不可用')
    })
  },

  /** 编辑（仅本人） */
  onEdit() {
    wx.navigateTo({ url: `/pages/publish/publish?id=${this.data.id}` })
  },

  /** 下架 / 删除（仅本人） */
  async onRemove() {
    const ok = await util.confirm('下架后同学们将无法在广场看到它，确定下架吗？', '下架技能')
    if (!ok) return
    try {
      util.loading('处理中')
      await api.skill.remove({ id: this.data.id })
      util.hideLoading()
      util.toastOk('已下架')
      getApp().emit('skillChange', { id: this.data.id })
      setTimeout(() => {
        if (getCurrentPages().length > 1) wx.navigateBack({ delta: 1 })
        else wx.switchTab({ url: '/pages/square/square' })
      }, 800)
    } catch (e) {
      util.hideLoading()
      util.toast(e.message)
    }
  },

  /** 立即预约：先过「资料 + 校园认证」守卫 */
  async onOrder() {
    if (this.data.submitting) return
    const app = getApp()
    this.setData({ submitting: true })
    try {
      await app.requireUser({ profile: true, verified: true })
    } catch (e) {
      // requireUser 被拒时自己会提示，这里只中止流程
      this.setData({ submitting: false })
      return
    }
    this.setData({ submitting: false })
    wx.navigateTo({ url: `/pages/order/create/create?skillId=${this.data.id}` })
  },

  /**
   * 联系 TA —— 直接为技能作者开一个会话。
   *
   * 与订单页的「联系 TA」等价（同一个 api.message.openChat），区别是这里没有订单，
   * 所以不传 orderId —— 会话先建起来，之后下单时会由 openChat 补上关联订单。
   * 参数拼装与 chat/room 的 onLoad 对齐。
   */
  async onChat() {
    if (this.data.chatting) return
    const author = this.data.author || {}
    const toId = author._openid || ''
    if (!toId) return util.toast('找不到对方信息')

    this.setData({ chatting: true })
    util.loading('打开会话')
    try {
      const res = await api.message.openChat({ toId })
      util.hideLoading()
      const chatId = (res && res.chatId) || ''
      if (!chatId) return util.toast('会话创建失败')
      const url = `/pages/chat/room/room?chatId=${chatId}&toId=${toId}`
        + `&name=${encodeURIComponent(author.nickName || '')}`
        + `&avatar=${encodeURIComponent(author.avatarUrl || '')}`
      wx.navigateTo({ url, fail: () => util.toast('聊天页暂不可用') })
    } catch (e) {
      util.hideLoading()
      util.toast((e && e.message) || '打开会话失败')
    } finally {
      this.setData({ chatting: false })
    }
  },

  /**
   * 收藏 / 取消收藏（封面右上角星标）。
   *
   * 采用**乐观更新**：先改 UI 再发请求，失败回滚 ——
   * 收藏是高频轻操作，等一次网络往返会有明显迟滞感。
   */
  async onToggleCollect() {
    if (this.data.collecting) return
    if (this.data.isOwner) return util.toast('不能收藏自己发布的技能')

    const next = !this.data.isCollected
    this.setData({ collecting: true, isCollected: next })   // 乐观更新
    try {
      const res = await api.skill.collect({ id: this.data.id, collected: next })
      const real = !!(res && res.collected)
      if (real !== next) this.setData({ isCollected: real })
      util.toast(real ? '已收藏' : '已取消收藏')
    } catch (e) {
      this.setData({ isCollected: !next })                  // 失败回滚
      util.toast((e && e.message) || '操作失败')
    } finally {
      this.setData({ collecting: false })
    }
  },

  onRetry() {
    this.loadDetail()
  },

  onGoSquare() {
    wx.switchTab({ url: '/pages/square/square' })
  },

  onShareAppMessage() {
    const s = this.data.skill
    return {
      title: (s && s.title) || '校园时间银行 · 技能详情',
      path: `/pages/skill/detail/detail?id=${this.data.id}`
    }
  }
})
