/**
 * 编辑资料
 * ------------------------------------------------------------------
 * 入口：① 我的 → 编辑资料  ② app.requireUser 首次完善引导（?first=1）
 * 要点：
 *   · 头像用官方 <button open-type="chooseAvatar">，并保留「从相册选择」兜底
 *   · 昵称用官方 <input type="nickname">，也允许手动修改
 *   · 头像先上传到云存储拿 fileID 再保存；MOCK 模式没有云存储，只存本地临时路径
 * ------------------------------------------------------------------
 */
const api = require('../../../utils/api')
const util = require('../../../utils/util')
const constants = require('../../../utils/constants')

const GENDER_RANGE = ['保密', '男', '女']
const GRADE_RANGE = ['2021级', '2022级', '2023级', '2024级', '2025级']
const MAX_TAGS = 5
const MAX_NICK = 12

Page({
  data: {
    first: false,          // 是否来自「首次完善资料」引导
    saving: false,

    form: {
      nickName: '',
      avatarUrl: '',
      gender: 0,
      campus: '',
      college: '',
      major: '',
      grade: '',
      bio: '',
      tags: [],
      phone: ''
    },

    genderRange: GENDER_RANGE,
    genderIndex: 0,
    gradeRange: GRADE_RANGE,
    gradeIndex: -1,        // -1 表示未选择
    bioLen: 0,
    tagInput: '',
    maxTags: MAX_TAGS,

    authStatus: 0,
    auth: constants.AUTH_STATUS[0]
  },

  /* ================================================================
   * 生命周期
   * ================================================================ */
  onLoad(options) {
    const first = (options && options.first) === '1'
    this.setData({ first: first })
    this.fillFromGlobal()

    // 冷启动直接进入本页时登录可能还没完成，等一次再回填
    const app = getApp()
    if (!app.globalData.userInfo) {
      app.login().then(() => this.fillFromGlobal()).catch(() => {})
    }
  },

  onShow() {
    // 从校园认证页返回时同步最新状态
    this.syncAuth()
  },

  /** 用全局用户信息回填表单 */
  fillFromGlobal() {
    const app = getApp()
    const u = app.globalData.userInfo || {}
    const genderIndex = GENDER_RANGE.indexOf(
      u.gender === 1 ? '男' : (u.gender === 2 ? '女' : '保密')
    )

    this.setData({
      form: {
        nickName: u.nickName || '',
        avatarUrl: u.avatarUrl || '',
        gender: u.gender || 0,
        campus: u.campus || '',
        college: u.college || '',
        major: u.major || '',
        grade: u.grade || '',
        bio: u.bio || '',
        tags: (u.tags || []).slice(0, MAX_TAGS),
        phone: u.phone || ''
      },
      genderIndex: genderIndex < 0 ? 0 : genderIndex,
      gradeIndex: GRADE_RANGE.indexOf(u.grade || ''),
      bioLen: (u.bio || '').length
    })
    this.syncAuth()
  },

  syncAuth() {
    const u = (getApp().globalData.userInfo) || {}
    const status = typeof u.authStatus === 'number' ? u.authStatus : 0
    this.setData({
      authStatus: status,
      auth: constants.AUTH_STATUS[status] || constants.AUTH_STATUS[0]
    })
  },

  /* ================================================================
   * 头像
   * ================================================================ */
  /** 官方头像填写能力（基础库 2.21.2+） */
  onChooseAvatar(e) {
    const url = (e && e.detail && e.detail.avatarUrl) || ''
    if (!url) return util.toast('未获取到微信头像')
    this.setAvatar(url)
  },

  /** 兜底：从相册 / 相机选择 */
  async onPickAlbum() {
    try {
      const paths = await util.chooseImage(1, ['album', 'camera'])
      if (!paths || !paths.length) return
      this.setAvatar(paths[0])
    } catch (e) {
      util.toast(e.errMsg || e.message || '选择图片失败')
    }
  },

  /** 上传头像：先拿 fileID 再保存 */
  async setAvatar(tempPath) {
    const app = getApp()
    try {
      if (app.globalData.MOCK) {
        // 离线预览模式没有云存储，直接用本地临时路径渲染（重启小程序后会失效）
        this.setData({ 'form.avatarUrl': tempPath })
        util.toast('离线预览模式，头像仅本地生效')
        return
      }
      util.loading('上传中')
      const fileID = await util.uploadFile(tempPath, 'avatar')
      this.setData({ 'form.avatarUrl': fileID })
    } catch (e) {
      util.toast(e.message || '头像上传失败')
    } finally {
      util.hideLoading()
    }
  },

  /* ================================================================
   * 基础字段
   * ================================================================ */
  /** 通用输入（通过 data-field 区分字段） */
  onInput(e) {
    const field = e.currentTarget.dataset.field
    if (!field) return
    const value = (e.detail && e.detail.value) || ''
    const patch = {}
    patch['form.' + field] = value
    this.setData(patch)
  },

  /** 昵称：官方 nickname 能力会走 bindinput / bindblur */
  onNickname(e) {
    const value = (e.detail && e.detail.value) || ''
    this.setData({ 'form.nickName': value })
  },

  onGender(e) {
    const index = Number(e.detail.value) || 0
    this.setData({ genderIndex: index, 'form.gender': index })
  },

  onGrade(e) {
    const index = Number(e.detail.value) || 0
    this.setData({ gradeIndex: index, 'form.grade': GRADE_RANGE[index] || '' })
  },

  onBio(e) {
    const value = (e.detail && e.detail.value) || ''
    this.setData({ 'form.bio': value, bioLen: value.length })
  },

  /* ================================================================
   * 技能标签
   * ================================================================ */
  onTagInput(e) {
    this.setData({ tagInput: (e.detail && e.detail.value) || '' })
  },

  /** 回车或点「添加」都走这里 */
  onAddTag() {
    const value = util.trimAll(this.data.tagInput)
    if (!value) return
    if (value.length > 8) return util.toast('单个标签不超过 8 个字')

    const tags = this.data.form.tags || []
    if (tags.length >= MAX_TAGS) return util.toast(`最多添加 ${MAX_TAGS} 个标签`)
    if (tags.indexOf(value) > -1) return util.toast('该标签已存在')

    this.setData({ 'form.tags': tags.concat([value]), tagInput: '' })
  },

  onDeleteTag(e) {
    const index = Number(e.currentTarget.dataset.index)
    const tags = (this.data.form.tags || []).slice()
    if (index < 0 || index >= tags.length) return
    tags.splice(index, 1)
    this.setData({ 'form.tags': tags })
  },

  /* ================================================================
   * 手机号（可选）
   * ================================================================ */
  async onGetPhone(e) {
    const app = getApp()
    // 离线预览模式没有真实手机号能力，直接跳过
    if (app.globalData.MOCK) return util.toast('离线预览模式跳过')

    const detail = (e && e.detail) || {}
    if (!detail.code) return util.toast('未授权手机号')

    try {
      util.loading('绑定中')
      const res = await api.login.bindPhone({ code: detail.code })
      this.setData({ 'form.phone': (res && res.phone) || '' })
      util.hideLoading()
      util.toastOk('绑定成功')
    } catch (err) {
      util.hideLoading()
      util.toast(err.message)
    }
  },

  /* ================================================================
   * 校园认证入口
   * ================================================================ */
  goAuth() {
    wx.navigateTo({ url: '/pages/auth/campus/campus' })
  },

  /* ================================================================
   * 保存
   * ================================================================ */
  async onSave() {
    if (this.data.saving) return
    const form = this.data.form || {}
    const nickName = util.trimAll(form.nickName)

    // 校验：昵称非空且 ≤12 字
    if (!nickName) return util.toast('请填写昵称')
    if (nickName.length > MAX_NICK) return util.toast(`昵称不能超过 ${MAX_NICK} 个字`)

    const app = getApp()
    this.setData({ saving: true })
    try {
      await api.login.updateProfile({
        nickName: nickName,
        avatarUrl: form.avatarUrl || '',
        gender: form.gender || 0,
        bio: util.trimAll(form.bio),
        campus: util.trimAll(form.campus),
        college: util.trimAll(form.college),
        major: util.trimAll(form.major),
        grade: form.grade || '',
        tags: form.tags || []
      })
      await app.refreshUser()
      util.toastOk('保存成功')
      setTimeout(() => wx.navigateBack({ fail: () => {} }), 700)
    } catch (e) {
      util.toast(e.message)
    } finally {
      this.setData({ saving: false })
    }
  }
})
