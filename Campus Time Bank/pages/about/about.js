/**
 * 关于 / 平台规则
 * ------------------------------------------------------------------
 * 顶部 App 介绍卡 → 什么是时间币 → 交易流程（4 步流程图）
 * → 信用分规则（constants.CREDIT_RULES）→ 用户协议要点 / 隐私说明
 * → 联系我们 → 当前运行模式提示（MOCK 黄色 / 云环境绿色）
 * ------------------------------------------------------------------
 */
const constants = require('../../utils/constants')
const util = require('../../utils/util')
const envList = require('../../envList')

const VERSION = '0.6.3'

Page({
  data: {
    version: VERSION,
    /*
     * ★ 运行模式：答辩演示时一眼看出用的是模拟数据还是真实云环境。
     *
     * ⚠️ 真实值在 onLoad 里算，**不能写在这里**。
     *    data 字面量只在**页面模块首次加载**时求值一次，之后即使调试模式
     *    开关变了也不会重算 —— 于是出现「先访问过本页、再开调试模式，
     *    回来还是旧值」。这和 envList.MOCK 的静态快照是同一类错误。
     */
    mock: false,
    /* ★ 身份预览（仅离线模式）：用来看「别的角色眼中的界面」 */
    previewRoles: [],
    previewRole: '',
    previewLabel: '',
    envText: '',
    /* 交易流程 4 步 */
    steps: [
      { icon: '🧊', title: '下单冻结', desc: '买家下单，时间币从可用余额转为冻结' },
      { icon: '🤝', title: '线下服务', desc: '服务者接单并完成技能交换' },
      { icon: '✅', title: '买家确认', desc: '买家确认服务完成，或 72 小时后自动确认' },
      { icon: '🪙', title: '结算到账', desc: '冻结的时间币真正转给服务者，双方各 +2 信用分' }
    ],
    rules: constants.CREDIT_RULES.map(r => Object.assign({}, r, {
      changeText: (r.change > 0 ? '+' : '') + r.change,
      isUp: r.change > 0,
      isZero: r.change === 0
    }))
  },

  /**
   * ★ 运行模式必须在 onLoad 里算，不能写在 data 字面量里。
   *   data 字面量只在模块首次加载时求值一次 —— 那样「先访问过本页、
   *   再开调试模式」就会一直显示旧值。
   */
  onLoad() {
    this.refreshMockState()
  },

  onShow() {
    this.refreshMockState()
    this.refreshPreview()
  },

  refreshMockState() {
    const app = getApp()
    const on = !!(app && app.globalData && app.globalData.MOCK)
    this.setData({
      mock: on,
      envText: on ? '当前为离线预览模式，数据来自本地模拟' : '已接入云开发环境'
    })
  },

  /* ================================================================
   * 身份预览（仅离线模式）
   * ----------------------------------------------------------------
   * 本机是管理员时，看不到普通用户眼中的界面 —— 而「管理员看不到普通
   * 用户长什么样」这件事会让权限相关的改动永远验不充分。
   *
   * ★ 为什么放在「关于与规则」页：任何角色都能到达这里。
   *   如果放在只有管理层能进的页面，切到普通用户后就**再也切不回来**。
   * ================================================================ */
  refreshPreview() {
    try {
      const pv = require('../../utils/mock').preview
      const cur = pv.current()
      const hit = pv.options.filter(o => o.value === cur)[0]
      this.setData({
        previewRoles: pv.options,
        previewRole: cur,
        previewLabel: hit ? hit.label : '跟随原始设置'
      })
    } catch (e) { /* 真实环境下没有预览，静默跳过 */ }
  },

  onPickPreview(e) {
    const value = (e.currentTarget.dataset || {}).value
    let pv = null
    try { pv = require('../../utils/mock').preview } catch (err) { return }
    pv.set(value)
    const hit = pv.options.filter(o => o.value === value)[0]
    /*
     * ★ 角色变了，内存里的权限缓存必须清掉 ——
     *   app.isAdminUser() 缓存为 true 就直接返回，不清的话切到普通用户
     *   仍然会看到管理员界面（测试结果会骗人）。
     */
    const app = getApp()
    if (app && app.globalData) {
      app.globalData.isAdmin = false
      app.globalData.isDebugger = false
      app.globalData.userInfo = null
      app.globalData.openid = ''
      app.globalData._loginTask = null
    }
    util.toastOk('已切换为「' + (hit ? hit.label : value) + '」')
    /*
     * ★ 用 redirectTo，**不能用 reLaunch**。
     *
     *   reLaunch 会清空整个页面栈 —— 切换后栈里只剩本页，
     *   手机的返回键就没有上一页可回，直接**退出小程序回到桌面**。
     *   而用户只是在本页切了个预览，返回键理应还能回到「我的」。
     *
     *   redirectTo 只替换当前页、保留后面的栈：
     *   本页被重建（onLoad 重跑，界面按新角色刷新），
     *   返回时「我的」页 onShow 也会重新查一次角色，
     *   所以两边都拿到新身份。
     */
    setTimeout(() => wx.redirectTo({ url: '/pages/about/about' }), 600)
  },

  /* ================================================================
   * 交互
   * ================================================================ */
  /** 复制邮箱 */
  /**
   * 长按版本号 → 内部账户登录（隐藏入口）。
   *
   * ★ 为什么藏起来：内部账户是校方/运维的特权通道。摆在「我的」页里
   *   等于告诉所有学生「这里有个特权入口」—— 不专业，也会引来试探。
   *
   * ★ 为什么不能只给管理员看：交接时新校方的微信**还没有任何权限**，
   *   如果入口藏在管理后台里，他就永远进不去（死锁）。
   *   所以留这个不依赖权限的隐藏触发。
   *
   * ⚠️ 口诀变更时同步改 docs/部署指南.md。
   */
  onHoldVersion() {
    wx.navigateTo({ url: '/pages/account/login/login' })
  },

  onCopyEmail() {
    util.copyText('timebank@example.edu.cn', '邮箱已复制')
  },

  /** 复制校园服务站地址 */
  onCopyAddress() {
    util.copyText('广东职业技术学院 · 学生活动中心 2 楼（时间银行校园服务站）', '地址已复制')
  },

  /** → 信用分详情 */
  goCredit() {
    wx.navigateTo({ url: '/pages/credit/detail/detail' })
  },

  onShareAppMessage() {
    return {
      title: '校园时间银行 · 用技能换技能，时间币不可充值不可提现',
      path: '/pages/square/square'
    }
  }
})
