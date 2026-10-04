/**
 * 管理端 ECharts 配置工厂
 * ==================================================================
 * 约定（与 docs/ARCHITECTURE.md §2 设计 token 对齐）：
 *   1. 所有图表 option 都在这里生成，页面只负责「拿数据 → 取 option → setOption」。
 *   2. 颜色统一取自下面的 COLOR 常量（图表内允许硬编码色值，但必须集中在此文件），
 *      其余页面样式一律使用 CSS 变量。
 *   3. 每个 option 都统一了 animation / color / tooltip / grid / 中文标签。
 * ------------------------------------------------------------------
 * 用法：
 *   const chartFactory = require('../../utils/chart')
 *   chart.setOption(chartFactory.lineTrend(res.trend))
 * ==================================================================
 */

/* ============================ 统一配色 ============================ */
/** 与 theme.wxss 调色板一一对应 */
const COLOR = {
  primary: '#0EA47A', // --c-primary
  accent: '#FF8B3D',  // --c-accent
  blue: '#3B82F6',    // --c-info
  purple: '#7C5CFF',  // 徽章紫（constants.BADGES.social）
  red: '#F5483B',     // --c-danger
  yellow: '#FF9F0A'   // --c-warn
}

/** 通用序列色序 */
const PALETTE = [COLOR.primary, COLOR.accent, COLOR.blue, COLOR.purple, COLOR.red, COLOR.yellow]

/** 轴 / 图例文字色（--c-t2 / --c-t3） */
const TEXT = '#6B7280'
const TEXT_LIGHT = '#9CA3AF'
/** 分割线色（--c-line） */
const SPLIT_LINE = '#EDEFF2'

/** 所有 option 的公共底座 */
const BASE = {
  animation: true,
  animationDuration: 600,
  animationEasing: 'cubicOut',
  backgroundColor: 'transparent',
  textStyle: { color: TEXT, fontSize: 10 }
}

/** #RRGGBB → rgba(r,g,b,a)，用于面积/发光等半透明场景 */
function alpha(hex, a) {
  const h = String(hex || '').replace('#', '')
  const full = h.length === 3 ? h.split('').map(c => c + c).join('') : h
  const n = parseInt(full || '0EA47A', 16)
  const r = (n >> 16) & 255
  const g = (n >> 8) & 255
  const b = n & 255
  return `rgba(${r},${g},${b},${a === undefined ? 1 : a})`
}

/** 合并底座，保证每个 option 都带统一动画与配色 */
function withBase(extra) {
  const base = Object.assign({}, BASE)
  base.color = PALETTE.slice()
  return Object.assign(base, extra || {})
}

/** 分类轴（xAxis 或横向图的 yAxis）通用配置 */
function categoryAxis(data, opts) {
  const o = opts || {}
  return Object.assign({
    type: 'category',
    data: data || [],
    boundaryGap: o.boundaryGap === undefined ? true : o.boundaryGap,
    axisLine: { lineStyle: { color: SPLIT_LINE } },
    axisTick: { show: false },
    axisLabel: Object.assign({ color: TEXT_LIGHT, fontSize: 10, interval: 0 }, o.axisLabel || {})
  }, o.extra || {})
}

/** 数值轴通用配置 */
function valueAxis(opts) {
  const o = opts || {}
  return Object.assign({
    type: 'value',
    minInterval: o.minInterval === undefined ? 1 : o.minInterval,
    axisLine: { show: false },
    axisTick: { show: false },
    axisLabel: { color: TEXT_LIGHT, fontSize: 10 },
    splitLine: { lineStyle: { color: SPLIT_LINE, type: 'dashed' } }
  }, o.extra || {})
}

/** 底部图例（可滚动，避免分类多时溢出） */
function legend(pos) {
  return Object.assign({
    type: 'scroll',
    bottom: 0,
    itemWidth: 10,
    itemHeight: 8,
    itemGap: 12,
    textStyle: { color: TEXT, fontSize: 10 }
  }, pos || {})
}

/** 长文案截断（分类轴标签用） */
function ellipsis(v, len) {
  const s = String(v === undefined || v === null ? '' : v)
  const n = len || 8
  return s.length > n ? s.slice(0, n) + '…' : s
}

/** 空数据兜底：返回 null 时页面应跳过该图表渲染 */
function hasData(data) {
  return !!(data && data.length)
}

/* ==================================================================
 * 1. 多序列折线图 —— 用户数 / 订单量 / 时间币流通
 * ================================================================== */
const TREND_SERIES = [
  { key: 'users', name: '新增用户', color: COLOR.primary },
  { key: 'orders', name: '新增订单', color: COLOR.accent },
  { key: 'coins', name: '时间币流通', color: COLOR.blue }
]

/**
 * @param {Array<{date, users, orders, coins}>} data admin.stats().trend
 * @param {Array<{key, name, color}>} seriesDefs 默认 TREND_SERIES
 * @returns {Object|null} ECharts option
 */
function lineTrend(data, seriesDefs) {
  if (!hasData(data)) return null
  const defs = (seriesDefs && seriesDefs.length) ? seriesDefs : TREND_SERIES
  const axis = data.map(d => (d && d.date) || '')

  const series = defs.map((def, i) => {
    const color = def.color || PALETTE[i % PALETTE.length]
    return {
      name: def.name || def.key,
      type: 'line',
      smooth: true,
      symbol: 'circle',
      symbolSize: 5,
      showSymbol: data.length <= 14,
      lineStyle: { width: 2, color },
      itemStyle: { color },
      areaStyle: {
        color: {
          type: 'linear',
          x: 0, y: 0, x2: 0, y2: 1,
          colorStops: [
            { offset: 0, color: alpha(color, 0.26) },
            { offset: 1, color: alpha(color, 0.02) }
          ]
        }
      },
      data: data.map(d => Number((d && d[def.key]) || 0))
    }
  })

  return withBase({
    grid: { left: 6, right: 12, top: 44, bottom: 34, containLabel: true },
    legend: legend({ top: 6, bottom: undefined, data: defs.map(d => d.name || d.key) }),
    tooltip: {
      trigger: 'axis',
      confine: true,
      textStyle: { fontSize: 10, color: TEXT },
      axisPointer: { type: 'line', lineStyle: { color: SPLIT_LINE } }
    },
    xAxis: categoryAxis(axis, { boundaryGap: false, axisLabel: { interval: 'auto' } }),
    yAxis: valueAxis({ minInterval: 0 }),
    series
  })
}

/* ==================================================================
 * 2. 环形饼图 —— 分类分布 / 订单状态分布
 * ================================================================== */
const PIE_STATUS_COLOR = {
  已完成: COLOR.primary,
  服务中: COLOR.blue,
  待接单: COLOR.yellow,
  待确认: COLOR.accent,
  已取消: COLOR.purple,
  已关闭: TEXT_LIGHT
}

/**
 * @param {Array<{name, value}>} data
 * @param {Object} opts { colorMap, unit, center, radius }
 */
function pieCategory(data, opts) {
  if (!hasData(data)) return null
  const o = opts || {}
  const colorMap = o.colorMap || PIE_STATUS_COLOR
  const unit = o.unit || ''

  const seriesData = data.map((d, i) => {
    const name = (d && d.name) || '未知'
    const item = { name, value: Number((d && d.value) || 0) }
    const c = colorMap[name]
    if (c) item.itemStyle = { color: c }
    else item.itemStyle = { color: PALETTE[i % PALETTE.length] }
    return item
  })

  return withBase({
    color: seriesData.map(d => d.itemStyle.color),
    tooltip: {
      trigger: 'item',
      confine: true,
      textStyle: { fontSize: 10, color: TEXT },
      formatter: p => `${p.name}：${p.value}${unit}（${p.percent}%）`
    },
    legend: legend({}),
    series: [{
      type: 'pie',
      radius: o.radius || ['42%', '64%'],
      center: o.center || ['50%', '44%'],
      avoidLabelOverlap: true,
      itemStyle: { borderColor: '#FFFFFF', borderWidth: 2 },
      label: {
        show: true,
        color: TEXT,
        fontSize: 10,
        formatter: '{b}\n{d}%'
      },
      labelLine: { length: 8, length2: 8, lineStyle: { color: SPLIT_LINE } },
      emphasis: { scale: true, scaleSize: 4 },
      data: seriesData
    }]
  })
}

/* ==================================================================
 * 3. 横向柱状图 —— 热门技能 TOP8
 * ================================================================== */
/**
 * @param {Array<{name, value}>} data
 * @param {Boolean} horizontal 默认 true（横向）
 */
function barTop(data, horizontal) {
  if (!hasData(data)) return null
  const h = horizontal !== false
  const names = data.map(d => ellipsis((d && d.name) || '', h ? 9 : 4))
  const values = data.map(d => Number((d && d.value) || 0))
  // 冠军用强调色，其余按名次递减透明度
  const colors = values.map((v, i) => (i === 0 ? COLOR.accent : alpha(COLOR.primary, Math.max(0.28, 1 - i * 0.1))))

  const series = [{
    type: 'bar',
    data: values.map((v, i) => ({ value: v, itemStyle: { color: colors[i] } })),
    barWidth: h ? 12 : '46%',
    itemStyle: { borderRadius: h ? [0, 6, 6, 0] : [6, 6, 0, 0] },
    label: { show: true, position: h ? 'right' : 'top', color: TEXT, fontSize: 10 }
  }]

  return withBase({
    grid: h
      ? { left: 6, right: 32, top: 16, bottom: 6, containLabel: true }
      : { left: 6, right: 12, top: 26, bottom: 6, containLabel: true },
    tooltip: {
      trigger: 'axis',
      confine: true,
      textStyle: { fontSize: 10, color: TEXT },
      axisPointer: { type: 'shadow', shadowStyle: { color: alpha(COLOR.primary, 0.06) } }
    },
    xAxis: h ? valueAxis({ minInterval: 0 }) : categoryAxis(names, { axisLabel: { rotate: data.length > 5 ? 30 : 0 } }),
    // 横向柱：yAxis 用 inverse 让 TOP1 在最上方；不能反转 names，否则与 series.data 错位
    yAxis: h ? categoryAxis(names, { extra: { inverse: true } }) : valueAxis({ minInterval: 0 }),
    series
  })
}

/* ==================================================================
 * 4. 信用分区间柱状图
 * ================================================================== */
const CREDIT_BAND_COLOR = [COLOR.red, COLOR.yellow, COLOR.blue, COLOR.primary, COLOR.purple]

/**
 * @param {Array<{name, value}>} data
 */
function barCredit(data) {
  if (!hasData(data)) return null
  const names = data.map(d => String((d && d.name) || ''))
  const values = data.map(d => Number((d && d.value) || 0))
  const colors = names.map((n, i) => CREDIT_BAND_COLOR[i] || PALETTE[i % PALETTE.length])

  return withBase({
    color: colors,
    grid: { left: 6, right: 12, top: 30, bottom: 6, containLabel: true },
    tooltip: {
      trigger: 'axis',
      confine: true,
      textStyle: { fontSize: 10, color: TEXT },
      formatter: p => {
        const it = (p && p[0]) || {}
        return `信用分 ${it.name}：${it.value} 人`
      },
      axisPointer: { type: 'shadow', shadowStyle: { color: alpha(COLOR.blue, 0.06) } }
    },
    xAxis: categoryAxis(names, { axisLabel: { fontSize: 9 } }),
    yAxis: valueAxis({ minInterval: 0 }),
    series: [{
      type: 'bar',
      data: values.map((v, i) => ({ value: v, itemStyle: { color: colors[i] } })),
      barWidth: '46%',
      itemStyle: { borderRadius: [6, 6, 0, 0] },
      label: { show: true, position: 'top', color: TEXT, fontSize: 10 }
    }]
  })
}

/* ==================================================================
 * 5. 平台健康度雷达图
 * ================================================================== */
/**
 * @param {Array<{name, value, max}>} data value 已归一化到 0~100（max 缺省 100）
 */
function radarPlatform(data) {
  if (!hasData(data)) return null
  const indicator = data.map(d => ({
    name: String((d && d.name) || ''),
    max: Number((d && d.max) || 100)
  }))
  const value = data.map(d => Number((d && d.value) || 0))

  return withBase({
    color: [COLOR.primary],
    tooltip: {
      trigger: 'item',
      confine: true,
      textStyle: { fontSize: 10, color: TEXT }
    },
    legend: legend({ bottom: 0, data: ['平台健康度'] }),
    radar: {
      center: ['50%', '46%'],
      radius: '58%',
      indicator,
      axisName: { color: TEXT, fontSize: 9 },
      splitNumber: 4,
      axisLine: { lineStyle: { color: SPLIT_LINE } },
      splitLine: { lineStyle: { color: SPLIT_LINE } },
      splitArea: { show: false }
    },
    series: [{
      type: 'radar',
      symbolSize: 4,
      lineStyle: { width: 2, color: COLOR.primary },
      itemStyle: { color: COLOR.primary },
      areaStyle: { color: alpha(COLOR.primary, 0.22) },
      data: [{ value, name: '平台健康度' }]
    }]
  })
}

/* ==================================================================
 * 6. 完成率仪表盘
 * ================================================================== */
/**
 * @param {Number} rate 0~100
 */
function gaugeFinish(rate) {
  const v = Math.max(0, Math.min(100, Math.round(Number(rate) || 0)))
  const color = v >= 80 ? COLOR.primary : (v >= 60 ? COLOR.accent : COLOR.red)

  return withBase({
    color: [color],
    series: [{
      type: 'gauge',
      startAngle: 210,
      endAngle: -30,
      min: 0,
      max: 100,
      radius: '88%',
      center: ['50%', '56%'],
      progress: { show: true, width: 12, roundCap: true, itemStyle: { color } },
      axisLine: { roundCap: true, lineStyle: { width: 12, color: [[1, SPLIT_LINE]] } },
      axisTick: { show: false },
      splitLine: { show: false },
      axisLabel: { show: false },
      pointer: { show: false },
      anchor: { show: false },
      title: { show: true, offsetCenter: [0, '34%'], color: TEXT_LIGHT, fontSize: 10 },
      detail: {
        valueAnimation: true,
        offsetCenter: [0, 0],
        formatter: '{value}%',
        color: TEXT,
        fontSize: 22,
        fontWeight: 'bold'
      },
      data: [{ value: v, name: '订单完成率' }]
    }]
  })
}

module.exports = {
  COLOR,
  PALETTE,
  TEXT,
  TEXT_LIGHT,
  SPLIT_LINE,
  alpha,
  ellipsis,
  lineTrend,
  pieCategory,
  barTop,
  barCredit,
  radarPlatform,
  gaugeFinish
}
