/**
 * 技能卡片（广场 / 我的发布 / 搜索结果通用）
 * ------------------------------------------------------------------
 * <skill-card item="{{item}}" bindcard="onCard" />
 *
 * 封面降级策略：技能没有上传图片时，用「分类渐变色 + 分类图标」
 * 生成封面，因此项目零图片资源也能有完整视觉。
 * ------------------------------------------------------------------
 */
const DURATION_TEXT = {
  30: '30 分钟', 60: '1 小时', 90: '1.5 小时', 120: '2 小时',
  150: '2.5 小时', 180: '3 小时', 240: '4 小时'
}

const COVER_PALETTE = {
  c1: ['#4FA8FF', '#2563EB'],
  c2: ['#A78BFA', '#7C5CFF'],
  c3: ['#FB923C', '#EA580C'],
  c4: ['#34D399', '#059669'],
  c5: ['#22D3EE', '#0891B2'],
  c6: ['#F472B6', '#DB2777'],
  c7: ['#FBBF24', '#D97706'],
  c8: ['#F87171', '#DC2626'],
  c9: ['#60A5FA', '#3B82F6'],
  c10: ['#9CA3AF', '#6B7280']
}

Component({
  options: { addGlobalClass: true },

  properties: {
    item: { type: Object, value: {} },
    showAuthor: { type: Boolean, value: true },
    showDistance: { type: Boolean, value: true },
    /** 紧凑模式：隐藏标签区，只保留标题与价格 */
    compact: { type: Boolean, value: false }
  },

  data: {
    coverBg: 'linear-gradient(135deg,#9CA3AF,#6B7280)',
    coverIcon: '✨',
    hasImage: false,
    durationText: '',
    typeText: '',
    typeClass: '',
    distance: '',
    tags: [],
    ratingText: ''
  },

  observers: {
    item(it) {
      const o = it || {}
      const pair = COVER_PALETTE[o.categoryId] || COVER_PALETTE.c10
      const images = o.images || []
      const st = o.authorInfo || o.author || {}
      this.setData({
        coverBg: `linear-gradient(135deg,${pair[0]},${pair[1]})`,
        coverIcon: o.categoryIcon || this._iconByCategory(o.categoryName),
        hasImage: images.length > 0,
        durationText: DURATION_TEXT[o.duration] || (o.duration ? o.duration + ' 分钟' : ''),
        typeText: o.type === 'need' ? '求助' : '提供',
        typeClass: o.type === 'need' ? 'is-need' : 'is-offer',
        distance: o.distance != null ? this._distanceText(o.distance) : '',
        tags: (o.tags || []).slice(0, 3),
        ratingText: st.avgRating ? String(st.avgRating) : ''
      })
    }
  },

  methods: {
    _iconByCategory(name) {
      const map = {
        学业辅导: '📚', 技能教学: '🎸', 摄影修图: '📷', 代取代买: '🛵',
        电脑技术: '💻', 运动健身: '🏃', 生活服务: '🧺', 设计美工: '🎨',
        语言互助: '🌏', 其他: '✨'
      }
      return map[name] || '✨'
    },
    _distanceText(m) {
      const v = Number(m)
      if (!v && v !== 0) return ''
      if (v < 100) return '100m 内'
      if (v < 1000) return Math.round(v / 10) * 10 + 'm'
      return (v / 1000).toFixed(1) + 'km'
    },
    onCard() {
      this.triggerEvent('card', { item: this.data.item })
    },
    onAuthor(e) {
      // 阻止冒泡到整卡
      this.triggerEvent('author', { openid: (this.data.item || {}).authorId })
    }
  }
})
