/**
 * 用户管理
 * ==================================================================
 * 接口：api.admin.users / setUserStatus / setUserRole / adjustCoins
 * 能力：昵称/学号搜索（防抖 400ms）＋ 认证状态、账号状态双筛选
 *       ＋ 封禁/解封、设/取消管理员、调整时间币（写流水）、查看主页
 * 所有危险操作均二次确认，并把后果写进确认文案。
 * ==================================================================
 */
const api = require('../../../utils/api')
const util = require('../../../utils/util')
const constants = require('../../../utils/constants')
const credit = require('../../../utils/credit')
const envList = require('../../../envList')
const guard = require('../../utils/guard')

const PAGE_SIZE = envList.PAGE_SIZE || 10

const AUTH_OPTIONS = [
  { v: '', t: '全部认证' },
  { v: '0', t: '未认证' },
  { v: '1', t: '待审核' },
  { v: '2', t: '已通过' },
  { v: '3', t: '已驳回' }
]
const STATUS_OPTIONS = [
  { v: '', t: '全部账号' },
  { v: '1', t: '正常' },
  { v: '0', t: '已封禁' }
]

Page({
  data: {
    keyword: '',
    authStatus: '',
    status: '',
    authOptions: AUTH_OPTIONS,
    statusOptions: STATUS_OPTIONS,

    list: [],
    page: 1,
    total: 0,
    hasMore: false,
    loading: true,
    loadingMore: false,

    /* 调整时间币弹层 */
    coinPopup: false,
    coinUser: null,
    coinAmount: '',
    coinRemark: '',

    /* 详情弹层 */
    detailPopup: false,
    detail: null
  },

  onLoad() {
    this._boot()
  },

  async _boot() {
    const ok = await guard.requireAdmin(this)
    if (!ok) return
    // ★ 是否为调试员 —— 决定操作菜单里有没有「设为调试员」那一项。
    //   与云端 admin.setUserRole 的规则一致：普通管理员不能授予调试员身份，
    //   否则他给自己升一级就绕过了整套隔离。
    this._isDebugger = await getApp().isDebuggerUser()
    // 搜索防抖（400ms）
    this._debouncedSearch = util.debounce(() => this.loadList(true), 400)
    this.loadList(true)
  },

  onUnload() {
    if (this._debouncedSearch && this._debouncedSearch.cancel) this._debouncedSearch.cancel()
  },

  onPullDownRefresh() {
    if (!this._isAdmin) return wx.stopPullDownRefresh()
    this.loadList(true).then(() => wx.stopPullDownRefresh()).catch(() => wx.stopPullDownRefresh())
  },

  onReachBottom() {
    if (!this.data.hasMore || this.data.loading || this.data.loadingMore) return
    this.loadList(false)
  },

  /* ================================================================
   * 数据
   * ================================================================ */
  async loadList(reset) {
    if (this._loading) return
    this._loading = true
    const page = reset ? 1 : this.data.page + 1
    this.setData(reset ? { loading: true } : { loadingMore: true })

    try {
      // 筛选条件为「全部」时不带该字段（避免云端按 '' 过滤成空列表）
      const params = {
        keyword: (this.data.keyword || '').trim(),
        page,
        size: PAGE_SIZE
      }
      if (this.data.authStatus !== '') params.authStatus = Number(this.data.authStatus)
      if (this.data.status !== '') params.status = Number(this.data.status)

      const res = (await api.admin.users(params)) || {}
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

  /** 列表项补全展示字段（WXML 里不能调 JS） */
  decorate(u) {
    const user = u || {}
    const auth = constants.AUTH_STATUS[user.authStatus] || {}
    const level = credit.getLevel(user.creditScore)
    return Object.assign({}, user, {
      userId: user._openid || user._id || '',
      avatarUrl: user.avatarUrl || '',
      nickName: user.nickName || '未设置昵称',
      authText: auth.text || '未知',
      authTone: auth.tone || '',
      statusText: user.status === 0 ? '已封禁' : '正常',
      creditScore: Number(user.creditScore || 0),
      creditLevelText: level ? level.text : '',
      coins: Number(user.coins || 0),
      frozenCoins: Number(user.frozenCoins || 0),
      createTimeText: util.formatDate(user.createTime) || '—',
      lastLoginText: util.fromNow(user.lastLoginTime) || '—'
    })
  },

  /* ================================================================
   * 筛选
   * ================================================================ */
  onKeyword(e) {
    this.setData({ keyword: e.detail.value })
    if (this._debouncedSearch) this._debouncedSearch()
  },

  clearKeyword() {
    this.setData({ keyword: '' })
    this.loadList(true)
  },

  onAuthTab(e) {
    const v = String(e.currentTarget.dataset.v === undefined ? '' : e.currentTarget.dataset.v)
    if (v === this.data.authStatus) return
    this.setData({ authStatus: v })
    this.loadList(true)
  },

  onStatusTab(e) {
    const v = String(e.currentTarget.dataset.v === undefined ? '' : e.currentTarget.dataset.v)
    if (v === this.data.status) return
    this.setData({ status: v })
    this.loadList(true)
  },

  /* ================================================================
   * 行内操作
   * ================================================================ */
  async onMore(e) {
    const userId = e.currentTarget.dataset.id
    const u = this.data.list.find(x => x.userId === userId)
    if (!u) return

    const banned = u.status === 0
    const isAdmin = u.role === 'admin'
    const isDebugger = u.role === 'debugger'

    /*
     * 菜单按能力动态拼，而不是写死下标 —— 少一项时下标不会错位。
     * ★ 「设为调试员」只对**调试员本人**出现（this._isDebugger）。
     */
    const items = ['查看详情', banned ? '解封账号' : '封禁账号']
    const acts = ['detail', 'ban']
    if (!isDebugger) {
      // 调试员已经包含管理员能力，不需要再来一个「设为管理员」
      items.push(isAdmin ? '取消管理员' : '设为管理员')
      acts.push('admin')
    }
    if (this._isDebugger) {
      items.push(isDebugger ? '取消调试员' : '设为调试员')
      acts.push('debugger')
    }
    items.push('调整时间币', '查看 TA 的主页')
    acts.push('coin', 'home')

    const idx = await util.actionSheet(items)
    if (idx === null || idx === undefined) return
    const act = acts[idx]

    switch (act) {
      case 'detail': this.openDetail(u); break
      case 'ban': await this.toggleBan(u, banned); break
      case 'admin': await this.toggleAdmin(u, isAdmin); break
      case 'debugger': await this.toggleDebugger(u, isDebugger); break
      case 'coin': this.openCoin(u); break
      case 'home':
        if (!u.userId) return util.toast('该用户缺少 ID，无法跳转')
        util.navTo('/pages/user/home/home?openid=' + encodeURIComponent(u.userId))
        break
      default: break
    }
  },

  /** 封禁 / 解封 */
  async toggleBan(u, banned) {
    const status = banned ? 1 : 0
    const content = banned
      ? `解封后「${u.nickName}」可以重新登录并使用小程序，确认解封吗？`
      : `封禁后「${u.nickName}」将无法登录使用小程序（技能不可见、不能下单接单），确认封禁吗？`
    const ok = await util.confirm(content, banned ? '解封账号' : '封禁账号')
    if (!ok) return
    await this.run(
      () => api.admin.setUserStatus({ userId: u.userId, status }),
      banned ? '已解封' : '已封禁'
    )
  },

  /** 设为 / 取消管理员 */
  async toggleAdmin(u, isAdmin) {
    const role = isAdmin ? 'user' : 'admin'
    const content = isAdmin
      ? `确认取消「${u.nickName}」的管理员身份吗？取消后 TA 将无法进入管理端。`
      : `设为管理员后，「${u.nickName}」可进入管理端查看全站数据、审核认证与处理举报，权限很大，确认吗？`
    const ok = await util.confirm(content, isAdmin ? '取消管理员' : '设为管理员')
    if (!ok) return
    await this.run(
      () => api.admin.setUserRole({ userId: u.userId, role }),
      isAdmin ? '已取消管理员' : '已设为管理员'
    )
  },

  /** 设为 / 取消调试员（校方）—— 只有调试员本人能做，云端也会再校验一次 */
  async toggleDebugger(u, isDebugger) {
    const role = isDebugger ? 'user' : 'debugger'
    const content = isDebugger
      ? `确认取消「${u.nickName}」的调试员身份吗？取消后 TA 将看不到未上线的调试功能。`
      : `设为调试员后，「${u.nickName}」能看到尚未上线的调试功能与全部数据，还能管理其他调试员。确认吗？`
    const ok = await util.confirm(content, isDebugger ? '取消调试员' : '设为调试员')
    if (!ok) return
    await this.run(
      () => api.admin.setUserRole({ userId: u.userId, role }),
      isDebugger ? '已取消调试员' : '已设为调试员'
    )
  },

  /* ================================================================
   * 调整时间币（自定义弹层）
   * ================================================================ */
  openCoin(u) {
    this.setData({
      coinPopup: true,
      coinUser: u,
      coinAmount: '',
      coinRemark: ''
    })
  },
  closeCoin() {
    this.setData({ coinPopup: false, coinUser: null, coinAmount: '', coinRemark: '' })
  },
  onCoinAmount(e) { this.setData({ coinAmount: e.detail.value }) },
  onCoinRemark(e) { this.setData({ coinRemark: e.detail.value }) },
  noop() { /* 阻止弹层内点击穿透 */ },

  async submitCoins() {
    const u = this.data.coinUser
    if (!u) return
    const raw = String(this.data.coinAmount || '').trim()
    if (!/^-?\d+$/.test(raw)) return util.toast('请输入整数（正数增加、负数扣减）')
    const amount = Number(raw)
    if (!amount) return util.toast('调整数量不能为 0')

    const willBe = u.coins + amount
    if (willBe < 0) return util.toast(`调整后余额为 ${willBe}，不能为负`)

    const ok = await util.confirm(
      `将为「${u.nickName}」${amount > 0 ? '增加' : '扣减'} ${Math.abs(amount)} 枚时间币，` +
      `余额 ${u.coins} → ${willBe}。该操作会写入一条「平台调整」流水记录且不可撤销，确认执行吗？`,
      '调整时间币'
    )
    if (!ok) return

    // 先取值再关弹层（关闭会清空表单）
    const remark = util.trimAll(this.data.coinRemark) || '管理员调整'
    this.closeCoin()
    await this.run(
      () => api.admin.adjustCoins({ userId: u.userId, amount, remark }),
      '已调整时间币'
    )
  },

  /* ================================================================
   * 详情弹层
   * ================================================================ */
  openDetail(u) {
    this.setData({
      detailPopup: true,
      detail: Object.assign({}, u, {
        statsText: u.stats
          ? `发布 ${u.stats.publishCount || 0} · 服务 ${u.stats.serveCount || 0} · 购买 ${u.stats.buyCount || 0} · 平均 ${u.stats.avgRating || 0} 分`
          : '暂无统计',
        campusText: [u.campus, u.college, u.major, u.grade].filter(Boolean).join(' · ') || '—'
      })
    })
  },
  closeDetail() {
    this.setData({ detailPopup: false, detail: null })
  },

  /** 证件照预览（认证资料，仅管理员可见） */
  previewAuth(e) {
    const urls = (this.data.detail && this.data.detail.authImages) || []
    if (!urls.length) return util.toast('该用户未上传证件照')
    const url = e.currentTarget.dataset.url
    util.previewImage(urls, url || urls[0])
  },

  copyOpenid() {
    const d = this.data.detail
    if (!d || !d.userId) return
    util.copyText(d.userId, '已复制 openid')
  },

  /* ================================================================
   * 通用执行
   * ================================================================ */
  async run(task, okTip) {
    util.loading('处理中')
    try {
      await task()
      util.hideLoading()
      util.toastOk(okTip || '操作成功')
      this.loadList(true)
    } catch (e) {
      util.hideLoading()
      util.toast(e.message)
    }
  }
})
