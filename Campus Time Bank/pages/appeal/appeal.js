/**
 * 申诉
 * ------------------------------------------------------------------
 * 平台在此之前是**单向**的：只有举报（指控别人），没有申辩渠道。
 * 被扣信用分、被下架技能的人只收到一条通知，没有任何表达异议的地方。
 *
 * onLoad 参数：type（credit / skill）+ targetId + targetTitle（可选）
 * 本页同时承担「提交申诉」和「查看我的申诉（含处理结果）」两件事 ——
 * 用户提交完最想知道的就是「什么时候有结果」。
 * ------------------------------------------------------------------
 */
const api = require('../../utils/api')
const util = require('../../utils/util')

const MAX_IMAGES = 3
const MAX_REASON = 200
const TYPE_TEXT = { credit: '信用分被扣', skill: '技能被下架' }

Page({
  data: {
    type: 'credit',
    typeText: '信用分被扣',
    targetId: '',
    targetTitle: '',

    reason: '',
    reasonLen: 0,
    images: [],
    maxImages: MAX_IMAGES,

    /* 我的申诉 */
    list: [],
    loading: true,
    submitting: false,
    mockMode: false
  },

  onLoad(options) {
    const opt = options || {}
    const type = decodeURIComponent(opt.type || 'credit')
    this.setData({
      type: type,
      typeText: TYPE_TEXT[type] || '处置',
      targetId: decodeURIComponent(opt.targetId || ''),
      targetTitle: decodeURIComponent(opt.targetTitle || ''),
      mockMode: !!(getApp().globalData && getApp().globalData.MOCK)
    })
  },

  onShow() { this.loadList() },

  async loadList() {
    try {
      const res = (await api.user.appealList({ page: 1, size: 20 })) || {}
      const STATUS = { 0: '待处理', 1: '已成立', 2: '未成立' }
      const TONE = { 0: 'warn', 1: 'success', 2: 'outline' }
      const list = (res.list || []).map(it => Object.assign({}, it, {
        statusText: STATUS[Number(it.status === undefined ? 0 : it.status)] || '未知',
        statusTone: TONE[Number(it.status === undefined ? 0 : it.status)] || 'outline',
        typeText: TYPE_TEXT[it.type] || '处置',
        timeText: util.formatTime(it.createTime, 'YYYY-MM-DD HH:mm')
      }))
      this.setData({ list: list, loading: false })
    } catch (e) {
      this.setData({ loading: false })
    }
  },

  /* ---------------- 表单 ---------------- */
  onReasonInput(e) {
    const v = (e.detail && e.detail.value) || ''
    this.setData({ reason: v, reasonLen: v.length })
  },

  onPickImage() {
    const left = MAX_IMAGES - this.data.images.length
    if (left <= 0) return util.toast('最多 ' + MAX_IMAGES + ' 张')
    util.chooseImage(left).then(paths => {
      this.setData({ images: this.data.images.concat(paths) })
    }).catch(() => {})
  },

  onRemoveImage(e) {
    const i = Number(e.currentTarget.dataset.index)
    const arr = this.data.images.slice()
    arr.splice(i, 1)
    this.setData({ images: arr })
  },

  async onSubmit() {
    if (this.data.submitting) return
    const reason = String(this.data.reason || '').trim()
    if (!reason) return util.toast('请填写申诉理由')

    const ok = await util.confirm(
      '申诉会提交给管理员人工复核。请如实说明情况，恶意申诉可能影响你的信用评价。',
      '确认提交申诉'
    )
    if (!ok) return

    this.setData({ submitting: true })
    try {
      /*
       * 图片：MOCK 模式没有云存储，跳过上传直接带本地临时路径 ——
       * 与举报页同一套处理方式。
       */
      let images = this.data.images || []
      if (images.length && !this.data.mockMode) {
        const up = []
        for (let i = 0; i < images.length; i++) {
          up.push(await util.uploadFile(images[i], 'appeal'))
        }
        images = up
      }

      await api.user.appealCreate({
        type: this.data.type,
        targetId: this.data.targetId,
        reason: reason,
        images: images
      })
      util.toastOk('已提交，请等待处理')
      this.setData({ reason: '', reasonLen: 0, images: [], submitting: false })
      setTimeout(() => this.loadList(), 600)
    } catch (e) {
      this.setData({ submitting: false })
      util.toast((e && e.message) || '提交失败')
    }
  },

  onShareAppMessage() {
    return { title: '校园时间银行 · 让每一份时间都被认真对待', path: '/pages/square/square' }
  }
})
