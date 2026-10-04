/**
 * 订单列表（tabBar 第 2 项）
 * ------------------------------------------------------------------
 * 一级 tab：我买到的（buyer）/ 我接的单（seller）
 * 二级筛选：constants.ORDER_TABS（全部/待接单/服务中/待确认/已完成/已取消关闭）
 * 列表项统一用 <order-card>，它的 bindaction 抛出的所有 action 都在本页实现，
 * 每个 action 都先二次确认（危险操作讲清后果）再调 api，成功后刷新并同步角标。
 * ------------------------------------------------------------------
 */
const api = require('../../../utils/api')
const util = require('../../../utils/util')
const constants = require('../../../utils/constants')
const envList = require('../../../envList')

const PAGE_SIZE = envList.PAGE_SIZE || 10

/** 不同 action 的确认文案（铁律：危险操作必须讲清后果） */
const CONFIRM_TEXT = {
  accept: '确认接下这个订单吗？接单后请在约定时间提供服务',
  cancel: '取消订单后时间币会立即退回。如果已被接单，取消方会扣除 5 点信用分，确认取消吗？',
  finish: '确认服务已完成？确认后将通知买家确认',
  confirm: '确认服务已完成？确认后 {amount} 枚时间币将立即结算给 {sellerName}，此操作不可撤销。'
}

/** 拒单原因选项 */
const REJECT_REASONS = ['时间冲突', '不在服务范围', '其他原因']

Page({
  data: {
    role: 'buyer',
    status: 'all',
    tabs: constants.ORDER_TABS,
    list: [],
    page: 1,
    hasMore: false,
    total: 0,
    loading: true,
    loadingMore: false,
    counts: { waiting: 0, ongoing: 0, confirming: 0, finished: 0, canceled: 0 },
    todo: 0
  },

  onLoad() {
    this.loadCounts()
    this.loadList(true)
  },

  onShow() {
    // tab 页：同步自定义 tabBar 选中态
    const app = getApp()
    app.selectTab(this, 1)
    app.refreshTabBadge()
    // onLoad 之后第一次 onShow 不重复请求，之后再进入（如从详情页返回）才静默刷新
    if (this._entered) {
      this.loadCounts()
      this.loadList(true)
    }
    this._entered = true
  },

  /* ================================================================
   * 数据加载
   * ================================================================ */
  /** 待办统计：「你有 N 个待处理订单」 */
  async loadCounts() {
    try {
      const res = await api.order.counts({})
      const c = Object.assign({ waiting: 0, ongoing: 0, confirming: 0, finished: 0, canceled: 0 }, res || {})
      this.setData({
        counts: c,
        todo: (c.waiting || 0) + (c.confirming || 0)
      })
    } catch (e) {
      // 统计失败不影响列表
      this.setData({ counts: { waiting: 0, ongoing: 0, confirming: 0, finished: 0, canceled: 0 }, todo: 0 })
    }
  },

  async loadList(reset, silent) {
    if (this._loading) return
    this._loading = true
    const page = reset ? 1 : this.data.page + 1
    // silent：原地刷新，不闪骨架屏（用于操作成功后的即时刷新）
    this.setData(reset ? { loading: !silent } : { loadingMore: !silent })

    try {
      const res = await api.order.list({
        role: this.data.role,
        status: this.data.status,
        page,
        size: PAGE_SIZE
      })
      const fresh = (res && res.list) || []
      const list = reset ? fresh : this.data.list.concat(fresh)
      this.setData({
        list,
        page,
        total: (res && res.total) || list.length,
        hasMore: !!(res && res.hasMore),
        loading: false,
        loadingMore: false
      })
    } catch (e) {
      this.setData({ loading: false, loadingMore: false })
      util.toast(e.message)
    } finally {
      this._loading = false
    }
  },

  /** 刷新列表（保留当前筛选）；silent=true 时原地刷新不闪骨架屏 */
  refresh(silent) {
    this.loadCounts()
    this.loadList(true, silent)
  },

  onPullDownRefresh() {
    Promise.all([this.loadCounts(), this.loadList(true)]).then(() => {
      wx.stopPullDownRefresh()
    }).catch(() => wx.stopPullDownRefresh())
  },

  onReachBottom() {
    if (!this.data.hasMore || this.data.loadingMore || this.data.loading) return
    this.loadList(false)
  },

  /* ================================================================
   * 筛选切换
   * ================================================================ */
  onRoleTab(e) {
    const role = e.currentTarget.dataset.role
    if (!role || role === this.data.role) return
    this.setData({ role })
    this.loadList(true)
  },

  onStatusTab(e) {
    const status = e.currentTarget.dataset.status
    if (!status || status === this.data.status) return
    this.setData({ status })
    this.loadList(true)
  },

  /* ================================================================
   * 卡片事件
   * ================================================================ */
  onCard(e) {
    const item = (e.detail && e.detail.item) || {}
    if (!item._id) return
    util.navTo(`/pages/order/detail/detail?orderId=${item._id}`)
  },

  /** 统一入口：order-card 抛出的 action ∈ accept|reject|cancel|finish|confirm|chat|review */
  async onAction(e) {
    const detail = e.detail || {}
    const action = detail.action
    const item = detail.item || {}
    if (!action || !item._id) return

    // 防连点
    if (this._acting) return
    this._acting = true
    try {
      switch (action) {
        case 'accept': await this.actAccept(item); break
        case 'reject': await this.actReject(item); break
        case 'cancel': await this.actCancel(item); break
        case 'finish': await this.actFinish(item); break
        case 'confirm': await this.actConfirm(item); break
        case 'chat': await this.actChat(item); break
        case 'review':
          util.navTo(`/pages/review/create/create?orderId=${item._id}`)
          break
        default:
          // 未识别的 action：兜底进详情页，不静默失败
          util.navTo(`/pages/order/detail/detail?orderId=${item._id}`)
      }
    } finally {
      this._acting = false
    }
  },

  /* ================================================================
   * 各 action 的具体实现（先确认，再调 api，成功后刷新 + 同步角标）
   * ================================================================ */
  /** 卖家接单 */
  async actAccept(item) {
    const ok = await util.confirm(CONFIRM_TEXT.accept, '确认接单')
    if (!ok) return
    await this.run(() => api.order.accept({ orderId: item._id }), '接单成功')
  },

  /** 卖家拒单：先选原因 */
  async actReject(item) {
    const idx = await util.actionSheet(REJECT_REASONS)
    if (idx === null || idx === undefined) return
    const reason = REJECT_REASONS[idx] || '其他原因'
    await this.run(
      () => api.order.reject({ orderId: item._id, reason }),
      '已拒绝该订单，时间币已退回买家'
    )
  },

  /** 取消订单：警告信用分影响 */
  async actCancel(item) {
    const ok = await util.confirm(CONFIRM_TEXT.cancel, '取消订单')
    if (!ok) return
    await this.run(
      () => api.order.cancel({ orderId: item._id, reason: '用户主动取消' }),
      '订单已取消'
    )
  },

  /** 卖家标记服务完成 */
  async actFinish(item) {
    const ok = await util.confirm(CONFIRM_TEXT.finish, '标记完成')
    if (!ok) return
    await this.run(() => api.order.finish({ orderId: item._id }), '已通知买家确认')
  },

  /** ★ 买家确认完成 → 冻结的时间币结算给服务者，不可撤销 */
  async actConfirm(item) {
    const isBuyer = item.role ? item.role === 'buyer' : item.buyerId === (getApp().globalData.openid || '')
    const seller = isBuyer ? (item.sellerInfo || {}) : (item.buyerInfo || {})
    const content = CONFIRM_TEXT.confirm
      .replace('{amount}', item.amount || 0)
      .replace('{sellerName}', seller.nickName || '对方')
    const ok = await util.confirm(content, '确认完成')
    if (!ok) return
    await this.run(() => api.order.confirm({ orderId: item._id }), '已确认，时间币已结算')
  },

  /** 联系对方：openChat 拿 chatId 再进聊天室 */
  async actChat(item) {
    const openid = getApp().globalData.openid || ''
    const toId = item.counterpartId ||
      (item.role === 'seller' ? item.buyerId : item.sellerId) ||
      (item.buyerId === openid ? item.sellerId : item.buyerId)
    if (!toId) return util.toast('找不到对方信息')
    const cp = item.counterpart || (item.role === 'seller' ? item.buyerInfo : item.sellerInfo) || {}
    util.loading('打开会话')
    try {
      const res = await api.message.openChat({ toId, orderId: item._id })
      util.hideLoading()
      const chatId = (res && res.chatId) || ''
      if (!chatId) return util.toast('会话创建失败')
      // 带上名称/头像，聊天页可直接显示对方信息（参数与 chat/room 的 onLoad 对齐）
      const url = `/pages/chat/room/room?chatId=${chatId}&toId=${toId}`
        + `&name=${encodeURIComponent(cp.nickName || '')}`
        + `&avatar=${encodeURIComponent(cp.avatarUrl || '')}`
        + `&orderId=${item._id}`
      wx.navigateTo({ url, fail: () => util.toast('聊天页暂不可用') })
    } catch (e) {
      util.hideLoading()
      util.toast(e.message)
    }
  },

  /**
   * 统一执行：错误提示 + 成功刷新 + tabBar 角标同步
   * @param {Function} task 返回 Promise 的 api 调用
   * @param {String} okTip 成功提示
   */
  async run(task, okTip) {
    util.loading('处理中')
    try {
      await task()
      util.hideLoading()
      util.toastOk(okTip || '操作成功')
      getApp().refreshTabBadge()
      this.refresh(true)
    } catch (e) {
      util.hideLoading()
      util.toast(e.message)
    }
  }
})
