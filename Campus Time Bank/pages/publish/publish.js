/**
 * 发布技能 / 求助
 * ------------------------------------------------------------------
 * 入口：tabBar 中间凸起按钮 navigateTo 打开（所以不是 tab 页，自带返回）
 * 两种身份共用一套表单，切换时整页主题色变化：
 *   offer「我能提供」= var(--c-primary) 绿
 *   need 「我要求助」= var(--c-info)    蓝
 * 带 options.id 时进入编辑模式，走 api.skill.update。
 * ------------------------------------------------------------------
 */
const api = require('../../utils/api')
const util = require('../../utils/util')
const constants = require('../../utils/constants')
const campus = require('../../utils/campus')
const envList = require('../../envList')

/** 主题色（只引用设计 token，禁止硬编码色值） */
const THEME = {
  offer: { main: 'var(--c-primary)', light: 'var(--c-primary-l)' },
  need: { main: 'var(--c-info)', light: 'var(--c-info-l)' }
}

/**
 * wx.setNavigationBarColor / switch 组件属性只接受色值、不支持 CSS 变量，
 * 这里保留与 styles/theme.wxss 完全一致的两组 token 值，改主题时同步改这两处即可。
 *   --c-primary #0EA47A / --c-primary-l #E8F7F1
 *   --c-info    #3B82F6 / --c-info-l    #EAF2FE
 */
const HEX = {
  offer: { main: '#0EA47A', light: '#E8F7F1' },
  need: { main: '#3B82F6', light: '#EAF2FE' }
}

/** 两种身份下的文案差异 */
const COPY = {
  offer: {
    pageTitle: '发布技能',
    editTitle: '编辑技能',
    phTitle: '例：吉他入门教学，零基础也能弹一首歌',
    phDesc: '介绍你的技能、可以提供的服务内容与时间安排，方便同学判断是否合适（不少于 10 字）',
    phTag: '输入技能标签，回车添加',
    tip: '说清楚「能提供什么、什么时间、在哪里」，更容易被同学下单～'
  },
  need: {
    pageTitle: '发布求助',
    editTitle: '编辑求助',
    phTitle: '例：求一位同学教我剪视频，毕设急用',
    phDesc: '说说你遇到的困难、希望对方怎么帮你、大概需要多久（不少于 10 字）',
    phTag: '输入期望的标签，回车添加',
    tip: '写清楚「需要什么帮助、什么时候、能出多少时间币」，更容易被接单～'
  }
}

const DESC_MIN = 10
const DESC_MAX = 500
const TITLE_MAX = 30
const TAG_MAX = 5
const IMG_MAX = 3
/** 地图选点页（pages/map/picker）回传数据的事件名与 storage 兜底 key（已与该页实现对齐） */
const PICKER_EVENT = 'pickedLocation'
const PICKER_KEY = 'pickedLocation'

Page({
  data: {
    /* 模式 */
    type: 'offer',
    isEdit: false,
    editId: '',
    isNeed: false,
    job: COPY.offer,
    themeMain: THEME.offer.main,
    themeLight: THEME.offer.light,
    pageStyle: `--c-theme:${THEME.offer.main};--c-theme-l:${THEME.offer.light};`,

    /* 选择器数据 */
    categories: [],
    categoryNames: [],
    categoryIndex: -1,
    categoryId: '',
    prices: constants.PRICE_OPTIONS,
    priceIndex: 1,               // 默认 2 枚
    durations: constants.DURATION_OPTIONS,
    durationIndex: 1,            // 默认 1 小时

    /* 表单 */
    title: '',
    desc: '',
    tagInput: '',
    tags: [],
    images: [],                  // { path, fileID, local }
    uploading: false,
    uploadText: '上传中',

    /* 地点 */
    locationName: '',
    address: '',
    longitude: null,
    latitude: null,

    /* 常量（wxml 用） */
    TITLE_MAX,
    DESC_MAX,
    DESC_MIN,
    TAG_MAX,
    IMG_MAX,

    submitting: false
  },

  onLoad(options) {
    const opts = options || {}
    const isEdit = !!opts.id
    const type = opts.type === 'need' ? 'need' : 'offer'
    this.setData({ isEdit, editId: opts.id || '' })
    this.applyType(type)
    this.loadCategories(isEdit ? opts.id : '')
  },

  onShow() {
    // storage 兜底：地图选点页已通过事件回传时，这里读到的内容相同 → 幂等，不覆盖用户的后续修改
    try {
      const picked = wx.getStorageSync(PICKER_KEY)
      if (picked && (picked.name || picked.locationName) && picked.latitude) {
        this.applyLocation(picked)
      }
    } catch (e) { /* 忽略缓存异常 */ }
  },

  /* ================================================================
   * 身份切换
   * ================================================================ */
  /** 切换「我能提供 / 我要求助」：主题色 + 文案 + 导航栏一起变 */
  applyType(type, editMode) {
    const t = type === 'need' ? 'need' : 'offer'
    const theme = THEME[t]
    // editMode 显式传入，避免依赖 setData 异步生效的 this.data.isEdit
    const isEdit = editMode === undefined ? this.data.isEdit : !!editMode
    this.setData({
      type: t,
      isNeed: t === 'need',
      job: COPY[t],
      themeMain: theme.main,
      themeLight: theme.light,
      pageStyle: `--c-theme:${theme.main};--c-theme-l:${theme.light};`
    })
    // 导航栏标题跟随身份（编辑模式优先显示「编辑…」）
    wx.setNavigationBarTitle({
      title: isEdit ? COPY[t].editTitle : COPY[t].pageTitle
    })
    // 整页主题变化：导航栏底色也跟随主题浅底（API 只接受色值，故用 HEX 表）
    wx.setNavigationBarColor({
      frontColor: '#000000',
      backgroundColor: HEX[t].light,
      fail: () => {}
    })
  },

  onSwitchType(e) {
    const type = e.currentTarget.dataset.type
    if (type === this.data.type) return
    this.applyType(type)
  },

  /* ================================================================
   * 分类 / 编辑回填
   * ================================================================ */
  async loadCategories(editId) {
    try {
      const res = await api.skill.categories({})
      const list = (res && res.list) || []
      const categories = list.length ? list : constants.DEFAULT_CATEGORIES
      this.setData({
        categories,
        categoryNames: categories.map(c => c.name || '未命名')
      })
      if (editId) await this.loadDetail(editId)
    } catch (e) {
      // 分类拉取失败时用内置兜底，**不阻断发布**
      const categories = constants.DEFAULT_CATEGORIES
      this.setData({
        categories,
        categoryNames: categories.map(c => c.name)
      })
      if (editId) await this.loadDetail(editId)
      // ★ 兜底已经生效、页面完全可用，所以这里**不应该**把云函数的原始报错
      //   （形如 `collection.get:fail -502005da`）弹给用户：既看不懂，又像是坏了。
      //   真实原因写日志，用户只看到一句能指导操作的提示。
      console.warn('[publish] 分类拉取失败，已回落内置分类：', e.message)
      util.toast('分类加载失败，已使用默认分类')
    }
  },

  /** 编辑模式：回填已有技能 */
  async loadDetail(id) {
    util.loading('加载中')
    try {
      const res = await api.skill.detail({ id })
      const skill = (res && res.skill) || {}
      const catIdx = this.data.categories.findIndex(c => c._id === skill.categoryId)
      const priceIdx = this.data.prices.indexOf(Number(skill.price))
      const durIdx = this.data.durations.findIndex(d => d.value === Number(skill.duration))
      this.setData({
        title: skill.title || '',
        desc: skill.desc || '',
        tags: (skill.tags || []).slice(0, TAG_MAX),
        images: (skill.images || []).slice(0, IMG_MAX).map(f => ({ path: f, fileID: f, local: false })),
        categoryIndex: catIdx,
        categoryId: catIdx > -1 ? this.data.categories[catIdx]._id : '',
        priceIndex: priceIdx > -1 ? priceIdx : this.data.priceIndex,
        durationIndex: durIdx > -1 ? durIdx : this.data.durationIndex,
        locationName: skill.locationName || '',
        address: skill.address || '',
        longitude: skill.location ? skill.location.coordinates[0] : null,
        latitude: skill.location ? skill.location.coordinates[1] : null
      })
      if (skill.type && skill.type !== this.data.type) this.applyType(skill.type, true)
    } catch (e) {
      util.toast(e.message)
    } finally {
      util.hideLoading()
    }
  },

  /* ================================================================
   * 表单输入
   * ================================================================ */
  onTitleInput(e) {
    this.setData({ title: e.detail.value || '' })
  },
  onDescInput(e) {
    this.setData({ desc: e.detail.value || '' })
  },
  onCategoryChange(e) {
    const i = Number(e.detail.value)
    const cat = this.data.categories[i]
    this.setData({ categoryIndex: i, categoryId: cat ? cat._id : '' })
  },
  onPriceChange(e) {
    this.setData({ priceIndex: Number(e.detail.value) })
  },
  onDurationChange(e) {
    this.setData({ durationIndex: Number(e.detail.value) })
  },

  /* ---------------------------- 标签 ---------------------------- */
  onTagInput(e) {
    this.setData({ tagInput: e.detail.value || '' })
  },
  onTagConfirm() {
    const v = util.trimAll(this.data.tagInput)
    if (!v) return
    if (v.length > 8) return util.toast('标签最多 8 个字')
    if (this.data.tags.length >= TAG_MAX) return util.toast(`最多添加 ${TAG_MAX} 个标签`)
    if (this.data.tags.indexOf(v) > -1) {
      this.setData({ tagInput: '' })
      return util.toast('这个标签已经添加过啦')
    }
    this.setData({ tags: this.data.tags.concat(v), tagInput: '' })
  },
  onTagRemove(e) {
    const i = Number(e.currentTarget.dataset.index)
    const tags = this.data.tags.slice()
    tags.splice(i, 1)
    this.setData({ tags })
  },

  /* ---------------------------- 图片 ---------------------------- */
  /**
   * 选图 → 本地预览 → 上传（MOCK 模式跳过真实上传只存本地路径）
   */
  async onAddImage() {
    const rest = IMG_MAX - this.data.images.length
    if (rest <= 0) return util.toast(`最多上传 ${IMG_MAX} 张图片`)
    let paths = []
    try {
      paths = await util.chooseImage(rest)
    } catch (e) {
      return util.toast(e.errMsg || e.message || '选择图片失败')
    }
    if (!paths || !paths.length) return

    // 先本地预览（立即上屏）
    const preview = paths.map(p => ({ path: p, fileID: '', local: true }))
    this.setData({ images: this.data.images.concat(preview) })

    // ★ 同样必须是运行时值：用编译期快照的话，调试模式下会去调真实云存储
    //   上传（没有云环境 → 必然失败）。
    if (getApp().globalData.MOCK) {
      util.toast('离线预览模式：图片仅本地展示，不会真实上传')
      return
    }

    this.setData({ uploading: true })
    try {
      const done = []
      for (let i = 0; i < paths.length; i++) {
        this.setData({ uploadText: `上传中 ${i + 1}/${paths.length}` })
        const fileID = await util.uploadFile(paths[i], 'skill')
        done.push({ path: paths[i], fileID, local: false })
      }
      // 用上传结果替换对应的本地预览项
      const images = this.data.images.map(item => {
        const hit = done.find(d => d.path === item.path)
        return hit || item
      })
      this.setData({ images })
    } catch (e) {
      // 上传失败：移除刚加入的本地项，避免提交空 fileID
      const images = this.data.images.filter(item => !item.local)
      this.setData({ images })
      util.toast(e.errMsg || e.message || '图片上传失败，请重试')
    } finally {
      this.setData({ uploading: false, uploadText: '上传中' })
    }
  },

  onRemoveImage(e) {
    const i = Number(e.currentTarget.dataset.index)
    const images = this.data.images.slice()
    images.splice(i, 1)
    this.setData({ images })
  },

  onPreviewImage(e) {
    const i = Number(e.currentTarget.dataset.index)
    const urls = this.data.images.map(x => x.path).filter(Boolean)
    util.previewImage(urls, urls[i])
  },

  /* ---------------------------- 地点 ---------------------------- */
  onPickLocation() {
    wx.navigateTo({
      url: '/pages/map/picker/picker',
      events: {
        // 选点页通过 eventChannel.emit('selectLocation', {...}) 回传
        [PICKER_EVENT]: data => this.applyLocation(data)
      },
      fail: () => util.toast('地图选点页暂不可用')
    })
  },
  /** 统一写入地点（事件 / storage 兜底两条路都走这里） */
  applyLocation(data) {
    const d = data || {}
    if (!d.locationName && !d.name) return
    this.setData({
      locationName: d.locationName || d.name || '',
      address: d.address || '',
      longitude: d.longitude === undefined ? null : d.longitude,
      latitude: d.latitude === undefined ? null : d.latitude
    })
  },
  onClearLocation() {
    this.setData({ locationName: '', address: '', longitude: null, latitude: null })
  },

  /* ================================================================
   * 提交
   * ================================================================ */
  /** 表单校验：返回错误文案（空串表示通过） */
  validate() {
    const d = this.data
    const title = util.trimAll(d.title)
    const desc = util.trimAll(d.desc)
    if (!title) return '请填写标题'
    if (title.length > TITLE_MAX) return `标题最多 ${TITLE_MAX} 个字`
    if (!d.categoryId) return '请选择分类'
    const price = Number(d.prices[d.priceIndex])
    if (!util.isValidCoin(price)) return '请选择时间币数量（1~999 的整数）'
    if (!desc) return '请填写详情描述'
    if (desc.length < DESC_MIN) return `详情描述至少 ${DESC_MIN} 个字`
    if (desc.length > DESC_MAX) return `详情描述最多 ${DESC_MAX} 个字`
    if (d.uploading) return '图片正在上传，请稍候'
    if (d.images.some(x => x.local)) return '有图片未上传成功，请删除后重试'
    // ★ 安全策略：必须选校内地点才能发布。
    //   校外的任务一旦出现纠纷或意外，校方无法及时处理 —— 这是硬性要求，
    //   客户端拦一次（体验好），云端 skill.create 还会再拦一次（防绕过）。
    if (!d.latitude || !d.longitude) {
      return '请选择服务地点：只能发布校内的任务'
    }
    if (!campus.isInside(d.latitude, d.longitude).inside) {
      return '所选地点在校外，无法发布：校外的任务校方无法及时处理，请重新选择校内位置'
    }
    return ''
  },

  async onSubmit() {
    if (this.data.submitting) return
    const err = this.validate()
    if (err) return util.toast(err)

    const d = this.data
    const dur = d.durations[d.durationIndex] || { value: 60 }
    const price = Number(d.prices[d.priceIndex])
    const label = d.isNeed ? '求助' : '技能'
    const ok = await util.confirm(
      `确认发布这条${label}吗？发布后可在「我的发布」中管理`,
      '发布确认'
    )
    if (!ok) return

    const payload = {
      type: d.type,
      title: util.trimAll(d.title),
      desc: util.trimAll(d.desc),
      categoryId: d.categoryId,
      price,
      duration: Number(dur.value) || 60,
      images: d.images.map(x => x.fileID).filter(Boolean),
      tags: d.tags,
      longitude: d.longitude,
      latitude: d.latitude,
      address: d.address,
      locationName: d.locationName
    }

    this.setData({ submitting: true })
    util.loading('发布中')
    try {
      if (d.isEdit) {
        await api.skill.update(Object.assign({ id: d.editId }, payload))
      } else {
        await api.skill.create(payload)
      }
      util.hideLoading()
      const app = getApp()
      app.emit('skillChange')
      util.toastOk(d.isEdit ? '保存成功' : '发布成功')
      setTimeout(() => wx.navigateBack(), 600)
    } catch (e) {
      util.hideLoading()
      util.toast(e.message)
    } finally {
      this.setData({ submitting: false })
    }
  }
})
