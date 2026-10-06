/**
 * WXML 标签配对检查
 * ------------------------------------------------------------------
 * ★ 为什么需要这个：一次真实事故 ——
 *   删掉 settings.wxml 里的一行开关时，用正则删掉了注释、标签和 `<switch />`，
 *   但**漏掉了它们外面那两层 `</view>`**，留下一个孤立的闭合标签。
 *   错误只在**开发者工具上传时**才报（`unexpected end tag: view`），
 *   而当时的三套门禁**一个都没拦住**。
 *
 *   所以把检查补进门禁：这类错误不该等到上传才发现。
 *
 * ★ 解析规则（刻意保持简单，不引入 void 标签列表）：
 *   · 自闭合 `<x />`         → 不入栈
 *   · 有显式结束标签 `<x>…</x>` → 入栈、配对
 *   · 跳过 `<!-- 注释 -->`
 *   · 跳过文本里的 `{{ … }}` —— 否则 `{{n < 0 ? 'a' : 'b'}}` 里的 `<`
 *     会被误当成标签开始（这一条是踩过坑才加的）
 *   · 标签内的属性值按引号整体跳过 —— `wx:if="{{a > b}}"` 里的 `>` 不算标签结束
 */
import fs from 'node:fs'
import path from 'node:path'

function lineOf(src, idx) {
  return src.slice(0, idx).split('\n').length
}

/** 扫描一段 wxml，返回标签配对错误列表 */
export function checkTags(src) {
  const errs = []
  const stack = []
  let i = 0

  while (i < src.length) {
    // 注释
    if (src.startsWith('<!--', i)) {
      const end = src.indexOf('-->', i + 4)
      if (end < 0) { errs.push('第 ' + lineOf(src, i) + ' 行：注释没有闭合 -->'); break }
      i = end + 3
      continue
    }
    // 文本里的插值：`{{ … }}` 内部可能出现 < >，整体跳过
    if (src.startsWith('{{', i)) {
      const end = src.indexOf('}}', i + 2)
      if (end < 0) { errs.push('第 ' + lineOf(src, i) + ' 行：插值没有闭合 }}'); break }
      i = end + 2
      continue
    }
    // 非标签字符，跳过
    if (src[i] !== '<') { i++; continue }

    // 结束标签
    if (src.startsWith('</', i)) {
      const gt = src.indexOf('>', i)
      if (gt < 0) { errs.push('第 ' + lineOf(src, i) + ' 行：结束标签没有 >'); break }
      const name = src.slice(i + 2, gt).trim()
      const top = stack.pop()
      if (!top) errs.push('第 ' + lineOf(src, i) + ' 行：多余的结束标签 </' + name + '>（没有未闭合的开始标签）')
      else if (top.name !== name) {
        errs.push('第 ' + lineOf(src, i) + ' 行：标签不匹配 —— 实际 </' + name +
          '>，但这里应该闭合第 ' + top.line + ' 行的 <' + top.name + '>')
      }
      i = gt + 1
      continue
    }

    // 开始标签：逐字符找标签结束的 >，引号内的内容整体跳过
    let j = i + 1
    let quote = ''
    while (j < src.length) {
      const ch = src[j]
      if (quote) { if (ch === quote) quote = '' }
      else if (ch === '"' || ch === "'") quote = ch
      else if (ch === '>') break
      j++
    }
    if (j >= src.length) { errs.push('第 ' + lineOf(src, i) + ' 行：开始标签没有 >'); break }

    const inner = src.slice(i + 1, j)
    const selfClose = inner.trimEnd().endsWith('/')
    const name = inner.trim().split(/[\s/]/)[0]
    if (name && !selfClose) stack.push({ name, line: lineOf(src, i) })
    i = j + 1
  }

  stack.forEach(s => errs.push('第 ' + s.line + ' 行的 <' + s.name + '> 没有闭合'))
  return errs
}

export function walk(d, out = []) {
  fs.readdirSync(d, { withFileTypes: true }).forEach(e => {
    const p = path.join(d, e.name)
    if (/ec-canvas|node_modules|(^|[\\/])backups([\\/]|$)/.test(p)) return
    if (e.isDirectory()) walk(p, out)
    else if (/\.wxml$/.test(e.name)) out.push(p)
  })
  return out
}

// ★ 只有作为命令行直接运行时才扫描并退出；
//   被 check-project.mjs import 时不应触发（否则会提前 process.exit）。
const isDirectRun = process.argv[1] && process.argv[1].endsWith('check-wxml.mjs')
if (!isDirectRun) { /* 被 import：不执行 CLI 部分 */ }
else {
const files = walk(process.argv[2] || 'Campus Time Bank')
let bad = 0
files.forEach(f => {
  const errs = checkTags(fs.readFileSync(f, 'utf8'))
  if (errs.length) {
    bad++
    console.log('  ✗ ' + f)
    errs.forEach(e => console.log('       ' + e))
  }
})
console.log('')
console.log('  扫描 ' + files.length + ' 个 wxml，标签配对有问题的：' + bad + ' 个')
console.log(bad === 0 ? '  ✓ 全部配对正确' : '  ✗ 开发者工具上传时会报 unexpected end tag')
process.exit(bad === 0 ? 0 : 1)
}
