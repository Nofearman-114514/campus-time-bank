/**
 * 项目一致性检查（离线静态体检）
 * ==================================================================
 * 用法（项目根目录）：
 *     node tools/check-project.mjs
 *
 * 检查项：
 *   1. app.json 里声明的每个页面是否都有 js/json/wxml/wxss 四件套
 *   2. 每个 json 的 usingComponents 路径是否能解析到真实组件
 *   3. 页面里调用的 api.xxx.yyy() 是否都在 utils/api.js 里存在
 *   4. utils/api.js 里的每个 action 是否都有 mock 实现（离线模式可跑）
 *   5. 所有相对路径 require() 是否能解析（含云函数 shared）
 *   6. tabBar 声明的页面是否都在 pages 列表里
 *   7. 云函数目录结构是否完整（index.js + package.json + shared/index.js）
 *   8. 统计代码规模
 * ==================================================================
 */
import fs from 'node:fs'
import path from 'node:path'
import url from 'node:url'

const __dirname = path.dirname(url.fileURLToPath(import.meta.url))
const ROOT = path.resolve(__dirname, '..')
const MP = path.join(ROOT, 'Campus Time Bank')
const CF = path.join(ROOT, 'cloudfunctions')

const C = {
  r: '\x1b[0m', b: '\x1b[1m', dim: '\x1b[2m',
  red: '\x1b[31m', green: '\x1b[32m', yellow: '\x1b[33m', cyan: '\x1b[36m'
}

const errors = []
const warnings = []
const err = (m) => errors.push(m)
const warn = (m) => warnings.push(m)

/* ------------------------------------------------------------------ */
/* 文件遍历                                                            */
/* ------------------------------------------------------------------ */
function walk(dir, filter, out = []) {
  if (!fs.existsSync(dir)) return out
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.name === 'node_modules' || e.name.startsWith('.')) continue
    const p = path.join(dir, e.name)
    if (e.isDirectory()) walk(p, filter, out)
    else if (!filter || filter(p)) out.push(p)
  }
  return out
}

const rel = (p) => path.relative(ROOT, p).replace(/\\/g, '/')
const exists = (p) => { try { return fs.existsSync(p) } catch { return false } }
const read = (p) => { try { return fs.readFileSync(p, 'utf8') } catch { return '' } }
/**
 * 去掉注释，避免把文档注释里的示例代码（如 require('../../utils/api')）
 * 当成真实引用而误报。
 */
function stripComments(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, '')      // 块注释
    .replace(/(^|[^:\w"'`])\/\/[^\n]*/g, '$1') // 行注释（保留 http:// 之类）
}
const readCode = (p) => stripComments(read(p))
const readJson = (p) => {
  try { return JSON.parse(read(p)) } catch (e) {
    err(`JSON 解析失败：${rel(p)} —— ${e.message}`)
    return null
  }
}

/* ------------------------------------------------------------------ */
/* 1 + 6. app.json 页面与 tabBar                                       */
/* ------------------------------------------------------------------ */
const appJson = readJson(path.join(MP, 'app.json'))

const allPages = []           // { route, dir, base }
if (appJson) {
  const main = appJson.pages || []
  main.forEach(r => allPages.push({ route: r, root: '' }))
  const sub = appJson.subpackages || appJson.subPackages || []
  sub.forEach(sp => {
    (sp.pages || []).forEach(r => allPages.push({ route: `${sp.root}/${r}`, root: sp.root }))
  })

  // 1. 四件套
  for (const p of allPages) {
    const base = path.join(MP, p.route)
    for (const ext of ['js', 'json', 'wxml', 'wxss']) {
      if (!exists(`${base}.${ext}`)) {
        if (ext === 'wxss') warn(`缺少样式文件（非致命）：${p.route}.wxss`)
        else err(`缺少页面文件：${p.route}.${ext}`)
      }
    }
  }

  // 6. tabBar
  const tb = appJson.tabBar || {}
  if (tb.list) {
    for (const item of tb.list) {
      if (main.indexOf(item.pagePath) < 0) {
        err(`tabBar 中的 "${item.pagePath}" 不在 app.json 的 pages 列表里`)
      }
    }
    if (tb.custom) {
      const ctdir = path.join(MP, 'custom-tab-bar')
      for (const ext of ['js', 'json', 'wxml', 'wxss']) {
        if (!exists(path.join(ctdir, `index.${ext}`))) err(`自定义 tabBar 缺少 custom-tab-bar/index.${ext}`)
      }
    }
  }
}

/* ------------------------------------------------------------------ */
/* 2. usingComponents 路径解析                                          */
/* ------------------------------------------------------------------ */
const jsonFiles = walk(MP, p => p.endsWith('.json'))

function resolveCompPath(fromJson, compPath) {
  if (compPath.startsWith('/')) return path.join(MP, compPath)
  return path.resolve(path.dirname(fromJson), compPath)
}

let compRefs = 0
for (const jf of jsonFiles) {
  const j = readJson(jf)
  if (!j) continue
  const uc = j.usingComponents
  if (!uc || typeof uc !== 'object') continue
  for (const [tag, cp] of Object.entries(uc)) {
    compRefs++
    const base = resolveCompPath(jf, cp)
    const missing = ['js', 'json', 'wxml'].filter(ext => !exists(`${base}.${ext}`))
    if (missing.length) {
      err(`组件引用失效：${rel(jf)} 的 <${tag}> → "${cp}"，缺少 ${missing.join('/')}`)
    } else {
      const cj = readJson(`${base}.json`)
      if (cj && cj.component !== true) warn(`组件 ${rel(base)}.json 缺少 "component": true`)
    }
  }
}

/* ------------------------------------------------------------------ */
/* 3. 页面调用的 api 是否存在                                            */
/* ------------------------------------------------------------------ */
const apiSrc = read(path.join(MP, 'utils', 'api.js'))

// api.js 中定义的所有 name.action
const definedActions = new Set()
for (const m of apiSrc.matchAll(/call\(\s*'([A-Za-z_]\w*)'\s*,\s*'([A-Za-z_]\w*)'/g)) {
  definedActions.add(`${m[1]}.${m[2]}`)
}
// 命名空间对象名（login/skill/order/wallet/user/message/admin）
const namespaces = new Set()
for (const m of apiSrc.matchAll(/^const\s+([A-Za-z_]\w*)\s*=\s*\{/gm)) namespaces.add(m[1])

const jsFiles = walk(MP, p => p.endsWith('.js'))
let apiCalls = 0
const usedActions = new Set()

for (const jf of jsFiles) {
  if (jf.endsWith(path.join('utils', 'api.js'))) continue
  const src = readCode(jf)
  for (const m of src.matchAll(/\bapi\.([A-Za-z_]\w*)\.([A-Za-z_]\w*)\s*\(/g)) {
    const ns = m[1]
    const fn = m[2]
    apiCalls++
    if (!namespaces.has(ns)) {
      err(`未知的 api 命名空间：${rel(jf)} 里的 api.${ns}.${fn}()`)
      continue
    }
    const key = `${ns}.${fn}`
    usedActions.add(key)
    // api.js 里每个方法体的 call('ns', 'action')
    if (!definedActions.has(key) && !new RegExp(`\\b${fn}\\s*:\\s*p\\s*=>`).test(apiSrc)) {
      err(`api 方法不存在：${rel(jf)} 调用了 api.${ns}.${fn}()`)
    }
  }
}

/* ------------------------------------------------------------------ */
/* 4. mock 覆盖率                                                      */
/* ------------------------------------------------------------------ */
const mockSrc = read(path.join(MP, 'utils', 'mock.js'))
const mockKeys = new Set()
for (const m of mockSrc.matchAll(/['"]([a-z]+)\.([a-zA-Z]\w*)['"]\s*:/g)) {
  mockKeys.add(`${m[1]}.${m[2]}`)
}

const missingMock = []
for (const a of definedActions) {
  if (!mockKeys.has(a)) missingMock.push(a)
}

/* ------------------------------------------------------------------ */
/* 5. require 路径解析                                                  */
/* ------------------------------------------------------------------ */
let requireCount = 0
for (const jf of jsFiles.concat(walk(CF, p => p.endsWith('.js')))) {
  const src = jf.endsWith('_shared/index.js') || jf.includes(`${path.sep}shared${path.sep}`) ? read(jf) : readCode(jf)
  for (const m of src.matchAll(/require\(\s*['"]([^'"]+)['"]\s*\)/g)) {
    const spec = m[1]
    if (!spec.startsWith('.')) continue        // 第三方包，跳过
    requireCount++
    const target = path.resolve(path.dirname(jf), spec)
    const cands = [target, `${target}.js`, path.join(target, 'index.js')]
    if (!cands.some(exists)) {
      // cloudfunctions/*/shared 由 tools/sync-shared.mjs 生成，缺失单独提示
      if (spec.includes('shared')) {
        warn(`未同步共享代码：${rel(jf)} → "${spec}"（请在根目录执行 node tools/sync-shared.mjs）`)
      } else {
        err(`require 路径不存在：${rel(jf)} → "${spec}"`)
      }
    }
  }
}

/* ------------------------------------------------------------------ */
/* 6.5 wxml 事件处理函数是否存在 + wx:for 是否有 wx:key                  */
/* ------------------------------------------------------------------ */
const wxmlFiles = walk(MP, p => p.endsWith('.wxml'))
let handlerRefs = 0
let forRefs = 0
let textWrapHits = 0

for (const wf of wxmlFiles) {
  const src = read(wf)
  const jsPath = wf.replace(/\.wxml$/, '.js')
  if (!exists(jsPath)) { err(`wxml 缺少同名 js：${rel(wf)}`); continue }
  const js = readCode(jsPath)

  // 事件处理函数：只检查字面量形式的绑定，{{}} 动态绑定跳过
  const names = new Set()
  for (const m of src.matchAll(/(?:bind|catch):?[a-zA-Z]+\s*=\s*"([A-Za-z_$][\w$]*)"/g)) {
    names.add(m[1])
  }
  for (const n of names) {
    handlerRefs++
    // 允许：方法定义、属性简写、对象方法
    const defined = new RegExp(`(^|[^\\w$])${n}\\s*[:(]`, 'm').test(js)
    if (!defined) {
      err(`事件处理函数未定义：${rel(wf)} 绑定了 "${n}"，但 ${rel(jsPath)} 里找不到`)
    }
  }

  // wx:for 建议都写 wx:key（不写会导致列表复用错乱）
  const blocks = src.split(/<([a-zA-Z-]+)\b/)
  for (const m of src.matchAll(/<[a-zA-Z-]+[^>]*\bwx:for\s*=[^>]*>/g)) {
    const tag = m[0]
    forRefs++
    if (!/\bwx:key\s*=/.test(tag)) {
      const line = src.slice(0, m.index).split('\n').length
      warn(`${rel(wf)}:${line} 的 wx:for 没有 wx:key，列表更新可能错乱`)
    }
  }

  // ★ <text> 的内容跨行：换行与缩进会成为文本内容的一部分。
  //   本项目真实踩过 —— 「分类」行的插值另起一行，导致真机上文字被推开、
  //   行盒被撑高（开发者工具里反而看不出来）；同一问题还漏掉了两处胶囊。
  //   所以这里按**错误**上报，逼着写在同一行。
  const tplLines = src.split('\n')
  for (let i = 0; i < tplLines.length - 1; i++) {
    if (/<text\b[^>]*>\s*$/.test(tplLines[i]) && /^\s*\{\{/.test(tplLines[i + 1])) {
      textWrapHits++
      err(`<text> 内容跨行：${rel(wf)}:${i + 1} —— 插值另起了一行，` +
        `换行与缩进会被当成文本内容（真机表现为文字偏移或盒子被撑高）。` +
        `请把插值紧贴标签写在同一行`)
    }
  }
}

/* ------------------------------------------------------------------ */
/* 6.6 页面调用的 app.* 方法是否存在                                     */
/* ------------------------------------------------------------------ */
const appSrc = read(path.join(MP, 'app.js'))
const appMembers = new Set(['globalData'])
// 方法定义：允许 async 前缀，例如 `async getLocation(force) {`
for (const m of appSrc.matchAll(/^\s{2}(?:async\s+)?([A-Za-z_]\w*)\s*\([^)]*\)\s*\{/gm)) appMembers.add(m[1])
// 属性写法：`getLocation: async function () {}` / `getLocation: (x) => {}`
for (const m of appSrc.matchAll(/^\s{2}([A-Za-z_]\w*)\s*:\s*(?:async\s*)?(?:function|\()/gm)) appMembers.add(m[1])

let appRefs = 0
for (const jf of jsFiles) {
  if (jf.endsWith(path.join('utils', 'api.js')) || jf.endsWith(path.join('app.js'))) continue
  const src = readCode(jf)
  for (const m of src.matchAll(/\bapp\.([A-Za-z_]\w*)\s*\(/g)) {
    appRefs++
    if (!appMembers.has(m[1])) {
      err(`app 方法不存在：${rel(jf)} 调用了 app.${m[1]}()，但 app.js 里没有这个方法`)
    }
  }
}

/* ------------------------------------------------------------------ */
/* 6.7 wxml 模板变量是否在对应 js 里出现过（抓拼写错误 / 漏 setData）      */
/* ------------------------------------------------------------------ */
const TPL_KEYWORDS = new Set([
  'true', 'false', 'null', 'undefined', 'item', 'index', 'wx', 'NaN', 'Infinity'
])
let tplVars = 0
for (const wf of wxmlFiles) {
  const src = read(wf)
  const jsPath = wf.replace(/\.wxml$/, '.js')
  if (!exists(jsPath)) continue
  const js = readCode(jsPath)

  // 模板自己声明的循环变量名是合法的
  const declared = new Set(['item', 'index'])
  for (const m of src.matchAll(/wx:for-item\s*=\s*"([^"]+)"/g)) declared.add(m[1].trim())
  for (const m of src.matchAll(/wx:for-index\s*=\s*"([^"]+)"/g)) declared.add(m[1].trim())

  const used = new Set()
  for (const m of src.matchAll(/\{\{([\s\S]*?)\}\}/g)) {
    // ★ 先剥掉字符串字面量，否则三元里的 CSS 类名会被误判成变量
    //   （例如 {{ok ? '' : 'is-locked'}} 里的 "-locked" 会被当成标识符 locked）
    const expr = m[1].replace(/'[^']*'/g, ' ').replace(/"[^"]*"/g, ' ')
    for (const idm of expr.matchAll(/(^|[^\w.$])([A-Za-z_$][\w$]*)/g)) {
      used.add(idm[2])
    }
  }

  for (const name of used) {
    if (TPL_KEYWORDS.has(name) || declared.has(name)) continue
    tplVars++
    if (!new RegExp(`(^|[^\\w$])${name}([^\\w$]|$)`, 'm').test(js)) {
      warn(`模板变量疑似未定义：${rel(wf)} 用了 "{{${name}}}"，但 ${rel(jsPath)} 里找不到这个名字（可能是拼写错误或忘了 setData）`)
    }
  }
}

/* ------------------------------------------------------------------ */
/* 7. 云函数结构                                                        */
/* ------------------------------------------------------------------ */
const EXPECT_FUNCS = ['login', 'skill', 'order', 'wallet', 'user', 'message', 'admin', 'initdb']
if (exists(CF)) {
  const dirs = fs.readdirSync(CF, { withFileTypes: true })
    .filter(d => d.isDirectory() && !d.name.startsWith('_') && !d.name.startsWith('.'))
    .map(d => d.name)
  for (const fn of EXPECT_FUNCS) {
    if (dirs.indexOf(fn) < 0) {
      err(`云函数缺失：cloudfunctions/${fn}/`)
      continue
    }
    if (!exists(path.join(CF, fn, 'index.js'))) err(`云函数缺少入口：cloudfunctions/${fn}/index.js`)
    if (!exists(path.join(CF, fn, 'package.json'))) err(`云函数缺少依赖声明：cloudfunctions/${fn}/package.json`)
    if (!exists(path.join(CF, fn, 'shared', 'index.js'))) {
      warn(`云函数未同步共享层：cloudfunctions/${fn}/shared/index.js（执行 node tools/sync-shared.mjs）`)
    }
  }
  for (const d of dirs) {
    if (EXPECT_FUNCS.indexOf(d) < 0) warn(`发现契约外的云函数目录：cloudfunctions/${d}/`)
  }
}

/* ------------------------------------------------------------------ */
/* 8. 规模统计                                                          */
/* ------------------------------------------------------------------ */
const statExts = ['.js', '.wxml', '.wxss', '.json', '.md', '.mjs']
const statTargets = [MP, CF, path.join(ROOT, 'docs'), path.join(ROOT, 'tools')]
const stats = {}
let totalLines = 0
let totalFiles = 0

for (const dir of statTargets) {
  for (const f of walk(dir, p => statExts.includes(path.extname(p)))) {
    if (f.includes('ec-canvas') || f.includes('node_modules')) continue
    const ext = path.extname(f)
    const lines = read(f).split('\n').length
    stats[ext] = stats[ext] || { files: 0, lines: 0 }
    stats[ext].files++
    stats[ext].lines += lines
    totalLines += lines
    totalFiles++
  }
}

/* ------------------------------------------------------------------ */
/* 报告                                                                */
/* ------------------------------------------------------------------ */
console.log(`\n${C.b}${C.cyan}校园时间银行 · 项目一致性检查${C.r}\n`)

console.log(`${C.b}规模统计${C.r}`)
console.log(`  页面/分包页面     ${C.b}${allPages.length}${C.r} 个`)
console.log(`  组件引用          ${C.b}${compRefs}${C.r} 处`)
console.log(`  api 调用点        ${C.b}${apiCalls}${C.r} 处`)
console.log(`  已定义 action     ${C.b}${definedActions.size}${C.r} 个`)
console.log(`  mock 覆盖         ${C.b}${definedActions.size - missingMock.length}/${definedActions.size}${C.r}`)
console.log(`  require 相对引用  ${C.b}${requireCount}${C.r} 处`)
console.log(`  事件绑定检查      ${C.b}${handlerRefs}${C.r} 个处理函数`)
console.log(`  wx:for 检查       ${C.b}${forRefs}${C.r} 处`)
console.log(`  <text> 跨行检查   ${C.b}${textWrapHits}${C.r} 处违规`)
console.log(`  app.* 调用检查    ${C.b}${appRefs}${C.r} 处`)
console.log(`  模板变量检查      ${C.b}${tplVars}${C.r} 个引用`)
console.log('')
for (const [ext, s] of Object.entries(stats).sort((a, b) => b[1].lines - a[1].lines)) {
  console.log(`  ${ext.padEnd(8)} ${String(s.files).padStart(4)} 个文件  ${String(s.lines).padStart(7)} 行`)
}
console.log(`  ${C.b}合计${C.r}     ${String(totalFiles).padStart(4)} 个文件  ${String(totalLines).padStart(7)} 行`)

if (missingMock.length) {
  console.log(`\n${C.yellow}${C.b}离线模式未覆盖的 action（${missingMock.length} 个）${C.r}`)
  missingMock.forEach(a => console.log(`  ${C.yellow}·${C.r} ${a}`))
  console.log(`${C.dim}  说明：这些接口在 MOCK 模式下会抛「未实现」，接入真实云环境后不受影响。${C.r}`)
}

if (warnings.length) {
  console.log(`\n${C.yellow}${C.b}警告（${warnings.length} 条）${C.r}`)
  warnings.forEach(w => console.log(`  ${C.yellow}!${C.r} ${w}`))
}

if (errors.length) {
  console.log(`\n${C.red}${C.b}错误（${errors.length} 条）${C.r}`)
  errors.forEach(e => console.log(`  ${C.red}✗${C.r} ${e}`))
  console.log(`\n${C.red}${C.b}检查未通过。${C.r}\n`)
  process.exit(1)
} else {
  console.log(`\n${C.green}${C.b}✓ 全部检查通过${warnings.length ? `（有 ${warnings.length} 条警告）` : ''}。${C.r}\n`)
  process.exit(0)
}
