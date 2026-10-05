/**
 * 地图选点
 * ------------------------------------------------------------------
 * 1) <map> 铺满屏幕，markers 显示当前定位
 * 2) 支持「用微信地图选点」→ wx.chooseLocation()，也可点地图 / 拖动地图微调
 * 3) 确认后：写 wx.setStorageSync('pickedLocation') + navigateBack，
 *    同时通过 getOpenerEventChannel().emit('pickedLocation') 回传（发布页优先用事件通道）
 * ------------------------------------------------------------------
 */
const util = require('../../../utils/util')
const campus = require('../../../utils/campus')

Page({
  data: {
    // ★ 默认中心 = 校园中心（1 栋），不再写死北京。
    //   定位失败时地图也不会飘到别的城市，用户一眼能认出这是学校。
    latitude: campus.CENTER.lat,
    longitude: campus.CENTER.lng,
    // 校园跨度约 600 米，16 级能一眼看到大半
    scale: 16,
    markers: [],
    mapHeight: 0,

    /** 校内常用地点：点一下直接选中，用户不必跟经纬度打交道 */
    spots: campus.SPOTS,

    /* 当前选中地点 */
    picked: null,          // { name, address, latitude, longitude }
    nearText: '',          // 「最近：山下饭堂 约 76 米」
    rejectText: '',        // 选到校外时的红字说明
    denied: false,         // 用户拒绝授权定位
    locating: false
  },

  /* ================================================================
   * 生命周期
   * ================================================================ */
  onLoad() {
    // 打开本页的页面事件通道（发布页用它接收选点结果）
    try {
      this._channel = this.getOpenerEventChannel && this.getOpenerEventChannel()
    } catch (e) {
      this._channel = null
    }

    this.setData({ mapHeight: this._screenHeight() })

    // 若之前选过点，先回显
    let last = null
    try {
      last = wx.getStorageSync('pickedLocation') || null
    } catch (e) {
      last = null
    }
    if (last && last.latitude && last.longitude) {
      this.setData({ picked: last })
    }

    this.locate(true)
  },

  /** 地图高度：整屏（px），底部卡片浮在其上 */
  _screenHeight() {
    const app = getApp()
    const info = (app && app.globalData && app.globalData.systemInfo) || {}
    const h = Number(info.windowHeight) || 0
    if (h) return h
    try {
      const w = wx.getWindowInfo ? wx.getWindowInfo() : wx.getSystemInfoSync()
      return Number(w.windowHeight) || 600
    } catch (e) {
      return 600
    }
  },

  /* ================================================================
   * 定位
   * ================================================================ */
  async locate(force) {
    if (this.data.locating) return
    this.setData({ locating: true })
    const app = getApp()
    let loc = null
    try {
      loc = await app.getLocation(!!force)
    } catch (e) {
      loc = null
    }
    this.setData({ locating: false })

    if (!loc) {
      // 拒绝授权：不再反复弹窗，改为给出「去设置」引导
      this.setData({ denied: true, markers: [] })
      util.toast('未获取到定位，可手动选点或去设置开启')
      return
    }

    const near = campus.nearest(loc.latitude, loc.longitude)
    const close = near && near.distance <= 300
    this.setData({ denied: false })

    // ★ 只有用户**确实在校园范围内**才把地图挪过去。
    //   校园 App 的绝大多数地点都在校内；如果此刻人在校外（在家 / 在路上），
    //   跟着实际定位走会让地图直接离开校园，用户反而找不到要选的地方。
    const toCampus = campus.distanceMeters(
      campus.CENTER.lat, campus.CENTER.lng, loc.latitude, loc.longitude
    )

    if (this.data.picked) {
      // 已经有明确选点：只在地图上补一个「我的位置」标记，不覆盖也不挪图
      this.setData({
        markers: this.data.markers.concat(this.markerOf(loc.latitude, loc.longitude, '我的位置', 2))
      })
      return
    }

    if (toCampus > 3000) {
      // 人在校外：停在校园地图上，并说明原因
      util.toast('你当前不在校园范围内，已停留在校园地图')
      this.setData({ markers: this.markerOf(loc.latitude, loc.longitude, '我的位置', 2) })
      return
    }

    this.showPoint(
      loc.latitude,
      loc.longitude,
      app.globalData.locationName || (close ? near.spot.locationName : '我的位置'),
      close ? `${near.spot.address}（约 ${near.distance} 米）` : '',
      near ? `最近：${near.spot.name} 约 ${near.distance} 米` : ''
    )
  },

  /** 造一个标记对象（无图片资源，用 callout 承载文字）。id 用于区分「选点」与「我的位置」 */
  markerOf(lat, lng, text, id) {
    return [{
      id: id || 1,
      latitude: lat,
      longitude: lng,
      width: 32,
      height: 32,
      callout: {
        content: text || '已选地点',
        color: '#1A1D1F',
        fontSize: 12,
        borderRadius: 8,
        borderWidth: 0,
        bgColor: '#FFFFFF',
        padding: 6,
        display: 'ALWAYS',
        textAlign: 'center'
      }
    }]
  },

  /**
   * 统一的选点展示：落 marker + 更新底部卡片 + 最近地点提示。
   *
   * ★ 这一层是「让人看得懂」的关键：
   *   历史上有过「点地图只改底部坐标、地图上不落标记」的写法，用户根本不知道选到了哪。
   */
  showPoint(lat, lng, name, address, nearText) {
    this.setData({
      latitude: lat,
      longitude: lng,
      nearText: nearText || '',
      picked: { name: name || '地图选点', address: address || '', latitude: lat, longitude: lng },
      markers: this.markerOf(lat, lng, name)
    })
  },

  /**
   * ★ 安全策略关卡：坐标必须在校内。
   *   校外的地点一旦出现纠纷或意外，校方无法及时处理 —— 所以直接拦下，
   *   并把「为什么」显示在卡片上，而不是默默不响应（那样用户只会以为卡了）。
   * @returns {Boolean} true = 校内，可继续
   */
  checkInside(lat, lng) {
    const chk = campus.isInside(lat, lng)
    if (chk.inside) {
      if (this.data.rejectText) this.setData({ rejectText: '' })
      return true
    }
    const km = chk.distance >= 1000
      ? (chk.distance / 1000).toFixed(1) + ' 公里'
      : chk.distance + ' 米'
    this.setData({
      rejectText: `这里在校外（距校园约 ${km}），不能选。校内任务出了问题校方能及时处理，校外处理不了。`
    })
    util.toast('只能选择校内的地点')
    return false
  },

  /**
   * 点击地图 → 设为选中地点，并**就近推断中文名**。
   *
   * 300 米内认为是「在某个校内地点」，直接用它的中文名；
   * 否则退回坐标，但仍然把「最近的地点 + 距离」告诉用户 —— 比一串裸数字好懂得多。
   */
  onMapTap(e) {
    const lat = Number(e.detail && e.detail.latitude)
    const lng = Number(e.detail && e.detail.longitude)
    if (!lat || !lng) return
    if (!this.checkInside(lat, lng)) return

    const near = campus.nearest(lat, lng)
    const close = near && near.distance <= 300
    this.showPoint(
      lat, lng,
      close ? near.spot.locationName : '地图选点',
      close ? `${near.spot.address}（约 ${near.distance} 米）` : '',
      near ? `最近：${near.spot.name} 约 ${near.distance} 米` : ''
    )
  },

  /** 点「校内常用地点」按钮 → 精确选中该地点（不需要任何坐标知识） */
  onPickSpot(e) {
    const p = campus.byKey(e.currentTarget.dataset.key)
    if (!p) return
    const d = campus.distanceMeters(campus.CENTER.lat, campus.CENTER.lng, p.lat, p.lng)
    this.showPoint(p.lat, p.lng, p.locationName, p.address, `距 1 栋（山下）约 ${d} 米`)
  },

  /** 拖动地图结束 → 以地图中心为选中地点 */
  onRegionChange(e) {
    if (!e.detail || e.type !== 'end') return
    const c = e.detail.centerLocation
    if (!c || this.data.picked) return   // 已有明确选点时不被拖动覆盖
    this.setData({
      latitude: c.latitude,
      longitude: c.longitude
    })
  },

  /* ================================================================
   * 微信地图选点
   * ================================================================ */
  async onChooseInMap() {
    try {
      const res = await util.chooseLocation()
      if (!res) return    // 用户取消
      // ★ 微信地图选点也可能选到校外，同样要拦
      if (!this.checkInside(Number(res.latitude), Number(res.longitude))) return
      this.setData({
        latitude: res.latitude,
        longitude: res.longitude,
        picked: {
          name: res.name || '未命名地点',
          address: res.address || '',
          latitude: res.latitude,
          longitude: res.longitude
        },
        markers: [{
          id: 1,
          latitude: res.latitude,
          longitude: res.longitude,
          width: 32,
          height: 32,
          callout: {
            content: res.name || '已选地点',
            color: '#1A1D1F',
            fontSize: 12,
            borderRadius: 8,
            borderWidth: 0,
            bgColor: '#FFFFFF',
            padding: 6,
            display: 'ALWAYS',
            textAlign: 'center'
          }
        }]
      })
    } catch (e) {
      util.toast('选点失败，请检查位置权限')
    }
  },

  /** 回到我的位置 */
  async onBackToMe() {
    await this.locate(true)
  },

  /** 去设置页开启位置权限 */
  onOpenSetting() {
    wx.openSetting({
      success: res => {
        const ok = !!(res && res.authSetting && res.authSetting['scope.userLocation'])
        if (ok) this.locate(true)
        else util.toast('仍未开启位置权限')
      },
      fail: () => util.toast('打开设置失败')
    })
  },

  /* ================================================================
   * 确认选择
   * ================================================================ */
  onConfirm() {
    const p = this.data.picked
    if (!p || !p.latitude || !p.longitude) {
      return util.toast('请先在地图上选择地点')
    }
    // ★ 最后一道客户端关卡（云端 skill.create 还会再校验一次）
    if (!this.checkInside(Number(p.latitude), Number(p.longitude))) return
    const payload = {
      name: p.name || '',
      address: p.address || '',
      latitude: p.latitude,
      longitude: p.longitude
    }

    // 方式一：事件通道回传（发布页优先使用）
    if (this._channel && typeof this._channel.emit === 'function') {
      try {
        this._channel.emit('pickedLocation', payload)
      } catch (e) { /* 通道不可用时忽略 */ }
    }

    // 方式二：本地存储兜底
    try {
      wx.setStorageSync('pickedLocation', payload)
    } catch (e) { /* 存储失败不影响返回 */ }

    util.toastOk('地点已选择')
    setTimeout(() => util.navBack(1), 400)
  },

  /** 取消 */
  onCancel() {
    util.navBack(1)
  }
})
