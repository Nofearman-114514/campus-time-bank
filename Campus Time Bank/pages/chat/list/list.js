/**
 * 消息列表
 * ------------------------------------------------------------------
 * 结构：系统通知入口卡（未读数 + 最新一条预览）→ 会话列表（按 lastTime desc）
 * 数据：api.message.conversations / api.message.notices / api.message.unreadTotal
 * 说明：从聊天室返回后未读会变，所以 onShow 必须重新拉取。
 * ------------------------------------------------------------------
 */
const api = require('../../../utils/api')
const util = require('../../../utils/util')
const constants = require('../../../utils/constants')

const PAGE_SIZE = 15

/** 会话行展示字段兜底（顶层函数，map 回调里不依赖 this） */
function decorateChat(c) {
  const chat = c || {}
  const other = chat.otherInfo || {}
  const unread = Number(chat.unreadCount) || 0
  return {
    _id: chat._id || '',
    otherId: chat.otherId || '',
    otherName: other.nickName || '用户',
    otherAvatar: other.avatarUrl || '',
    orderId: chat.orderId || '',
    lastMsg: chat.lastMsgType === 'image' ? '[图片]' : (chat.lastMsg || ''),
    lastMsgType: chat.lastMsgType || 'text',
    timeText: chat.lastTime ? util.fromNow(chat.lastTime) : '',
    unreadCount: unread,
    unreadText: unread > 99 ? '99+' : String(unread)
  }
}

Page({
  data: {
    /* 系统通知入口卡 */
    notice: null,          // 最新一条通知
    noticeUnread: 0,       // 通知未读数

    /* 会话列表 */
    list: [],
    page: 1,
    hasMore: true,
    total: 0,
    loading: false,
    loadingMore: false,
    firstLoaded: false,

    /* 消息未读总数（导航栏 / 头部提示用） */
    chatUnread: 0
  },

  /* ================================================================
   * 生命周期
   * ================================================================ */
  onLoad() {
    this.loadAll(true)
  },

  // ★ 从聊天室返回时未读已变化，必须重新拉取
  onShow() {
    if (this.data.firstLoaded) this.loadAll(true)
  },

  /* ================================================================
   * 数据加载
   * ================================================================ */
  loadAll(reset) {
    return Promise.all([
      this.loadNoticeEntry(),
      this.loadList(reset)
    ])
  },

  /** 系统通知入口：最新一条 + 未读数 */
  async loadNoticeEntry() {
    try {
      const [res, unread] = await Promise.all([
        api.message.notices({ page: 1, size: 1, type: 'all' }),
        api.message.unreadTotal({}).catch(() => null)
      ])
      const list = (res && res.list) || []
      const item = list[0] || null
      this.setData({
        // 兜底：只取需要的字段，避免把 undefined 写进 data
        notice: item ? {
          _id: item._id || '',
          type: item.type || 'system',
          title: item.title || '',
          content: item.content || '',
          read: !!item.read,
          timeText: util.fromNow(item.createTime)
        } : null,
        noticeUnread: (unread && unread.notice) || 0,
        chatUnread: (unread && unread.chat) || 0
      })
    } catch (e) {
      // 入口卡失败不影响会话列表
      this.setData({ notice: null, noticeUnread: 0 })
      util.toast(e.message)
    }
  },

  /** 会话列表 */
  async loadList(reset) {
    if (this.data.loading) return
    const page = reset ? 1 : this.data.page + 1
    this.setData({ loading: true, loadingMore: !reset && this.data.list.length > 0 })

    try {
      const res = await api.message.conversations({ page: page, size: PAGE_SIZE })
      const rows = ((res && res.list) || []).map(decorateChat)
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
      const app = getApp()
      app.refreshTabBadge()
    }
  },

  /** 会话行展示字段兜底：见文件顶部 decorateChat */

  /* ================================================================
   * 交互
   * ================================================================ */
  /** → 系统通知列表 */
  goNotice() {
    wx.navigateTo({ url: '/pages/notice/list/list' })
  },

  /** → 聊天室 */
  openChat(e) {
    const id = e.currentTarget.dataset.id
    const item = this.data.list.find(c => c._id === id)
    if (!item) return
    // 把对方信息带过去，聊天室可以立刻显示昵称，不必再多请求一次
    const q = [
      'chatId=' + encodeURIComponent(item._id),
      'toId=' + encodeURIComponent(item.otherId),
      'name=' + encodeURIComponent(item.otherName),
      'avatar=' + encodeURIComponent(item.otherAvatar),
      'orderId=' + encodeURIComponent(item.orderId)
    ].join('&')
    wx.navigateTo({ url: '/pages/chat/room/room?' + q })
  },

  /**
   * 会话长按：暂不做删除（会话由服务端维护），只提示
   * 保留入口便于后续扩展
   */
  onChatLongPress() {
    util.toast('会话由系统统一维护，暂不支持删除')
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
    this.loadList(false)
  },

  onShareAppMessage() {
    return { title: '校园时间银行 · 用技能换技能', path: '/pages/square/square' }
  }
})
