/**
 * 搜索页
 * ------------------------------------------------------------------
 * 未输入：搜索历史（本地存储，最多 10 条）+ 热门标签
 * 输入后：结果列表（关键词高亮）+ 分页加载
 * 说明：高亮采用「切片成多个 text」方案（不使用 rich-text，天然免疫 HTML 注入）。
 * ------------------------------------------------------------------
 */
const api = require('../../utils/api')
const util = require('../../utils/util')

const PAGE_SIZE = 10
const HISTORY_KEY = 'searchHistory'
const HISTORY_MAX = 10

/** 热门标签（写死在页面内） */
const HOT_TAGS = ['吉他', '证件照', '高数', 'PPT', '羽毛球', '修电脑', '口语', '简历']

Page({
  data: {
    keyword: '',
    inputFocus: false,
    searched: false,        // 是否已执行过搜索
    searching: false,

    hotTags: HOT_TAGS,
    hotCats: [],            // 热门分类（config.hotCategories → 分类名），见 loadHotCategories
    history: [],

    list: [],               // 结果列表（title 为切片数组，用于高亮）
    page: 1,
    total: 0,
    hasMore: true,
    loadingMore: false,
    loadError: false
  },

  onLoad() {
    const history = this._readHistory()
    // 400ms 防抖：输入过程中不请求
    this._debouncedSearch = util.debounce(() => this.doSearch(), 400)
    this.setData({ history: history, inputFocus: true })
    this.loadHotCategories()
  },

  /**
   * 加载「热门分类」。
   *
   * config.hotCategories 里存的是**分类 _id**（如 ['c1','c2','c3']），
   * 需要映射成分类名才能展示与搜索。注意：initdb 种下的是**分类 id**，
   * 不是名字，页面侧必须自己映射，不要假定它已经是可展示的文案。
   *
   * 失败时保持空数组，wxml 的 wx:if 会让整个区块隐藏，不影响搜索主流程。
   */
  loadHotCategories() {
    const app = getApp()
    const ids = (app.globalData.config && app.globalData.config.hotCategories) || []
    if (!ids.length) return
    api.skill.categories()
      .then((res) => {
        const map = {}
        ;((res && res.list) || []).forEach((c) => { map[c._id] = c })
        const hotCats = ids.map((id) => map[id]).filter(Boolean)
        if (hotCats.length) this.setData({ hotCats })
      })
      .catch(() => { /* 拿不到就隐藏区块，不打扰用户 */ })
  },

  /* ================================================================
   * 搜索历史（本地存储）
   * ================================================================ */
  _readHistory() {
    let list = []
    try {
      list = wx.getStorageSync(HISTORY_KEY) || []
    } catch (e) {
      list = []
    }
    return Array.isArray(list) ? list.slice(0, HISTORY_MAX) : []
  },

  _writeHistory(list) {
    const arr = (list || []).slice(0, HISTORY_MAX)
    try {
      wx.setStorageSync(HISTORY_KEY, arr)
    } catch (e) { /* 存储失败不影响主流程 */ }
    return arr
  },

  /** 记录一条搜索词（去重 + 置顶） */
  _pushHistory(kw) {
    const k = util.trimAll(kw)
    if (!k) return
    const list = [k].concat(this.data.history.filter(h => h !== k))
    this.setData({ history: this._writeHistory(list) })
  },

  /** 单个删除 */
  onDeleteHistory(e) {
    const k = e.currentTarget.dataset.kw
    const list = this.data.history.filter(h => h !== k)
    this.setData({ history: this._writeHistory(list) })
  },

  /** 全部清空 */
  async onClearHistory() {
    const ok = await util.confirm('确定清空全部搜索历史吗？')
    if (!ok) return
    wx.removeStorageSync(HISTORY_KEY)
    this.setData({ history: [] })
    util.toastOk('已清空')
  },

  /* ================================================================
   * 输入 / 触发搜索
   * ================================================================ */
  onInput(e) {
    const kw = (e.detail && e.detail.value) || ''
    this.setData({ keyword: kw })
    if (!util.trimAll(kw)) {
      // 清空后回到「历史 + 热门」态
      this.setData({
        searched: false,
        list: [],
        page: 1,
        hasMore: true,
        loadError: false,
        inputFocus: false
      })
      return
    }
    this._debouncedSearch()
  },

  /** 键盘「搜索」 */
  onConfirm(e) {
    const kw = (e.detail && e.detail.value) || this.data.keyword
    this.setData({ keyword: kw, inputFocus: false })
    this.doSearch()
  },

  /** 清空输入框 */
  onClear() {
    this.setData({
      keyword: '',
      searched: false,
      list: [],
      page: 1,
      hasMore: true,
      loadError: false,
      inputFocus: true
    })
  },

  /** 点击历史 / 热门标签 */
  onTagTap(e) {
    const kw = e.currentTarget.dataset.kw || ''
    if (!kw) return
    this.setData({ keyword: kw, inputFocus: false })
    this.doSearch()
  },

  /* ================================================================
   * 结果
   * ================================================================ */
  /**
   * 关键词切片：把命中词单独成片，交给 wxml 用不同样式渲染。
   * 纯文本切片 + wxml 逐片包 <text>，不使用 rich-text，天然免疫 HTML 注入。
   */
  _slice(text, kw) {
    const s = String(text == null ? '' : text)
    const k = String(kw == null ? '' : kw)
    if (!k) return [{ t: s, hit: false }]
    const lower = s.toLowerCase()
    const kl = k.toLowerCase()
    const out = []
    let i = 0
    while (i < s.length) {
      const idx = lower.indexOf(kl, i)
      if (idx < 0) {
        out.push({ t: s.slice(i), hit: false })
        break
      }
      if (idx > i) out.push({ t: s.slice(i, idx), hit: false })
      out.push({ t: s.slice(idx, idx + k.length), hit: true })
      i = idx + k.length
    }
    return out.filter(p => p.t !== '')
  },

  /** 为一条结果生成高亮片段：标题 + 描述命中处 */
  _decorate(it, kw) {
    const o = Object.assign({}, it || {})
    o.titleParts = this._slice(o.title, kw)
    const descHit = String(o.desc || '').toLowerCase().indexOf(String(kw).toLowerCase()) > -1
    o.descParts = descHit ? this._slice(this._clip(o.desc, kw, 26), kw) : []
    return o
  },

  /** 截取关键词前后文，避免详情整段太长 */
  _clip(text, kw, radius) {
    const s = String(text == null ? '' : text).replace(/\s+/g, ' ')
    const idx = s.toLowerCase().indexOf(String(kw).toLowerCase())
    if (idx < 0) return s.slice(0, radius * 2)
    const start = Math.max(0, idx - radius)
    const end = Math.min(s.length, idx + String(kw).length + radius)
    return (start > 0 ? '…' : '') + s.slice(start, end) + (end < s.length ? '…' : '')
  },

  async doSearch(reset) {
    const kw = util.trimAll(this.data.keyword)
    if (!kw) return
    if (this._querying) { this._pendingAgain = true; return }   // 搜索中又输入 → 完成后重查
    const toFirst = reset !== false     // 默认视为重置到第 1 页
    const page = toFirst ? 1 : this.data.page + 1

    this._querying = true
    this._pendingAgain = false
    this.setData({ searching: toFirst, loadingMore: !toFirst, loadError: false })
    // 请求序号：连续输入时丢弃过期响应
    const seq = (this._seq = (this._seq || 0) + 1)
    try {
      const res = await api.skill.list({ keyword: kw, page: page, size: PAGE_SIZE, sort: 'new' })
      if (seq !== this._seq) return
      const rows = (res && res.list) || []
      const mapped = rows.map(it => this._decorate(it, kw))
      this._pushHistory(kw)
      this.setData({
        list: toFirst ? mapped : this.data.list.concat(mapped),
        page: page,
        total: (res && res.total) || mapped.length,
        hasMore: !!(res && res.hasMore),
        searched: true
      })
    } catch (e) {
      if (seq !== this._seq) return
      this.setData({ loadError: true, searched: true })
      util.toast(e.message)
    } finally {
      this._querying = false
      this.setData({ searching: false, loadingMore: false })
      if (this._pendingAgain) {
        this._pendingAgain = false
        this.doSearch(true)
      }
    }
  },

  /** 结果卡片 → 详情（skill-card 事件带 item，高亮行只用 data-id） */
  onCard(e) {
    const item = (e.detail && e.detail.item) || {}
    const id = item._id || (e.currentTarget && e.currentTarget.dataset && e.currentTarget.dataset.id) || ''
    if (!id) return
    wx.navigateTo({ url: `/pages/skill/detail/detail?id=${id}` })
  },

  /** 空态 / 失败态的按钮 */
  onRetry() {
    this.doSearch(true)
  },

  onGoPublish() {
    wx.navigateTo({ url: '/pages/publish/publish', fail: () => {} })
  },

  /* ================================================================
   * 触底分页
   * ================================================================ */
  onReachBottom() {
    if (!this.data.searched || !this.data.hasMore || this.data.loadingMore || !this.data.list.length) return
    this.doSearch(false)
  }
})
