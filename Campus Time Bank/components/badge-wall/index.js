/**
 * 徽章墙
 * ------------------------------------------------------------------
 * <badge-wall list="{{allBadges}}" />
 * list 每项：{ id, name, icon, color, desc, owned }
 * 传 ownedList（字符串 id 数组）时会自动标注获得状态。
 * ------------------------------------------------------------------
 */
Component({
  options: { addGlobalClass: true },

  properties: {
    /** 完整徽章数组（推荐传 user.badges 返回的 all） */
    list: { type: Array, value: [] },
    /** 已获得的徽章 id 数组；若 list 项自带 owned 则以其为准 */
    ownedList: { type: Array, value: [] },
    /** 每行列数 */
    cols: { type: Number, value: 4 },
    /** 是否显示未获得的徽章（置灰） */
    showLocked: { type: Boolean, value: true },
    /** 是否显示描述文字 */
    showDesc: { type: Boolean, value: false }
  },

  data: {
    render: [],
    itemWidth: 25
  },

  observers: {
    'list, ownedList, showLocked, showDesc, cols': function (list, ownedList, showLocked, showDesc, cols) {
      const owned = ownedList || []
      const src = (list && list.length) ? list : []
      const render = src
        .map(b => {
          const isOwned = b.owned !== undefined ? !!b.owned : owned.indexOf(b.id) > -1
          return { id: b.id, name: b.name, icon: b.icon, color: b.color || '#0EA47A', desc: b.desc || '', owned: isOwned, showDesc }
        })
        .filter(b => showLocked || b.owned)

      // cols 真正生效：用内联 width 覆盖，避免页面跨界改样式
      const n = Math.min(Math.max(Number(cols) || 4, 1), 6)
      this.setData({ render, itemWidth: Math.round(10000 / n) / 100 })
    }
  },

  methods: {
    onTap(e) {
      this.triggerEvent('tap', { badge: e.currentTarget.dataset.badge })
    }
  }
})
