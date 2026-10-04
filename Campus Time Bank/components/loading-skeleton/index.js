/**
 * 骨架屏
 * ------------------------------------------------------------------
 * <loading-skeleton wx:if="{{loading}}" type="skill" count="{{4}}" />
 * type: skill | order | list | detail | grid
 * ------------------------------------------------------------------
 */
Component({
  options: { addGlobalClass: true },

  properties: {
    type: { type: String, value: 'list' },
    count: { type: Number, value: 3 }
  },

  data: {
    rows: [0, 1, 2]
  },

  observers: {
    count(n) {
      const len = Math.max(1, Math.min(Number(n) || 3, 10))
      this.setData({ rows: Array.from({ length: len }, (_, i) => i) })
    }
  }
})
