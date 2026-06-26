// ============================================================
// movement-engine.js — 走位策略层
//
// 走位单步策略函数：追星/巡逻/standoff/蹲草/逃离覆盖带等。
// 被 nodes-movement-v2.js 的 BT 节点直接调用。
// 依赖 core-utils.js + tactics.js。
// ============================================================


/**
 * 战术走位决策引擎。
 * 安全站位核心：根据敌方威胁动态决定与敌人的"最小安全间距"，避免走进会被秒的近身死区；
 * 隐身敌人按最后已知位置避让；逼近敌人时停在能开火又留有躲弹余地的距离。
 */
/**
 * 步伐安全守门：next 格不进死区且不踏入敌能封锁的死胡同。
 * 各分支的死区复检统一走这里，消除重复的 stepEntersKillZone + stepIntoSealedDeadEnd 调用。
 * allowStarDeadEnd：星就在死格里时仍允许进入（不因噎废食）。
 */
function isSafeStep(next, myPos, enemyPos, game, enemy, standoff, allowStarDeadEnd, enemyBullets, memory) {
  if (!next) return false;
  if (enemyPos && stepEntersKillZone(myPos, next, enemyPos, game, enemy, standoff)) return false;
  if (stepIntoSealedDeadEnd(next, enemyPos, game) && !allowStarDeadEnd) return false;
  // M1/M2: overload 流时，走进”横向出口<=1格且无法跨出双弹带”的窄兜也视为危险。
  // 副弹封相邻列时角落里横向根本跑不掉（mat_8xLQ/mat_Ae1A：[17,13]仅[16,13]一个出口被副弹封死）。
  if (enemyPos && enemyIsOverloadType(enemy) && !allowStarDeadEnd) {
    if (!hasDoubleLaneEscapeAt(next, enemyPos, game) && inDoubleLaneBand(enemyPos, next, standoff + 2)) return false;
  }
  // 还要排除下一帧会扫到的子弹轨道，避免”当前安全、下一拍吃弹”的假安全。
  if (enemyBullets && stepIntoBulletPath(enemyBullets, next, game)) return false;
  if (predictedOverloadThreatens(enemy, next, game)) return false;
  // 甩狙威胁：敌1帧转向即可射到 next 且子弹3帧内到达
  var et = (enemy && enemy.tank) || null;
  if (enemyPos && et && enemySnapFireThreat(next, enemy, et, game)) return false;
  // 预瞄死区(d=4)：可见敌已正对 next、枪就绪 -> 我一踏上同线当帧被射，子弹2帧到达，
  // 脱离要 turn+go=2帧且因敌已瞄准慢一拍 -> 必死(mat_0ApZZ: 传送敌蹲星行[16,13]预瞄左,
  // 我追星踏[12,13] d=4 被秒)。stepEntersKillZone 只覆盖 d<=3,enemySnapFireThreat 只管 turns=1,
  // 此处补 turns=0(已正对)的 d=4 盲区。仅拦"踏上敌预瞄火线"这一步,备选路径会从侧面绕近星。
  if (enemyPos && et && et.direction && enemyCanFireSoon(enemy) && !allowStarDeadEnd) {
    var preDir = clearShotDirection(enemyPos, next, game);
    if (preDir && preDir === et.direction) {
      var preDist = manhattan(next, enemyPos);
      if (preDist >= 2 && preDist <= 4) return false;
    }
  }
  // 隐身敌射线检查：敌不可见时避免走入其最后已知位置的射击线
  if (!enemyPos && memory && stepIntoHiddenEnemyFireLine(next, myPos, game, memory, allowStarDeadEnd)) return false;
  return true;
}


/**
 * 在四邻里挑一个"非被封锁死胡同"的安全开阔格走一步：优先开口多、离边远、不在敌炮线的格。
 * 用于巡逻/走位即将踏进墙角死路时改道（mat_2Wz）。
 */
function safestNonDeadEndStep(myPos, game, enemyPos, enemyBullets) {
  let best = null, bestScore = -9999;
  const bullets = enemyBullets || [];
  for (let i = 0; i < DIRS.length; i++) {
    const p = [myPos[0] + DIRS[i].dx, myPos[1] + DIRS[i].dy];
    if (!isPassable(game, p, enemyPos)) continue;
    if (stepIntoSealedDeadEnd(p, enemyPos, game)) continue; // 跳过会被封锁的死胡同
    if (stepIntoBulletPath(bullets, p, game)) continue;
    const sealed = enemyPos && clearShotDirection(enemyPos, p, game) ? -4 : 0; // 敌能直线打到的格降权
    const score = openNeighborCount(p, game) * 3 + distanceFromEdges(p, game) + sealed;
    if (score > bestScore) { bestScore = score; best = p; }
  }
  return best;
}


/**
 * 虚拟巡逻目标：无真星星时给坦克一个移动目标，避免原地空转挨打。
 * 目标"粘性"：一旦选定就持续走向它直到到达(或失效/逼近危险)，再换下一个，避免每帧重选导致来回横跳。
 * 选点：四象限中心的开阔格里，离我足够远(保证移动)、且远离隐身敌人最后已知位置。
 *
 * overload 流优化（mat_KxY8/mat_C5iE）：敌从对角逼近时，我会被推进同侧墙角来回震荡。
 * 对 overload 流，给"在敌方对侧象限"的锚点额外加分，驱动绕到敌人背面开阔地而非同侧徘徊。
 * 同时对"贴地图边缘(distanceFromEdges<=2)"的锚点降权，避免选进死角。
 */
function virtualPatrolTarget(me, game, state, enemy) {
  const myPos = me.tank.position;
  const danger = state && state.lastEnemyPos && ((game.frames || 0) - state.lastEnemySeenFrame <= 12)
    ? state.lastEnemyPos : null;
  const enemyPos = enemy && enemy.tank ? enemy.tank.position : null;

  // 已有粘性目标且仍有效(未到达、可通行、不贴危险点) -> 继续用，保持稳定航向
  if (state && state.patrolTarget) {
    const t = state.patrolTarget;
    const reached = manhattan(myPos, t) <= 1;
    const nearDanger = danger && manhattan(t, danger) <= 2;
    if (!reached && isPassable(game, t, null) && !nearDanger) return t;
    state.patrolTarget = null; // 失效，重选
  }

  const w = game.map.length, h = game.map[0].length;
  const cx = Math.floor(w / 2), cy = Math.floor(h / 2);
  const ax = [Math.floor(w / 4), Math.floor(w * 3 / 4)];
  const ay = [Math.floor(h / 4), Math.floor(h * 3 / 4)];
  const anchors = [];
  for (let i = 0; i < ax.length; i++) for (let j = 0; j < ay.length; j++) {
    const o = nearestOpenTo(game, [ax[i], ay[j]]);
    if (o) anchors.push(o);
  }
  // 被动跑分型 teleport 敌：把地图中心也作为候选锚点——守中心十字区离任何方向新刷的星都近(mat_GwxblYdS)。
  const passiveRusher = enemyIsPassiveRusher(enemy, enemy && enemy.tank, game, myPos);
  if (passiveRusher) {
    const center = nearestOpenTo(game, [cx, cy]);
    if (center) anchors.push(center);
  }
  if (anchors.length === 0) return null;

  const isOverload = enemyIsOverloadType(enemy);

  let best = null, bestScore = -9999;
  for (let i = 0; i < anchors.length; i++) {
    const p = anchors[i];
    const distMe = manhattan(p, myPos);
    if (distMe < 4) continue; // 太近的不作为目标(到了就停=空转)
    const dangerScore = danger ? manhattan(p, danger) * 2 : 0;
    const edgeD = distanceFromEdges(p, game);
    // overload 流：贴边锚点降权(-8)；对侧象限加分(+6)，驱动绕到敌人背面
    let overloadBonus = 0;
    if (isOverload && enemyPos) {
      if (edgeD <= 1) overloadBonus -= 8; // 贴最外墙降权，内圈锚点不受影响
      // 对侧象限：x 方向对侧 + y 方向对侧各 +3
      const oppX = (enemyPos[0] > cx) ? p[0] < cx : p[0] > cx;
      const oppY = (enemyPos[1] > cy) ? p[1] < cy : p[1] > cy;
      if (oppX) overloadBonus += 3;
      if (oppY) overloadBonus += 3;
    }
    // 被动跑分敌：不靠"远离敌"拉开(它不主动打)，改为偏好靠近中心十字区(抢下一颗星更快)。
    // 抵消 dangerScore 的远离驱动，并按离中心距离加分(越居中越高)。
    let rusherBonus = 0;
    if (passiveRusher) {
      const centerD = Math.abs(p[0] - cx) + Math.abs(p[1] - cy);
      rusherBonus = Math.max(0, 8 - centerD) * 2; // 居中 +16，外圈逐渐归零
      if (edgeD <= 1) rusherBonus -= 6;            // 仍不选贴墙死角
    }
    // 通用居中偏移：无星等待期偏向中心，缩短下颗星的起步距离
    let centerBonus = 0;
    if (!passiveRusher && !isOverload) {
      const centerD = Math.abs(p[0] - cx) + Math.abs(p[1] - cy);
      centerBonus = Math.max(0, 6 - centerD); // 居中 +6，外圈递减
    }
    const dangerWeight = passiveRusher ? 0 : 1;     // 被动跑分敌不为"远离它"巡逻
    const score = dangerScore * dangerWeight + distMe + edgeD + overloadBonus + rusherBonus + centerBonus;
    if (score > bestScore) { bestScore = score; best = p; }
  }
  if (best && state) state.patrolTarget = best; // 记住，保持航向
  return best;
}


/**
 * 找最接近目标坐标 target 的可通行开阔格(空地/草丛)。
 */
function nearestOpenTo(game, target) {
  let best = null, bestD = 9999;
  for (let x = 0; x < game.map.length; x++) {
    for (let y = 0; y < game.map[x].length; y++) {
      if (!isPassable(game, [x, y], null)) continue;
      const d = Math.abs(x - target[0]) + Math.abs(y - target[1]);
      if (d < bestD) { bestD = d; best = [x, y]; }
    }
  }
  return best;
}


/**
 * 奔草丛躲双弹：面对 overload 双弹流、无星可安全抢的空窗期，走向最近的"安全草丛"蹲守，
 * 让敌方脚本失去我的位置(enemy.tank=null)——双弹无从瞄准；保留传送等星刷新再闪现抢分(用户策略)。
 * 安全草丛要求：可站、不在敌近距死区(stepEntersKillZone)、不落在握弹敌的双弹覆盖带里。
 * 返回朝最近安全草丛的下一步；找不到(或我已在草丛里)返回 null，交上层巡逻/兜底。
 * 仅对 overload 流敌人触发，避免对普通敌防过头。
 */
function nextStepToSafeBush(me, enemy, game, enemyPos, standoff, enemyBullets) {
  const myPos = me.tank.position;
  const bullets = enemyBullets || [];
  if (tileAt(game, myPos) === "o") return null; // 已在草丛，不必再找
  let bestBush = null, bestD = 9999;
  for (let x = 0; x < game.map.length; x++) {
    for (let y = 0; y < game.map[x].length; y++) {
      if (tileAt(game, [x, y]) !== "o") continue;          // 只找草丛格
      const c = [x, y];
      if (!isPassable(game, c, enemyPos)) continue;
      if (samePos(c, myPos)) continue;
      // 草丛本身不能在敌握弹双弹带/近距死区(躲进去反被秒，mat_EHR 落点不安全的教训)
      if (enemyPos && stepEntersKillZone(myPos, c, enemyPos, game, enemy, standoff)) continue;
      if (enemyPos && enemyDoubleLaneThreat(enemy) && inDoubleLaneBand(enemyPos, c, standoff)) continue;
      if (stepIntoBulletPath(bullets, c, game)) continue;
      const d = pathDistance(myPos, c, game, enemyPos);
      if (d < 0) continue;                                  // 不可达
      if (d < bestD) { bestD = d; bestBush = c; }
    }
  }
  if (!bestBush) return null;
  const step = nextStepToward(myPos, bestBush, game, enemyPos);
  if (!step || !enemyPos) return step;
  // 奔草丛途中这一步也不许进死区(穿过握弹敌炮线)
  if (stepEntersKillZone(myPos, step, enemyPos, game, enemy, standoff)) return null;
  if (stepIntoBulletPath(bullets, step, game)) return null;
  // 握双弹敌：途中这一步也不要顺着敌人正行/列往敌人方向挪(BFS 可能沿敌列直上)，
  // 宁可这一步先横向脱出双弹带——若该步留在带内且比当前更靠近敌人，改用横移脱带步。
  if (enemyDoubleLaneThreat(enemy) && inDoubleLaneBand(enemyPos, step, standoff) &&
      manhattan(step, enemyPos) < manhattan(myPos, enemyPos)) {
    const bandEscape = escapeDoubleLaneBand(myPos, enemyPos, game, bullets);
    if (bandEscape) return bandEscape;
    return null; // 没有更好的脱带步，交上层巡逻，别朝握弹敌挪
  }
  return step;
}


/**
 * 追星落点前瞻：站到 star 落点后，过载敌朝我逼近一步，落点是否会陷入"双弹覆盖带内且无横向脱离"的死地。
 * 过载敌会追着我移动——吃星瞬间的横向出路常在下一帧被敌逼近而封死(mat：吃完星下一帧四向全被双弹覆盖、
 * 只能原地空转挨双弹)。这里保守预演敌沿"敌->落点"主轴逼近一格，用新敌位复检落点是否仍在带内且脱不掉。
 * 返回 true 表示这颗星是过载十字线陷阱，应放弃(scoreMoveCandidate 据此否决)。
 */
function starGrabTrapsInOverloadLane(starStep, enemyPos, game) {
  // 敌朝落点逼近一步：沿曼哈顿主轴(偏移更大的轴)移动一格，模拟过载敌持续压上
  const dx = starStep[0] - enemyPos[0];
  const dy = starStep[1] - enemyPos[1];
  let advanced = enemyPos;
  if (Math.abs(dx) >= Math.abs(dy) && dx !== 0) {
    advanced = [enemyPos[0] + (dx > 0 ? 1 : -1), enemyPos[1]];
  } else if (dy !== 0) {
    advanced = [enemyPos[0], enemyPos[1] + (dy > 0 ? 1 : -1)];
  }
  // 敌逼近格不可通行(撞墙)则维持原位预演
  if (!samePos(advanced, enemyPos) && !isPassable(game, advanced, null)) advanced = enemyPos;
  // 逼近后：落点仍在双弹覆盖带(同行/列或相邻±1)且无横向脱离 -> 吃完星即被困，判陷阱
  return inDoubleLaneBand(advanced, starStep, 6) && !hasDoubleLaneEscapeAt(starStep, advanced, game);
}


/**
 * 判断是否值得放弃交战去追星星
 */
function shouldChaseStar(myPos, enemyPos, game, starPath, enemy, fleeMode, me, enemyTank) {
  if (!game.star || !starPath || starPath.dist < 0) return false;
  if (!enemyPos) return true; // 看不到敌人必追星星
  // 守星陷阱：敌"此刻握双弹"且星就贴在它的双弹覆盖带里(它在守这颗星)，冲过去抢 = 落进双弹炮线送死
  // (mat_Jov6 星[1,5]紧贴握弹敌[2,4] d=1，我沿副弹行迎敌抢星被秒)。放弃这颗星，交走位拉开/另寻机会。
  if (enemy && enemyDoubleLaneThreat(enemy) && inDoubleLaneBand(enemyPos, game.star, 4)) return false;
  if (manhattan(myPos, game.star) <= 5) return true; // 星星很近就去吃
  // 跑路流：对方连续背对我逃跑，说明它只抢星不打架——我也不用等"比它近"才追，直接跟进抢星(mat_AAKs)
  if (fleeMode) return true;

  var enemyDist = pathDistance(enemyPos, game.star, game, myPos);
  // 转向惩罚：敌当前方向不朝星，需额外1~2帧转向才能出发
  if (enemyDist > 0 && enemyTank && enemyTank.direction) {
    var dirToStar = directionBetween(enemyPos, game.star);
    if (dirToStar && dirToStar !== enemyTank.direction) {
      enemyDist += turnDistance(enemyTank.direction, dirToStar);
    }
  }
  // 传送折扣：我方传送就绪时等效到达距离缩短(传送1帧+等待2帧+补走1步=4帧)
  var myEffectiveDist = starPath.dist;
  if (me && teleportReady(me) && starPath.dist > 3) {
    myEffectiveDist = 4; // 传送落星旁1步，1帧传+2帧等待+1帧走
  }
  // 如果比敌人更近（或差距在容忍范围内），就去抢
  // +4 容忍：敌人传送也需1帧+2等待+补走+转向，实际到达不比走路快多少
  // 有射线到星时放宽到+6：能拦截来敌，不必过于保守让位
  var tolerance = 4;
  if (clearShotDirection(myPos, game.star, game)) tolerance = 6;
  return enemyDist < 0 || myEffectiveDist <= enemyDist + tolerance;
}


/**
 * 守星陷阱检查：敌此刻握双弹且星在其覆盖带内（走路和传送共用）。
 * shouldChaseStar 内已含此判断（供走路路径使用）；
 * findStarTeleport 调用此函数做传送路径的统一守星陷阱过滤，
 * 避免走路/传送两套不同的 inDoubleLaneBand 阈值。
 */
function isStarGuardTrap(enemyPos, enemy, starPos) {
  if (!enemyPos || !enemy || !starPos) return false;
  return enemyDoubleLaneThreat(enemy) && inDoubleLaneBand(enemyPos, starPos, 4);
}


/**
 * BFS 寻找能打到敌人的射击轨道的下一步走位（不进入比 standoff 更近的死区）。
 *
 * 先手优化：在多个等距轨道格中，优先选"走过去后我已对准敌人"的格——省去一帧转向，
 * 避免逼近途中方向不对被敌人抢先开炮（mat_CD9x：我从右侧逼近，走到同行时朝 right 背对敌）。
 * 具体打分：走过去后的 clearShotDirection = 当前行进方向 -> +4（原地就能开炮）；
 *           走过去后需要转 1 次 -> +0；其余 -> -4。
 */
function nextStepToFiringLane(myPos, enemyPos, game, standoff, preferDir, flankWeight, minDistFloor, overloadAware) {
  const minD = minDistFloor !== undefined ? minDistFloor : Math.max(3, standoff - 1);
  // 收集所有候选轨道格（BFS 层序，记录到达每格的第一步和步数）
  const w = game.map.length, h = game.map[0].length;
  const queue = [myPos];
  const seen = {}, dist = {}, firstStep_ = {};
  const startKey = key(myPos);
  seen[startKey] = true; dist[startKey] = 0;
  let candidates = [], minDist = 9999;

  for (let qi = 0; qi < queue.length; qi++) {
    const p = queue[qi];
    const pd = dist[key(p)];
    if (pd > minDist + 1) break; // 只找最近的一批
    const d = manhattan(p, enemyPos);
    // 直射线格(原逻辑)；overloadAware 时错位副弹线格也算有效炮位(走过去后敌落我 +1 副弹道)
    var isLane = false;
    if (!samePos(p, myPos) && d >= minD && d <= 9) {
      if (clearShotDirection(p, enemyPos, game)) isLane = true;
      else if (overloadAware && overloadOffsetShotDir(p, enemyPos, game)) isLane = true;
    }
    if (isLane && pd <= minDist) { minDist = pd; candidates.push(p); }
    for (let i = 0; i < DIRS.length; i++) {
      const n = [p[0] + DIRS[i].dx, p[1] + DIRS[i].dy];
      const nk = key(n);
      if (seen[nk]) continue;
      if (n[0] < 0 || n[1] < 0 || n[0] >= w || n[1] >= h) continue;
      if (!isPassable(game, n, enemyPos)) continue;
      seen[nk] = true;
      dist[nk] = pd + 1;
      // 记录到达 n 的第一步
      firstStep_[nk] = samePos(p, myPos) ? n : firstStep_[key(p)];
      queue.push(n);
    }
  }
  if (candidates.length === 0) return null;

  // 对候选格按"走过去后是否对准敌人"打分
  let best = null, bestScore = -9999;
  for (let i = 0; i < candidates.length; i++) {
    const c = candidates[i];
    const ck = key(c);
    const step = samePos(c, myPos) ? c : (firstStep_[ck] || c);
    // 直射方向优先；无直射但有错位副弹方向(overloadAware)时用副弹方向评估"已对准"
    var lineDir = clearShotDirection(c, enemyPos, game);
    var offsetOnly = false;
    if (!lineDir && overloadAware) {
      lineDir = overloadOffsetShotDir(c, enemyPos, game);
      offsetOnly = !!lineDir;
    }
    // 走到 c 的行进方向（第一步方向）
    const moveDir = directionBetween(myPos, step);
    // 若走到 c 后 lineDir 就是我到达时的朝向（即行进中已对准）-> 无需再转向
    const alreadyAimed = lineDir === moveDir ? 4 : 0;
    // 绕背偏好：候选格在敌人 preferDir 侧（背后）时加分
    var behindBonus = 0;
    var frontPenalty = 0;
    if (preferDir && lineDir) {
      var dd = DIR_DELTAS[preferDir];
      if (dd) {
        var dot = (c[0] - enemyPos[0]) * dd[0] + (c[1] - enemyPos[1]) * dd[1];
        if (dot > 0) behindBonus = flankWeight ? flankWeight : 3;
        else if (dot < 0 && flankWeight) frontPenalty = -flankWeight;
      }
    }
    // 错位炮位略让位于直射炮位(直射主弹必中，错位只副弹中)，但仍是有效占位
    var offsetPenalty = offsetOnly ? -1 : 0;
    const score = alreadyAimed + behindBonus + frontPenalty + offsetPenalty + distanceFromEdges(c, game);
    if (score > bestScore) { bestScore = score; best = step; }
  }
  return best;
}


/**
 * 维持安全站位：当前离敌人比 standoff 近则后撤，远则靠近到 standoff 环附近。
 *
 * 三条路径（互斥，从上往下依次判断）：
 *   A. 太近(d < standoff)      → 后撤一步（stepAwayFromEnemy）
 *   B. 在安全环带内(standoff..standoff+2) → 找射击轨道（nextStepToFiringLane），不主动贴近
 *   C. 太远(d > standoff+2)    → 逼近到 standoff 环（BFS 寻路）
 *
 * overload 流特例：逼近会穿过其行/列、走进副弹覆盖带或贴墙副弹行陷阱（mat_LBH）。
 * 路径 B 调 nextStepToFiringLane 可能选"走过去对准"的格，同样有向敌正列逼近的风险。
 * 对 overload 流，路径 B 和路径 C 均禁止，交给上层 bandEscape/bushStep 保持机动。
 */
function nextStepToStandoff(myPos, enemyPos, game, standoff, enemy, enemyBullets) {
  const curD = manhattan(myPos, enemyPos);

  // 路径 A：太近 → 后撤
  if (curD < standoff) {
    return stepAwayFromEnemy(myPos, enemyPos, game, enemy, enemyBullets);
  }

  // 路径 B：已在安全环带内 → 找射击轨道（在此停留，不贴近）
  // overload 流 CD 充裕(>5帧)时压上开炮；CD 快好或已过载则保守交上层。
  if (curD <= standoff + 2) {
    if (enemyIsOverloadType(enemy)) {
      const cd = enemy.skill && enemy.skill.remainingCooldownFrames;
      if (enemyDoubleLaneThreat(enemy) || (cd !== undefined && cd <= 5)) return null;
    }
    return nextStepToFiringLane(myPos, enemyPos, game, standoff);
  }

  // 路径 C：太远 → 逼近到 standoff 环（overload 流 CD 快好时禁止逼近，交上层巡逻）
  if (enemyIsOverloadType(enemy)) {
    const cd = enemy.skill && enemy.skill.remainingCooldownFrames;
    if (enemyDoubleLaneThreat(enemy) || (cd !== undefined && cd <= 5)) return null;
  }
  return nextStepToGoal(myPos, game, enemyPos, function (p) {
    const d = manhattan(p, enemyPos);
    return d >= standoff && d <= standoff + 1;
  });
}


/**
 * 选一个远离敌人、且不撞进敌方炮线的相邻后撤格。
 * 对 overload 流敌人：重罚仍留在其双弹覆盖带(相邻±1行/列)的后撤格，奖励跨出覆盖带的格——
 * 否则只按"远离+离边"打分会在副弹列上下挪(mat_4YF 在 x=15 副弹列徘徊被错位双弹秒)。
 */
function stepAwayFromEnemy(myPos, enemyPos, game, enemy, enemyBullets) {
  const overloadType = enemyIsOverloadType(enemy);
  const bullets = enemyBullets || [];
  let best = null;
  let bestScore = -9999;
  for (let i = 0; i < DIRS.length; i++) {
    const p = [myPos[0] + DIRS[i].dx, myPos[1] + DIRS[i].dy];
    if (!isPassable(game, p, enemyPos)) continue;
    if (stepIntoBulletPath(bullets, p, game)) continue;
    let score = manhattan(p, enemyPos) + distanceFromEdges(p, game) * 0.5;
    if (overloadType) {
      // 跨出双弹覆盖带(既不同行±1也不同列±1)大幅加分，仍在覆盖带内则减分，逼自己离开副弹道
      const dx = Math.abs(enemyPos[0] - p[0]);
      const dy = Math.abs(enemyPos[1] - p[1]);
      if (dx >= 2 && dy >= 2) score += 10;
      else score -= 6;
    }
    if (score > bestScore) {
      bestScore = score;
      best = p;
    }
  }
  return best;
}


/**
 * 横向脱离"双弹覆盖带"：敌此刻握双弹、我站在其正行/列或相邻±1行/列(副弹道)内时，朝垂直于敌我连线的
 * 方向走一步，尽量跨到 dx>=2 且 dy>=2 的覆盖带外安全格(mat_Jov6 在副弹行 y=5 沿带迎敌走="还回头"被秒；
 * mat_EUR 贴 x=16 副弹列顺子弹逃被追)。优先：跨出覆盖带 > 远离边缘 > 当前朝向即可走(省一帧转向)。
 * 只在握双弹(enemyDoubleLaneThreat)时调用；找不到比当前更好的脱离格则返回 null(交巡逻兜底)。
 */
function escapeDoubleLaneBand(myPos, enemyPos, game, enemyBullets) {
  let best = null;
  let bestScore = -9999;
  const bullets = enemyBullets || [];
  for (let i = 0; i < DIRS.length; i++) {
    const p = [myPos[0] + DIRS[i].dx, myPos[1] + DIRS[i].dy];
    if (!isPassable(game, p, enemyPos)) continue;
    if (stepIntoBulletPath(bullets, p, game)) continue;
    const dx = Math.abs(enemyPos[0] - p[0]);
    const dy = Math.abs(enemyPos[1] - p[1]);
    const outOfBand = dx >= 2 && dy >= 2; // 既不在(相邻)列也不在(相邻)行 -> 真正跨出双弹覆盖带
    // 不能往敌人更近处挪(否则是"靠近握弹敌"而非脱离)
    if (manhattan(p, enemyPos) < manhattan(myPos, enemyPos)) continue;
    let score = (outOfBand ? 100 : 0) + manhattan(p, enemyPos) + distanceFromEdges(p, game) * 0.5;
    if (score > bestScore) { bestScore = score; best = p; }
  }
  // 只有当确实能往覆盖带外/更远走才返回；否则 null 让巡逻/兜底接手
  return best;
}


/**
 * 朝远离某危险点(如隐身敌人最后位置)的方向走一步，保持至少 minDist 间距。
 */
function nextStepAvoiding(myPos, dangerPos, game, minDist, enemyBullets, enemy) {
  if (manhattan(myPos, dangerPos) >= minDist + 2) return null; // 已经够远，不必特意避让
  return stepAwayFromEnemy(myPos, dangerPos, game, enemy, enemyBullets);
}


/**
 * 隐身敌"伏击线"横移脱离：我与 dangerPos(敌最后已知位置)同行或同列、且中间无墙遮挡(真能被一炮打到)时，
 * 朝垂直方向走一步彻底离开那条行/列。隐身敌看不见、会沿原线游弋开火，远距也危险。
 * 有石墙挡在中间 -> 那条线其实安全(子弹会被墙吃掉)，返回 null 不避让(避免无谓徘徊、不防过头)。
 */
function escapeAmbushLine(myPos, dangerPos, game, enemyBullets) {
  const lineDir = clearShotDirection(dangerPos, myPos, game); // 敌->我 无遮挡方向(同行/列且无墙)
  if (!lineDir) return null; // 不同线 或 中间有墙(石墙挡子弹) -> 不必横移
  const sameCol = dangerPos[0] === myPos[0]; // 同列(竖直线) -> 需左右(x)脱离; 同行 -> 上下(y)脱离
  const lateral = sameCol
    ? [{ dx: -1, dy: 0 }, { dx: 1, dy: 0 }]
    : [{ dx: 0, dy: -1 }, { dx: 0, dy: 1 }];
  const bullets = enemyBullets || [];
  let best = null, bestScore = -9999;
  for (let i = 0; i < lateral.length; i++) {
    const q = [myPos[0] + lateral[i].dx, myPos[1] + lateral[i].dy];
    if (!isPassable(game, q, null)) continue;
    if (stepIntoBulletPath(bullets, q, game)) continue;
    // 走过去后不能仍与敌最后位置同行/同列(否则没真正离开线)
    if (q[0] === dangerPos[0] || q[1] === dangerPos[1]) continue;
    const score = manhattan(q, dangerPos) + distanceFromEdges(q, game) * 0.5;
    if (score > bestScore) { bestScore = score; best = q; }
  }
  return best;
}


/**
 * 隐身敌"之字斜逃"：面对 cloak 流敌人逃跑时，绝不沿单一行/列直线退（mat_L4l9：敌隐身绕到我正后方
 * 同行 y=6，我沿 y=6 连走 3 格直线退，被 2 格/帧的子弹从背后追死）。隐身时我看不见敌真实位置，
 * 它可能藏在我**任意**行/列背后；走斜向(每帧换行又换列)能让任何一条直线子弹到达时我都已离开那条线。
 *
 * 坦克一帧只能走一格(不能真正对角移动)，所以"之字"靠**逐帧交替换轴**实现：本帧优先选一个
 * "既离 lastEnemyPos 更远、又能为下一帧换轴留出空间"的方向；并尽量避免与上一步同轴(交替 x/y)。
 * lastStepAxis 记录上一步走的轴(0=x,1=y)，本帧优先换另一轴，凑出之字轨迹。
 */
function diagonalEvadeStep(myPos, dangerPos, game, state) {
  const lastAxis = state ? state.lastEvadeAxis : undefined; // 0=x轴(left/right), 1=y轴(up/down)
  let best = null, bestScore = -9999, bestAxis = null;
  for (let i = 0; i < DIRS.length; i++) {
    const d = DIRS[i];
    const p = [myPos[0] + d.dx, myPos[1] + d.dy];
    if (!isPassable(game, p, null)) continue;
    if (manhattan(p, dangerPos) < manhattan(myPos, dangerPos)) continue; // 不往隐身敌方向靠
    const axis = d.dx !== 0 ? 0 : 1;
    // 离开"敌可能藏身"的两条线：走过去后既不与 dangerPos 同行、也不同列最优(彻底脱离任何一条偷袭直线)
    const offDanger = (p[0] !== dangerPos[0] ? 1 : 0) + (p[1] !== dangerPos[1] ? 1 : 0);
    // 交替换轴(之字核心)：本帧换到与上一步不同的轴 -> 加分；同轴(直线退) -> 不加分
    const altBonus = (lastAxis === undefined || axis !== lastAxis) ? 6 : 0;
    const score = altBonus + offDanger * 4 + manhattan(p, dangerPos) + distanceFromEdges(p, game) * 0.5;
    if (score > bestScore) { bestScore = score; best = p; bestAxis = axis; }
  }
  if (best && state) state.lastEvadeAxis = bestAxis;
  return best;
}
