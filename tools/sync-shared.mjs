/**
 * 把 cloudfunctions/_shared 同步到每个云函数的 shared/ 子目录
 * ------------------------------------------------------------------
 * 微信云开发每个云函数独立打包上传，无法跨目录 require，
 * 因此用「单一源码 + 构建同步」的方式避免重复维护。
 *
 * 用法（在项目根目录执行）：
 *     node tools/sync-shared.mjs
 *
 * ★ 每次修改 cloudfunctions/_shared/index.js 后都要重跑一次，
 *   否则上传的云函数用的还是旧的共享代码。
 * ------------------------------------------------------------------
 */
import fs from 'node:fs'
import path from 'node:path'
import url from 'node:url'

const __dirname = path.dirname(url.fileURLToPath(import.meta.url))
const ROOT = path.resolve(__dirname, '..')
const CF_DIR = path.join(ROOT, 'cloudfunctions')
const SRC = path.join(CF_DIR, '_shared')

const C = {
  reset: '\x1b[0m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  red: '\x1b[31m',
  cyan: '\x1b[36m',
  dim: '\x1b[2m'
}

function main() {
  if (!fs.existsSync(SRC)) {
    console.error(`${C.red}✗ 找不到共享目录：${SRC}${C.reset}`)
    process.exit(1)
  }

  const files = fs.readdirSync(SRC).filter(f => fs.statSync(path.join(SRC, f)).isFile())
  if (!files.length) {
    console.error(`${C.red}✗ ${SRC} 是空的${C.reset}`)
    process.exit(1)
  }

  // 所有非 _ 开头的目录都视为一个云函数
  const funcs = fs.readdirSync(CF_DIR, { withFileTypes: true })
    .filter(d => d.isDirectory() && !d.name.startsWith('_') && !d.name.startsWith('.'))
    .map(d => d.name)

  if (!funcs.length) {
    console.warn(`${C.yellow}! cloudfunctions 下还没有任何云函数目录${C.reset}`)
    return
  }

  console.log(`${C.cyan}同步共享代码 → ${funcs.length} 个云函数${C.reset}`)
  console.log(`${C.dim}源：cloudfunctions/_shared  (${files.join(', ')})${C.reset}\n`)

  let total = 0
  for (const fn of funcs) {
    const dest = path.join(CF_DIR, fn, 'shared')
    fs.mkdirSync(dest, { recursive: true })
    for (const f of files) {
      fs.copyFileSync(path.join(SRC, f), path.join(dest, f))
      total++
    }
    console.log(`  ${C.green}✓${C.reset} ${fn}/shared/  ${C.dim}(${files.length} 个文件)${C.reset}`)
  }

  console.log(`\n${C.green}完成：共写入 ${total} 个文件。${C.reset}`)
  console.log(`${C.yellow}提醒：请在微信开发者工具中对每个云函数右键「上传并部署：云端安装依赖」。${C.reset}`)
}

main()
