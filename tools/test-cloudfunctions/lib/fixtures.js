/**
 * 测试夹具：把用户 / 技能 / 配置写入内存库，并提供读库与调用云函数的便捷方法
 * 数据结构严格按 docs/ARCHITECTURE.md §3.1 / §3.3 / §3.13。
 */
const BASE_STATS = () => ({
  publishCount: 0, serveCount: 0, buyCount: 0,
  reviewCount: 0, ratingSum: 0, avgRating: 0, ontimeStreak: 0
})

const HOUR = 3600000

function attach(t) {
  const fake = t.fake

  /** 小时偏移的时间（负数=过去） */
  const D = h => new Date(Date.now() - h * HOUR)

  function store() {
    const s = fake.__store.collections
    ;['users', 'skills', 'orders', 'wallet_logs', 'credit_logs', 'notices', 'config']
      .forEach(k => { s[k] = s[k] || [] })
    return s
  }

  /**
   * 重置并写入一套标准夹具
   * @param {Object} o { buyScore, buyAuth, buyCoins, selScore, selAuth, serveCount, avgRating, streak, price, skillStatus, subscribe }
   */
  function seed(o) {
    const e = o || {}
    fake.__reset()
    fake.__resetStats()
    const s = store()

    s.users = [
      {
        _id: 'u_buy', _openid: 'o_buy', nickName: '买家小明', avatarUrl: '',
        authStatus: e.buyAuth == null ? 2 : e.buyAuth,
        coins: e.buyCoins == null ? 10 : e.buyCoins, frozenCoins: 0,
        totalEarned: 0, totalSpent: 0,
        creditScore: e.buyScore == null ? 100 : e.buyScore, creditLevel: 'good',
        badges: [], stats: BASE_STATS(), role: 'user', status: 1, createTime: D(200)
      },
      {
        _id: 'u_sel', _openid: 'o_sel', nickName: '卖家思远', avatarUrl: '',
        authStatus: e.selAuth == null ? 2 : e.selAuth,
        coins: 0, frozenCoins: 0, totalEarned: 0, totalSpent: 0,
        creditScore: e.selScore == null ? 110 : e.selScore, creditLevel: 'good',
        badges: [],
        stats: Object.assign(BASE_STATS(), {
          serveCount: e.serveCount || 0,
          avgRating: e.avgRating == null ? 4.7 : e.avgRating,
          ontimeStreak: e.streak || 0
        }),
        role: 'user', status: 1, createTime: D(200)
      },
      {
        _id: 'u_weak', _openid: 'o_weak', nickName: '路人同学', avatarUrl: '', authStatus: 2,
        coins: 10, frozenCoins: 0, totalEarned: 0, totalSpent: 0,
        creditScore: 100, creditLevel: 'good', badges: [], stats: BASE_STATS(),
        role: 'user', status: 1, createTime: D(200)
      },
      {
        _id: 'u_adm', _openid: 'o_adm', nickName: '管理员', avatarUrl: '', authStatus: 2,
        coins: 0, frozenCoins: 0, totalEarned: 0, totalSpent: 0,
        creditScore: 100, creditLevel: 'good', badges: [], stats: BASE_STATS(),
        role: 'admin', status: 1, createTime: D(200)
      }
    ]

    s.skills = [{
      _id: 'sk1', _openid: 'o_sel', authorId: 'o_sel',
      authorInfo: { nickName: '卖家思远', avatarUrl: '', creditScore: 110, creditLevel: 'good', authStatus: 2 },
      type: 'offer', title: '吉他入门一对一', categoryId: 'c2', categoryName: '技能教学',
      price: e.price == null ? 3 : e.price, duration: 60, images: [],
      status: e.skillStatus == null ? 1 : e.skillStatus,
      orderCount: 0, createTime: D(50)
    }]

    s.config = [{
      _id: 'global', registerBonus: 5, orderExpireHours: 24, confirmExpireHours: 72,
      minCreditToOrder: 60, serviceFee: 0,
      subscribeTemplates: e.subscribe || {}
    }]
    return s
  }

  /** 调用云函数（自动带上 openid 登录态） */
  async function call(fn, openid, action, payload) {
    fake.__setOpenId(openid || '')
    return t.fns[fn].main(Object.assign({ action }, payload || {}), { function_name: fn })
  }

  /** 调用云函数（不带登录态，用于定时触发器） */
  async function callRaw(fn, event) {
    fake.__setOpenId('')
    return t.fns[fn].main(event, { function_name: fn })
  }

  /** 直接塞一条订单（用于构造超时等场景，绕过 create 的信用上限） */
  function putOrder(o) {
    const s = store()
    const doc = Object.assign({
      _openid: o.buyerId, orderNo: 'TB_MANUAL_' + s.orders.length,
      skillId: 'sk1',
      skillSnapshot: { title: '手工构造单', price: 2, duration: 60, categoryName: '技能教学', images: [], type: 'offer' },
      buyerId: 'o_buy', buyerInfo: { nickName: '买家小明', avatarUrl: '', creditScore: 100 },
      sellerId: 'o_sel', sellerInfo: { nickName: '卖家思远', avatarUrl: '', creditScore: 110 },
      amount: 2, status: 'waiting', remark: '', expectTime: '', contact: '',
      timeline: [{ status: 'waiting', time: D(1), remark: '买家下单，时间币已冻结', operator: 'o_buy' }],
      cancelBy: '', cancelReason: '',
      isRatedBuyer: false, isRatedSeller: false, buyerScore: 0, sellerScore: 0,
      createTime: D(1), acceptTime: null, finishTime: null, confirmTime: null, cancelTime: null,
      expireTime: D(1)   // 默认已过期 1 小时（putOrder 主要用于构造超时场景）
    }, o)
    s.orders.push(doc)
    return doc
  }

  Object.assign(t, {
    D, HOUR, store, seed, call, callRaw, putOrder,
    user: oid => store().users.find(u => u._openid === oid),
    order: id => store().orders.find(o => o._id === id),
    orders: () => store().orders,
    skill: (id) => store().skills.find(s => s._id === (id || 'sk1')),
    logs: (oid, type) => store().wallet_logs.filter(l => l._openid === oid && (!type || l.type === type)),
    credits: oid => store().credit_logs.filter(c => c._openid === oid),
    notices: oid => store().notices.filter(n => n._openid === oid)
  })
  return t
}

module.exports = { attach, BASE_STATS }
