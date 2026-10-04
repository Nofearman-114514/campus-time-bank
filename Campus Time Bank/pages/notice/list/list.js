/**
 * 系统通知
 * ------------------------------------------------------------------
 * 顶部筛选 constants.NOTICE_TYPE（全部/订单动态/认证审核/信用变动/举报结果/系统消息）
 * 行：类型图标（按 NOTICE_TYPE[type].color 着色圆底）+ 标题 + 内容（两行省略）+ 时间
 * 点击：标记已读 + 智能跳转
 *   orderId 有值 → 订单详情；type=audit → 校园认证页；
 *   type=credit → 信用分详情；否则原地展开全文
 * ------------------------------------------------------------------
 */
const api = require('../../../utils/api')
const util = require('../../../utils/util')
const constants = require('../../../utils/constants')

const PAGE_SIZE = 15

/** 筛选 tab：全部 + NOTICE_TYPE 的 5 种 */
const TYPE_TABS = [{ key: 'all', text: '全部' }].concat(
  Object.keys(constants.NOTICE_TYPE).map(k => ({ key: k, text: constants.NOTICE_TYPE[k].text }))
)

/** 通知行展示字段兜底（颜色/图标按 constants.NOTICE_TYPE 映射） */
function decorateNotice(n) {
  const notice = n || {}
  const meta = constants.NOTICE_TYPE[notice.type] || constants.NOTICE_TYPE.system
  return {
    _id: notice._id || '',
    type: notice.type || 'system',
    typeText: meta.text,
    typeIcon: meta.icon,
    typeColor: meta.color,
    title: notice.title || '系统通知',
    content: notice.content || '',
    orderId: notice.orderId || '',
    read: !!notice.read,
    open: false,
    // 日期 + 时刻，通知列表用绝对时间更清晰
    timeText: util.formatShort(notice.createTime)
  }
}

Page({
  data: {
    tabs: TYPE_TABS,
    activeType: 'all',

    list: [],
    page: 1,
    hasMore: true,
    total: 0,
    unread: 0,
    loading: false,
    loadingMore: false,
    firstLoaded: false,
    reading: false      // 正在「全部已读」
  },

  onLoad() {
    this.loadList(true)
  },

  onShow() {
    // 从订单详情返回后状态可能变化（例如通知被其它页面读掉）
    if (this.data.firstLoaded) this.loadList(true)
  },

  /* ================================================================
   * 数据加载
   * ================================================================ */
  async loadList(reset) {
    if (this.data.loading) return
    const page = reset ? 1 : this.data.page + 1
    this.setData({ loading: true, loadingMore: !reset && this.data.list.length > 0 })

    try {
      const res = await api.message.notices({
        page: page,
        size: PAGE_SIZE,
        type: this.data.activeType
      })
      const rows = ((res && res.list) || []).map(decorateNotice)
      const list = reset ? rows : this.data.list.concat(rows)
      this.setData({
        list: list,
        page: page,
        total: (res && res.total) || list.length,
        hasMore: !!(res && res.hasMore),
        unread: list.filter(n => !n.read).length
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
    if (key === this.data.activeType) return
    this.setData({ activeType: key, list: [], page: 1, hasMore: true })
    this.loadList(true)
  },

  /** 点击一行：标记已读 → 智能跳转 / 展开 */
  async onTapItem(e) {
    const id = e.currentTarget.dataset.id
    const idx = this.data.list.findIndex(n => n._id === id)
    if (idx < 0) return
    const item = this.data.list[idx]

    // 先做已读（失败不阻断跳转）
    if (!item.read) {
      try {
        await api.message.readNotice({ id: item._id })
        this.setData({
          ['list[' + idx + '].read']: true,
          unread: Math.max(0, this.data.unread - 1)
        })
        getApp().refreshTabBadge()
      } catch (err) {
        util.toast(err.message)
      }
    }

    // 智能跳转
    if (item.orderId) {
      wx.navigateTo({
        url: '/pages/order/detail/detail?orderId=' + item.orderId,
        fail: () => this.toggleOpen(idx)
      })
      return
    }
    if (item.type === 'audit') {
      wx.navigateTo({ url: '/pages/auth/campus/campus', fail: () => this.toggleOpen(idx) })
      return
    }
    if (item.type === 'credit') {
      wx.navigateTo({ url: '/pages/credit/detail/detail', fail: () => this.toggleOpen(idx) })
      return
    }
    // 其余（举报结果 / 系统消息）原地展开全文
    this.toggleOpen(idx)
  },

  /** 展开 / 收起全文 */
  toggleOpen(idx) {
    this.setData({ ['list[' + idx + '].open']: !this.data.list[idx].open })
  },

  /** 右上角「全部已读」 */
  async onReadAll() {
    if (this.data.reading) return
    if (this.data.unread === 0) {
      util.toast('没有未读通知')
      return
    }
    const ok = await util.confirm('确认把全部通知标记为已读吗？', '全部已读')
    if (!ok) return

    this.setData({ reading: true })
    try {
      await api.message.readNotice({ all: true })
      const list = this.data.list.map(n => Object.assign({}, n, { read: true }))
      this.setData({ list: list, unread: 0 })
      util.toastOk('已全部标记为已读')
      getApp().refreshTabBadge()
    } catch (e) {
      util.toast(e.message)
    } finally {
      this.setData({ reading: false })
    }
  },

  /* ================================================================
   * 下拉刷新 / 触底加载
   * ================================================================ */
  async onPullDownRefresh() {
    this.setData({ page: 1, hasMore: true })
    await this.loadList(true)
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
