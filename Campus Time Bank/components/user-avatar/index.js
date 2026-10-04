/**
 * 用户头像
 * ------------------------------------------------------------------
 * 没有 avatarUrl 时自动降级为「昵称首字 + 稳定渐变色」头像，
 * 因此项目**不需要任何图片资源**也能有完整的视觉表现。
 * ------------------------------------------------------------------
 */
const PALETTE = [
  ['#12B98A', '#0B8A66'],
  ['#4FA8FF', '#3B82F6'],
  ['#FFA05C', '#F2701F'],
  ['#A78BFA', '#7C5CFF'],
  ['#FB7185', '#E11D48'],
  ['#34D399', '#059669'],
  ['#FBBF24', '#D97706'],
  ['#60A5FA', '#2563EB']
]

Component({
  options: { addGlobalClass: true },

  properties: {
    url: { type: String, value: '' },
    name: { type: String, value: '' },
    /** 's' 64rpx | 'm' 88rpx | 'l' 128rpx | 'xl' 160rpx，也可直接传数字(rpx) */
    size: { type: null, value: 'm' },
    /** 是否显示信用分角标 */
    showCredit: { type: Boolean, value: false },
    credit: { type: Number, value: 0 },
    /** 是否显示「已认证」小勾 */
    verified: { type: Boolean, value: false },
    /** 是否显示白色描边（叠放在深色背景上时用） */
    ring: { type: Boolean, value: false }
  },

  data: {
    px: 88,
    initial: '',
    bg: 'linear-gradient(135deg,#12B98A,#0B8A66)'
  },

  observers: {
    'size, name': function (size, name) {
      this.setData({
        px: this._toPx(size),
        initial: this._initial(name),
        bg: this._bg(name)
      })
    }
  },

  methods: {
    _toPx(size) {
      const map = { s: 64, m: 88, l: 128, xl: 160 }
      if (typeof size === 'number') return size
      return map[size] || 88
    },
    _initial(name) {
      const n = String(name || '').trim()
      if (!n) return '友'
      // 中文取第一个字，英文取首字母大写
      return /[\u4e00-\u9fa5]/.test(n[0]) ? n[0] : n[0].toUpperCase()
    },
    _bg(name) {
      const n = String(name || 'user')
      let h = 0
      for (let i = 0; i < n.length; i++) h = (h * 31 + n.charCodeAt(i)) % 9973
      const pair = PALETTE[h % PALETTE.length]
      return `linear-gradient(135deg,${pair[0]},${pair[1]})`
    },
    onTap() {
      this.triggerEvent('tap', { name: this.data.name })
    }
  }
})
