/**
 * 离线测试替身：内存版 wx-server-sdk
 * ==================================================================
 * 只在 `tools/test-cloudfunctions/` 里被使用，**不会**被任何云函数打包上传。
 *
 * 它实现了云函数真正用到的那一小部分能力：
 *   - 集合查询：where / orderBy / field / skip / limit / get / count / update / remove
 *   - 文档操作：doc().get() / update() / set() / remove()
 *   - 指令：_.in _.eq _.neq _.lt _.lte _.gt _.gte _.and _.or _.push _.inc
 *   - runTransaction()：快照隔离 + 提交时写冲突检测 + 自动重试
 *
 * ★ runTransaction 的语义刻意贴近云开发：
 *   1) 事务开始时对全库做快照，事务内所有读写都发生在快照上（快照隔离）；
 *   2) 提交时若发现有别的事务在本事务执行期间提交过 → 判定写冲突，整个事务重跑；
 *   3) 提交时只把「本事务真正写过的文档」合并回主库，
 *      因此事务外并发的补写（时间币流水、通知）不会被覆盖 —— 这也正是真实数据库的行为。
 *   没有这套语义，「并发下单不超卖」的测试就只是自欺欺人。
 * ==================================================================
 */
const store = { collections: {} }
let commitSeq = 0
let seq = 0

/** 观测数据：给测试断言用（事务次数 / 冲突重试次数 / 订阅消息发送次数） */
const stats = { transactions: 0, retries: 0, subscribeSends: 0, phoneCalls: 0 }
/** 跨 seed 累计的观测数据（seed 会清零 stats，这里保留全程总计） */
const totals = { transactions: 0, retries: 0, subscribeSends: 0, phoneCalls: 0 }

const coll = (name, root) => {
  const r = root || store.collections
  return (r[name] || (r[name] = []))
}
const newId = p => `${p || 'doc'}_${++seq}_${Math.random().toString(36).slice(2, 6)}`
const clone = v => (v === undefined ? undefined : structuredClone(v))

/* ---------------------------- 查询指令 ---------------------------- */
const CMD = Symbol('cmd')

/**
 * 构造一个字段级查询指令。
 *
 * ★ 返回值上额外挂了链式的 `.and()` / `.or()`：真实云开发支持
 *   `_.gte(a).and(_.lt(b))`（**同一字段**同时满足两个条件），
 *   而最初的 stub 只返回一个纯对象，没有 `.and`，
 *   于是 `admin.stats` 里的 `_.gte(yest0).and(_.lt(today0))` 直接
 *   TypeError → 被 wrap() 兜成 500「服务异常」，把真实缺陷掩盖掉了。
 *
 *   语义等价于 `_.and([self, other])`，因此能直接被 matchField 的
 *   `case 'and'` 消费（那里是 `args.every(x => matchField(actual, x))`，
 *   两个条件作用在同一个 actual 上，正是「同字段交叉条件」）。
 *
 *   用 non-enumerable 定义，避免影响 Object.keys / JSON 序列化 / structuredClone。
 */
const cmd = op => {
  const build = (...args) => {
    const node = { [CMD]: op, args }
    Object.defineProperty(node, 'and', {
      enumerable: false,
      value: other => ({ [CMD]: 'and', args: [node, other] })
    })
    Object.defineProperty(node, 'or', {
      enumerable: false,
      value: other => ({ [CMD]: 'or', args: [node, other] })
    })
    return node
  }
  return build
}

/** 正则字面量标记（db.RegExp 返回它，查询匹配器据此识别） */
const REGEXP = Symbol('regexp')
/** 聚合累加器标记（$.sum 等，只在 aggregate().group() 里有意义） */
const AGG = Symbol('agg')
const aggOp = op => arg => ({ [AGG]: op, arg })
const $ = {
  sum: aggOp('sum'),
  count: aggOp('count'),
  max: aggOp('max'),
  min: aggOp('min'),
  avg: aggOp('avg')
}

const command = {
  in: cmd('in'), nin: cmd('nin'), eq: cmd('eq'), neq: cmd('neq'),
  lt: cmd('lt'), lte: cmd('lte'), gt: cmd('gt'), gte: cmd('gte'),
  and: cmd('and'), or: cmd('or'), push: cmd('push'), inc: cmd('inc'), set: cmd('set'),
  // ★ 下面三个是其余 6 个云函数能跑起来的必要条件（缺失时它们根本起不来）：
  all: cmd('all'),          // 数组字段包含全部给定值 —— message.openChat 用它精确匹配二人会话
  exists: cmd('exists'),    // 字段是否存在
  geoNear: cmd('geoNear'),  // 地理位置邻近查询 —— skill.list 的「附近」排序
  aggregate: $
}

const isCmd = v => !!(v && typeof v === 'object' && v[CMD])
const getPath = (o, p) => p.split('.').reduce((a, k) => (a == null ? undefined : a[k]), o)
function setPath(o, p, v) {
  const ks = p.split('.')
  let cur = o
  for (let i = 0; i < ks.length - 1; i++) {
    if (cur[ks[i]] == null) cur[ks[i]] = {}
    cur = cur[ks[i]]
  }
  cur[ks[ks.length - 1]] = v
}
const toNum = v => {
  if (v instanceof Date) return v.getTime()
  if (typeof v === 'string' && /^\d{4}-\d{2}-\d{2}/.test(v)) {
    const t = Date.parse(v)
    if (!isNaN(t)) return t
  }
  return v
}
const cmp = (a, b) => {
  const x = toNum(a)
  const y = toNum(b)
  if (x === y) return 0
  if (x == null) return -1
  if (y == null) return 1
  return x < y ? -1 : 1
}
const RANGE_OPS = ['lt', 'lte', 'gt', 'gte']

/** 两点间球面距离（米）。geoNear 与 distance 字段都靠它。 */
function geoDistanceMeters(point, target) {
  const c1 = point && point.coordinates
  const c2 = target && target.coordinates
  if (!Array.isArray(c1) || !Array.isArray(c2)) return null
  const R = 6371000
  const rad = d => (d * Math.PI) / 180
  const [lng1, lat1] = c1
  const [lng2, lat2] = c2
  const dLat = rad(lat2 - lat1)
  const dLng = rad(lng2 - lng1)
  const a = Math.sin(dLat / 2) ** 2 +
    Math.cos(rad(lat1)) * Math.cos(rad(lat2)) * Math.sin(dLng / 2) ** 2
  return Math.round(R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a)))
}

/** 在查询条件里找出 geoNear，返回 { field, geometry } —— get() 要靠它补 distance 并排序 */
function findGeoNear(clause) {
  if (!clause) return null
  if (isCmd(clause)) {
    const arr = Array.isArray(clause.args[0]) ? clause.args[0] : clause.args
    if (clause[CMD] === 'and' || clause[CMD] === 'or') {
      for (const c of arr) {
        const r = findGeoNear(c)
        if (r) return r
      }
    }
    return null
  }
  for (const k of Object.keys(clause)) {
    const v = clause[k]
    if (isCmd(v) && v[CMD] === 'geoNear') {
      return { field: k, geometry: (v.args[0] || {}).geometry }
    }
  }
  return null
}

function matchField(actual, c) {
  if (isCmd(c)) {
    // 真实数据库：字段缺失时不匹配范围查询
    if (actual === undefined && RANGE_OPS.indexOf(c[CMD]) > -1) return false
    switch (c[CMD]) {
      case 'in': return c.args[0].indexOf(actual) > -1
      case 'nin': return c.args[0].indexOf(actual) < 0
      case 'eq': return actual === c.args[0]
      case 'neq': return actual !== c.args[0]
      case 'lt': return cmp(actual, c.args[0]) < 0
      case 'lte': return cmp(actual, c.args[0]) <= 0
      case 'gt': return cmp(actual, c.args[0]) > 0
      case 'gte': return cmp(actual, c.args[0]) >= 0
      case 'and': return c.args.every(x => matchField(actual, x))
      case 'or': return c.args.some(x => matchField(actual, x))
      case 'all': {
        const need = c.args[0]
        return Array.isArray(actual) && Array.isArray(need) && need.every(v => actual.indexOf(v) > -1)
      }
      case 'exists': return (actual !== undefined) === !!c.args[0]
      case 'geoNear': {
        const spec = c.args[0] || {}
        const d = geoDistanceMeters(actual, spec.geometry)
        return d !== null && d <= (spec.maxDistance == null ? Infinity : spec.maxDistance)
      }
      default: throw new Error('[stub-db] 不支持的字段指令 ' + c[CMD])
    }
  }
  // 正则查询（db.RegExp）—— skill.list 的关键词搜索用它
  if (c && typeof c === 'object' && c[REGEXP]) {
    // 用 test 前复位 lastIndex：带 g/y 标志的正则 test 是有状态的，
    // 不复位会导致同一条查询在不同文档上结果不一致。
    const hit = (s) => {
      if (typeof s !== 'string') return false
      c.regex.lastIndex = 0
      return c.regex.test(s)
    }
    // ★ 数组字段按元素匹配：真实数据库（MongoDB）里 `{ tags: /英语/ }`
    //   命中的是 tags 数组中**任一元素**匹配。
    //   只判 `typeof actual === 'string'` 的话数组直接 false，
    //   导致 skill.list「关键词命中 tags」这条路径离线根本无法验证。
    if (Array.isArray(actual)) return actual.some(hit)
    return hit(actual)
  }
  // ★ 数组字段的「隐式包含」语义：云开发里 where({ members: 'openid' })
  //   命中的是 members 数组含该值的文档（message 的会话查询依赖这个行为）
  if (Array.isArray(actual) && !Array.isArray(c)) return actual.indexOf(c) > -1
  return actual === c
}

function matchClause(doc, clause) {
  if (!clause || !Object.keys(clause).length) return true
  if (isCmd(clause)) {
    const arr = Array.isArray(clause.args[0]) ? clause.args[0] : clause.args
    if (clause[CMD] === 'or') return arr.some(c => matchClause(doc, c))
    if (clause[CMD] === 'and') return arr.every(c => matchClause(doc, c))
    throw new Error('[stub-db] 不支持的顶层指令 ' + clause[CMD])
  }
  return Object.keys(clause).every(k => matchField(getPath(doc, k), clause[k]))
}

function applyUpdate(doc, data) {
  Object.keys(data).forEach(k => {
    const v = data[k]
    if (isCmd(v) && v[CMD] === 'push') doc[k] = (getPath(doc, k) || []).concat(v.args[0])
    else if (isCmd(v) && v[CMD] === 'inc') setPath(doc, k, (getPath(doc, k) || 0) + v.args[0])
    else setPath(doc, k, v)
  })
}

/* ---------------------------- 查询构造 ---------------------------- */
function makeQuery(name, clause, opt, root) {
  const o = opt || {}
  return {
    where(c) { return makeQuery(name, c, o, root) },
    orderBy(f, d) { return makeQuery(name, clause, Object.assign({}, o, { orderBy: (o.orderBy || []).concat([[f, d || 'desc']]) }), root) },
    field(f) { return makeQuery(name, clause, Object.assign({}, o, { field: f }), root) },
    skip(n) { return makeQuery(name, clause, Object.assign({}, o, { skip: n }), root) },
    limit(n) { return makeQuery(name, clause, Object.assign({}, o, { limit: n }), root) },
    async get() {
      let list = coll(name, root).filter(d => matchClause(d, clause))
      // ★ geoNear：真实云开发会**按距离升序**返回，并给每条文档补上 distance（米）。
      //   skill.list 的「附近」排序就靠这个字段 —— 不补上，前端拿不到距离。
      const near = findGeoNear(clause)
      if (near) {
        list = list.map(d => Object.assign(clone(d), {
          distance: geoDistanceMeters(getPath(d, near.field), near.geometry)
        }))
        list.sort((a, b) => {
          const x = a.distance == null ? Infinity : a.distance
          const y = b.distance == null ? Infinity : b.distance
          return x - y
        })
      } else {
        ;(o.orderBy || []).slice().reverse().forEach(([f, dir]) => {
          list = list.slice().sort((a, b) => {
            const r = cmp(getPath(a, f), getPath(b, f))
            return dir === 'asc' ? r : -r
          })
        })
      }
      if (o.skip) list = list.slice(o.skip)
      if (o.limit != null) list = list.slice(0, o.limit)
      list = list.map(clone)
      if (o.field) {
        list = list.map(d => {
          const x = {}
          Object.keys(o.field).forEach(k => { if (o.field[k]) x[k] = getPath(d, k) })
          x._id = d._id
          return x
        })
      }
      return { data: list }
    },
    async count() { return { total: coll(name, root).filter(d => matchClause(d, clause)).length } },
    async update({ data }) {
      let n = 0
      coll(name, root).forEach(d => { if (matchClause(d, clause)) { applyUpdate(d, data); n++ } })
      return { stats: { updated: n } }
    },
    async remove() {
      const keep = coll(name, root).filter(d => !matchClause(d, clause))
      const n = coll(name, root).length - keep.length
      ;(root || store.collections)[name] = keep
      return { stats: { removed: n } }
    }
  }
}

function makeDoc(name, id, root, touched) {
  const find = () => coll(name, root).find(x => x._id === id)
  const mark = () => { if (touched) touched.add(`${name}\u0000${id}`) }
  return {
    async get() {
      const d = find()
      if (!d) {
        const e = new Error('document.get:fail document does not exist')
        e.errCode = -1
        throw e
      }
      return { data: clone(d) }
    },
    async update({ data }) {
      const d = find()
      if (!d) throw new Error('document.update:fail document does not exist')
      applyUpdate(d, data)
      mark()
      return { stats: { updated: 1 } }
    },
    async set({ data }) {
      // ★ 真实云开发**不允许**在 set 的 data 里带 _id：
      //     document.set:fail -501007 invalid parameters. 不能更新_id的值
      //   不模拟这一点，就测不出 initdb 修复模式里「把带 _id 的种子文档原样 set 回去」
      //   这个真实 bug —— 离线用例全绿、真机全红。
      if (data && Object.prototype.hasOwnProperty.call(data, '_id')) {
        const e = new Error('document.set:fail -501007 invalid parameters. 不能更新_id的值')
        e.errCode = -501007
        throw e
      }
      const d = find()
      if (d) {
        Object.keys(d).forEach(k => { if (k !== '_id') delete d[k] })
        Object.assign(d, clone(data))
      } else {
        coll(name, root).push(Object.assign({ _id: id }, clone(data)))
      }
      mark()
      return { stats: { updated: 1 } }
    },
    async remove() {
      const keep = coll(name, root).filter(x => x._id !== id)
      ;(root || store.collections)[name] = keep
      mark()
      return { stats: { removed: 1 } }
    }
  }
}

/* ---------------------------- 聚合 ---------------------------- */
/**
 * 内存版聚合管道，只实现云函数真正用到的阶段：
 *   .match() → 过滤；.group() → 分组；.end() → 取结果 { list }
 *
 * 调用形态（admin.stats / user.badges 用的就是这些）：
 *   db.collection('users').aggregate().group({ _id: null, coins: $.sum('$coins') }).end()
 *   db.collection('orders').aggregate().match({ status: 'finished' })
 *                       .group({ _id: '$skillSnapshot.categoryName', value: $.sum(1) }).end()
 *
 * ★ 语义对齐 MongoDB：输入为空时 $group 产出**空数组**（不是一条全 0 的记录）。
 */
function aggExprValue(expr, doc) {
  if (typeof expr === 'string' && expr.charAt(0) === '$') return getPath(doc, expr.slice(1))
  return expr
}

function computeAccumulator(acc, rows) {
  const op = acc && acc[AGG]
  const arg = acc && acc.arg
  const vals = rows.map(d => {
    const v = typeof arg === 'string' && arg.charAt(0) === '$' ? getPath(d, arg.slice(1)) : arg
    return typeof v === 'number' ? v : 0
  })
  switch (op) {
    case 'sum': return vals.reduce((a, b) => a + b, 0)
    case 'count': return rows.length
    case 'max': return vals.length ? Math.max.apply(null, vals) : null
    case 'min': return vals.length ? Math.min.apply(null, vals) : null
    case 'avg': return vals.length ? vals.reduce((a, b) => a + b, 0) / vals.length : null
    default: return null
  }
}

function runGroup(rows, spec) {
  const buckets = new Map()
  for (const doc of rows) {
    const key = aggExprValue(spec._id, doc)
    const k = JSON.stringify(key === undefined ? null : key)
    if (!buckets.has(k)) buckets.set(k, { key: key === undefined ? null : key, rows: [] })
    buckets.get(k).rows.push(doc)
  }
  const out = []
  for (const b of buckets.values()) {
    const rec = { _id: b.key }
    for (const field of Object.keys(spec)) {
      if (field === '_id') continue
      rec[field] = computeAccumulator(spec[field], b.rows)
    }
    out.push(rec)
  }
  return out
}

function runAggregate(name, root, stages) {
  let rows = coll(name, root).map(clone)
  for (const st of stages) {
    if (st.type === 'match') rows = rows.filter(d => matchClause(d, st.clause))
    else if (st.type === 'group') rows = runGroup(rows, st.spec)
    else if (st.type === 'limit') rows = rows.slice(0, st.n)
    else if (st.type === 'skip') rows = rows.slice(st.n)
    else if (st.type === 'sort') {
      Object.keys(st.o).forEach(f => {
        const dir = st.o[f]
        rows = rows.slice().sort((a, b) => {
          const r = cmp(getPath(a, f), getPath(b, f))
          return dir === 'asc' || dir === 1 ? r : -r
        })
      })
    }
  }
  return rows
}

function makeAggregate(name, root) {
  const stages = []
  const api = {
    match(clause) { stages.push({ type: 'match', clause }); return api },
    group(spec) { stages.push({ type: 'group', spec }); return api },
    sort(o) { stages.push({ type: 'sort', o }); return api },
    limit(n) { stages.push({ type: 'limit', n }); return api },
    skip(n) { stages.push({ type: 'skip', n }); return api },
    async end() { return { list: runAggregate(name, root, stages) } }
  }
  return api
}

function makeCollection(name, root, touched) {
  return {
    doc: id => makeDoc(name, id, root, touched),
    aggregate: () => makeAggregate(name, root),
    where: c => makeQuery(name, c, {}, root),
    orderBy: (f, d) => makeQuery(name, {}, {}, root).orderBy(f, d),
    skip: n => makeQuery(name, {}, {}, root).skip(n),
    limit: n => makeQuery(name, {}, {}, root).limit(n),
    field: f => makeQuery(name, {}, {}, root).field(f),
    get: () => makeQuery(name, {}, {}, root).get(),
    count: () => makeQuery(name, {}, {}, root).count(),
    add: async ({ data }) => {
      const d = clone(data)
      if (!d._id) {
        d._id = newId(name)
      } else if (coll(name, root).some(x => x._id === d._id)) {
        // ★ 真实云开发里 _id 是主键：显式指定且已存在时 add 必须失败。
        //   不模拟这一点，就测不出「并发 openChat 会不会建出第二条会话」——
        //   而 message.openChat 的修复正是把唯一性交给主键。
        const e = new Error('collection.add:fail duplicate _id')
        e.errCode = -502001
        throw e
      }
      coll(name, root).push(d)
      if (touched) touched.add(`${name}\u0000${d._id}`)
      return { _id: d._id }
    }
  }
}

/* ---------------------------- 事务 ---------------------------- */
async function runTransaction(fn) {
  for (let attempt = 0; attempt < 8; attempt++) {
    stats.transactions++
    if (attempt > 0) stats.retries++
    const snapshot = clone(store.collections)
    const touched = new Set()
    const versionAtStart = commitSeq
    const result = await fn({ collection: name => makeCollection(name, snapshot, touched) })
    // 提交前检测：本事务执行期间是否有别的事务提交过 → 乐观锁冲突，整事务重跑
    if (commitSeq !== versionAtStart) continue
    commitSeq++
    touched.forEach(key => {
      const [name, id] = key.split('\u0000')
      const doc = (snapshot[name] || []).find(x => x._id === id)
      if (!doc) return
      const live = coll(name)
      const i = live.findIndex(x => x._id === id)
      if (i > -1) live[i] = doc
      else live.push(doc)
    })
    return result
  }
  throw new Error('[stub-db] 事务冲突重试次数超限')
}

/* ---------------------------- 导出 ---------------------------- */
let CURRENT_OPENID = ''
let currentPhone = '13800000000'
let phoneFailFlag = false

/*
 * 内容安全的测试状态（security.msgSecCheck）
 * ★ stub 必须实现这个接口：否则任何接了 checkText 的云函数一调就
 *   「Cannot read properties of undefined (reading 'msgSecCheck')」，
 *   整片用例挂掉 —— 与当初 phonenumber 踩的是同一个坑。
 */
let secFailFlag = false          // true → 接口直接抛错（测「失败放行」分支）
let secRiskyWords = []           // 含这些词 → risky（应被拦下）
let secReviewWords = []          // 含这些词 → review（疑似，应放行）
const database = () => ({
  collection: name => makeCollection(name),
  command,
  Geo: { Point: (lng, lat) => ({ type: 'Point', coordinates: [lng, lat] }) },
  /** db.RegExp —— skill.list 的关键词模糊匹配用它 */
  RegExp: ({ regexp, options }) => ({ [REGEXP]: true, regex: new RegExp(regexp, options || '') }),
  /** db.createCollection —— initdb 逐个建集合；已存在时按真实行为抛错（调用方 catch 掉） */
  createCollection: async (name) => {
    if (Object.prototype.hasOwnProperty.call(store.collections, name)) {
      const e = new Error('createCollection:fail collection already exists')
      e.errCode = -501001
      throw e
    }
    store.collections[name] = []
    return { errMsg: 'createCollection:ok' }
  },
  runTransaction
})

module.exports = {
  DYNAMIC_CURRENT_ENV: 'DYNAMIC_CURRENT_ENV',
  init() {},
  database,
  getWXContext: () => ({ OPENID: CURRENT_OPENID, FROM_OPENID: CURRENT_OPENID }),
  openapi: {
    subscribeMessage: {
      send: async () => { stats.subscribeSends++; return { errCode: 0, errMsg: 'ok' } }
    },
    /**
     * 手机号快速验证（`<button open-type="getPhoneNumber">` 的 code 换手机号）。
     *
     * ★ stub 必须同时实现 subscribeMessage 与 phonenumber：只有前者时 `login.bindPhone` 一调就
     *   「Cannot read properties of undefined (reading 'getPhoneNumber')」，
     *   导致 login 的用例整片挂掉。
     *   真实接口返回的是**当前登录用户**的手机号（与 code 无关），
     *   所以这里返回固定号码，测试可用 `__setPhone()` 改、`__failPhone()` 模拟失败。
     */
    /**
     * 内容安全（security.msgSecCheck）。
     *
     * 真实接口返回 result.suggest = pass / review / risky。
     * 这里用「关键词命中」来模拟，方便用例精确控制：
     *   __secRisky(['违禁词'])  含这些词 → risky
     *   __secReview(['疑似'])   含这些词 → review
     *   __secFail(true)         接口直接抛错（测「失败放行」）
     *   __secReset()            恢复默认（全部 pass）
     */
    security: {
      msgSecCheck: async (opt) => {
        stats.secCalls = (stats.secCalls || 0) + 1
        const content = String((opt && opt.content) || '')
        if (secFailFlag) {
          const e = new Error('security.msgSecCheck:fail system error')
          e.errCode = -1
          throw e
        }
        if (secRiskyWords.some(w => w && content.indexOf(w) >= 0)) {
          return { errCode: 0, errMsg: 'ok', result: { suggest: 'risky', label: 20001 } }
        }
        if (secReviewWords.some(w => w && content.indexOf(w) >= 0)) {
          return { errCode: 0, errMsg: 'ok', result: { suggest: 'review', label: 100 } }
        }
        return { errCode: 0, errMsg: 'ok', result: { suggest: 'pass', label: 100 } }
      }
    },
    phonenumber: {
      getPhoneNumber: async () => {
        stats.phoneCalls++
        if (phoneFailFlag) {
          const e = new Error('phonenumber.getPhoneNumber:fail invalid code')
          e.errCode = -1
          throw e
        }
        return {
          errCode: 0,
          errMsg: 'ok',
          phoneInfo: {
            phoneNumber: currentPhone,
            purePhoneNumber: currentPhone,
            countryCode: '86'
          }
        }
      }
    }
  },
  /* —— 仅测试用的后门 —— */
  __store: store,
  __stats: stats,
  __totals: totals,
  __setOpenId: id => { CURRENT_OPENID = id },
  /** 设定 getPhoneNumber 返回的号码 */
  __setPhone: (p) => { currentPhone = p || '13800000000' },
  /** 模拟换手机号失败（用于测 bindPhone 的降级分支） */
  __failPhone: (v) => { phoneFailFlag = v !== false },
  /* —— 内容安全的后门 —— */
  /** 含这些词的内容判为 risky */
  __secRisky: (words) => { secRiskyWords = Array.isArray(words) ? words : (words ? [words] : []) },
  /** 含这些词的内容判为 review */
  __secReview: (words) => { secReviewWords = Array.isArray(words) ? words : (words ? [words] : []) },
  /** 让接口直接抛错（测「检测失败」时的放行策略） */
  __secFail: (v) => { secFailFlag = v !== false },
  /** 恢复默认 + 清零调用计数 */
  __secReset: () => { secFailFlag = false; secRiskyWords = []; secReviewWords = []; stats.secCalls = 0 },
  /** 接口被调用了几次 */
  __secCalls: () => stats.secCalls || 0,
  __reset: () => { store.collections = {}; commitSeq = 0; seq = 0 },
  __resetStats: () => {
    totals.transactions += stats.transactions
    totals.retries += stats.retries
    totals.subscribeSends += stats.subscribeSends
    totals.phoneCalls += stats.phoneCalls
    stats.transactions = 0
    stats.retries = 0
    stats.subscribeSends = 0
    stats.phoneCalls = 0
  }
}
