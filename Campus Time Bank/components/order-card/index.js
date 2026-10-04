/**
 * 订单卡片
 * ------------------------------------------------------------------
 * <order-card item="{{item}}" bindcard="onCard" bindaction="onAction" />
 * item 需带 role 字段（'buyer' | 'seller'），order.list / order.detail 会返回。
 * action 事件 detail：{ action, item }
 *   action ∈ accept | reject | cancel | finish | confirm | chat | review | detail
 * ------------------------------------------------------------------
 */
const DURATION_TEXT = {
  30: '30 分钟', 60: '1 小时', 90: '1.5 小时', 120: '2 小时',
  150: '2.5 小时', 180: '3 小时', 240: '4 小时'
}

const STATUS_TEXT = {
  waiting: '待接单',
  ongoing: '服务中',
  confirming: '待确认',
  finished: '已完成',
  canceled: '已取消',
  closed: '已关闭'
}

const COVER_ICON = {
  学业辅导: '📚', 技能教学: '🎸', 摄影修图: '📷', 代取代买: '🛵',
  电脑技术: '💻', 运动健身: '🏃', 生活服务: '🧺', 设计美工: '🎨',
  语言互助: '🌏', 其他: '✨'
}

const COVER_PALETTE = {
  c1: ['#4FA8FF', '#2563EB'], c2: ['#A78BFA', '#7C5CFF'],
  c3: ['#FB923C', '#EA580C'], c4: ['#34D399', '#059669'],
  c5: ['#22D3EE', '#0891B2'], c6: ['#F472B6', '#DB2777'],
  c7: ['#FBBF24', '#D97706'], c8: ['#F87171', '#DC2626'],
  c9: ['#60A5FA', '#3B82F6'], c10: ['#9CA3AF', '#6B7280']
}

Component({
  options: { addGlobalClass: true },

  properties: {
    item: { type: Object, value: {} },
    /** 不传则用 item.role */
    role: { type: String, value: '' },
    /** 是否显示底部的操作按钮 */
    showActions: { type: Boolean, value: true },
    /** 头部右上角显示「我买到的 / 我接的单」 */
    showRoleTag: { type: Boolean, value: false }
  },

  data: {
    statusText: '',
    statusKey: '',
    coverBg: '',
    coverIcon: '✨',
    hasImage: false,
    durationText: '',
    roleText: '',
    counterpartTitle: '',
    counterpart: {},
    actions: [],
    rated: false
  },

  observers: {
    'item, role': function (it, role) {
      const o = it || {}
      const r = role || o.role || 'buyer'
      const snap = o.skillSnapshot || {}
      const pair = COVER_PALETTE[o.categoryId] || COVER_PALETTE.c10
      const images = snap.images || []

      const rated = r === 'buyer' ? !!o.isRatedBuyer : !!o.isRatedSeller

      this.setData({
        statusText: STATUS_TEXT[o.status] || '未知',
        statusKey: o.status || 'closed',
        coverBg: `linear-gradient(135deg,${pair[0]},${pair[1]})`,
        coverIcon: COVER_ICON[snap.categoryName] || '✨',
        hasImage: images.length > 0,
        durationText: DURATION_TEXT[snap.duration] || (snap.duration ? snap.duration + ' 分钟' : ''),
        roleText: r === 'buyer' ? '我买到的' : '我接的单',
        counterpartTitle: r === 'buyer' ? '服务者' : '买家',
        counterpart: (r === 'buyer' ? o.sellerInfo : o.buyerInfo) || {},
        rated,
        actions: this._buildActions(o, r, rated)
      })
    }
  },

  methods: {
    _buildActions(o, role, rated) {
      const a = []
      const st = o.status
      if (st === 'waiting') {
        if (role === 'seller') {
          a.push({ key: 'reject', text: '无法接单', type: 'gray' })
          a.push({ key: 'accept', text: '接单', type: 'primary' })
        } else {
          a.push({ key: 'chat', text: '联系 TA', type: 'ghost' })
          a.push({ key: 'cancel', text: '取消订单', type: 'gray' })
        }
      } else if (st === 'ongoing') {
        if (role === 'seller') {
          a.push({ key: 'chat', text: '联系买家', type: 'ghost' })
          a.push({ key: 'finish', text: '标记完成', type: 'primary' })
        } else {
          a.push({ key: 'cancel', text: '取消订单', type: 'gray' })
          a.push({ key: 'chat', text: '联系 TA', type: 'ghost' })
        }
      } else if (st === 'confirming') {
        if (role === 'buyer') {
          a.push({ key: 'chat', text: '联系 TA', type: 'ghost' })
          a.push({ key: 'confirm', text: '确认完成', type: 'primary' })
        } else {
          a.push({ key: 'chat', text: '催一下', type: 'gray' })
        }
      } else if (st === 'finished') {
        if (!rated) a.push({ key: 'review', text: '去评价', type: 'accent' })
        else a.push({ key: 'chat', text: '再约一次', type: 'gray' })
      } else {
        a.push({ key: 'chat', text: '联系 TA', type: 'gray' })
      }
      return a.slice(0, 2)
    },

    onCard() {
      this.triggerEvent('card', { item: this.data.item })
    },

    onAction(e) {
      const action = e.currentTarget.dataset.action
      // 按钮点击不冒泡到整卡
      this.triggerEvent('action', { action, item: this.data.item })
    },

    noop() {}
  }
})
