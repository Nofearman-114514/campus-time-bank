/**
 * 管理端页面守卫
 * ==================================================================
 * 8 个管理端页面在 onLoad 里统一调用：
 *
 *   const guard = require('../../utils/guard')
 *   async onLoad() {
 *     if (!(await guard.requireAdmin(this))) return   // 非管理员：已 toast + 返回
 *     ...
 *   }
 *
 * 说明：
 *   · 鉴权以 app.isAdminUser()（内部走 api.admin.check，带缓存）为准；
 *   · 非管理员：toast「无管理员权限」→ 延时 navigateBack；
 *     若当前是页面栈唯一页面（如开发者工具直接编译进入），navigateBack 会失败，
 *     此时降级 reLaunch 到「我的」页，避免出现白屏死页。
 * ==================================================================
 */
const util = require('../../utils/util')

/** navigateBack，失败时回退到主包「我的」页 */
function backOrHome() {
  wx.navigateBack({
    delta: 1,
    fail: () => {
      wx.reLaunch({
        url: '/pages/mine/mine',
        fail: () => wx.switchTab({ url: '/pages/mine/mine' })
      })
    }
  })
}

/**
 * @param {Object} pageVm 页面实例（this），用于挂载 _isAdmin 标记
 * @returns {Promise<Boolean>} 是否管理员
 */
async function requireAdmin(pageVm) {
  const app = getApp()
  let ok = false
  try {
    ok = await app.isAdminUser()
  } catch (e) {
    ok = false
  }

  if (pageVm) pageVm._isAdmin = !!ok
  if (ok) return true

  util.toast('无管理员权限')
  setTimeout(backOrHome, 900)
  return false
}

module.exports = { requireAdmin, backOrHome }
