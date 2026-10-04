/**
 * 全局枚举 / 字典 / 状态机文案
 * 前后端共用同一套 key，云函数里的值必须与此处一致。
 */

/* ============================ 订单状态机 ============================ */
const ORDER_STATUS = {
  waiting: { key: 'waiting', text: '待接单', color: 'var(--c-warn)', dot: 'waiting', desc: '等待服务者接单' },
  ongoing: { key: 'ongoing', text: '服务中', color: 'var(--c-info)', dot: 'ongoing', desc: '服务者已接单，正在服务' },
  confirming: { key: 'confirming', text: '待确认', color: 'var(--c-accent)', dot: 'confirming', desc: '服务者已完成，等待你确认' },
  finished: { key: 'finished', text: '已完成', color: 'var(--c-success)', dot: 'finished', desc: '服务已完成，时间币已结算' },
  canceled: { key: 'canceled', text: '已取消', color: 'var(--c-t3)', dot: 'canceled', desc: '订单已取消，时间币已退回' },
  closed: { key: 'closed', text: '已关闭', color: 'var(--c-t3)', dot: 'closed', desc: '订单已关闭' }
}
const ORDER_STATUS_LIST = Object.keys(ORDER_STATUS).map(k => ORDER_STATUS[k])

/** 订单列表筛选 tab */
const ORDER_TABS = [
  { key: 'all', text: '全部' },
  { key: 'waiting', text: '待接单' },
  { key: 'ongoing', text: '服务中' },
  { key: 'confirming', text: '待确认' },
  { key: 'finished', text: '已完成' },
  { key: 'canceled', text: '已取消/关闭' }
]

/** 角色 */
const ORDER_ROLE = { buyer: '我买到的', seller: '我接的单' }

/* ============================ 技能 ============================ */
const SKILL_TYPE = {
  offer: { key: 'offer', text: '我能提供', short: '提供', color: 'var(--c-primary)', bg: 'var(--c-primary-l)' },
  need: { key: 'need', text: '我要求助', short: '求助', color: 'var(--c-info)', bg: 'var(--c-info-l)' }
}

const SKILL_STATUS = {
  1: { text: '上架中', tone: 'success' },
  0: { text: '已下架', tone: '' },
  2: { text: '已完成', tone: 'info' },
  3: { text: '违规下架', tone: 'danger' },
  4: { text: '待审核', tone: 'warn' }
}

const SKILL_SORT = [
  { key: 'new', text: '最新发布' },
  { key: 'hot', text: '人气最高' },
  { key: 'near', text: '离我最近' },
  { key: 'priceAsc', text: '时间币最少' },
  { key: 'priceDesc', text: '时间币最多' }
]

/** 服务时长选项（分钟） */
const DURATION_OPTIONS = [
  { value: 30, text: '30 分钟' },
  { value: 60, text: '1 小时' },
  { value: 90, text: '1.5 小时' },
  { value: 120, text: '2 小时' },
  { value: 180, text: '3 小时' },
  { value: 240, text: '4 小时' }
]

/** 时间币数量快捷选项 */
const PRICE_OPTIONS = [1, 2, 3, 5, 8, 10]

/* ============================ 校园认证 ============================ */
const AUTH_STATUS = {
  0: { text: '未认证', tone: 'warn', desc: '完成校园认证后可发布与下单' },
  1: { text: '审核中', tone: 'info', desc: '资料已提交，管理员将在 1 个工作日内审核' },
  2: { text: '已认证', tone: 'success', desc: '已通过校园认证' },
  3: { text: '已驳回', tone: 'danger', desc: '认证未通过，请修改后重新提交' }
}

/* ============================ 信用分 ============================ */
const CREDIT_LEVELS = [
  { min: 120, max: 150, key: 'excellent', text: '极佳', color: 'var(--c-accent)', bg: 'var(--c-accent-l)', limit: 5, desc: '可同时进行 5 单' },
  { min: 100, max: 119, key: 'good', text: '优秀', color: 'var(--c-success)', bg: 'var(--c-success-l)', limit: 3, desc: '可同时进行 3 单' },
  { min: 80, max: 99, key: 'normal', text: '良好', color: 'var(--c-info)', bg: 'var(--c-info-l)', limit: 2, desc: '可同时进行 2 单' },
  { min: 60, max: 79, key: 'weak', text: '一般', color: 'var(--c-warn)', bg: 'var(--c-warn-l)', limit: 1, desc: '仅可同时进行 1 单' },
  { min: 0, max: 59, key: 'limited', text: '受限', color: 'var(--c-danger)', bg: 'var(--c-danger-l)', limit: 0, desc: '信用分过低，暂不能下单' }
]

/** 信用分规则文案（与云函数 credit 逻辑一一对应） */
const CREDIT_RULES = [
  { key: 'order_finish', change: 2, text: '订单顺利完成（双方各 +2）' },
  { key: 'review_5', change: 1, text: '收到 5 星好评' },
  { key: 'review_4', change: 0, text: '收到 4 星评价' },
  { key: 'review_3', change: -1, text: '收到 3 星评价' },
  { key: 'review_2', change: -2, text: '收到 2 星评价' },
  { key: 'review_1', change: -3, text: '收到 1 星评价' },
  { key: 'cancel_after_accept', change: -5, text: '接单后取消 / 爽约' },
  { key: 'report_valid', change: -10, text: '被举报且核实成立' },
  { key: 'ontime_streak', change: 3, text: '连续 5 单按时完成' }
]

/* ============================ 徽章 ============================ */
const BADGES = [
  { id: 'newbie', name: '初出茅庐', icon: '🌱', color: '#0EA47A', desc: '完成第一笔订单' },
  { id: 'ontime', name: '守时达人', icon: '⏰', color: '#3B82F6', desc: '连续 5 单按时完成' },
  { id: 'warm', name: '热心助人', icon: '❤️', color: '#F5483B', desc: '完成 10 次技能提供' },
  { id: 'expert', name: '技能达人', icon: '🎯', color: '#FF8B3D', desc: '同一分类完成 5 单且评分 ≥ 4.5' },
  { id: 'trust', name: '信用之星', icon: '⭐', color: '#F5B301', desc: '信用分达到 120' },
  { id: 'popular', name: '人气之星', icon: '🔥', color: '#FF6B35', desc: '发布的技能被浏览 500 次' },
  { id: 'social', name: '社交达人', icon: '💬', color: '#7C5CFF', desc: '收到 20 条以上评价' }
]
const BADGE_MAP = BADGES.reduce((m, b) => (m[b.id] = b, m), {})

/* ============================ 时间币流水 ============================ */
const WALLET_LOG_TYPES = {
  income: { text: '服务收入', icon: '↓', color: 'var(--c-success)' },
  expense: { text: '服务支出', icon: '↑', color: 'var(--c-danger)' },
  freeze: { text: '下单冻结', icon: '🔒', color: 'var(--c-warn)' },
  unfreeze: { text: '取消解冻', icon: '🔓', color: 'var(--c-info)' },
  settle: { text: '结算给服务方', icon: '→', color: 'var(--c-danger)' },
  refund: { text: '退回', icon: '↩', color: 'var(--c-info)' },
  admin: { text: '平台调整', icon: '⚙', color: 'var(--c-t2)' },
  bonus: { text: '注册赠送', icon: '🎁', color: 'var(--c-accent)' }
}
const WALLET_LOG_TABS = [
  { key: 'all', text: '全部' },
  { key: 'income', text: '收入' },
  { key: 'expense', text: '支出' },
  { key: 'freeze', text: '冻结' }
]

/* ============================ 举报 ============================ */
const REPORT_REASONS = [
  '虚假信息 / 与描述不符',
  '涉嫌诈骗或诱导线下付款',
  '发布违法违规内容',
  '言语骚扰或人身攻击',
  '爽约 / 服务态度恶劣',
  '其他违规行为'
]
const REPORT_TARGET = { skill: '技能', user: '用户', order: '订单', review: '评价' }

/* ============================ 评价 ============================ */
const REVIEW_TAGS_GOOD = ['专业靠谱', '准时守约', '态度超好', '讲解细致', '效率很高', '物超所值']
const REVIEW_TAGS_BAD = ['经常迟到', '沟通不畅', '与描述不符', '态度一般', '效率偏低']

/* ============================ 消息 ============================ */
const NOTICE_TYPE = {
  order: { text: '订单动态', icon: '📦', color: 'var(--c-primary)' },
  audit: { text: '认证审核', icon: '🛡️', color: 'var(--c-info)' },
  credit: { text: '信用变动', icon: '📊', color: 'var(--c-accent)' },
  report: { text: '举报结果', icon: '🚨', color: 'var(--c-danger)' },
  system: { text: '系统消息', icon: '📢', color: 'var(--c-t2)' }
}

/* ============================ 兼容默认分类（离线/兜底） ============================ */
const DEFAULT_CATEGORIES = [
  { _id: 'c1', name: '学业辅导', icon: '📚' },
  { _id: 'c2', name: '技能教学', icon: '🎸' },
  { _id: 'c3', name: '摄影修图', icon: '📷' },
  { _id: 'c4', name: '代取代买', icon: '🛵' },
  { _id: 'c5', name: '电脑技术', icon: '💻' },
  { _id: 'c6', name: '运动健身', icon: '🏃' },
  { _id: 'c7', name: '生活服务', icon: '🧺' },
  { _id: 'c8', name: '设计美工', icon: '🎨' },
  { _id: 'c9', name: '语言互助', icon: '🌏' },
  { _id: 'c10', name: '其他', icon: '✨' }
]

module.exports = {
  ORDER_STATUS,
  ORDER_STATUS_LIST,
  ORDER_TABS,
  ORDER_ROLE,
  SKILL_TYPE,
  SKILL_STATUS,
  SKILL_SORT,
  DURATION_OPTIONS,
  PRICE_OPTIONS,
  AUTH_STATUS,
  CREDIT_LEVELS,
  CREDIT_RULES,
  BADGES,
  BADGE_MAP,
  WALLET_LOG_TYPES,
  WALLET_LOG_TABS,
  REPORT_REASONS,
  REPORT_TARGET,
  REVIEW_TAGS_GOOD,
  REVIEW_TAGS_BAD,
  NOTICE_TYPE,
  DEFAULT_CATEGORIES
}
