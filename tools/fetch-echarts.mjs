/**
 * 下载 ECharts 小程序适配器到管理端分包
 * ------------------------------------------------------------------
 * 用法（项目根目录）：
 *     node tools/fetch-echarts.mjs
 *
 * 说明：仓库里已经包含下载好的文件（Campus Time Bank/packageAdmin/components/ec-canvas/）。
 * 本脚本仅用于「重新下载 / 升级版本」，正常开发不需要执行。
 * ------------------------------------------------------------------
 * 为什么 ECharts 放在分包里？
 *   主包体积上限 2MB，echarts.min.js 约 1MB，
 *   放进 packageAdmin 分包后只有管理员进入看板时才下载，不影响普通用户体验。
 * ------------------------------------------------------------------
 */
import fs from 'node:fs'
import path from 'node:path'
import url from 'node:url'
import https from 'node:https'

const __dirname = path.dirname(url.fileURLToPath(import.meta.url))
const DEST = path.resolve(__dirname, '../Campus Time Bank/packageAdmin/components/ec-canvas')

const EC_VERSION = 'master'
const ECHARTS_VERSION = '5.5.1'

const TARGETS = [
  { name: 'ec-canvas.js', url: `https://cdn.jsdelivr.net/gh/ecomfe/echarts-for-weixin@${EC_VERSION}/ec-canvas/ec-canvas.js` },
  { name: 'ec-canvas.json', url: `https://cdn.jsdelivr.net/gh/ecomfe/echarts-for-weixin@${EC_VERSION}/ec-canvas/ec-canvas.json` },
  { name: 'ec-canvas.wxml', url: `https://cdn.jsdelivr.net/gh/ecomfe/echarts-for-weixin@${EC_VERSION}/ec-canvas/ec-canvas.wxml` },
  { name: 'ec-canvas.wxss', url: `https://cdn.jsdelivr.net/gh/ecomfe/echarts-for-weixin@${EC_VERSION}/ec-canvas/ec-canvas.wxss` },
  { name: 'wx-canvas.js', url: `https://cdn.jsdelivr.net/gh/ecomfe/echarts-for-weixin@${EC_VERSION}/ec-canvas/wx-canvas.js` },
  { name: 'echarts.js', url: `https://cdn.jsdelivr.net/npm/echarts@${ECHARTS_VERSION}/dist/echarts.min.js` }
]

function download(u, dest) {
  return new Promise((resolve, reject) => {
    https.get(u, res => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        return download(res.headers.location, dest).then(resolve, reject)
      }
      if (res.statusCode !== 200) {
        return reject(new Error(`HTTP ${res.statusCode}`))
      }
      const chunks = []
      res.on('data', c => chunks.push(c))
      res.on('end', () => {
        fs.writeFileSync(dest, Buffer.concat(chunks))
        resolve(Buffer.concat(chunks).length)
      })
    }).on('error', reject)
  })
}

async function main() {
  fs.mkdirSync(DEST, { recursive: true })
  console.log(`下载目标目录：${DEST}\n`)

  for (const t of TARGETS) {
    const dest = path.join(DEST, t.name)
    try {
      const size = await download(t.url, dest)
      console.log(`  ✓ ${t.name.padEnd(16)} ${(size / 1024).toFixed(1)} KB`)
    } catch (e) {
      console.error(`  ✗ ${t.name.padEnd(16)} ${e.message}`)
      console.error(`    可以手动下载：${t.url}`)
    }
  }

  console.log('\n完成。若 echarts.js 下载失败，也可从 https://echarts.apache.org/zh/download.html 获取后重命名为 echarts.js 放入上述目录。')
}

main()
