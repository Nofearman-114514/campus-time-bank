/**
 * ★ 唯一网络出口
 * ------------------------------------------------------------------
 * 页面**禁止**直接调用 wx.cloud.callFunction，一律走这里。
 *
 *   const api = require('../../utils/api')
 *   const res = await api.skill.list({ page: 1, size: 10 })
 *   // res 就是云函数返回的 data 字段；失败会 throw Error(msg)
 *
 * 失败统一用 try/catch 处理：
 *   try { ... } catch (e) { util.toast(e.message) }
 * ------------------------------------------------------------------
 */
const cloud = require('./cloud')

/* ============================ 内部账户令牌 ============================ */
/**
 * 令牌的本地存储 key。
 *
 * ★ 普通用户**没有**令牌 —— 他们的身份来自微信（wx.login 换的 openid），
 *   这是小程序里唯一自然的方式，无需密码。
 *   只有内部账户（校方/运维）用账号密码登录后才会拿到令牌。
 */
const TOKEN_KEY = 'ctb_account_token'

function getToken() {
  try {
    return wx.getStorageSync(TOKEN_KEY) || ''
  } catch (e) {
    return ''
  }
}

function setToken(t) {
  try {
    if (t) wx.setStorageSync(TOKEN_KEY, t)
    else wx.removeStorageSync(TOKEN_KEY)
  } catch (e) { /* 存储失败则维持现状 */ }
}

/** 统一包装：把 action 塞进 data */
function call(name, action, payload, opts) {
  const data = Object.assign({ action }, payload || {})
  /*
   * ★ 令牌随每个请求走。云端的 wrap() 看到 __token 就解析会话，
   *   把这次请求的身份替换成该账户的合成 openid。
   *   没有令牌时什么都不加 —— 普通用户完全不受影响。
   */
  const tk = getToken()
  if (tk) data.__token = tk
  return cloud.call(name, data, opts)
}

/* ==================================================================
 * login —— 登录 / 资料 / 校园认证
 * ================================================================== */
const login = {
  /** 静默登录（首次调用自动注册并赠送时间币）→ { user, isNew, config } */
  login: p => call('login', 'login', p),
  /** 完善资料 → { user } */
  updateProfile: p => call('login', 'updateProfile', p),
  /** 提交校园认证 → { authStatus } */
  submitCampusAuth: p => call('login', 'submitCampusAuth', p),
  /** 绑定手机号（getPhoneNumber 的 code）→ { phone } */
  bindPhone: p => call('login', 'bindPhone', p),
  /** 查看他人公开资料 → { user } */
  getUser: p => call('login', 'getUser', p),
  /** 上报定位 → { ok } */
  updateLocation: p => call('login', 'updateLocation', p)
}

/* ==================================================================
 * skill —— 技能域
 * ================================================================== */
const skill = {
  /**
   * 技能列表
   * @param {Object} p { page, size, categoryId, keyword, type, sort, longitude, latitude, radius, onlyVerified }
   * @returns {Promise<{list:Array, total:Number, hasMore:Boolean}>}
   */
  list: p => call('skill', 'list', p),
  /** 详情 → { skill, author, isOwner, isCollected } */
  detail: p => call('skill', 'detail', p),
  /** 发布 → { id } */
  create: p => call('skill', 'create', p),
  /** 编辑 → { ok } */
  update: p => call('skill', 'update', p),
  /** 下架/删除 → { ok } */
  remove: p => call('skill', 'remove', p),
  /** 我的发布 → { list, total, hasMore } */
  myList: p => call('skill', 'myList', p),
  /** 收藏 / 取消收藏 → { collected:Boolean }。collected 缺省时按当前状态取反 */
  collect: p => call('skill', 'collect', p),
  /** 我的收藏 → { list, total, hasMore, page }（每条附 collectedTime） */
  myFavorites: p => call('skill', 'myFavorites', p),
  /** 分类列表 → { list } */
  categories: p => call('skill', 'categories', p),
  /** 首页轮播 → { list } */
  banners: p => call('skill', 'banners', p),
  /** 举报 → { ok } */
  report: p => call('skill', 'report', p)
}

/* ==================================================================
 * order —— 订单域（★ 时间币事务核心）
 * ================================================================== */
const order = {
  /** 下单（冻结买家时间币）→ { orderId, orderNo } */
  create: p => call('order', 'create', p),
  /** 卖家接单 → { ok } */
  accept: p => call('order', 'accept', p),
  /** 卖家拒单（解冻退回）→ { ok } */
  reject: p => call('order', 'reject', p),
  /** 取消订单 → { ok } */
  cancel: p => call('order', 'cancel', p),
  /** 服务者标记服务完成 → { ok } */
  finish: p => call('order', 'finish', p),
  /** ★ 买家确认完成 → 解冻并结算给卖家，双方 +2 信用分 */
  confirm: p => call('order', 'confirm', p),
  /** 列表 → { list, total, hasMore } */
  list: p => call('order', 'list', p),
  /** 详情 → { order, role } */
  detail: p => call('order', 'detail', p),
  /** 各状态数量 → { waiting, ongoing, confirming, finished, canceled } */
  counts: p => call('order', 'counts', p)
}

/* ==================================================================
 * wallet —— 时间币
 * ================================================================== */
const wallet = {
  /** → { coins, frozenCoins, totalEarned, totalSpent, income7d, expense7d } */
  info: p => call('wallet', 'info', p),
  /** 明细 → { list, total, hasMore } */
  logs: p => call('wallet', 'logs', p),
  /** 收支趋势与分类 → { trend, byCategory } */
  stats: p => call('wallet', 'stats', p)
}

/* ==================================================================
 * user —— 个人中心 / 信用 / 评价
 * ================================================================== */
const user = {
  /** 个人中心聚合 → { user, counts, badges } */
  mine: p => call('user', 'mine', p),
  /** 他人主页 → { user, skills, reviews, stats } */
  home: p => call('user', 'home', p),
  /** 信用分变动明细 → { list, total, hasMore } */
  creditLogs: p => call('user', 'creditLogs', p),
  /** 徽章 → { owned, all } */
  badges: p => call('user', 'badges', p),
  /** 评价列表 → { list, total, hasMore } */
  reviews: p => call('user', 'reviews', p),
  /** 发表评价 → { ok } */
  reviewCreate: p => call('user', 'reviewCreate', p),
  /** 回复评价 → { ok } */
  reviewReply: p => call('user', 'reviewReply', p),
  /**
   * 注销账号 → { ok }
   * ★ 不可逆：云端会把个人身份信息匿名化并禁用账号。
   *   调用前必须走完多步确认（见 pages/mine/mine.js 的 onCancelAccount）。
   */
  cancel: p => call('user', 'cancel', p)
}

/* ==================================================================
 * message —— 聊天 / 通知 / 订阅消息
 * ================================================================== */
const message = {
  /** 会话列表 → { list, total, hasMore } */
  conversations: p => call('message', 'conversations', p),
  /** 打开（或创建）与某人的会话 → { chatId } */
  openChat: p => call('message', 'openChat', p),
  /** 历史消息 → { list, hasMore } */
  history: p => call('message', 'history', p),
  /** 发送消息 → { msgId, createTime } */
  send: p => call('message', 'send', p),
  /** 标记会话已读 → { ok } */
  read: p => call('message', 'read', p),
  /** 未读总数 → { chat, notice } */
  unreadTotal: p => call('message', 'unreadTotal', p),
  /** 系统通知 → { list, total, hasMore } */
  notices: p => call('message', 'notices', p),
  /** 通知已读 → { ok }（传 { all: true } 全部已读） */
  readNotice: p => call('message', 'readNotice', p),
  /** 订阅消息模板配置 → { templates } */
  subConfig: p => call('message', 'subConfig', p)
}

/* ==================================================================
 * admin —— 管理端（全部要求 role === 'admin'）
 * ================================================================== */
const admin = {
  /** 是否管理员 → { isAdmin } */
  check: p => call('admin', 'check', p),
  /** ★ 数据看板 → 见 ARCHITECTURE.md §4.8 */
  stats: p => call('admin', 'stats', p),

  users: p => call('admin', 'users', p),
  auditUser: p => call('admin', 'auditUser', p),
  setUserStatus: p => call('admin', 'setUserStatus', p),
  setUserRole: p => call('admin', 'setUserRole', p),
  adjustCoins: p => call('admin', 'adjustCoins', p),

  categories: p => call('admin', 'categories', p),
  saveCategory: p => call('admin', 'saveCategory', p),
  deleteCategory: p => call('admin', 'deleteCategory', p),

  skills: p => call('admin', 'skills', p),
  auditSkill: p => call('admin', 'auditSkill', p),

  orders: p => call('admin', 'orders', p),

  reports: p => call('admin', 'reports', p),
  handleReport: p => call('admin', 'handleReport', p),

  banners: p => call('admin', 'banners', p),
  saveBanner: p => call('admin', 'saveBanner', p),
  deleteBanner: p => call('admin', 'deleteBanner', p),

  config: p => call('admin', 'config', p),
  saveConfig: p => call('admin', 'saveConfig', p)
}

/* ==================================================================
 * account —— 内部账户（账号密码登录，**不绑定微信号**）
 * ------------------------------------------------------------------
 * ★ 这条通道只服务「不属于任何个人微信号」的账号（校方 / 运维）。
 *   普通用户走 login 的静默登录，不需要也不应该用密码。
 * ================================================================== */
const account = {
  /** 账号密码登录 → { token, expireTime, user, role, isAdmin, isDebugger } */
  login: async p => {
    const res = await call('account', 'login', p)
    if (res && res.token) setToken(res.token)
    return res
  },
  /**
   * 退出内部账户。
   * ★ 顺序很重要：先让云端删掉会话（这时还需要令牌），再清本地令牌。
   */
  logout: async () => {
    let out = { ok: true }
    try {
      out = await call('account', 'logout')
    } catch (e) { /* 云端失败也要清本地令牌，否则会一直带着废令牌 */ }
    setToken('')
    return out
  },
  /** 当前是否以内部账户登录 → { account, user, role, isAdmin, isDebugger } */
  me: () => call('account', 'me')
}

module.exports = {
  login,
  skill,
  order,
  wallet,
  user,
  message,
  admin,
  account,
  /** 令牌读写（退出登录、切换账户时用） */
  getToken,
  setToken,
  /** 逃生舱：调用未在上面登记的 action */
  raw: (name, action, payload, opts) => call(name, action, payload, opts),
  BizError: cloud.BizError
}
