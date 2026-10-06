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
// ★ WXML 标签配对检查（见该文件头的真实事故说明）
import { checkTags } from './check-wxml.mjs'

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
/**
 * ★ 可选依赖白名单：这些 require 的目标**允许不存在**。
 *
 *   典型是「本地个人配置」—— 真实值不进仓库（见 .gitignore 的 envList.local.js），
 *   调用方用 try/catch 包住，文件不在时降级为默认值。
 *
 *   如果不在这里放行，**别人 clone 仓库后 check-project 会直接失败** ——
 *   而仓库里本来就不该有这个文件（它装着云环境 ID）。
 *   往这个列表里加东西要慎重：等于声明「缺失是正常的」。
 */
const OPTIONAL_REQUIRE = [/envList\.local$/]

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
      // 可选依赖：文件不在是正常情况（本地个人配置不进程）
      if (OPTIONAL_REQUIRE.some(re => re.test(spec))) continue
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
/* 5.5 禁止直接读 Geo 的 .latitude / .longitude                          */
/* ------------------------------------------------------------------ */
/**
 * ★ 为什么要有这条静态检查：
 *   云端 `db.Geo.Point(lng, lat)` 经 wx.cloud 序列化回来是 **GeoJSON**：
 *       { type: 'Point', coordinates: [经度, 纬度] }
 *   它**没有** `.latitude` / `.longitude` 属性 —— 直接读永远是 undefined。
 *
 *   这个错配很难在测试里暴露（页面上只是按钮不出现，不报错），
 *   而且旧种子数据的 location 是 null，所以长期潜伏。
 *   统一走 utils/campus.js 的 parseGeoPoint()，它两种格式都吃。
 */
let geoCheck = 0
for (const jf of jsFiles) {
  const relPath = rel(jf)
  if (relPath.includes('utils/campus.js')) continue          // 归一化函数自己的实现
  const src = readCode(jf)
  src.split('\n').forEach((line, i) => {
    if (/\.location\.(longitude|latitude)\b/.test(line)) {
      err(`${relPath}:${i + 1} 直接读 .location.longitude/.latitude —— ` +
          `云端返回的是 GeoJSON，请用 campus.parseGeoPoint(skill.location)`)
    }
    geoCheck++
  })
}

/* ------------------------------------------------------------------ */
/* 5.6 硬编码的年级下拉不能过期                                          */
/* ------------------------------------------------------------------ */
/**
 * ★ 为什么要有这条：
 *   年级每年新增一届。写死成 ['2021级'…'2025级'] 的话，
 *   2026 年入学的新生就选不到自己 —— 而且这个问题**年年复发**，
 *   不写检查就只能等用户来报。
 *
 *   只有「≥3 个年级字符串」才当成下拉列表（单条用户数据不算）。
 *   规则与 profile.js 的 buildGradeRange 一致：8 月是入学月。
 */
const enrollYear = (() => {
  const d = new Date()
  return (d.getMonth() + 1) >= 8 ? d.getFullYear() : d.getFullYear() - 1
})()
let gradeLists = 0
for (const jf of jsFiles) {
  const relPath = rel(jf)
  // ★ 注意用 /(^|\/)pages\// 而不是 /^pages\// —— rel() 会带上小程序根目录前缀
  //   （现在是 "Campus Time Bank/pages/..."，而且根目录名可改），
  //   锚定开头就永远匹配不到，检查会静默失效。
  if (!/(^|\/)(pages|components|packageAdmin)\//.test(relPath)) continue
  const years = [...readCode(jf).matchAll(/'(20\d{2})级'/g)].map(m => Number(m[1]))
  if (years.length < 3) continue          // 不像列表，跳过
  gradeLists++
  const maxYear = Math.max(...years)
  if (maxYear < enrollYear) {
    err(`${relPath} 年级下拉最新只到 ${maxYear}级，但当前最新一届是 ${enrollYear}级 —— ` +
        `年级逐年新增，请改成按当前时间动态生成（参考 pages/user/profile/profile.js 的 buildGradeRange()）`)
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
const EXPECT_FUNCS = ['login', 'skill', 'order', 'wallet', 'user', 'message', 'admin', 'initdb', 'account']
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
/* ==================================================================
 * §5.7 WXML 标签配对
 * ------------------------------------------------------------------
 * ★ 真实事故：删一行开关时用正则删掉了注释、标签和 <switch />，
 *   但漏掉了外面两层 </view>，留下孤立闭合标签。
 *   开发者工具上传时报 `unexpected end tag: view`，
 *   而当时门禁一项都没拦住 —— 因为它们只查绑定，不查配对。
 * ================================================================== */
let wxmlPairBad = 0
for (const wf of wxmlFiles) {
  const errs = checkTags(read(wf))
  if (!errs.length) continue
  wxmlPairBad++
  const rel = path.relative(ROOT, wf).replace(/\\/g, '/')
  errs.forEach(e => errors.push(`WXML 标签不配对 → ${rel} ${e}`))
}
const wxmlCount = wxmlFiles.length

/* ==================================================================
 * §5.8 文档里的关键数字与实际一致
 * ==================================================================
 * 动因：一轮迭代下来，README / 答辩材料 / 部署指南里的数字**全过时了** ——
 *   「8 个云函数」实际 9 个、「65 个 action」实际 75、「14 个集合」实际 17、
 *   「32 个页面」实际 37、「1901 条断言」实际 2261，六份文档都中招。
 *
 *   ★ 原有三套门禁**一条都拦不住** —— 它们只看代码，从来不读文档。
 *   而答辩材料是给老师看的，数字对不上比不写还糟。
 *
 * 【为什么要看上下文，而不是"见到 N 个 action 就比总数"】
 *   文档里的数字不全是**总数**，还有三种：
 *     · 「admin 云函数的 20 个 action」   —— 单个云函数的
 *     · 「11 个集合：仅管理端可读写」     —— 按权限分类的
 *     · 「阶段 1（约 53 个 action）」     —— 分批执行的
 *   一律当总数比会误报一大片（第一版就误报了约三成）。
 *   所以：**提到哪个云函数，就按那个云函数的真实 action 数比**；
 *   带「约 / 阶段 / 权限 / 第 N 个」这类限定词的，直接跳过。
 *
 * ★ 真实值会随下面的汇总一起打出来 ——
 *   门禁自己也会撒谎（我写过一个「读到空值反而判通过」的检查），
 *   所以中间结果必须可见。
 * ★ 断言数**不在这里查**：它要靠跑测试才知道，静态算不出来，
 *   硬编码进去只会又多一处漂移。
 * ================================================================== */
const cfCount = fs.readdirSync(CF, { withFileTypes: true })
  .filter(d => d.isDirectory() && d.name !== '_shared' && exists(path.join(CF, d.name, 'index.js'))).length
const actionTotal = definedActions.size
const colTotal = (read(path.join(CF, '_shared', 'index.js')).match(/^\s{2}[A-Z][A-Z_]*:\s*'[a-z_]+'/gm) || []).length

/** 每个云函数各自的 action 数 —— 取自 api.js 的声明，和 definedActions 同源 */
const actionsByNs = {}
for (const m of apiSrc.matchAll(/call\(\s*'([A-Za-z_]\w*)'\s*,\s*'([A-Za-z_]\w*)'/g)) {
  actionsByNs[m[1]] = (actionsByNs[m[1]] || 0) + 1
}

const subPacks = (appJson && (appJson.subpackages || appJson.subPackages)) || []
const adminPageCount = subPacks.reduce((s, x) => s + ((x.pages || []).length), 0)
/* ★ 不能用 main —— 它是 L80 那个 if 块里的 const，块级作用域拿不到（这个错 node --check 查不出来） */
const mainPageCount = ((appJson && appJson.pages) || []).length
const pageTotal = mainPageCount + adminPageCount

/** 限定词：出现这些就说明这个数字不是「总数」，跳过不检查 */
const NOT_TOTAL = /约|阶段|权限|可读写|仅管理端|所有用户|权重|比例/

/** 「N 个页面」的指向看前文 */
function pageWant(before) {
  /* ★ 取「最近」出现的那个 —— 只看「出现过」的话，一行里先提用户端后提管理端，
     两个数字会都被判成前一个从属词。 */
  const lastUser = Math.max(before.lastIndexOf('用户端'), before.lastIndexOf('主包'))
  const lastAdmin = Math.max(before.lastIndexOf('管理端'), before.lastIndexOf('分包'), before.lastIndexOf('packageAdmin'))
  if (lastUser < 0 && lastAdmin < 0) return { want: pageTotal, what: '页面合计' }
  return lastAdmin > lastUser
    ? { want: adminPageCount, what: '管理端页面数' }
    : { want: mainPageCount, what: '主包页面数' }
}

/** 数字前面点名的云函数（用于「admin 的 N 个 action」这类） */
function nsBefore(before) {
  /* ★ 必须扫整个前缀并取「最近」的那个：
     README 里是树形列表 `├── login/  … （6 个 action）`，函数名在 48 个字符之外，
     只看最后 32 个字符根本找不到它，结果被当成了总数 75。 */
  const tail = before.slice(-80)
  const re = /(login|skill|order|wallet|user|message|admin|initdb|account)/g
  let last = null, m
  while ((m = re.exec(tail))) last = m[1]
  return last
}

const docFiles = ['README.md'].concat(
  fs.readdirSync(path.join(ROOT, 'docs')).filter(f => f.endsWith('.md')).map(f => 'docs/' + f)
)

const docNumBad = new Set()
for (const f of docFiles) {
  const abs = path.join(ROOT, f)
  if (!exists(abs)) continue
  read(abs).split(/\r?\n/).forEach((line, i) => {
    const hit = (got, want, what) => {
      if (Number(got) !== want) docNumBad.add(`${f}:${i + 1}  「${got} 个${what}」实际是 ${want}`)
    }
    const before = (m) => line.slice(0, m.index)   // ★ 整个前缀 —— 从属词可能离数字很远
    /* 序号说法（第 14 个集合）不是总数，别当总数比 */
    const skip = (m) => NOT_TOTAL.test(line) || /第\s*\d+\s*个/.test(line.slice(Math.max(0, m.index - 10), m.index + 10))

    for (const m of line.matchAll(/(\d+)\s*个业务云函数/g)) hit(m[1], cfCount, '业务云函数')
    for (const m of line.matchAll(/云函数层[^\n]{0,30}?(\d+)\s*个函数/g)) hit(m[1], cfCount, '云函数')
    for (const m of line.matchAll(/(\d+)\s*个云函数/g)) hit(m[1], cfCount, '云函数')
    for (const m of line.matchAll(/(\d+)\s*个集合/g)) { if (!skip(m)) hit(m[1], colTotal, '集合') }

    /* action / 接口：前面点名了哪个云函数，就按那个函数比 */
    for (const m of line.matchAll(/(\d+)\s*个\s*(?:action|接口)/g)) {
      if (skip(m)) continue
      const ns = nsBefore(before(m))
      if (ns && actionsByNs[ns] !== undefined) hit(m[1], actionsByNs[ns], ns + ' 的 action')
      else if (!ns) hit(m[1], actionTotal, 'action')
      /* 点名了但 api.js 里查不到 —— 不猜，跳过 */
    }

    for (const m of line.matchAll(/(\d+)\s*个页面/g)) {
      if (skip(m)) continue
      const ctx = pageWant(before(m))
      hit(m[1], ctx.want, ctx.what)
    }
    for (const m of line.matchAll(/用户端\s*(\d+)\s*(?:个页面|[+＋/、])/g)) { if (!skip(m)) hit(m[1], mainPageCount, '主包页面') }
    for (const m of line.matchAll(/管理端\s*(\d+)\s*(?:个页面|[)）+＋/、])/g)) { if (!skip(m)) hit(m[1], adminPageCount, '管理端页面') }
  })
}
for (const b of docNumBad) err('文档数字过时 → ' + b)

console.log(`  云函数目录        ${C.b}${cfCount}${C.r} 个`)
console.log(`  集合常量          ${C.b}${colTotal}${C.r} 个`)
console.log(`  页面              ${C.b}${pageTotal}${C.r} 个（主包 ${mainPageCount} + 管理端 ${adminPageCount}）`)
console.log(`  文档数字比对      ${docNumBad.size ? C.red + docNumBad.size + ' 处过时' + C.r : C.b + '一致' + C.r}`)

console.log(`  已定义 action     ${C.b}${definedActions.size}${C.r} 个`)
console.log(`  mock 覆盖         ${C.b}${definedActions.size - missingMock.length}/${definedActions.size}${C.r}`)
console.log(`  require 相对引用  ${C.b}${requireCount}${C.r} 处`)
console.log(`  事件绑定检查      ${C.b}${handlerRefs}${C.r} 个处理函数`)
console.log(`  wx:for 检查       ${C.b}${forRefs}${C.r} 处`)
console.log(`  <text> 跨行检查   ${C.b}${textWrapHits}${C.r} 处违规`)
console.log(`  app.* 调用检查    ${C.b}${appRefs}${C.r} 处`)
console.log(`  模板变量检查      ${C.b}${tplVars}${C.r} 个引用`)
console.log(`  WXML 标签配对     ${C.b}${wxmlCount}${C.r} 个文件${wxmlPairBad ? `  ${C.red}${wxmlPairBad} 个不配对${C.r}` : ''}`)

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
