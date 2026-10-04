#!/usr/bin/env node
/**
 * 小程序端「交互流程测试」
 * ==================================================================
 * 与 tools/ui-smoke.js 的分工：
 *   ui-smoke.js  —— 「页面能不能活着打开」（31 个页面逐个 reLaunch）
 *   ui-flow.js   —— 「交互到底能不能用」（本文件，真实点击 / 输入 / 下单 / 取消）
 *
 * 覆盖 5 条业务主线 + 1 段清理，全部由 miniprogram-automator 真实驱动：
 *   ① 发布技能  ：填表 → 选分类/时间币 → 提交 → 断言进广场 + 我的发布
 *   ② 搜索      ：输入关键词 → 断言命中（含高亮切片）+ 负例（乱码词应为空）
 *   ③ 下单      ：技能详情 →「立即预约」→ 确认页 → 断言订单入列表 + 时间币冻结
 *   ④ 聊天      ：订单卡「联系 TA」→ 聊天室发消息 → 断言消息上屏 + 会话入列表
 *   ⑤ 取消订单  ：订单卡「取消订单」→ 断言状态 canceled + 冻结解冻
 *   ⑥ 时间币守恒：跑完整条链路后，可用余额与冻结额必须回到起始值
 *
 * 用法：
 *   1. 开发者工具里打开本项目
 *   2. 开发者工具 → 设置 → 安全设置 → 打开「服务端口」
 *   3. 项目根目录执行：  node tools/ui-flow.js
 *
 * 可用环境变量：
 *   WX_CLI                  开发者工具 cli.bat 路径
 *   WX_AUTO_PORT            自动化端口（默认 9420，**不是**安全设置里那个 HTTP 端口）
 *   WX_WS                   直接指定 ws 地址（默认 ws://127.0.0.1:<WX_AUTO_PORT>）
 *   FLOW                    只跑某一条流程（名字前缀匹配，如 FLOW=搜索），便于调脚本
 *   KEEP_DATA=1             跑完不清理（默认清理，见下）
 *
 * ★ 幂等：脚本自己造的数据自己收拾（取消订单 / 删除技能）。跑第二遍结果必须一致。
 * ★ 退出码：全部断言通过 = 0，只要有失败 = 1；失败会逐条打印「步骤 / 期望 / 实际」。
 *
 * ------------------------------------------------------------------
 * 三个必须照搬 / 踩过的坑（都已在真机复测过，别再走一遍弯路）
 * ------------------------------------------------------------------
 * 1) 端口：不要假设自动化端口是 9420。安全设置里显示的是 IDE 的 **HTTP** 端口
 *    （每次启动都变），自动化端口必须由 `cli auto --project <path> --auto-port <n>`
 *    显式指定 —— 下方 enableAutomation() / findCli() / connect() 与 ui-smoke.js 同一套。
 *
 * 2) 取页面数据用 `page.data()`。**不要**用 `page.evaluate(getCurrentPages())`：
 *    在小程序运行时里取不到当前页实例，实测恒为空。
 *
 * 3) 原生弹窗（wx.showModal）的确认：
 *    · `mp.native().confirmModal()` 在当前工具版本下**静默无效**（调用返回正常，
 *      弹窗不点，也不报错）—— 实测三次都没能推进流程，不要依赖它。
 *    · `mp.mockWxMethod('showModal', fn)`（函数形态）也**不行**：自动化协议不把
 *      success 回调传进 mock，实测 `typeof opts.success === 'undefined'`，页面
 *      永远等不到 resolve。
 *    · 可用的是**对象形态**：`mp.mockWxMethod('showModal', { confirm: true })`，
 *      工具会用它作为 success 回调的参数 → `util.confirm()` 一律返回 true。
 *    因此本脚本所有「确认类」弹窗都是自动确认的。
 *    （页面里出现过的 toast 文案会被 mock 捕获并打印，失败时可直接看到云函数报错文案。）
 *
 * 4) `element.tap()` 在「点击会触发页面重渲染」时可能**永远不返回**
 *    （例如删除后 resetAndLoad），所以统一走 tap() 包装：与超时赛跑，
 *    真假由**结果断言**判定，而不是由 tap 的返回判定。
 * ==================================================================
 */
'use strict'

const fs = require('fs')
const path = require('path')
const { spawn } = require('child_process')
const automator = require('miniprogram-automator')

const ROOT = path.resolve(__dirname, '..')
const PROJECT = ROOT

/** 自动化端口：优先环境变量 */
const PORT = Number(process.env.WX_AUTO_PORT || 9420)
const WS_ENDPOINT = process.env.WX_WS || `ws://127.0.0.1:${PORT}`
/** 只跑指定流程（名字前缀匹配） */
const ONLY = String(process.env.FLOW || '').trim()
/** 跑完不清理（默认清理） */
const KEEP_DATA = process.env.KEEP_DATA === '1'

const C = {
  r: '\x1b[0m', b: '\x1b[1m', dim: '\x1b[2m',
  red: '\x1b[31m', green: '\x1b[32m', yellow: '\x1b[33m', cyan: '\x1b[36m'
}

const TS = Date.now()
/** 本次测试造的数据统一带这个前缀，便于「自愈式」清理上一轮残留 */
const MARK = 'ui-flow-'
const SKILL_TITLE = `${MARK}${TS}`
const SKILL_DESC = '自动化交互流程测试写入的详情描述，用于验证发布链路能否落库。'
const SEARCH_MISS = `${MARK}none-${TS}`
const CHAT_MSG = `${MARK}msg-${TS}`

/* ------------------------------------------------------------------ */
/* 0. 基础设施（与 ui-smoke.js 同一套端口处理）                          */
/* ------------------------------------------------------------------ */
function sleep (ms) { return new Promise(r => setTimeout(r, ms)) }

/** 开发者工具 CLI 路径：优先环境变量，其次探测常见位置 */
function findCli () {
  if (process.env.WX_CLI && fs.existsSync(process.env.WX_CLI)) return process.env.WX_CLI
  const cands = [
    'D:\\3340\\Tencent\\微信web开发者工具\\cli.bat',
    'C:\\Program Files (x86)\\Tencent\\微信web开发者工具\\cli.bat',
    'C:\\Program Files\\Tencent\\微信web开发者工具\\cli.bat',
    process.env.LOCALAPPDATA ? path.join(process.env.LOCALAPPDATA, 'Programs', '微信web开发者工具', 'cli.bat') : ''
  ].filter(Boolean)
  return cands.find(p => fs.existsSync(p)) || ''
}

/** 调 cli auto 把自动化端口固定下来（前提：「安全设置 → 服务端口」已打开） */
function enableAutomation (cli) {
  return new Promise((resolve) => {
    let done = false
    const finish = () => { if (!done) { done = true; resolve() } }
    try {
      const cp = spawn('cmd.exe',
        ['/c', cli, 'auto', '--project', PROJECT, '--auto-port', String(PORT)],
        { stdio: 'ignore', windowsHide: true })
      cp.on('exit', finish)
      cp.on('error', finish)
      setTimeout(finish, 60000)          // 兜底，避免 CLI 不返回时卡死
    } catch (e) { finish() }
  })
}

async function connect () {
  // ① 直连：工具已开着且自动化端口就是 PORT 时最快
  try {
    const mp = await automator.connect({ wsEndpoint: WS_ENDPOINT })
    console.log(`${C.green}已连接到正在运行的开发者工具${C.r}  ${C.dim}${WS_ENDPOINT}${C.r}`)
    return mp
  } catch (e) {
    console.log(`${C.dim}直连 ${WS_ENDPOINT} 失败，改用 CLI 启用自动化…${C.r}`)
  }
  // ② 用 CLI 把自动化端口固定到 PORT
  const cli = findCli()
  if (!cli) {
    throw new Error(
      '找不到开发者工具的 cli.bat。请设置环境变量 WX_CLI 指向它，例如：\n' +
      '    $env:WX_CLI="D:\\...\\微信web开发者工具\\cli.bat"'
    )
  }
  await enableAutomation(cli)
  await sleep(2500)
  try {
    const mp = await automator.connect({ wsEndpoint: WS_ENDPOINT })
    console.log(`${C.green}已通过 CLI 启用自动化并连接${C.r}  ${C.dim}${WS_ENDPOINT}${C.r}`)
    return mp
  } catch (e) {
    throw new Error(
      `仍然连不上 ${WS_ENDPOINT}。\n\n` +
      '请确认两件事：\n' +
      '  ① 开发者工具里**正在打开本项目**（不是别的项目）；\n' +
      '  ② 「设置 → 安全设置 → 服务端口」已打开。\n\n' +
      `注意：安全设置里那个数字是 IDE 的 HTTP 端口，自动化端口由 ` +
      `cli auto --auto-port ${PORT} 指定；想换端口就设环境变量 WX_AUTO_PORT。`
    )
  }
}

/* ------------------------------------------------------------------ */
/* 1. 运行时状态：报错收集 / toast 捕获                                 */
/* ------------------------------------------------------------------ */
const state = {
  current: '(init)',
  toasts: [],          // 页面里所有 wx.showToast 的 title（含成功/失败提示）
  exceptions: [],      // 未捕获异常
  consoleErrors: [],   // console.error（已剔除 routeDone 噪音）
  noisy: 0             // 「routeDone with a webviewId」噪音计数
}

function installHooks (mp) {
  mp.on('exception', (err) => {
    state.exceptions.push({ flow: state.current, text: String((err && (err.message || err.stack)) || JSON.stringify(err)) })
  })
  mp.on('console', (msg) => {
    if (!msg || msg.type !== 'error') return
    const text = (msg.args || []).map(a => (typeof a === 'string' ? a : JSON.stringify(a))).join(' ')
    // 已知噪音：自动化快速切页时框架会对已切走的页面回调 routeDone。
    // 只过滤这一条固定文案，其余 console.error 一律照报（不掩盖真问题）。
    if (/routeDone with a webviewId/.test(text)) { state.noisy++; return }
    state.consoleErrors.push({ flow: state.current, text })
  })
}

/** toast 捕获：mockWxMethod 的函数形态拿不到回调，但「被调用」这件事本身可观测 */
async function installToastCapture (mp) {
  await mp.exposeFunction('dshFlowReport', (text) => { state.toasts.push(String(text)); return 'ok' })
  await mp.mockWxMethod('showToast', function (opts) {
    try { dshFlowReport(String((opts && opts.title) || '')) } catch (e) { /* 忽略 */ }
  })
  // 确认类弹窗：对象形态 → 工具把它当 success 参数传入 → util.confirm 恒为 true
  await mp.mockWxMethod('showModal', { confirm: true, cancel: false })
}

/* ------------------------------------------------------------------ */
/* 2. 页面工具                                                          */
/* ------------------------------------------------------------------ */
/**
 * reLaunch 到指定页面，并等它**真正成为当前页**后再返回句柄。
 *
 * ★ 不能只睡固定时长：`mp.reLaunch()` 返回的 Page 句柄可能是**切换前的页面**，
 *   而固定 sleep 也不保证目标页已就绪 —— 于是 `page.data()` 会读回上一页的数据。
 *   实测后果：「新技能出现在我的发布」这条断言间歇性失败，读到的却是
 *   「技能广场」的 10 条全量技能（同一个人跑 3 次全过、Lead 复跑就挂）。
 *   这里轮询 `currentPage().path` 直到吻合，再取句柄。
 */
async function goto (mp, url, wait) {
  const path = String(url).split('?')[0].replace(/^\//, '')
  await mp.reLaunch(url)
  await sleep(wait || 2400)
  const t0 = Date.now()
  let page = null
  while (Date.now() - t0 < 8000) {
    try {
      const cur = await mp.currentPage()
      if (cur && cur.path === path) { page = cur; break }
    } catch (e) { /* 切页瞬间可能取不到，继续轮询 */ }
    await sleep(250)
  }
  if (!page) page = await mp.currentPage()
  await sleep(400)          // 路径吻合后再给异步云查询一点时间
  return page
}

async function currentPath (mp) {
  try { const p = await mp.currentPage(); return p ? p.path : '' } catch (e) { return '' }
}

/** 等某个页面成为当前页（tap 之后的路由跳转是异步的） */
async function waitPath (mp, expect, timeout) {
  const t0 = Date.now()
  const limit = timeout || 8000
  while (Date.now() - t0 < limit) {
    const p = await currentPath(mp)
    if (p === expect) { await sleep(600); try { return await mp.currentPage() } catch (e) { return null } }
    await sleep(300)
  }
  return null
}

/** 等 toast 出现（轮询本地捕获数组） */
async function waitToast (text, timeout) {
  const t0 = Date.now()
  const limit = timeout || 8000
  while (Date.now() - t0 < limit) {
    if (state.toasts.some(t => String(t).indexOf(text) >= 0)) return true
    await sleep(250)
  }
  return false
}

/**
 * tap 包装：点击可能触发重渲染，automator 的 tap 会因此**永远不返回**。
 * 与超时赛跑，成败交给后续断言判定。
 */
async function tap (el, ms) {
  if (!el) return { ok: false, how: 'element=null' }
  try {
    await Promise.race([
      el.tap(),
      sleep(ms || 4000).then(() => { throw new Error('tap 超时未返回') })
    ])
    return { ok: true, how: 'tap' }
  } catch (e) {
    return { ok: false, how: 'tap: ' + String(e && e.message).slice(0, 40) }
  }
}

/** 页面上实际存在的选择器命中数（选择器找不到时用来定位问题，不猜） */
async function probeSelectors (page, candidates) {
  const out = []
  for (const c of candidates) {
    let n = -1
    try { n = (await page.$$(c)).length } catch (e) { n = -1 }
    out.push(`${c}=${n}`)
  }
  return out.join('  ')
}

/** 转储页面真实类名：选择器找不到时打印出来，据此改选择器而不是瞎猜 */
async function dumpClasses (page) {
  try {
    const root = (await page.$('.page')) || (await page.$('view'))
    if (!root) return '(页面没有 .page / view 根节点)'
    let wxml = ''
    try { wxml = await root.outerWxml() } catch (e) { /* 某些工具版本没有 outerWxml */ }
    if (!wxml || String(wxml).length < 40) {
      try { wxml = await root.wxml() } catch (e) { /* 忽略 */ }
    }
    const set = new Set()
    const re = /class="([^"]*)"/g
    let m
    while ((m = re.exec(String(wxml))) !== null) {
      m[1].split(/\s+/).forEach(c => { if (c) set.add(c) })
    }
    const arr = Array.from(set).sort()
    if (!arr.length) return '(未从 wxml 取到 class，片段：' + String(wxml).slice(0, 160) + ')'
    return arr.slice(0, 60).join(' ')
  } catch (e) {
    return '(类名转储失败: ' + String(e.message).slice(0, 80) + ')'
  }
}

/** 在页面里按「组件 data.item」找到某张卡片（order-card / skill-card 通用） */
async function findCard (page, cardSelector, predicate) {
  const cards = await page.$$(cardSelector)
  for (const c of cards) {
    let d = null
    try { d = await c.data() } catch (e) { /* 忽略 */ }
    const item = d && d.item
    if (item && predicate(item)) return { el: c, item: item }
  }
  return null
}

/** 卡片内的操作按钮：按文案找（比按颜色 class 稳） */
async function cardButton (card, text, scopeSelector) {
  const scope = scopeSelector || '.oc__actions .btn'
  let btns = []
  try { btns = await card.$$(scope) } catch (e) { btns = [] }
  for (const b of btns) {
    let t = ''
    try { t = String(await b.text()).trim() } catch (e) { t = '' }
    if (t === text) return b
  }
  return null
}

/* ------------------------------------------------------------------ */
/* 3. 数据读取（一律走页面 data，不直接查库）                            */
/* ------------------------------------------------------------------ */
async function readMe (mp) {
  const p = await goto(mp, '/pages/mine/mine', 2200)
  const d = await p.data()
  const u = d.user || d.userInfo || {}
  return { openid: u._openid || '', nickName: u.nickName || '', coins: Number(u.coins) || 0, frozenCoins: Number(u.frozenCoins) || 0, creditScore: u.creditScore }
}

async function readWallet (mp) {
  const p = await goto(mp, '/pages/wallet/wallet', 2000)
  const d = await p.data()
  return { coins: Number(d.coins) || 0, frozen: Number(d.frozenCoins) || 0 }
}

async function readOrders (mp) {
  const p = await goto(mp, '/pages/order/list/list', 2400)
  const d = await p.data()
  return { page: p, list: d.list || [], counts: d.counts || {} }
}

async function readMySkills (mp) {
  // 轮询直到拿到非空列表：云查询是异步的，单次读取可能拿到空 list。
  // （演示账号必然已有已发布技能，所以「等非空」在这里是安全判据；
  //   若列表为空是合法状态，请勿直接照抄这个写法。）
  const p = await goto(mp, '/pages/user/skills/skills?type=publish', 2400)
  for (let i = 0; i < 6; i++) {
    const d = await p.data()
    const list = d.list || []
    if (list.length) return { page: p, list }
    await sleep(500)
  }
  const d = await p.data().catch(() => ({}))
  return { page: p, list: (d && d.list) || [] }
}

/* ------------------------------------------------------------------ */
/* 4. 流程骨架                                                          */
/* ------------------------------------------------------------------ */
class Flow {
  constructor (name) {
    this.name = name
    this.checks = []
    this.notes = []
    this.skipped = ''
  }

  /** 断言：失败时同时给出「期望」与「实际」，这是排查的唯一线索 */
  assert (cond, desc, expected, actual) {
    this.checks.push({
      ok: !!cond,
      desc: desc,
      exp: expected === undefined ? '' : String(expected),
      act: actual === undefined ? '' : String(actual)
    })
    return !!cond
  }

  /** 找不到元素：不要猜，打印页面真实类名 */
  async miss (desc, page, candidates) {
    const probes = page ? await probeSelectors(page, candidates || []) : '(无页面句柄)'
    const classes = page ? await dumpClasses(page) : ''
    this.checks.push({
      ok: false,
      desc: desc + '（元素未找到）',
      exp: '元素存在',
      act: `候选选择器命中：${probes}\n        页面真实类名：${classes}`
    })
    return false
  }

  note (text) { this.notes.push(text) }

  get failed () { return this.checks.filter(c => !c.ok) }
  get passed () { return this.checks.length - this.failed.length }
}

const results = []
const ctx = { mp: null, me: null, baseline: null, shared: {} }

async function runFlow (name, fn) {
  if (ONLY && name.indexOf(ONLY) !== 0) return null
  const f = new Flow(name)
  state.current = name
  const exBefore = state.exceptions.length
  const ceBefore = state.consoleErrors.length
  console.log(`\n${C.b}${C.cyan}▶ ${name}${C.r}`)
  try {
    await fn(f)
  } catch (e) {
    f.assert(false, '流程未捕获异常', '流程正常执行完', String((e && e.message) || e).split('\n')[0])
  }
  // 归因：本流程期间冒出的未捕获异常 / console.error
  for (const ex of state.exceptions.slice(exBefore)) {
    f.assert(false, '流程期间无未捕获异常', '0 个异常', ex.text.slice(0, 200))
  }
  for (const ce of state.consoleErrors.slice(ceBefore)) {
    f.assert(false, '流程期间无 console.error', '0 条报错', ce.text.slice(0, 200))
  }
  // 即时打印
  for (const c of f.checks) {
    if (c.ok) console.log(`  ${C.green}✓${C.r} ${c.desc}  ${C.dim}期望 ${c.exp}｜实际 ${c.act}${C.r}`)
    else {
      console.log(`  ${C.red}✗${C.r} ${c.desc}`)
      console.log(`      ${C.red}期望：${c.exp}${C.r}`)
      console.log(`      ${C.red}实际：${String(c.act).split('\n').join('\n      ')}${C.r}`)
    }
  }
  for (const n of f.notes) console.log(`  ${C.yellow}※ ${n}${C.r}`)
  if (!f.checks.length && !f.skipped) f.assert(false, '流程至少产生 1 条断言', '>0', '0')
  results.push(f)
  return f
}

/** 跳过（前置条件没满足，如订单没造出来）——不算失败，但要在报告里说清楚 */
function skipFlow (name, reason) {
  if (ONLY && name.indexOf(ONLY) !== 0) return null
  const f = new Flow(name)
  f.skipped = reason
  console.log(`\n${C.b}${C.cyan}▶ ${name}${C.r}\n  ${C.yellow}⊘ 跳过：${reason}${C.r}`)
  results.push(f)
  return f
}

/* ------------------------------------------------------------------ */
/* 5. 各流程实现                                                        */
/* ------------------------------------------------------------------ */

/* ---------- ① 发布技能 ---------- */
async function flowPublish (f) {
  const mp = ctx.mp
  const page = await goto(mp, '/pages/publish/publish', 2400)
  let d = await page.data()
  if (!(d.categoryNames || []).length) { await sleep(1500); d = await page.data() }
  f.assert((d.categoryNames || []).length > 0, '发布页分类已加载',
    '>0 个分类', `${(d.categoryNames || []).length} 个：${JSON.stringify((d.categoryNames || []).slice(0, 3))}`)

  const titleInput = await page.$('.form-item__input--left')
  if (!titleInput) {
    await f.miss('标题输入框 .form-item__input--left', page, ['.form-item__input', 'input', '.form-item__input--left'])
    return
  }
  await titleInput.input(SKILL_TITLE)
  await sleep(250)

  const pickers = await page.$$('picker')
  f.assert(pickers.length === 3, '发布表单有 3 个 picker（分类 / 时间币 / 时长）', 3, pickers.length)
  if (pickers.length < 2) {
    await f.miss('分类 / 时间币 picker', page, ['picker', '.form-item'])
    return
  }
  // 原生 picker 的滚轮没法用选择器点，用 trigger 直接派发 change（等价于用户选完确定）
  await pickers[0].trigger('change', { value: 2 })
  await sleep(250)
  await pickers[1].trigger('change', { value: 0 })
  await sleep(250)

  const descInput = await page.$('.form-textarea')
  if (!descInput) {
    await f.miss('详情输入框 .form-textarea', page, ['.form-textarea', 'textarea'])
    return
  }
  await descInput.input(SKILL_DESC)
  await sleep(300)

  d = await page.data()
  f.assert(d.title === SKILL_TITLE, '标题写入成功', SKILL_TITLE, d.title)
  f.assert(!!d.categoryId, '分类已选中', '非空 categoryId',
    `${d.categoryId}（${(d.categoryNames || [])[d.categoryIndex] || '-'}）`)
  f.assert(Number(d.prices[d.priceIndex]) === 1, '时间币选择=1（picker 第 1 项）', 1, d.prices[d.priceIndex])
  f.assert(d.desc === SKILL_DESC && d.desc.length >= 10, '详情写入且满足 ≥10 字校验', `长度≥10`, `长度 ${d.desc.length}`)

  /* ---------- ★ 选服务地点 ----------
   * 新安全策略：必须选**校内**地点才能发布（云端 skill.create 也会拦）。
   * 这里走真实流程：点「地点」行 → 进地图选点页 → 点第一个校内快捷按钮 → 确认。 */
  const locRows = await page.$$('.form-item')
  let locRow = null
  for (const r of locRows) {
    try { const tx = await r.text(); if (tx && tx.indexOf('地点') > -1) { locRow = r; break } } catch (e) { /* 忽略 */ }
  }
  if (!locRow) {
    await f.miss('「地点」选择行 .form-item', page, ['.form-item'])
    return
  }
  await tap(locRow)
  await sleep(1600)

  const picker = await waitPath(mp, 'pages/map/picker/picker', 8000)
  if (!picker) {
    await f.miss('地图选点页 pages/map/picker/picker', page, ['.spots__chip'])
    return
  }
  const chips = await picker.$$('.spots__chip')
  f.assert(chips.length > 0, '★ 地图选点页渲染出校内常用地点按钮', '>0', String(chips.length))
  if (!chips.length) return

  await tap(chips[0])                       // 第一个是「山下饭堂」
  await sleep(700)
  const pd = await picker.data()
  f.assert(!!pd.picked && !!pd.picked.name, '选中校内地点后有中文名', '非空 name', (pd.picked || {}).name)
  f.assert((pd.markers || []).length > 0, '地图上落下了标记（marker）', '1 个', String((pd.markers || []).length))

  const confirmBtn = await picker.$('.picker-card__actions .btn--primary')
  if (!confirmBtn) {
    await f.miss('选点确认按钮', picker, ['.picker-card__actions .btn--primary'])
    return
  }
  await tap(confirmBtn)
  await sleep(1600)

  const back = await waitPath(mp, 'pages/publish/publish', 8000)
  const pubPage = back || page
  const pd2 = await pubPage.data()
  f.assert(!!pd2.locationName, '★ 地点回填到发布页', '非空 locationName', pd2.locationName)

  const submit = await pubPage.$('.footer-bar__btn')
  if (!submit) {
    await f.miss('提交按钮 .footer-bar__btn', page, ['.footer-bar__btn', '.footer-bar .btn'])
    return
  }
  await tap(submit)
  const toasted = await waitToast('发布成功', 9000)
  f.assert(toasted, '提交后出现「发布成功」提示（确认弹窗已自动确认）', 'toast=发布成功',
    JSON.stringify(state.toasts.slice(-3)))

  // 广场：发布成功后 emit('skillChange') → 广场自动刷新；这里重新进入取一次。
  // ★ 轮询直到新技能出现或超时：列表数据是异步查询来的，**可能晚于写入**，
  //   单次读会间歇性拿不到（实测 7 次复跑里失败 3 次，失败点就是这里）。
  let sq = await goto(mp, '/pages/square/square', 2800)
  let sd = await sq.data()
  let sqList = sd.list || []
  let inSquare = sqList.some(x => x.title === SKILL_TITLE)
  for (let i = 0; i < 6 && !inSquare; i++) {
    await sleep(800)
    sq = await goto(mp, '/pages/square/square', 1200)
    sd = await sq.data()
    sqList = sd.list || []
    inSquare = sqList.some(x => x.title === SKILL_TITLE)
  }
  f.assert(inSquare, '新技能出现在「技能广场」列表', SKILL_TITLE,
    JSON.stringify(sqList.slice(0, 3).map(x => x.title)))

  // 我的发布（同样轮询到出现为止）
  let mine = await readMySkills(mp)
  let hit = mine.list.find(x => x.title === SKILL_TITLE)
  for (let i = 0; i < 6 && !hit; i++) {
    await sleep(800)
    mine = await readMySkills(mp)
    hit = mine.list.find(x => x.title === SKILL_TITLE)
  }
  f.assert(!!hit, '新技能出现在「我的发布」列表', SKILL_TITLE, JSON.stringify(mine.list.map(x => x.title)))
  if (hit) {
    f.assert(hit.status === 1, '新技能状态=上架中', '1（上架中）', `${hit.status}（${hit.statusText}）`)
  }
  ctx.shared.publishedSkillId = hit ? hit._id : ''
}

/* ---------- ② 搜索 ---------- */
async function flowSearch (f) {
  const mp = ctx.mp
  const page = await goto(mp, '/pages/search/search', 1800)
  const input = await page.$('.search-box__input')
  if (!input) {
    await f.miss('搜索输入框 .search-box__input', page, ['.search-box__input', 'input', '.search-box'])
    return
  }
  await input.input(SKILL_TITLE)
  // 输入框有 400ms 防抖，等它真的发请求
  let d = null
  for (let i = 0; i < 12; i++) {
    await sleep(400)
    d = await page.data()
    if (d.searched && !d.searching) break
  }
  f.assert(!!d.searched, '输入关键词后触发搜索（searched=true）', 'true', `${d.searched}`)

  const list = d.list || []
  f.assert(list.length > 0, '搜索结果非空', '≥1 条', `${list.length} 条（total=${d.total}）`)
  const hit = list.find(x => x.title === SKILL_TITLE)
  f.assert(!!hit, '结果里能找到刚发布的技能', SKILL_TITLE, JSON.stringify(list.map(x => x.title).slice(0, 5)))
  if (hit) {
    const parts = hit.titleParts || []
    f.assert(parts.some(p => p.hit), '命中关键词被切成高亮片段（titleParts.hit）', '至少 1 段 hit=true',
      JSON.stringify(parts.map(p => (p.hit ? '[' + p.t + ']' : p.t))))
  }

  // 负例：乱码关键词应为空态
  const clear = await page.$('.search-box__clear')
  if (clear) { await tap(clear); await sleep(400) }
  const input2 = await page.$('.search-box__input')
  await input2.input(SEARCH_MISS)
  let d2 = null
  for (let i = 0; i < 12; i++) {
    await sleep(400)
    d2 = await page.data()
    if (d2.searched && !d2.searching && d2.keyword === SEARCH_MISS) break
  }
  f.assert((d2.list || []).length === 0, '负例：不存在的关键词返回空列表', '0 条', `${(d2.list || []).length} 条`)
}

/* ---------- ③ 下单 ---------- */
async function flowOrder (f) {
  const mp = ctx.mp
  const sq = await goto(mp, '/pages/square/square', 2800)
  const sd = await sq.data()
  const me = ctx.me
  const coins0 = ctx.baseline.coins
  const frozen0 = ctx.baseline.frozen

  const candidates = (sd.list || [])
    .filter(x => x && x.status === 1 && x.authorId !== me.openid && Number(x.price) <= coins0)
    .sort((a, b) => Number(a.price) - Number(b.price))
  f.assert(candidates.length > 0, '广场上存在「非本人、上架中、价格≤余额」的可下单技能',
    `≥1 条（余额 ${coins0}）`, candidates.length)
  if (!candidates.length) return
  const skill = candidates[0]
  const price = Number(skill.price)

  const dp = await goto(mp, `/pages/skill/detail/detail?id=${encodeURIComponent(skill._id)}`, 2600)
  const dd = await dp.data()
  f.assert(dd.isOwner === false, '技能详情页判定为「非本人」（能看到预约入口）', false, dd.isOwner)
  f.assert(Number((dd.skill || {}).price) === price, '详情页价格与列表一致', price, (dd.skill || {}).price)

  const book = await dp.$('.footer-bar .btn--primary')
  if (!book) {
    await f.miss('「立即预约」按钮 .footer-bar .btn--primary', dp,
      ['.footer-bar .btn--primary', '.footer-bar .btn', '.btn--primary'])
    return
  }
  f.assert(String(await book.text()).trim() === '立即预约', '详情页按钮文案=「立即预约」', '立即预约', String(await book.text()).trim())
  await tap(book)

  const cp = await waitPath(mp, 'pages/order/create/create', 9000)
  f.assert(!!cp, '点「立即预约」后进入下单确认页（资历/认证守卫已通过）',
    'pages/order/create/create', await currentPath(mp))
  if (!cp) return
  const cd = await cp.data()
  f.assert(Number(cd.amount) === price, '确认页服务费用=技能价格', price, cd.amount)
  f.assert(cd.enough === true, '确认页判定余额充足', true, `enough=${cd.enough}（余额 ${cd.coins}，下单后 ${cd.balanceAfter}）`)
  f.assert(Number(cd.coins) === coins0, '确认页「当前余额」=下单前钱包余额', coins0, cd.coins)

  const submit = await cp.$('.footer-bar__btn')
  if (!submit) {
    await f.miss('下单提交按钮 .footer-bar__btn', cp, ['.footer-bar__btn', '.footer-bar .btn'])
    return
  }
  await tap(submit)
  const toasted = await waitToast('下单成功', 9000)
  f.assert(toasted, '提交后出现「下单成功」提示', 'toast=下单成功', JSON.stringify(state.toasts.slice(-3)))

  // 订单列表
  const orders = await readOrders(mp)
  const before = ctx.baseline.orderIds || []
  const fresh = orders.list.filter(o => before.indexOf(o._id) < 0)
  const order = fresh.find(o => ((o.skillSnapshot || {}).title === skill.title)) || fresh[0]
  f.assert(!!order, '新订单出现在「订单列表」', `skill=${skill.title}`, JSON.stringify(orders.list.map(o => (o.skillSnapshot || {}).title).slice(0, 5)))
  if (order) {
    f.assert(order.status === 'waiting', '新订单状态=待接单', 'waiting', order.status)
    f.assert(Number(order.amount) === price, '订单冻结金额=技能价格', price, order.amount)
    ctx.shared.orderId = order._id
    ctx.shared.orderSkillTitle = skill.title
    ctx.shared.orderSkillId = skill._id
    ctx.shared.cleanupOrderNeeded = true
  }

  // 冻结生效（可用余额 -price，冻结 +price）
  const w = await readWallet(mp)
  f.assert(w.coins === coins0 - price, '下单后可用余额 = 下单前 - 价格', coins0 - price, w.coins)
  f.assert(w.frozen === frozen0 + price, '下单后冻结时间币 = 下单前 + 价格', frozen0 + price, w.frozen)
}

/* ---------- ④ 聊天 ---------- */
async function flowChat (f) {
  const mp = ctx.mp
  const orderId = ctx.shared.orderId
  if (!orderId) return f.assert(false, '前置：存在一笔可聊天的订单', '有 orderId', '无（下单流程未产出订单）')

  // 先记录一个事实：技能详情页**没有**「联系 TA」入口
  const noteSkillId = ctx.shared.orderSkillId || ''
  const dp = noteSkillId
    ? await goto(mp, `/pages/skill/detail/detail?id=${encodeURIComponent(noteSkillId)}`, 2200).catch(() => null)
    : null
  if (dp) {
    const foot = await dp.$$('.footer-bar .btn')
    const texts = []
    for (const b of foot) { try { texts.push(String(await b.text()).trim()) } catch (e) {} }
    if (!texts.some(t => t.indexOf('联系') >= 0)) {
      f.note(`技能详情页底部按钮实际为 ${JSON.stringify(texts)}，没有「联系 TA」入口；` +
        '但 chat/list 的空态文案写着「在技能详情页点「联系 TA」开始聊天」——文案与实现不一致。' +
        '本次聊天改用订单卡上的「联系 TA」（actChat）进入。')
    }
  }

  const orders = await readOrders(mp)
  const card = await findCard(orders.page, 'order-card', it => it._id === orderId)
  if (!card) {
    await f.miss(`订单卡（orderId=${orderId}）`, orders.page, ['.oc', 'order-card'])
    return
  }
  const chatBtn = await cardButton(card.el, '联系 TA')
  if (!chatBtn) {
    const names = []
    for (const b of await card.el.$$('.oc__actions .btn')) { try { names.push(String(await b.text()).trim()) } catch (e) {} }
    f.assert(false, '订单卡上有「联系 TA」按钮', '联系 TA', JSON.stringify(names))
    return
  }
  await tap(chatBtn, 6000)
  const room = await waitPath(mp, 'pages/chat/room/room', 9000)
  f.assert(!!room, '点「联系 TA」进入聊天室', 'pages/chat/room/room', await currentPath(mp))
  if (!room) return

  let rd = await room.data()
  f.assert(!!rd.chatId, '聊天室拿到 chatId（openChat 成功）', '非空 chatId', rd.chatId)
  const msgCount0 = (rd.messages || []).length

  const input = await room.$('.input-bar__input')
  const send = await room.$('.input-bar__send')
  if (!input || !send) {
    await f.miss('聊天输入框 / 发送按钮', room, ['.input-bar__input', '.input-bar__send', '.input-bar'])
    return
  }
  await input.input(CHAT_MSG)
  await sleep(300)
  await tap(send)
  // 真实环境有 watch 推送，MOCK 是 2 秒轮询；都给足 12 秒
  let found = null
  for (let i = 0; i < 24; i++) {
    await sleep(500)
    rd = await room.data()
    found = (rd.messages || []).find(m => m.content === CHAT_MSG)
    if (found) break
  }
  f.assert(!!found, '发出的消息出现在会话消息列表里', CHAT_MSG,
    JSON.stringify((rd.messages || []).slice(-3).map(m => m.content)))
  if (found) f.assert(found.isMine === true, '该消息归属「我」（isMine=true）', true, found.isMine)
  f.assert((rd.messages || []).length > msgCount0, '消息条数增加', `>${msgCount0}`, (rd.messages || []).length)

  // 会话列表也要能看到
  const cl = await goto(mp, '/pages/chat/list/list', 2400)
  const cd = await cl.data()
  const conv = (cd.list || []).find(c => c._id === rd.chatId)
  f.assert(!!conv, '会话出现在「消息」列表', `chatId=${rd.chatId}`,
    JSON.stringify((cd.list || []).map(c => c._id).slice(0, 5)))
  f.note('聊天消息无法通过 UI 删除（产品未提供删除消息能力），是本脚本唯一无法回收的残留数据。')
}

/* ---------- ⑤ 取消订单 ---------- */
async function flowCancel (f) {
  const mp = ctx.mp
  const orderId = ctx.shared.orderId
  if (!orderId) return f.assert(false, '前置：存在待取消的订单', '有 orderId', '无（下单流程未产出订单）')

  const orders = await readOrders(mp)
  const card = await findCard(orders.page, 'order-card', it => it._id === orderId)
  if (!card) {
    await f.miss(`订单卡（orderId=${orderId}）`, orders.page, ['.oc', 'order-card'])
    return
  }
  const cancelBtn = await cardButton(card.el, '取消订单')
  if (!cancelBtn) {
    const names = []
    for (const b of await card.el.$$('.oc__actions .btn')) { try { names.push(String(await b.text()).trim()) } catch (e) {} }
    f.assert(false, '待接单订单卡上有「取消订单」按钮', '取消订单', JSON.stringify(names))
    return
  }
  await tap(cancelBtn, 6000)
  f.assert(await waitToast('订单已取消', 9000), '取消后出现「订单已取消」提示', 'toast=订单已取消',
    JSON.stringify(state.toasts.slice(-3)))

  const after = await readOrders(mp)
  const o = after.list.find(x => x._id === orderId)
  f.assert(!!o, '取消后订单仍在订单列表（历史可查）', orderId, JSON.stringify(after.list.map(x => x._id).slice(0, 5)))
  if (o) f.assert(o.status === 'canceled', '订单状态变为「已取消」', 'canceled', o.status)

  const w = await readWallet(mp)
  f.assert(w.coins === ctx.baseline.coins, '取消后可用余额已解冻回下单前',
    ctx.baseline.coins, w.coins)
  f.assert(w.frozen === ctx.baseline.frozen, '取消后冻结时间为 0（不再占用）',
    ctx.baseline.frozen, w.frozen)
  if (o && o.status === 'canceled') ctx.shared.cleanupOrderNeeded = false
}

/* ---------- ⑥ 时间币守恒 ---------- */
async function flowConservation (f) {
  const mp = ctx.mp
  const w = await readWallet(mp)
  f.assert(w.coins === ctx.baseline.coins, '全流程跑完后可用余额与开始时一致（守恒）',
    ctx.baseline.coins, w.coins)
  f.assert(w.frozen === ctx.baseline.frozen, '全流程跑完后冻结额与开始时一致（下单冻结 + 取消解冻可逆）',
    ctx.baseline.frozen, w.frozen)
  const me = await readMe(mp)
  f.assert(me.coins === ctx.baseline.coins, '个人中心显示的余额同样守恒（与钱包页一致）',
    ctx.baseline.coins, me.coins)
}

/* ---------- ⑦ 数据清理（幂等） ---------- */
async function flowCleanup (f) {
  const mp = ctx.mp
  // 仍未取消的订单兜底取消
  if (ctx.shared.cleanupOrderNeeded && ctx.shared.orderId) {
    const orders = await readOrders(mp)
    const card = await findCard(orders.page, 'order-card', it => it._id === ctx.shared.orderId)
    const btn = card ? await cardButton(card.el, '取消订单') : null
    if (btn) { await tap(btn, 6000); await waitToast('订单已取消', 8000) }
  }

  // 删除本轮发布的技能
  if (!KEEP_DATA) {
    const mine0 = await readMySkills(mp)
    const existed = mine0.list.some(x => x.title === SKILL_TITLE)
    if (existed) {
      const removed = await deleteSkillByTitle(SKILL_TITLE)
      f.assert(removed, '测试技能已删除（我的发布 → 删除按钮）', `删除 ${SKILL_TITLE}`, removed ? '已删除' : '未删除')
    } else {
      f.note(`本轮没有产生测试技能「${SKILL_TITLE}」（发布流程未成功），无需删除`)
    }
    const mine = await readMySkills(mp)
    f.assert(!mine.list.some(x => x.title === SKILL_TITLE), '「我的发布」中不再有测试技能',
      '不含 ' + SKILL_TITLE, JSON.stringify(mine.list.map(x => x.title)))
    const sq = await goto(mp, '/pages/square/square', 2800)
    const sd = await sq.data()
    f.assert(!(sd.list || []).some(x => x.title === SKILL_TITLE), '「技能广场」中不再有测试技能',
      '不含 ' + SKILL_TITLE, JSON.stringify((sd.list || []).map(x => x.title).slice(0, 5)))
  } else {
    f.note('KEEP_DATA=1：跳过数据清理')
  }
}

/** 在我的发布里按标题找到技能并点「删除」（幂等核心） */
async function deleteSkillByTitle (title) {
  const mp = ctx.mp
  const mine = await readMySkills(mp)
  const idx = mine.list.findIndex(x => x.title === title)
  if (idx < 0) return false
  const items = await mine.page.$$('.list-item')
  if (!items[idx]) return false
  const del = await items[idx].$('.ops .btn--ghost')
  if (!del) return false
  await tap(del, 6000)
  await sleep(2600)
  return true
}

/** 启动时自愈：把上一轮（或调试期）残留的 ui-flow-* 技能删掉，保证幂等 */
async function cleanupLeftovers () {
  try {
    const mine = await readMySkills(ctx.mp)
    const left = mine.list.filter(x => String(x.title).indexOf(MARK) === 0)
    const names = []
    for (const s of left) {
      names.push(s.title)
      await deleteSkillByTitle(s.title)
    }
    if (names.length) {
      console.log(`${C.yellow}启动自愈：清理了 ${names.length} 条历史残留测试技能 ${JSON.stringify(names)}${C.r}`)
    } else {
      console.log(`${C.dim}启动自愈：没有历史残留的 ${MARK}* 技能${C.r}`)
    }
  } catch (e) {
    console.log(`${C.yellow}启动自愈失败（不影响后续流程）：${String(e.message).slice(0, 100)}${C.r}`)
  }
}

/* ------------------------------------------------------------------ */
/* 6. 主流程                                                            */
/* ------------------------------------------------------------------ */
const ALL_FLOWS = [
  ['发布技能', flowPublish],
  ['搜索关键词', flowSearch],
  ['下单冻结', flowOrder],
  ['聊天发消息', flowChat],
  ['取消订单解冻', flowCancel],
  ['时间币守恒', flowConservation],
  ['数据清理（幂等）', flowCleanup]
]

async function main () {
  console.log(`\n${C.b}${C.cyan}小程序端交互流程测试${C.r}  ${C.dim}(tools/ui-flow.js)${C.r}`)
  console.log(`${C.dim}被测数据标记：技能「${SKILL_TITLE}」 消息「${CHAT_MSG}」${C.r}`)
  if (ONLY) console.log(`${C.yellow}FLOW=${ONLY}：只跑名字以此开头的流程${C.r}`)

  let mp
  try {
    mp = await connect()
  } catch (e) {
    console.error(`\n${C.red}${C.b}无法连接开发者工具${C.r}\n`)
    console.error(e.message)
    console.error(`\n${C.yellow}请确认：① 工具里正打开本项目；② 「设置 → 安全设置 → 服务端口」已打开。${C.r}\n`)
    process.exit(1)
  }
  ctx.mp = mp
  installHooks(mp)
  await installToastCapture(mp)

  // 基线：干净状态下的余额 / 订单集合
  ctx.me = await readMe(mp)
  ctx.baseline = { coins: ctx.me.coins, frozen: ctx.me.frozenCoins, orderIds: [] }
  const orders0 = await readOrders(mp)
  ctx.baseline.orderIds = orders0.list.map(o => o._id)
  console.log(`${C.dim}账号 ${ctx.me.nickName}(${ctx.me.openid})  可用 ${ctx.baseline.coins} 枚 / 冻结 ${ctx.baseline.frozen} 枚  ` +
    `已有订单 ${orders0.list.length} 笔${C.r}`)
  if (!ctx.me.openid) {
    console.log(`${C.red}读不到当前用户 openid（未登录？）——先手动打开一次小程序登录后再跑。${C.r}`)
    process.exit(1)
  }

  await cleanupLeftovers()

  for (const [name, fn] of ALL_FLOWS) {
    const f = await runFlow(name, fn)
    // 依赖链：下单失败 → 聊天/取消/守恒 无法进行，明确跳过而不是假装通过
    if (f && name === '下单冻结' && !ctx.shared.orderId) {
      skipFlow('聊天发消息', '下单流程未产出订单，无法驱动聊天入口')
      skipFlow('取消订单解冻', '下单流程未产出订单')
    }
  }

  /* ---- 汇总 ---- */
  console.log(`\n${'─'.repeat(66)}`)
  console.log(`${C.b}流程汇总${C.r}`)
  let totalChecks = 0
  let totalFail = 0
  for (const f of results) {
    totalChecks += f.checks.length
    totalFail += f.failed.length
    if (f.skipped) {
      console.log(`  ${C.yellow}⊘${C.r} ${f.name.padEnd(18)} ${C.dim}跳过：${f.skipped}${C.r}`)
      continue
    }
    const mark = f.failed.length ? `${C.red}✗${C.r}` : `${C.green}✓${C.r}`
    console.log(`  ${mark} ${f.name.padEnd(18)} ${C.dim}${f.passed}/${f.checks.length} 条断言${C.r}`)
  }
  const ranFlows = results.filter(f => !f.skipped).length
  const okFlows = results.filter(f => !f.skipped && !f.failed.length).length
  console.log(`${'─'.repeat(66)}`)
  console.log(`${C.b}流程 ${okFlows}/${ranFlows} 通过${C.r}   ` +
    `${C.b}断言 ${totalChecks - totalFail}/${totalChecks} 通过${C.r}` +
    (totalFail ? `   ${C.red}失败 ${totalFail}${C.r}` : `   ${C.green}全部通过${C.r}`))

  const notes = results.flatMap(f => f.notes.map(n => `${f.name}：${n}`))
  if (notes.length) {
    console.log(`\n${C.yellow}${C.b}发现 / 说明：${C.r}`)
    notes.forEach(n => console.log(`  ${C.yellow}※ ${n}${C.r}`))
  }
  if (state.noisy) {
    console.log(`\n${C.dim}（另有 ${state.noisy} 条「routeDone with a webviewId」已忽略：自动化快速切页的框架噪音）${C.r}`)
  }
  if (state.toasts.length) {
    console.log(`${C.dim}本次捕获到的 toast：${JSON.stringify(state.toasts)}${C.r}`)
  }

  if (totalFail) {
    console.log(`\n${C.red}${C.b}失败明细${C.r}`)
    for (const f of results) {
      for (const c of f.failed) console.log(`  ${C.red}✗${C.r} [${f.name}] ${c.desc}\n      期望：${c.exp}\n      实际：${String(c.act).split('\n')[0]}`)
    }
  }
  console.log('')
  process.exit(totalFail ? 1 : 0)
}

main().catch(e => {
  console.error(`\n${C.red}脚本异常：${C.r}`, (e && e.stack) || e)
  process.exit(1)
})
