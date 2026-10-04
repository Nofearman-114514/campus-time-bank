/**
 * 订单详情
 * ------------------------------------------------------------------
 * 结构：状态大卡（渐变）→ 订单时间轴（状态机可视化）→ 服务信息 → 对方信息
 *      → 订单信息 → 时间币流水说明 → 去评价提示
 * 底部操作条：按钮规则与 components/order-card 的 action 完全一致
 *   （accept|reject|cancel|finish|confirm|chat|review），本页内抽成一套方法。
 * ------------------------------------------------------------------
 */
const api = require('../../../utils/api')
const util = require('../../../utils/util')
const constants = require('../../../utils/constants')

/** 各状态对应的语义色（用于注释与 wxml 的 class 对应关系；渐变在 wxss 里按同一套 token 定义） */
const STATUS_BG = {
  waiting: 'var(--c-warn)',
  ongoing: 'var(--c-info)',
  confirming: 'var(--c-accent)',
  finished: 'var(--c-success)',
  canceled: 'var(--c-t3)',
  closed: 'var(--c-t3)'
}

const DURATION_TEXT = {
  30: '30 分钟', 60: '1 小时', 90: '1.5 小时', 120: '2 小时',
  150: '2.5 小时', 180: '3 小时', 240: '4 小时'
}

const COVER_ICON = {
  学业辅导: '📚', 技能教学: '🎸', 摄影修图: '📷', 代取代买: '🛵',
  电脑技术: '💻', 运动健身: '🏃', 生活服务: '🧺', 设计美工: '🎨',
  语言互助: '🌏', 其他: '✨'
}

const REJECT_REASONS = ['时间冲突', '不在服务范围', '其他原因']

Page({
  data: {
    orderId: '',
    loading: true,
    order: {},
    role: 'buyer',
    statusKey: 'closed',
    statusText: '',
    statusDesc: '',

    /* 时间轴 */
    timeline: [],

    /* 服务信息 */
    coverIcon: '✨',
    durationText: '',

    /* 对方（根据 role 决定是买家还是服务者） */
    counterpart: {},
    counterpartId: '',
    counterpartTitle: '',

    /* 时间信息 */
    createTimeText: '',
    acceptTimeText: '',
    finishTimeText: '',
    confirmTimeText: '',
    expireText: '',
    autoConfirmText: '',

    /* 时间币说明 */
    coinFlow: [],

    /* 状态派生 */
    canCountdown: false,
    showAutoConfirm: false,
    needReview: false,
    actions: []
  },

  onLoad(options) {
    const orderId = (options && options.orderId) || ''
    if (!orderId) {
      util.toast('缺少订单参数')
      setTimeout(() => wx.navigateBack(), 800)
      return
    }
    this.setData({ orderId })
    this.loadDetail()
  },

  onShow() {
    // 从评价页 / 聊天页返回后刷新一次（跳过 onLoad 后的首次 onShow）
    if (this._entered && !this.data.loading) this.loadDetail(true)
    this._entered = true
  },

  onUnload() {
    this.clearTimer()
  },

  onHide() {
    this.clearTimer()
  },

  /* ================================================================
   * 数据加载与派生
   * ================================================================ */
  async loadDetail(silent) {
    if (!silent) this.setData({ loading: true })
    try {
      const res = await api.order.detail({ orderId: this.data.orderId })
      const order = (res && res.order) || {}
      const role = (res && res.role) || order.role || 'buyer'
      this.applyOrder(order, role)
      if (!silent) this.setData({ loading: false })
    } catch (e) {
      // 静默刷新失败时不再打扰用户，但首屏必须收掉骨架屏
      this.setData({ loading: false })
      if (!silent) util.toast(e.message)
    }
  },

  /** 把订单数据派生为页面所需的一切展示字段 */
  applyOrder(order, role) {
    const o = order || {}
    const st = constants.ORDER_STATUS[o.status] || constants.ORDER_STATUS.closed
    const snap = o.skillSnapshot || {}
    // ★ role 可能是 'admin'（非参与方的管理员查看）：此时既不是买家也不是卖家，
    //   绝不能走「取对方信息」的分支（否则会推出一个错误的对家），也不允许任何状态操作。
    const isParty = role === 'buyer' || role === 'seller'
    const isBuyer = role === 'buyer'
    const counterpart = isParty ? ((isBuyer ? o.sellerInfo : o.buyerInfo) || {}) : {}
    const counterpartId = isParty ? ((isBuyer ? o.sellerId : o.buyerId) || '') : ''
    const rated = !isParty || (isBuyer ? !!o.isRatedBuyer : !!o.isRatedSeller)
    const cfg = (getApp().globalData.config) || {}

    this.setData({
      order: o,
      role,
      isParty,
      isAdminView: !isParty,
      statusKey: o.status || 'closed',
      statusText: st.text,
      statusDesc: st.desc,

      timeline: this.buildTimeline(o),

      coverIcon: COVER_ICON[snap.categoryName] || '✨',
      durationText: DURATION_TEXT[snap.duration] || (snap.duration ? `${snap.duration} 分钟` : '未填写'),

      counterpart,
      counterpartId,
      counterpartTitle: isParty ? (isBuyer ? '服务者' : '买家') : '',

      createTimeText: util.formatTime(o.createTime) || '—',
      acceptTimeText: util.formatTime(o.acceptTime) || '—',
      finishTimeText: util.formatTime(o.finishTime) || '—',
      confirmTimeText: util.formatTime(o.confirmTime) || '—',
      expireText: util.countdown(o.expireTime),

      canCountdown: o.status === 'waiting' && !!o.expireTime,
      showAutoConfirm: o.status === 'confirming',
      autoConfirmText: this.buildAutoConfirmText(o, cfg),

      coinFlow: this.buildCoinFlow(o, role),

      needReview: isParty && o.status === 'finished' && !rated,
      actions: this.buildActions(o, role, rated)
    })

    // 待接单倒计时：每 30 秒刷新一次文案
    this.setupTimer()
  },

  /**
   * 「超时 N 小时后将自动确认」→ 用 finishTime + config.confirmExpireHours 算出精确时刻，
   * 记录时间戳（this._autoConfirmAt）后用统一的文案方法渲染，倒计时每 30s 复用它。
   */
  buildAutoConfirmText(o, cfg) {
    const hours = cfg.confirmExpireHours || 72
    const finish = util.toDate(o.finishTime)
    if (!finish) {
      this._autoConfirmAt = 0
      return `超时 ${hours} 小时后将自动确认`
    }
    this._autoConfirmAt = finish.getTime() + hours * 3600000
    return this.autoConfirmText()
  },

  /** 自动确认倒计时文案（供首屏与定时器共用） */
  autoConfirmText() {
    if (!this._autoConfirmAt) return ''
    const at = new Date(this._autoConfirmAt)
    return `将于 ${util.formatTime(at)} 自动确认（${util.countdown(at)}）`
  },

  /** 时间轴：优先用 order.timeline，缺失时用各时间字段兜底拼装 */
  buildTimeline(o) {
    const raw = Array.isArray(o.timeline) && o.timeline.length ? o.timeline : null
    const source = raw || this.fallbackTimeline(o)
    return source.map((t, i, arr) => {
      const st = constants.ORDER_STATUS[t.status] || {}
      return {
        key: `${t.status || 'x'}-${i}`,
        status: t.status || 'closed',
        title: st.text || '状态更新',
        remark: t.remark || st.desc || '',
        timeText: util.formatTime(t.time) || '—',
        isLast: i === arr.length - 1,
        dot: st.dot || 'closed'
      }
    })
  },

  /** 兜底：按标准时间字段还原一条最小时间轴 */
  fallbackTimeline(o) {
    const list = []
    if (o.createTime) list.push({ status: 'waiting', time: o.createTime, remark: '买家下单，时间币已冻结' })
    if (o.acceptTime) list.push({ status: 'ongoing', time: o.acceptTime, remark: '服务者已接单' })
    if (o.finishTime) list.push({ status: 'confirming', time: o.finishTime, remark: '服务者标记服务完成' })
    if (o.confirmTime) list.push({ status: 'finished', time: o.confirmTime, remark: '买家确认完成，时间币已结算' })
    if (o.cancelTime) {
      list.push({
        status: o.cancelBy === 'seller' ? 'closed' : 'canceled',
        time: o.cancelTime,
        remark: (o.cancelReason || '订单已取消')
      })
    }
    return list
  },

  /** 时间币流水说明：把「冻结 → 解冻 / 结算」讲清楚（答辩要点） */
  buildCoinFlow(o, role) {
    const amount = o.amount || 0
    const isBuyer = role !== 'seller'
    const flow = [{
      icon: '🔒',
      title: '下单冻结',
      text: `买家下单时冻结 ${amount} 枚时间币（可用余额减少，冻结额增加）`
    }]

    if (o.status === 'canceled' || o.status === 'closed') {
      flow.push({
        icon: '🔓',
        title: '取消解冻',
        text: `${amount} 枚已原路解冻退回买家可用余额`
      })
      if (o.cancelBy === 'seller' && o.status === 'closed') {
        flow.push({ icon: '🙅', title: '服务者拒单', text: '拒单不扣除任何一方信用分' })
      }
    } else if (o.status === 'finished') {
      flow.push({
        icon: '✅',
        title: '确认结算',
        text: `买家确认后冻结的 ${amount} 枚真正扣除，并转入服务者可用余额`
      })
      flow.push({ icon: '📈', title: '信用分 +2', text: '订单顺利完成，买卖双方各加 2 分信用分' })
    } else {
      flow.push({
        icon: '⏳',
        title: '等待结算',
        text: `服务完成并由买家确认后，${amount} 枚才会真正结算给服务者`
      })
    }
    flow.push({
      icon: 'ℹ️',
      title: '说明',
      text: isBuyer
        ? '时间币不可充值、不可提现，只能通过提供服务赚取'
        : '时间币不可充值、不可提现，服务完成后自动到账'
    })
    return flow
  },

  /** 底部按钮：与 order-card 的 action 规则保持一致；非参与方（管理员）无任何操作 */
  buildActions(o, role, rated) {
    const a = []
    // ★ 管理员查看：不得代替买卖双方接单/完成/确认，直接返回空数组
    if (role !== 'buyer' && role !== 'seller') return a
    const st = o.status
    if (st === 'waiting') {
      if (role === 'seller') {
        a.push({ key: 'reject', text: '无法接单', type: 'gray' })
        a.push({ key: 'accept', text: '接单', type: 'primary' })
      } else {
        a.push({ key: 'chat', text: '联系 TA', type: 'ghost' })
        a.push({ key: 'cancel', text: '取消订单', type: 'gray' })
      }
    } else if (st === 'ongoing') {
      if (role === 'seller') {
        a.push({ key: 'chat', text: '联系买家', type: 'ghost' })
        a.push({ key: 'finish', text: '标记完成', type: 'primary' })
      } else {
        a.push({ key: 'cancel', text: '取消订单', type: 'gray' })
        a.push({ key: 'chat', text: '联系 TA', type: 'ghost' })
      }
    } else if (st === 'confirming') {
      if (role === 'buyer') {
        a.push({ key: 'chat', text: '联系 TA', type: 'ghost' })
        a.push({ key: 'confirm', text: '确认完成', type: 'primary' })
      } else {
        a.push({ key: 'chat', text: '催一下', type: 'gray' })
      }
    } else if (st === 'finished') {
      if (!rated) a.push({ key: 'review', text: '去评价', type: 'accent' })
      else a.push({ key: 'chat', text: '再约一次', type: 'gray' })
    } else {
      a.push({ key: 'chat', text: '联系 TA', type: 'gray' })
    }
    return a
  },

  /* ================================================================
   * 倒计时
   * ================================================================ */
  setupTimer() {
    this.clearTimer()
    if (!this.data.canCountdown && !this._autoConfirmAt) return
    this._timer = setInterval(() => {
      const patch = {}
      if (this.data.canCountdown) {
        patch.expireText = util.countdown(this.data.order.expireTime)
      }
      if (this._autoConfirmAt) {
        patch.autoConfirmText = this.autoConfirmText()
      }
      if (Object.keys(patch).length) this.setData(patch)
    }, 30000)
  },
  clearTimer() {
    if (this._timer) {
      clearInterval(this._timer)
      this._timer = null
    }
  },

  /* ================================================================
   * 交互
   * ================================================================ */
  /** 长按复制订单号 */
  onCopyOrderNo() {
    util.copyText(this.data.order.orderNo || '', '订单号已复制')
  },

  onTapCounterpart() {
    const id = this.data.counterpartId
    if (!id) return
    util.navTo(`/pages/user/home/home?openid=${id}`)
  },

  onGoReview() {
    util.navTo(`/pages/review/create/create?orderId=${this.data.orderId}`)
  },

  /** 「联系 TA」按钮（等价于 chat action） */
  onContact() {
    this.onAction({ currentTarget: { dataset: { action: 'chat' } } })
  },

  /** 底部按钮统一入口 */
  onAction(e) {
    const action = e.currentTarget.dataset.action
    if (!action || this._acting) return
    const item = this.data.order
    this._acting = true
    // 不在入口统一 showLoading：拒单要先弹 actionSheet，蒙层会挡住弹窗
    Promise.resolve()
      .then(() => this.dispatch(action, item))
      .catch(err => {
        util.hideLoading()
        util.toast(err.message)
      })
      .then(() => { this._acting = false })
  },

  async dispatch(action, item) {
    switch (action) {
      case 'accept': return this.actAccept(item)
      case 'reject': return this.actReject(item)
      case 'cancel': return this.actCancel(item)
      case 'finish': return this.actFinish(item)
      case 'confirm': return this.actConfirm(item)
      case 'chat': return this.actChat(item)
      case 'review': return this.actReview(item)
      default: return null
    }
  },

  async actAccept(item) {
    const ok = await util.confirm('确认接下这个订单吗？接单后请在约定时间提供服务', '确认接单')
    if (!ok) return
    await this.run(() => api.order.accept({ orderId: item._id }), '接单成功')
  },

  async actReject(item) {
    const idx = await util.actionSheet(REJECT_REASONS)
    if (idx === null || idx === undefined) return
    const reason = REJECT_REASONS[idx] || '其他原因'
    await this.run(() => api.order.reject({ orderId: item._id, reason }), '已拒绝，时间币已退回买家')
  },

  async actCancel(item) {
    const ok = await util.confirm(
      '取消订单后时间币会立即退回。如果已被接单，取消方会扣除 5 点信用分，确认取消吗？',
      '取消订单'
    )
    if (!ok) return
    await this.run(
      () => api.order.cancel({ orderId: item._id, reason: '用户主动取消' }),
      '订单已取消'
    )
  },

  async actFinish(item) {
    const ok = await util.confirm('确认服务已完成？确认后将通知买家确认', '标记完成')
    if (!ok) return
    await this.run(() => api.order.finish({ orderId: item._id }), '已通知买家确认')
  },

  /** ★ 确认结算：不可撤销，文案必须写清去向与数量 */
  async actConfirm(item) {
    const seller = item.sellerInfo || {}
    const ok = await util.confirm(
      `确认服务已完成？确认后 ${item.amount || 0} 枚时间币将立即结算给 ${seller.nickName || '服务者'}，此操作不可撤销。`,
      '确认完成'
    )
    if (!ok) return
    await this.run(() => api.order.confirm({ orderId: item._id }), '已确认，时间币已结算')
  },

  async actChat(item) {
    const toId = this.data.counterpartId
    if (!toId) return util.toast('找不到对方信息')
    const cp = this.data.counterpart || {}
    util.hideLoading()
    util.loading('打开会话')
    try {
      const res = await api.message.openChat({ toId, orderId: item._id })
      util.hideLoading()
      const chatId = (res && res.chatId) || ''
      if (!chatId) return util.toast('会话创建失败')
      // 参数与 chat/room 的 onLoad 对齐
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

  actReview() {
    util.navTo(`/pages/review/create/create?orderId=${this.data.orderId}`)
  },

  /** 统一执行：调 api → 提示 → 刷新详情 + 同步 tabBar 角标 */
  async run(task, okTip) {
    try {
      await task()
      util.hideLoading()
      util.toastOk(okTip || '操作成功')
      getApp().refreshTabBadge()
      await this.loadDetail(true)
    } catch (e) {
      util.hideLoading()
      util.toast(e.message)
      // 状态冲突时（如已被处理）刷新一次，保证界面与后端一致
      if (e && e.code === 409) this.loadDetail(true)
    }
  }
})
