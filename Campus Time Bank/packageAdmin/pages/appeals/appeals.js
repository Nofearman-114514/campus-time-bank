/**
 * 申诉处理
 * ==================================================================
 * 接口：api.admin.appeals / handleAppeal
 *   result: 1 成立 → ★ **撤销原处置**（信用分加回 / 技能恢复上架）+ 通知申诉人
 *           2 驳回 → 只通知
 *
 * ★ 与举报处理的方向相反：举报是「用户指控别人」，申诉是「用户为自己申辩」。
 *   成立时**不删原记录**，而是写一条反向记录（credit_logs 里记 appeal_ok），
 *   这样账本只增不改、可追溯 —— 处理结果里会告诉管理员具体撤销了什么。
 * ==================================================================
 */
const api = require('../../../utils/api')
const util = require('../../../utils/util')
const envList = require('../../../envList')
const guard = require('../../utils/guard')

const PAGE_SIZE = envList.PAGE_SIZE || 10

const STATUS_OPTIONS = [
  { v: '', t: '全部' },
  { v: '0', t: '待处理' },
  { v: '1', t: '已成立' },
  { v: '2', t: '未成立' }
]
const STATUS_TEXT = { 0: '待处理', 1: '已成立', 2: '未成立' }
const STATUS_TONE = { 0: 'warn', 1: 'success', 2: 'outline' }
const TYPE_TEXT = { credit: '信用分被扣', skill: '技能被下架' }

Page({
  data: {
    status: '',
    statusOptions: STATUS_OPTIONS,
    pendingCount: 0,
    list: [],
    page: 1,
    total: 0,
    hasMore: false,
    loading: true,
    loadingMore: false
  },

  onLoad() { this._boot() },

  async _boot() {
    const ok = await guard.requireAdmin(this)
    if (!ok) return
    this.loadPending()
    this.load()
  },

  async loadPending() {
    try {
      const res = (await api.admin.appeals({ status: 0, page: 1, size: 1 })) || {}
      this.setData({ pendingCount: Number(res.total || 0) })
    } catch (e) { /* 计数失败不影响列表 */ }
  },

  async load(more) {
    if (more && (!this.data.hasMore || this.data.loadingMore)) return
    const page = more ? this.data.page + 1 : 1
    this.setData(more ? { loadingMore: true } : { loading: true })
    try {
      const params = { page: page, size: PAGE_SIZE }
      if (this.data.status !== '') params.status = Number(this.data.status)
      const res = (await api.admin.appeals(params)) || {}
      const list = (res.list || []).map(it => Object.assign({}, it, this.decorate(it)))
      this.setData({
        list: more ? this.data.list.concat(list) : list,
        page: page,
        total: Number(res.total || 0),
        hasMore: !!res.hasMore,
        loading: false,
        loadingMore: false
      })
    } catch (e) {
      this.setData({ loading: false, loadingMore: false })
      util.toast((e && e.message) || '加载失败')
    }
  },

  decorate(it) {
    const s = Number(it.status === undefined ? 0 : it.status)
    return {
      status: s,
      statusText: STATUS_TEXT[s] || '未知',
      statusTone: STATUS_TONE[s] || 'outline',
      typeText: TYPE_TEXT[it.type] || '处置',
      timeText: util.formatTime(it.createTime, 'MM-DD HH:mm'),
      restoreText: it.type === 'credit'
        ? '成立将加回 ' + ((it.restore && it.restore.scoreChange) || 0) + ' 分信用分'
        : '成立将恢复技能上架'
    }
  },

  onStatusTab(e) {
    const v = String(e.currentTarget.dataset.v || '')
    if (v === this.data.status) return
    this.setData({ status: v, list: [] })
    this.load()
  },

  onReachBottom() { this.load(true) },

  onPullDownRefresh() {
    this.loadPending()
    this.load().then(() => wx.stopPullDownRefresh())
  },

  /** 核实成立：先二次确认，再让管理员填处理说明 */
  async onPass(e) {
    const id = e.currentTarget.dataset.id
    const item = this.data.list.filter(x => x._id === id)[0] || {}
    const ok = await util.confirm(
      '确认申诉成立？\n\n' + (item.restoreText || '') + '\n\n此操作会立即执行且不可撤销。',
      '申诉成立'
    )
    if (!ok) return
    const remark = await util.prompt('处理说明（会通知申诉人）', '如：核实确为误会，已恢复', '')
    if (remark === null) return
    this._handle(id, 1, remark)
  },

  /** 驳回 */
  async onReject(e) {
    const id = e.currentTarget.dataset.id
    const remark = await util.prompt('驳回必须填写理由（会通知申诉人）', '如：证据不足，未能核实', '')
    if (remark === null) return
    if (!String(remark).trim()) return util.toast('请填写驳回理由')
    this._handle(id, 2, remark)
  },

  async _handle(id, result, remark) {
    try {
      const res = (await api.admin.handleAppeal({ id: id, result: result, remark: remark })) || {}
      const undo = res.undo || {}
      // ★ 把「具体撤销了什么」如实告诉管理员 —— 否则他不知道生效了没
      util.toastOk(undo.handled ? undo.note : (result === 1 ? (undo.note || '已成立') : '已驳回'))
      this.loadPending()
      this.load()
    } catch (e) {
      util.toast((e && e.message) || '处理失败')
    }
  },

  goDetail(e) {
    const id = e.currentTarget.dataset.id
    const url = '/packageAdmin/pages/users/users?id=' + encodeURIComponent(id)
    /* 申诉对象可能是技能或用户，这里只做提示，不强行跳转 */
    util.toast('申诉对象 ID：' + id)
  }
})
