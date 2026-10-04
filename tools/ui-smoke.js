/**
 * 小程序端「一键冒烟测试」
 * ==================================================================
 * 用微信官方自动化 SDK（miniprogram-automator）驱动**开发者工具**，
 * 自动逐个打开 app.json 里声明的全部页面，捕获：
 *   · 未捕获异常（exception 事件）
 *   · console.error 输出
 *   · 页面 data 为空（说明根本没渲染成功）
 *
 * 用法：
 *     1. 先在开发者工具里打开本项目
 *     2. 开发者工具 → 设置 → 安全设置 → 打开「服务端口」
 *     3. 项目根目录执行：  npm run test:ui
 *
 * 可用环境变量覆盖默认值：
 *     WX_CLI   开发者工具 cli.bat 路径
 *     WX_WS    已打开的工具的服务端口地址（默认 ws://127.0.0.1:9420）
 *     KEEP=1   测试结束后不关闭工具（默认也不关，方便你接着手动看）
 *
 * ★ 这个脚本测的是「页面能不能活着打开」，不测业务正确性。
 *   业务逻辑的正确性由另外两套脚本负责：
 *     npm run test:mock  （离线数据层 63 个接口）
 *     npm run test:cf    （云函数 343 条断言）
 * ==================================================================
 */
const fs = require('fs')
const path = require('path')
const { spawn } = require('child_process')
const automator = require('miniprogram-automator')

const ROOT = path.resolve(__dirname, '..')
const PROJECT = ROOT

/** 开发者工具 CLI 路径：优先环境变量，其次探测常见位置 */
function findCli() {
  if (process.env.WX_CLI && fs.existsSync(process.env.WX_CLI)) return process.env.WX_CLI
  const cands = [
    'D:\\3340\\Tencent\\微信web开发者工具\\cli.bat',
    'C:\\Program Files (x86)\\Tencent\\微信web开发者工具\\cli.bat',
    'C:\\Program Files\\Tencent\\微信web开发者工具\\cli.bat',
    process.env.LOCALAPPDATA ? path.join(process.env.LOCALAPPDATA, 'Programs', '微信web开发者工具', 'cli.bat') : ''
  ].filter(Boolean)
  return cands.find(p => fs.existsSync(p)) || ''
}

const C = {
  r: '\x1b[0m', b: '\x1b[1m', dim: '\x1b[2m',
  red: '\x1b[31m', green: '\x1b[32m', yellow: '\x1b[33m', cyan: '\x1b[36m'
}

/* ------------------------------------------------------------------ */
/* 1. 从 app.json 收集全部页面（主包 + 分包）                            */
/* ------------------------------------------------------------------ */
const appJson = JSON.parse(fs.readFileSync(path.join(PROJECT, 'Campus Time Bank', 'app.json'), 'utf8'))
const SUB_PREFIX = 'packageAdmin/'
const routes = appJson.pages.slice()
for (const sp of (appJson.subpackages || [])) {
  for (const p of (sp.pages || [])) routes.push(`${sp.root}/${p}`)
}

/**
 * 需要 query 参数的页面。
 * 标了 id 的会在开测前从对应的列表页把**真实 id** 读出来 ——
 * 注意不能用 mock.js 里的 id：那些是 `Math.random()` 生成的，
 * 测试进程与小程序运行时是两个不同的实例，id 对不上。
 */
const PARAM_PAGES = {
  'pages/skill/detail/detail': 'skillId',
  'pages/order/create/create': 'skillId',
  'pages/order/detail/detail': 'orderId',
  'pages/review/create/create': 'orderId',
  'pages/report/report': 'reportTarget',
  'pages/chat/room/room': 'chatId',
  'pages/user/home/home': 'openid'
}

/* ------------------------------------------------------------------ */
/* 2. 连接开发者工具                                                    */
/* ------------------------------------------------------------------ */
/**
 * 自动化端口。**不要假设它是 9420。**
 *
 * 「安全设置 → 服务端口」显示的那个数字（例如 49465）是 **IDE 的 HTTP 端口**，
 * 每次启动都可能变；自动化（automation）端口要由 `cli auto --auto-port <n>`
 * 显式指定。所以策略是：先直连，连不上就让 CLI 把端口固定到 PORT 再连。
 */
const PORT = Number(process.env.WX_AUTO_PORT || 9420)
const WS_ENDPOINT = process.env.WX_WS || `ws://127.0.0.1:${PORT}`

function sleep(ms) { return new Promise(r => setTimeout(r, ms)) }

/** 调 cli auto 把自动化端口固定下来（前提：「安全设置 → 服务端口」已打开） */
function enableAutomation(cli) {
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

async function connect() {
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
  await sleep(1500)

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
      `注意：你在安全设置里看到的端口号（如 49465）是 IDE 的 HTTP 端口，\n` +
      `自动化端口由本脚本的 cli auto --auto-port ${PORT} 指定；\n` +
      '想换端口就设环境变量 WX_AUTO_PORT。'
    )
  }
}

/* ------------------------------------------------------------------ */
/* 3. 从列表页采集真实 id                                               */
/* ------------------------------------------------------------------ */
async function harvestIds(mp) {
  const ids = {}
  /**
   * 用 `page.data()` 直接取页面数据 —— 不要用 `page.evaluate(getCurrentPages())`，
   * 那个在小程序运行时里取不到当前页实例（实测恒返回空）。
   */
  const grab = async (url, pick) => {
    try {
      const page = await mp.reLaunch(url)
      await page.waitFor(1600)
      const d = await page.data()
      return pick(d || {}) || ''
    } catch (e) { return '' }
  }

  ids.skillId = await grab('/pages/square/square', d => ((d.list || [])[0] || {})._id)
  ids.orderId = await grab('/pages/order/list/list', d => ((d.list || [])[0] || {})._id)
  ids.chatId = await grab('/pages/chat/list/list', d => ((d.list || [])[0] || {})._id)
  ids.openid = await grab('/pages/mine/mine', d => {
    const u = d.user || d.userInfo || {}
    return u._openid || ''
  })

  return ids
}

/* ------------------------------------------------------------------ */
/* 4. 主流程                                                            */
/* ------------------------------------------------------------------ */
async function main() {
  console.log(`\n${C.b}${C.cyan}小程序端一键冒烟测试${C.r}`)
  console.log(`${C.dim}共 ${routes.length} 个页面（主包 ${appJson.pages.length} + 分包 ${routes.length - appJson.pages.length}）${C.r}\n`)

  let mp
  try {
    mp = await connect()
  } catch (e) {
    console.error(`\n${C.red}${C.b}无法连接开发者工具${C.r}\n`)
    console.error(e.message)
    console.error(`\n${C.yellow}最可能的原因：没有开启「服务端口」${C.r}`)
    console.error('  开发者工具 → 右上角「详情」→ 本地设置 / 设置 → 安全设置')
    console.error('  → 打开「服务端口」，然后重新运行 npm run test:ui\n')
    process.exit(1)
  }

  /* ---- 错误收集：把异常与 console.error 归到「当前正在测的页面」上 ---- */
  let current = { route: '(init)', errors: [] }
  let noisy = 0
  mp.on('exception', (err) => {
    current.errors.push('未捕获异常: ' + ((err && (err.message || err.stack)) || JSON.stringify(err)))
  })
  mp.on('console', (msg) => {
    if (!msg || msg.type !== 'error') return
    const text = (msg.args || []).map(a => (typeof a === 'string' ? a : JSON.stringify(a))).join(' ')
    // 已知噪音：自动化快速 reLaunch 时，框架会对已切走的页面回调 routeDone，
    // 输出「routeDone with a webviewId N that is not the current page」。
    // 已单独复测确认：同一页面正常打开并给足稳定时间时不会出现，属测试竞态而非页面 bug。
    // ★ 只过滤这一条固定文案，其余 console.error 一律照报（不掩盖真问题）。
    if (/routeDone with a webviewId/.test(text)) { noisy++; return }
    current.errors.push('console.error: ' + text)
  })

  console.log(`${C.dim}正在采集页面真实 id…${C.r}`)
  const ids = await harvestIds(mp)
  console.log(`${C.dim}  skillId=${ids.skillId || '(无)'}  orderId=${ids.orderId || '(无)'}  chatId=${ids.chatId || '(无)'}  openid=${ids.openid || '(无)'}${C.r}\n`)

  const results = []

  for (const route of routes) {
    const url = '/' + route
    let target = url
    const need = PARAM_PAGES[route]
    if (need === 'reportTarget') {
      target = `${url}?targetType=skill&targetId=${encodeURIComponent(ids.skillId || 'unknown')}`
    } else if (need) {
      const v = ids[need]
      target = `${url}?${need}=${encodeURIComponent(v || 'unknown_id')}`
    }

    current = { route, errors: [] }
    let ok = true
    let note = ''

    try {
      const page = await mp.reLaunch(target)
      await page.waitFor(900)

      // 通用断言：页面 data 不能是空对象（空说明压根没渲染成功）
      const data = await page.data()
      const keys = Object.keys(data || {}).length
      if (keys === 0) {
        ok = false
        note = 'data 为空'
      } else {
        note = `${keys} 个字段`
      }
    } catch (e) {
      ok = false
      note = '打开失败: ' + String(e.message || e).split('\n')[0].slice(0, 60)
    }

    if (current.errors.length) {
      ok = false
      note = current.errors.length + ' 个报错'
    }

    results.push({ route, ok, note, errors: current.errors.slice(0, 3) })
    const mark = ok ? `${C.green}✓${C.r}` : `${C.red}✗${C.r}`
    console.log(`  ${mark} ${route.padEnd(42)} ${C.dim}${note}${C.r}`)
    if (!ok) {
      for (const e of current.errors.slice(0, 3)) {
        console.log(`      ${C.red}${e.slice(0, 150)}${C.r}`)
      }
    }
  }

  /* ---- 汇总 ---- */
  const failed = results.filter(r => !r.ok)
  console.log(`\n${'─'.repeat(64)}`)
  console.log(
    `${C.b}通过 ${results.length - failed.length} / ${results.length}${C.r}` +
    (failed.length ? `   ${C.red}失败 ${failed.length}${C.r}` : `   ${C.green}全部正常${C.r}`)
  )
  if (noisy) {
    console.log(`${C.dim}（另有 ${noisy} 条「routeDone with a webviewId」已忽略：` +
      `自动化快速切页的框架噪音，非页面问题）${C.r}`)
  }

  if (failed.length) {
    console.log(`\n${C.red}${C.b}有问题的页面：${C.r}`)
    failed.forEach(r => console.log(`  ${C.red}✗${C.r} ${r.route}  ${C.dim}${r.note}${C.r}`))
    console.log(`\n${C.dim}提示：如果报错是「数据尚未初始化」之类，说明云数据库还没跑过 initdb init。${C.r}`)
    console.log(`${C.dim}若想在离线模式下测（不依赖云环境），确认 envList.js 的 ENV_ID 为空。${C.r}`)
  }

  if (process.env.KEEP !== '1') {
    // 默认不关工具，方便你接着手动点开有问题的页面
    console.log(`\n${C.dim}（开发者工具保持打开，方便你手动复查）${C.r}\n`)
  }

  process.exit(failed.length ? 1 : 0)
}

main().catch(e => {
  console.error(`\n${C.red}脚本异常：${C.r}`, e && e.message)
  process.exit(1)
})
