/**
 * 云开发环境与全局配置
 * ==================================================================
 * ★ 个人配置不写在这个文件里。
 *
 *   下面的 ENV_ID / QQMAP_KEY / SUBSCRIBE_TEMPLATES 都会进 git，
 *   所以真实值请放在**同目录下的 `envList.local.js`**（已被 .gitignore 排除）：
 *
 *     // Campus Time Bank/envList.local.js
 *     module.exports = {
 *       ENV_ID: '你的云开发环境 ID',
 *       QQMAP_KEY: '你的腾讯位置服务 Key',        // 可选
 *       SUBSCRIBE_TEMPLATES: { ORDER_CREATE: '' } // 可选
 *     }
 *
 *   本文件会自动读取它；文件不存在也能正常启动。
 *
 * ★ 不填 ENV_ID 也能跑：
 *   小程序会自动进入「调试模式」，用内置模拟数据把全部页面走通。
 *   别人 clone 下来无需任何云环境即可预览 —— 这正是调试模式的价值。
 *
 * ★ 部署：微信开发者工具 → 云开发 → 设置 → 环境 ID，
 *   形如 myschool-1g2h3i4j5k6l7m。
 * ==================================================================
 */

// 个人配置（存在则覆盖下面的默认值；不存在时为 {}）
let LOCAL = {}
try {
  LOCAL = require('./envList.local') || {}
} catch (e) {
  LOCAL = {}
}

// ============================ 必填 ============================
/** 云开发环境 ID —— 真实值在 envList.local.js 里 */
const ENV_ID = LOCAL.ENV_ID || ''

// ============================ 可选 ============================
// 订阅消息模板 ID（微信公众平台 → 订阅消息 → 选用模板后获得）
// 留空则自动降级为「站内通知」，不影响任何主流程
const SUBSCRIBE_TEMPLATES = Object.assign({
  ORDER_CREATE: '', // 新订单提醒（发给服务者）
  ORDER_ACCEPT: '', // 接单成功通知（发给买家）
  ORDER_FINISH: '', // 服务完成待确认（发给买家）
  ORDER_CONFIRM: '' // 确认完成到账（发给服务者）
}, LOCAL.SUBSCRIBE_TEMPLATES || {})

// 腾讯位置服务 Key（可选，仅用于逆地址解析；不填也能跑通全部功能）
const QQMAP_KEY = LOCAL.QQMAP_KEY || ''

// 手动强制调试模式（true 强制模拟数据；null = 由 ENV_ID 是否为空自动决定）
const MOCK_OVERRIDE = null

// ============================ 调试模式 ============================
/**
 * 「调试模式」= 用内置模拟数据运行，不连云环境。
 *
 * ★ 两层来源：
 *   ① 编译期基础值 —— ENV_ID 为空（纯前端开发）或 MOCK_OVERRIDE 显式打开；
 *   ② **运行时开关** —— 管理员在「管理端 → 设置」里打开（存本地存储）。
 *
 * ★ 为什么必须是**函数**而不是常量：
 *   管理员切换开关后要立即生效，而模块级常量在 require 时就定死了、
 *   重新进页面也不会重算（小程序不会重新执行 require）。
 */
const DEBUG_KEY = 'ctb_debug_mode'

/** 编译期基础值 */
function baseMock() {
  return MOCK_OVERRIDE === null ? !ENV_ID : !!MOCK_OVERRIDE
}

/** 本地是否开着调试模式（只有管理员能在设置页打开） */
function isDebugOn() {
  try {
    return wx.getStorageSync(DEBUG_KEY) === true
  } catch (e) {
    return false
  }
}

/** ★ 运行时判断：当前是否处于调试模式 */
function isMock() {
  return baseMock() || isDebugOn()
}

/** 开启 / 关闭调试模式（调用方负责校验管理员身份） */
function setDebugMode(on) {
  try {
    if (on) wx.setStorageSync(DEBUG_KEY, true)
    else wx.removeStorageSync(DEBUG_KEY)
  } catch (e) { /* 存储失败则维持现状 */ }
}

/* ============================ 多账号测试开关 ============================ */
/**
 * ★ 这是一个**测试功能开关**，默认关闭。
 *
 *   为什么要开关：多账号会让答辩变难 —— 功能再多，讲不清楚就是减分。
 *   所以默认关着，答辩时展示简单版本；需要用的时候由调试员打开。
 *
 * ★ 只对**调试员**可见。学生管理员看不到这个开关，也看不到它开启后才
 *   出现的一切入口 —— 和调试模式、危险操作区用的是同一条原则：
 *   没把握的功能不给学生看，因为总有学生会把每个按钮都点一遍。
 *
 * ★ 打开后需要重启小程序才生效（切换时会 reLaunch）。
 */
const MULTI_ACCOUNT_KEY = 'ctb_multi_account'

/** 当前是否开启了多账号测试功能 */
function isMultiAccountOn() {
  try {
    return wx.getStorageSync(MULTI_ACCOUNT_KEY) === true
  } catch (e) {
    return false
  }
}

/** 开启 / 关闭（调用方负责校验调试员身份） */
function setMultiAccount(on) {
  try {
    if (on) wx.setStorageSync(MULTI_ACCOUNT_KEY, true)
    else wx.removeStorageSync(MULTI_ACCOUNT_KEY)
  } catch (e) { /* 存储失败则维持现状 */ }
}

module.exports = {
  envId: ENV_ID,
  isMock,
  isDebugOn,
  setDebugMode,
  DEBUG_KEY,
  isMultiAccountOn,
  setMultiAccount,
  MULTI_ACCOUNT_KEY,
  /**
   * 当前是否处于调试模式。
   *
   * ★ 必须是 getter，不能写成静态值。
   *   调试模式可以在运行时开关（结果存本地存储），写成静态值就会变成
   *   「编译期快照」—— 于是出现最迷惑的一类 bug：
   *   **开关打开了，页面却仍然认为自己连着真实云环境**。
   *
   *   这个陷阱已经真实发生过两次：
   *     · about 页的模式提示条永远显示「已接入云开发环境」
   *     · publish 页在调试模式下仍去调真实云存储上传（必然失败）
   *
   *   现在 envList.MOCK 与 app.globalData.MOCK 语义一致，两种写法都对。
   */
  get MOCK() {
    return isMock()
  },
  SUBSCRIBE_TEMPLATES,
  QQMAP_KEY,

  /** 开发期调试日志开关 */
  DEBUG: true,

  /** 云函数调用超时（毫秒） */
  TIMEOUT: 15000,

  /** 默认分页大小 */
  PAGE_SIZE: 10,

  /** 附近技能默认半径（米） —— 一个校园大约 1~2 公里 */
  NEAR_RADIUS: 3000,

  /** 后端服务端要求的最低下单信用分（与 config.minCreditToOrder 保持一致） */
  MIN_CREDIT: 60
}
