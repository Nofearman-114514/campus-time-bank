/**
 * 我的发布 / 我的接单
 * ------------------------------------------------------------------
 * 入口：个人中心 → 我的发布（?type=publish）/ 我的接单（?type=accept）
 *   · publish：api.skill.myList({ type, status, page, size })
 *     ★ 注意：这里的 type 指 offer / need（提供 / 求助），状态筛选用 status
 *   · accept：api.order.list({ role: 'seller', status, page, size })
 * 两种模式都支持下拉刷新 + 触底分页。
 * ------------------------------------------------------------------
 */
const api = require('../../../utils/api')
const util = require('../../../utils/util')
const constants = require('../../../utils/constants')

const PAGE_SIZE = 10

/** 我的发布：状态筛选（key === 'all' 表示不传 status） */
const PUBLISH_STATUS_TABS = [
  { key: 'all', text: '全部' },
  { key: '1', text: '上架中' },
  { key: '0', text: '已下架' },
  { key: '4', text: '待审核' }
]

/** 我的发布：提供 / 求助 子筛选（对应接口的 type 参数） */
const SKILL_TYPE_TABS = [
  { key: '', text: '全部' },
  { key: 'offer', text: '提供技能' },
  { key: 'need', text: '我要求助' }
]

Page({
  data: {
    mode: 'publish',            // publish | accept

    /* 筛选 */
    statusTabs: PUBLISH_STATUS_TABS,
    status: 'all',
    typeTabs: SKILL_TYPE_TABS,
    skillType: '',

    /* 列表 */
    list: [],
    page: 1,
    hasMore: true,
    total: 0,
    firstLoaded: false,
    loading: false,
    loadingMore: false,

    /* 我的接单：各状态数量 */
    orderCounts: { waiting: 0, ongoing: 0, confirming: 0, finished: 0 },

    /* 空态文案（两种模式不同） */
    emptyIcon: '📝',
    emptyText: '还没有发布过技能',
    emptyDesc: '把你的特长发出来，让别人用时间币来找你',
    emptyBtn: '去发布'
  },

  /* ================================================================
   * 生命周期
   * ================================================================ */
  onLoad(options) {
    const type = (options && options.type) === 'accept' ? 'accept' : 'publish'

    if (type === 'accept') {
      wx.setNavigationBarTitle({ title: '我的接单' })
      this.setData({
        mode: 'accept',
        statusTabs: constants.ORDER_TABS,   // 全部 / 待接单 / 服务中 / 待确认 / 已完成 / 已取消
        orderCounts: { waiting: 0, ongoing: 0, confirming: 0, finished: 0 },
        emptyIcon: '🤝',
        emptyText: '还没有接到单',
        emptyDesc: '去广场看看同学们需要什么帮助吧',
        emptyBtn: '去广场看看'
      })
    } else {
      wx.setNavigationBarTitle({ title: '我的发布' })
    }

    this.loadAll()
  },

  onPullDownRefresh() {
    this.loadAll().then(() => wx.stopPullDownRefresh())
  },

  onReachBottom() {
    if (!this.data.hasMore || this.data.loading) return
    this.loadList(false)
  },

  /* ================================================================
   * 数据
   * ================================================================ */
  /** 首次 / 刷新：列表 + 统计一起拉 */
  async loadAll() {
    const jobs = [this.loadList(true)]
    if (this.data.mode === 'accept') jobs.push(this.loadCounts())
    await Promise.all(jobs)
  },

  /** 我的接单：顶部统计 */
  async loadCounts() {
    try {
      const res = (await api.order.counts({})) || {}
      this.setData({
        orderCounts: {
          waiting: res.waiting || 0,
          ongoing: res.ongoing || 0,
          confirming: res.confirming || 0,
          finished: res.finished || 0
        }
      })
    } catch (e) {
      // 统计失败不影响列表
    }
  },

  /** 请求一页数据 */
  fetch(page) {
    if (this.data.mode === 'publish') {
      return api.skill.myList({
        page: page,
        size: PAGE_SIZE,
        // type：offer / need（空串表示全部）
        type: this.data.skillType || '',
        // status：上架 1 / 下架 0 / 待审核 4（空串表示全部）
        status: this.data.status === 'all' ? '' : Number(this.data.status)
      })
    }
    return api.order.list({
      role: 'seller',
      status: this.data.status || 'all',
      page: page,
      size: PAGE_SIZE
    })
  },

  async loadList(reset) {
    if (this.data.loading) return
    const page = reset ? 1 : this.data.page + 1

    this.setData({ loading: true, loadingMore: !reset && this.data.list.length > 0 })

    try {
      const res = (await this.fetch(page)) || {}
      const rows = this.data.mode === 'publish'
        ? this.decorate(res.list || [])
        : (res.list || [])
      const list = reset ? rows : this.data.list.concat(rows)

      this.setData({
        list: list,
        page: page,
        total: typeof res.total === 'number' ? res.total : list.length,
        hasMore: !!res.hasMore
      })
    } catch (e) {
      util.toast(e.message)
      if (reset) this.setData({ list: [], hasMore: false })
    } finally {
      this.setData({ loading: false, loadingMore: false, firstLoaded: true })
    }
  },

  /** 给技能补上状态文案与操作按钮（setData 前兜底） */
  decorate(list) {
    return (list || []).map(item => {
      const it = item || {}
      const status = constants.SKILL_STATUS[it.status] || { text: '未知', tone: '' }
      return Object.assign({}, it, {
        statusText: status.text,
        statusTone: status.tone || '',
        // 只有上架中 / 已下架 的技能才能切换上下架
        canToggle: it.status === 1 || it.status === 0,
        toggleText: it.status === 1 ? '下架' : '上架'
      })
    })
  },

  /* ================================================================
   * 筛选
   * ================================================================ */
  onStatus(e) {
    const key = e.currentTarget.dataset.key || 'all'
    if (key === this.data.status) return
    this.setData({ status: key })
    this.resetAndLoad()
  },

  onSkillType(e) {
    const key = e.currentTarget.dataset.key || ''
    if (key === this.data.skillType) return
    this.setData({ skillType: key })
    this.resetAndLoad()
  },

  resetAndLoad() {
    this.setData({ page: 1, hasMore: true })
    return this.loadList(true)
  },

  /* ================================================================
   * 我的发布：编辑 / 上下架 / 删除
   * ================================================================ */
  onCard(e) {
    const item = (e.detail && e.detail.item) || {}
    if (!item._id) return
    wx.navigateTo({ url: `/pages/skill/detail/detail?id=${item._id}` })
  },

  onEdit(e) {
    const id = e.currentTarget.dataset.id
    if (!id) return
    wx.navigateTo({ url: `/pages/publish/publish?id=${id}` })
  },

  /** 上下架 */
  async onToggle(e) {
    const id = e.currentTarget.dataset.id
    const status = Number(e.currentTarget.dataset.status)
    const next = status === 1 ? 0 : 1
    const tip = next === 1 ? '确认重新上架该技能吗？' : '下架后广场将不再展示该技能，确认下架吗？'

    if (!id) return
    if (!(await util.confirm(tip))) return

    try {
      await api.skill.update({ id: id, status: next })
      util.toastOk(next === 1 ? '已上架' : '已下架')
      this.resetAndLoad()
    } catch (err) {
      util.toast(err.message)
    }
  },

  /** 删除（不可恢复，二次确认） */
  async onDelete(e) {
    const id = e.currentTarget.dataset.id
    if (!id) return
    if (!(await util.confirm('删除后无法恢复，确认删除吗？'))) return

    try {
      await api.skill.remove({ id: id })
      util.toastOk('已删除')
      this.resetAndLoad()
    } catch (err) {
      util.toast(err.message)
    }
  },

  /* ================================================================
   * 我的接单：订单操作
   * ================================================================ */
  onOrderCard(e) {
    const item = (e.detail && e.detail.item) || {}
    if (!item._id) return
    wx.navigateTo({ url: `/pages/order/detail/detail?orderId=${item._id}` })
  },

  async onOrderAction(e) {
    const action = (e.detail && e.detail.action) || ''
    const item = (e.detail && e.detail.item) || {}
    const orderId = item._id
    if (!orderId || !action) return

    try {
      switch (action) {
        case 'accept':
          if (!(await util.confirm('确认接下这一单吗？'))) return
          await api.order.accept({ orderId: orderId })
          util.toastOk('已接单')
          break

        case 'reject':
          if (!(await util.confirm('拒绝后买家冻结的时间币会退回，确认无法接单吗？'))) return
          await api.order.reject({ orderId: orderId, reason: '暂时无法提供该服务' })
          util.toastOk('已拒单')
          break

        case 'finish':
          if (!(await util.confirm('确认已完成线下服务？确认后将等待买家确认。'))) return
          await api.order.finish({ orderId: orderId })
          util.toastOk('已标记完成')
          break

        case 'confirm':
          if (!(await util.confirm('确认该订单已完成吗？'))) return
          await api.order.confirm({ orderId: orderId })
          util.toastOk('订单已完成')
          break

        case 'cancel':
          if (!(await util.confirm('接单后取消会扣除信用分，确认取消吗？'))) return
          await api.order.cancel({ orderId: orderId, reason: '服务者取消' })
          util.toastOk('已取消')
          break

        case 'chat': {
          const toId = item.counterpartId || (item.role === 'buyer' ? item.sellerId : item.buyerId)
          if (!toId) return util.toast('无法定位对方')
          const res = await api.message.openChat({ toId: toId, orderId: orderId })
          const chatId = (res && res.chatId) || ''
          if (!chatId) throw new Error('会话创建失败')
          wx.navigateTo({ url: `/pages/chat/room/room?chatId=${chatId}` })
          return
        }

        case 'review':
          wx.navigateTo({ url: `/pages/review/create/create?orderId=${orderId}` })
          return

        default:
          return
      }
      // 操作成功后刷新列表与统计
      this.loadAll()
    } catch (err) {
      util.toast(err.message)
    }
  },

  /* ================================================================
   * 空态按钮
   * ================================================================ */
  onEmptyAction() {
    if (this.data.mode === 'publish') {
      wx.navigateTo({ url: '/pages/publish/publish' })
    } else {
      util.switchTab('/pages/square/square')
    }
  }
})
