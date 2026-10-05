/**
 * 离线测试内核
 * ==================================================================
 * 关键设计：**不拷贝任何云函数源码**。
 *   - `cloudfunctions/<fn>/index.js` 里的 `require('./shared')` 被解析到
 *     `cloudfunctions/_shared/index.js`（源码唯一事实来源，而不是各函数下由
 *     sync-shared.mjs 生成的副本）；
 *   - `require('wx-server-sdk')` 被解析到 `stub/wx-server-sdk.js`。
 * 两者都通过拦截 `Module._resolveFilename` 实现，因此测试跑的就是仓库里那份真源码，
 * 实现一改，测试立刻跟着变，不存在「测试副本与实现脱节」的问题。
 * ==================================================================
 */
const Module = require('module')
const path = require('path')

const ROOT = path.resolve(__dirname, '..', '..', '..')
const STUB = path.join(__dirname, '..', 'stub', 'wx-server-sdk.js')

/* ------------------ 模块解析劫持 ------------------ */
const originalResolve = Module._resolveFilename
Module._resolveFilename = function (request, parent, isMain, options) {
  if (request === 'wx-server-sdk') return STUB
  if (
    request === './shared' &&
    parent && parent.filename &&
    /cloudfunctions[\\/][^\\/]+[\\/]index\.js$/.test(parent.filename)
  ) {
    return path.join(ROOT, 'cloudfunctions', '_shared', 'index.js')
  }
  return originalResolve.call(this, request, parent, isMain, options)
}

const fake = require(STUB)
const shared = require(path.join(ROOT, 'cloudfunctions', '_shared', 'index.js'))

/**
 * 加载全部 8 个云函数入口。
 *
 * ★ 这里必须加载全部 8 个云函数 —— 只 require order / wallet 的话，其余 6 个（login / skill /
 *   user / message / admin / initdb）在离线回归里**根本无法被测到**。
 *   改成遍历加载后，任何云函数都能写进 cases/ 直接测。
 *   某个函数加载失败不会中断整体（只记录），方便逐个补齐覆盖。
 */
const FUNC_NAMES = ['login', 'skill', 'order', 'wallet', 'user', 'message', 'admin', 'initdb', 'account']
const fns = {}
const loadErrors = {}
for (const n of FUNC_NAMES) {
  try {
    fns[n] = require(path.join(ROOT, 'cloudfunctions', n, 'index.js'))
  } catch (e) {
    loadErrors[n] = e && e.message
  }
}

/* ------------------ 云函数 console 输出接管 ------------------
 * 云函数里的 console.log/error（补发徽章、autoTask 汇总等）默认被收集起来，
 * 不打断测试报告；失败时自动回显最后若干行，便于定位。 */
const logs = []
const rawLog = console.log.bind(console)
const rawError = console.error.bind(console)
console.log = (...a) => { logs.push(a.map(x => (typeof x === 'string' ? x : JSON.stringify(x))).join(' ')) }
console.error = (...a) => { logs.push('[stderr] ' + a.map(x => (typeof x === 'string' ? x : (x && x.message) || JSON.stringify(x))).join(' ')) }

const C = { reset: '\x1b[0m', green: '\x1b[32m', red: '\x1b[31m', dim: '\x1b[2m', cyan: '\x1b[36m' }

/* ------------------ 断言与报告 ------------------ */
function createHarness() {
  const groups = []
  let cur = null
  let passed = 0
  let failed = 0

  function ensure() {
    if (!cur) {
      cur = { title: '(未分组)', items: [] }
      groups.push(cur)
    }
  }

  const t = {
    fake,
    shared,
    fns,

    group(title) {
      cur = { title, items: [] }
      groups.push(cur)
    },

    /** 记录一条断言 */
    ok(cond, msg, extra) {
      ensure()
      if (cond) {
        passed++
        cur.items.push({ pass: true, msg })
      } else {
        failed++
        cur.items.push({ pass: false, msg, extra })
      }
      return !!cond
    },

    /** 断言相等，失败时打印期望值 / 实际值 */
    eq(actual, expected, msg) {
      return t.ok(
        actual === expected,
        msg,
        `期望 ${JSON.stringify(expected)}，实际 ${JSON.stringify(actual)}`
      )
    },

    /** 断言布尔，失败时打印实际值 */
    isTrue(actual, msg) {
      return t.ok(actual === true, msg, `期望 true，实际 ${JSON.stringify(actual)}`)
    },

    summary() { return { passed, failed, groups } },

    /**
     * 打印一行调试信息。
     *
     * ★ 必须用它，**不要用 console.log**：本文件在加载时接管了 console，
     *   把云函数的输出收集进 logs[] 不直接打印，所以用例里写 console.log
     *   会「看起来什么都没发生」，极难排查。rawLog 是唯一真正输出的通道。
     */
    log(msg) { rawLog(String(msg)) },

    /** 打印分组报告，返回失败数 */
    report() {
      const line = '─'.repeat(64)
      const verbose = process.env.TB_TEST_VERBOSE === '1'
      if (verbose && logs.length) {
        rawLog(`${C.dim}—— 云函数 console 输出（TB_TEST_VERBOSE=1）——`)
        logs.forEach(l => rawLog(`${C.dim}   ${l}${C.reset}`))
      }
      rawLog(`\n${C.cyan}校园时间银行 · 云函数离线回归测试${C.reset}`)
      rawLog(`${C.dim}被测真实源码：cloudfunctions/<8 个云函数>/index.js + cloudfunctions/_shared/index.js${C.reset}`)
      rawLog(`${C.dim}测试替身：tools/test-cloudfunctions/stub/wx-server-sdk.js（内存库 + 快照隔离事务）${C.reset}`)
      groups.forEach((g, gi) => {
        const bad = g.items.filter(i => !i.pass).length
        rawLog(`\n${line}`)
        rawLog(`[${gi + 1}/${groups.length}] ${g.title}   ${bad ? C.red + '✗ ' + bad + ' 条失败' + C.reset : C.green + '✓ 全通过' + C.reset}`)
        g.items.forEach(i => {
          if (i.pass) rawLog(`   ${C.green}✓${C.reset} ${i.msg}`)
          else rawLog(`   ${C.red}✗ ${i.msg}${C.reset}\n       ${C.red}${i.extra}${C.reset}`)
        })
      })
      rawLog(`\n${line}`)
      const color = failed ? C.red : C.green
      rawLog(`${color}通过 ${passed} / 失败 ${failed}${C.reset}   断言总数 ${passed + failed}`)
      const tot = fake.__totals
      const tr = fake.__stats
      rawLog(`${C.dim}数据库事务 ${tot.transactions + tr.transactions} 次（其中写冲突自动重试 ${tot.retries + tr.retries} 次）${C.reset}`)
      rawLog(`${C.dim}云函数 console 输出 ${logs.length} 行（需要时用 TB_TEST_VERBOSE=1 打印）${C.reset}`)
      if (failed) {
        rawLog(`\n${C.red}—— 失败详情 ——${C.reset}`)
        groups.forEach(g => g.items.filter(i => !i.pass).forEach(i => {
          rawLog(`   ${C.red}✗${C.reset} [${g.title}]\n     ${i.msg}\n     ${C.red}${i.extra}${C.reset}`)
        }))
        rawLog(`\n${C.dim}—— 失败前的云函数 console 输出（最后 30 行）——${C.reset}`)
        logs.slice(-30).forEach(l => rawLog(`${C.dim}   ${l}${C.reset}`))
      }
      return failed
    }
  }

  return t
}

module.exports = { createHarness, ROOT, fake, rawLog, fns, loadErrors, FUNC_NAMES }
