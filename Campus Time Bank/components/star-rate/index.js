/**
 * 星级评分
 * 只读：<star-rate value="{{4.5}}" />
 * 可交互：<star-rate value="{{score}}" editable bindchange="onRate" />
 */
Component({
  options: { addGlobalClass: true },

  properties: {
    value: { type: Number, value: 0 },
    /** 星星尺寸 rpx */
    size: { type: Number, value: 32 },
    editable: { type: Boolean, value: false },
    /** 是否在右侧显示「4.5 分」 */
    showValue: { type: Boolean, value: false },
    /** 空星字符，可以换成 '☆' */
    emptyIcon: { type: String, value: '★' }
  },

  data: {
    list: [0, 0, 0, 0, 0]
  },

  observers: {
    value(v) {
      const n = Math.round(Number(v) || 0)
      this.setData({ list: [1, 2, 3, 4, 5].map(i => (i <= n ? 1 : 0)) })
    }
  },

  methods: {
    onTap(e) {
      if (!this.data.editable) return
      const v = Number(e.currentTarget.dataset.i)
      this.setData({ value: v, list: [1, 2, 3, 4, 5].map(i => (i <= v ? 1 : 0)) })
      this.triggerEvent('change', { value: v })
    }
  }
})
