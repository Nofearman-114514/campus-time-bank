/**
 * 订单管理
 * ==================================================================
 * 接口：api.admin.orders（status/keyword/page/size）
 *      api.admin.stats —— 仅取 orderStatusDist 作为顶部统计条
 * 订单详情（留言、时间轴、取消原因）就地展开，不跳用户端详情页，
 * 因为管理端需要看到「全站订单」而不只是自己的订单。
 * ==================================================================
 */
const api = require('../../../utils/api')
const util = require('../../../utils/util')
const constants = require('../../../utils/constants')
const envList = require('../../../envList')
const guard = require('../../utils/guard')

const PAGE_SIZE = envList.PAGE_SIZE || 10

/** 统计条名称 → 订单状态 key（admin.stats().orderStatusDist 用的是中文名） */
const DIST_NAME_TO_KEY = {
  待接单: 'waiting',
  服务中: 'ongoing',
  待确认: 'confirming',
  已完成: 'finished',
  已取消: 'canceled',
  已关闭: 'closed'
}

const STATUS_OPTIONS = [{ v: '', t: '全部', count: null }].concat(
  constants.ORDER_STATUS_LIST.map(s => ({ v: s.key, t: s.text, count: null }))
)

Page({
  data: {
    keyword: '',
    status: '',
    statusOptions: STATUS_OPTIONS,

    list: [],
    page: 1,
    total: 0,
    hasMore: false,
    loading: true,
    loadingMore: false,

    expandedId: ''
  },

  onLoad() {
    this._boot()
  },

  async _boot() {
    const ok = await guard.requireAdmin(this)
    if (!ok) return
    this._debouncedSearch = util.debounce(() => this.loadList(true), 400)
    this.loadDist()
    this.loadList(true)
  },

  onPullDownRefresh() {
    if (!this._isAdmin) return wx.stopPullDownRefresh()
    this.loadDist()
    this.loadList(true).then(() => wx.stopPullDownRefresh()).catch(() => wx.stopPullDownRefresh())
  },

  onReachBottom() {
    if (!this.data.hasMore || this.data.loading || this.data.loadingMore) return
    this.loadList(false)
  },

  /* ================================================================
   * 顶部统计条
   * ================================================================ */
  async loadDist() {
    try {
      const res = (await api.admin.stats({ range: 7 })) || {}
      const dist = res.orderStatusDist || []
      const map = { waiting: 0, ongoing: 0, confirming: 0, finished: 0, canceled: 0, closed: 0 }
      let sum = 0
      dist.forEach(d => {
        const key = DIST_NAME_TO_KEY[(d && d.name) || '']
        const n = Number((d && d.value) || 0)
        sum += n
        if (key) map[key] += n
      })
      this.setData({
        statusOptions: STATUS_OPTIONS.map(o => Object.assign({}, o, {
          count: o.v === '' ? sum : map[o.v]
        }))
      })
    } catch (e) {
      // 统计失败不影响列表：用已加载列表兜底（见 applyLocalDist）
      console.warn('[orders] 状态统计获取失败', e.message)
      this._distFailed = true
    }
  },

  /** stats 不可用时，用当前已加载数据粗略统计，保证统计条不空白 */
  applyLocalDist(list) {
    if (!this._distFailed) return
    const map = { waiting: 0, ongoing: 0, confirming: 0, finished: 0, canceled: 0, closed: 0 }
    ;(list || []).forEach(o => { if (map[o.status] !== undefined) map[o.status] += 1 })
    const sum = Object.keys(map).reduce((n, k) => n + map[k], 0)
    this.setData({
      statusOptions: STATUS_OPTIONS.map(o => Object.assign({}, o, {
        count: o.v === '' ? sum : map[o.v]
      }))
    })
  },

  /* ================================================================
   * 列表
   * ================================================================ */
  async loadList(reset) {
    if (this._loading) return
    this._loading = true
    const page = reset ? 1 : this.data.page + 1
    this.setData(reset ? { loading: true } : { loadingMore: true })

    try {
      const params = {
        keyword: (this.data.keyword || '').trim(),
        page,
        size: PAGE_SIZE
      }
      if (this.data.status !== '') params.status = this.data.status

      const res = (await api.admin.orders(params)) || {}
      const fresh = (res.list || []).map(o => this.decorate(o))
      const list = reset ? fresh : this.data.list.concat(fresh)
      this.setData({
        list,
        page,
        total: Number(res.total || list.length),
        hasMore: !!res.hasMore,
        loading: false,
        loadingMore: false
      }, () => {
        if (reset) this.applyLocalDist(list)
      })
    } catch (e) {
      this.setData({ loading: false, loadingMore: false })
      util.toast(e.message)
    } finally {
      this._loading = false
    }
  },

  decorate(o) {
    const od = o || {}
    const buyer = od.buyerInfo || {}
    const seller = od.sellerInfo || {}
    const snap = od.skillSnapshot || {}
    const st = constants.ORDER_STATUS[od.status] || {}
    const timeline = (od.timeline || []).map((t, i) => {
      const ts = constants.ORDER_STATUS[t.status] || {}
      return {
        idx: 'node_' + i,
        status: t.status || '',
        text: ts.text || t.status || '状态变更',
        remark: t.remark || '',
        timeText: util.formatTime(t.time) || ''
      }
    })
    return Object.assign({}, od, {
      _id: od._id || '',
      orderNo: od.orderNo || '—',
      skillTitle: snap.title || '技能信息缺失',
      amount: Number(od.amount || 0),
      buyerName: buyer.nickName || '未知买家',
      buyerAvatar: buyer.avatarUrl || '',
      sellerName: seller.nickName || '未知服务者',
      sellerAvatar: seller.avatarUrl || '',
      statusText: st.text || '未知',
      statusColor: st.color || 'var(--c-t3)',
      createTimeText: util.formatTime(od.createTime) || '—',
      timeline,
      timelineView: timeline.slice(0, 5),
      expandTimeText: od.cancelTime || od.confirmTime || od.finishTime || od.createTime
    })
  },

  /* ================================================================
   * 筛选与展开
   * ================================================================ */
  onKeyword(e) {
    this.setData({ keyword: e.detail.value })
    if (this._debouncedSearch) this._debouncedSearch()
  },
  clearKeyword() {
    this.setData({ keyword: '' })
    this.loadList(true)
  },
  onStatusTab(e) {
    const v = String(e.currentTarget.dataset.v === undefined ? '' : e.currentTarget.dataset.v)
    if (v === this.data.status) return
    this.setData({ status: v, list: [], expandedId: '' })
    this.loadList(true)
  },

  toggleExpand(e) {
    const id = e.currentTarget.dataset.id
    if (!id) return
    this.setData({ expandedId: this.data.expandedId === id ? '' : id })
  },

  copyOrderNo(e) {
    const no = e.currentTarget.dataset.no
    if (no) util.copyText(no, '已复制订单号')
  },

  /** 查看买卖双方主页 */
  goUser(e) {
    const openid = e.currentTarget.dataset.openid
    if (!openid) return util.toast('该用户信息不完整')
    util.navTo('/pages/user/home/home?openid=' + encodeURIComponent(openid))
  },

  /** 查看关联技能 */
  goSkill(e) {
    const id = e.currentTarget.dataset.id
    if (!id) return util.toast('该订单没有关联技能')
    util.navTo('/pages/skill/detail/detail?id=' + id)
  }
})
