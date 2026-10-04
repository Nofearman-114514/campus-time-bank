/**
 * 下单确认页
 * ------------------------------------------------------------------
 * 流程：skill.detail 拿技能 → 校验信用分 / 余额 → order.create（冻结时间币）
 *      → 成功跳订单详情（redirectTo），并请求订阅消息授权（失败静默）
 * 答辩要点：下单只「冻结」不扣款，完成并确认后才真正结算给服务者。
 * ------------------------------------------------------------------
 */
const api = require('../../../utils/api')
const util = require('../../../utils/util')

const DURATION_TEXT = {
  30: '30 分钟', 60: '1 小时', 90: '1.5 小时', 120: '2 小时',
  150: '2.5 小时', 180: '3 小时', 240: '4 小时'
}

const COVER_ICON = {
  学业辅导: '📚', 技能教学: '🎸', 摄影修图: '📷', 代取代买: '🛵',
  电脑技术: '💻', 运动健身: '🏃', 生活服务: '🧺', 设计美工: '🎨',
  语言互助: '🌏', 其他: '✨'
}

/** 默认期望时间：明天此刻（整点） */
function defaultExpect() {
  const d = new Date(Date.now() + 86400000)
  const pad = n => (n < 10 ? '0' + n : '' + n)
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:00`
}

Page({
  data: {
    skillId: '',
    loading: true,
    skill: {},
    author: {},

    coverIcon: '✨',
    durationText: '',

    /* 时间币结算 */
    coins: 0,
    frozenCoins: 0,
    amount: 0,
    balanceAfter: 0,
    enough: true,
    shortfall: 0,

    /* 信用分 */
    creditScore: 100,
    minCredit: 60,
    creditBlocked: false,

    /* 表单 */
    expectDate: '',
    expectTime: '',
    expectTimeText: '',
    contact: '',
    remark: '',

    submitting: false
  },

  onLoad(options) {
    const skillId = (options && options.skillId) || ''
    if (!skillId) {
      util.toast('缺少技能参数')
      setTimeout(() => wx.navigateBack(), 800)
      return
    }
    const app = getApp()
    const cfg = app.globalData.config || {}
    const user = app.globalData.userInfo || {}
    const creditScore = user.creditScore === undefined ? 100 : user.creditScore
    // ★ 用 `=== undefined` 而不是 `|| 60`：管理员可以把门槛设为 0（=关闭门槛），
  //   0 是合法值，用 || 会被顶成 60，造成「后端放行、前端拦住」。
  const minCredit = cfg.minCreditToOrder === undefined ? 60 : cfg.minCreditToOrder
    const def = defaultExpect()

    this.setData({
      skillId,
      coins: user.coins || 0,
      frozenCoins: user.frozenCoins || 0,
      creditScore,
      minCredit,
      creditBlocked: creditScore < minCredit,
      expectDate: def.slice(0, 10),
      expectTime: def.slice(11),
      expectTimeText: def
    })
    this.loadSkill()
    this.refreshBalance()
  },

  /* ================================================================
   * 数据
   * ================================================================ */
  async loadSkill() {
    try {
      const res = await api.skill.detail({ id: this.data.skillId })
      const skill = (res && res.skill) || {}
      this.setData({
        skill,
        author: (res && res.author) || {},
        coverIcon: COVER_ICON[skill.categoryName] || '✨',
        durationText: DURATION_TEXT[skill.duration] || (skill.duration ? `${skill.duration} 分钟` : '未填写'),
        amount: Number(skill.price) || 0,
        loading: false
      })
      this.recalc()
    } catch (e) {
      this.setData({ loading: false })
      util.toast(e.message)
    }
  },

  /** 余额以钱包为准（可能刚有订单结算） */
  async refreshBalance() {
    try {
      const res = await api.wallet.info({})
      const user = getApp().globalData.userInfo || {}
      this.setData({
        coins: (res && res.coins) || user.coins || 0,
        frozenCoins: (res && res.frozenCoins) || user.frozenCoins || 0
      })
      this.recalc()
    } catch (e) {
      // 拉取失败时用本地登录态兜底，不打断下单
      this.recalc()
    }
  },

  /** 重算「下单后余额」与余额是否充足 */
  recalc() {
    const coins = Number(this.data.coins) || 0
    const amount = Number(this.data.amount) || 0
    const after = coins - amount
    this.setData({
      balanceAfter: after,
      enough: after >= 0,
      shortfall: after < 0 ? -after : 0
    })
  },

  /* ================================================================
   * 表单一
   * ================================================================ */
  onDateChange(e) {
    this.setData({ expectDate: e.detail.value }, () => this.syncExpectText())
  },
  onTimeChange(e) {
    this.setData({ expectTime: e.detail.value }, () => this.syncExpectText())
  },
  syncExpectText() {
    const d = this.data.expectDate
    const t = this.data.expectTime
    this.setData({ expectTimeText: d && t ? `${d} ${t}` : (d || '') })
  },
  onContactInput(e) {
    this.setData({ contact: e.detail.value || '' })
  },
  onRemarkInput(e) {
    this.setData({ remark: e.detail.value || '' })
  },

  /* ================================================================
   * 提交
   * ================================================================ */
  async onSubmit() {
    if (this.data.submitting) return
    if (this.data.creditBlocked) {
      const go = await util.confirm(
        `信用分低于 ${this.data.minCredit} 分时暂时不能下单，可通过按时完成服务与收到好评提升信用分。`,
        '暂时不能下单'
      )
      if (go) util.navTo('/pages/credit/detail/detail')
      return
    }
    if (!this.data.enough) {
      return util.toast(`时间币不足，还差 ${this.data.shortfall} 枚`)
    }

    const ok = await util.confirm(
      `确认下单吗？将冻结 ${this.data.amount} 枚时间币，服务完成并由你确认后才会结算给服务者。`,
      '下单确认'
    )
    if (!ok) return

    this.setData({ submitting: true })
    util.loading('提交中')
    try {
      const res = await api.order.create({
        skillId: this.data.skillId,
        remark: util.trimAll(this.data.remark),
        expectTime: this.data.expectTimeText,
        contact: util.trimAll(this.data.contact)
      })
      util.hideLoading()
      util.toastOk('下单成功')

      const app = getApp()
      app.emit('orderChange')
      app.refreshTabBadge()
      // 订阅消息授权：失败静默，不阻断主流程
      app.requestSubscribe(['ORDER_CREATE']).catch(() => {})

      const orderId = (res && res.orderId) || ''
      setTimeout(() => {
        if (orderId) {
          wx.redirectTo({ url: `/pages/order/detail/detail?orderId=${orderId}` })
        } else {
          wx.navigateBack()
        }
      }, 600)
    } catch (e) {
      util.hideLoading()
      util.toast(e.message)
    } finally {
      this.setData({ submitting: false })
    }
  }
})
