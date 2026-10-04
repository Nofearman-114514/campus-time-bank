/**
 * 举报
 * ------------------------------------------------------------------
 * onLoad 参数：targetType / targetId / targetTitle / targetUserId
 * 表单：举报对象 → 举报原因（单选卡片）→ 补充说明（≤200 字）→ 凭证图片（≤3 张）
 * 提交：util.confirm 二次确认 → api.skill.report → toastOk → navigateBack
 *
 * 图片：util.chooseImage 选取，util.uploadFile(..., 'report') 上传云存储。
 *       MOCK 模式没有云存储，**跳过上传**，直接把本地临时路径作为凭证带给接口。
 * ------------------------------------------------------------------
 */
const api = require('../../utils/api')
const util = require('../../utils/util')
const constants = require('../../utils/constants')

const MAX_IMAGES = 3
const MAX_REMARK = 200

Page({
  data: {
    /* 被举报对象 */
    targetType: 'skill',
    targetTypeText: '技能',
    targetId: '',
    targetTitle: '',
    targetUserId: '',

    /* 表单 */
    reasons: constants.REPORT_REASONS,
    reasonIndex: -1,
    reason: '',
    remark: '',
    remarkLen: 0,
    images: [],
    maxImages: MAX_IMAGES,

    /* 状态 */
    submitting: false,
    mockMode: false
  },

  onLoad(options) {
    const opt = options || {}
    const targetType = decodeURIComponent(opt.targetType || 'skill')

    this.setData({
      targetType: targetType,
      targetTypeText: constants.REPORT_TARGET[targetType] || '内容',
      targetId: decodeURIComponent(opt.targetId || ''),
      targetTitle: decodeURIComponent(opt.targetTitle || ''),
      targetUserId: decodeURIComponent(opt.targetUserId || ''),
      mockMode: !!getApp().globalData.MOCK
    })
  },

  /* ================================================================
   * 表单交互
   * ================================================================ */
  /** 举报原因单选 */
  onPickReason(e) {
    const idx = Number(e.currentTarget.dataset.index)
    this.setData({
      reasonIndex: idx,
      reason: this.data.reasons[idx] || ''
    })
  },

  /** 补充说明 */
  onRemark(e) {
    const v = String(e.detail.value || '').slice(0, MAX_REMARK)
    this.setData({ remark: v, remarkLen: v.length })
  },

  /** 选凭证图片（最多 3 张） */
  async onAddImage() {
    const left = MAX_IMAGES - this.data.images.length
    if (left <= 0) {
      util.toast(`最多上传 ${MAX_IMAGES} 张凭证`)
      return
    }
    try {
      const paths = await util.chooseImage(left)
      if (!paths || !paths.length) return
      this.setData({ images: this.data.images.concat(paths).slice(0, MAX_IMAGES) })
    } catch (e) {
      util.toast(e.message)
    }
  },

  /** 删除某张凭证 */
  onRemoveImage(e) {
    const idx = Number(e.currentTarget.dataset.index)
    const images = this.data.images.slice()
    images.splice(idx, 1)
    this.setData({ images: images })
  },

  /** 预览凭证 */
  onPreview(e) {
    util.previewImage(this.data.images, e.currentTarget.dataset.url)
  },

  /* ================================================================
   * 提交
   * ================================================================ */
  async onSubmit() {
    if (this.data.submitting) return
    if (this.data.reasonIndex < 0) {
      util.toast('请选择举报原因')
      return
    }
    if (!this.data.targetId) {
      util.toast('缺少举报对象，请返回重试')
      return
    }

    const ok = await util.confirm('确认提交举报吗？我们会尽快核实处理', '提交确认')
    if (!ok) return

    this.setData({ submitting: true })
    const app = getApp()
    try {
      /* 1. 上传凭证（MOCK 模式跳过） */
      let images = []
      if (this.data.images.length) {
        if (app.globalData.MOCK) {
          images = this.data.images.slice()
        } else {
          util.loading('上传凭证中')
          images = []
          for (let i = 0; i < this.data.images.length; i++) {
            images.push(await util.uploadFile(this.data.images[i], 'report'))
          }
          util.hideLoading()
        }
      }

      /* 2. 提交举报 */
      await api.skill.report({
        targetType: this.data.targetType,
        targetId: this.data.targetId,
        targetTitle: this.data.targetTitle,
        targetUserId: this.data.targetUserId,
        reason: this.data.reason,
        remark: util.trimAll(this.data.remark),
        images: images
      })

      util.toastOk('举报已提交')
      setTimeout(() => wx.navigateBack(), 900)
    } catch (e) {
      util.hideLoading()
      util.toast(e.message)
    } finally {
      this.setData({ submitting: false })
    }
  },

  onShareAppMessage() {
    return { title: '校园时间银行 · 用技能换技能', path: '/pages/square/square' }
  }
})
