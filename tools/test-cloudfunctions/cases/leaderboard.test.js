/**
 * 贡献排行榜
 * ==================================================================
 * 两个设计选择要被测试钉住：
 *   ① **按累计收入排，不是按余额** —— 按余额会鼓励囤积、加剧币集中
 *   ② **脱敏在服务端做** —— 只在客户端遮名字是没用的，接口照样返回真名
 *
 * 还有一条隐私底线：**必须能退出**，退出后服务端不能再返回你。
 * ==================================================================
 */
module.exports = async function (t) {
  const u = (id) => t.user(id)

  /* ==================================================================
   * 组 1 · 按累计收入排序（不是余额）
   * ================================================================== */
  t.group('组 1 · 按累计收入排序，不是按余额')

  t.seed()
  /*
   * 故意让「收入高但余额低」和「余额高但收入低」两种情况同时存在：
   *   o_sel  收入 100、余额 0    ← 服务了很多但把币花掉了
   *   o_buy  收入 0、  余额 999  ← 囤了很多币但没提供过服务
   * 按收入排 → o_sel 第一；按余额排 → o_buy 第一
   */
  u('o_sel').totalEarned = 100
  u('o_sel').coins = 0
  u('o_buy').totalEarned = 0
  u('o_buy').coins = 999

  let r = await t.call('user', 'o_weak', 'leaderboard', { limit: 20 })
  t.eq(r.code, 0, '登录用户可以查看榜单')
  t.eq(r.data.list[0].isMe, false, '榜首不是当前用户')

  const top = r.data.list[0]
  t.eq(top.totalEarned, 100, '★ 榜首是收入最高的（100）')
  t.eq(r.data.list.filter(x => x.totalEarned === 999).length, 0,
    '★★ 余额 999 但收入 0 的人**不在榜首** —— 按余额排会让他第一，那就变成鼓励囤积了')

  /* ==================================================================
   * 组 2 · ★ 脱敏在服务端（接口返回的就已经是脱敏值）
   * ================================================================== */
  t.group('组 2 · ★ 昵称脱敏在服务端完成')

  t.seed()
  u('o_sel').totalEarned = 500
  u('o_sel').nickName = '王小明'

  r = await t.call('user', 'o_weak', 'leaderboard', { limit: 20 })
  const row = r.data.list.filter(x => x.totalEarned === 500)[0]
  t.ok(row, '找到目标行')
  t.eq(row.nickName, '王*明', '★★ 接口返回的就是「王*明」—— 不是客户端遮的')
  t.eq(row.nickName.indexOf('小明') < 0, true, '★ 接口响应里**找不到**完整名字（抓包也拿不到）')

  /* 长度边界 */
  t.seed()
  u('o_sel').totalEarned = 500; u('o_sel').nickName = '李四'
  r = await t.call('user', 'o_weak', 'leaderboard', { limit: 20 })
  t.eq(r.data.list.filter(x => x.totalEarned === 500)[0].nickName, '李*', '两字昵称 → 李*')

  t.seed()
  u('o_sel').totalEarned = 500; u('o_sel').nickName = '欧阳小明'
  r = await t.call('user', 'o_weak', 'leaderboard', { limit: 20 })
  t.eq(r.data.list.filter(x => x.totalEarned === 500)[0].nickName, '欧*明', '四字昵称 → 欧*明（只保留首末字）')

  /* ==================================================================
   * 组 3 · ★ 可以退出（隐私底线）
   * ================================================================== */
  t.group('组 3 · ★ 可以退出排行榜')

  t.seed()
  u('o_sel').totalEarned = 500
  u('o_sel').nickName = '王小明'

  r = await t.call('user', 'o_sel', 'leaderboard', { limit: 20 })
  t.eq(r.data.me.hidden, false, '默认参与')
  t.ok(r.data.me.rank >= 1, '默认有名次', String(r.data.me.rank))
  t.eq(r.data.list.filter(x => x._openid === 'o_sel').length, 0, '（列表项不带 openid，这正是脱敏的意义）')

  /* 通过资料接口退出 */
  r = await t.call('login', 'o_sel', 'updateProfile', { leaderboardHidden: true })
  t.eq(r.code, 0, '可以设置退出')

  r = await t.call('user', 'o_weak', 'leaderboard', { limit: 20 })
  t.eq(r.data.list.filter(x => x.totalEarned === 500).length, 0,
    '★★ 退出后**不出现在榜单上** —— 服务端查询就把他排掉了，不是客户端隐藏')

  r = await t.call('user', 'o_sel', 'leaderboard', { limit: 20 })
  t.eq(r.data.me.hidden, true, '自己看到 hidden = true')
  t.eq(r.data.me.rank, 0, '★ 退出后不显示名次')

  /* 再打开 */
  r = await t.call('login', 'o_sel', 'updateProfile', { leaderboardHidden: false })
  r = await t.call('user', 'o_weak', 'leaderboard', { limit: 20 })
  t.eq(r.data.list.filter(x => x.totalEarned === 500).length, 1, '重新加入后又能看到')

  /* 类型规范化：不接受非布尔 */
  t.seed()
  u('o_sel').totalEarned = 500
  await t.call('login', 'o_sel', 'updateProfile', { leaderboardHidden: 'yes' })
  t.eq(u('o_sel').leaderboardHidden, true, '★ 传字符串会被规范化成布尔 true（不接受任意值）')
  await t.call('login', 'o_sel', 'updateProfile', { leaderboardHidden: '' })
  t.eq(u('o_sel').leaderboardHidden, false, '空字符串 → false')

  /* ==================================================================
   * 组 4 · 被处置的账号不出现
   * ================================================================== */
  t.group('组 4 · 被封禁 / 注销的账号不出现在榜单')

  t.seed()
  u('o_sel').totalEarned = 500
  u('o_buy').totalEarned = 400

  r = await t.call('user', 'o_weak', 'leaderboard', { limit: 20 })
  t.eq(r.data.list.filter(x => x.totalEarned === 500).length, 1, '正常时在榜上')

  u('o_sel').status = 0                    // 封禁 / 注销
  r = await t.call('user', 'o_weak', 'leaderboard', { limit: 20 })
  t.eq(r.data.list.filter(x => x.totalEarned === 500).length, 0,
    '★★ 被封禁的账号不出现在榜单（否则等于给违规账号做推广）')

  /* ==================================================================
   * 组 5 · 只返回前 N 名，但自己的名次照样算得出来
   * ================================================================== */
  t.group('组 5 · 只返回前 N 名 + 自己的名次')

  t.seed()
  /* 造一个「排名靠后」的用户：收入最低 */
  u('o_weak').totalEarned = 0
  u('o_buy').totalEarned = 300
  u('o_sel').totalEarned = 200
  u('o_adm').totalEarned = 100

  r = await t.call('user', 'o_weak', 'leaderboard', { limit: 2 })
  t.eq(r.data.list.length, 2, '★ limit=2 只返回 2 条（不给全站排名）')
  t.eq(r.data.list[0].totalEarned, 300, '榜首正确')
  t.eq(r.data.me.rank, 4, '★★ 即使不在返回的 2 条里，自己的名次也算得出来（比我收入高的有 3 人）')
  t.eq(r.data.me.totalEarned, 0, '我的累计收入照常返回')

  /* 榜首就是自己时 */
  t.seed()
  u('o_weak').totalEarned = 999
  r = await t.call('user', 'o_weak', 'leaderboard', { limit: 20 })
  t.eq(r.data.me.rank, 1, '收入最高时名次是 1')
  t.eq(r.data.list[0].isMe, true, '★ 榜上那一行被标记为「我」（前端可以高亮）')

  /* ==================================================================
   * 组 6 · 匿名但可点进主页
   * ================================================================== */
  t.group('组 6 · 脱敏后的昵称仍然可读，头像照常给')

  t.seed()
  u('o_sel').totalEarned = 500
  u('o_sel').nickName = '王小明'
  u('o_sel').avatarUrl = 'cloud://a.jpg'

  r = await t.call('user', 'o_weak', 'leaderboard', { limit: 20 })
  const one = r.data.list.filter(x => x.totalEarned === 500)[0]
  t.eq(one.avatarUrl, 'cloud://a.jpg', '头像照常返回（榜单一屏能认人，但不给全名）')
  t.eq(one.serveCount, u('o_sel').stats.serveCount, '带服务次数')
  t.eq(one.creditScore, u('o_sel').creditScore, '带信用分')
  t.eq(JSON.stringify(one).indexOf('_openid') < 0, true,
    '★★ 出参里**不含 openid** —— 榜单不该暴露账号标识')
}
