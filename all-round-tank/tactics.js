// ============================================================
// tactics.js — 战术决策层
//
// find*/传送/刺杀/攻击安全判定/射击窗口等战术函数。
// 依赖 core-utils.js 的工具函数。被 blackboard.js 的传感器调用。
// ============================================================


/**
 * 面对 shield 流敌人时，这一发多半只是骗盾/试探，不能站桩白送对方回敬。
 * 仅当我开火后仍能在敌方最早命中前侧移离线，才允许主动对枪；否则宁可不打。
 */
function canShootThenEvadeShieldCounter(me, enemy, enemyTank, enemyBullets, game, enemyPos) {
  if (!enemyHasShieldSkill(enemy)) return true;
  // 盾在冷却中 → 我的子弹不会被吸收 → 直射必命中（至少换命），无需侧移避反
  if (enemy && enemy.skill && enemy.skill.remainingCooldownFrames > 0) return true;
  if (!enemyTank || !enemyPos) return false;
  if (!gunReady(me)) return false;

  const myPos = me.tank.position;
  const dirToEnemy = clearShotDirection(myPos, enemyPos, game);
  if (!dirToEnemy) return false;
  if (!enemyCanFireSoon(enemy)) return true;

  const dirToMe = clearShotDirection(enemyPos, myPos, game);
  if (!dirToMe) return true;

  const dist = manhattan(myPos, enemyPos);
  const enemyHitFrames = turnDistance(enemyTank.direction, dirToMe) + Math.ceil(dist / BULLET_SPEED);
  const perp = (dirToEnemy === "up" || dirToEnemy === "down")
    ? [DIRS[dirIndex("left")], DIRS[dirIndex("right")]]
    : [DIRS[dirIndex("up")], DIRS[dirIndex("down")]];

  for (let i = 0; i < perp.length; i++) {
    const d = perp[i];
    const p = [myPos[0] + d.dx, myPos[1] + d.dy];
    if (!isPassable(game, p, enemyPos)) continue;
    if (anyBulletThreatens(enemyBullets || [], p, game)) continue;
    if (enemyAimsAt(p, enemyTank, game)) continue;
    const escapeFrames = d.name === me.tank.direction ? 1 : 2;
    // 我开火占本帧，下一帧才能移动；敌子弹 enemyHitFrames 帧后到达我当前格。
    // 需要在子弹到达前离开：escapeFrames <= enemyHitFrames（等于时恰好来得及）。
    if (escapeFrames <= enemyHitFrames) return true;
  }
  return false;
}


/**
 * 直射开火是否“不会必死”：用于判断能否把“打面前的敌人”提到预防性软躲避之上。
 * 能进入攻击层说明已无需硬躲的来袭子弹（findBulletDodge/escapeTeleport 都已 return null），
 * 所以这一炮的致死风险只来自敌方炮口。满足以下任一即认定开火不必死：
 *  1. 敌方短期内开不了火（enemyCanFireSoon=false）：纯赚一炮。
 *  2. 我严格先手命中（myDuel<enemyDuel）：敌先倒，不算必死。
 *  2b. 同归于尽（myDuel===enemyDuel）只在**星星严格领先**时才算不必死：星平=运行时长判负=必输
 *      (我方代码一贯更慢)，同归把翻盘机会清零更糟，绝不换命；领先时同归=我赢，可换命锁胜。
 *  3. 我不占先手，但开完火下一帧能侧移离开敌方炮线（不进别的弹道/炮口）：先打再躲，自己没死与星数无关。
 * 皆不满足 -> 这一炮换不回血且躲不掉，判定必死，让位给软躲避。
 *
 * 前置铁律（mat 摇摆送死复盘）：必须车头已对准敌人（turnDistance=0，开火即本帧发出）才算"即时先手直射"。
 * 未对准时开火要先花一帧转向，而敌人往往已在转向过程中/即将开火（replay：敌连续转向对准、我才刚转向
 * 就被抢先开炮），用静态转向距离赌"转向竞速先手"并不可靠——未对准一律让位躲避/机动，绝不站着转向把
 * 先手白送给敌人。这正是"摇摆送死"的源头：直射↔躲避每帧横跳、连转方向却始终没离开弹道。
 */
function directShotNotSuicidal(me, enemy, enemyTank, enemyBullets, game, enemyPos, shotDir) {
  if (!enemyTank || !enemyPos || !shotDir) return false;
  // 未对准敌人 -> 开火非本帧即时，赌转向竞速会被抢先 -> 不算安全直射，让位躲避（及时机动优先）。
  if (turnDistance(me.tank.direction, shotDir) !== 0) return false;
  if (!enemyCanFireSoon(enemy)) return true;

  // shield 流：这一发多半被盾吃掉换不到血，只有“打完仍能侧移离线”才不算白送（与守线/对射同源判定）。
  if (enemyHasShieldSkill(enemy)) {
    return canShootThenEvadeShieldCounter(me, enemy, enemyTank, enemyBullets, game, enemyPos);
  }

  const myPos = me.tank.position;
  const dist = manhattan(myPos, enemyPos);
  const myDuel = turnDistance(me.tank.direction, shotDir) + Math.ceil(dist / BULLET_SPEED);
  const dirToMe = clearShotDirection(enemyPos, myPos, game);
  const enemyDuel = (dirToMe ? turnDistance(enemyTank.direction, dirToMe) : 1) + Math.ceil(dist / BULLET_SPEED);
  if (myDuel < enemyDuel) return true; // 严格先手：敌先倒
  if (myDuel === enemyDuel) {           // 同归：仅星星严格领先才换命，星平/落后必输不换
    const myStars = (me && me.stars) || 0;
    const enmStars = (enemy && enemy.stars) || 0;
    if (myStars > enmStars) return true;
    // 星平/落后：同归=必输，不放行，继续看能否先打再躲（自己不死则无所谓星数）
  }

  const perp = (shotDir === "up" || shotDir === "down")
    ? [DIRS[dirIndex("left")], DIRS[dirIndex("right")]]
    : [DIRS[dirIndex("up")], DIRS[dirIndex("down")]];
  for (let i = 0; i < perp.length; i++) {
    const d = perp[i];
    const p = [myPos[0] + d.dx, myPos[1] + d.dy];
    if (!isPassable(game, p, enemyPos)) continue;
    if (anyBulletThreatens(enemyBullets || [], p, game)) continue;
    if (enemyAimsAt(p, enemyTank, game)) continue;
    const td = turnDistance(me.tank.direction, d.name);
    const escapeFrames = td === 0 ? 1 : td + 1;
    if (escapeFrames <= enemyDuel) return true; // 开火占本帧，下帧能在敌弹到达前离线
  }
  return false;
}


/**
 * freeze 流敌人的"被冻致死"预计算：假设敌人此刻冻住我 FREEZE_DURATION(=2) 帧。
 * 关键点：冻结期间我不能移动/转向，而敌人可以**自由转向**(≤2 次转向即可对准任意方向，正好被 2 帧冻结吸收)，
 * 所以致死的硬约束只是子弹飞行时间，不取决于敌人当前朝向。
 * 最坏时序(敌已在我所在行/列、冻结期间开火)：T 冻结(锁 T,T+1)、T+1 开火、子弹 ceil(dist/2) 帧到达；
 * 我 T+2 解冻，需朝向正确本帧脱线、否则要先转向(T+3)。
 *   - dist<=4：ceil(4/2)=2，子弹 T+3 到达，我需转向脱线也是 T+3 -> 命中(必死)。
 *   - dist>=5：ceil(5/2)=3，子弹 T+4，我 T+2/T+3 即可脱线 -> 安全。
 * 故 cell 与 freeze 敌在同一无墙射线上、且曼哈顿 <= 2*FREEZE_DURATION(=4) 即"被冻必死"格。
 * 中间有墙挡住射线则打不到，安全。
 */
function freezeKillsAt(cell, enemyPos, game) {
  if (!enemyPos) return false;
  if (!clearShotDirection(enemyPos, cell, game)) return false; // 不同线或有墙遮挡 -> 冻住也打不到
  return manhattan(enemyPos, cell) <= 2 * FREEZE_DURATION;
}

/**
 * stun 流敌人"被晕致死"判定：同线(无墙) + dist ≤ 4。
 * stun 持续 6 帧(50%反向)，期间敌即时开火子弹 2 帧到达(dist≤4)，受害者无法可靠闪避。
 * 对 shield 尤其致命：stun 下 shield 立即过期，失去唯一防御手段。
 */
function stunKillsAt(cell, enemyPos, game) {
  if (!enemyPos) return false;
  if (!clearShotDirection(enemyPos, cell, game)) return false;
  return manhattan(enemyPos, cell) <= 4;
}


/**
 * cell 是否落在过载敌人的"双弹覆盖带"内：敌人所在行/列，或相邻 ±1 行/列，且在近距(maxDist)内。
 * 用于传送落点安全判定与走位死区判定——双弹副弹走相邻列，严格同线判定会漏掉。
 */
function inDoubleLaneBand(enemyPos, cell, maxDist) {
  if (!enemyPos) return false;
  if (manhattan(enemyPos, cell) > maxDist) return false;
  const dx = Math.abs(enemyPos[0] - cell[0]);
  const dy = Math.abs(enemyPos[1] - cell[1]);
  // 同列或相邻列(竖直双弹覆盖带) 或 同行或相邻行(水平双弹覆盖带)
  return dx <= 1 || dy <= 1;
}


/**
 * 寻找最佳传送刺杀方案（严格门槛）。
 * 返回 { pos: [x, y], dir: "方向" }
 *
 * 安全模型（子弹 2 格/帧；传送后保持朝向，第 1 帧开火，命中需 ceil(距离/2) 帧）：
 *  - 敌人隐身/有护盾/本局已被标记会躲刺杀 -> 直接放弃。
 *  - 落点必须满足：我方子弹能在敌方反击子弹打到我之前先命中敌人；
 *    且即便敌人转身/横移反击，我方也来得及躲开（见 assassinIsSafe）。
 */
function findAssassinationPlan(me, enemy, enemyTank, enemyBullets, game, state) {
  if (!enemyTank || !teleportReady(me) || !canShoot(me, enemy)) return null;
  // 敌人隐身或有护盾则不刺杀
  if (enemy.status && (enemy.status.cloaked || enemy.status.shielded)) return null;
  // 敌方是传送技能：它能瞬移脱离我的刺杀弹道（甚至反传送到我背后），刺杀收益太低 -> 放弃
  if (enemyHasTeleport(enemy)) return null;
  // 敌方过载(双弹就绪)：刺杀落点必与敌同线(才能直射)，恰好落进双弹正列，反被一帧双弹反杀 -> 放弃刺杀
  if (enemyDoubleLaneThreat(enemy)) return null;
  // overload 流敌人(哪怕此刻冷却中)：刺杀=传送到敌身边对射，它一过载就双弹反杀(刺杀落点必同线=副弹正列)。
  // 对双弹流应"怂"——保留传送躲草丛/抢星，绝不主动凑上去送(呼应 mat_D9W/mat_4YF "别贴双弹敌")。
  if (enemyIsOverloadType(enemy)) return null;
  // 本局敌方已展示过躲刺杀子弹的反应 -> 全局禁用刺杀
  if (state && state.assassinBanned) return null;
  // 脚边有星(走两步内可吃)且我不比敌人远 -> 别把传送浪费在远处刺杀上，留着走过去/传送吃星(mat_E3G 开局[2,2]星在[3,3]却传去刺杀[11,12]丢星)
  if (game && game.star) {
    const myToStar = pathDistance(me.tank.position, game.star, game, enemyTank.position);
    if (myToStar >= 0 && myToStar <= 2) {
      const enemyToStar = pathDistance(enemyTank.position, game.star, game, me.tank.position);
      if (enemyToStar < 0 || myToStar <= enemyToStar) return null;
    }
  }

  const enemyPos = enemyTank.position;
  let best = null;
  let bestScore = -9999;

  // 遍历所有方向和攻击距离，寻找最佳落点
  for (let i = 0; i < DIRS.length; i++) {
    const dir = DIRS[i];
    for (let range = ASSASSIN_MIN_RANGE; range <= ASSASSIN_MAX_RANGE; range++) {
      const p = [enemyPos[0] - dir.dx * range, enemyPos[1] - dir.dy * range];
      if (samePos(p, me.tank.position)) continue; // 排除当前位置
      if (!isAssassinTile(p, dir.name, enemyTank, enemyBullets, game)) continue;
      // 严格安全校验：模拟敌方反击，确认我方先手命中且能躲掉反击
      if (!assassinIsSafe(p, dir, range, me, enemy, enemyTank, game)) continue;

      // 打分模型：转向代价越小越好，距离越近(命中更快)越好，靠近地图中心更好
      const turns = turnDistance(me.tank.direction, dir.name);
      const centerBias = distanceFromEdges(p, game);
      const score = 100 - turns * 35 - range * 2 + centerBias;

      if (score > bestScore) {
        bestScore = score;
        best = { pos: p, dir: dir.name };
      }
    }
  }
  return best;
}


/**
 * 严格刺杀安全判定：在落点 p、朝 dir、与敌距离 range 的前提下，模拟敌方最快反击。
 *
 * 时间线（传送占当前帧，落点朝向已对准 -> 下一帧即我方开火帧记为 t=1）：
 *  - 我方子弹命中敌人耗时：myHitFrames = ceil(range / 2)。
 *  - 敌方反击：最坏情况敌人本就朝向我方所在直线、且炮管就绪，可与我方同帧开火，
 *    其子弹命中我耗时 enemyHitFrames = ceil(range / 2)（同样距离）。
 *  - 若敌人需要先转向对准（不在我方直线朝向上），反击至少晚 1 帧。
 *
 * 通过条件（满足其一即安全）：
 *  A. 我方严格快于敌方反击命中（myHitFrames < enemyReplyHit）；
 *  B. 同时命中但我方落点在"打完后能立刻横移脱离敌方弹道"——保守起见要求落点有可躲的侧向空格。
 * 否则判为不安全（宁可不刺杀）。
 */
function assassinIsSafe(p, dir, range, me, enemy, enemyTank, game) {
  const enemyPos = enemyTank.position;
  const myHitFrames = Math.ceil(range / BULLET_SPEED);

  // 敌方炮管是否就绪（场上已有敌弹则其无法立刻再开火，对我更有利）
  const enemyGunBusy = enemy && enemy.bullet && enemy.bullet.position;

  // 敌人当前是否已朝向能直接打到落点 p（即可与我同帧反击）
  const enemyFacingMe = enemyAimsAt(p, enemyTank, game);
  // 敌方反击命中我所需帧：能直接打则与我同距离；需转身则 +1 帧
  let enemyReplyHit = Math.ceil(range / BULLET_SPEED) + (enemyFacingMe ? 0 : 1);
  if (enemyGunBusy) enemyReplyHit += 1; // 敌人得等旧弹消失，再晚 1 帧

  // A. 我方严格更快命中 -> 安全
  if (myHitFrames < enemyReplyHit) return true;

  // B. 同帧/稍慢：要求落点能在被命中前横向脱离敌方弹道（侧向有可走空格且不被其他弹道封锁）
  if (myHitFrames <= enemyReplyHit) {
    if (hasLateralEscape(p, dir, enemyTank, game)) return true;
  }
  return false;
}


/**
 * 落点 p 沿射击方向 dir 的两个垂直侧向，是否存在可走且不被敌人立刻瞄准的脱离格。
 * 用于刺杀后"开火即走"躲反击。
 */
function hasLateralEscape(p, dir, enemyTank, game) {
  // 垂直于 dir 的两个方向
  const perp = (dir.name === "up" || dir.name === "down")
    ? [DIRS[dirIndex("left")], DIRS[dirIndex("right")]]
    : [DIRS[dirIndex("up")], DIRS[dirIndex("down")]];
  for (let i = 0; i < perp.length; i++) {
    const q = [p[0] + perp[i].dx, p[1] + perp[i].dy];
    if (!isPassable(game, q, enemyTank.position)) continue;
    if (enemyAimsAt(q, enemyTank, game)) continue;
    return true;
  }
  return false;
}


/**
 * 判断一个坐标是否适合作为刺杀传送落点
 */
function isAssassinTile(p, dir, enemyTank, enemyBullets, game) {
  if (!isTeleportSafe(p, enemyTank, enemyBullets, game, 0)) return false; // 必须安全（不卡墙/不接现有子弹/不被预瞄）
  if (manhattan(p, enemyTank.position) < ASSASSIN_MIN_RANGE) return false; // 必须大于最小距离避免开火锁定
  if (clearShotDirection(p, enemyTank.position, game) !== dir) return false; // 落点必须能直接射击敌人
  return true;
}


/**
 * 寻找争夺星星时的预瞄方向
 */
function findContestedStarGuard(me, enemyTank, game) {
  if (!game.star || !enemyTank || !gunReady(me)) return null;
  const myPos = me.tank.position;
  const enemyPos = enemyTank.position;
  
  const enemyToStar = manhattan(enemyPos, game.star);
  if (enemyToStar > 2) return null; // 敌人离星星不远
  if (manhattan(myPos, game.star) > 4) return null; // 我离星星也不远
  
  const dir = clearShotDirection(myPos, game.star, game);
  if (!dir) return null; // 必须能瞄准星星
  
  // 确保我跑去星星的路径距离不比敌人长太多
  if (pathDistance(enemyPos, game.star, game, myPos) > enemyToStar) return null;
  return { dir: dir };
}


/**
 * 隐身守星陷阱判定：仅在以下全部成立时返回 true（窄条件，避免"防过头不敢抢星"）：
 *  - 敌人拥有隐身技能，且此刻不可见(enemyTank=null，即正在隐身)；
 *  - 最近 6 帧内见过敌人（lastEnemyPos 有效），其最后位置与星星同行/同列且视线无遮挡（能直接狙击抢星者）；
 *  - 敌方距星星在开火射程内(<=8)；我离星星也不算远(<=6，确实在争这颗星)。
 * 此时冲过去抢星 = 落点即被狙，应改为守位等待（见 mat_1Hvg / mat_0fCb）。
 */
function inCloakStarTrap(me, enemy, enemyTank, game, state) {
  if (!game.star) return false;
  if (enemyTank) return false;                 // 敌人可见 -> 不算隐身陷阱
  if (!enemy || !enemy.skill || enemy.skill.type !== "cloak") return false;
  if (!state || !state.lastEnemyPos) return false;
  if (((game.frames || 0) - state.lastEnemySeenFrame) > 6) return false; // 太久没见，信息失效

  const ePos = state.lastEnemyPos;
  // 敌最后位置必须卡在星星的射线上（同行/同列且中间无遮挡），否则狙不到抢星者
  if (!clearShotDirection(ePos, game.star, game)) return false;
  if (manhattan(ePos, game.star) > 8) return false;          // 超出开火射程
  if (manhattan(me.tank.position, game.star) > 6) return false; // 我不在争星范围就不必守
  return true;
}


/**
 * 草丛星点陷阱检测（通用版，不限敌人技能）：
 * 敌人消失 + 最后位置附近有草丛在星射击线上 → 大概率蹲草伏击。
 * 返回 true 时应避免盲冲星。
 */
function inBushStarTrap(me, enemy, enemyTank, game, state) {
  if (!game.star) return false;
  if (enemyTank) return false;
  if (!state || !state.lastEnemyPos) return false;
  var frame = (game && game.frames) || 0;
  if (frame - state.lastEnemySeenFrame > 10) return false;
  var myPos = me.tank.position;
  if (manhattan(myPos, game.star) > 8) return false;
  // 近距豁免：已贴脸星(≤2步)时冲就完事，不因远处草丛放弃
  if (manhattan(myPos, game.star) <= 2) return false;
  // 传送兜底：传送就绪时走路被阻可传送逃生，不完全禁止走路追星
  if (teleportReady(me)) return false;

  var ePos = state.lastEnemyPos;
  var star = game.star;
  var hm = state.bushHeatmap;
  var w = game.map.length, h = game.map[0].length;

  for (var x = 0; x < w; x++) {
    for (var y = 0; y < h; y++) {
      if (game.map[x][y] !== "o") continue;
      var c = [x, y];
      var distToStar = manhattan(c, star);
      if (distToStar < 1 || distToStar > 4) continue;
      if (!clearShotDirection(c, star, game)) continue;
      if (manhattan(c, ePos) > 5) continue;
      // 热力图门槛：只有高置信度(score>=50)的草丛才触发阻断
      var k = key(c);
      if (hm && hm[k] && hm[k].score >= 50) return true;
      // 无热力图记录但敌刚消失(≤3帧)：仍视为高威胁
      if (frame - state.lastEnemySeenFrame <= 3) return true;
    }
  }
  return false;
}


/**
 * 找到星附近可疑草丛的射击方向（供远距预射使用）。
 * 返回 { dir, target } 或 null。
 */
function findBushPreFireTarget(me, enemy, enemyTank, game, state) {
  if (!game.star || enemyTank) return null;
  if (!canShoot(me, enemy)) return null;
  if (!state || !state.lastEnemyPos) return null;
  var frame = (game && game.frames) || 0;
  if (frame - state.lastEnemySeenFrame > 10) return null;

  var myPos = me.tank.position;
  var ePos = state.lastEnemyPos;
  var star = game.star;
  var w = game.map.length, h = game.map[0].length;
  var best = null, bestDist = 9999;

  for (var x = 0; x < w; x++) {
    for (var y = 0; y < h; y++) {
      if (game.map[x][y] !== "o") continue;
      var c = [x, y];
      var distToStar = manhattan(c, star);
      if (distToStar < 1 || distToStar > 4) continue;
      if (!clearShotDirection(c, star, game)) continue;
      if (manhattan(c, ePos) > 5) continue;
      var dir = clearShotDirection(myPos, c, game);
      if (!dir) continue;
      var dist = manhattan(myPos, c);
      if (dist > 6) continue;
      if (dist < bestDist) { bestDist = dist; best = { dir: dir, target: c }; }
    }
  }
  return best;
}


/**
 * 通用草丛盲射：敌人消失后，朝其最后位置附近的草丛开枪（不限星附近）。
 * 触发条件：敌人不可见 + 最后出现 ≤ 8 帧前 + 枪就绪 + 安全（无来袭子弹）。
 * 返回 { dir, target } 或 null。
 */
function findBlindBushShot(me, enemy, enemyTank, enemyBullets, game, state) {
  if (enemyTank) return null;
  if (!canShoot(me, enemy)) return null;
  if (!state || !state.lastEnemyPos) return null;
  var frame = (game && game.frames) || 0;
  if (frame - state.lastEnemySeenFrame > 8) return null;
  if (anyBulletThreatens(enemyBullets || [], me.tank.position, game)) return null;

  var myPos = me.tank.position;
  var ePos = state.lastEnemyPos;
  var w = game.map.length, h = game.map[0].length;
  var best = null, bestScore = -9999;

  for (var x = 0; x < w; x++) {
    for (var y = 0; y < h; y++) {
      if (game.map[x][y] !== "o") continue;
      var c = [x, y];
      // 草丛须在敌人最后位置附近（≤5步可达）
      var distToEnemy = manhattan(c, ePos);
      if (distToEnemy > 5) continue;
      // 我须有清晰射线能打到该草丛
      var dir = clearShotDirection(myPos, c, game);
      if (!dir) continue;
      // 距离合理（不浪费远距弹）
      var distToMe = manhattan(myPos, c);
      if (distToMe > 7) continue;
      // 不朝自己脚下射（别打到自己旁边）
      if (distToMe < 2) continue;
      // 评分：距敌最后位置越近越可能藏人
      var score = (6 - distToEnemy) * 20 + (8 - distToMe) * 5;
      // 朝向即射线方向时优先（不用转向，出手更快）
      if (dir === me.tank.direction) score += 50;
      // 热力图加权：高概率草丛优先射击
      if (state && state.bushHeatmap) {
        var heat = state.bushHeatmap[key(c)];
        if (heat) score += heat.score * 0.5;
      }
      if (score > bestScore) { bestScore = score; best = { dir: dir, target: c }; }
    }
  }
  return best;
}


/**
 * 草丛蹲守防御：当我处于高概率草丛的射击线上时，侧移到安全格。
 * 仅在敌人不可见时触发（敌可见时交给 aim-dodge 处理）。
 * 返回安全侧移目标格 或 null。
 */
function findBushCamperFireLineDodge(me, enemy, enemyTank, enemyBullets, game, state) {
  if (enemyTank) return null;
  if (!state || !state.bushHeatmap) return null;
  if (anyBulletThreatens(enemyBullets || [], me.tank.position, game)) return null;
  var myPos = me.tank.position;
  var hm = state.bushHeatmap;

  // 只对高置信度条目(>=65)响应：walk(80+)/teleport(100)新鲜入草触发，
  // 扩散(40)/看门狗维持(52)不触发，避免整片草丛永久"危险"(mat_AH4im3mff5)
  var DODGE_THRESHOLD = 65;
  var threatened = false;
  var dangerDirs = {};
  for (var k in hm) {
    if (!hm.hasOwnProperty(k) || hm[k].score < DODGE_THRESHOLD) continue;
    var parts = k.split(',');
    var bushPos = [parseInt(parts[0]), parseInt(parts[1])];
    var shotDir = clearShotDirection(bushPos, myPos, game);
    if (shotDir && manhattan(bushPos, myPos) <= 8) {
      threatened = true;
      dangerDirs[shotDir] = true;
    }
  }
  if (!threatened) return null;

  // 找不在任何高置信草丛射击线上的安全相邻格
  var best = null, bestScore = -9999;
  for (var i = 0; i < DIRS.length; i++) {
    var p = [myPos[0] + DIRS[i].dx, myPos[1] + DIRS[i].dy];
    if (!isPassable(game, p, null)) continue;
    if (stepIntoBulletPath(enemyBullets || [], p, game)) continue;
    var stillDanger = false;
    for (var kk in hm) {
      if (!hm.hasOwnProperty(kk) || hm[kk].score < DODGE_THRESHOLD) continue;
      var pp = kk.split(',');
      var bp = [parseInt(pp[0]), parseInt(pp[1])];
      if (clearShotDirection(bp, p, game) && manhattan(bp, p) <= 8) {
        stillDanger = true; break;
      }
    }
    if (stillDanger) continue;
    var score = distanceFromEdges(p, game);
    if (score > bestScore) { bestScore = score; best = p; }
  }
  return best;
}


function cloakStarGuardStep(me, game, state) {
  const myPos = me.tank.position;
  const ePos = state.lastEnemyPos;
  const star = game.star;
  // 当前格已安全（不在敌狙击线）则原地守，不乱动
  const myDirToStar = clearShotDirection(ePos, myPos, game);
  const onSnipeLine = myDirToStar && manhattan(ePos, myPos) <= 8;
  if (!onSnipeLine) return null;

  // 我正卡在敌方狙击线上 -> 侧移到不在该线、且离星星不更远的相邻格
  let best = null;
  let bestScore = -9999;
  for (let i = 0; i < DIRS.length; i++) {
    const p = [myPos[0] + DIRS[i].dx, myPos[1] + DIRS[i].dy];
    if (!isPassable(game, p, ePos)) continue;
    const stillSniped = clearShotDirection(ePos, p, game) && manhattan(ePos, p) <= 8;
    if (stillSniped) continue;
    const score = -manhattan(p, star) * 2 + distanceFromEdges(p, game);
    if (score > bestScore) {
      bestScore = score;
      best = p;
    }
  }
  return best;
}


/**
 * 隐身敌刚消失后，用最后可见位置 + 消失帧数做 BFS 预测可达格。
 * 这里不假设敌人一定在某格，只用于识别“敌可能隐身卡星点枪线”的高危区域。
 */
function hiddenCloakPositions(enemy, enemyTank, game, state) {
  if (!game || !game.map) return [];
  if (enemyTank) return [];
  if (!enemyIsCloakType(enemy)) return [];
  if (!state || !state.lastEnemyPos) return [];
  const age = (game.frames || 0) - state.lastEnemySeenFrame;
  if (age < 0 || age > 6) return [];

  const maxSteps = Math.min(6, age);
  const start = state.lastEnemyPos;
  const queue = [start];
  const dist = {};
  const seen = {};
  dist[key(start)] = 0;
  seen[key(start)] = true;

  for (let qi = 0; qi < queue.length; qi++) {
    const p = queue[qi];
    const pd = dist[key(p)];
    if (pd >= maxSteps) continue;
    for (let i = 0; i < DIRS.length; i++) {
      const n = [p[0] + DIRS[i].dx, p[1] + DIRS[i].dy];
      const nk = key(n);
      if (seen[nk]) continue;
      if (!isPassable(game, n, null)) continue;
      seen[nk] = true;
      dist[nk] = pd + 1;
      queue.push(n);
    }
  }
  return queue;
}


/**
 * 从隐身可达格里筛出能直接打到星点的位置。
 * 复盘来源：mat_G8，敌在星点同行/同列隐身守枪线，我方直传星点后被下一枪收掉。
 */
function hiddenCloakStarThreatPositions(enemy, enemyTank, game, state) {
  const positions = hiddenCloakPositions(enemy, enemyTank, game, state);
  const threats = [];
  for (let i = 0; i < positions.length; i++) {
    const p = positions[i];
    if (clearShotDirection(p, game.star, game) && manhattan(p, game.star) <= 8) {
      threats.push(p);
    }
  }
  return threats;
}


function snipedByHiddenCloakPositions(p, threats, game) {
  for (let i = 0; i < threats.length; i++) {
    const t = threats[i];
    if (clearShotDirection(t, p, game) && manhattan(t, p) <= 8) return true;
  }
  return false;
}


function minDistanceToPositions(p, positions) {
  let best = 999;
  for (let i = 0; i < positions.length; i++) {
    const d = manhattan(p, positions[i]);
    if (d < best) best = d;
  }
  return best;
}


/**
 * 隐身守星反制传送：星点可能被隐身枪线守住时，不直传星。
 * 优先落到最后隐身格 2 格内、离星不远、且不会被预测枪线直射的压迫位。
 */
function hiddenCloakStarTeleport(me, enemy, enemyTank, enemyBullets, game, state) {
  const threats = hiddenCloakStarThreatPositions(enemy, enemyTank, game, state);
  if (threats.length === 0) return null;

  const myPos = me.tank.position;
  let best = null;
  let bestScore = -9999;

  for (let x = 0; x < game.map.length; x++) {
    for (let y = 0; y < game.map[x].length; y++) {
      const p = [x, y];
      if (samePos(p, myPos) || samePos(p, game.star)) continue;
      if (!isPassable(game, p, null)) continue;
      if (anyBulletThreatens(enemyBullets || [], p, game)) continue;
      if (stepIntoBulletPath(enemyBullets || [], p, game)) continue;
      if (samePos(p, state.lastEnemyPos)) continue; // 别直踩最后隐身格，避免撞上真实敌人
      if (minDistanceToPositions(p, threats) === 0) continue; // 别踩到能卡星线的高危隐身格
      if (snipedByHiddenCloakPositions(p, threats, game)) continue;

      const nearThreat = minDistanceToPositions(p, threats);
      const nearLast = manhattan(p, state.lastEnemyPos);
      if (nearLast > 2) continue; // 贴最后隐身格两格内，保留压迫感且不直送星点

      const starDist = pathDistance(p, game.star, game, null);
      if (starDist < 0 || starDist > 4) continue;

      const score = -starDist * 12 - nearThreat * 3 - nearLast + distanceFromEdges(p, game);
      if (score > bestScore) {
        bestScore = score;
        best = p;
      }
    }
  }
  return best;
}


/**
 * 判断当前朝向能否本帧横移离开敌方瞄准线。
 * 若需要先转向才可脱线，近距枪线下通常会慢一拍，应该交给硬传逃生。
 */
function hasImmediatePerpEscapeFromAim(me, enemyTank, enemyBullets, game, enemyPos, enemy) {
  if (!enemyTank || !enemyTank.position) return true;
  const myPos = me.tank.position;
  const lineDir = clearShotDirection(enemyTank.position, myPos, game);
  if (!lineDir || enemyTank.direction !== lineDir) return true;
  const verticalShot = lineDir === "up" || lineDir === "down";
  const d = DIRS[dirIndex(me.tank.direction)];
  if (!d) return false;
  const movingVertical = d.name === "up" || d.name === "down";
  if (verticalShot === movingVertical) return false; // 当前朝向仍沿弹道轴，不能本帧离线

  const p = [myPos[0] + d.dx, myPos[1] + d.dy];
  if (!isPassable(game, p, enemyPos)) return false;
  if (enemyAimsAt(p, enemyTank, game)) return false;
  if (anyBulletThreatens(enemyBullets || [], p, game)) return false;
  if (stepIntoBulletPath(enemyBullets || [], p, game)) return false;
  if (predictedOverloadThreatens(enemy, p, game)) return false;
  return true;
}


/**
 * 寻找紧急逃生传送点。
 * 触发条件：传送就绪，且当前位置被任意敌方子弹威胁、或常规躲避来不及（隐身/过载场景由调用方先行判断）。
 * 落点要求：远离所有子弹弹道、远离敌人（避免传送后立刻被开火锁定或对射）。
 */
function findEscapeTeleport(me, enemy, enemyTank, enemyBullets, game) {
  if (!teleportReady(me)) return null;
  const myPos = me.tank.position;
  const threatened = anyBulletThreatens(enemyBullets, myPos, game);
  // 过载预警：敌人处于过载(下次开火即双弹)、已瞄准我或与我同线、且近距(<=6)时，双弹几乎躲不掉，提前传送拉开
  const overloadEnemy = enemy && enemy.status && enemy.status.overloaded;
  const overloadAmbush = overloadEnemy && enemyTank && enemyTank.position &&
    !!clearShotDirection(enemyTank.position, myPos, game) &&
    manhattan(enemyTank.position, myPos) <= 6;
  // 近距硬锁：像 mat_4C5，敌已瞄准且我当前朝向无法立刻横移，转向会来不及。
  const pointBlankAimLock = enemyTank && enemyTank.position && enemyCanFireSoon(enemy) &&
    enemyAimsAt(myPos, enemyTank, game) &&
    manhattan(enemyTank.position, myPos) <= 4 &&
    !hasImmediatePerpEscapeFromAim(me, enemyTank, enemyBullets, game, enemyTank.position, enemy);
  if (!threatened && !overloadAmbush && !pointBlankAimLock) return null;
  // 过载敌人弹道更密，逃生落点额外拉开距离
  return bestTeleportTile(myPos, enemyTank, enemyBullets, game, game.star, true, (overloadEnemy || pointBlankAimLock) ? 6 : 4, enemy);
}


/**
 * 寻找抢夺星星的传送点
 */
function findStarTeleport(me, enemy, enemyTank, enemyBullets, game, state) {
  if (!teleportReady(me) || !game.star) return null;
  const enemyPos = enemyTank ? enemyTank.position : null;
  const walkDist = pathDistance(me.tank.position, game.star, game, enemyPos);

  // 终局帧数博弈：临近 128 帧结束时，按星数判胜负。若走路来不及吃星(walkDist>剩余帧)，但传送+剩余帧内
  // 敌人即使立刻开火也打不到我(剩余帧 < 敌开火命中所需帧)，则大胆传送抢星锁分——哪怕落点在敌炮线。
  const endgameGrab = endgameStarTeleport(me, enemy, enemyTank, enemyBullets, game, walkDist);
  if (endgameGrab) return endgameGrab;

  // 过载敌人：仅当对方 overload 冷却 <= 10 帧（即将放双弹）时才保留传送做逃生，
  // 其余时间允许传星——传完后靠走位评分避开双弹带，不在这里一刀切禁止。
  if (enemyIsOverloadType(enemy)) {
    // 过载即将开火(已过载状态)：传星后若落点在双弹带内且无法即时逃跑，则留传送做逃生。
    // 注意：overloadCD=0 但敌未激活(status.overloaded=false)，不等于实弹在途，不能一刀切禁用传星。
    // isTeleportSafe / isStarGuardTrap 已过滤落点危险，此处只阻断"敌已过载中(实弹即将飞出)"的情形。
    if (enemy && enemy.status && enemy.status.overloaded) return null; // 已激活，双弹本帧就发出
  }

  // 走路够快(<=5步)时通常不浪费传送，但若敌人比我更近星则仍需传送抢
  if (walkDist >= 0 && walkDist <= 5) {
    var enemyToStar = enemyPos ? pathDistance(enemyPos, game.star, game, me.tank.position) : -1;
    if (enemyToStar < 0 || walkDist <= enemyToStar + 1) return null;
  }

  // 守星陷阱：敌握双弹且星在其覆盖带内时放弃传送（与 shouldChaseStar 走路判断用同一函数）
  if (isStarGuardTrap(enemyPos, enemy, game.star)) return null;

  // 星在敌方近距射线上：直传星点会踏入射线送死(mat_GDXBfZAVR5e3xWW76)。
  // 但不直接 return null——后面 crossAdjacentStarTeleport 可找"不在射线上"的安全十字格落地。
  // 仅在敌人贴脸星(manhattan<=2, 子弹1帧到达)时彻底禁止传送（传哪都来不及）。
  var starOnEnemyFireLine = !!(enemyPos && enemyCanFireSoon(enemy) &&
      clearShotDirection(enemyPos, game.star, game) && manhattan(enemyPos, game.star) <= 6);
  if (starOnEnemyFireLine && manhattan(enemyPos, game.star) <= 2) return null;

  // 隐身守星：先找贴最后隐身格的安全压迫位；找不到则放弃传星，避免直送星点。
  const hiddenCloakGrab = hiddenCloakStarTeleport(me, enemy, enemyTank, enemyBullets, game, state);
  if (hiddenCloakGrab) return hiddenCloakGrab;
  if (hiddenCloakStarThreatPositions(enemy, enemyTank, game, state).length > 0) return null;

  // 丢失视野时，估算敌人老家位置，避开可能的危险区域传送
  if (!enemyTank) {
    const enemyGuess = estimateEnemyHome(me.tank.position, game);
    if (enemyGuess && manhattan(game.star, enemyGuess) <= ASSASSIN_MAX_RANGE) {
      return bestUnknownEnemyStarTeleport(me.tank.position, enemyGuess, enemyBullets, game);
    }
  }

  const centralContestGrab = centralTeleportStarContest(me, enemy, enemyTank, enemyBullets, game);
  if (centralContestGrab) return centralContestGrab;

  // 双 teleport 抢星对撞：敌方传送也就绪时，直传星点 = 站在对方能预判的靶位上送死(mat_JOj 直传 [17,4]，
  // 敌一跳到 [15,4] 同行右射 2格/帧瞬达把我秒)。星点同时暴露在"行+列"两条线，对方传到任一条线即可命中。
  // 改传星十字相邻一格(只暴露行或列之一、对方猜不到我落哪个十字格)，下一帧再走上去补吃；找不到安全相邻格再退回原逻辑。
  //
  // 门控(mat_FH69 复盘)：十字相邻避狙的前提是"对手也得靠瞬移到星线来抢这颗星"。若对手走路就能到星
  // (foeWalk 近)，它会直接走过去吃，不会瞬移狙我——此时我传旁边一格反而吃不到星、还可能因补吃格贴敌被
  // 死区拦下而丢星(mat_FH69 f51 星[3,5]、敌走路 d=3，我传[4,5]没吃到、补吃[3,5]贴敌 d=1 被拦，丢星+废传送)。
  // 仅当对手走路够不到星(foeWalk 远，会被迫传送瞬移)时才用十字相邻避狙；否则直传星点抢分。
  if (enemyTeleportReady(enemy)) {
    const foeWalk = enemyPos ? pathDistance(enemyPos, game.star, game, me.tank.position) : -1;
    const foeMustTeleport = foeWalk < 0 || foeWalk > 5; // 对手走路够不到(或不可达) -> 才会瞬移狙星线
    if (foeMustTeleport) {
      const crossGrab = crossAdjacentStarTeleport(me, enemyTank, enemyBullets, game, enemy);
      if (crossGrab) return crossGrab;
    }
  }

  // 传送削弱：直传星点会被引擎随机重路由到星旁，改为自选最优星旁格（可控落点）
  if (isTeleportSafe(game.star, enemyTank, enemyBullets, game, 0, enemy) &&
      !starLandingDeadly(game.star, me, enemyTank, enemy, game) &&
      !landingNearSweepingBullet(game.star, enemyBullets, game)) {
    const adj = crossAdjacentStarTeleport(me, enemyTank, enemyBullets, game, enemy);
    if (adj) return adj;
    return game.star; // fallback: 所有十字格不安全时仍传星点
  }

  const adjacentUnsafeStarGrab = unsafeStarAdjacentTeleport(me, enemy, enemyTank, enemyBullets, game, walkDist);
  if (adjacentUnsafeStarGrab) return adjacentUnsafeStarGrab;

  const lateContestGrab = lateContestedAdjacentStarTeleport(me, enemy, enemyTank, enemyBullets, game, walkDist);
  if (lateContestGrab) return lateContestGrab;

  // 星星上不安全则传送到星星附近最安全的点
  return bestTeleportTile(me.tank.position, enemyTank, enemyBullets, game, game.star, false, 0, enemy);
}


/**
 * 双 teleport 抢星：传送到星星"十字相邻一格"而非星点本身。
 *
 * 为什么不直传星点：双方都是 teleport 时，对方可瞬移到星星所在行/列上沿线狙击(mat_JOj 敌跳到 [15,4]
 * 与星 [17,4] 同行右射，子弹 2格/帧瞬达把我秒)。星点同时位于"行 y=4"和"列 x=17"两条线，
 * 对方传到任一条线即可命中我。
 *
 * 十字相邻格(星的上/下/左/右一格)只落在"行或列"之一上：例如落星上方 [17,3]，则敌沿星所在行 y=4 的炮弹
 * 打不到 y=3 的我；对方也无法预判我会落四个十字格中的哪个。落点本身用 isTeleportSafe + starLandingDeadly
 * 双重过滤(不卡墙、不在现有子弹/炮线、对射不吃亏)，选离敌最远、最不易被狙的那个。
 * 下一帧 onIdle 会走 1 步上去吃星(走路 1 格/帧)。找不到任何安全十字格则返回 null，退回原直传逻辑。
 */
function crossAdjacentStarTeleport(me, enemyTank, enemyBullets, game, enemy) {
  const star = game.star;
  if (!star) return null;
  const myPos = me.tank.position;
  const enemyPos = enemyTank ? enemyTank.position : null;
  // 星点在敌方射线上且敌能开火：不再一刀切禁止所有十字格，
  // 改为下方循环中逐格过滤——排除"落点与星同行/列对准敌人"的十字格(补吃时穿越敌射线)，
  // 保留垂直方向的安全十字格(补吃方向不在敌射线上)。
  // 仅在敌贴脸星(≤2格,子弹1帧到)时彻底放弃(任何十字格补吃都来不及)。
  var enemyLineToStar = !!(enemyPos && enemyCanFireSoon(enemy) && clearShotDirection(enemyPos, star, game));
  var enemyStarDist = enemyPos ? manhattan(enemyPos, star) : 99;
  if (enemyLineToStar && enemyStarDist <= 2) return null;
  let best = null;
  let bestScore = -Infinity;
  for (let i = 0; i < DIRS.length; i++) {
    const c = [star[0] + DIRS[i].dx, star[1] + DIRS[i].dy];
    if (samePos(c, myPos)) continue;
    // 落点必须能站、不在子弹/炮线上、对射不吃亏
    if (!isTeleportSafe(c, enemyTank, enemyBullets, game, 0, enemy || null)) continue;
    if (starLandingDeadly(c, me, enemyTank, enemy || null, game)) continue;
    // 敌有射线对星时：排除"补吃走入星格时经过敌射线"的十字格
    // 十字格到星的补吃方向 = 走回星格。若十字格与敌同行/列(即落点本身在敌射线上)，补吃那帧我暴露在射线上。
    // 仅保留不在敌射线方向上的十字格(垂直轴方向的格)。
    if (enemyLineToStar && enemyStarDist <= 6) {
      if (clearShotDirection(enemyPos, c, game)) continue;
    }
    // 必须能从该格一步走到星(中间无墙/相邻)——十字相邻天然满足，但星可能贴墙导致某向不可达，复检
    if (!isPassable(game, star, enemyPos)) return null; // 星点本身不可站则无意义
    // 打分：离敌越远越好(越不易被瞬移狙击)；远离地图边缘(留躲闪空间)；
    // 减去转向成本：落点走到星需要的转向帧数越少越好（省帧 = 更快吃星）
    const enemyScore = enemyPos ? manhattan(c, enemyPos) : 0;
    const toStarDir = directionBetween(c, star);
    const turnCost = toStarDir ? turnDistance(me.tank.direction, toStarDir) : 0;
    const score = enemyScore * 2 + distanceFromEdges(c, game) - turnCost * 3;
    if (score > bestScore) {
      bestScore = score;
      best = c;
    }
  }
  return best;
}


/**
 * 中央星点的双 teleport 竞星：若星点在开阔中心、敌当前炮线并未锁星，
 * 贴星一格会让敌直接踩星后形成我方 fireLocked 的近距劣势（mat_C28）。
 * 此时优先直传星点抢分；边角星仍走 crossAdjacent，保留 mat_JOj / mat_KBZ 的避狙逻辑。
 */
function centralTeleportStarContest(me, enemy, enemyTank, enemyBullets, game) {
  if (!game.star || !enemyTeleportReady(enemy) || !enemyTank || !enemyTank.position) return null;
  const frame = (game && game.frames) || 0;
  if (frame > 8) return null; // 只处理开局/早局的同帧抢第一颗星，避免中后期过度冒险
  if (distanceFromEdges(game.star, game) < 4) return null; // 边角星被瞬移狙击概率高，继续用十字相邻
  if (clearShotDirection(enemyTank.position, game.star, game)) return null; // 敌当前已锁星线，不直送炮口
  if (!isTeleportSafe(game.star, enemyTank, enemyBullets, game, 0, enemy)) return null;
  if (starLandingDeadly(game.star, me, enemyTank, enemy, game)) return null;
  // 传送削弱：直传星点被引擎随机重路由，优先选可控的星旁格
  const centralAdj = crossAdjacentStarTeleport(me, enemyTank, enemyBullets, game, enemy);
  return centralAdj || game.star;
}


/**
 * 星点本身落地即死时的进攻型补偿。
 * 参考小强 mat_7m1：直接上星不安全就贴星一格，保留下一帧抢星节奏。
 */
function unsafeStarAdjacentTeleport(me, enemy, enemyTank, enemyBullets, game, walkDist) {
  if (!game.star || !enemyTank || !enemyTank.position) return null;
  if (walkDist >= 0 && walkDist <= 5) return null;
  const starSafe = isTeleportSafe(game.star, enemyTank, enemyBullets, game, 0, enemy) &&
    !starLandingDeadly(game.star, me, enemyTank, enemy, game);
  if (starSafe) return null;
  return crossAdjacentStarTeleport(me, enemyTank, enemyBullets, game, enemy);
}


/**
 * 晚局比分胶着时，若直传星点会被敌炮线秒掉，但敌人又明显比我更快接星，
 * 优先传到星的十字相邻安全格，而不是退到泛化安全落点的两三格外。
 * 复盘来源：mat_12d26hXYXtTHzftkj，小强 f115-f118 星在 [14,6]。
 */
function lateContestedAdjacentStarTeleport(me, enemy, enemyTank, enemyBullets, game, walkDist) {
  if (!game.star || !enemyTank || !enemyTank.position) return null;
  const frame = (game && game.frames) || 0;
  const framesLeft = MAX_GAME_FRAMES - frame;
  if (framesLeft > 20) return null;

  const myStars = me && typeof me.stars === "number" ? me.stars : 0;
  const enemyStars = enemy && typeof enemy.stars === "number" ? enemy.stars : 0;
  if (myStars > enemyStars) return null;

  const enemyDist = pathDistance(enemyTank.position, game.star, game, me.tank.position);
  if (enemyDist < 0) return null;
  if (enemyDist > Math.min(5, framesLeft)) return null;
  if (walkDist >= 0 && walkDist <= enemyDist) return null;

  return crossAdjacentStarTeleport(me, enemyTank, enemyBullets, game, enemy);
}



/**
 * 传送抢星前是否应"先转向再传送"，返回应转到的朝向(null=直接传)。
 * 仅当敌方是 teleport 技能(能瞬移到星另一侧对撞) + 双方都离星近(可能同帧抢同一颗星) + 传送落点也贴星时触发：
 * 传送落地朝向不变，若不先对准，落地后转向那帧会被对侧传来的敌人抢先开火(mat_KBZ 传[3,6]朝向不对被秒)。
 * 返回"落点 -> 星"方向：对撞在星周围发生，朝星即朝可能出现的敌人，落地即可对射不被抢先。
 */
function teleportPreTurnDir(me, landing, enemy, enemyTank, game) {
  if (!enemyHasTeleport(enemy)) return null;     // 仅针对会瞬移对撞的 teleport 敌人
  if (!game.star) return null;
  const enemyPos = enemyTank ? enemyTank.position : null;
  if (!enemyPos) return null;
  // 双方都离星近(都可能传送来抢)才有对撞风险；敌离星远则不会来对撞，无需预转
  if (manhattan(enemyPos, game.star) > ASSASSIN_MAX_RANGE) return null;
  // 落点要贴星(对撞区, 距星<=2)才需要预转；远离星的安全落点不必
  if (manhattan(landing, game.star) > 2) return null;
  // 落点已避开敌方当前清晰炮线(如十字相邻安全格)则无对射风险，直接传不必浪费一帧预转；
  // 仅当落点确实在敌当前炮线/即落点就是星点(双方对撞挤同格)时才需先转对准。
  if (!samePos(landing, game.star) && !clearShotDirection(enemyPos, landing, game)) return null;
  // 理想落地朝向 = 落点指向星(对撞方向)。落点即星点时退而指向敌人当前方位。
  const dir = samePos(landing, game.star)
    ? clearShotDirection(landing, enemyPos, game) || directionBetween(landing, enemyPos)
    : directionBetween(landing, game.star);
  return dir || null;
}


/**
 * 终局抢星传送：临近第 128 帧、走路来不及吃星时，若传送到星点后敌人即使立刻开火也来不及在终局前命中，
 * 就传送抢星锁定星数胜负（超时按星数判）。子弹2格/帧：敌最快命中我需 1(传送占帧,敌下帧响应)+敌转向(0或1)+ceil(dist/2)。
 * 剩余帧 < 该命中帧 -> 终局前打不到我 -> 安全抢星，哪怕落点在敌炮线。落点本身必须可站(不卡墙/不接现有子弹)。
 */
function endgameStarTeleport(me, enemy, enemyTank, enemyBullets, game, walkDist) {
  const frame = (game && game.frames) || 0;
  const framesLeft = MAX_GAME_FRAMES - frame;
  if (framesLeft <= 0) return null;
  // 只在终局窗口内启用(剩余<=10帧)，且走路确实来不及吃(walkDist 不可达或 > 剩余帧)
  if (framesLeft > 10) return null;
  if (walkDist >= 0 && walkDist <= framesLeft) return null; // 走路来得及，无需传送
  const star = game.star;
  // 落点必须能站(不卡墙/土块；星点格按规则可站)
  if (!isPassable(game, star, enemyTank ? enemyTank.position : null)) return null;
  // 敌人最快命中我所需帧：传送当前帧用掉，敌下一帧起算
  const enemyPos = enemyTank ? enemyTank.position : null;
  if (enemyPos) {
    const lineDir = clearShotDirection(enemyPos, star, game);
    const dist = manhattan(enemyPos, star);
    // 同线无墙才打得到；不同线/有墙则需敌移动+转向，更慢，这里取最快的同线情形保守估计
    const enemyFacing = lineDir && enemyTank.direction === lineDir;
    const hitFrames = 1 + (lineDir ? (enemyFacing ? 0 : 1) : 2) + Math.ceil(dist / BULLET_SPEED);
    if (framesLeft >= hitFrames) return null; // 敌来得及在终局前打到 -> 不强抢
  }
  // 传送削弱：直传星点被引擎随机重路由，需要额外 1 帧补吃；加上传送后2帧拾取冷却
  // 计算传送后到星需要多少帧：2帧等待 + 转向(0/1/2) + 移动 1 步
  const endgameAdj = crossAdjacentStarTeleport(me, enemyTank, enemyBullets || [], game, enemy);
  const landing = endgameAdj || star;
  const landingToStarDir = directionBetween(landing, star);
  const turnsNeeded = landingToStarDir ? turnDistance(me.tank.direction, landingToStarDir) : 0;
  if (framesLeft < 1 + 2 + turnsNeeded + 1) return null; // 传送帧 + 2帧等待 + 转向帧 + 走上去
  return landing;
}


/**
 * 传送落点是否紧贴一发"横扫中"的飞行子弹，使得我吃完星后的自然走向会撞进它的弹道。
 * 复盘来源：mat_GwxblYdS4ZSDXd0wX f51-f54——我传 [15,14] 吃星(落点本身安全，子弹在 y=12)，
 * 落地后朝 up 一路走 [15,14]->[15,13]->[15,12]，f54 正好撞上沿 y=12 右扫的子弹。
 *
 * 落点本身不在弹道(isTeleportSafe 已过滤)，但若一发子弹与落点只差 1~2 行/列、且落点朝子弹那条行/列
 * 偏移 1~2 格的邻格正落在该子弹的未来飞行路径上(同行/列且子弹朝它飞来)，则落点是"陷阱落点"——
 * 我吃完星自然走 1~2 步进那条行/列时会与扫来的子弹相遇(子弹 2 格/帧 > 我 1 格/帧，迟早撞上)。
 * 用 bulletReachTiles 判邻格是否在子弹未来路径上，不限帧数(走过去就会被扫到)。
 */
function landingNearSweepingBullet(landing, enemyBullets, game) {
  const bullets = enemyBullets || [];
  for (let i = 0; i < bullets.length; i++) {
    const b = bullets[i];
    if (!b || !b.position) continue;
    const horizontal = b.direction === "left" || b.direction === "right";
    // 子弹横扫的是它的飞行轴(水平飞->沿 x 扫，落点在相邻 y)；竖直飞->沿 y 扫，落点在相邻 x。
    const sweepAxisSame = horizontal ? (b.position[1] !== landing[1]) : (b.position[0] !== landing[0]);
    if (!sweepAxisSame) continue; // 落点与子弹同行/列由 isTeleportSafe/stepIntoBulletPath 处理，这里只管相邻带
    const offset = horizontal ? Math.abs(b.position[1] - landing[1]) : Math.abs(b.position[0] - landing[0]);
    if (offset === 0 || offset > 2) continue; // 只防相邻 1~2 行/列(吃完星 1~2 步会踏入)
    for (let s = 1; s <= offset; s++) {
      // 朝子弹弹道方向挪 s 步的落点邻格(模拟吃完星走向弹道行/列)
      const towardBullet = horizontal
        ? [landing[0], landing[1] + (b.position[1] > landing[1] ? s : -s)]
        : [landing[0] + (b.position[0] > landing[0] ? s : -s), landing[1]];
      if (!isPassable(game, towardBullet, null)) break; // 被墙挡住，走不过去，安全
      // 邻格在子弹未来飞行路径上(同行/列、子弹朝它飞来、中间无墙) -> 走过去迟早被扫到
      if (bulletReachTiles(b, towardBullet, game) >= 0) return true;
    }
  }
  return false;
}


/**
 * 判断传送到 landing（如星星）会不会"落地即死"：敌方与落点同线、能在我躲开前开火命中。
 *
 * 时间线（子弹 2 格/帧）：传送占当前帧；敌方下一帧可转向对准(若未对准+1帧)并开火；
 * 子弹命中我耗时 ceil(dist/2) 帧。我方落地后需横向脱离：若有可走且不被敌方再次瞄准的侧格，
 * 当前朝向就是侧向只需 1 帧、否则需转向+前进 2 帧。来不及脱离即判为死亡陷阱。
 */
function starLandingDeadly(landing, me, enemyTank, enemy, game) {
  if (!enemyTank || !enemyTank.position) return false;
  if (!enemyCanFireSoon(enemy)) return false; // 敌方近期无法开火则无威胁

  const enemyPos = enemyTank.position;
  const lineDir = clearShotDirection(enemyPos, landing, game);
  if (!lineDir) return false; // 敌方与落点不同线/被遮挡，打不到

  const dist = manhattan(enemyPos, landing);
  // 敌方反击命中我所需帧：已对准则下一帧即可开火，否则先转向 +1 帧
  const enemyFacing = enemyTank.direction === lineDir;
  const enemyHitFrames = Math.ceil(dist / BULLET_SPEED) + (enemyFacing ? 0 : 1);

  // 对射先手对比：传送后我保持朝向，需转向对准敌人(landing->enemy)再开火。
  // 传送落点距敌<=4 还会被开火锁定2帧，先手更差。只要我不是严格快于敌人，落在其炮线上就视为危险陷阱。
  const myDirToEnemy = clearShotDirection(landing, enemyPos, game);
  const myTurnFrames = myDirToEnemy ? turnDistance(me.tank.direction, myDirToEnemy) : 2;
  const fireLockPenalty = dist <= 4 ? 2 : 0; // 落点太近会 fireLocked 2 帧
  const myHitFrames = myTurnFrames + fireLockPenalty + Math.ceil(dist / BULLET_SPEED);
  if (myHitFrames >= enemyHitFrames) return true; // 对射不占先手 -> 别传到这条炮线上送死

  // 我方脱离所需帧：找垂直于敌方弹道、可走且不会被敌方立刻再瞄准的侧格
  const perp = (lineDir === "up" || lineDir === "down")
    ? [DIRS[dirIndex("left")], DIRS[dirIndex("right")]]
    : [DIRS[dirIndex("up")], DIRS[dirIndex("down")]];
  let escapeFrames = 99;
  for (let i = 0; i < perp.length; i++) {
    const q = [landing[0] + perp[i].dx, landing[1] + perp[i].dy];
    if (!isPassable(game, q, enemyPos)) continue;
    if (enemyAimsAt(q, enemyTank, game)) continue; // 侧格仍在另一条炮线上则无效
    const need = perp[i].name === me.tank.direction ? 1 : 2;
    if (need < escapeFrames) escapeFrames = need;
  }

  // 我无法在敌弹命中前完成脱离 -> 死亡陷阱
  return escapeFrames >= enemyHitFrames;
}


/**
 * 在丢失敌人视野时，寻找安全的星星传送点
 */
function bestUnknownEnemyStarTeleport(myPos, enemyGuess, enemyBullets, game) {
  let best = null;
  let bestScore = -9999;
  for (let x = 0; x < game.map.length; x++) {
    for (let y = 0; y < game.map[x].length; y++) {
      const p = [x, y];
      if (samePos(p, myPos)) continue;
      if (!isPassable(game, p, null)) continue; // 不能是墙或土块
      if (anyBulletThreatens(enemyBullets, p, game)) continue; // 不能在子弹轨迹上
      if (manhattan(p, enemyGuess) <= ASSASSIN_MAX_RANGE) continue; // 避开敌人可能出现的地方

      const score = -manhattan(p, game.star) * 3 + distanceFromEdges(p, game);
      if (score > bestScore) {
        bestScore = score;
        best = p;
      }
    }
  }
  return best;
}


/**
 * 遍历全图，评估并返回最佳的通用传送落点
 * minEnemyDist: 落点与敌人的最小曼哈顿距离门槛（防开火锁定/对射），0 表示不限制。
 */
function bestTeleportTile(myPos, enemyTank, enemyBullets, game, target, preferDistance, minEnemyDist, enemy) {
  let best = null;
  let bestScore = -9999;
  // 抢星落点(target 是星)额外排除"紧贴横扫子弹、走向会撞弹道"的陷阱落点(mat_GwxblYdS)。
  const avoidSweep = target && game.star && samePos(target, game.star);
  for (let x = 0; x < game.map.length; x++) {
    for (let y = 0; y < game.map[x].length; y++) {
      const p = [x, y];
      if (samePos(p, myPos)) continue;
      if (!isTeleportSafe(p, enemyTank, enemyBullets, game, minEnemyDist || 0, enemy)) continue;
      if (avoidSweep && landingNearSweepingBullet(p, enemyBullets, game)) continue;

      const enemyPos = enemyTank ? enemyTank.position : null;
      // 偏好远离敌人打分
      const enemyScore = enemyPos ? manhattan(p, enemyPos) : 0;
      // 偏好靠近目标(如星星)打分
      const targetScore = target ? -manhattan(p, target) * 2 : 0;

      const score = distanceFromEdges(p, game) + targetScore + (preferDistance ? enemyScore : 0);
      if (score > bestScore) {
        bestScore = score;
        best = p;
      }
    }
  }
  return best;
}


/**
 * 判断某个坐标是否适合传送（不卡墙、不接子弹、不被瞄准）
 * minEnemyDist: 与敌人的最小允许曼哈顿距离，0 表示不限制。
 */
function isTeleportSafe(p, enemyTank, enemyBullets, game, minEnemyDist, enemy) {
  const enemyPos = enemyTank ? enemyTank.position : null;
  if (!isPassable(game, p, enemyPos)) return false;
  const bullets = enemyBullets || [];
  for (let i = 0; i < bullets.length; i++) {
    if (bullets[i] && samePos(p, bullets[i].position)) return false;
  }
  if (enemyAimsAt(p, enemyTank, game)) return false;
  if (anyBulletThreatens(bullets, p, game)) return false;
  // 避免落点离敌人太近（曼哈顿距离<=4会被开火锁定，且易被对射）
  if (minEnemyDist > 0 && enemyPos && manhattan(p, enemyPos) <= minEnemyDist) return false;
  // 避免落在敌方清晰炮线上的近距(<=4)：敌人转身即可开火，我落地多半来不及脱离（闪现送死，见 mat_JYuX/mat_1BN）
  if (enemyPos && manhattan(p, enemyPos) <= 4 && clearShotDirection(enemyPos, p, game)) return false;
  // 过载敌人：落点不能进双弹覆盖带(敌同行/列 或 相邻±1 行/列且近距)——副弹走相邻列，严格同线判定会漏(mat_EHR 传 [17,10] 距敌3格相邻列被秒)
  if (enemyPos && enemyDoubleLaneThreat(enemy) && inDoubleLaneBand(enemyPos, p, 6)) return false;
  if (predictedOverloadThreatens(enemy, p, game)) return false;
  return true;
}



/**
 * 与敌人的最小安全间距：
 * - 双弹威胁(已过载/过载就绪)：6 格(双弹随时来，最危险)；
 * - overload 流但冷却中：5 格(冷却好就双弹，不能贴身缠斗，保守周旋 mat_D9W)；
 * - 隐身敌人：5 格；普通敌人：4 格。5~6 格是子弹约 3 帧到达的距离，配合横移刚好够躲。
 */
function safeStandoffDistance(enemy) {
  if (enemyDoubleLaneThreat(enemy)) return 6;
  if (enemyIsOverloadType(enemy)) return 5;
  // freeze 流：冻我 2 帧期间敌可从容对准开火，贴近(<=4 同线)被冻必死，保守拉到 5 格周旋(mat_0Wmx)。
  if (enemyIsFreezeType(enemy)) return 5;
  // stun 流：被眩晕 6 帧 go/turn 半数反向，贴身近战会失控撞炮线，拉到 5 格留侧移离线余量。
  if (enemyIsStunType(enemy)) return 5;
  // poison 流：中毒 4 帧只能隔帧动，近身躲弹反应被拖慢，拉到 5 格留出隔帧躲避余量。
  if (enemyIsPoisonType(enemy)) return 5;
  if (enemy && enemy.skill && enemy.skill.type === "cloak") return 5;
  return 4;
}


/**
 * 判断走到 next 后是否进入"会被秒的死区"。
 * 子弹 2 格/帧 + 我转向 1 帧：3 格内只要需要转向就躲不掉，故普通敌人 d<=3 即死区。
 * 双弹威胁敌人(过载中 或 过载流冷却就绪)：一帧双弹走"正行/列+相邻±1行/列"，
 * d<=4 一律死区；standoff 内且落在双弹覆盖带、又无法一步横向跨出覆盖带(走廊夹死)亦为死区。
 * overload 流(哪怕此刻冷却中)：敌可"错位一列"站位，过载副弹专打相邻列(mat_4YF 敌[14,8]站我[15,10]相邻列，
 * 过载副弹走 x=15 把我秒)。故对 overload 流敌人，落在其双弹覆盖带(相邻±1)且 standoff 内、无法跨出也判死区——
 * 逼自己离开相邻列到 dx>=2 的安全列，不在 overload 敌身边的副弹道上逗留。
 * 石墙遮挡豁免：敌我之间有墙、敌人当前及移动一步后都打不到 next 时，那条"近距"其实安全(子弹被墙吃掉)。
 */
function stepEntersKillZone(myPos, next, enemyPos, game, enemy, standoff) {
  const d = manhattan(next, enemyPos);
  const doubleLane = enemyDoubleLaneThreat(enemy);   // 真实双弹威胁(已过载/就绪) -> d<=4 一律死区
  const overloadType = enemyIsOverloadType(enemy);    // overload 流(含冷却中) -> 覆盖带逗留也危险(错位射击)
  const freezeType = enemyIsFreezeType(enemy);        // freeze 流 -> 同线 d<=4 被冻必死(冻2帧期间敌从容对准开火)
  // 贴脸 d<=1：无论有无墙，敌一步即可近身/绕射，恒死区
  if (d <= 1) return true;
  // 石墙完全遮挡：敌当前打不到 next、且敌四向移动一步后也仍打不到 next -> 子弹被墙挡，非死区
  if (d >= 2 && wallBlocksEnemyShot(next, enemyPos, game)) {
    // 被墙挡住时只豁免"普通炮线死区"；双弹覆盖带若仍可达则继续走下方判定
    if (!doubleLane && !overloadType) return false;
  }
  // 普通敌人：贴近 3 格内即死区（转向就被追上）。
  // overload 流在”后撤且确实拉开距离”时，允许先退一步再交给下一帧继续评估，避免太近时直接卡死。
  // 但后撤豁免不能覆盖”next 仍在敌方直射线上”的情况——敌此刻已对准，退一步照样被秒。
  if (d <= 3) {
    if (overloadType && manhattan(next, enemyPos) > manhattan(myPos, enemyPos) &&
        !clearShotDirection(enemyPos, next, game)) return false;
    return true;
  }
  // 双弹威胁敌人：同行/列或相邻±1行/列内 d<=4 是死区；纯对角(无直射线)放行，
  // 避免封死所有"曼哈顿≤4但方向偏移"的格，让坦克仍能绕路抢星。
  if (doubleLane && d <= 4) {
    if (clearShotDirection(enemyPos, next, game) !== null) return true; // 敌有直射 -> 死区
    if (inDoubleLaneBand(enemyPos, next, 4)) return true;              // 在双弹覆盖带内 -> 死区
    // 纯对角(dx>=2 && dy>=2)且无直射 -> 放行（敌需先转向再瞄准）
  }
  // freeze 流：与敌同行/列、无墙、曼哈顿<=4 时被冻 2 帧期间会被对准击杀(mat_0Wmx d=1 被冻点死) -> 死区。
  // 不同线/有墙(freezeKillsAt 内 clearShotDirection 判定)则不算，避免对开阔地相邻列防过头。
  if (freezeType && freezeKillsAt(next, enemyPos, game)) return true;
  // stun 流：同线 dist<=4 被晕6帧 无法可靠闪避(mat_7zpz dist2同线被晕→盾失效→双杀)。
  if (enemyIsStunType(enemy) && stunKillsAt(next, enemyPos, game)) return true;
  // 双弹威胁/overload流：standoff 内 + 落在双弹覆盖带(同行/列或相邻±1) + 无法一步跨出覆盖带 -> 死区
  // (mat_73I 走廊夹死 / mat_4YF 错位副弹列逗留)。overload流即使冷却中也算——敌会突然过载。
  if ((doubleLane || overloadType) && d < standoff && inDoubleLaneBand(enemyPos, next, standoff)) {
    if (!hasDoubleLaneEscapeAt(next, enemyPos, game)) return true;
  }
  return false;
}


/**
 * 敌人的子弹此刻打不到 next、且敌人朝四个方向各移动一步后也仍打不到 next（中间都有墙遮挡）。
 * 即 next 被石墙保护，敌人近距也无法直射 -> 该格其实安全(mat_7JO [3,10] 与敌[6,10]间 [5,10] 是墙)。
 */
function wallBlocksEnemyShot(next, enemyPos, game) {
  if (clearShotDirection(enemyPos, next, game)) return false; // 当前就能直射 -> 没被墙挡
  // 敌移动一步后的四个位置，任一能直射 next 则不算被墙完全封住
  for (let i = 0; i < DIRS.length; i++) {
    const ep = [enemyPos[0] + DIRS[i].dx, enemyPos[1] + DIRS[i].dy];
    if (!isPassable(game, ep, null)) continue;
    if (clearShotDirection(ep, next, game)) return false;
  }
  return true; // 当前及移动一步后都打不到 -> 被墙挡
}


/**
 * 隐身敌射线检查：敌人不可见但有最近传送/消失位置时，
 * 判断走到 next 是否会进入该位置的射击线（同行/列无墙遮挡）。
 * 近距（manhattan ≤ 4）直接拒绝，中距（≤ 6）除非 next 是星否则也拒绝。
 */
function stepIntoHiddenEnemyFireLine(next, myPos, game, memory, isStar) {
  if (!memory) return false;
  var frame = (game && game.frames) || 0;
  var stuck = memory.stuckFrames || 0;
  var stuckRelax = stuck >= 4;
  // 高卡住帧数时完全放行：防止热力图扩散导致的无限震荡(mat_KIVHqQI7CpDLwTbF0)
  if (stuck >= 10 && isStar) return false;

  // 来源1: lastEnemyPos（12帧内有效）
  if (memory.lastEnemyPos && frame - memory.lastEnemySeenFrame <= 12) {
    if (_hiddenFireLineBlocked(memory.lastEnemyPos, next, myPos, game, isStar, stuckRelax)) return true;
    // 来源1b: 沿敌最后朝向外推的预测位置（隐身/消失后可能继续前进）
    var age = frame - memory.lastEnemySeenFrame;
    if (memory.lastEnemyDir && age >= 2 && age <= 6) {
      var dxDir = { right: 1, left: -1, up: 0, down: 0 };
      var dyDir = { right: 0, left: 0, up: -1, down: 1 };
      var dx = dxDir[memory.lastEnemyDir], dy = dyDir[memory.lastEnemyDir];
      for (var step = 1; step <= Math.min(age, 4); step++) {
        var pred = [memory.lastEnemyPos[0] + dx * step, memory.lastEnemyPos[1] + dy * step];
        if (!isPassable(game, pred, null)) break;
        if (_hiddenFireLineBlocked(pred, next, myPos, game, isStar, stuckRelax)) return true;
      }
    }
  }

  // 来源2: bushHeatmap 高置信度条目（蹲草敌持续有效，不受12帧限制）
  var hm = memory.bushHeatmap;
  if (hm) {
    for (var k in hm) {
      if (!hm.hasOwnProperty(k) || hm[k].score < 50) continue;
      var parts = k.split(',');
      var bushPos = [parseInt(parts[0]), parseInt(parts[1])];
      if (_hiddenFireLineBlocked(bushPos, next, myPos, game, isStar, stuckRelax)) return true;
    }
  }

  return false;
}

function _hiddenFireLineBlocked(dangerPos, next, myPos, game, isStar, stuckRelax) {
  if (clearShotDirection(dangerPos, myPos, game)) return false;
  if (!clearShotDirection(dangerPos, next, game)) return false;
  var dist = manhattan(dangerPos, next);
  if (stuckRelax) {
    if (dist <= 2) return true;
    if (!_hasEscapeNeighbor(next, dangerPos, game)) return true;
    return false;
  }
  if (dist <= 4) return true;
  if (dist <= 6 && !isStar) return true;
  return false;
}

function _hasEscapeNeighbor(pos, dangerPos, game) {
  for (var i = 0; i < DIRS.length; i++) {
    var p = [pos[0] + DIRS[i].dx, pos[1] + DIRS[i].dy];
    if (!isPassable(game, p, null)) continue;
    if (clearShotDirection(dangerPos, p, game)) continue;
    return true;
  }
  return false;
}


/**
 * next 是否能横向(垂直于敌我连线)脱离双弹覆盖带：
 * 至少一侧能连走两格(第一格脱出敌人正列/行进入相邻列、第二格再跨出相邻列)到 dx>=2(或 dy>=2)的安全格。
 * 走廊贴墙时一侧是墙、另一侧仅一格就撞回主弹列 -> 无此脱离 -> 双弹夹死(mat_73I 沿 x=17 走廊被相邻列副弹追死)。
 * 开阔地两侧能延伸 -> 有脱离(两帧横移即可躲开)，照常走，避免防过头不敢抢星。
 */
function hasDoubleLaneEscapeAt(next, enemyPos, game) {
  const vertical = enemyPos[0] === next[0] || Math.abs(enemyPos[0] - next[0]) <= 1; // 大体同列 -> 双弹竖直来 -> 需左右(x)脱离
  const lateral = vertical
    ? [{ dx: -1, dy: 0 }, { dx: 1, dy: 0 }]
    : [{ dx: 0, dy: -1 }, { dx: 0, dy: 1 }];
  for (let i = 0; i < lateral.length; i++) {
    const s1 = [next[0] + lateral[i].dx, next[1] + lateral[i].dy];
    if (!isPassable(game, s1, enemyPos)) continue; // 第一步就被墙堵
    const s2 = [s1[0] + lateral[i].dx, s1[1] + lateral[i].dy];
    if (!isPassable(game, s2, enemyPos)) continue; // 第二步被墙堵(走廊) -> 这侧脱不掉
    const dx = Math.abs(enemyPos[0] - s2[0]);
    const dy = Math.abs(enemyPos[1] - s2[1]);
    if (dx >= 2 || dy >= 2) return true; // 两格横移跨出双弹覆盖带
  }
  return false;
}


/**
 * 寻找破坏土块的方向（为了抄近道）
 */
function findDigDirection(pos, game, target) {
  let bestDir = null;
  let bestScore = 9999;
  for (let i = 0; i < DIRS.length; i++) {
    const d = DIRS[i];
    let x = pos[0] + d.dx;
    let y = pos[1] + d.dy;
    let range = 1;

    while (range <= 8) {
      const t = tileAt(game, [x, y]);
      if (t === 'x') break;
      if (t === 'm') {
        const after = [x + d.dx, y + d.dy];
        const afterTile = tileAt(game, after);
        if (afterTile === 'x' || afterTile === 'm') break;
        if (target) {
          var afterDist = pathDistance(after, target, game, null);
          if (afterDist < 0) break;
          const score = range * 3 + afterDist;
          if (score < bestScore) { bestScore = score; bestDir = d.name; }
        } else {
          const score = range * 3;
          if (score < bestScore) { bestScore = score; bestDir = d.name; }
        }
        break;
      }
      if (t !== '.' && t !== 'o') break;
      x += d.dx; y += d.dy; range++;
    }
  }
  return bestDir;
}


function findStarDigShot(myPos, star, game, enemyPos) {
  if (!star) return null;
  var currentDist = pathDistance(myPos, star, game, enemyPos);
  if (currentDist === 0) return null;
  if (currentDist < 0) currentDist = 99;

  var bestDir = null, bestSave = 0;
  for (var i = 0; i < DIRS.length; i++) {
    var d = DIRS[i];
    var x = myPos[0] + d.dx, y = myPos[1] + d.dy;
    var range = 1;
    while (range <= 8) {
      var t = tileAt(game, [x, y]);
      if (t === 'x') break;
      if (t === 'm') {
        var after = [x + d.dx, y + d.dy];
        var afterTile = tileAt(game, after);
        if (afterTile === 'x' || afterTile === 'm') break;
        var afterDist = pathDistance(after, star, game, enemyPos);
        if (afterDist < 0) break;
        var saved = currentDist - (range + afterDist);
        if (saved >= 3 && saved > bestSave) {
          bestSave = saved;
          bestDir = d.name;
        }
        break;
      }
      if (t !== '.' && t !== 'o') break;
      x += d.dx; y += d.dy; range++;
    }
  }
  return bestDir;
}


/**
 * 寻找最靠近地图中心的空地
 */
function nearestOpenToCenter(game) {
  const cx = Math.floor(game.map.length / 2);
  const cy = Math.floor(game.map[0].length / 2);
  let best = null;
  let bestScore = 9999;
  
  for (let x = 0; x < game.map.length; x++) {
    for (let y = 0; y < game.map[x].length; y++) {
      const p = [x, y];
      if (!isPassable(game, p, null)) continue;
      const score = Math.abs(x - cx) + Math.abs(y - cy);
      if (score < bestScore) {
        bestScore = score;
        best = p;
      }
    }
  }
  return best;
}


/**
 * 寻找躲避子弹的安全邻近格子。
 * 适配：过载双弹（同时威胁多条弹道）、按子弹真实速度(2格/帧)判断能否在命中前移开、
 * 优先选当前朝向就能直接前进的方向（避免反复转向空耗帧而原地被击中）。
 *
 * 时序模型（关键修复 mat_2cHX/mat_DXZ）：子弹 incomingFrames 帧后命中我当前格。
 *  - 朝向即脱离方向(needFrames=1)：本帧 go 立刻离格，只要 incomingFrames>=1 即安全。
 *  - 需先转向(needFrames=2)：本帧转向仍留在原格，下一帧才离开，故要求 incomingFrames>=3 才真正脱险
 *    （incomingFrames==2 时转向那帧子弹正好到达，会被命中——这正是过去"摇摆送死"的根因）。
 *  - 绝不选"顺着子弹飞行方向"的脱离格（顺向逃会被 2 格/帧的子弹追上，mat_DXZ 屁股后中弹）。
 * 若无来得及的脱离格，返回 null，交由紧急传送处理。
 */
function findBulletDodge(me, enemy, game, enemyPos) {
  const myPos = me.tank.position;
  const bullets = collectEnemyBullets(enemy);
  if (bullets.length === 0) return null;

  // 没有任何子弹威胁到我，就不躲
  if (!anyBulletThreatens(bullets, myPos, game)) return null;

  // 最快多少帧子弹会命中我当前格（含双弹推断），后续时序判断依赖这个窗口
  const incomingFrames = minBulletFramesTo(bullets, myPos, game);
  if (incomingFrames < 0) return null;

  // 威胁我的那些子弹的飞行方向集合（用于排除"顺向逃"的死路方向）
  const threatDirs = {};
  for (let i = 0; i < bullets.length; i++) {
    if (bulletThreatens(bullets[i], myPos, game)) threatDirs[bullets[i].direction] = true;
  }

  // 四个相邻格都作为候选（移开任意弹道即可），逐一评估安全与可达性
  let best = null;
  let bestScore = -9999;
  for (let i = 0; i < DIRS.length; i++) {
    const d = DIRS[i];
    const p = [myPos[0] + d.dx, myPos[1] + d.dy];
    if (!isPassable(game, p, enemyPos)) continue;
    // 落点必须脱离所有子弹弹道
    if (anyBulletThreatens(bullets, p, game)) continue;
    // 落点不能正好撞进敌人能立刻开火的炮口
    if (enemyAimsAt(p, enemy && enemy.tank, game)) continue;
    // 不能顺着来袭子弹方向走（同向只会被追上，且这一步本就还在弹道行/列上）
    if (threatDirs[d.name]) continue;

    const needTurn = d.name !== me.tank.direction;
    // 时序校验：
    // 1. 如果不用转向直接能走，1帧脱离。前面已经校验过 p 目前不在弹道上，所以直接通过。
    if (!needTurn) {
      if (incomingFrames < 1) continue;
      // boost 态: go() 实际走2格到 p2, p2 也必须安全(否则让 boost-through-dodge 处理)
      if (me.status && me.status.boosted) {
        var p2 = [myPos[0] + d.dx * 2, myPos[1] + d.dy * 2];
        if (isPassable(game, p2, enemyPos) &&
            (anyBulletThreatens(bullets, p2, game) ||
             stepIntoBulletPath(bullets, p2, game) ||
             enemyAimsAt(p2, enemy && enemy.tank, game))) continue;
      }
    } else {
      // 时序：转 N 次 + 走 1 步 = N+1 帧脱离。平手时仍尝试（引擎先移动再判碰撞）
      var turns = turnDistance(me.tank.direction, d.name);
      if (incomingFrames < turns + 1) continue;
      
      // 预演子弹再飞 1 帧（模拟完成转身，即将进行 go 的那个帧）
      // 必须保证那帧里，目标格子 p 不会被子弹扫过或占领
      const bulletsNext = advanceBullets(bullets, BULLET_SPEED);
      if (stepIntoBulletPath(bulletsNext, p, game) || anyBulletThreatens(bulletsNext, p, game)) {
        continue;
      }
    }

    // 打分：当前朝向就能走 > 逃生开口数 > 远离边缘 > 靠近星星
    // 死胡同重罚：开口<=1 时后续无法横移脱困，连续躲避会越走越深进墙角
    const facing = needTurn ? 0 : 100;
    const openExits = openNeighborCount(p, game);
    const deadEndPenalty = openExits <= 1 ? -150 : 0;
    // 对射优化：躲弹后仍能直射敌人 → 立刻还手，不丢制枪机会。+30 让"能还手的侧方格"优先于"更宽裕但丢射线的方向"。
    const counterBonus = enemyPos && clearShotDirection(p, enemyPos, game) ? 30 : 0;
    const score = facing + openExits * 8 + deadEndPenalty + distanceFromEdges(p, game) + counterBonus + (game.star ? -manhattan(p, game.star) * 0.1 : 0);
    if (score > bestScore) {
      bestScore = score;
      best = p;
    }
  }
  return best;
}


/**
 * boost 穿弹闪避：已处于加速状态 + 当前格有子弹威胁时，
 * 利用 boost 2格跳跃（中间格不碰撞）穿过子弹到安全终点。
 * 返回 { dir, target, turns } 或 null。
 */
function findBoostThroughDodge(me, enemyBullets, game, enemyPos, enemyTank) {
  if (!(me.status && me.status.boosted)) return null;
  var myPos = me.tank.position;
  var myDir = me.tank.direction;
  if (!anyBulletThreatens(enemyBullets, myPos, game)) return null;

  var best = null, bestScore = -9999;
  for (var i = 0; i < DIRS.length; i++) {
    var d = DIRS[i];
    var dir = d.name;
    var p1 = [myPos[0] + d.dx, myPos[1] + d.dy];
    var p2 = [myPos[0] + d.dx * 2, myPos[1] + d.dy * 2];
    if (!isPassable(game, p1, enemyPos)) continue;
    if (!isPassable(game, p2, enemyPos)) continue;
    if (stepIntoBulletPath(enemyBullets, p2, game)) continue;
    if (anyBulletThreatens(enemyBullets, p2, game)) continue;
    var turns = turnDistance(myDir, dir);
    if (turns > 1) continue;

    var score = 0;
    if (turns === 0) score += 50;
    if (enemyPos && clearShotDirection(p2, enemyPos, game)) score += 80;
    if (game.star) score += (manhattan(myPos, game.star) - manhattan(p2, game.star)) * 2;
    score += distanceFromEdges(p2, game) * 2;
    score += openNeighborCount(p2, game) * 5;

    if (score > bestScore) { bestScore = score; best = { dir: dir, target: p2, turns: turns }; }
  }
  return best;
}


/**
 * 时序躲避存在性判定：从 myPos(车头 myDir) 面对给定子弹集，是否存在"来得及"脱离的相邻格。
 * 完全复用 findBulletDodge 的时序铁律（朝向即脱离 incoming>=1；需转向 incoming>=3 才不会在转向帧被命中），
 * 但只返回布尔值，供"先射后走"在开火预演后复用——子弹集为推进过的快照即可。
 * 子弹集已含过载配对弹(collectEnemyBullets 推断)，因此多子弹/双弹一并纳入时序校验。
 */
function hasTimedDodge(myPos, myDir, bullets, game, enemyPos, enemyTank) {
  const list = bullets || [];
  if (!anyBulletThreatens(list, myPos, game)) return true; // 当前格本就不被任何子弹威胁
  const incoming = minBulletFramesTo(list, myPos, game);
  if (incoming < 0) return true;

  // 威胁我的子弹飞行方向集合：排除"顺向逃"（2格/帧必被追上）
  const threatDirs = {};
  for (let i = 0; i < list.length; i++) {
    if (bulletThreatens(list[i], myPos, game)) threatDirs[list[i].direction] = true;
  }

  for (let i = 0; i < DIRS.length; i++) {
    const d = DIRS[i];
    const p = [myPos[0] + d.dx, myPos[1] + d.dy];
    if (!isPassable(game, p, enemyPos)) continue;
    if (enemyAimsAt(p, enemyTank, game)) continue;        // 落点不能正撞敌炮口
    if (threatDirs[d.name]) continue;                     // 不顺着来袭子弹方向逃

    // 如果不用转向直接能走，1帧脱离，前提是落点也是安全的
    if (d.name === myDir) {
      if (!anyBulletThreatens(list, p, game)) return true;
      continue;
    }
    
    // 如果需要转向，移动需要 2 帧（第 1 帧转身，第 2 帧离开）。
    // 【致命漏洞修复】：由于第 1 帧（转身帧）仍停留在当前格子 myPos，
    // 我们必须保证预演的这批 bullets（此时正处于转身帧开始时刻）不会在这一帧内命中 myPos！
    if (incoming < 3) continue; // 子弹距离不足3帧，转身帧/移动帧会被追上
    
    // 预演子弹再飞 1 帧（模拟完成转身，即将进行 go 的那个帧）
    const bulletsNext = advanceBullets(list, BULLET_SPEED);
    if (!stepIntoBulletPath(bulletsNext, p, game) && !anyBulletThreatens(bulletsNext, p, game)) {
      return true;
    }
  }
  return false;
}


/**
 * 绝境横移：被子弹威胁、findBulletDodge 与传送都救不了时的兜底。
 * 在垂直于来袭子弹方向的两个相邻格里挑一个可走、且本身不在弹道上的，朝它移动（哪怕需转向）。
 * 目的：绝不顺着子弹方向直线逃（必被 2 格/帧子弹追上），横向挣一步仍有活命机会。
 */
function findDesperateDodge(me, enemyBullets, game, enemyPos, enemyTank) {
  const myPos = me.tank.position;
  const bullets = enemyBullets || [];
  if (!anyBulletThreatens(bullets, myPos, game)) return null;

  // 收集威胁子弹的飞行方向（顺/逆向都不选，只走垂直方向）
  const blockedAxis = {};
  for (let i = 0; i < bullets.length; i++) {
    if (!bulletThreatens(bullets[i], myPos, game)) continue;
    const dir = bullets[i].direction;
    if (dir === "up" || dir === "down") blockedAxis.vertical = true;
    else blockedAxis.horizontal = true;
  }

  let best = null;
  let bestScore = -9999;
  for (let i = 0; i < DIRS.length; i++) {
    const d = DIRS[i];
    // 子弹竖直来 -> 只走水平(left/right)；水平来 -> 只走竖直(up/down)
    const isVerticalMove = d.name === "up" || d.name === "down";
    if (blockedAxis.vertical && isVerticalMove) continue;
    if (blockedAxis.horizontal && !isVerticalMove) continue;

    const p = [myPos[0] + d.dx, myPos[1] + d.dy];
    if (!isPassable(game, p, enemyPos)) continue;
    if (anyBulletThreatens(bullets, p, game)) continue; // 脱离格不能也在弹道上
    // 偏好当前朝向(本帧即走)、其次远离边缘
    const facing = d.name === me.tank.direction ? 100 : 0;
    const score = facing + distanceFromEdges(p, game);
    if (score > bestScore) {
      bestScore = score;
      best = p;
    }
  }
  return best;
}


/**
 * 两步脱困：单步无安全格（findBulletDodge=null）时的备用逃生。
 * 适用于双弹平行夹击（如 mat_FXI：x=16/x=17 两列都有子弹朝 up，右侧是墙）。
 *
 * 策略：在相邻格中找一个"虽然当前被某子弹威胁、但该子弹还有 ≥3 帧才到、
 * 且从该格出发下一帧能找到真正安全的纵向脱离格"的方向走过去。
 * 优先选远离边界（避免被逼到墙角）、且威胁子弹最远的方向。
 */
function findTwoStepEscape(me, enemyBullets, game, enemyPos, enemyTank) {
  const myPos = me.tank.position;
  const bullets = enemyBullets || [];
  if (!anyBulletThreatens(bullets, myPos, game)) return null;

  let best = null;
  let bestScore = -9999;
  for (let i = 0; i < DIRS.length; i++) {
    const d = DIRS[i];
    const p = [myPos[0] + d.dx, myPos[1] + d.dy];
    if (!isPassable(game, p, enemyPos)) continue;
    if (enemyAimsAt(p, enemyTank, game)) continue;
    // 不走顺着威胁子弹方向的格（顺向必被追上）
    let isAlongThreat = false;
    for (let j = 0; j < bullets.length; j++) {
      if (bulletThreatens(bullets[j], myPos, game) && bullets[j].direction === d.name) {
        isAlongThreat = true; break;
      }
    }
    if (isAlongThreat) continue;

    // 到达 p 所需帧：当前朝向=1(直接 go)，否则 turnDistance+1(先转再走)
    const arriveFrames = (d.name === me.tank.direction) ? 1 : (turnDistance(me.tank.direction, d.name) + 1);
    // 该格被子弹威胁：必须在我到达之后才命中（留出落脚帧），否则走过去就被打
    const framesAtP = minBulletFramesTo(bullets, p, game);
    if (framesAtP >= 0 && framesAtP <= arriveFrames) continue;

    // 二步模型关键：从 p 再迈一步能脱离所有弹道，且时间上能抢在威胁命中前完成
    let nextEscapeOk = false;
    for (let k = 0; k < DIRS.length; k++) {
      const q = [p[0] + DIRS[k].dx, p[1] + DIRS[k].dy];
      if (!isPassable(game, q, enemyPos)) continue;
      if (anyBulletThreatens(bullets, q, game)) continue;
      if (enemyAimsAt(q, enemyTank, game)) continue;
      nextEscapeOk = true; break;
    }
    if (!nextEscapeOk) continue;

    // 打分：远离边界（避免被逼墙角）+ 威胁子弹越远越好 + 到位越快越好
    const edgeScore = distanceFromEdges(p, game);
    const threatDist = framesAtP >= 0 ? framesAtP : 99;
    const score = edgeScore * 3 + threatDist - arriveFrames * 2;
    if (score > bestScore) { bestScore = score; best = p; }
  }
  return best;
}


/**
 * 对射"先射后走"判定：在子弹来袭、findBulletDodge 已确认本帧有躲位的前提下，
 * 若满足以下条件，则先回敬一炮再躲（下一帧子弹更近但仍可躲）：
 *  - 炮管就绪、敌人未开盾、我与敌人同线且视线无遮挡、车头已对准敌人（开火不耗转向帧）；
 *  - 来袭子弹至少 2 帧后才命中我当前格（开火占本帧，留下一帧躲避）；
 *  - 开火后下一帧子弹推进 BULLET_SPEED 格，我仍能找到脱离弹道的相邻格。
 * 化纯被动逃跑为压制对射（见 mat_DtH4：全程只躲不还手被压死）。
 */
/**
 * 反击"先手干净击杀"判定：来袭子弹下，即使开火后自己躲不掉，但只要这一炮能**先于**敌方任何威胁
 * 命中并打死敌人，敌坦克 crash 后其在途子弹威胁随之解除——此时先射就是"不必死还反杀"，
 * 不该怂着躲（落实用户"不必死就先打面前的敌人"第一优先级）。
 *
 * 严格三约束（缺一不可，宁可不打也不送命/锁死平局）：
 *  1. 我严格先手命中：myHit < enemyHit。其中 myHit = 开火占本帧后子弹飞行帧 = ceil(dist/2)；
 *     enemyHit = 来袭子弹命中我当前格的最快帧(minBulletFramesTo，已含过载配对弹)。严格小于才算
 *     "敌中弹时尚未轮到它的弹打到我"。相等=同归于尽，单独按约束3处理。
 *  2. 护盾流敌人盾就绪(正开盾 或 cd=0 可即时格挡)时，这一炮会被盾吃掉，不构成击杀 -> 不放行。
 *  3. 同归于尽(myHit === enemyHit)只在**星星严格领先**时才换命：星平=运行时长判负=必输(我方代码一贯更慢)，
 *     同归把翻盘机会也清零，比被单方打死更糟，绝不换命；严格领先时同归=我赢，可换命锁胜。
 */
function counterShootKillsCleanly(me, enemy, enemyTank, enemyBullets, game, enemyPos) {
  if (!enemyTank || !enemyPos) return false;
  if (!canShoot(me, enemy)) return false;
  const shotDir = clearShotDirection(me.tank.position, enemyPos, game);
  if (!shotDir || shotDir !== me.tank.direction) return false;

  // 约束2：护盾流敌盾就绪 -> 这一炮被吃，不算击杀
  const shieldUp = enemy && enemy.status && enemy.status.shielded;
  const shieldReady = enemyHasShieldSkill(enemy) &&
    enemy.skill && (enemy.skill.remainingCooldownFrames || 0) === 0;
  if (shieldUp || shieldReady) return false;

  const bullets = enemyBullets || [];
  const enemyHit = minBulletFramesTo(bullets, me.tank.position, game);
  if (enemyHit < 0) return false; // 没有来袭弹会命中我 -> 不归本函数（交常规流程）
  const dist = manhattan(me.tank.position, enemyPos);
  const myHit = Math.ceil(dist / BULLET_SPEED); // 开火占本帧，子弹飞行 ceil(dist/2) 帧命中敌

  // 约束1：严格先手 -> 敌中弹时其弹还没打到我，先射反杀
  if (myHit < enemyHit) return true;
  // 约束3：同归于尽，仅星星严格领先时换命锁胜；星平/落后必不换命
  if (myHit === enemyHit) {
    const myStars = (me && me.stars) || 0;
    const enmStars = (enemy && enemy.stars) || 0;
    return myStars > enmStars;
  }
  return false;
}


function shouldCounterShootThenDodge(me, enemy, enemyTank, enemyBullets, game, enemyPos) {
  if (!enemyTank || !enemyPos) return false;
  if (!canShoot(me, enemy)) return false; // 炮管就绪 + 敌未开盾
  // 必须车头已对准敌人（开火不耗转向帧），否则先躲
  const shotDir = clearShotDirection(me.tank.position, enemyPos, game);
  if (!shotDir || shotDir !== me.tank.direction) return false;

  // 先手干净击杀：哪怕开火后自己躲不掉，只要这一炮先反杀敌人(且不锁死平局/不被盾吃)，就先射。
  if (counterShootKillsCleanly(me, enemy, enemyTank, enemyBullets, game, enemyPos)) return true;

  const bullets = enemyBullets || [];
  const incoming = minBulletFramesTo(bullets, me.tank.position, game);
  if (incoming < 2) return false; // 子弹 0~1 帧即到，开火占掉本帧必来不及躲，老实躲

  // 时序验算（用户要求）：开火占掉当前帧、子弹随之推进 1 帧(BULLET_SPEED 格)，剩下的就是一个
  // 全新的"躲子弹"问题。我必朝敌(沿弹道轴)，脱离只能垂直=必先转向一帧再移动，所以唯有
  // "转向帧+移动帧 < 子弹(含双弹)命中帧"时才躲得掉。直接复用 hasTimedDodge 的时序铁律
  // (需转向要求剩余 incoming>=3，等价于开火前 incoming>=4)对**推进后的全部子弹**(已含过载配对弹)
  // 做存在性校验：开火后仍存在来得及的躲位才值得先射，否则白送一发又躲不掉(见用户复盘)。
  const advanced = advanceBullets(bullets, BULLET_SPEED);
  return hasTimedDodge(me.tank.position, me.tank.direction, advanced, game, enemyPos, enemyTank);
}


function findOverloadLaneDodge(me, enemy, enemyTank, game, enemyPos) {
  if (!me || !me.tank || !me.tank.position || !enemyTank) return null;
  if (!enemyDoubleLaneThreat(enemy)) return null;
  if (!enemyCanFireSoon(enemy)) return null;

  const myPos = me.tank.position;
  // 用 ±1 全覆盖检测：敌不确定打哪侧，两侧都视为危险
  const predictedAll = predictedOverloadBulletsAll(enemyTank);
  if (!anyBulletThreatens(predictedAll, myPos, game)) return null;

  const incomingFrames = minBulletFramesTo(predictedAll, myPos, game);
  if (incomingFrames < 0) return null;

  function scoreCell(p, needTurn) {
    const exits = openNeighborCount(p, game);
    const deadEndPenalty = exits <= 1 ? -150 : 0;
    return (needTurn ? 0 : 100) + exits * 8 + distanceFromEdges(p, game) * 3 + deadEndPenalty +
      (game.star ? -manhattan(p, game.star) * 0.1 : 0);
  }

  // 一步逃脱
  let best = null;
  let bestScore = -9999;
  for (let i = 0; i < DIRS.length; i++) {
    const d = DIRS[i];
    const p = [myPos[0] + d.dx, myPos[1] + d.dy];
    if (!isPassable(game, p, enemyPos)) continue;
    if (enemyAimsAt(p, enemyTank, game)) continue;
    if (anyBulletThreatens(predictedAll, p, game)) continue;
    if (stepIntoBulletPath(predictedAll, p, game)) continue;

    const needTurn = d.name !== me.tank.direction;
    if (!needTurn) {
      if (incomingFrames < 1) continue;
    } else {
      if (incomingFrames < 3) continue;
      const predictedNext = advanceBullets(predictedAll, BULLET_SPEED);
      if (stepIntoBulletPath(predictedNext, p, game) || anyBulletThreatens(predictedNext, p, game)) continue;
    }

    const s = scoreCell(p, needTurn);
    if (s > bestScore) { bestScore = s; best = p; }
  }
  if (best) return best;

  // ±1 两侧都被封时（我在双弹带中央），做两步 BFS 找更远脱离格
  if (incomingFrames < 2) return null; // 来不及了
  for (let i = 0; i < DIRS.length; i++) {
    const d1 = DIRS[i];
    const p1 = [myPos[0] + d1.dx, myPos[1] + d1.dy];
    if (!isPassable(game, p1, enemyPos)) continue;
    // p1 也必须不在预测弹道上，否则经过 p1 时会被实际双弹扫到
    if (anyBulletThreatens(predictedAll, p1, game)) continue;
    for (let j = 0; j < DIRS.length; j++) {
      const d2 = DIRS[j];
      const p2 = [p1[0] + d2.dx, p1[1] + d2.dy];
      if (!isPassable(game, p2, enemyPos)) continue;
      if (anyBulletThreatens(predictedAll, p2, game)) continue;
      if (stepIntoBulletPath(predictedAll, p2, game)) continue;
      const s = scoreCell(p2, true);
      if (s > bestScore) { bestScore = s; best = p2; }
    }
  }
  return best;
}


/**
 * 防范敌方预瞄/预发射/守星：若敌人正瞄准我且本帧具备开火能力，提前移动脱离其炮线。
 *
 * 改进点：
 *  - 只在敌方"真能开火"（炮管就绪、未被开火锁定）时才躲，避免对着不能开火的敌人空走。
 *  - 不再只试前方一格：四向择优选一个能脱离敌方炮线、且不撞进现有子弹弹道的格子。
 *  - 隐身敌人(enemyTank=null)交由其他逻辑处理，这里只针对可见敌人的预瞄。
 *  - 抢星豁免：当敌人只是"预瞄"(尚无实弹在途)而我正贴近一颗我更有希望抢到的星时，
 *    不为一次未必命中的瞄准而中断抢星——否则会反复原地转向，把星拱手让人(见 mat_DuPt4ff7Ivt9Hy6Rf)。
 */
function findAimDodge(me, enemy, enemyTank, enemyBullets, game, enemyPos) {
  if (!enemyTank) return null;
  if (enemy && enemy.status && enemy.status.stunned) return null;
  var isDirectAim = enemyAimsAt(me.tank.position, enemyTank, game);
  if (!isDirectAim && !enemyBoostFlickThreat(me.tank.position, enemy, enemyTank, game)) return null;
  // 隐身豁免：草丛中敌人看不见我，炮口朝向不是真正的瞄准，无需空躲。
  // 但以下情况不豁免：overload 激活 / 敌人近距（≤3格贴脸即使隐身也危险）
  // 近距反豁免的例外：枪就绪 + 有射击线 → 草丛先手优势，应射击而非出草逃跑
  const enemyOverloadActive = enemy && enemy.status && enemy.status.overloaded;
  const tooClose = enemyPos && manhattan(me.tank.position, enemyPos) <= 3;
  if (iAmHidden(me, game) && !enemyOverloadActive && !(enemy && enemy.bullet && enemy.bullet.position)) {
    if (!tooClose) return null;
    if (gunReady(me) && clearShotDirection(me.tank.position, enemyPos, game)) return null;
  }
  // 敌人本帧无法开火（已有在途子弹且未过载，或被开火锁定）则预瞄无威胁，不必空躲
  // 注：boost flick 分支已在上面的 enemyBoostFlickThreat 中做了 enemyCanFireSoon 检查
  if (isDirectAim && !enemyCanFireSoon(enemy)) return null;
  // 抢星竞速豁免：敌人只是预瞄、没有实弹在途时，若这颗星我更可能先到，则继续抢星不空躲
  if (shouldContestStarOverAim(me, enemy, enemyTank, enemyBullets, game)) return null;
  // 对射豁免：我也能瞄到敌人、无实弹在途、且对射不慢于敌人(myDuel<=enemyDuel) -> 不在此空躲。
  // 交给下方"近距对射规避"统一裁决：能及时侧移就侧移，来不及就开火换血，避免站着转身送死。
  if (canShoot(me, enemy) && !(enemy && enemy.bullet && enemy.bullet.position)) {
    const myShotDir = clearShotDirection(me.tank.position, enemyPos, game);
    if (myShotDir) {
      const dist = manhattan(me.tank.position, enemyPos);
      const myDuel = turnDistance(me.tank.direction, myShotDir) + Math.ceil(dist / BULLET_SPEED);
      const dirToMe = clearShotDirection(enemyPos, me.tank.position, game);
      const enemyDuel = (dirToMe ? turnDistance(enemyTank.direction, dirToMe) : 1) + Math.ceil(dist / BULLET_SPEED);
      if (myDuel <= enemyDuel) return null;
    }
  }

  const myPos = me.tank.position;
  // 敌最快命中我当前格所需帧：过载双弹/普通单弹都按"敌转向对准 + 子弹飞行(2格/帧)"估。
  // 用于给"需转向才能到达的侧格"做时序闸门——转身那帧我还停在原格，必须保证敌弹此刻打不到。
  const dist = manhattan(myPos, enemyPos);
  const dirToMe = clearShotDirection(enemyPos, myPos, game);
  const enemyHitFrames = (dirToMe ? turnDistance(enemyTank.direction, dirToMe) : 1) + Math.ceil(dist / BULLET_SPEED);

  let best = null;
  let bestScore = -9999;
  for (let i = 0; i < DIRS.length; i++) {
    const d = DIRS[i];
    const p = [myPos[0] + d.dx, myPos[1] + d.dy];
    if (!isPassable(game, p, enemyPos)) continue;
    if (enemyAimsAt(p, enemyTank, game)) continue; // 必须脱离炮线
    if (enemyBoostFlickThreat(p, enemy, enemyTank, game)) continue; // 脱离甩狙线
    if (anyBulletThreatens(enemyBullets || [], p, game)) continue; // 别躲进现有弹道
    if (predictedOverloadThreatens(enemy, p, game)) continue;      // 别躲进过载双弹覆盖带

    const needTurn = d.name !== me.tank.direction;
    // 时序铁律：当前朝向即脱离方向 -> 1 帧 go 离线，最快。
    // 需转向：实际转向帧 = turnDistance(当前, 目标方向)，共需 turns+1 帧(含最后走步)。
    // 反向(如 DOWN→UP, turns=2)需 3 帧，旧代码误算为 2 帧导致以为能逃实则来不及。
    const turns = needTurn ? turnDistance(me.tank.direction, d.name) : 0;
    const escapeFrames = turns === 0 ? 1 : turns + 1;
    if (needTurn && escapeFrames > enemyHitFrames) continue;

    // 偏好当前朝向就能直接走的格子（1 帧脱离，最快）
    const facing = needTurn ? 0 : 100;
    // 加强星星引力：躲弹时若某方向能更快接近星星，优先选（原 0.1 太弱，改为 3，使星星 1 格内相当于 facing 同向）
    const starPull = game.star ? Math.max(0, 6 - manhattan(p, game.star)) * 3 : 0;
    const score = facing + distanceFromEdges(p, game) + starPull;
    if (score > bestScore) {
      bestScore = score;
      best = p;
    }
  }
  return best;
}


/**
 * 抢星是否应优先于防瞄：仅当
 *  - 场上有星，且我离星很近（路径 <= 接近射程）；
 *  - 敌人没有实弹在途（仅预瞄，下帧才可能开火，威胁是概率性的）；
 *  - 我到星的路径距离不比敌人远（我更可能先吃到）。
 * 满足时返回 true，表示宁可吃这一发概率性瞄准也要把星抢下。
 */
function shouldContestStarOverAim(me, enemy, enemyTank, enemyBullets, game) {
  if (!game.star) return false;
  // 敌人已有实弹在途 -> 是真威胁，不豁免（交由子弹躲避/这里继续躲）
  if (enemy && enemy.bullet && enemy.bullet.position) return false;
  // 过载就绪/已过载：威胁高，通常不豁免。
  // 特例：星极近(≤2步)且星所在格不在敌方炮线上——此时"抓星"= "脱线"，两件事合一，应当豁免。
  if (enemyDoubleLaneThreat(enemy)) {
    const myToStar = pathDistance(me.tank.position, game.star, game, enemyTank.position);
    if (myToStar >= 0 && myToStar <= 2 && !enemyAimsAt(game.star, enemyTank, game)) {
      return true; // 抓星格不在炮线，抓星同时完成闪避，不阻止
    }
    return false;
  }

  const myPos = me.tank.position;
  const enemyPos = enemyTank.position;
  const myToStar = pathDistance(myPos, game.star, game, enemyPos);
  if (myToStar < 0 || myToStar > 7) return false; // 星在7步内才值得冒险抢（原先4步过于保守，导致长期缩角落）

  const enemyToStar = pathDistance(enemyPos, game.star, game, myPos);
  // 我不比敌人远即抢（敌人不可达也抢）
  return enemyToStar < 0 || myToStar <= enemyToStar;
}


/**
 * 近距对射规避：敌人与我同行/同列、距离近、且能开火时，权衡"转身对射"谁先命中。
 * 若我不占先手（敌人不晚于我命中），就不要站着转身送死，改为侧移离开这条致命直线。
 *
 * 时间线（子弹 2 格/帧，转向占 1 帧）：
 *  - 我命中敌人帧 = 我转向到对准方向的帧 + ceil(dist/2)
 *  - 敌人命中我帧 = 敌转向到对准方向的帧 + ceil(dist/2)
 *  仅当我严格更快(myDuel < enemyDuel)时才值得对射，否则侧移脱线。
 *  侧移优先当前朝向就能直接前进的方向，避免转向耗帧再次被逼住。
 */
function findLineDuelDodge(me, enemy, enemyTank, enemyBullets, game, enemyPos) {
  if (!enemyTank || !enemyPos) return null;
  if (enemy && enemy.status && enemy.status.stunned) return null;
  // 隐身豁免：草丛中敌人看不见我，同线威胁不成立，无需规避。
  // 但以下情况不豁免：overload 激活 / 敌人近距（≤3格贴脸即使隐身也危险）
  // 近距反豁免的例外：枪就绪 + 有射击线 → 草丛先手优势，应射击而非出草逃跑
  const enemyOverloadActive = enemy && enemy.status && enemy.status.overloaded;
  const tooClose = enemyPos && manhattan(me.tank.position, enemyPos) <= 3;
  if (iAmHidden(me, game) && !enemyOverloadActive && !(enemy && enemy.bullet && enemy.bullet.position)) {
    if (!tooClose) return null;
    if (gunReady(me) && clearShotDirection(me.tank.position, enemyPos, game)) return null;
  }
  if (!enemyCanFireSoon(enemy)) return null; // 敌人开不了火，无近距威胁
  // M3: overload 冷却中且场上无己弹 = 空窗期，炮管实际是空的，不算"能立刻开火"的近距威胁，
  // 允许回敬（mat_Lwm4：对方双弹耗尽后我仍一路侧移躲避，最后被单发打死）。
  if (enemyIsOverloadType(enemy) &&
      !(enemy.status && enemy.status.overloaded) &&
      (enemy.skill && typeof enemy.skill.remainingCooldownFrames === "number" && enemy.skill.remainingCooldownFrames > 0) &&
      !(enemy.bullet && enemy.bullet.position)) return null;

  const myPos = me.tank.position;
  // 必须同线且视线无遮挡
  const dirToEnemy = clearShotDirection(myPos, enemyPos, game);
  if (!dirToEnemy) return null;
  const dist = manhattan(myPos, enemyPos);
  // 只处理"近距"危险区：5 格内对射几乎无容错（子弹<=3帧到）
  if (dist > 5) return null;

  // 对射先手比较（转向帧 + 子弹飞行帧）
  const myDuel = turnDistance(me.tank.direction, dirToEnemy) + Math.ceil(dist / BULLET_SPEED);
  const dirToMe = clearShotDirection(enemyPos, myPos, game);
  const enemyTurn = dirToMe ? turnDistance(enemyTank.direction, dirToMe) : 1;
  const enemyDuel = enemyTurn + Math.ceil(dist / BULLET_SPEED);
  const shieldDuelSafe = canShootThenEvadeShieldCounter(me, enemy, enemyTank, enemyBullets, game, enemyPos);

  // 普通敌人：我严格更快命中 -> 对射占优，不躲，交给后续开火分支
  // shield 流敌人：先手快也不代表能赚，因为这一发常被护盾吃掉；只有打完仍能脱线才值得对枪。
  if (!enemyHasShieldSkill(enemy) && myDuel < enemyDuel) return null;
  if (enemyHasShieldSkill(enemy) && myDuel <= enemyDuel && shieldDuelSafe) return null;

  // 以守为攻：敌人此刻并未瞄准我（炮口不朝我，无实弹在途），且我对射不慢于它(myDuel<=enemyDuel) ->
  // 不必侧移逃避，交给开火/守线分支先手压制（敌没瞄我时侧移只是浪费先手，见 mat_AZpe 被压到墙角）。
  const enemyAimingMe = enemyAimsAt(myPos, enemyTank, game);
  const enemyHasBullet = enemy && enemy.bullet && enemy.bullet.position;
  if (!enemyHasShieldSkill(enemy) && !enemyAimingMe && !enemyHasBullet && myDuel <= enemyDuel) return null;

  // 评估"侧移脱线"能否在敌方子弹到达前离开这条直线。
  // 侧移耗帧：当前朝向即侧向 -> 1 帧(直接 go 离格)；否则需先转向 -> 2 帧(转+走)。
  // 敌方最快命中我的帧 = enemyDuel（已含其转向）。
  // 只有当某个侧向脱离格"可走、不进别的弹道/炮线"，且脱离耗帧 < 敌命中帧 时，侧移才真正活命。
  const perp = (dirToEnemy === "up" || dirToEnemy === "down")
    ? [DIRS[dirIndex("left")], DIRS[dirIndex("right")]]
    : [DIRS[dirIndex("up")], DIRS[dirIndex("down")]];
  let best = null;
  let bestScore = -9999;
  for (let i = 0; i < perp.length; i++) {
    const d = perp[i];
    const p = [myPos[0] + d.dx, myPos[1] + d.dy];
    if (!isPassable(game, p, enemyPos)) continue;
    if (anyBulletThreatens(enemyBullets || [], p, game)) continue; // 别躲进现有弹道
    if (enemyAimsAt(p, enemyTank, game)) continue;                 // 也别进另一条炮线
    const turns2 = turnDistance(me.tank.direction, d.name);
    const escapeFrames = turns2 === 0 ? 1 : turns2 + 1;
    // 能否在中弹前离线：朝向即侧向可本帧直接 go 离线(必活)；需转向则要求敌命中更晚。
    // 修正：原 needTurn?2:1 对反向(turns=2)低估1帧，导致坦克来不及脱线时仍尝试转向。
    const safe = escapeFrames === 1 || escapeFrames < enemyDuel;
    if (!safe) continue;
    // 偏好当前朝向就能直接走的方向（1 帧脱离），其次保持反击角度，再次远离边缘
    const facing = d.name === me.tank.direction ? 100 : 0;
    // 侧移后仍能直射敌人(如侧方恰好同行/列)→ 保留反击机会，不白跑
    const counterLine = clearShotDirection(p, enemyPos, game) ? 15 : 0;
    // 优先留在草丛中（不暴露自己）
    const stayHidden = (tileAt(game, myPos) === 'o' && tileAt(game, p) === 'o') ? 30 : 0;
    const score = facing + counterLine + stayHidden + manhattan(p, enemyPos) + distanceFromEdges(p, game) * 0.5;
    if (score > bestScore) {
      bestScore = score;
      best = p;
    }
  }
  // best 为 null 表示无法及时脱线：交回开火分支去对射/换血，至少不是站着挨打
  return best;
}


/**
 * 以守为攻：敌人近距(<=3)正逼近、即将进入我的同行/同列枪线时，提前把炮口对准那条线（守株待兔）。
 * 返回 { fire:true } 表示本帧开火；{ dir } 表示先转向对准；null 表示不触发。
 *
 * 触发条件（守，所以保守）：
 *  - 炮管就绪、敌人未开盾；
 *  - 没有实弹正威胁我（实弹来袭由上方躲避逻辑优先处理，此处只在安全时主动备战）；
 *  - 敌人曼哈顿距离 <= 3；
 *  - 敌人已在我同行或同列（视线无遮挡）——这是它即将/已经能打我、我也能打它的线。
 * 行为：在该线上且已对准 -> 开火（先手）；在该线上未对准 -> 转向对准；
 *      尚未同线但近在 <=3 -> 朝敌人所在的更近轴向预先转炮口。
 */
/**
 * 敌炮管空窗期反击：检测到敌方子弹已在场（炮管空了）且方向不威胁我时，主动进攻。
 *
 * 逻辑：
 * - 敌方场上有子弹(enemy.bullet)，说明炮管已空，短期内无法再开火
 * - 这发子弹方向不朝我（不是打我的，我安全）
 * - 我与敌方同行/同列视线清晰、炮管就绪、无实弹威胁我
 * - 则返回应该转向/开火的方向
 *
 * 不触发的情况：
 * - 子弹方向朝我（这发子弹在打我，交给躲避逻辑）
 * - 过载流敌人握双弹时（虽然场上有一发，可能还有第二发）
 * - shield 流敌人（开盾会吃掉我这发，不值得）
 */
function findEnemyBulletOpenShot(me, enemy, enemyTank, enemyBullets, game, enemyPos) {
  if (!enemyTank || !enemyPos) return null;
  if (!canShoot(me, enemy)) return null;
  const eb = enemy && enemy.bullet;
  const hasBulletInFlight = eb && eb.position;
  // 空窗期判定：
  //   A) 场上有敌弹但不朝我（朝我的交给躲避逻辑）
  //   B) overload 技能冷却中且场上无子弹（双弹耗尽，炮管实际为空）
  const overloadCooling = enemyIsOverloadType(enemy) &&
    !(enemy.status && enemy.status.overloaded) &&
    (enemy.skill && typeof enemy.skill.remainingCooldownFrames === 'number' && enemy.skill.remainingCooldownFrames > 0) &&
    !hasBulletInFlight;
  if (!hasBulletInFlight && !overloadCooling) return null;
  if (hasBulletInFlight) {
    const bulletThreatensMe = bulletThreatens(eb, me.tank.position, game);
    if (bulletThreatensMe) return null;
  }
  // 过载流握双弹时不进：场上有弹且过载激活，可能还有第二发
  if (enemyDoubleLaneThreat(enemy)) return null;
  // shield 流不进（开盾吃掉我这发）
  if (enemyHasShieldSkill(enemy)) return null;
  // 无实弹威胁我
  if (anyBulletThreatens(enemyBullets || [], me.tank.position, game)) return null;
  // 同行/同列视线清晰
  const shotDir = clearShotDirection(me.tank.position, enemyPos, game);
  if (!shotDir) return null;
  // 距离合理（太远的不值得浪费一炮）
  const d = manhattan(me.tank.position, enemyPos);
  if (d > 10) return null;
  return shotDir;
}



function canPreemptiveShot(myPos, myDir, enemyTank, game) {
  if (!enemyTank) return null;
  const d = { up:[0,-1], down:[0,1], left:[-1,0], right:[1,0] }[enemyTank.direction];
  if (!d) return null;
  // 2帧预判：检查敌人沿当前方向走1~2步后是否进入我的射线
  for (var step = 1; step <= 2; step++) {
    var epNext = [enemyTank.position[0] + d[0] * step, enemyTank.position[1] + d[1] * step];
    if (!isPassable(game, epNext, null)) break;
    var shotDir = clearShotDirection(myPos, epNext, game);
    if (!shotDir) continue;
    // 子弹到达帧 = 转向帧 + 飞行帧；敌到达帧 = step帧（每帧走1格）
    var turnFrames = turnDistance(myDir, shotDir);
    var bulletDist = manhattan(myPos, epNext);
    var bulletArrival = turnFrames + Math.ceil(bulletDist / BULLET_SPEED);
    var enemyArrival = step;
    // 子弹准时或提前1帧到达（提前1帧子弹在交叉点等敌人=有效命中）
    if (bulletArrival <= enemyArrival && bulletArrival >= enemyArrival - 1) return shotDir;
  }
  return null;
}


function canAmbushLeadShot(myPos, myDir, enemyTank, game) {
  if (!enemyTank) return null;
  var ePos = enemyTank.position;
  var eDir = enemyTank.direction;
  var d = { up:[0,-1], down:[0,1], left:[-1,0], right:[1,0] }[eDir];
  if (!d) return null;

  var shotDir = null;
  var bulletDist = 0;
  var enemySteps = 0;

  if (d[1] !== 0 && ePos[0] !== myPos[0]) {
    var rowDiff = myPos[1] - ePos[1];
    if ((d[1] > 0 && rowDiff > 0) || (d[1] < 0 && rowDiff < 0)) {
      enemySteps = Math.abs(rowDiff);
      var colDiff = ePos[0] - myPos[0];
      bulletDist = Math.abs(colDiff);
      shotDir = colDiff > 0 ? 'right' : 'left';
    }
  } else if (d[0] !== 0 && ePos[1] !== myPos[1]) {
    var colDiff2 = myPos[0] - ePos[0];
    if ((d[0] > 0 && colDiff2 > 0) || (d[0] < 0 && colDiff2 < 0)) {
      enemySteps = Math.abs(colDiff2);
      var rowDiff2 = ePos[1] - myPos[1];
      bulletDist = Math.abs(rowDiff2);
      shotDir = rowDiff2 > 0 ? 'down' : 'up';
    }
  }

  if (!shotDir || bulletDist === 0 || enemySteps === 0) return null;
  if (bulletDist > 7 || enemySteps > 7) return null;

  // 子弹到达交叉点的帧数：子弹每帧走2格，fire frame 内就开始移动
  // 距离D的格子在 fire + floor((D-1)/2) 帧被经过
  var turnFrames = turnDistance(myDir, shotDir);
  var bulletArrival = turnFrames + Math.floor((bulletDist - 1) / BULLET_SPEED);
  // 敌人到达交叉点的帧数：每帧走1格，fire frame 内也移动
  var enemyArrival = enemySteps - 1;

  if (bulletArrival !== enemyArrival) return null;

  var intersection = (d[1] !== 0)
    ? [ePos[0], myPos[1]]
    : [myPos[0], ePos[1]];
  if (!clearBetween(myPos, intersection, game)) return null;

  var checkPos = ePos.slice();
  for (var i = 0; i < enemySteps; i++) {
    checkPos = [checkPos[0] + d[0], checkPos[1] + d[1]];
    var t = tileAt(game, checkPos);
    if (t === 'x' || t === 'm') return null;
  }

  return shotDir;
}

/**
 * 伏击远距预瞄：敌人当前方向走 3~6 步后将穿过我的某条射线。
 * 不要求弹道时间精确对齐（那是 canPreemptiveShot 的职责），
 * 只负责提前转向到正确方向，保证敌人进入 1~2 步开火区时炮口已对准。
 * 额外考虑敌人朝星方向拐弯的情况（预判交叉点）。
 * 返回应预瞄的方向 或 null。
 */
function canAmbushPreAim(myPos, myDir, enemyTank, star, game) {
  if (!enemyTank) return null;
  var ePos = enemyTank.position;
  var eDir = enemyTank.direction;
  var d = { up:[0,-1], down:[0,1], left:[-1,0], right:[1,0] }[eDir];
  if (!d) return null;

  // A) 沿敌当前方向 3~6 步，找第一条穿越我射线的方向
  for (var step = 3; step <= 6; step++) {
    var epNext = [ePos[0] + d[0] * step, ePos[1] + d[1] * step];
    if (!isPassable(game, epNext, null)) break;
    var shotDir = clearShotDirection(myPos, epNext, game);
    if (shotDir) return shotDir;
  }

  // B) 敌人→星路径预判：如果敌人不在星同线，会拐弯追星，
  //    预判敌人走到与我同行/同列时的交叉格
  if (star) {
    // 横向交叉：敌走到与我同行(y相同)的点
    if (ePos[1] !== myPos[1]) {
      var crossX = [ePos[0], myPos[1]];
      var stepsToRow = Math.abs(ePos[1] - myPos[1]);
      // 敌当前方向是否朝这一行走
      var headingToRow = (d[1] > 0 && myPos[1] > ePos[1]) || (d[1] < 0 && myPos[1] < ePos[1]);
      if (headingToRow && stepsToRow >= 3 && stepsToRow <= 8 &&
          isPassable(game, crossX, null)) {
        var xDir = clearShotDirection(myPos, crossX, game);
        if (xDir) return xDir;
      }
    }
    // 纵向交叉：敌走到与我同列(x相同)的点
    if (ePos[0] !== myPos[0]) {
      var crossY = [myPos[0], ePos[1]];
      var stepsToCol = Math.abs(ePos[0] - myPos[0]);
      var headingToCol = (d[0] > 0 && myPos[0] > ePos[0]) || (d[0] < 0 && myPos[0] < ePos[0]);
      if (headingToCol && stepsToCol >= 3 && stepsToCol <= 8 &&
          isPassable(game, crossY, null)) {
        var yDir = clearShotDirection(myPos, crossY, game);
        if (yDir) return yDir;
      }
    }
  }
  return null;
}


/**
 * 沿连通草丛 BFS，找 1~3 步内对星有射线的更优伏击位置。
 * 要求路径全是草丛(不暴露)，且目标格对星有清晰射线。
 * 返回 { dest, step, shotDir } 或 null。
 */
function findBetterAmbushBush(myPos, star, game, enemyBullets) {
  if (!star) return null;
  // 当前位置已有射线，不需要挪
  if (clearShotDirection(myPos, star, game)) return null;

  var queue = [{ pos: myPos, step: null, dist: 0 }];
  var seen = {}; seen[key(myPos)] = true;
  var best = null, bestScore = -9999;

  for (var qi = 0; qi < queue.length; qi++) {
    var cur = queue[qi];
    if (cur.dist >= 3) continue;

    for (var i = 0; i < DIRS.length; i++) {
      var np = [cur.pos[0] + DIRS[i].dx, cur.pos[1] + DIRS[i].dy];
      var nk = key(np);
      if (seen[nk]) continue;
      seen[nk] = true;
      if (tileAt(game, np) !== 'o') continue; // 只走草丛，不暴露
      if (anyBulletThreatens(enemyBullets || [], np, game)) continue;

      var firstStep = cur.step || np;
      var newDist = cur.dist + 1;

      var sDir = clearShotDirection(np, star, game);
      if (sDir) {
        // 离星近 + 步数少 = 更优
        var score = 100 - newDist * 15 - manhattan(np, star) * 3 +
                    distanceFromEdges(np, game) * 2;
        if (score > bestScore) {
          bestScore = score;
          best = { dest: np, step: firstStep, shotDir: sDir };
        }
      }
      queue.push({ pos: np, step: firstStep, dist: newDist });
    }
  }
  return best;
}


function findGuardLineShot(me, enemy, enemyTank, enemyBullets, game, enemyPos, state) {
  if (!enemyTank || !enemyPos) return null;
  // 有星可追时不浪费帧做守线预瞄——但如果敌人正朝星走且将穿过我的射线，仍允许拦截
  if (game.star) {
    var myStarDist = pathDistance(me.tank.position, game.star, game, enemyPos);
    if (myStarDist >= 0 && myStarDist <= 8) {
      // 豁免：敌人正走向星且其路径将穿过我的炮线（拦截价值高于自己去追）
      var enemyHeadingToStar = false;
      if (enemyTank.direction) {
        var ed = { up:[0,-1], down:[0,1], left:[-1,0], right:[1,0] }[enemyTank.direction];
        if (ed) {
          var dirToStar = directionBetween(enemyPos, game.star);
          if (dirToStar === enemyTank.direction) enemyHeadingToStar = true;
        }
      }
      if (!enemyHeadingToStar) return null;
    }
  }
  if (!canShoot(me, enemy)) return null;                 // 炮管就绪 + 敌未开盾
  // 双弹门控统一用 enemyDoubleLaneThreat(握弹才怂)，与主开火分支”没双弹就刚”一致：
  // overload 流但 CD 充裕(手里没双弹)时，同线开火与未同线预转都照常——只在真握弹(已过载/cd<=1)时全关。
  const shieldEnemy = enemyHasShieldSkill(enemy);
  if (anyBulletThreatens(enemyBullets || [], me.tank.position, game)) return null; // 有实弹来袭 -> 让躲避先处理

  const myPos = me.tank.position;
  const dist = manhattan(myPos, enemyPos);

  // 拦截射击（优先）：敌在移动且将穿过我射线 — 距离放宽到 9 格，抓住穿线窗口
  var enemyIsMoving = !state || !state.enemyStationaryFrames || state.enemyStationaryFrames < 2;
  if (enemyIsMoving && !enemyDoubleLaneThreat(enemy) && !enemyIsOverloadType(enemy) && dist <= 9) {
    const preDir = canPreemptiveShot(myPos, me.tank.direction, enemyTank, game);
    if (preDir) return me.tank.direction === preDir ? { fire: true } : { dir: preDir };
    // 精确提前量拦截（子弹与敌同时到达交叉点）
    const leadDir = canAmbushLeadShot(myPos, me.tank.direction, enemyTank, game);
    if (leadDir) return me.tank.direction === leadDir ? { fire: true } : { dir: leadDir };
  }

  // 距离门控：拉到 safeStandoffDistance（overload 流=5）才不备战——在安全环带就开始预瞄转炮口，
  // 不必贴到 4 格才守线（mat_2Bc fired=0：守线距离门只有4，整局没机会预瞄）。握双弹时同样按 standoff 退。
  const guardDist = safeStandoffDistance(enemy);
  if (dist > guardDist) return null;
  // 已在同行/同列且视线清晰：能打就打/对准
  const lineDir = clearShotDirection(myPos, enemyPos, game);
  if (lineDir) {
    // 双弹流（已过载/握双弹）：默认一发换双弹必亏，不主动对枪。
    // 但"预瞄转炮口"本身不发弹、不会同归——握双弹时若我尚未对准，仍先转过去对准，
    // 占住先手姿态(mat_7YQEUd 复盘：因双弹门控连转炮口都不做，被压墙角破墙自曝)。
    // 已对准时只放行"严格先手干净击杀"(敌先倒，双弹来不及发出)：
    //   - 敌短期开不了火(enemyCanFireSoon=false)：纯赚一炮；
    //   - 或我命中帧 < 敌命中帧(myHit<enemyHit)：敌先倒。
    // 同归(myHit===enemyHit)即使我领先也不放行——双弹同归换命风险远高于普通对枪，不靠它锁胜；
    // 劣势更不打。让位后续走位/躲避拉开距离。
    const doubleLane = (enemy.status && enemy.status.overloaded) || enemyDoubleLaneThreat(enemy);
    if (doubleLane) {
      if (me.tank.direction !== lineDir) return { dir: lineDir }; // 转炮口预瞄，不发弹
      if (!enemyCanFireSoon(enemy)) return { fire: true };       // 敌开不了火，纯赚
      const dist = manhattan(myPos, enemyPos);
      const myHit = Math.ceil(dist / BULLET_SPEED);              // 已对准，转向0
      const dirToMe = clearShotDirection(enemyPos, myPos, game);
      const enemyHit = (dirToMe ? turnDistance(enemyTank.direction, dirToMe) : 1) + Math.ceil(dist / BULLET_SPEED);
      if (myHit < enemyHit) return { fire: true };               // 严格先手，敌先倒
      return null; // 同归/劣势：不对枪换命，让位走位/躲避
    }
    if (shieldEnemy && !canShootThenEvadeShieldCounter(me, enemy, enemyTank, enemyBullets, game, enemyPos)) return null;
    if (me.tank.direction === lineDir) return { fire: true };
    return { dir: lineDir };
  }

  // 尚未同线——预转风险更高（主动凑进覆盖带）
  // 已过载或握双弹(cd<=1)时关闭；overload 流但 CD 充裕(手里没双弹)允许预转压制，与主开火“没双弹就刚”一致。
  if (enemy.status && enemy.status.overloaded) return null;
  if (enemyDoubleLaneThreat(enemy)) return null;
  // shield 流敌人不做近距守线预转，避免主动把自己摆进无收益对枪。
  if (shieldEnemy) return null;

  // 敌人很近(<=3)，预判它将从哪条轴进入我的枪线，提前转炮口对准那个轴向。
  // 方向锁定：选定预瞄方向后锁住 N 帧不切换，防止 |dx|≈|dy| 时逐帧翻转抖动。
  var GUARD_PREAIM_LOCK = 3;
  var curFrame = game.frame || 0;
  if (state && state.guardPreAimDir && state.guardPreAimFrame != null &&
      curFrame - state.guardPreAimFrame <= GUARD_PREAIM_LOCK) {
    if (me.tank.direction !== state.guardPreAimDir) return { dir: state.guardPreAimDir };
    return null;
  }

  const dx = enemyPos[0] - myPos[0];
  const dy = enemyPos[1] - myPos[1];
  var preAimDir;
  if (Math.abs(dx) < Math.abs(dy)) {
    preAimDir = dy < 0 ? 'up' : 'down';
  } else if (Math.abs(dx) > Math.abs(dy)) {
    preAimDir = dx < 0 ? 'left' : 'right';
  } else {
    // |dx|===|dy|：优先沿用上次方向，消除边界抖动
    if (state && state.guardPreAimDir) {
      preAimDir = state.guardPreAimDir;
    } else {
      preAimDir = dy < 0 ? 'up' : 'down';
    }
  }
  // 校验预瞄方向至少有3格无墙走廊，否则子弹出膛即撞墙浪费(mat_J8lxX83O)
  var paDelta = { up:[0,-1], down:[0,1], left:[-1,0], right:[1,0] }[preAimDir];
  if (paDelta) {
    var paBlocked = false;
    for (var paStep = 1; paStep <= 3; paStep++) {
      var paCell = [myPos[0] + paDelta[0] * paStep, myPos[1] + paDelta[1] * paStep];
      var paTile = tileAt(game, paCell);
      if (paTile === 'x' || paTile === 'm') { paBlocked = true; break; }
    }
    if (paBlocked) return null;
  }

  if (state) {
    state.guardPreAimDir = preAimDir;
    state.guardPreAimFrame = curFrame;
  }
  if (me.tank.direction !== preAimDir) return { dir: preAimDir };
  return null;
}


/**
 * 草丛/隐身攻防（mat_1dAV / mat_0BKrG 复盘：走进隐身敌人的同行近距被冒出的子弹秒杀）。
 * 返回 { fire:true } 本帧开火 / { dir } 先转向对准 / null 不触发。炮管就绪、非过载、无实弹来袭时才考虑。
 *
 *  A) 防伏击预射：敌人此刻不可见（藏草丛 或 用 cloak 技能隐身），其最后已知位置与我同行/同列、
 *     距离<=3、视线清晰 -> 朝那条线预先开一炮（打草惊蛇/压制），对准了就开火，没对准先转。
 *     注：草丛蹲坑与 cloak 隐身本质相同（enemy.tank=null 看不见也看不见其子弹），统一处理。
 *  B) 草丛伏击：我正处在草丛中(隐身)、敌人可见、与我同行/同列、距离<=3 -> 主动开火（我占信息优势）。
 */
function findBushLineShot(me, enemy, enemyTank, enemyBullets, game, enemyPos, state) {
  if (!canShoot(me, enemy)) return null;
  if (enemy && enemy.status && enemy.status.overloaded) return null; // 过载太险，交躲避
  const myPos = me.tank.position;
  if (anyBulletThreatens(enemyBullets || [], myPos, game)) return null;

  // B) 草丛伏击：我在草丛、敌可见近距 -> 已在同线则开火；未同线则预判拦截
  const iAmInBush = me.status && me.status.cloaked || tileAt(game, myPos) === "o";
  if (iAmInBush && enemyTank && enemyPos && manhattan(myPos, enemyPos) <= 5) {
    // 敌当前已在炮线上
    const dir = clearShotDirection(myPos, enemyPos, game);
    if (dir) return me.tank.direction === dir ? { fire: true } : { dir: dir };
    // 2帧预判：敌沿当前方向走1~2步后与我同线
    const preDir = canPreemptiveShot(myPos, me.tank.direction, enemyTank, game);
    if (preDir) return me.tank.direction === preDir ? { fire: true } : { dir: preDir };
    // 远距精确拦截：计算子弹与敌人同时到达交叉点的提前量射击
    const leadDir = canAmbushLeadShot(myPos, me.tank.direction, enemyTank, game);
    if (leadDir) return me.tank.direction === leadDir ? { fire: true } : { dir: leadDir };
  }

  // A) 防伏击预射：敌不可见(草丛或cloak隐身)、最后位置与我同线、近距、视线清晰 -> 朝该线预射
  if (!enemyTank && state && state.lastEnemyPos) {
    const ePos = state.lastEnemyPos;
    const enemyHidden = tileAt(game, ePos) === "o" || (enemy && enemy.skill && enemy.skill.type === "cloak");
    if (enemyHidden &&
        ((game.frames || 0) - state.lastEnemySeenFrame) <= 6 &&  // 信息还新鲜
        manhattan(myPos, ePos) <= 3) {                           // 近距才值得预射
      const dir = clearShotDirection(myPos, ePos, game);         // 同行/同列且无遮挡
      if (dir) return me.tank.direction === dir ? { fire: true } : { dir: dir };
    }
  }
  return null;
}


/**
 * 隐身炮口预射（mat_C3Rd）：敌 cloak 刚消失、最后位置在我炮口前方或可能一步切入我的同行/同列时，
 * 主动朝当前炮口/预测伏击线打一发。它比普通草丛预射更宽：不要求 lastEnemyPos 已经与我同线，
 * 而是用 hiddenCloakPositions 预测 1~4 帧内的可达格，找近距离、无遮挡的射击线。
 */
function findCloakPreFireShot(me, enemy, enemyTank, enemyBullets, game, state) {
  if (!canShoot(me, enemy)) return null;
  if (enemyTank) return null; // 敌可见时交给直射/守线
  if (!enemyIsCloakType(enemy)) return null;
  if (!state || !state.lastEnemyPos) return null;
  const age = ((game && game.frames) || 0) - state.lastEnemySeenFrame;
  if (age < 0 || age > 4) return null;

  const myPos = me.tank.position;
  if (anyBulletThreatens(enemyBullets || [], myPos, game)) return null;

  const positions = hiddenCloakPositions(enemy, enemyTank, game, state);
  if (positions.length === 0) positions.push(state.lastEnemyPos);

  const lastDir = state.lastEnemyDir || null;
  const dxDir = { right: 1, left: -1, up: 0, down: 0 };
  const dyDir = { right: 0, left: 0, up: -1, down: 1 };

  let bestDir = null;
  let bestScore = -9999;
  for (let i = 0; i < positions.length; i++) {
    const p = positions[i];
    if (samePos(p, myPos)) continue;
    const dir = clearShotDirection(myPos, p, game);
    if (!dir) continue;
    const dist = manhattan(myPos, p);
    if (dist > 5) continue;

    // 方向偏好：沿敌最后朝向的位置更可能是实际位置
    let dirBias = 0;
    if (lastDir) {
      const dpx = p[0] - state.lastEnemyPos[0];
      const dpy = p[1] - state.lastEnemyPos[1];
      const dotProduct = dpx * dxDir[lastDir] + dpy * dyDir[lastDir];
      dirBias = dotProduct > 0 ? dotProduct * 15 : dotProduct * 5;
    }
    const facingBonus = dir === me.tank.direction ? 60 : 0;
    const lastBias = manhattan(p, state.lastEnemyPos) <= 1 ? 12 : 0;
    const score = dirBias + facingBonus + lastBias - dist * 5 - age * 4;
    if (score > bestScore) {
      bestScore = score;
      bestDir = dir;
    }
  }

  if (!bestDir) return null;
  return me.tank.direction === bestDir ? { fire: true, dir: bestDir } : { dir: bestDir };
}


function findBombDodge(myPos, bombs, game, enemyPos, enemyBullets, frame) {
  if (!bombs || bombs.length === 0) return null;
  let threatened = false;
  for (let i = 0; i < bombs.length; i++) {
    const bPos = bombs[i].position || bombs[i];
    if (inBombBlast(myPos, bPos, game) && bombTimeLeft(bombs[i], frame) <= 4) {
      threatened = true; break;
    }
  }
  if (!threatened) return null;
  let best = null, bestScore = -9999;
  for (let i = 0; i < DIRS.length; i++) {
    const p = [myPos[0] + DIRS[i].dx, myPos[1] + DIRS[i].dy];
    if (!isPassable(game, p, enemyPos)) continue;
    let safe = true;
    for (let j = 0; j < bombs.length; j++) {
      const bPos = bombs[j].position || bombs[j];
      if (inBombBlast(p, bPos, game) && bombTimeLeft(bombs[j], frame) <= 5) { safe = false; break; }
    }
    if (!safe) continue;
    if (anyBulletThreatens(enemyBullets || [], p, game)) continue;
    const score = (enemyPos ? manhattan(p, enemyPos) : 0) + (p[1] !== myPos[1] ? 1 : 0);
    if (score > bestScore) { bestScore = score; best = p; }
  }
  return best;
}


function findRetreatBomb(me, enemy, enemyTank, game, state, frame) {
  if (!bombReady(me)) return null;
  if (!enemyTank || !enemyTank.position) return null;
  const myPos = me.tank.position;
  const enemyPos = enemyTank.position;
  const dist = manhattan(myPos, enemyPos);
  if (dist > 3 || dist < 1) return null;
  const dirToMe = clearShotDirection(enemyPos, myPos, game);
  if (!dirToMe) return null;
  const enemyApproaching = enemyTank.direction === dirToMe;
  if (!enemyApproaching) return null;
  if (!canEscapeAfterBomb(myPos, me.tank.direction, game, enemyPos, [], state, frame)) return null;
  return { type: 'retreat' };
}


function findStarBomb(me, enemy, enemyTank, game, state, frame) {
  if (!bombReady(me)) return null;
  if (!game.star || !enemyTank || !enemyTank.position) return null;
  const myPos = me.tank.position;
  const starDist = manhattan(myPos, game.star);
  if (starDist > 2) return null;
  const enemyStarDist = manhattan(enemyTank.position, game.star);
  if (enemyStarDist > 5 || enemyStarDist <= starDist) return null;
  if (inBombBlast(game.star, myPos, game)) return null;
  if (!canEscapeAfterBomb(myPos, me.tank.direction, game, enemyTank.position, [], state, frame)) return null;
  return { type: 'star' };
}


function findBushBomb(me, enemy, enemyTank, game, state, frame) {
  if (!bombReady(me)) return null;
  if (!enemyTank || !enemyTank.position) return null;
  const myPos = me.tank.position;
  if (!iAmHidden(me, game)) return null;
  const dist = manhattan(myPos, enemyTank.position);
  if (dist > 5 || dist < 2) return null;
  const dirToMe = clearShotDirection(enemyTank.position, myPos, game);
  if (!dirToMe) return null;
  const enemyApproaching = enemyTank.direction === dirToMe;
  if (!enemyApproaching) return null;
  if (!canEscapeAfterBomb(myPos, me.tank.direction, game, enemyTank.position, [], state, frame)) return null;
  return { type: 'bush' };
}


function findChokeBomb(me, enemy, enemyTank, game, state, frame) {
  if (!bombReady(me)) return null;
  if (!game.star || !enemyTank || !enemyTank.position) return null;
  var myPos = me.tank.position;
  var enemyPos = enemyTank.position;
  var dist = manhattan(myPos, enemyPos);
  if (dist < 4 || dist > 10) return null;
  if (openNeighborCount(myPos, game) > 2) return null;
  if (inBombBlast(game.star, myPos, game)) return null;
  if (!canEscapeAfterBomb(myPos, me.tank.direction, game, enemyPos, [], state, frame)) return null;
  var baselineDist = pathDistance(enemyPos, game.star, game, null);
  if (baselineDist < 0 || baselineDist > 14) return null;
  var blastTiles = getBombBlastTiles(myPos, game);
  var detourDist = pathDistanceBlockSet(enemyPos, game.star, game, blastTiles);
  var gain = (detourDist < 0) ? 99 : (detourDist - baselineDist);
  if (gain < 4) return null;
  return { type: 'choke', gain: gain };
}


function findPostGrabBomb(me, enemy, enemyTank, game, state, frame) {
  if (!bombReady(me)) return null;
  if (game.star) return null;
  var myPos = me.tank.position;
  var enemyPos = enemyTank ? enemyTank.position : (state.lastEnemyPos || null);
  if (!enemyPos) return null;
  if (manhattan(myPos, enemyPos) > 6) return null;
  if (!canEscapeAfterBomb(myPos, me.tank.direction, game, enemyPos, [], state, frame)) return null;
  return { type: 'grab' };
}


function findStarBushAmbush(me, enemy, enemyTank, enemyBullets, game, state) {
  if (!teleportReady(me) || !game.star) return null;
  var frame = game.frames || 0;
  if (state && state.ambushCooldown && frame - state.ambushCooldown < 20) return null;
  var myPos = me.tank.position;
  var enemyPos = enemyTank ? enemyTank.position : null;
  // 已在草丛且有射线则不需要传送
  if (iAmHidden(me, game) && clearShotDirection(myPos, game.star, game)) return null;

  var w = game.map.length, h = game.map[0].length;
  var star = game.star;
  var enemyHasTp = enemyHasTeleport(enemy);
  var best = null, bestScore = -9999;

  for (var x = 0; x < w; x++) {
    for (var y = 0; y < h; y++) {
      if (game.map[x][y] !== "o") continue;
      var c = [x, y];
      if (samePos(c, myPos)) continue;
      var distToStar = manhattan(c, star);
      // 传送敌：蹲星附近(2-5)；非传送敌：可蹲必经路线(2-8)
      var maxDist = enemyHasTp ? 5 : 8;
      if (distToStar < 2 || distToStar > maxDist) continue;
      if (!isTeleportSafe(c, enemyTank, enemyBullets, game, 0, enemy)) continue;
      // 必须有至少一条清晰射线（任意方向）
      var shotToStar = clearShotDirection(c, star, game);
      var hasAnyLine = !!shotToStar;
      if (!hasAnyLine) {
        for (var di = 0; di < DIRS.length; di++) {
          var dp = DIRS[di];
          var probe = [c[0] + dp.dx, c[1] + dp.dy];
          if (isPassable(game, probe, null) && clearShotDirection(c, probe, game)) {
            hasAnyLine = true; break;
          }
        }
      }
      if (!hasAnyLine) continue;

      // 评分
      var score = 0;
      // Tier 1：直接对星有射线（最高价值）
      if (shotToStar) score += 100;
      // Tier 2：射线方向与敌→星路径交叉
      else if (enemyPos) {
        // 草丛是否在敌人走向星的 "中间通道" 上
        var enemyStarDx = star[0] - enemyPos[0];
        var enemyStarDy = star[1] - enemyPos[1];
        // 如果草丛 x 在 enemy.x 和 star.x 之间，或 y 在之间 → 必经通道
        var xBetween = (enemyStarDx > 0) ? (c[0] >= enemyPos[0] && c[0] <= star[0]) :
                       (enemyStarDx < 0) ? (c[0] <= enemyPos[0] && c[0] >= star[0]) : (c[0] === star[0]);
        var yBetween = (enemyStarDy > 0) ? (c[1] >= enemyPos[1] && c[1] <= star[1]) :
                       (enemyStarDy < 0) ? (c[1] <= enemyPos[1] && c[1] >= star[1]) : (c[1] === star[1]);
        if (xBetween || yBetween) score += 60;
        else score += 30;
      } else {
        score += 30;
      }
      // 距星近加分
      score += (maxDist + 1 - distToStar) * 15;
      // 远离敌人（避免传送被发现）
      if (enemyPos) score += Math.min(manhattan(c, enemyPos), 10) * 3;
      // 远离地图边缘
      score += distanceFromEdges(c, game) * 2;
      // 扣分：落点与星同行/列 → 敌方传送流蹲星对面时容易同线被扫草命中
      if (c[0] === star[0] || c[1] === star[1]) score -= 40;
      // 加分：有相邻草丛邻居且对星有射线（可供传送后偏移）
      var adjGrassCount = 0;
      for (var di2 = 0; di2 < DIRS.length; di2++) {
        var adj = [c[0] + DIRS[di2].dx, c[1] + DIRS[di2].dy];
        if (tileAt(game, adj) === 'o' && clearShotDirection(adj, star, game)) adjGrassCount++;
      }
      if (adjGrassCount > 0) score += 15 + adjGrassCount * 5;
      if (score > bestScore) { bestScore = score; best = c; }
    }
  }
  return best;
}


/**
 * 找到星附近适合冰冻伏击的草丛：
 * - 是草丛格('o')
 * - 到星有清晰射线（能覆盖星所在行/列）
 * - 离星 2-5 格（太近暴露风险大，太远射线被挡概率高）
 * - 离我当前位置可达且较近（优先选更近的草丛）
 * 返回最佳草丛坐标或 null。
 */
function findFreezeAmbushBush(myPos, star, game, enemyPos) {
  var best = null, bestScore = -9999;
  var w = game.map.length, h = game.map[0].length;
  for (var x = 0; x < w; x++) {
    for (var y = 0; y < h; y++) {
      if (tileAt(game, [x, y]) !== 'o') continue;
      var p = [x, y];
      var dStar = manhattan(p, star);
      if (dStar < 2 || dStar > 5) continue;
      if (!clearShotDirection(p, star, game)) continue;
      var dMe = manhattan(p, myPos);
      if (dMe > 8) continue;
      var score = 20 - dMe * 2 - dStar;
      if (enemyPos && clearShotDirection(p, enemyPos, game)) score += 5;
      if (score > bestScore) { bestScore = score; best = p; }
    }
  }
  return best;
}


function findPostTeleportShift(landingPos, star, game, enemyBullets) {
  var candidates = [];
  for (var i = 0; i < DIRS.length; i++) {
    var d = DIRS[i];
    var np = [landingPos[0] + d.dx, landingPos[1] + d.dy];
    if (tileAt(game, np) !== 'o') continue;
    if (!clearShotDirection(np, star, game)) continue;
    if (anyBulletThreatens(enemyBullets, np, game)) continue;
    candidates.push(np);
  }
  if (candidates.length === 0) return null;
  if (candidates.length === 1) return candidates[0];
  var dx = star[0] - landingPos[0];
  var dy = star[1] - landingPos[1];
  var mainAxis = Math.abs(dx) >= Math.abs(dy) ? 'x' : 'y';
  var best = candidates[0], bestDist = 0;
  for (var j = 0; j < candidates.length; j++) {
    var c = candidates[j];
    var dist = mainAxis === 'x'
      ? Math.abs(c[1] - landingPos[1])
      : Math.abs(c[0] - landingPos[0]);
    if (dist > bestDist) { bestDist = dist; best = c; }
  }
  return best;
}


/**
 * 伏击扫草：传送后敌人不可见时，逐方向朝星附近草丛开炮扫描。
 * 返回要射击的方向(dir string)，或 null（无目标/已全部扫完）。
 *
 * state.ambushScannedDirs: 已扫过的方向集合，由调用方维护。
 */
function findAmbushGrassScan(myPos, myDir, star, game, state) {
  if (!star || !game || !game.map) return null;
  var scanned = (state && state.ambushScannedDirs) || {};
  var allDirs = ['up', 'down', 'left', 'right'];
  var deltas = { up: [0, -1], down: [0, 1], left: [-1, 0], right: [1, 0] };

  // 收集每个方向的扫草价值
  var candidates = [];
  for (var di = 0; di < allDirs.length; di++) {
    var dir = allDirs[di];
    if (scanned[dir]) continue;
    var d = deltas[dir];
    // 沿射线方向找第一个草丛格
    var cx = myPos[0] + d[0], cy = myPos[1] + d[1];
    var hasGrass = false;
    var grassDist = 0;
    while (true) {
      var t = tileAt(game, [cx, cy]);
      if (t === 'x' || t === 'm') break;
      if (t === 'o') { hasGrass = true; grassDist = manhattan(myPos, [cx, cy]); break; }
      cx += d[0]; cy += d[1];
      if (manhattan(myPos, [cx, cy]) > 10) break;
    }
    if (!hasGrass) continue;
    var grassToStar = manhattan([cx, cy], star);
    var score = (10 - grassToStar) * 10 + (8 - grassDist) * 5;
    if (dir === myDir) score += 30;
    candidates.push({ dir: dir, score: score });
  }

  if (candidates.length === 0) return null;
  candidates.sort(function (a, b) { return b.score - a.score; });
  return candidates[0].dir;
}


function findStarContestPush(me, enemy, enemyTank, game, enemyBullets) {
  if (!game.star || !enemyTank) return null;
  var myPos = me.tank.position;
  var enemyPos = enemyTank.position;
  if (manhattan(myPos, game.star) > 6 || manhattan(enemyPos, game.star) > 6) return null;

  var hasWindow = false;

  var dirToStar = directionBetween(enemyPos, game.star);
  var dirToMe = clearShotDirection(enemyPos, myPos, game);
  // 空窗1: 敌人方向既不朝星也不朝我
  if (enemyTank.direction !== dirToStar &&
      (!dirToMe || enemyTank.direction !== dirToMe)) {
    hasWindow = true;
  }
  // 空窗2: 弹管空 + 不面朝我
  if (!enemyCanFireSoon(enemy) && (!dirToMe || dirToMe !== enemyTank.direction)) {
    hasWindow = true;
  }
  // 空窗3: 敌人正后撤（方向背对星）
  var opposites = { up: 'down', down: 'up', left: 'right', right: 'left' };
  if (dirToStar && enemyTank.direction === opposites[dirToStar]) {
    hasWindow = true;
  }

  if (!hasWindow) return null;

  var starPath = shortestPathInfo(myPos, game.star, game, enemyPos);
  if (!starPath || !starPath.step) return null;
  if (anyBulletThreatens(enemyBullets, starPath.step, game)) return null;
  if (stepIntoBulletPath(enemyBullets, starPath.step, game)) return null;

  return { step: starPath.step };
}


function findStarInterceptShot(me, enemy, enemyTank, game) {
  if (!game.star || !enemyTank) return null;
  if (!gunReady(me)) return null;
  var myPos = me.tank.position;
  var enemyPos = enemyTank.position;
  var star = game.star;

  var shotDir = clearShotDirection(myPos, star, game);
  if (!shotDir) return null;

  var enemyDirToStar = directionBetween(enemyPos, star);
  if (!enemyDirToStar || enemyTank.direction !== enemyDirToStar) return null;
  if (enemyPos[0] !== star[0] && enemyPos[1] !== star[1]) return null;
  var enemyDistToStar = manhattan(enemyPos, star);
  if (enemyDistToStar < 1 || enemyDistToStar > 4) return null;

  var myTurnFrames = turnDistance(me.tank.direction, shotDir);
  var bulletFrames = myTurnFrames + Math.ceil(manhattan(myPos, star) / BULLET_SPEED);
  var enemyArrival = enemyDistToStar;

  if (bulletFrames <= enemyArrival && bulletFrames >= enemyArrival - 1) {
    return { dir: shotDir, turnFrames: myTurnFrames };
  }
  return null;
}
