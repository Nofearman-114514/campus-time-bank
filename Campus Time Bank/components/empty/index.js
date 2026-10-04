/**
 * 空状态 / 错误状态占位
 * <empty icon="📭" text="还没有订单" desc="去技能广场看看有什么需要的" btn="去逛逛" bindaction="goSquare" />
 */
Component({
  options: { addGlobalClass: true },

  properties: {
    icon: { type: String, value: '📭' },
    text: { type: String, value: '暂无数据' },
    desc: { type: String, value: '' },
    btn: { type: String, value: '' },
    /** primary | ghost | light */
    btnType: { type: String, value: 'primary' },
    /** 视觉尺寸 compact 更紧凑（嵌在卡片里时用） */
    compact: { type: Boolean, value: false }
  },

  methods: {
    onAction() {
      this.triggerEvent('action')
    }
  }
})
