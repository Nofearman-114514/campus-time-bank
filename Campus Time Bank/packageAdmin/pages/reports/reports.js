/**
 * 举报处理
 * ==================================================================
 * 接口：api.admin.reports / handleReport
 *   result: 1 核实成立（★ 会对被举报人扣 10 点信用分，写 credit_logs）
 *           2 已驳回（需填写处理备注）
 *
 * 契约说明：reports 集合只冗余了 targetTitle/targetUserId，没有举报人昵称，
 * 因此举报人昵称通过 api.login.getUser 按需补齐（带本地缓存，失败则退化显示 ID 尾号）。
 * ==================================================================
 */
const api = require('../../../utils/api')
const util = require('../../../utils/util')
const constants = require('../../../utils/constants')
const envList = require('../../../envList')
const guard = require('../../utils/guard')

const PAGE_SIZE = envList.PAGE_SIZE || 10

const STATUS_OPTIONS = [
  { v: '', t: '全部' },
  { v: '0', t: '待处理' },
  { v: '1', t: '已处理' },
  { v: '2', t: '已驳回' }
]
const STATUS_TEXT = { 0: '待处理', 1: '已处理', 2: '已驳回' }
const STATUS_TONE = { 0: 'warn', 1: 'success', 2: 'outline' }

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

  onLoad() {
    this._boot()
  },

  async _boot() {
    const ok = await guard.requireAdmin(this)
    if (!ok) return
    this._userCache = {}
    this.loadPendingCount()
    this.loadList(true)
  },

  onPullDownRefresh() {
    if (!this._isAdmin) return wx.stopPullDownRefresh()
    this.loadPendingCount()
    this.loadList(true).then(() => wx.stopPullDownRefresh()).catch(() => wx.stopPullDownRefresh())
  },

  onReachBottom() {
    if (!this.data.hasMore || this.data.loading || this.data.loadingMore) return
    this.loadList(false)
  },

  /* ================================================================
   * 数据
   * ================================================================ */
  async loadPendingCount() {
    try {
      const res = (await api.admin.reports({ status: 0, page: 1, size: 1 })) || {}
      this.setData({ pendingCount: Number(res.total || 0) })
    } catch (e) {
      console.warn('[reports] 待处理数量获取失败', e.message)
    }
  },

  async loadList(reset) {
    if (this._loading) return
    this._loading = true
    const page = reset ? 1 : this.data.page + 1
    this.setData(reset ? { loading: true } : { loadingMore: true })

    try {
      const params = { page, size: PAGE_SIZE }
      if (this.data.status !== '') params.status = Number(this.data.status)

      const res = (await api.admin.reports(params)) || {}
      const fresh = (res.list || []).map(r => this.decorate(r))
      const list = reset ? fresh : this.data.list.concat(fresh)
      this.setData({
        list,
        page,
        total: Number(res.total || list.length),
        hasMore: !!res.hasMore,
        loading: false,
        loadingMore: false
      })
      this.resolveReporters(fresh)
    } catch (e) {
      this.setData({ loading: false, loadingMore: false })
      util.toast(e.message)
    } finally {
      this._loading = false
    }
  },

  decorate(r) {
    const it = r || {}
    const s = Number(it.status === undefined ? 0 : it.status)
    const images = (it.images || []).filter(Boolean)
    return Object.assign({}, it, {
      _id: it._id || '',
      reporterId: it._openid || '',
      reporterName: '',
      targetTypeText: constants.REPORT_TARGET[it.targetType] || '未知对象',
      targetTitle: it.targetTitle || '未记录标题',
      reason: it.reason || '未填写原因',
      // §3.11 已补 remark（举报页「补充说明」）；desc/content 为历史字段兜底
      desc: it.remark || it.desc || it.content || '',
      images,
      status: s,
      statusText: STATUS_TEXT[s] || '未知',
      statusTone: STATUS_TONE[s] || 'outline',
      createTimeText: util.formatTime(it.createTime) || '—',
      handleTimeText: it.handleTime ? (util.formatTime(it.handleTime) || '—') : ''
    })
  },

  /** 补齐举报人昵称（reports 未冗余昵称；带缓存，单条失败不影响列表） */
  async resolveReporters(list) {
    const ids = []
    ;(list || []).forEach(r => {
      if (r.reporterId && !this._userCache[r.reporterId] && ids.indexOf(r.reporterId) < 0) ids.push(r.reporterId)
    })
    if (!ids.length) return

    await Promise.all(ids.map(id =>
      api.login.getUser({ openid: id })
        .then(res => { this._userCache[id] = (res && res.user && res.user.nickName) || '' })
        .catch(() => { this._userCache[id] = '' })
    ))

    const list2 = this.data.list.map(r => {
      if (!r.reporterId) return r
      const name = this._userCache[r.reporterId]
      return Object.assign({}, r, { reporterName: name || ('用户 ' + String(r.reporterId).slice(-6)) })
    })
    this.setData({ list: list2 })
  },

  /* ================================================================
   * 筛选
   * ================================================================ */
  onStatusTab(e) {
    const v = String(e.currentTarget.dataset.v === undefined ? '' : e.currentTarget.dataset.v)
    if (v === this.data.status) return
    this.setData({ status: v, list: [] })
    this.loadList(true)
  },

  /* ================================================================
   * 处理
   * ================================================================ */
  /** 举报凭证预览 */
  previewImages(e) {
    const id = e.currentTarget.dataset.id
    const r = this.data.list.find(x => x._id === id)
    if (!r || !r.images.length) return
    const url = e.currentTarget.dataset.url
    util.previewImage(r.images, url || r.images[0])
  },

  /** 核实成立：备注（选填）→ 二次确认（明确告知扣 10 信用分） */
  async onValid(e) {
    const r = this.getItem(e)
    if (!r) return

    const input = await util.prompt(
        '核实成立',
        '处理说明（选填，会记录在举报单上）',
        ''
    )
    if (input === null) return
    const remark = util.trimAll(input) || '举报核实成立'

    const ok = await util.confirm(
      `核实成立后：\n` +
      `1. 将对被举报用户（${r.targetTitle}）扣除 10 点信用分，并写入一条信用分流水；\n` +
      `2. 举报人会收到「举报已处理」的系统通知；\n` +
      `3. 该操作不可撤销。\n\n确认核实成立吗？`,
      '核实举报成立'
    )
    if (!ok) return
    await this.handle(r, 1, remark)
  },

  /** 驳回：必须填写处理备注 */
  async onReject(e) {
    const r = this.getItem(e)
    if (!r) return

    let remark = ''
    for (let i = 0; i < 3; i++) {
      const input = await util.prompt(
          '驳回举报',
          '处理备注（必填，供复查）',
          ''
      )
      if (input === null) return
      remark = util.trimAll(input)
      if (remark) break
      util.toast('处理备注不能为空')
    }
    if (!remark) return
    await this.handle(r, 2, remark)
  },

  async handle(r, result, remark) {
    if (this._acting) return
    this._acting = true
    util.loading('提交中')
    try {
      await api.admin.handleReport({ id: r._id, result, remark })
      util.hideLoading()
      util.toastOk(result === 1 ? '已核实成立' : '已驳回')

      const handled = Object.assign({}, r, {
        status: result,
        statusText: STATUS_TEXT[result],
        statusTone: STATUS_TONE[result],
        handleRemark: remark,
        handleTimeText: util.formatTime(new Date()) || ''
      })
      // 在「待处理」筛选下处理完就直接从列表移出，其他筛选下原地更新
      const list = this.data.status === '0'
        ? this.data.list.filter(x => x._id !== r._id)
        : this.data.list.map(x => (x._id === r._id ? handled : x))

      this.setData({ list, pendingCount: Math.max(0, this.data.pendingCount - 1) })
      this.loadPendingCount()
    } catch (e) {
      util.hideLoading()
      util.toast(e.message)
    } finally {
      this._acting = false
    }
  },

  getItem(e) {
    const id = e.currentTarget.dataset.id
    const r = this.data.list.find(x => x._id === id)
    if (!r) util.toast('该举报单已不在列表中')
    return r || null
  },

  /** 查看被举报对象：技能 → 详情页；用户 → 主页 */
  goTarget(e) {
    const r = this.getItem(e)
    if (!r) return
    if (r.targetType === 'skill' && r.targetId) {
      return util.navTo('/pages/skill/detail/detail?id=' + r.targetId)
    }
    if (r.targetType === 'user' && r.targetUserId) {
      return util.navTo('/pages/user/home/home?openid=' + encodeURIComponent(r.targetUserId))
    }
    util.toast('该举报对象暂无可跳转的页面')
  }
})
