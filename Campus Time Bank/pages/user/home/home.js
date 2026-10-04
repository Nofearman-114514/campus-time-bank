/**
 * 他人主页
 * ------------------------------------------------------------------
 * 自定义导航（透明）→ 渐变头图 → 头像压在头图下沿 → 简介 / 信用 / 评分
 * → 数据行 → TA 的技能 → TA 收到的评价 → 底部「打招呼 / 举报」
 * 入口：技能详情页作者、评价列表等，参数 ?openid=xxx
 * ------------------------------------------------------------------
 */
const api = require('../../../utils/api')
const util = require('../../../utils/util')
const credit = require('../../../utils/credit')

Page({
  data: {
    openid: '',
    loading: true,

    user: {},
    stats: {},
    skills: [],
    reviews: [],

    schoolLine: '',
    creditLevel: null,
    isSelf: false,
    goodRate: '暂无',
    doneCount: 0,
    chatLoading: false
  },

  /* ================================================================
   * 生命周期
   * ================================================================ */
  onLoad(options) {
    const openid = (options && options.openid) || ''
    const app = getApp()

    this.setData({
      openid: openid,
      isSelf: !!openid && openid === app.globalData.openid
    })

    if (!openid) {
      this.setData({ loading: false })
      util.toast('缺少用户标识')
      return
    }
    this.load()
  },

  onPullDownRefresh() {
    this.load().then(() => wx.stopPullDownRefresh())
  },

  /* ================================================================
   * 数据
   * ================================================================ */
  async load() {
    try {
      const res = (await api.user.home({ openid: this.data.openid })) || {}
      this.apply(res)
    } catch (e) {
      util.toast(e.message)
      this.setData({ user: {}, skills: [], reviews: [], stats: {} })
    } finally {
      this.setData({ loading: false })
    }
  },

  /** 统一落数据（setData 前兜底） */
  apply(res) {
    const app = getApp()
    const user = res.user || {}
    const stats = res.stats || {}
    const avg = Number(stats.avgRating) || 0
    const school = [user.campus, user.college, user.grade].filter(Boolean)

    // 评价按时间友好化 + 匿名处理
    const reviews = (res.reviews || []).map(r => {
      const item = r || {}
      return Object.assign({}, item, {
        fromInfo: item.anonymous
          ? { nickName: '匿名同学', avatarUrl: '' }
          : (item.fromInfo || { nickName: '同学', avatarUrl: '' }),
        timeText: util.fromNow(item.createTime)
      })
    })

    this.setData({
      user: user,
      stats: stats,
      skills: res.skills || [],
      reviews: reviews,
      schoolLine: school.join(' · '),
      creditLevel: credit.getLevel(user.creditScore === undefined ? 100 : user.creditScore),
      goodRate: avg > 0 ? Math.round(avg / 5 * 100) + '%' : '暂无',
      doneCount: (stats.serveCount || 0) + (stats.buyCount || 0),
      // 登录态可能晚于本页加载，这里用返回的 _openid 兜底判断
      isSelf: this.data.isSelf || (!!user._openid && user._openid === app.globalData.openid)
    })
  },

  /* ================================================================
   * 交互
   * ================================================================ */
  /** 技能卡片 → 技能详情 */
  onSkill(e) {
    const item = (e.detail && e.detail.item) || {}
    if (!item._id) return
    wx.navigateTo({ url: `/pages/skill/detail/detail?id=${item._id}` })
  },

  /** 打招呼：先建会话再进聊天室 */
  async onGreet() {
    if (this.data.chatLoading) return
    this.setData({ chatLoading: true })
    try {
      const res = await api.message.openChat({ toId: this.data.openid })
      const chatId = (res && res.chatId) || ''
      if (!chatId) throw new Error('会话创建失败')
      wx.navigateTo({ url: `/pages/chat/room/room?chatId=${chatId}` })
    } catch (e) {
      util.toast(e.message)
    } finally {
      this.setData({ chatLoading: false })
    }
  },

  /** 举报该用户 */
  onReport() {
    wx.navigateTo({
      url: `/pages/report/report?targetType=user&targetId=${this.data.openid}`,
      fail: () => util.toast('页面打开失败')
    })
  },

  onShareAppMessage() {
    return {
      title: `${(this.data.user && this.data.user.nickName) || '同学'}的校园技能主页`,
      path: `/pages/user/home/home?openid=${this.data.openid}`
    }
  }
})
