/**
 * 技能审核与下架 / 置顶
 * ==================================================================
 * 接口：api.admin.skills / auditSkill({ id, status, remark, isTop? })
 * 状态取值见 constants.SKILL_STATUS：1上架 0下架 2已完成 3违规下架 4待审核
 *
 * ★ auditSkill 是「状态 + 备注 + 置顶」一次性写库：
 *   · status 必传（后端 assert 0~4，缺省会 Number(undefined)=NaN → 400）
 *   · isTop 只有显式传了才更新，所以下架/恢复不传它，置顶态不会被误清
 *   · remark 后端缺省写成 ''（覆盖原备注），故置顶开关要把当前 auditRemark 回传
 *   置顶效果：广场列表按 isTop 优先，再按原有排序规则（仅对上架中技能可见）
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
  { v: '1', t: '上架中' },
  { v: '0', t: '已下架' },
  { v: '4', t: '待审核' },
  { v: '3', t: '违规下架' }
]

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
    loadingMore: false
  },

  onLoad() {
    this._boot()
  },

  async _boot() {
    const ok = await guard.requireAdmin(this)
    if (!ok) return
    this._debouncedSearch = util.debounce(() => this.loadList(true), 400)
    this.loadList(true)
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
      const params = {
        keyword: (this.data.keyword || '').trim(),
        page,
        size: PAGE_SIZE
      }
      if (this.data.status !== '') params.status = Number(this.data.status)

      const res = (await api.admin.skills(params)) || {}
      const fresh = (res.list || []).map(s => this.decorate(s))
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

  decorate(s) {
    const sk = s || {}
    const st = constants.SKILL_STATUS[Number(sk.status)] || {}
    const author = sk.authorInfo || {}
    const images = (sk.images || []).filter(Boolean)
    return Object.assign({}, sk, {
      _id: sk._id || '',
      title: sk.title || '未命名技能',
      categoryName: sk.categoryName || '未分类',
      categoryIcon: sk.categoryIcon || '✨',
      cover: images[0] || '',
      price: Number(sk.price || 0),
      viewCount: Number(sk.viewCount || 0),
      orderCount: Number(sk.orderCount || 0),
      authorName: author.nickName || '未知作者',
      authorAvatar: author.avatarUrl || '',
      statusText: st.text || '未知',
      statusTone: st.tone || 'outline',
      createTimeText: util.formatDate(sk.createTime) || '—',
      isTop: !!sk.isTop
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
  onStatusTab(e) {
    const v = String(e.currentTarget.dataset.v === undefined ? '' : e.currentTarget.dataset.v)
    if (v === this.data.status) return
    this.setData({ status: v })
    this.loadList(true)
  },

  /* ================================================================
   * 操作
   * ================================================================ */
  goDetail(e) {
    const id = e.currentTarget.dataset.id
    if (!id) return util.toast('该技能缺少 ID')
    util.navTo('/pages/skill/detail/detail?id=' + id)
  },

  /** 违规下架：先填原因（选填），再二次确认 */
  async onBan(e) {
    const item = this.getItem(e)
    if (!item) return

    const input = await util.prompt(
      '可填写下架原因（选填），会记录为该技能的审核备注',
      '违规下架',
      '如：内容与描述不符，涉嫌引流'
    )
    if (input === null) return // 取消输入 = 放弃操作
    const remark = util.trimAll(input)

    const ok = await util.confirm(
      `下架后「${item.title}」将在技能广场不再展示，作者端会看到状态与审核备注。\n` +
      `原因：${remark || '未填写'}\n确认违规下架吗？`,
      '违规下架'
    )
    if (!ok) return
    await this.audit(item, 3, remark, '已违规下架')
  },

  /** 恢复上架 */
  async onRestore(e) {
    const item = this.getItem(e)
    if (!item) return
    const ok = await util.confirm(
      `恢复后「${item.title}」会重新出现在技能广场，可以继续被下单。确认恢复上架吗？`,
      '恢复上架'
    )
    if (!ok) return
    await this.audit(item, 1, '', '已恢复上架')
  },

  /**
   * 置顶 / 取消置顶
   * ★ 必须把当前 status 与 auditRemark 一起回传：
   *   auditSkill 是「status + remark + isTop」一次性写库，
   *   只传 isTop 会让 status 变成 NaN（400），不传 remark 会把原审核备注清空。
   */
  async onToggleTop(e) {
    const item = this.getItem(e)
    if (!item) return
    const next = !item.isTop
    const effect = item.status === 1
      ? '置顶后该技能会排在技能广场列表最前面。'
      : '该技能当前不是「上架中」，置顶会在它恢复上架后生效。'
    const ok = await util.confirm(
      next
        ? `${effect}\n确认置顶「${item.title}」吗？`
        : `取消置顶后「${item.title}」将恢复按常规排序展示。确认取消置顶吗？`,
      next ? '置顶技能' : '取消置顶'
    )
    if (!ok) return
    await this.audit(item, item.status, item.auditRemark || '', next ? '已置顶' : '已取消置顶', next)
  },

  /**
   * @param {Object} item   列表项
   * @param {Number} status 目标状态（必传）
   * @param {String} remark 审核备注
   * @param {String} okTip  成功提示
   * @param {Boolean} [isTop] 传了才更新置顶态
   */
  async audit(item, status, remark, okTip, isTop) {
    if (this._acting) return
    this._acting = true
    util.loading('处理中')
    try {
      const payload = { id: item._id, status, remark }
      if (isTop !== undefined) payload.isTop = isTop
      await api.admin.auditSkill(payload)
      util.hideLoading()
      await this.loadList(true)

      // 置顶做「写后读」校验：后端若忽略 isTop（例如某个环境没更新），
      // 明确报出来，而不是让用户看到点了没反应的假按钮
      if (isTop !== undefined) {
        const fresh = this.data.list.find(x => x._id === item._id)
        if (fresh && fresh.isTop !== isTop) {
          util.toast('置顶未生效：后端未写入 isTop')
          return
        }
      }
      util.toastOk(okTip)
    } catch (e) {
      util.hideLoading()
      util.toast(e.message)
    } finally {
      this._acting = false
    }
  },

  getItem(e) {
    const id = e.currentTarget.dataset.id
    const item = this.data.list.find(x => x._id === id)
    if (!item) util.toast('该技能已不在列表中')
    return item || null
  }
})
