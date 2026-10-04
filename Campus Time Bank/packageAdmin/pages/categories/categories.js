/**
 * 技能分类管理
 * ==================================================================
 * 接口：api.admin.categories / saveCategory / deleteCategory
 * 排序用「上下箭头」交换 sort（简单可靠，避免拖拽在小程序里的兼容坑）。
 * 删除时后端若有技能引用会返回 409，这里捕获后直接展示 e.message。
 * ==================================================================
 */
const api = require('../../../utils/api')
const util = require('../../../utils/util')
const guard = require('../../utils/guard')

const EMPTY_FORM = { visible: false, id: '', name: '', icon: '✨', sort: '99', status: 1 }

Page({
  data: {
    list: [],
    loading: true,
    skillCountReady: false,
    form: Object.assign({}, EMPTY_FORM)
  },

  onLoad() {
    this._boot()
  },

  async _boot() {
    const ok = await guard.requireAdmin(this)
    if (!ok) return
    this.loadList()
  },

  onPullDownRefresh() {
    if (!this._isAdmin) return wx.stopPullDownRefresh()
    this.loadList().then(() => wx.stopPullDownRefresh()).catch(() => wx.stopPullDownRefresh())
  },

  /* ================================================================
   * 数据
   * ================================================================ */
  async loadList() {
    this.setData({ loading: true })
    try {
      const res = (await api.admin.categories({})) || {}
      const list = (res.list || []).map(c => ({
        _id: c._id,
        name: c.name || '未命名分类',
        icon: c.icon || '✨',
        sort: Number(c.sort || 0),
        status: Number(c.status === undefined ? 1 : c.status),
        statusText: Number(c.status === undefined ? 1 : c.status) ? '启用' : '停用',
        skillCount: null
      })).sort((a, b) => a.sort - b.sort)

      this.setData({ list, loading: false })
      this.loadSkillCounts()
    } catch (e) {
      this.setData({ loading: false })
      util.toast(e.message)
    }
  },

  /** 统计各分类下的技能数（失败不影响主流程，仅不展示数量） */
  async loadSkillCounts() {
    try {
      const res = (await api.admin.skills({ page: 1, size: 200 })) || {}
      const map = {}
      ;(res.list || []).forEach(s => {
        const k = s.categoryId || 'unknown'
        map[k] = (map[k] || 0) + 1
      })
      const list = this.data.list.map(c => Object.assign({}, c, { skillCount: map[c._id] || 0 }))
      this.setData({ list, skillCountReady: true })
    } catch (e) {
      this.setData({ skillCountReady: false })
    }
  },

  /* ================================================================
   * 排序（上下箭头交换 sort）
   * ================================================================ */
  async onMove(e) {
    const id = e.currentTarget.dataset.id
    const dir = Number(e.currentTarget.dataset.dir) // -1 上移 / 1 下移
    const list = this.data.list
    const i = list.findIndex(c => c._id === id)
    const j = i + dir
    if (i < 0 || j < 0 || j >= list.length) return
    if (this._moving) return
    this._moving = true

    const a = list[i]
    const b = list[j]
    // 交换 sort 值（若两者 sort 相同，用序号兜底，保证确实换位）
    const sa = a.sort === b.sort ? j + 1 : b.sort
    const sb = a.sort === b.sort ? i + 1 : a.sort

    util.loading('调整中')
    try {
      await api.admin.saveCategory({ _id: a._id, name: a.name, icon: a.icon, sort: sa, status: a.status })
      await api.admin.saveCategory({ _id: b._id, name: b.name, icon: b.icon, sort: sb, status: b.status })
      util.hideLoading()
      util.toastOk('排序已更新')
      this.loadList()
    } catch (err) {
      util.hideLoading()
      util.toast(err.message)
    } finally {
      this._moving = false
    }
  },

  /* ================================================================
   * 新增 / 编辑弹层
   * ================================================================ */
  onAdd() {
    this.setData({ form: Object.assign({}, EMPTY_FORM, { visible: true, sort: String((this.data.list.length + 1)) }) })
  },

  onEdit(e) {
    const id = e.currentTarget.dataset.id
    const c = this.data.list.find(x => x._id === id)
    if (!c) return
    this.setData({
      form: { visible: true, id: c._id, name: c.name, icon: c.icon, sort: String(c.sort), status: c.status }
    })
  },

  closeForm() {
    this.setData({ form: Object.assign({}, EMPTY_FORM) })
  },

  onFormName(e) { this.setData({ 'form.name': e.detail.value }) },
  onFormIcon(e) { this.setData({ 'form.icon': e.detail.value }) },
  onFormSort(e) { this.setData({ 'form.sort': e.detail.value }) },
  onFormStatus(e) { this.setData({ 'form.status': e.detail.value ? 1 : 0 }) },
  noop() { /* 阻止弹层点击穿透 */ },

  async submitForm() {
    const f = this.data.form
    const name = util.trimAll(f.name)
    const icon = util.trimAll(f.icon) || '✨'
    if (!name) return util.toast('请填写分类名称')
    if (name.length > 8) return util.toast('分类名称建议不超过 8 个字')
    if (!/^\d+$/.test(String(f.sort))) return util.toast('排序号请填写非负整数')

    const params = { name, icon, sort: Number(f.sort), status: f.status }
    if (f.id) params._id = f.id

    util.loading('保存中')
    try {
      await api.admin.saveCategory(params)
      util.hideLoading()
      util.toastOk(f.id ? '已保存' : '已新增分类')
      this.closeForm()
      this.loadList()
    } catch (e) {
      util.hideLoading()
      util.toast(e.message)
    }
  },

  async onDelete(e) {
    const id = e.currentTarget.dataset.id
    const c = this.data.list.find(x => x._id === id)
    if (!c) return
    const extra = c.skillCount ? `\n该分类下已有 ${c.skillCount} 个技能，删除会被服务端拒绝。` : ''
    const ok = await util.confirm(`确认删除分类「${c.name}」？删除后不可恢复。${extra}`, '删除分类')
    if (!ok) return

    util.loading('删除中')
    try {
      await api.admin.deleteCategory({ _id: c._id })
      util.hideLoading()
      util.toastOk('已删除')
      this.loadList()
    } catch (err) {
      util.hideLoading()
      // 409：该分类下还有技能（后端返回的中文提示直接展示）
      util.toast(err.message)
    }
  }
})
