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

const VERSION = '1.0.0'

Page({
  data: {
    version: VERSION,
    /* ★ 运行模式：答辩演示时一眼看出用的是模拟数据还是真实云环境 */
    mock: envList.MOCK,
    envText: envList.MOCK
      ? '当前为离线预览模式，数据来自本地模拟'
      : '已接入云开发环境',
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
