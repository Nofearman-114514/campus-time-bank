/**
 * 校园认证审核
 * ==================================================================
 * 接口：api.admin.users（按 authStatus 过滤）/ api.admin.auditUser
 * 默认只看 authStatus === 1（待审核），可切到「已通过 / 已驳回」回看。
 * 驳回必须填写原因（同步写 notices 通知用户，见 §4.7）。
 * ==================================================================
 */
const api = require('../../../utils/api')
const util = require('../../../utils/util')
const envList = require('../../../envList')
const guard = require('../../utils/guard')

const PAGE_SIZE = envList.PAGE_SIZE || 10

const TABS = [
  { v: '1', t: '待审核' },
  { v: '2', t: '已通过' },
  { v: '3', t: '已驳回' }
]

const EMPTY_TEXT = {
  '1': { icon: '✅', text: '没有待审核的认证', desc: '所有申请都处理完啦' },
  '2': { icon: '📄', text: '还没有通过的认证', desc: '通过后的用户会出现在这里' },
  '3': { icon: '📄', text: '还没有被驳回的认证', desc: '驳回记录会保留在这里，便于复查' }
}

Page({
  data: {
    tab: '1',
    tabs: TABS,
    pendingCount: 0,

    list: [],
    page: 1,
    total: 0,
    hasMore: false,
    loading: true,
    loadingMore: false,
    emptyView: EMPTY_TEXT['1']
  },

  onLoad() {
    this._boot()
  },

  async _boot() {
    const ok = await guard.requireAdmin(this)
    if (!ok) return
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
  /** 顶部待审数量：只取 total，故 size=1 */
  async loadPendingCount() {
    try {
      const res = (await api.admin.users({ authStatus: 1, page: 1, size: 1 })) || {}
      this.setData({ pendingCount: Number(res.total || 0) })
    } catch (e) {
      console.warn('[auth-audit] 待审数量获取失败', e.message)
    }
  },

  async loadList(reset) {
    if (this._loading) return
    this._loading = true
    const page = reset ? 1 : this.data.page + 1
    this.setData(reset ? { loading: true } : { loadingMore: true })

    try {
      const res = (await api.admin.users({
        authStatus: Number(this.data.tab),
        page,
        size: PAGE_SIZE
      })) || {}
      const fresh = (res.list || []).map(u => this.decorate(u))
      const list = reset ? fresh : this.data.list.concat(fresh)
      this.setData({
        list,
        page,
        total: Number(res.total || list.length),
        hasMore: !!res.hasMore,
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

  decorate(u) {
    const user = u || {}
    const images = (user.authImages || []).filter(Boolean)
    return Object.assign({}, user, {
      userId: user._openid || user._id || '',
      avatarUrl: user.avatarUrl || '',
      nickName: user.nickName || '未设置昵称',
      realName: user.realName || '未填写姓名',
      studentNo: user.studentNo || '—',
      campusText: [user.campus, user.college, user.major].filter(Boolean).join(' · ') || '未填写学校信息',
      submitTimeText: util.formatTime(user.authTime || user.updateTime) || '—',
      images,
      thumb: images[0] || ''
    })
  },

  onTab(e) {
    const v = String(e.currentTarget.dataset.v)
    if (!v || v === this.data.tab) return
    this.setData({ tab: v, emptyView: EMPTY_TEXT[v] || EMPTY_TEXT['1'], list: [] })
    this.loadList(true)
  },

  /* ================================================================
   * 审核
   * ================================================================ */
  /** 证件照全屏查看 */
  preview(e) {
    const userId = e.currentTarget.dataset.id
    const u = this.data.list.find(x => x.userId === userId)
    if (!u || !u.images.length) return util.toast('该申请没有上传证件照')
    const url = e.currentTarget.dataset.url
    util.previewImage(u.images, url || u.images[0])
  },

  async onPass(e) {
    const u = this.getItem(e)
    if (!u) return
    const ok = await util.confirm(
      `确认通过「${u.nickName}」（${u.realName} · ${u.studentNo}）的校园认证？通过后 TA 可以发布技能与下单。`,
      '通过认证'
    )
    if (!ok) return
    await this.handle(u, true, '')
  },

  async onReject(e) {
    const u = this.getItem(e)
    if (!u) return
    let remark = ''
    for (let i = 0; i < 3; i++) {
      const input = await util.prompt(
        '驳回校园认证',
        '驳回原因（必填，会通知该用户）',
        ''
      )
      if (input === null) return
      remark = util.trimAll(input)
      if (remark) break
      util.toast('驳回原因不能为空')
    }
    if (!remark) return
    await this.handle(u, false, remark)
  },

  /** 统一提交审核结果：从当前列表移除 + 刷新待审数量 */
  async handle(u, pass, remark) {
    if (this._acting) return
    this._acting = true
    util.loading('提交中')
    try {
      await api.admin.auditUser({ userId: u.userId, pass, remark })
      util.hideLoading()
      util.toastOk(pass ? '已通过' : '已驳回')

      const list = this.data.list.filter(x => x.userId !== u.userId)
      const pending = this.data.tab === '1'
        ? Math.max(0, this.data.pendingCount - 1)
        : this.data.pendingCount
      this.setData({
        list,
        total: Math.max(0, this.data.total - 1),
        pendingCount: pending
      })
      // 以服务端为准再校准一次待审数量（本地只是乐观更新）
      this.loadPendingCount()
    } catch (e) {
      util.hideLoading()
      util.toast(e.message)
    } finally {
      this._acting = false
    }
  },

  getItem(e) {
    const userId = e.currentTarget.dataset.id
    const u = this.data.list.find(x => x.userId === userId)
    if (!u) util.toast('该用户已不在列表中')
    return u || null
  }
})
