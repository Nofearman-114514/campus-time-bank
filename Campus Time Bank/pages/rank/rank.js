/**
 * 贡献排行榜
 * ==================================================================
 * 接口：api.user.leaderboard
 *
 * ★ 按「累计收入」排，**不是按时间币余额** ——
 *   按余额排会让靠前的人更有动力不花出去，币越堆越集中；
 *   一个全站只有 30 枚币的平台，前 3 名囤了 25 枚，剩下的人就没币交易了。
 *   按收入排 = 鼓励提供服务，与「用技能换技能」的初衷一致。
 *
 * ★ 昵称脱敏在**服务端**完成（本页拿到的已经是「王*明」）——
 *   只在客户端遮是没用的，接口照样返回真名。
 *
 * ★ 只展示前 20 名 + 自己的名次：校园是熟人圈，全站排名会让靠后的人
 *   被「公开处刑」，而新用户恰恰最需要鼓励。
 * ==================================================================
 */
const api = require('../../utils/api')
const util = require('../../utils/util')

Page({
  data: {
    list: [],
    me: null,
    loading: true,
    switching: false
  },

  onLoad() { this.load() },

  onPullDownRefresh() {
    this.load().then(() => wx.stopPullDownRefresh())
  },

  async load() {
    this.setData({ loading: true })
    try {
      const res = (await api.user.leaderboard({ limit: 20 })) || {}
      /*
       * ★ 展示文本在这里拼好，不写在 WXML 里。
       *   三元 + 字符串拼接堆在模板里，改一次要看半天；拼在 JS 里还能被测试覆盖。
       *   学院缺失时不留一个孤零零的分隔点。
       */
      const list = (res.list || []).map(it => Object.assign({}, it, {
        medal: it.rank === 1 ? '🥇' : (it.rank === 2 ? '🥈' : (it.rank === 3 ? '🥉' : '')),
        // ★ 同样不能用 slice：昵称首字可能是 emoji（占两个码元），
        //   切半个会渲染成「�」。脱敏后的昵称最短只有 1 个字，这条路走得到。
        avatarText: (Array.from(it.nickName || '?')[0]) || '?',
        subText: (it.college ? it.college + ' · ' : '') +
          '服务 ' + (it.serveCount || 0) + ' 次 · 信用分 ' + (it.creditScore || 0)
      }))
      this.setData({ list: list, me: res.me || null, loading: false })
    } catch (e) {
      this.setData({ loading: false })
      util.toast((e && e.message) || '加载失败')
    }
  },

  /**
   * 切换「参与排行榜」。
   * ★ 这是一个隐私开关：校园是熟人圈，不是所有人都愿意被公开比较。
   *   关掉后服务端查询会把你排除在榜单之外，自己的名次也不显示。
   */
  async onToggleJoin(e) {
    if (this.data.switching) return
    const on = !!(e.detail && e.detail.value)
    this.setData({ switching: true })
    try {
      await api.login.updateProfile({ leaderboardHidden: !on })
      util.toastOk(on ? '已加入榜单' : '已退出榜单')
      this.setData({ switching: false })
      this.load()
    } catch (err) {
      this.setData({ switching: false })
      util.toast((err && err.message) || '设置失败')
    }
  },

  goUser(e) {
    const id = e.currentTarget.dataset.id
    if (!id) return
    wx.navigateTo({ url: '/pages/user/home/home?id=' + encodeURIComponent(id) })
  },

  onShareAppMessage() {
    return { title: '校园时间银行 · 贡献榜', path: '/pages/square/square' }
  }
})
