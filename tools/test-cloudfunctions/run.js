#!/usr/bin/env node
/**
 * 云函数离线回归测试入口
 * ==================================================================
 * 用法（在项目根目录）：
 *     node tools/test-cloudfunctions/run.js              # 跑全部案例
 *     node tools/test-cloudfunctions/run.js order        # 只跑文件名含 order 的案例
 *     node tools/test-cloudfunctions/run.js wallet       # 只跑 wallet 案例
 *
 * 退出码：0 = 全部通过，1 = 有失败（可直接接进 CI）
 * ==================================================================
 */
const fs = require('fs')
const path = require('path')
const { createHarness, rawLog, ROOT, fake } = require('./lib/harness')
const { attach } = require('./lib/fixtures')
const shared = require(path.join(ROOT, 'cloudfunctions', '_shared', 'index.js'))

/**
 * 自动发现全部用例文件。
 *
 * ★ 用例文件必须自动发现 —— 硬编码数组的话，多人并行各加用例时要改同一处，
 *   必然冲突。改成目录扫描后，新增用例只要把文件放进 cases/ 就会被自动执行，
 *   谁都不用动 runner。
 */
const CASES_DIR = path.join(__dirname, 'cases')
const CASES = fs.existsSync(CASES_DIR)
  ? fs.readdirSync(CASES_DIR)
    .filter(f => f.endsWith('.test.js'))
    .sort()
    .map(f => path.join('cases', f))
  : []

/** 组 0：自检 —— 确认被测的是仓库真源码，而不是 sync-shared 生成的副本 */
function selfCheck (t) {
  t.group('组 0 · 自检：被测模块确实是仓库里的真源码')
  const cache = require.cache
  const p = f => path.join(ROOT, 'cloudfunctions', f)
  t.eq(!!cache[p('order/index.js')], true, 'order 云函数从 cloudfunctions/order/index.js 加载')
  t.eq(!!cache[p('wallet/index.js')], true, 'wallet 云函数从 cloudfunctions/wallet/index.js 加载')
  t.eq(!!cache[p('_shared/index.js')], true, '共享层从 cloudfunctions/_shared/index.js 加载（唯一事实来源）')
  t.eq(!!cache[p('order/shared/index.js')], false, 'order/shared 副本没有被加载（避免「测副本」失真）')
  t.eq(!!cache[p('wallet/shared/index.js')], false, 'wallet/shared 副本没有被加载')
  t.eq(t.fns.order !== undefined && t.fns.wallet !== undefined, true, '两个云函数入口都已 require 成功')
  t.eq(typeof shared.orderLimitOf, 'function', '共享层导出 orderLimitOf（信用等级并发上限的唯一出处）')
  t.eq(shared.orderLimitOf(130), 5, 'orderLimitOf(130) = 5')
}

async function main () {
  const filter = process.argv[2] || ''
  const t = attach(createHarness())
  selfCheck(t)

  let ran = 0
  for (const file of CASES) {
    if (filter && file.indexOf(filter) < 0) continue
    ran++
    rawLog(`▶ 运行 ${file}`)
    try {
      const mod = require(path.join(__dirname, file))
      if (typeof mod !== 'function') {
        t.group(`用例文件 ${path.basename(file)} · 加载`)
        t.ok(false, `${file} 必须导出一个 async 函数（module.exports = async (t) => {}）`)
        continue
      }
      await mod(t)
    } catch (e) {
      // ★ 单个用例文件崩溃**不应该**拖垮整个套件 —— 并行写用例时尤其重要。
      //   把异常记成一组失败断言，其余文件继续跑。
      t.group(`用例文件 ${path.basename(file)} · 执行异常`)
      t.ok(false, `${file} 执行时抛出异常：${e && e.message}`,
        e && e.stack ? String(e.stack).split('\n').slice(0, 5).join('\n') : '')
    }
  }

  if (!ran) {
    rawLog(`[runner] 没有匹配的案例文件：${filter}`)
    rawLog(`[runner] 可选：${CASES.join(' / ')}`)
    process.exit(1)
  }

  process.exit(t.report() ? 1 : 0)
}

main().catch(e => {
  rawLog('\n[runner] 测试运行器异常：')
  rawLog(e && e.stack ? e.stack : String(e))
  process.exit(1)
})
