/**
 * 云函数调用封装
 * ------------------------------------------------------------------
 * 职责：统一入口 → 超时控制 → 错误归一 → 离线模拟分发 → 调试日志
 * 页面不要直接用这个文件，请用 utils/api.js
 * ------------------------------------------------------------------
 */
const envList = require('../envList')
const { envId, DEBUG, TIMEOUT } = envList
/** ★ 每次调用都重新求值：管理员切换调试模式后无需重启 */
const isMock = () => envList.isMock()

let _inited = false

/** 懒初始化云开发（避免在 MOCK 模式下报错） */
function initCloud() {
  if (_inited || isMock() || !envId) return
  wx.cloud.init({ env: envId, traceUser: true })
  _inited = true
  log('云开发已初始化, env =', envId)
}

function log() {
  if (DEBUG) console.log.apply(console, ['[cloud]'].concat(Array.prototype.slice.call(arguments)))
}

/** 业务异常（携带 code，页面可据此做特殊处理） */
class BizError extends Error {
  constructor(code, msg, data) {
    super(msg || '操作失败')
    this.name = 'BizError'
    this.code = code
    this.data = data
  }
}

/** 带超时的 Promise */
function withTimeout(promise, ms, tag) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new BizError(-1, `请求超时（${tag}），请检查网络`)), ms)
    promise.then(
      v => { clearTimeout(timer); resolve(v) },
      e => { clearTimeout(timer); reject(e) }
    )
  })
}

/** 判断是否为可重试的网络类错误 */
function isRetryable(err) {
  const msg = String((err && (err.errMsg || err.message)) || '')
  return /timeout|fail|network|ECONN|连接|超时/i.test(msg)
}

/**
 * 调用云函数
 * @param {String} name   云函数名
 * @param {Object} data   { action, ...payload }
 * @param {Object} opts   { retry:Number, timeout:Number, silent:Boolean }
 * @returns {Promise<any>} 云函数返回体中的 data 字段
 */
async function call(name, data, opts) {
  const options = Object.assign({ retry: 1, timeout: TIMEOUT, silent: false }, opts || {})
  const action = data && data.action
  const tag = `${name}.${action}`

  /* ---------------- 离线模拟模式 ---------------- */
  if (isMock()) {
    const mock = require('./mock')
    log('MOCK →', tag, data)
    try {
      const res = await mock.dispatch(name, data || {})
      log('MOCK ←', tag, res)
      return res
    } catch (e) {
      if (e instanceof BizError) throw e
      throw new BizError(500, e.message || '模拟数据异常')
    }
  }

  /* ---------------- 真实云函数 ---------------- */
  initCloud()
  if (!envId) throw new BizError(401, '未配置云开发环境 ID，请打开 miniprogram/envList.js 填写')

  let lastErr = null
  for (let i = 0; i <= options.retry; i++) {
    try {
      log('→', tag, data)
      const res = await withTimeout(
        wx.cloud.callFunction({ name, data: data || {} }),
        options.timeout,
        tag
      )
      const result = res && res.result
      if (!result) throw new BizError(500, '云函数无返回，请确认已上传部署 ' + name)

      log('←', tag, result)
      if (result.code !== 0) throw new BizError(result.code, result.msg || '操作失败', result.data)
      return result.data
    } catch (e) {
      lastErr = e
      if (e instanceof BizError && e.code !== -1) break // 业务错误不重试
      if (i < options.retry && isRetryable(e)) {
        log('重试', tag, i + 1)
        await new Promise(r => setTimeout(r, 400 * (i + 1)))
        continue
      }
      break
    }
  }

  if (lastErr instanceof BizError) throw lastErr
  const msg = String((lastErr && (lastErr.errMsg || lastErr.message)) || '网络异常')
  if (/FunctionName parameter could not be found|not found/i.test(msg)) {
    throw new BizError(500, `云函数「${name}」未部署，请在 cloudfunctions 目录右键上传部署`)
  }
  throw new BizError(500, msg.replace(/^cloud\.callFunction:fail\s*/, ''))
}

module.exports = { call, initCloud, BizError, log }
