/**
 * 参数配置（全局参数 + 轮播图 + 危险操作）
 * ==================================================================
 * 接口：api.admin.config / saveConfig
 *      api.admin.banners / saveBanner / deleteBanner
 *
 * ★ 危险操作说明：
 *   initdb 是**独立的云函数**（见 ARCHITECTURE §1/§4.9），api.js 里没有为它做包装，
 *   因此按契约走逃生舱：api.raw('initdb', 'init', {}) / api.raw('initdb', 'clear', {})。
 *   离线预览模式（MOCK）下没有 initdb 的模拟实现，这里直接拦截并提示，
 *   避免用户看到「未实现的接口」这种技术报错。
 * ==================================================================
 */
const api = require('../../../utils/api')
const util = require('../../../utils/util')
const guard = require('../../utils/guard')
const envList = require('../../../envList')

Page({
  data: {
    config: {
      registerBonus: 5,
      orderExpireHours: 24,
      confirmExpireHours: 72,
      minCreditToOrder: 60,
      aboutUs: ''
    },
    loading: true,
    saving: false,
    /* ★ 调试开关的状态（真实值在 _boot 里读）—— 显式声明便于排查 */
    isDebugger: false,

    /* 轮播图 */
    banners: [],
    bannerLoading: true,
    bannerForm: { visible: false, id: '', title: '', image: '', link: '', sort: '1', status: 1 },
    uploading: false,

    /* 危险区 */
    dangerRunning: false,
    mockMode: false,
    /** 调试模式开关（仅管理员可见 —— 本页入口本身就有 requireAdmin 守卫） */
    debugMode: false,
    debugSwitching: false
  },

  onLoad() {
    this._boot()
  },

  async _boot() {
    const ok = await guard.requireAdmin(this)
    if (!ok) return
    /*
     * ★ 进得来这一页 ≠ 看得到调试功能。
     *   本页只要求「管理员」（管理员 + 调试员都能进），
     *   但调试模式那一块额外要求**调试员** —— 未调试完的东西不给学生看，
     *   因为总有学生会管理员把每个按钮都点一遍。
     */
    const isDebugger = await getApp().isDebuggerUser()
    this.setData({
      isDebugger: !!isDebugger,
      mockMode: !!(getApp().globalData && getApp().globalData.MOCK),
      debugMode: envList.isDebugOn()
    })
    this.loadConfig()
    this.loadBanners()
  },

  /**
   * 切换「调试模式」。
   *
   * ★ 只有管理员能走到这里 —— 本页的 _boot() 已经过 guard.requireAdmin()，
   *   普通用户根本进不来（管理端入口也是管理员可见的）。
   *
   * 打开后整个数据层改用内置模拟数据（不连云环境），方便答辩演示 / 无网环境排查；
   * 关闭后立即回到真实云端数据。
   * 切换本身就是一次模式切换，所以直接 reLaunch 让所有页面重新取数。
   */
  async onToggleDebug(e) {
    if (this.data.debugSwitching) return
    const on = !!(e.detail && e.detail.value)
    this.setData({ debugSwitching: true })
    try {
      envList.setDebugMode(on)
      /*
       * ★ 必须清掉角色缓存。
       *
       *   reLaunch 只会重建页面，**不会重跑 app.onLaunch**，
       *   所以 globalData 会原样留着。
       *   而 debugger 是「看到就缓存、缓存为 true 就直接返回」的策略 ——
       *   切换后如果不清，危险操作区与调试开关会继续按**切换前**的身份显示：
       *   管理员可能因此看到本该只有校方可见的入口。
       */
      const app = getApp()
      if (app && app.globalData) {
        app.globalData.isAdmin = false
        app.globalData.isDebugger = false
      }
      util.toast(on ? '已开启调试模式（使用模拟数据）' : '已关闭调试模式（回到云端数据）')
      // 延时一拍，让 toast 能被看到；reLaunch 会重建所有页面并按新模式取数
      setTimeout(() => {
        wx.reLaunch({ url: '/pages/square/square' })
      }, 800)
    } catch (err) {
      this.setData({ debugSwitching: false, debugMode: !on })
      util.toast((err && err.message) || '切换失败')
    }
  },

  onPullDownRefresh() {
    if (!this._isAdmin) return wx.stopPullDownRefresh()
    Promise.all([this.loadConfig(), this.loadBanners()])
      .then(() => wx.stopPullDownRefresh())
      .catch(() => wx.stopPullDownRefresh())
  },

  /* ================================================================
   * 全局参数
   * ================================================================ */
  async loadConfig() {
    this.setData({ loading: true })
    try {
      const res = await api.admin.config({})
      // 契约未明确出参形状：兼容「直接返回 config」与「返回 { config }」两种
      const cfg = (res && res.config) ? res.config : (res || {})
      this._rawConfig = cfg
      this.setData({
        loading: false,
        config: {
          registerBonus: Number(cfg.registerBonus === undefined ? 5 : cfg.registerBonus),
          orderExpireHours: Number(cfg.orderExpireHours === undefined ? 24 : cfg.orderExpireHours),
          confirmExpireHours: Number(cfg.confirmExpireHours === undefined ? 72 : cfg.confirmExpireHours),
          minCreditToOrder: Number(cfg.minCreditToOrder === undefined ? 60 : cfg.minCreditToOrder),
          aboutUs: cfg.aboutUs || ''
        }
      })
    } catch (e) {
      this.setData({ loading: false })
      util.toast(e.message)
    }
  },

  onField(e) {
    const key = e.currentTarget.dataset.key
    if (!key) return
    const patch = {}
    patch['config.' + key] = e.detail.value
    this.setData(patch)
  },

  async saveConfig() {
    if (this.data.saving) return
    const c = this.data.config
    const nums = {
      registerBonus: c.registerBonus,
      orderExpireHours: c.orderExpireHours,
      confirmExpireHours: c.confirmExpireHours,
      minCreditToOrder: c.minCreditToOrder
    }
    for (const k in nums) {
      if (!/^\d+$/.test(String(nums[k]))) return util.toast('请把数值项填写为非负整数')
    }
    if (Number(nums.minCreditToOrder) > 150) return util.toast('最低下单信用分不能超过 150（信用分上限）')
    if (String(c.aboutUs || '').length > 300) return util.toast('「关于我们」文案请控制在 300 字内')

    const ok = await util.confirm(
      '保存后立即对全站生效（新用户赠送、超时时间、下单门槛）。确认保存吗？',
      '保存全局参数'
    )
    if (!ok) return

    this.setData({ saving: true })
    util.loading('保存中')
    try {
      // 带上未在表单里修改的字段，避免云端 Object.assign 覆盖丢失
      const payload = Object.assign({}, this._rawConfig || {}, {
        registerBonus: Number(nums.registerBonus),
        orderExpireHours: Number(nums.orderExpireHours),
        confirmExpireHours: Number(nums.confirmExpireHours),
        minCreditToOrder: Number(nums.minCreditToOrder),
        aboutUs: util.trimAll(c.aboutUs)
      })
      await api.admin.saveConfig(payload)
      util.hideLoading()
      util.toastOk('参数已保存')
      this.loadConfig()
    } catch (e) {
      util.hideLoading()
      util.toast(e.message)
    } finally {
      this.setData({ saving: false })
    }
  },

  /* ================================================================
   * 轮播图管理
   * ================================================================ */
  async loadBanners() {
    this.setData({ bannerLoading: true })
    try {
      const res = (await api.admin.banners({})) || {}
      const banners = (res.list || []).map(b => ({
        _id: b._id,
        title: b.title || '未命名轮播',
        image: b.image || '',
        link: b.link || '',
        sort: Number(b.sort === undefined ? 99 : b.sort),
        status: Number(b.status === undefined ? 1 : b.status),
        statusText: Number(b.status === undefined ? 1 : b.status) ? '展示中' : '已隐藏'
      })).sort((a, b) => a.sort - b.sort)
      this.setData({ banners, bannerLoading: false })
    } catch (e) {
      this.setData({ bannerLoading: false })
      util.toast(e.message)
    }
  },

  onAddBanner() {
    this.setData({
      bannerForm: {
        visible: true, id: '', title: '', image: '', link: '',
        sort: String(this.data.banners.length + 1), status: 1
      }
    })
  },

  onEditBanner(e) {
    const id = e.currentTarget.dataset.id
    const b = this.data.banners.find(x => x._id === id)
    if (!b) return
    this.setData({
      bannerForm: {
        visible: true, id: b._id, title: b.title, image: b.image,
        link: b.link, sort: String(b.sort), status: b.status
      }
    })
  },

  closeBannerForm() {
    this.setData({ bannerForm: { visible: false, id: '', title: '', image: '', link: '', sort: '1', status: 1 } })
  },

  onBannerField(e) {
    const key = e.currentTarget.dataset.key
    if (!key) return
    const patch = {}
    patch['bannerForm.' + key] = e.detail.value
    this.setData(patch)
  },
  onBannerStatus(e) {
    this.setData({ 'bannerForm.status': e.detail.value ? 1 : 0 })
  },
  noop() { /* 阻止弹层点击穿透 */ },

  /** 选择并上传轮播图 */
  async chooseBannerImage() {
    if (this.data.uploading) return
    try {
      const paths = await util.chooseImage(1)
      if (!paths || !paths.length) return
      if (this.data.mockMode) {
        this.setData({ 'bannerForm.image': paths[0] })
        return util.toast('离线预览模式：已用本地图片预览，接入云环境后会自动上传')
      }
      this.setData({ uploading: true })
      util.loading('上传中')
      const fileID = await util.uploadFile(paths[0], 'banner')
      util.hideLoading()
      this.setData({ 'bannerForm.image': fileID, uploading: false })
      util.toastOk('图片已上传')
    } catch (e) {
      util.hideLoading()
      this.setData({ uploading: false })
      util.toast(e.message || '图片上传失败')
    }
  },

  previewBanner(e) {
    const url = e.currentTarget.dataset.url
    if (!url) return util.toast('该轮播还没有图片')
    util.previewImage([url], url)
  },

  async submitBanner() {
    const f = this.data.bannerForm
    const title = util.trimAll(f.title)
    if (!title) return util.toast('请填写轮播文案')
    if (!f.image) return util.toast('请先选择轮播图片')
    if (!/^\d+$/.test(String(f.sort))) return util.toast('排序号请填写非负整数')

    const params = {
      title,
      image: f.image,
      link: util.trimAll(f.link),
      sort: Number(f.sort),
      status: f.status
    }
    if (f.id) params._id = f.id

    util.loading('保存中')
    try {
      await api.admin.saveBanner(params)
      util.hideLoading()
      util.toastOk(f.id ? '轮播已更新' : '轮播已新增')
      this.closeBannerForm()
      this.loadBanners()
    } catch (e) {
      util.hideLoading()
      util.toast(e.message)
    }
  },

  async deleteBanner(e) {
    const id = e.currentTarget.dataset.id
    const b = this.data.banners.find(x => x._id === id)
    if (!b) return
    const ok = await util.confirm(`确认删除轮播「${b.title}」？删除后首页不再展示。`, '删除轮播')
    if (!ok) return
    util.loading('删除中')
    try {
      await api.admin.deleteBanner({ _id: b._id })
      util.hideLoading()
      util.toastOk('已删除')
      this.loadBanners()
    } catch (err) {
      util.hideLoading()
      util.toast(err.message)
    }
  },

  /* ================================================================
   * 危险操作区
   * ================================================================ */
  /** 初始化演示数据（initdb.init） */
  async onInitDemo() {
    const ok = await util.confirm(
      '将向数据库写入示例分类、全局配置、轮播与演示用户/技能/订单数据，已存在的数据不会被删除。确认执行吗？',
      '初始化演示数据'
    )
    if (!ok) return
    await this.runDanger('init', '演示数据已初始化')
  },

  /** 清空业务数据：三段式确认（弹窗 → 输入「确认清空」→ 最终弹窗） */
  async onClearData() {
    const step1 = await util.confirm(
      '该操作会清空全部业务数据（技能、订单、时间币流水、信用分流水、评价、举报、通知等），仅保留管理员账号，且不可恢复！\n确认继续吗？',
      '危险操作 · 清空业务数据'
    )
    if (!step1) return

    // ★ 说明放 title；content 留空 —— 否则会被预填，二次确认形同虚设
    const input = await util.prompt(
      '请输入四个字以继续：确认清空',
      '在此输入',
      ''
    )
    if (input === null) return
    if (util.trimAll(input) !== '确认清空') return util.toast('输入不匹配，已取消本次操作')

    const step2 = await util.confirm(
      '最后一次确认：清空后所有用户的时间币与订单记录都会消失，无法恢复。确认执行吗？',
      '最终确认'
    )
    if (!step2) return

    await this.runDanger('clear', '业务数据已清空')
  },

  /**
   * 调用 initdb 独立云函数（api.js 未包装，走 api.raw 逃生舱）
   * @param {String} action init | clear
   */
  async runDanger(action, okTip) {
    if (this.data.dangerRunning) return
    if (this.data.mockMode) {
      return util.toast('离线预览模式（MOCK）下不会真正操作数据库，请先配置云环境 ID')
    }
    this.setData({ dangerRunning: true })
    util.loading('执行中，请稍候')
    try {
      await api.raw('initdb', action, {})
      util.hideLoading()
      util.toastOk(okTip)
      this.loadConfig()
      this.loadBanners()
    } catch (e) {
      util.hideLoading()
      util.toast(e.message)
    } finally {
      this.setData({ dangerRunning: false })
    }
  }
})
