/**
 * 聊天室（★ 技术亮点：实时消息监听）
 * ==================================================================
 * 实时方案（严格按 ARCHITECTURE.md §9）：
 *   1. 先 api.message.history 拉历史，保证首屏立刻可见
 *   2. 再建立 wx.cloud.database().collection('messages').watch() 实时监听
 *      —— snapshot.docs 就是「当前全量结果集」，直接 setData
 *   3. onError（断线 / 权限变动）→ 降级为 3 秒轮询 api.message.history
 *
 * ★ MOCK 分支（必须存在的原因）：
 *   envList.MOCK 为 true 时**没有真实云环境**，cloud.initCloud() 会直接跳过，
 *   此时调用 wx.cloud.database() 会抛错（"cloud.init 未调用 / env 未配置"），
 *   watch 根本建立不起来。为了让离线预览也能看到消息「动起来」（答辩彩排、
 *   写论文配图都靠它），MOCK 模式下不走 watch，直接用 setInterval 每 2 秒
 *   轮询 api.message.history 模拟实时下发，并在页面顶部显示「离线演示模式」。
 *
 * ★ 最易错点：连接泄漏
 *   watch() 建立的是长连接，页面销毁时**必须** watcher.close()，
 *   否则每次进出聊天室都会多留一个连接，几十次后小程序直接卡死。
 *   轮询的 setInterval 同理必须 clearInterval。
 *   所以 onUnload 里统一调用 _stopRealtime()。
 * ==================================================================
 */
const api = require('../../../utils/api')
const util = require('../../../utils/util')

/** 一次性最多渲染多少条（长列表性能：只保留最近 100 条） */
const MAX_MESSAGES = 100
/** 每页拉取条数 */
const PAGE_SIZE = 20
/** 降级轮询间隔（§9 规定 3 秒） */
const POLL_INTERVAL = 3000
/** MOCK 模拟实时间隔（2 秒，快一点便于演示） */
const MOCK_INTERVAL = 2000
/** 相邻消息超过 5 分钟才插入一条时间分隔 */
const TIME_GAP = 5 * 60 * 1000

/** 当前用户 openid 缓存：轮询每 2 秒渲染一次，避免每次都 getApp() */
let MY_ID = ''

Page({
  data: {
    chatId: '',
    toId: '',
    toName: '',
    toAvatar: '',

    /* 消息 */
    messages: [],        // 渲染用（已算好 isMine / showTime）
    scrollInto: '',
    scrollHeight: 400,

    /* 关联订单 */
    orderId: '',
    orderNo: '',

    /* 状态 */
    inputText: '',
    sending: false,
    loading: false,
    hasMore: false,      // 还有更早的历史
    loadingMore: false,
    mockMode: false,     // 离线演示模式标识
    realtimeDegraded: false, // 实时连接断开、已降级为轮询
    keyboardHeight: 0,
    /**
     * nav-bar 的颜色是「属性 → 内联 style」，属性只能传色值字符串：
     * 内联 style 里 var(--x) 在自定义组件内不保证解析，所以这里用与
     * app.json window / theme 完全一致的字面色（--c-card / --c-t1）。
     */
    navBg: '#FFFFFF',
    navColor: '#1A1D1F'
  },

  /* ================================================================
   * 生命周期
   * ================================================================ */
  onLoad(options) {
    const app = getApp()
    const opt = options || {}

    const chatId = decodeURIComponent(opt.chatId || '')
    if (!chatId) {
      util.toast('会话不存在')
      setTimeout(() => wx.navigateBack(), 800)
      return
    }

    this.setData({
      chatId: chatId,
      toId: decodeURIComponent(opt.toId || ''),
      toName: decodeURIComponent(opt.name || ''),
      toAvatar: decodeURIComponent(opt.avatar || ''),
      orderId: decodeURIComponent(opt.orderId || ''),
      mockMode: !!app.globalData.MOCK
    })

    // 动态改导航栏标题为对方昵称
    if (this.data.toName) {
      wx.setNavigationBarTitle({ title: this.data.toName })
    } else {
      // 列表页没带昵称时兜底拉一次
      this._loadCounterpartName()
    }

    this._calcScrollHeight()
    this._loadOrder()
    this.init()

    // 键盘弹出时把输入框顶上去（scroll-view 高度同步压缩，避免遮挡最后一条）
    this._onKeyboard = res => {
      const h = (res && res.height) || 0
      this.setData({ keyboardHeight: h })
      this._calcScrollHeight(h)
    }
    wx.onKeyboardHeightChange(this._onKeyboard)

    // 进入即标记已读
    this.markRead()
  },

  onShow() {
    // onLoad 里已经标记过一次，首次 onShow 跳过，避免重复请求
    if (!this._firstShow) {
      this._firstShow = true
      return
    }
    // 从订单详情等页面返回，重新标记已读
    if (this.data.chatId) this.markRead()
  },

  onUnload() {
    // ★★ 必须：关闭 watch 长连接 + 清掉轮询定时器，否则连接泄漏
    this._destroyed = true
    this._stopRealtime()
    if (this._onKeyboard) {
      wx.offKeyboardHeightChange(this._onKeyboard)
      this._onKeyboard = null
    }
    const app = getApp()
    app.refreshTabBadge()
  },

  /* ================================================================
   * 初始化：历史 + 实时
   * ================================================================ */
  async init() {
    await this.loadHistory(1)
    this._startRealtime()
  },

  /** 拉取历史（page 1 = 最新一页） */
  async loadHistory(page) {
    if (this.data.loading) return
    this.setData({ loading: true })
    try {
      const res = await api.message.history({
        chatId: this.data.chatId,
        page: page,
        size: PAGE_SIZE
      })
      const list = (res && res.list) || []
      // 兜底：setData 不允许 undefined
      const merged = page === 1 ? list : list.concat(this._raw || [])
      this._raw = merged
      this._historyPage = page
      // 只保留最近 MAX_MESSAGES 条（长列表性能，旧的靠上滑加载补回）
      const sliced = merged.slice(-MAX_MESSAGES)
      this._render(sliced)
      this.setData({ hasMore: !!(res && res.hasMore) })
    } catch (e) {
      util.toast(e.message)
    } finally {
      this.setData({ loading: false })
    }
  },

  /**
   * 建立实时监听
   * MOCK → 定时轮询；真实环境 → db.watch()，出错降级轮询
   */
  _startRealtime() {
    const app = getApp()
    const chatId = this.data.chatId

    // ---------- 分支一：离线演示模式（无云环境，watch 必然报错）----------
    if (app.globalData.MOCK) {
      this._startPolling(MOCK_INTERVAL, true)
      return
    }

    // ---------- 分支二：真实云端 watch ----------
    try {
      const db = wx.cloud.database()
      this.watcher = db.collection('messages')
        .where({ chatId: chatId })
        .orderBy('createTime', 'asc')
        .watch({
          onChange: snapshot => {
            // snapshot.docs 即当前结果集，直接渲染
            const docs = (snapshot && snapshot.docs) || []
            this._raw = docs
            this._render(docs.slice(-MAX_MESSAGES))
            this.setData({ realtimeDegraded: false })
          },
          onError: err => {
            // 实时连接失败 → 降级为 3 秒轮询，并提示用户
            console.warn('[chat] watch 失败，降级轮询：', err && (err.errMsg || err.message))
            if (this.watcher) {
              try { this.watcher.close() } catch (e) {}
              this.watcher = null
            }
            this.setData({ realtimeDegraded: true })
            util.toast('实时连接已断开，已切换轮询')
            this._startPolling(POLL_INTERVAL, false)
          }
        })
    } catch (e) {
      // 云环境未就绪等情况，同样降级，保证功能可用
      console.warn('[chat] 无法建立 watch，降级轮询：', e.message)
      this.setData({ realtimeDegraded: true })
      this._startPolling(POLL_INTERVAL, false)
    }
  },

  /** 轮询降级方案 */
  _startPolling(interval, isMock) {
    this._stopPolling()
    this.pollTimer = setInterval(async () => {
      // 页面已销毁就直接退出，避免在已卸载的页面上 setData
      if (this._destroyed) return
      try {
        const res = await api.message.history({
          chatId: this.data.chatId,
          page: 1,
          size: PAGE_SIZE
        })
        const docs = (res && res.list) || []
        this._raw = docs
        this._render(docs.slice(-MAX_MESSAGES))
        this.markRead(true)   // silent
      } catch (e) {
        // 轮询失败静默处理，下一次继续
      }
    }, interval || POLL_INTERVAL)
    if (isMock) this.setData({ mockMode: true })
  },

  /** 停止一切实时通道（★ 关键：页面销毁必须调用） */
  _stopRealtime() {
    if (this.watcher) {
      try { this.watcher.close() } catch (e) {}
      this.watcher = null
    }
    this._stopPolling()
  },

  _stopPolling() {
    if (this.pollTimer) {
      clearInterval(this.pollTimer)
      this.pollTimer = null
    }
  },

  /* ================================================================
   * 渲染处理
   * ================================================================ */
  /** 计算 isMine / 时间分隔 / 滚动锚点 */
  _render(list) {
    // 登录是异步的，openid 可能还没回来 → 每次渲染时惰性补齐
    if (!MY_ID) MY_ID = getApp().globalData.openid || ''
    const myId = MY_ID
    const rows = []
    let lastTime = 0

    ;(list || []).forEach((m, i) => {
      const msg = m || {}
      const t = msg.createTime ? new Date(msg.createTime).getTime() : 0
      // 相邻消息超过 5 分钟才显示一次时间分隔
      const showTime = !!t && (i === 0 || t - lastTime > TIME_GAP)
      if (t) lastTime = t
      const isImage = msg.type === 'image'
      rows.push({
        _id: msg._id || ('local_' + i),
        isMine: !!msg.fromId && msg.fromId === myId,
        isImage: isImage,
        content: isImage ? '' : (msg.content || ''),
        image: isImage ? (msg.content || '') : '',
        showTime: showTime,
        timeText: showTime && t ? util.chatTime(msg.createTime) : ''
      })
    })

    // 滚动锚点固定在列表底部的占位元素上
    this.setData({
      messages: rows,
      scrollInto: rows.length ? 'msg-bottom' : ''
    })
  },

  /** 文案兜底：列表页没带昵称时拉一次对方公开资料 */
  async _loadCounterpartName() {
    if (!this.data.toId) return
    try {
      const res = await api.login.getUser({ openid: this.data.toId })
      const u = (res && res.user) || {}
      const name = u.nickName || '聊天'
      this.setData({ toName: name, toAvatar: u.avatarUrl || this.data.toAvatar })
      wx.setNavigationBarTitle({ title: name })
    } catch (e) {
      wx.setNavigationBarTitle({ title: '聊天' })
    }
  },

  /** 有关联订单时，导航栏右侧显示「查看订单」 */
  async _loadOrder() {
    if (!this.data.orderId) return
    try {
      const res = await api.order.detail({ orderId: this.data.orderId })
      const order = (res && res.order) || {}
      this.setData({ orderNo: order.orderNo || '' })
    } catch (e) {
      // 无权查看（例如订单已被删除）则隐藏入口，不打扰用户
      this.setData({ orderId: '' })
    }
  },

  /** 计算 scroll-view 高度：窗口高 - 状态栏 - 导航栏 - 输入区 - 键盘 */
  _calcScrollHeight(keyboardH) {
    const app = getApp()
    const g = app.globalData || {}
    let winH = 667
    let winW = 375
    try {
      const win = wx.getWindowInfo ? wx.getWindowInfo() : wx.getSystemInfoSync()
      winH = win.windowHeight || winH
      winW = win.windowWidth || winW
    } catch (e) { /* 忽略，用默认值兜底 */ }

    // 输入栏实际高度（rpx → px）：上下 16rpx 内边距 + 输入框 72rpx + 底部安全区
    const safeBottom = g.safeBottom || 0
    const inputBar = Math.round((16 + 72 + 16) * winW / 750) + safeBottom
    const navTotal = (g.statusBarHeight || 20) + (g.navBarHeight || 44)
    const kb = keyboardH || 0
    const h = Math.max(200, Math.round(winH - navTotal - inputBar - kb))
    this.setData({ scrollHeight: h })
  },

  /* ================================================================
   * 发送
   * ================================================================ */
  onInput(e) {
    this.setData({ inputText: e.detail.value || '' })
  },

  /** 输入框失焦（发送按钮点击时也应先收键盘） */
  onBlur() {
    this.setData({ keyboardHeight: 0 })
    this._calcScrollHeight(0)
  },

  /** 发送文本 */
  async onSend() {
    const text = util.trimAll(this.data.inputText)
    if (!text) {
      util.toast('请输入内容')
      return
    }
    if (this.data.sending) return
    this.setData({ sending: true })

    try {
      await api.message.send({
        chatId: this.data.chatId,
        toId: this.data.toId,
        content: text,
        type: 'text'
      })
      // 发送后立刻清空输入并滚到底
      this.setData({ inputText: '', scrollInto: 'msg-bottom' })
    } catch (e) {
      util.toast(e.message)
    } finally {
      this.setData({ sending: false })
    }
  },

  /** 发送图片：选图 → 上传云存储 → 发 image 消息 */
  async onSendImage() {
    if (this.data.sending) return
    try {
      const paths = await util.chooseImage(1)
      const local = (paths && paths[0]) || ''
      if (!local) return

      this.setData({ sending: true })
      const app = getApp()
      let fileId = local
      if (app.globalData.MOCK) {
        // 离线模式没有云存储，直接用本地临时路径当图片地址展示
        fileId = local
      } else {
        util.loading('上传中')
        fileId = await util.uploadFile(local, 'chat')
        util.hideLoading()
      }

      await api.message.send({
        chatId: this.data.chatId,
        toId: this.data.toId,
        content: fileId,
        type: 'image'
      })
      // 发送成功后不需要自己插消息：
      // 真实环境 watch 会推回来，MOCK 环境下一次轮询（2 秒内）就会出现
      this.setData({ scrollInto: 'msg-bottom' })
    } catch (e) {
      util.hideLoading()
      util.toast(e.message)
    } finally {
      this.setData({ sending: false })
    }
  },

  /** 点击图片放大预览 */
  onPreview(e) {
    const url = e.currentTarget.dataset.url
    const urls = this.data.messages.filter(m => m.isImage && m.image).map(m => m.image)
    util.previewImage(urls, url)
  },

  /* ================================================================
   * 已读 / 订单
   * ================================================================ */
  async markRead(silent) {
    if (!this.data.chatId) return
    try {
      await api.message.read({ chatId: this.data.chatId })
    } catch (e) {
      if (!silent) util.toast(e.message)
    }
  },

  /** 导航栏右侧「查看订单」 */
  goOrder() {
    if (!this.data.orderId) return
    wx.navigateTo({ url: '/pages/order/detail/detail?orderId=' + this.data.orderId })
  },

  /** 上滑到顶：加载更早的历史（长列表分页） */
  async onScrollUpper() {
    if (this.data.loadingMore || !this.data.hasMore) return
    // scroll-upper 是「到达顶部」时触发，这里再补一层时间节流，避免抖动反复请求
    const now = Date.now()
    if (this._upperLock && now - this._upperLock < 800) return
    this._upperLock = now

    this.setData({ loadingMore: true })
    const nextPage = (this._historyPage || 1) + 1
    try {
      const res = await api.message.history({
        chatId: this.data.chatId,
        page: nextPage,
        size: PAGE_SIZE
      })
      const list = (res && res.list) || []
      const hasMore = !!(res && res.hasMore)
      if (list.length) {
        this._historyPage = nextPage
        const merged = list.concat(this._raw || [])
        this._raw = merged
        this._render(merged.slice(-MAX_MESSAGES))
      }
      this.setData({ hasMore: hasMore })
    } catch (e) {
      // 翻页失败不打断聊天，静默即可（toast 会盖住输入框）
      console.warn('[chat] 加载更早消息失败：', e.message)
    } finally {
      this.setData({ loadingMore: false })
    }
  },

  onShareAppMessage() {
    return { title: '校园时间银行 · 用技能换技能', path: '/pages/square/square' }
  }
})
