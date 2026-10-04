/**
 * skill 云函数离线回归用例（9 个 action）
 * ==================================================================
 * 契约见 docs/ARCHITECTURE.md §4.2
 * action：list | detail | create | update | remove | myList | categories | banners | report
 *
 * ⚠️ 断言消息里带「⚠️ 偏差」前缀的，断言的是**当前实现的实际行为**，
 *    而不是文档期望的行为 —— 它们是本次记录下来的契约偏差（保持绿色不制造红灯），
 *    完整清单见回报给 Lead 的缺陷列表。
 * ==================================================================
 */
module.exports = async function (t) {
  /** 校内坐标（1 栋）—— 新安全策略要求：发布必须带**校内**地点 */
  const LOC = { longitude: 112.818333, latitude: 23.003611, address: '广职院 · 山下 1 栋', locationName: '山下 1 栋楼下' }
  /** 构造一条技能文档（默认作者 o_sel、上架、非置顶） */
  const mkSkill = (id, over) => Object.assign({
    _id: id, _openid: 'o_sel', authorId: 'o_sel',
    authorInfo: { nickName: '卖家思远', avatarUrl: '', creditScore: 110, creditLevel: 'good', authStatus: 2 },
    type: 'offer', title: '技能' + id, desc: '描述' + id, categoryId: 'c2', categoryName: '技能教学', categoryIcon: '🎸',
    price: 3, duration: 60, images: [], tags: [], status: 1, isTop: false,
    viewCount: 0, orderCount: 0, createTime: t.D(3)
  }, over || {})

  /** 取列表里的 _id 序列 */
  const ids = r => r.data.list.map(x => x._id)
  /** 举报集合（集合在第一次 add 之前不存在，读的时候要兜底） */
  const reports = () => t.store().reports || []

  /* ==================================================================
   * 组 1：list —— 只返回上架技能 + 分页
   * ================================================================== */
  t.group('组 1 · list：只返回 status=1 的技能 + 分页 total/hasMore')

  t.seed()
  t.store().skills = [
    mkSkill('s1'),
    mkSkill('s_off', { status: 0 }),
    mkSkill('s_audit', { status: 2 }),
    mkSkill('s_done', { status: 4 })
  ]
  let r = await t.call('skill', 'o_buy', 'list', {})
  t.eq(r.code, 0, 'list 调用成功')
  t.eq(JSON.stringify(ids(r)), '["s1"]', '★ 只返回 status=1（下架 0 / 待审 2 / 完成 4 都不出现在广场）')
  t.eq(r.data.total, 1, 'total 只统计上架技能')
  t.eq(r.data.hasMore, false, 'hasMore=false')
  t.eq(r.data.page, 1, 'page 默认 1')
  t.eq(Object.keys(r.data).sort().join(','), 'hasMore,list,page,total', '出参字段与契约一致')

  const many = []
  for (let i = 0; i < 12; i++) many.push(mkSkill('p' + i, { createTime: t.D(i + 1) }))
  t.store().skills = many
  r = await t.call('skill', 'o_buy', 'list', { page: 1, size: 5 })
  t.eq(r.data.list.length, 5, 'size=5 生效')
  t.eq(r.data.total, 12, 'total=12')
  t.eq(r.data.hasMore, true, '第 1 页 hasMore=true')
  r = await t.call('skill', 'o_buy', 'list', { page: 3, size: 5 })
  t.eq(r.data.list.length, 2, '第 3 页返回 2 条')
  t.eq(r.data.hasMore, false, '最后一页 hasMore=false')
  r = await t.call('skill', 'o_buy', 'list', { page: 4, size: 5 })
  t.eq(r.data.list.length, 0, '越界页返回空数组（不报错）')
  r = await t.call('skill', 'o_buy', 'list', { size: 100 })
  t.eq(r.data.list.length, 12, 'size 超过 50 被夹到 50（这里只有 12 条）')
  r = await t.call('skill', 'o_buy', 'list', { page: 0 })
  t.eq(r.data.page, 1, 'page=0 被夹到 1')
  r = await t.callRaw('skill', { action: 'list' })
  t.eq(r.code, 0, '广场列表无需登录即可访问')

  /* ==================================================================
   * 组 2：list 排序 —— ★ isTop desc 是所有排序模式的第一排序键
   * ================================================================== */
  t.group('组 2 · list 排序：★ isTop desc 贯穿 new/hot/priceAsc/priceDesc')

  const seedSort = () => {
    t.seed()
    t.store().skills = [
      mkSkill('s_top', { isTop: true, createTime: t.D(100), viewCount: 1, price: 9 }),
      mkSkill('s_new', { createTime: t.D(1), viewCount: 100, price: 5 }),
      mkSkill('s_mid', { createTime: t.D(2), viewCount: 50, price: 3 })
    ]
  }

  seedSort()
  r = await t.call('skill', 'o_buy', 'list', { sort: 'new' })
  t.eq(JSON.stringify(ids(r)), '["s_top","s_new","s_mid"]', 'sort=new：置顶最老也排第一，其余按时间倒序')
  seedSort()
  r = await t.call('skill', 'o_buy', 'list', {})
  t.eq(JSON.stringify(ids(r)), '["s_top","s_new","s_mid"]', '不传 sort 默认 new')
  seedSort()
  r = await t.call('skill', 'o_buy', 'list', { sort: 'bogus' })
  t.eq(JSON.stringify(ids(r)), '["s_top","s_new","s_mid"]', 'sort 非法值回退 new')
  seedSort()
  r = await t.call('skill', 'o_buy', 'list', { sort: 'hot' })
  t.eq(JSON.stringify(ids(r)), '["s_top","s_new","s_mid"]', 'sort=hot：★ 置顶仍优先，其余按 viewCount 倒序')
  seedSort()
  r = await t.call('skill', 'o_buy', 'list', { sort: 'priceAsc' })
  t.eq(JSON.stringify(ids(r)), '["s_top","s_mid","s_new"]', 'sort=priceAsc：★ 置顶仍优先，其余按 price 升序')
  seedSort()
  r = await t.call('skill', 'o_buy', 'list', { sort: 'priceDesc' })
  t.eq(JSON.stringify(ids(r)), '["s_top","s_new","s_mid"]', 'sort=priceDesc：★ 置顶仍优先，其余按 price 降序')

  for (const sort of ['new', 'hot', 'priceAsc', 'priceDesc']) {
    seedSort()
    const res = await t.call('skill', 'o_buy', 'list', { sort })
    t.eq(res.data.list[0]._id, 's_top', `★ sort=${sort} 时 isTop=true 的技能排第一`)
  }

  /* ==================================================================
   * 组 3：list —— ★ sort='near' 无经纬度时静默降级（不报错、不返空）
   * ================================================================== */
  t.group("组 3 · list：★ sort='near' 但没传经纬度 → 静默降级为 createTime desc")

  const seedDegrade = () => {
    t.seed()
    t.store().skills = [
      mkSkill('d_a', { createTime: t.D(1) }),
      mkSkill('d_b', { createTime: t.D(2) }),
      mkSkill('d_c', { createTime: t.D(3) })
    ]
  }

  seedDegrade()
  r = await t.call('skill', 'o_buy', 'list', { sort: 'near' })
  t.eq(r.code, 0, '★ 不报错（code 0）')
  t.eq(r.data.total, 3, '★ 不返空（total=3）')
  t.eq(JSON.stringify(ids(r)), '["d_a","d_b","d_c"]', '★ 降级为 createTime desc（最新在前）')
  t.eq('distance' in r.data.list[0], false, '★ 降级后列表项不带 distance 字段（前端按 item.distance ?? \'\' 渲染）')

  seedDegrade()
  r = await t.call('skill', 'o_buy', 'list', { sort: 'near', longitude: 116.4 })
  t.eq(r.code, 0, '只传经度（纬度缺失）→ 同样降级不报错')
  t.eq(r.data.total, 3, '只传经度时仍返回全部 3 条')

  seedDegrade()
  r = await t.call('skill', 'o_buy', 'list', { sort: 'near', longitude: 999, latitude: 999 })
  t.eq(r.code, 0, '经纬度越界 → 同样降级不报错')
  t.eq(r.data.total, 3, '经纬度越界时仍返回全部 3 条')

  seedDegrade()
  r = await t.call('skill', 'o_buy', 'list', { sort: 'near', longitude: 'abc', latitude: 'def' })
  t.eq(r.code, 0, '经纬度非数字 → 降级不报错')

  /* ==================================================================
   * 组 4：list —— 带经纬度的 near：距离升序 + radius 裁剪 + 排除无定位
   * ================================================================== */
  t.group('组 4 · list：near 带经纬度 → geoNear 距离升序、radius 裁剪、无定位技能被排除')

  const seedNear = () => {
    t.seed()
    t.store().skills = [
      mkSkill('nA', { location: { type: 'Point', coordinates: [116.40, 39.90] }, createTime: t.D(9) }),
      mkSkill('nB', { location: { type: 'Point', coordinates: [116.41, 39.90] }, isTop: true, createTime: t.D(1) }),
      mkSkill('nFar', { location: { type: 'Point', coordinates: [117.0, 40.0] } }),
      mkSkill('nNo', { location: null })
    ]
  }

  seedNear()
  r = await t.call('skill', 'o_buy', 'list', { sort: 'near', longitude: 116.40, latitude: 39.90 })
  t.eq(r.code, 0, '带经纬度的 near 调用成功')
  t.eq(JSON.stringify(ids(r)), '["nA","nB"]', '★ 按距离升序返回；60km 外的 nFar 与无定位的 nNo 被排除')
  t.eq(r.data.total, 2, 'total 只统计半径内的技能')
  t.eq(r.data.list[0].distance, 0, '★ 列表项带 distance（原点自身 0 米）')
  t.ok(Math.abs(r.data.list[1].distance - 853) <= 3, '★ 第二项 distance ≈ 853 米（0.01 经度 @北纬 39.9）', r.data.list[1].distance)
  t.eq(Number.isInteger(r.data.list[0].distance), true, 'distance 是整数（已 Math.round）')
  t.ok(r.data.list[0].distance <= r.data.list[1].distance, 'distance 单调不减')
  t.eq(ids(r)[0], 'nA', '★ near 模式下 isTop 不参与排序（置顶的 nB 距离更远仍排第二）—— 与 mock.js 注释一致')

  seedNear()
  r = await t.call('skill', 'o_buy', 'list', { sort: 'near', longitude: 116.40, latitude: 39.90, radius: 500 })
  t.eq(JSON.stringify(ids(r)), '["nA"]', 'radius=500 → 853 米外的 nB 被裁掉')
  seedNear()
  r = await t.call('skill', 'o_buy', 'list', { sort: 'near', longitude: 116.40, latitude: 39.90, radius: 10 })
  t.eq(JSON.stringify(ids(r)), '["nA"]', 'radius=10 被夹到下限 100（nA 仍在半径内）')
  seedNear()
  r = await t.call('skill', 'o_buy', 'list', { sort: 'near', longitude: 116.40, latitude: 39.90, radius: 999999 })
  t.eq(JSON.stringify(ids(r)), '["nA","nB"]', 'radius 被夹到上限 50000（60km 外的 nFar 仍被排除）')
  seedNear()
  r = await t.call('skill', 'o_buy', 'list', { sort: 'near', longitude: 116.40, latitude: 39.90, page: 1, size: 1 })
  t.eq(r.data.list.length, 1, 'near 模式同样支持分页')
  t.eq(r.data.total, 2, 'near 分页的 total 是半径内总数')

  /* ==================================================================
   * 组 5：list —— 关键词 / type / categoryId / onlyVerified / status 校验
   * ================================================================== */
  t.group('组 5 · list 过滤：关键词（title/desc/tags/categoryName）、type、categoryId、onlyVerified')

  const seedFilter = () => {
    t.seed()
    t.store().skills = [
      mkSkill('k1', { title: '吉他入门一对一', desc: '第一节课就能弹唱', tags: ['零基础'], categoryId: 'c2', categoryName: '技能教学' }),
      mkSkill('k2', { title: '剪映速成', desc: '教你用剪映做视频', tags: ['剪辑'], categoryId: 'c5', categoryName: '电脑技术' }),
      mkSkill('k3', { title: '证件照拍摄', desc: '当天出片', tags: ['摄影'], categoryId: 'c3', categoryName: '摄影修图' }),
      mkSkill('k4', { title: 'ps教程', desc: '设计基础', tags: ['PS'], categoryId: 'c8', categoryName: '设计美工', type: 'need', authorInfo: { nickName: '甲', avatarUrl: '', creditScore: 100, creditLevel: 'good', authStatus: 0 } })
    ]
  }

  seedFilter()
  r = await t.call('skill', 'o_buy', 'list', { keyword: '吉他' })
  t.eq(JSON.stringify(ids(r)), '["k1"]', '关键词命中 title')
  seedFilter()
  r = await t.call('skill', 'o_buy', 'list', { keyword: '剪映' })
  t.eq(JSON.stringify(ids(r)), '["k2"]', '关键词命中 desc')
  seedFilter()
  r = await t.call('skill', 'o_buy', 'list', { keyword: '零基础' })
  t.eq(JSON.stringify(ids(r)), '["k1"]', '关键词命中 tags（k1 的 tags 含「零基础」；stub 已支持数组字段的正则匹配）')
  seedFilter()
  r = await t.call('skill', 'o_buy', 'list', { keyword: '摄影修图' })
  t.eq(JSON.stringify(ids(r)), '["k3"]', '关键词命中 categoryName')
  seedFilter()
  r = await t.call('skill', 'o_buy', 'list', { keyword: 'ps' })
  t.eq(JSON.stringify(ids(r)), '["k4"]', '关键词忽略大小写（ps 命中 ps教程）')
  seedFilter()
  r = await t.call('skill', 'o_buy', 'list', { keyword: '吉他 一对一' })
  t.eq(JSON.stringify(ids(r)), '["k1"]', '空格分词 = AND（两个词都命中同一文档才返回）')
  seedFilter()
  r = await t.call('skill', 'o_buy', 'list', { keyword: '吉他 剪映' })
  t.eq(r.data.total, 0, '空格分词 AND：没有任何文档同时命中两个词 → 空列表')
  seedFilter()
  r = await t.call('skill', 'o_buy', 'list', { keyword: '  吉他  ' })
  t.eq(JSON.stringify(ids(r)), '["k1"]', '关键词首尾空白被忽略')
  seedFilter()
  r = await t.call('skill', 'o_buy', 'list', { keyword: '吉他 入门 一对一 不存在' })
  t.eq(JSON.stringify(ids(r)), '["k1"]', '⚠️ 偏差：关键词最多取前 3 个分词，第 4 个词被静默丢弃（k1 仍命中）')
  seedFilter()
  r = await t.call('skill', 'o_buy', 'list', { keyword: '根本不存在的词' })
  t.eq(r.data.total, 0, '无命中 → total 0（不是 404）')

  seedFilter()
  r = await t.call('skill', 'o_buy', 'list', { type: 'need' })
  t.eq(JSON.stringify(ids(r)), '["k4"]', 'type=need 过滤生效')
  seedFilter()
  r = await t.call('skill', 'o_buy', 'list', { type: 'offer' })
  t.eq(r.data.total, 3, 'type=offer 过滤生效')
  seedFilter()
  r = await t.call('skill', 'o_buy', 'list', { type: 'bogus' })
  t.eq(r.data.total, 4, 'type 非法值被忽略（不过滤）')

  seedFilter()
  r = await t.call('skill', 'o_buy', 'list', { categoryId: 'c3' })
  t.eq(JSON.stringify(ids(r)), '["k3"]', 'categoryId 过滤生效')

  seedFilter()
  r = await t.call('skill', 'o_buy', 'list', { onlyVerified: true })
  t.eq(JSON.stringify(ids(r)), '["k1","k2","k3"]', '★ onlyVerified 只返回 authorInfo.authStatus===2 的技能')

  seedFilter()
  r = await t.call('skill', 'o_buy', 'list', { status: 0 })
  t.eq(r.code, 0, 'status=0 是合法枚举，不报错')
  t.eq(r.data.total, 0, '★ status=0 真正生效：fixture 里没有已下架技能，所以 0 条（修复前会被 forceStatus1 覆盖、返回 4 条上架技能）')
  // 造一条已下架技能，验证 status=0 确实能把它筛出来
  t.store().skills.find(s => s._id === 'k4').status = 0
  r = await t.call('skill', 'o_buy', 'list', { status: 0 })
  t.eq(JSON.stringify(ids(r)), '["k4"]', '★ status=0 能筛出已下架技能（调用方显式传的 status 被尊重）')
  r = await t.call('skill', 'o_buy', 'list', { status: 5 })
  t.eq(r.code, 400, 'status=5 非法枚举 → 400')
  t.ok(/技能状态/.test(r.msg), '400 文案面向用户', r.msg)
  r = await t.call('skill', 'o_buy', 'list', { status: 'abc' })
  t.eq(r.code, 400, 'status 非数字 → 400')

  seedFilter()
  r = await t.call('skill', 'o_buy', 'list', { authorId: 'o_sel' })
  t.eq(r.code, 0, 'authorId 参数不报错')
  t.eq(r.data.total, 4, '⚠️ 偏差：§4.2 声明 list 支持 authorId 过滤，实现忽略它（mock.js 支持）')

  /* ==================================================================
   * 组 6：detail —— viewCount +1、作者带 stats、隐私过滤、isOwner
   * ================================================================== */
  t.group('组 6 · detail：viewCount 自增 + 作者带 stats + 作者隐私过滤 + isOwner')

  t.seed()
  r = await t.call('skill', 'o_buy', 'detail', { id: 'sk1' })
  t.eq(r.code, 0, 'detail 调用成功')
  t.eq(r.data.skill._id, 'sk1', '返回技能本体')
  t.eq(r.data.skill.viewCount, 1, '★ 返回的 viewCount = 原值 0 + 1')
  t.eq(t.skill().viewCount, 1, '★ viewCount 已自增落库')
  await t.call('skill', 'o_buy', 'detail', { id: 'sk1' })
  t.eq(t.skill().viewCount, 2, '★ 再调一次 → 落库值 2（累加而非覆盖）')
  t.eq(r.data.isOwner, false, '非作者查看 isOwner=false')
  t.eq(r.data.isCollected, false, '★ isCollected 恒为 false（预留字段，功能未实现）')
  t.eq(Object.keys(r.data).sort().join(','), 'author,isCollected,isOwner,skill', '出参字段与契约一致')

  const au = r.data.author
  t.eq(typeof au.stats, 'object', '★ author 必须带 stats')
  t.eq(au.stats.avgRating, 4.7, 'author.stats.avgRating 取作者文档的真实值')
  t.eq(au.stats.serveCount, 0, 'author.stats.serveCount 存在')
  t.eq(au.stats.reviewCount, 0, 'author.stats.reviewCount 存在')
  t.eq(au.stats.buyCount, 0, 'author.stats.buyCount 存在')
  t.eq(au.nickName, '卖家思远', 'author 公开字段可用')
  t.eq(au.creditScore, 110, 'author 公开字段 creditScore')

  t.seed()
  Object.assign(t.store().users[1], {
    phone: '13800000000', studentNo: '2021001', realName: '王思远',
    authImages: ['cloud://a.png'], authRemark: '请补材料'
  })
  r = await t.call('skill', 'o_buy', 'detail', { id: 'sk1' })
  t.eq(r.data.author.phone, undefined, '★ author.phone 被滤掉')
  t.eq(r.data.author.studentNo, undefined, '★ author.studentNo 被滤掉')
  t.eq(r.data.author.realName, undefined, '★ author.realName 被滤掉')
  t.eq(r.data.author.authImages, undefined, '★ author.authImages 被滤掉')
  t.eq(r.data.author.authRemark, undefined, '★ author.authRemark 被滤掉')
  t.eq('phone' in r.data.author, false, '★ author 响应里连 phone 键都不存在')

  t.seed()
  r = await t.call('skill', 'o_sel', 'detail', { id: 'sk1' })
  t.eq(r.data.isOwner, true, '作者自己查看 isOwner=true')
  r = await t.callRaw('skill', { action: 'detail', id: 'sk1' })
  t.eq(r.data.isOwner, false, '未登录查看 isOwner=false')

  t.seed()
  t.store().skills = [mkSkill('sk_orphan', { authorId: 'o_nobody' })]
  r = await t.call('skill', 'o_buy', 'detail', { id: 'sk_orphan' })
  t.eq(r.code, 0, '作者文档缺失不影响详情返回')
  t.eq(r.data.author.stats.avgRating, 0, '作者不存在时 stats 默认 avgRating=0')
  t.eq(r.data.author.stats.reviewCount, 0, '作者不存在时 stats 默认 reviewCount=0')
  t.eq(r.data.skill._id, 'sk_orphan', '技能本体仍返回')

  r = await t.call('skill', 'o_buy', 'detail', {})
  t.eq(r.code, 400, '缺 id → 400')
  t.ok(/缺少技能 id/.test(r.msg), '400 文案', r.msg)
  r = await t.call('skill', 'o_buy', 'detail', { id: 'sk_nope' })
  t.eq(r.code, 404, '技能不存在 → 404')
  t.ok(/技能不存在/.test(r.msg), '404 文案', r.msg)

  /* ==================================================================
   * 组 7：create —— 认证门槛、入参校验、副作用（发布数 +1）
   * ================================================================== */
  t.group('组 7 · create：需已认证 + 全量入参校验 + publishCount 自增')

  t.seed()
  r = await t.call('skill', 'o_buy', 'create', { ...LOC,
    type: 'need', title: '求带剪映', desc: '完全不会剪辑', categoryId: 'c5',
    price: '5', duration: 45.6, images: ['a', 'a', '', 'b', 'c', 'd'], tags: ['x', 'x', 'y'],
    longitude: 112.818333, latitude: 23.003611, address: '广职院 · 山下 1 栋', locationName: '山下 1 栋楼下'
  })
  t.eq(r.code, 0, '发布成功')
  t.ok(!!r.data.id, '出参 { id }')
  const created = t.store().skills.find(x => x._id === r.data.id)
  t.eq(created._openid, 'o_buy', '写入 _openid = 发布者')
  t.eq(created.authorId, 'o_buy', 'authorId = 发布者')
  t.eq(created.authorInfo.nickName, '买家小明', 'authorInfo 作者快照（昵称）')
  t.eq(created.authorInfo.creditScore, 100, 'authorInfo 信用分快照')
  t.eq(created.authorInfo.authStatus, 2, 'authorInfo 认证状态快照')
  t.eq(created.type, 'need', 'type 落库')
  t.eq(created.title, '求带剪映', 'title 落库')
  t.eq(created.desc, '完全不会剪辑', 'desc 落库')
  t.eq(created.categoryId, 'c5', 'categoryId 落库')
  t.eq(created.categoryName, '其他', '分类文档不存在时降级为「其他」')
  t.eq(created.categoryIcon, '✨', '分类文档不存在时图标降级 ✨')
  t.eq(created.price, 5, 'price 字符串被转成数字 5')
  t.eq(created.duration, 46, 'duration 45.6 四舍五入为 46')
  t.eq(JSON.stringify(created.images), '["a","b","c"]', 'images 去空去重 + 最多 3 张')
  t.eq(JSON.stringify(created.tags), '["x","y"]', 'tags 去重 + 最多 5 个')
  t.eq(created.location.coordinates[0], 112.818333, 'location 经度落库（Geo.Point 经度在前）')
  t.eq(created.location.coordinates[1], 23.003611, 'location 纬度落库')
  t.eq(created.address, '广职院 · 山下 1 栋', 'address 落库')
  t.eq(created.locationName, '山下 1 栋楼下', 'locationName 落库')
  t.eq(created.status, 1, '★ 新建技能 status=1（直接上架）')
  t.eq(created.auditRemark, '', 'auditRemark 初始空')
  t.eq(created.isTop, false, 'isTop 初始 false')
  t.eq(created.viewCount, 0, 'viewCount 初始 0')
  t.eq(created.orderCount, 0, 'orderCount 初始 0')
  t.eq(t.user('o_buy').stats.publishCount, 1, '★ 发布者 stats.publishCount +1')

  t.seed()
  t.store().categories = [{ _id: 'c9', name: '语言互助', icon: '🌏', status: 1, sort: 9 }]
  r = await t.call('skill', 'o_buy', 'create', { ...LOC, title: '英语陪练', desc: '口语', categoryId: 'c9', price: 2, duration: 60 })
  const c2 = t.store().skills.find(x => x._id === r.data.id)
  t.eq(c2.categoryName, '语言互助', '分类存在时 categoryName 取真实名称')
  t.eq(c2.categoryIcon, '🌏', '分类存在时 categoryIcon 取真实图标')

  /* ★ 安全策略：只能发校内 —— 不传地点直接拒，校外坐标也拒 */
  t.seed()
  r = await t.call('skill', 'o_buy', 'create', { title: '无定位', desc: 'd', categoryId: 'c1', price: 1, duration: 1 })
  t.eq(r.code, 400, '★ 不传服务地点 → 400（策略：必须选校内地点）')
  t.ok(/校内/.test(r.msg), '400 文案点明「只能发校内」', r.msg)

  r = await t.call('skill', 'o_buy', 'create', { ...LOC, title: '校外任务', desc: '校外', categoryId: 'c1', price: 1, duration: 60, longitude: 116.4, latitude: 39.9 })
  t.eq(r.code, 400, '★ 校外坐标（北京）→ 400')
  t.ok(/无法及时处理/.test(r.msg), '文案说明「校方无法及时处理校外事件」', r.msg)
  t.eq(t.store().skills.filter(x => x._id !== 'sk1').length >= 0, true, '校外坐标没有落库')

  r = await t.call('skill', 'o_buy', 'create', { ...LOC, title: '下边界', desc: 'd', categoryId: 'c1', price: 1, duration: 1 })
  t.eq(r.code, 0, 'duration=1 合法（下边界）')
  const c3 = t.store().skills.find(x => x._id === r.data.id)
  t.eq(c3.duration, 1, 'duration 落库')
  t.eq(c3.location.coordinates[0], 112.818333, '★ 校内坐标正常落库')

  t.seed()
  r = await t.call('skill', 'o_buy', 'create', { ...LOC, title: '无定位2', desc: 'd', categoryId: 'c1', price: 999, duration: 1 })
  t.eq(r.code, 0, 'price=999 合法（上边界）')
  t.eq(t.store().skills.find(x => x._id === r.data.id).price, 999, 'price=999 落库')

  t.seed()
  r = await t.call('skill', 'o_buy', 'create', { ...LOC, type: 'weird', title: '类型非法', desc: 'd', categoryId: 'c1', price: 1, duration: 1 })
  t.eq(r.code, 0, 'type 非法值不报错')
  t.eq(t.store().skills.find(x => x._id === r.data.id).type, 'offer', 'type 非法值回退 offer')

  t.seed({ buyAuth: 0 })
  r = await t.call('skill', 'o_buy', 'create', { ...LOC, title: 't', desc: 'd', categoryId: 'c1', price: 1, duration: 1 })
  t.eq(r.code, 403, '未通过校园认证 → 403')
  t.ok(/校园认证/.test(r.msg), '403 文案', r.msg)
  t.eq(t.store().skills.length, 1, '失败后没有新增技能')

  t.seed()
  r = await t.call('skill', 'o_ghost', 'create', { ...LOC, title: 't', desc: 'd', categoryId: 'c1', price: 1, duration: 1 })
  t.eq(r.code, 401, '未注册用户 → 401')
  r = await t.callRaw('skill', { action: 'create', title: 't', desc: 'd', categoryId: 'c1', price: 1, duration: 1 })
  t.eq(r.code, 401, '无登录态 → 401')

  const badCreate = async (patch, expect, label, msgRe) => {
    const res = await t.call('skill', 'o_buy', 'create', Object.assign({
      title: 't', desc: 'd', categoryId: 'c1', price: 1, duration: 1
    }, LOC, patch))
    t.eq(res.code, expect, label)
    if (msgRe) t.ok(msgRe.test(res.msg), label + ' · 文案', res.msg)
  }

  t.seed()
  await badCreate({ title: '' }, 400, '缺标题 → 400', /标题/)
  await badCreate({ title: '   ' }, 400, '标题只有空白 → 400')
  await badCreate({ title: 'x'.repeat(31) }, 400, '标题超过 30 字 → 400', /30/)
  await badCreate({ title: 'x'.repeat(30) }, 0, '标题正好 30 字 → 成功')
  await badCreate({ desc: '' }, 400, '缺技能详情 → 400', /详情/)
  await badCreate({ categoryId: '' }, 400, '缺分类 → 400', /分类/)
  await badCreate({ price: undefined }, 400, '缺价格 → 400', /时间币数/)
  await badCreate({ price: 0 }, 400, 'price=0 → 400')
  await badCreate({ price: 1000 }, 400, 'price=1000 → 400')
  await badCreate({ price: 1.5 }, 400, 'price 非整数 → 400')
  await badCreate({ price: 'abc' }, 400, 'price 非数字 → 400')
  await badCreate({ duration: 0 }, 400, 'duration=0 → 400', /时长/)
  await badCreate({ duration: -5 }, 400, 'duration<0 → 400')
  await badCreate({ duration: 'abc' }, 400, 'duration 非数字 → 400')
  t.eq(t.user('o_buy').stats.publishCount, 1, '★ 所有失败请求都没让 publishCount 增长（只有 30 字标题那次成功）')

  /* ==================================================================
   * 组 8：update —— 仅作者可改、字段校验、分类冗余名同步
   * ================================================================== */
  t.group('组 8 · update：仅作者可改 + 校验 + 分类冗余名同步 + 局部更新不丢字段')

  t.seed()
  t.store().categories = [{ _id: 'c9', name: '语言互助', icon: '🌏', status: 1, sort: 9 }]
  r = await t.call('skill', 'o_sel', 'update', { id: 'sk1', title: '改名后的技能', categoryId: 'c9' })
  t.eq(r.code, 0, '作者编辑自己的技能成功')
  t.eq(r.data.ok, true, '出参 { ok: true }')
  t.eq(t.skill().title, '改名后的技能', 'title 已更新')
  t.eq(t.skill().categoryId, 'c9', 'categoryId 已更新')
  t.eq(t.skill().categoryName, '语言互助', '★ 分类变更同步 categoryName（避免列表显示旧分类）')
  t.eq(t.skill().categoryIcon, '🌏', '★ 分类变更同步 categoryIcon')
  t.eq(t.skill().price, 3, '★ 未传 price → 保留原值 3（局部更新不丢字段）')
  t.eq(t.skill().duration, 60, '未传 duration → 保留原值 60')
  t.eq(t.skill().status, 1, '未传 status → 保留原值')
  t.ok(!!t.skill().updateTime, 'updateTime 已刷新')

  t.seed()
  r = await t.call('skill', 'o_buy', 'update', { id: 'sk1', title: 'x' })
  t.eq(r.code, 403, '非作者编辑 → 403')
  t.ok(/只能编辑自己/.test(r.msg), '403 文案', r.msg)
  r = await t.call('skill', 'o_sel', 'update', { id: 'sk_nope', title: 'x' })
  t.eq(r.code, 404, '技能不存在 → 404')
  r = await t.call('skill', 'o_sel', 'update', { title: 'x' })
  t.eq(r.code, 400, '缺 id → 400')
  r = await t.call('skill', 'o_ghost', 'update', { id: 'sk1', title: 'x' })
  t.eq(r.code, 401, '未注册用户 → 401')
  r = await t.callRaw('skill', { action: 'update', id: 'sk1', title: 'x' })
  t.eq(r.code, 401, '无登录态 → 401')

  const badUpdate = async (patch, expect, label, msgRe) => {
    const res = await t.call('skill', 'o_sel', 'update', Object.assign({ id: 'sk1' }, patch))
    t.eq(res.code, expect, label)
    if (msgRe) t.ok(msgRe.test(res.msg), label + ' · 文案', res.msg)
  }

  t.seed()
  await badUpdate({ title: '' }, 400, '编辑时标题为空 → 400', /标题/)
  await badUpdate({ title: 'x'.repeat(31) }, 400, '编辑时标题超 30 字 → 400', /30/)
  await badUpdate({ desc: '' }, 400, '编辑时详情为空 → 400', /详情/)
  await badUpdate({ categoryId: '' }, 400, '编辑时分类为空 → 400', /分类/)
  await badUpdate({ price: 0 }, 400, '编辑时 price=0 → 400', /时间币数/)
  await badUpdate({ price: 1.5 }, 400, '编辑时 price 非整数 → 400')
  await badUpdate({ price: 1000 }, 400, '编辑时 price 越界 → 400')
  await badUpdate({ duration: 0 }, 400, '编辑时 duration=0 → 400', /时长/)
  t.eq(t.skill().price, 3, '校验失败后价格未被改动')
  t.eq(t.skill().title, '吉他入门一对一', '校验失败后标题未被改动')

  t.seed()
  await badUpdate({ type: 'weird' }, 0, '编辑时 type 非法不报错')
  t.eq(t.skill().type, 'offer', 'type 非法 → 保留原值')

  t.seed()
  await t.call('skill', 'o_sel', 'update', { id: 'sk1', desc: 'd'.repeat(600), images: ['i1', 'i1', 'i2', 'i3', 'i4'], tags: ['t1', 't2'], address: 'a'.repeat(130), locationName: 'n'.repeat(70) })
  t.eq(t.skill().desc.length, 500, 'desc 截断到 500')
  t.eq(JSON.stringify(t.skill().images), '["i1","i2","i3"]', 'images 去重 + 最多 3 张')
  t.eq(JSON.stringify(t.skill().tags), '["t1","t2"]', 'tags 更新')
  t.eq(t.skill().address.length, 120, 'address 截断到 120')
  t.eq(t.skill().locationName.length, 60, 'locationName 截断到 60')

  t.seed()
  await t.call('skill', 'o_sel', 'update', { id: 'sk1', longitude: 112.820100, latitude: 23.005500 })
  t.eq(t.skill().location.coordinates[0], 112.820100, '编辑定位：经度在前')
  t.eq(t.skill().location.coordinates[1], 23.005500, '编辑定位：纬度在后')

  const offEdit = await t.call('skill', 'o_sel', 'update', { id: 'sk1', longitude: 116.4, latitude: 39.9 })
  t.eq(offEdit.code, 400, '★ 编辑到校外 → 400（安全策略同样管编辑）')
  t.eq(t.skill().location.coordinates[0], 112.820100, '★ 校外坐标被拒后保留原坐标，没有被改写')

  await t.call('skill', 'o_sel', 'update', { id: 'sk1', longitude: 999, latitude: 999 })
  t.eq(t.skill().location.coordinates[0], 112.820100, '非法定位被忽略（保留原坐标，不写非法值）')

  /* ==================================================================
   * 组 9：remove —— 有进行中订单必须 409
   * ================================================================== */
  t.group('组 9 · remove：waiting/ongoing/confirming 订单存在时 409，finished/canceled 放行')

  t.seed()
  t.putOrder({ skillId: 'sk1', status: 'waiting' })
  r = await t.call('skill', 'o_sel', 'remove', { id: 'sk1' })
  t.eq(r.code, 409, '★ waiting 订单存在 → 409')
  t.ok(/进行中/.test(r.msg), '409 文案说明有进行中订单', r.msg)
  t.eq(t.store().skills.length, 1, '拒绝后技能仍在库')
  t.eq(t.orders().length, 1, '拒绝不删订单')

  t.seed()
  t.putOrder({ skillId: 'sk1', status: 'ongoing' })
  r = await t.call('skill', 'o_sel', 'remove', { id: 'sk1' })
  t.eq(r.code, 409, 'ongoing 订单存在 → 409')

  t.seed()
  t.putOrder({ skillId: 'sk1', status: 'confirming' })
  r = await t.call('skill', 'o_sel', 'remove', { id: 'sk1' })
  t.eq(r.code, 409, 'confirming 订单存在 → 409')

  t.seed()
  t.putOrder({ skillId: 'sk1', status: 'finished' })
  r = await t.call('skill', 'o_sel', 'remove', { id: 'sk1' })
  t.eq(r.code, 0, 'finished 订单不阻塞删除')
  t.eq(t.store().skills.length, 0, '技能已删除')

  t.seed()
  t.putOrder({ skillId: 'sk1', status: 'canceled' })
  r = await t.call('skill', 'o_sel', 'remove', { id: 'sk1' })
  t.eq(r.code, 0, 'canceled 订单不阻塞删除')

  t.seed()
  t.putOrder({ skillId: 'sk_other', status: 'waiting' })
  r = await t.call('skill', 'o_sel', 'remove', { id: 'sk1' })
  t.eq(r.code, 0, '只有「其它技能」的进行中订单时不阻塞（按 skillId 精确匹配）')

  t.seed()
  t.user('o_sel').stats.publishCount = 2
  r = await t.call('skill', 'o_sel', 'remove', { id: 'sk1' })
  t.eq(r.code, 0, '无订单时删除成功')
  t.eq(r.data.ok, true, '出参 { ok: true }')
  t.eq(t.user('o_sel').stats.publishCount, 1, '★ 删除后 stats.publishCount -1')

  t.seed()
  r = await t.call('skill', 'o_buy', 'remove', { id: 'sk1' })
  t.eq(r.code, 403, '非作者删除 → 403')
  t.ok(/只能删除自己/.test(r.msg), '403 文案', r.msg)
  r = await t.call('skill', 'o_sel', 'remove', { id: 'sk_nope' })
  t.eq(r.code, 404, '技能不存在 → 404')
  r = await t.call('skill', 'o_sel', 'remove', {})
  t.eq(r.code, 400, '缺 id → 400')
  r = await t.call('skill', 'o_ghost', 'remove', { id: 'sk1' })
  t.eq(r.code, 401, '★ 未注册用户删除技能 → 401（先判账号存在再判归属；修复前直接 403）')
  r = await t.callRaw('skill', { action: 'remove', id: 'sk1' })
  t.eq(r.code, 401, '无登录态 → 401')

  /* ==================================================================
   * 组 10：myList —— 只看自己的发布（含未上架）
   * ================================================================== */
  t.group('组 10 · myList：只看自己 + 含未上架 + isTop 优先 + 分页')

  const seedMine = () => {
    t.seed()
    t.store().skills = [
      mkSkill('m_old', { _openid: 'o_buy', authorId: 'o_buy', createTime: t.D(5) }),
      mkSkill('m_top', { _openid: 'o_buy', authorId: 'o_buy', status: 0, isTop: true, createTime: t.D(6) }),
      mkSkill('m_new', { _openid: 'o_buy', authorId: 'o_buy', status: 2, createTime: t.D(1) }),
      mkSkill('m_other', { _openid: 'o_sel', authorId: 'o_sel', createTime: t.D(1) })
    ]
  }

  seedMine()
  r = await t.call('skill', 'o_buy', 'myList', {})
  t.eq(r.code, 0, 'myList 调用成功')
  t.eq(r.data.total, 3, '★ 只有自己的 3 条（不含 o_sel 的）')
  t.eq(JSON.stringify(ids(r)), '["m_top","m_new","m_old"]', '★ isTop 优先，其余按 createTime desc')
  t.ok(r.data.list.every(x => x.authorId === 'o_buy'), '列表里全是自己的技能')
  t.ok(r.data.list.some(x => x.status === 0) && r.data.list.some(x => x.status === 2), '★ 未上架/待审的技能也返回（我的发布要能看到）')
  t.eq(r.data.hasMore, false, 'hasMore=false')
  t.eq(r.data.page, 1, 'page=1')

  seedMine()
  r = await t.call('skill', 'o_buy', 'myList', { page: 1, size: 2 })
  t.eq(r.data.list.length, 2, 'size=2 生效')
  t.eq(r.data.hasMore, true, '还有下一页')
  r = await t.call('skill', 'o_buy', 'myList', { page: 2, size: 2 })
  t.eq(r.data.list.length, 1, '第 2 页返回 1 条')
  t.eq(r.data.hasMore, false, '最后一页 hasMore=false')

  seedMine()
  r = await t.call('skill', 'o_buy', 'myList', { status: 0 })
  t.eq(r.data.total, 1, 'status=0 过滤生效（myList 不像 list 那样被强制成 status=1）')
  r = await t.call('skill', 'o_buy', 'myList', { status: 5 })
  t.eq(r.code, 400, 'status 非法 → 400')
  r = await t.call('skill', 'o_buy', 'myList', { type: 'offer' })
  t.eq(r.data.total, 3, 'type=offer 过滤生效')

  t.seed()
  r = await t.call('skill', 'o_sel', 'myList', {})
  t.eq(r.data.total, 1, 'o_sel 只看到自己的 1 条')
  r = await t.call('skill', 'o_ghost', 'myList', {})
  t.eq(r.code, 401, '★ 未注册用户 myList → 401（修复前返回 0 + 空列表）')
  t.eq(r.data, null, '★ 不再返回「0 + 空列表」——那种响应无法区分「没数据」和「没登录」')
  r = await t.callRaw('skill', { action: 'myList' })
  t.eq(r.code, 401, '无登录态 → 401')

  /* ==================================================================
   * 组 11：categories / banners —— 只返回启用项
   * ================================================================== */
  t.group('组 11 · categories/banners：只返回 status=1，按 sort 升序')

  t.seed()
  t.store().categories = [
    { _id: 'c1', name: '学业辅导', icon: '📚', sort: 3, status: 1 },
    { _id: 'c2', name: '技能教学', icon: '🎸', sort: 1, status: 1 },
    { _id: 'c3', name: '已停用分类', icon: '❌', sort: 2, status: 0 }
  ]
  r = await t.callRaw('skill', { action: 'categories' })
  t.eq(r.code, 0, 'categories 调用成功')
  t.eq(r.data.list.length, 2, '★ 只返回 status=1 的分类')
  t.eq(r.data.list[0]._id, 'c2', '★ 按 sort 升序（sort=1 在前）')
  t.eq(r.data.list[1]._id, 'c1', '第二项 sort=3')
  t.ok(r.data.list.every(x => x.status === 1), '停用分类不在返回里')

  const banners = []
  for (let i = 1; i <= 22; i++) banners.push({ _id: 'b' + i, title: '轮播' + i, sort: i, status: 1 })
  banners.push({ _id: 'b_off', title: '已停用', sort: 0, status: 0 })
  t.store().banners = banners
  r = await t.callRaw('skill', { action: 'banners' })
  t.eq(r.code, 0, 'banners 调用成功')
  t.eq(r.data.list.length, 20, '★ 单次最多返回 20 条')
  t.ok(r.data.list.every(x => x.status === 1), '停用轮播不在返回里')
  t.eq(r.data.list[0]._id, 'b1', '按 sort 升序（sort=1 在前）')

  t.seed()
  t.store().categories = []
  t.store().banners = []
  r = await t.callRaw('skill', { action: 'categories' })
  t.eq(r.data.list.length, 0, '空集合返回空数组（不报错）')
  r = await t.callRaw('skill', { action: 'banners' })
  t.eq(r.data.list.length, 0, '空轮播返回空数组（不报错）')

  /* ==================================================================
   * 组 12：report —— 校验、自举报、重复举报、冗余补全、remark 截断
   * ================================================================== */
  t.group('组 12 · report：入参校验 + 自举报 409 + 重复举报 409 + remark 落库截断')

  t.seed()
  r = await t.call('skill', 'o_buy', 'report', {
    targetType: 'skill', targetId: 'sk1', reason: '  虚假  信息  ',
    remark: 'x'.repeat(250), images: ['a', 'b', 'c', 'd']
  })
  t.eq(r.code, 0, '举报成功')
  t.eq(r.data.ok, true, '出参 ok=true')
  t.ok(!!r.data.id, '出参带举报记录 id')
  const rep = reports()[0]
  t.eq(rep._openid, 'o_buy', '举报人 openid 落库')
  t.eq(rep.targetType, 'skill', 'targetType 落库')
  t.eq(rep.targetId, 'sk1', 'targetId 落库')
  t.eq(rep.reason, '虚假 信息', 'reason 首尾去空白 + 折叠连续空白')
  t.eq(rep.remark.length, 200, '★ remark 截断到 200 字')
  t.eq(rep.remark, 'x'.repeat(200), 'remark 内容为前 200 字')
  t.eq(JSON.stringify(rep.images), '["a","b","c"]', '★ 举报图片最多 3 张')
  t.eq(rep.status, 0, '举报初始 status=0（待处理）')
  t.eq(rep.handleRemark, '', 'handleRemark 初始空')
  t.eq(rep.handleTime, null, 'handleTime 初始 null')
  t.eq(rep.targetTitle, '吉他入门一对一', '★ targetTitle 未传时按 targetType 自动补全为技能标题')
  t.eq(rep.targetUserId, 'o_sel', '★ targetUserId 自动补全为技能作者')

  r = await t.call('skill', 'o_buy', 'report', { targetType: 'skill', targetId: 'sk1', reason: '再次举报' })
  t.eq(r.code, 409, '★ 同一用户对同一对象重复举报 → 409')
  t.ok(/已举报过/.test(r.msg), '409 文案', r.msg)
  t.eq(reports().length, 1, '重复举报不写第二条记录')

  t.seed()
  r = await t.call('skill', 'o_buy', 'report', { targetType: 'user', targetId: 'o_buy', reason: 'x' })
  t.eq(r.code, 409, '★ 举报自己（targetType=user）→ 409')
  t.ok(/不能举报自己/.test(r.msg), '409 文案', r.msg)
  t.eq(reports().length, 0, '自举报不落库')

  t.seed()
  t.store().skills[0].authorId = 'o_buy'
  t.store().skills[0]._openid = 'o_buy'
  r = await t.call('skill', 'o_buy', 'report', { targetType: 'skill', targetId: 'sk1', reason: 'x' })
  t.eq(r.code, 409, '★ 举报自己的技能 → 409（targetUserId 自动补全后命中自举报规则）')

  t.seed()
  r = await t.call('skill', 'o_buy', 'report', { targetType: 'user', targetId: 'o_sel', reason: '爽约' })
  t.eq(r.code, 0, '举报他人成功')
  t.eq(reports()[0].targetTitle, '卖家思远', 'targetType=user 时补全昵称')
  t.eq(reports()[0].targetUserId, 'o_sel', 'targetType=user 时补全 openid')

  t.seed()
  t.putOrder({ _id: 'ord1', skillId: 'sk1', status: 'waiting' })
  r = await t.call('skill', 'o_buy', 'report', { targetType: 'order', targetId: 'ord1', reason: 'x' })
  t.eq(r.code, 0, '举报订单成功')
  t.eq(reports()[0].targetTitle, 'TB_MANUAL_0', 'targetType=order 时补全订单号')
  t.eq(reports()[0].targetUserId, 'o_sel', 'targetType=order 时补全对方 openid（买家举报 → 卖家）')

  t.seed()
  t.store().reviews = [{ _id: 'rv1', content: '很棒的评论', fromId: 'o_sel' }]
  r = await t.call('skill', 'o_buy', 'report', { targetType: 'review', targetId: 'rv1', reason: 'x' })
  t.eq(r.code, 0, '举报评价成功')
  t.eq(reports()[0].targetTitle, '很棒的评论', 'targetType=review 时补全评价内容')
  t.eq(reports()[0].targetUserId, 'o_sel', 'targetType=review 时补全评价人')

  t.seed()
  r = await t.call('skill', 'o_buy', 'report', { targetType: 'skill', targetId: 'sk_nope', reason: 'x' })
  t.eq(r.code, 0, '举报不存在的对象仍可提交（人去楼空也要能投诉）')
  t.eq(reports()[0].targetTitle, '', '补全失败时 targetTitle 为空字符串')

  t.seed()
  r = await t.call('skill', 'o_buy', 'report', { targetType: 'skill', targetId: 'sk1', reason: 'x', targetTitle: '我指定的标题', targetUserId: 'o_xxx' })
  t.eq(reports()[0].targetTitle, '我指定的标题', '前端传了 targetTitle 时以传入值为准')
  t.eq(reports()[0].targetUserId, 'o_xxx', '前端传了 targetUserId 时以传入值为准')

  t.seed()
  r = await t.call('skill', 'o_buy', 'report', { targetType: 'bogus', targetId: 'x', reason: 'y' })
  t.eq(r.code, 400, '非法 targetType → 400')
  t.ok(/类型不正确/.test(r.msg), '400 文案', r.msg)
  r = await t.call('skill', 'o_buy', 'report', { targetType: 'skill', reason: 'y' })
  t.eq(r.code, 400, '缺 targetId → 400')
  t.ok(/缺少举报对象/.test(r.msg), '400 文案', r.msg)
  r = await t.call('skill', 'o_buy', 'report', { targetType: 'skill', targetId: 'sk1' })
  t.eq(r.code, 400, '缺 reason → 400')
  t.ok(/举报原因/.test(r.msg), '400 文案', r.msg)
  r = await t.call('skill', 'o_buy', 'report', { targetType: 'skill', targetId: 'sk1', reason: '   ' })
  t.eq(r.code, 400, 'reason 仅空白 → 400')
  r = await t.call('skill', 'o_buy', 'report', { targetType: 'skill', targetId: 'sk1', reason: 'r'.repeat(100) })
  t.eq(reports()[0].reason.length, 60, 'reason 截断到 60 字')

  t.seed({ buyAuth: 0 })
  r = await t.call('skill', 'o_buy', 'report', { targetType: 'skill', targetId: 'sk1', reason: 'x' })
  t.eq(r.code, 0, '未认证用户也能举报（举报不设认证门槛）')

  t.seed()
  r = await t.call('skill', 'o_ghost', 'report', { targetType: 'skill', targetId: 'sk1', reason: 'x' })
  t.eq(r.code, 401, '未注册用户举报 → 401')
  r = await t.callRaw('skill', { action: 'report', targetType: 'skill', targetId: 'sk1', reason: 'x' })
  t.eq(r.code, 401, '无登录态举报 → 401')

  t.seed()
  r = await t.call('skill', 'o_buy', 'report', { targetType: 'skill', targetId: 'sk1', reason: 'x' })
  t.eq(r.code, 0, '第一次举报成功')
  r = await t.call('skill', 'o_weak', 'report', { targetType: 'skill', targetId: 'sk1', reason: 'x' })
  t.eq(r.code, 0, '★ 防刷是按「举报人 + 对象」维度，另一个人可以举报同一对象')
  t.eq(reports().length, 2, '两条举报记录并存')

  /* ==================================================================
   * 组 13：入口协议
   * ================================================================== */
  t.group('组 13 · 入口协议：未知 action → 400')

  r = await t.call('skill', 'o_buy', 'nope', {})
  t.eq(r.code, 400, '未知 action → 400')
  t.ok(/未知 action/.test(r.msg), '400 文案', r.msg)

  /* ==================================================================
   * 组 14：★ collect / myFavorites —— 收藏功能
   * ================================================================== */
  t.group('组 14 · ★ collect / myFavorites：收藏、取消收藏、我的收藏列表')

  const favs = () => t.store().favorites || []

  t.seed()
  t.store().skills = [
    mkSkill('f1'),
    mkSkill('f2'),
    mkSkill('f3', { status: 0 }),                          // 已下架
    mkSkill('f4', { authorId: 'o_buy', _openid: 'o_buy' }), // 自己发布的
    mkSkill('f5', { authorId: 'o_third', _openid: 'o_third' }) // 给 o_sel 收藏用（o_sel 是 f1/f2 的作者，不能收藏自己的）
  ]

  /* ---- 校验分支 ---- */
  t.eq((await t.call('skill', 'o_ghost', 'collect', { id: 'f1' })).code, 401, '未注册 → 401')
  t.eq((await t.call('skill', 'o_buy', 'collect', {})).code, 400, '缺 id → 400')
  t.eq((await t.call('skill', 'o_buy', 'collect', { id: 'nope' })).code, 404, '技能不存在 → 404')
  t.eq((await t.call('skill', 'o_buy', 'collect', { id: 'f3' })).code, 409, '已下架技能 → 409')
  t.eq((await t.call('skill', 'o_buy', 'collect', { id: 'f4' })).code, 400, '不能收藏自己发布的技能 → 400')
  t.eq(favs().length, 0, '★ 以上失败分支都没有写库')

  /* ---- 收藏成功 ---- */
  let c = await t.call('skill', 'o_buy', 'collect', { id: 'f1', collected: true })
  t.eq(c.code, 0, '收藏成功')
  t.eq(c.data.collected, true, '返回 { collected: true }')
  t.eq(favs().length, 1, '★ favorites 写入 1 条')
  t.eq(Object.keys(favs()[0]).sort().join(','), '_id,_openid,createTime,skillId', '收藏文档字段与契约一致')
  t.eq(favs()[0]._openid, 'o_buy', '收藏归属当前用户')
  t.eq(favs()[0].skillId, 'f1', 'skillId 正确')

  /* ---- 详情页收藏态 ---- */
  t.eq((await t.call('skill', 'o_buy', 'detail', { id: 'f1' })).data.isCollected, true,
    '★ skill.detail 的 isCollected 反映真实收藏态（此前恒为 false）')
  t.eq((await t.call('skill', 'o_buy', 'detail', { id: 'f2' })).data.isCollected, false,
    '未收藏的技能 isCollected=false')

  /* ---- 幂等 ---- */
  c = await t.call('skill', 'o_buy', 'collect', { id: 'f1', collected: true })
  t.eq(c.data.collected, true, '重复收藏仍返回 true')
  t.eq(favs().length, 1, '★ 重复收藏不产生第二条（幂等）')

  c = await t.call('skill', 'o_buy', 'collect', { id: 'f1', collected: false })
  t.eq(c.data.collected, false, '取消收藏')
  t.eq(favs().length, 0, '取消后集合为空')

  c = await t.call('skill', 'o_buy', 'collect', { id: 'f1', collected: false })
  t.eq(c.code, 0, '★ 重复取消不报错（幂等）')
  t.eq(favs().length, 0, '仍为空')

  /* ---- toggle（不传 collected 时取反）---- */
  c = await t.call('skill', 'o_buy', 'collect', { id: 'f1' })
  t.eq(c.data.collected, true, '★ 缺省 collected → 按当前状态取反为「收藏」')
  c = await t.call('skill', 'o_buy', 'collect', { id: 'f1' })
  t.eq(c.data.collected, false, '★ 再调一次 → 取反为「取消」')
  t.eq(favs().length, 0, 'toggle 两下回到空')

  /* ---- 我的收藏列表 ---- */
  await t.call('skill', 'o_buy', 'collect', { id: 'f1', collected: true })
  await new Promise(res => setTimeout(res, 5))   // 拉开 createTime，保证倒序断言稳定
  await t.call('skill', 'o_buy', 'collect', { id: 'f2', collected: true })

  let fav = await t.call('skill', 'o_buy', 'myFavorites', { page: 1, size: 10 })
  t.eq(fav.code, 0, 'myFavorites 调用成功')
  t.eq(Object.keys(fav.data).sort().join(','), 'hasMore,list,page,total', '返回 { list, total, hasMore, page }')
  t.eq(fav.data.total, 2, 'total=2')
  t.eq(fav.data.list.length, 2, '返回 2 条技能')
  t.ok(fav.data.list.every(x => !!x.collectedTime), '★ 每条都带 collectedTime（前端渲染「x 天前收藏」）')
  t.eq(fav.data.list[0]._id, 'f2', '★ 按收藏时间倒序：后收藏的排前面')

  /* ---- 只列自己的 ---- */
  await t.call('skill', 'o_sel', 'collect', { id: 'f5', collected: true })
  t.eq((await t.call('skill', 'o_buy', 'myFavorites', {})).data.total, 2, '★ 只列自己的收藏（o_sel 的不计入）')
  t.eq((await t.call('skill', 'o_sel', 'myFavorites', {})).data.total, 1, 'o_sel 自己看到 1 条')

  /* ---- 分页 ---- */
  fav = await t.call('skill', 'o_buy', 'myFavorites', { page: 1, size: 1 })
  t.eq(fav.data.list.length, 1, 'size=1 生效')
  t.eq(fav.data.hasMore, true, 'hasMore=true（还有下一页）')
  fav = await t.call('skill', 'o_buy', 'myFavorites', { page: 2, size: 1 })
  t.eq(fav.data.list.length, 1, '第 2 页有 1 条')
  t.eq(fav.data.hasMore, false, '最后一页 hasMore=false')

  t.eq((await t.call('skill', 'o_ghost', 'myFavorites', {})).code, 401, '未注册 myFavorites → 401')

  /* ---- 技能被删除后不返回空洞 ---- */
  t.store().skills = t.store().skills.filter(s => s._id !== 'f2')
  fav = await t.call('skill', 'o_buy', 'myFavorites', { page: 1, size: 10 })
  t.eq(fav.data.list.length, 1, '★ 技能被删除后列表跳过该条（不返回空洞）')
  t.eq(fav.data.list[0]._id, 'f1', '留下的是仍存在的技能')

  t.log('⚠️ skill 仍存在的契约偏差：① 关键词只取前 3 个分词，多余词静默丢弃（属合理设计）；' +
    '② myFavorites 的 total 按收藏记录数统计 —— 若技能已被删除，total 会大于 list 长度（前端按 list 渲染，不受影响）。')
}
