/**
 * 校园认证
 * ------------------------------------------------------------------
 * 状态（app.globalData.userInfo.authStatus）：
 *   0 未提交 → 直接展示表单
 *   1 审核中 → 蓝色卡片，可撤回重填
 *   2 已通过 → 绿色认证成功卡 + 「查看认证信息」折叠区（不再有提交按钮）
 *   3 已驳回 → 红色卡片醒目展示 authRemark，表单可重新填写提交
 * 上传凭证：真实环境先传云存储拿 fileID；MOCK 模式只保留本地临时路径。
 * ------------------------------------------------------------------
 */
const api = require('../../../utils/api')
const util = require('../../../utils/util')
const constants = require('../../../utils/constants')

const MAX_IMAGES = 3
const STEP_TEXTS = ['提交资料', '管理员审核', '认证完成']

Page({
  data: {
    status: 0,
    auth: constants.AUTH_STATUS[0],
    authTime: '',
    authRemark: '',
    userInfo: {},
    storedImages: [],     // 已提交的认证凭证（回看用）
    studentNoMask: '—',

    showForm: true,       // 是否展示表单
    showDetail: false,    // 「查看认证信息」折叠区

    steps: [],

    form: {
      realName: '',
      studentNo: '',
      campus: '广东职业技术学院',
      college: '',
      major: ''
    },
    images: [],           // 学生证/校园卡：本地临时路径 或 fileID
    maxImages: MAX_IMAGES,
    agree: false,
    submitting: false
  },

  /* ================================================================
   * 生命周期
   * ================================================================ */
  onLoad() {
    // 先读全局登录态里的认证状态，决定展示哪种卡片
    this.syncFromGlobal()

    // 冷启动直接进入本页时登录可能还没完成，等一次再同步
    const app = getApp()
    if (!app.globalData.userInfo) {
      app.login().then(() => this.syncFromGlobal()).catch(() => {})
    }
  },

  async onShow() {
    // 审核中的用户回到本页时，问一次服务端（可能已被管理员审核）
    if (this.data.status !== 1) return
    const app = getApp()
    try {
      await app.refreshUser()
      const u = app.globalData.userInfo || {}
      if (u.authStatus !== 1) this.syncFromGlobal()
    } catch (e) { /* 静默失败 */ }
  },

  /* ================================================================
   * 状态同步
   * ================================================================ */
  syncFromGlobal() {
    const app = getApp()
    const u = app.globalData.userInfo || {}
    const status = typeof u.authStatus === 'number' ? u.authStatus : 0

    this.buildSteps(status)

    this.setData({
      status: status,
      auth: constants.AUTH_STATUS[status] || constants.AUTH_STATUS[0],
      authTime: u.authTime ? util.formatDate(u.authTime) : '',
      authRemark: u.authRemark || '',
      userInfo: u,
      storedImages: u.authImages || [],
      studentNoMask: this.maskStudentNo(u.studentNo),
      showForm: status === 0 || status === 3,
      // 学校默认取用户资料里的校园，没有则「广东职业技术学院」
      'form.campus': u.campus || '广东职业技术学院'
    })
  },

  /** 学号脱敏展示 */
  maskStudentNo(no) {
    const s = String(no || '')
    if (s.length <= 4) return s || '—'
    return s.slice(0, 2) + '****' + s.slice(-2)
  },

  /** 构建三步时间轴：done 已完成 / current 当前 / todo 未到 */
  buildSteps(status) {
    const idx = status === 2 ? 2 : (status === 1 ? 1 : 0)
    const steps = STEP_TEXTS.map((text, i) => ({
      text: text,
      state: i < idx ? 'done' : (i === idx ? 'current' : 'todo')
    }))
    this.setData({ steps: steps })
  },

  /* ================================================================
   * 表单输入
   * ================================================================ */
  onInput(e) {
    const field = e.currentTarget.dataset.field
    if (!field) return
    const patch = {}
    patch['form.' + field] = (e.detail && e.detail.value) || ''
    this.setData(patch)
  },

  onAgree(e) {
    const value = (e.detail && e.detail.value) || []
    this.setData({ agree: value.indexOf('1') > -1 })
  },

  /* ================================================================
   * 凭证图片
   * ================================================================ */
  async onChooseImages() {
    const left = MAX_IMAGES - this.data.images.length
    if (left <= 0) return util.toast(`最多上传 ${MAX_IMAGES} 张`)

    const app = getApp()
    try {
      const paths = await util.chooseImage(left, ['camera', 'album'])
      if (!paths || !paths.length) return

      const added = []
      if (app.globalData.MOCK) {
        // 离线预览模式没有云存储：直接用本地临时路径预览与提交（重启后失效）
        paths.forEach(p => added.push(p))
      } else {
        util.loading('上传中')
        for (let i = 0; i < paths.length; i++) {
          added.push(await util.uploadFile(paths[i], 'auth'))
        }
      }
      this.setData({ images: this.data.images.concat(added) })
    } catch (e) {
      util.toast(e.message || e.errMsg || '图片上传失败')
    } finally {
      util.hideLoading()
    }
  },

  onDeleteImage(e) {
    const index = Number(e.currentTarget.dataset.index)
    const images = (this.data.images || []).slice()
    if (index < 0 || index >= images.length) return
    images.splice(index, 1)
    this.setData({ images: images })
  },

  /** 预览：表单里的图片 或 已提交的认证图片 */
  async onPreview(e) {
    const index = Number(e.currentTarget.dataset.index) || 0
    const source = e.currentTarget.dataset.source
    const list = (source === 'stored'
      ? (this.data.storedImages || [])
      : (this.data.images || [])).filter(Boolean)

    if (!list.length) return
    const current = list[index] || list[0]

    // 云存储 fileID 需要先换成临时链接才能预览
    if (!/^cloud:\/\//.test(current)) return util.previewImage(list, current)
    try {
      const map = await util.getTempFileURL(list)
      util.previewImage(list.map(id => map[id] || id), map[current] || current)
    } catch (err) {
      util.previewImage(list, current)
    }
  },

  /* ================================================================
   * 撤回重填（审核中）
   * ================================================================ */
  async onWithdraw() {
    if (!(await util.confirm('撤回后可以重新填写资料并再次提交，确认撤回吗？'))) return
    this.setData({ showForm: true })
    util.toast('请修改后重新提交')
  },

  onToggleDetail() {
    this.setData({ showDetail: !this.data.showDetail })
  },

  /* ================================================================
   * 提交认证
   * ================================================================ */
  async onSubmit() {
    if (this.data.submitting) return

    const form = this.data.form || {}
    const realName = util.trimAll(form.realName)
    const studentNo = util.trimAll(form.studentNo)
    const campus = util.trimAll(form.campus)
    const college = util.trimAll(form.college)
    const major = util.trimAll(form.major)

    // ---- 校验 ----
    if (!realName) return util.toast('请填写真实姓名')
    if (realName.length > 10) return util.toast('姓名不能超过 10 个字')
    if (!util.isStudentNo(studentNo)) return util.toast('学号格式不正确（4~20 位数字或字母）')
    if (!campus) return util.toast('请填写学校')
    if (!college) return util.toast('请填写学院')
    if (!major) return util.toast('请填写专业')
    if (!this.data.images.length) return util.toast('请上传学生证或校园卡照片')
    if (!this.data.agree) return util.toast('请先阅读并同意认证协议')

    if (!(await util.confirm('提交后资料将提交管理员审核，确认信息真实有效？'))) return

    const app = getApp()
    this.setData({ submitting: true })
    try {
      await api.login.submitCampusAuth({
        realName: realName,
        studentNo: studentNo,
        campus: campus,
        college: college,
        // ★ 契约 §4.1 未列出 major，但表单要求填写「专业」，这里一并上报（云函数忽略未知字段）
        major: major,
        authImages: this.data.images
      })

      await app.refreshUser()

      // 切换到「审核中」展示
      this.buildSteps(1)
      this.setData({
        status: 1,
        auth: constants.AUTH_STATUS[1],
        authRemark: '',
        showForm: false,
        studentNoMask: this.maskStudentNo(studentNo)
      })
      util.toastOk('已提交，等待审核')
    } catch (e) {
      util.toast(e.message)
    } finally {
      this.setData({ submitting: false })
    }
  }
})
