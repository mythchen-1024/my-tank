/**
 * 
 * 【设计理念】
 *   基于 README 总结的复盘经验，本坦克采用"局面评分 + 硬约束"架构：
 *   - 不是看到情况A就固定做动作B，而是对所有候选动作打分
 *   - 选择风险可控且收益最高的动作
 *   - 核心平衡：不是怂，也不是莽，而是在收益和风险之间做主动选择
 * 
 * 【决策优先级（从高到低）】
 *   0. 异常状态拦截（眩晕/冰冻）
 *   1. 硬约束：子弹躲避（最高优先级，保命）
 *   2. 硬约束：紧急传送逃生
 *   3. 硬约束：防范敌方瞄准（防被秒）
 *   4. 一击必杀：能击杀且不会立刻死
 *   5. 卡死检测：打破来回振荡的死循环
 *   6. 终局抢星：快结束时提高吃星优先级
 *   7. 星线压制：占住星星十字线，不让位
 *   8. 射击敌人：同线无遮挡且安全可开火
 *   9. 传送刺杀：寻找敌方射击盲区突袭
 *   10. 星星争夺预瞄：双方靠近星星时提前瞄准
 *   11. 传送抢星：走路太远时传送抢分
 *   12. 战术走位：BFS寻路（星星→射击轨道→靠近敌人→中心）
 *   13. 破墙开路：面前有土块且子弹就绪
 *   14. 安全徘徊：无事可做时走最安全的格子
 *   15. 原地转向：避免卡死
 * 
 * 【核心模块】
 *   - 抢星模块：距离判断、路径障碍检测、终局紧迫感
 *   - 星线压制模块：占线不让位、敌人靠近时开火压制
 *   - 开火模块：一击必杀优先、远距压制、安全校验
 *   - 子弹躲避模块：1帧2格ETA计算、overload双弹侧线检测
 *   - 传送模块：逃生传送、刺杀传送、抢星传送
 *   - 反传送防御：面对传送敌人时预判伏击落点
 *   - 卡死检测：检测来回振荡，强制打破循环
 *   - 死角检测：避免走入三面墙的死胡同
 * 
 * ==================== onIdle 参数详解 ====================
 * 
 * 1. me（自身状态与动作接口）
 *    me.tank.id            — 坦克ID
 *    me.tank.position      — 坐标 [x, y]
 *    me.tank.direction     — 车头朝向 ("up"/"down"/"left"/"right")
 *    me.tank.crashed       — 是否撞击中
 *    me.bullet             — 己方在场子弹（无则为null）
 *      .position / .direction
 *    me.stars              — 已收集星星数
 *    me.skill              — 技能信息
 *      .type               — 技能类型（本坦克固定为 "teleport"）
 *      .cooldownFrames     — 基础冷却帧数
 *      .remainingCooldownFrames — 剩余冷却（0=可用）
 *      .activeRemainingFrames   — 生效中剩余帧数
 *    me.effects            — Buff/Debuff
 *      .self               — 增益 { type, remainingFrames }
 *      .debuff             — 负面 { type, remainingFrames }
 *    me.status             — 状态集合
 *      .shielded / .cloaked / .boosted / .overloaded
 *      .frozen / .stunned / .poisoned / .fireLocked
 *      .actionSpeed / .canActThisFrame
 * 
 *    可调用动作（加入队列延后执行）：
 *      me.go() / me.go(2)         — 前进
 *      me.turn("left"/"right")    — 转向
 *      me.fire()                  — 开火
 *      me.teleport(x, y)          — 传送（本坦克技能）
 *      me.speak("text")           — 气泡发言（仅回放视觉）
 * 
 * 2. enemy（敌方状态，隐身/草丛时 tank 为 null）
 *    enemy.tank / enemy.bullet / enemy.skill
 *    enemy.effects / enemy.status
 * 
 * 3. game（全局状态）
 *    game.map[x][y]  — "x"=墙 "m"=土块 "o"=草丛 "."=空地
 *    game.star       — 星星坐标 [x,y] 或 null
 *    game.frames     — 当前帧数（最大128帧）
 * 
 * ==================== 游戏规则要点 ====================
 * - 胜利条件：击杀敌方 或 超时后星星多者胜
 * - 每帧默认执行1个动作指令
 * - 场上同时只能有1发己方子弹（overload除外）
 * - 传送落点距敌<=4格会被开火锁定2帧
 * - 传送冷却40帧，目标无效仍消耗冷却
 * 
 * ============================================================
 */

// ==================== 卡死检测状态（跨帧持久化） ====================
// 记录最近N帧的位置，检测是否在两点间来回振荡
var STUCK_HISTORY = (typeof STUCK_HISTORY !== "undefined") ? STUCK_HISTORY : [];
var STUCK_MAX_HISTORY = 8;          // 最多记录8个历史位置
var STUCK_OSCILLATE_COUNT = 0;      // 振荡计数器
var STUCK_BREAK_DIR = null;         // 打破卡死时强制走的方向
var STUCK_BREAK_FRAMES = 0;         // 强制打破卡死的剩余帧数

// 敌人记忆：当敌人隐身/进草后，记住最后已知位置
var ENEMY_MEMORY_POS = null;        // 敌人最后已知坐标
var ENEMY_MEMORY_FRAMES = 0;        // 记忆剩余有效帧数

// 反摇摆迟滞：记录上一帧执行的转向方向与位置，抑制原地左右转来回拉锯
var LAST_TURN_SIDE = null;          // 上一帧的转向方向 "left"/"right"
var LAST_POS_KEY = null;            // 上一帧的位置 key

function onIdle(me, enemy, game) {
  // ========== 获取基础状态信息 ==========
  var myPos = me.tank.position;
  var enemyTank = enemy && enemy.tank ? enemy.tank : null;
  var enemyPos = enemyTank ? enemyTank.position : null;
  var enemyBullet = enemy && enemy.bullet ? enemy.bullet : null;
  var foeOverloaded = !!(enemy && enemy.status && enemy.status.overloaded);
  var framesLeft = 128 - game.frames;
  var starDiff = me.stars - (enemy.stars || 0);
  var isLeading = starDiff > 0;
  var isTrailing = starDiff < 0;

  // ========== 敌人记忆更新 ==========
  if (enemyPos) {
    ENEMY_MEMORY_POS = enemyPos.slice();
    ENEMY_MEMORY_FRAMES = 20;
  } else if (ENEMY_MEMORY_FRAMES > 0) {
    ENEMY_MEMORY_FRAMES--;
  } else {
    ENEMY_MEMORY_POS = null;
  }

  // ========== 异常状态拦截 ==========
  if (me.status && (me.status.stunned || me.status.frozen)) return;

  // ========== 硬约束1：子弹躲避（最高优先级，保命） ==========
  // 参考 bak.js 的简洁模式：findBulletDodge 找安全侧躲格，moveToward 执行；
  // 无法侧躲时 findEscapeTeleport 全图传送兜底。先于一切收益逻辑。
  var dodge = findBulletDodge(me, enemy, game, enemyPos);
  if (dodge) {
    moveToward(me, game, dodge, enemyPos, enemyTank, enemyBullet);
    return;
  }
  // 常规侧躲无解 → 紧急传送逃生（仅在被子弹威胁时才动用，避免浪费技能）
  if (enemyBullet && bulletThreatens(enemyBullet, myPos, game) && teleportReady(me)) {
    var escTile = findEscapeTeleport(me, enemyTank, enemyBullet, game);
    if (escTile) { me.teleport(escTile[0], escTile[1]); return; }
  }

  // ========== 卡死检测（元级覆盖，打破振荡后重新进入评分） ==========
  updateStuckHistory(myPos);
  if (STUCK_BREAK_FRAMES > 0) {
    STUCK_BREAK_FRAMES--;
    if (STUCK_BREAK_DIR && isPassable(game, nextInDirection(myPos, STUCK_BREAK_DIR), enemyPos)) {
      if (me.tank.direction === STUCK_BREAK_DIR) { me.go(); }
      else { turnToward(me, STUCK_BREAK_DIR); }
      return;
    }
  }
  if (isStuckOscillating()) {
    // 如果当前在星线上或有明显吃星机会，不触发卡死打破（让评分系统自然处理）
    if (game.star && clearShotDirection(myPos, game.star, game)) {
      STUCK_OSCILLATE_COUNT = 0;
      STUCK_HISTORY = [];
    } else {
      STUCK_BREAK_DIR = findBreakDirection(myPos, game, enemyPos, enemyTank, enemyBullet);
      if (STUCK_BREAK_DIR) {
        STUCK_BREAK_FRAMES = 3; STUCK_OSCILLATE_COUNT = 0; STUCK_HISTORY = [];
        if (me.tank.direction === STUCK_BREAK_DIR) { me.go(); }
        else { turnToward(me, STUCK_BREAK_DIR); }
        return;
      }
    }
  }

  // ================================================================
  //  评分系统核心：生成所有候选动作 → 硬约束过滤 → 多维打分 → 选最高分
  // ================================================================
  var candidates = [];

  // --- 1. 移动候选：四个方向 ---
  for (var i = 0; i < DIRS.length; i++) {
    var d = DIRS[i];
    var nextPos = [myPos[0] + d.dx, myPos[1] + d.dy];

    // 硬约束过滤：不通、必死格（子弹ETA命中/overload侧线/近距炮口含下一帧）、死角
    if (!isPassable(game, nextPos, enemyPos)) continue;
    if (isLethalTile(nextPos, enemyTank, enemyBullet, game, foeOverloaded)) continue;
    if (enemyPos && enemyAimsAt(nextPos, enemyTank, game) && manhattan(nextPos, enemyPos) <= 4) continue;
    if (isDeadEnd(nextPos, game, enemyPos)) continue;

    var moveScore = scorePosition(nextPos, me, enemy, game, enemyPos, enemyTank, enemyBullet, isLeading, isTrailing, framesLeft);
    // 转向代价：每90度转弯扣分
    moveScore -= turnDistance(me.tank.direction, d.name) * 8;
    candidates.push({ type: "move", dir: d.name, pos: nextPos, score: moveScore });
  }

  // --- 2. 原地不动候选 ---
  var holdScore = scorePosition(myPos, me, enemy, game, enemyPos, enemyTank, enemyBullet, isLeading, isTrailing, framesLeft);
  // 阵地意识：仅当“有可见敌人需要封锁”且自己不站在星上时，占星线原地不动才加分。
  // 否则（敌人不可见 / 已可吃星）不应原地空守，避免怂坦克放着免费星不吃。
  if (game.star && clearShotDirection(myPos, game.star, game) && !bulletThreatens(enemyBullet, myPos, game)) {
    var onStar = samePos(myPos, game.star);
    if (enemyPos && !onStar) {
      var enemyStarGap = manhattan(enemyPos, game.star);
      if (enemyStarGap <= 6) holdScore += 18; // 敌人在争星范围内才值得守线
    }
  }
  // 硬约束：当前格本身是必死格（子弹/侧线/近距炮口）→ 原地不动重罚，强制离开
  if (isLethalTile(myPos, enemyTank, enemyBullet, game, foeOverloaded)) {
    holdScore -= 5000;
  }
  // 反发呆：无星时原地 hold 没有收益，评分平局会让坦克永远不动。
  // 无论敌人是否可见，无星就惩罚 hold，强制去追星/找射击位/巡逻。
  // 有目标（星/敌）时也给 hold 小惩罚，确保转向代价不会让坦克永远原地不动。
  var idleNoTarget = !game.star && !enemyPos;
  if (!game.star) {
    holdScore -= 30; // 无星时统一惩罚，确保任何有效 move 都赢过 hold
  } else if (!enemyPos) {
    holdScore -= 10; // 有星无敌时打破平局，确保追星
  } else {
    holdScore -= 3;  // 有星有敌时极小惩罚，只打破完全平局，不过度驱动移动
  }
  candidates.push({ type: "hold", score: holdScore });

  // --- 2.1 巡逻探索：无星无敌人时，沿当前朝向继续前进（或转向可走方向），避免发呆 ---
  // 策略：优先沿当前朝向走（保持惯性，不乱改方向），前方不通时才转向。
  // 不强制走向地图中心，避免在某些地图上主动走进敌人射击线。
  if (idleNoTarget) {
    var forwardPos = nextInDirection(myPos, me.tank.direction);
    if (isPassable(game, forwardPos, null)) {
      // 前方可走：直接 go，分数高于 hold(-200)
      candidates.push({ type: "move", dir: me.tank.direction, pos: forwardPos, score: 50 });
    } else {
      // 前方不通：找任意可走邻格，分数略低
      for (var ei = 0; ei < DIRS.length; ei++) {
        var ep = [myPos[0] + DIRS[ei].dx, myPos[1] + DIRS[ei].dy];
        if (isPassable(game, ep, null)) {
          candidates.push({ type: "move", dir: DIRS[ei].name, pos: ep,
            score: 40 - turnDistance(me.tank.direction, DIRS[ei].name) * 4 });
          break; // 只加一个，避免过多候选
        }
      }
    }
  }

  // --- 2.5 调头应战：与敌人同线无遮挡却没面对他，优先调转炮口（含站星时不发呆） ---
  // 经验复盘：站在星上或星线上原地 hold 时，敌人进入同线我方还背对着，
  // 容易被先手击杀。只要敌人能与我互射、我朝向不对，就把"转向敌人"作为高分候选。
  if (enemyPos && !bulletThreatens(enemyBullet, myPos, game)) {
    var faceDir = clearShotDirection(myPos, enemyPos, game);
    if (faceDir && faceDir !== me.tank.direction) {
      // 敌人已经瞄着我（同线且炮口对准）→ 站着不动会被先手秒，必须高于 hold 抢先转向应战
      var foeAiming = enemyAimsAt(myPos, enemyTank, game);
      var onStarOrLine = game.star && (samePos(myPos, game.star) || clearShotDirection(myPos, game.star, game));
      var turnScore = foeAiming ? (holdScore + 30) : (onStarOrLine ? 40 : 30);
      candidates.push({ type: "turn", dir: faceDir, score: turnScore });
    }
  }

  // --- 3. 开火候选 ---
  if (enemyPos && gunReady(me)) {
    var fireDir = clearShotDirection(myPos, enemyPos, game);
    if (fireDir) {
      var fireScore = scoreFire(me, enemy, game, myPos, enemyPos, enemyTank, enemyBullet, isLeading, isTrailing, framesLeft);
      if (fireScore > -9000) {
        candidates.push({ type: "fire", dir: fireDir, score: fireScore });
      }
    }
  }

  // --- 4. 破墙开路候选 ---
  // 仅在有明确目标（星星 / 可见敌人）时才破墙开路；无目标时破墙纯属浪费子弹
  // （真实对局出现过无敌无星时反复 fire 打墙/打不挡路的土块，白白消耗唯一的子弹）。
  if ((game.star || enemyPos) && gunReady(me)) {
    var digTarget = game.star || enemyPos;
    var digDir = findDigDirection(myPos, game, digTarget);
    // 仅当破墙确实能缩短到目标的路径时才挖（绕路距离 > 破墙后直线收益）
    if (digDir && digHelpsReach(myPos, digDir, digTarget, game)) {
      candidates.push({ type: "dig", dir: digDir, score: 25 });
    }
  }

  // --- 5. 传送候选 ---
  if (teleportReady(me)) {
    var teleCands = generateTeleportCandidates(me, enemyTank, enemyBullet, game, isLeading, isTrailing, framesLeft);
    for (var t = 0; t < teleCands.length; t++) {
      candidates.push(teleCands[t]);
    }
  }

  // --- 反摇摆迟滞：若上一帧原地转向，本帧又要反方向转回且位置没动，给该转向候选扣分 ---
  // 修复 f15-f18 那种原地 left/right/left/right 拉锯死循环（位置不变，评分翻转）。
  var curPosKey = key(myPos);
  if (LAST_TURN_SIDE && LAST_POS_KEY === curPosKey) {
    var reverseSide = LAST_TURN_SIDE === "left" ? "right" : "left";
    for (var hc = 0; hc < candidates.length; hc++) {
      var c = candidates[hc];
      if (c.type === "turn" && c.dir) {
        // 该转向候选实际会让 turnToward 选哪个 side
        var side = turnSideFor(me.tank.direction, c.dir);
        if (side === reverseSide) c.score -= 60; // 反向转回 → 重扣，打破拉锯
      }
    }
  }

  // --- 按分数降序排列，选最高分 ---
  candidates.sort(function(a, b) { return b.score - a.score; });

  if (candidates.length > 0) {
    var best = candidates[0];

    // 记录本帧动作，用于下一帧反摇摆判断
    var executedTurnSide = null;

    if (best.type === "move") {
      if (me.tank.direction === best.dir) { me.go(); }
      else { executedTurnSide = turnSideFor(me.tank.direction, best.dir); turnToward(me, best.dir); }
    } else if (best.type === "fire" || best.type === "dig") {
      if (me.tank.direction === best.dir) { me.fire(); }
      else { executedTurnSide = turnSideFor(me.tank.direction, best.dir); turnToward(me, best.dir); }
    } else if (best.type === "turn") {
      executedTurnSide = turnSideFor(me.tank.direction, best.dir);
      turnToward(me, best.dir);
    } else if (best.type === "teleport") {
      if (me.tank.direction === best.dir) { me.teleport(best.pos[0], best.pos[1]); }
      else { executedTurnSide = turnSideFor(me.tank.direction, best.dir); turnToward(me, best.dir); }
    }
    // type === "hold"：不做任何动作，保持当前位置和朝向

    LAST_TURN_SIDE = executedTurnSide;
    LAST_POS_KEY = curPosKey;
    return;
  }

  // 兜底：转向避免彻底卡死
  LAST_TURN_SIDE = "right"; LAST_POS_KEY = curPosKey;
  me.turn("right");
}

// ==================== 常量定义 ====================

// 四个基本方向及其坐标偏移量 [dx, dy]
var DIRS = [
  { name: "up",    dx:  0, dy: -1 },  // 上
  { name: "right", dx:  1, dy:  0 },  // 右
  { name: "down",  dx:  0, dy:  1 },  // 下
  { name: "left",  dx: -1, dy:  0 }   // 左
];

// 子弹轨迹预判距离（格），用于 overload 双弹侧线判断
var BULLET_LOOKAHEAD_TILES = 8;
// 子弹威胁的 ETA 上限（帧）。子弹1帧2格，阈值10≈20格，覆盖整张图宽。
// 用 ETA 而非固定格数，修复"远距离同线子弹未被感知 → 原地摇摆被秒"的硬伤。
var BULLET_THREAT_ETA = 10;
// 刺杀传送的最小距离（避免开火锁定）与最大搜索距离
var ASSASSIN_MIN_RANGE = 5;
var ASSASSIN_MAX_RANGE = 8;

// ==================== 辅助函数 ====================

/**
 * 【一击必杀判断】能击杀敌人且自己不会立刻死
 * 这是最高价值的开火时机，优先级高于抢星
 * 条件：距离<=3、同线无遮挡、自己不在敌方炮口/子弹线上
 */
function isOneHitKill(me, enemy, game, enemyPos, enemyBullet) {
  if (!gunReady(me)) return false;
  // 敌人有护盾或隐身时无法一击必杀
  if (enemy.status && enemy.status.shielded) return false;
  if (enemy.status && enemy.status.cloaked) return false;
  var myPos = me.tank.position;
  var dist = manhattan(myPos, enemyPos);
  // 近距离（<=3格）且同线无遮挡 = 必中窗口
  if (dist <= 3 && !!clearShotDirection(myPos, enemyPos, game)) {
    // 安全检查：自己不在敌方瞄准线上、不在子弹轨迹上
    if (!enemyAimsAt(myPos, enemy && enemy.tank, game) && !bulletThreatens(enemyBullet, myPos, game)) {
      return true;
    }
  }
  return false;
}

/**
 * 【射击安全判断】判断当前是否可以安全开火
 * - 远距离（>4格）：允许冒险开火，有足够时间侧躲
 * - 近距离（<=4格）：必须不在敌方炮口线上且不在子弹轨迹上
 * - 敌人有护盾时不浪费子弹
 */
function canShoot(me, enemy, myPos, enemyTank, enemyBullet, game) {
  if (!gunReady(me)) return false; // 炮管未就绪（场上已有子弹或被开火锁定）
  if (enemy.status && enemy.status.shielded) return false; // 敌人有护盾，不打
  var dist = manhattan(myPos, enemyTank ? enemyTank.position : [0, 0]);
  // 远距离允许冒险开火，子弹飞行需要时间，可以侧躲
  if (dist > 4) return true;
  // 近距离必须安全：不在敌方炮口线上、不在子弹轨迹上
  if (enemyAimsAt(myPos, enemyTank, game)) return false;
  if (bulletThreatens(enemyBullet, myPos, game)) return false;
  return true;
}

/**
 * 【炮管就绪检查】场上无己方子弹 且 未被开火锁定
 */
function gunReady(me) {
  return !me.bullet && !(me.status && me.status.fireLocked);
}

/**
 * 【传送就绪检查】技能存在 且 冷却完毕
 */
function teleportReady(me) {
  return !!me.teleport && me.skill && me.skill.remainingCooldownFrames === 0;
}

/**
 * 【传送刺杀方案】寻找最佳传送落点，从敌方射击盲区突袭
 * 遍历四个方向和5-8格距离，打分选择最优落点
 * 返回 { pos: [x,y], dir: "方向" } 或 null
 *
 * 【v8 修正】传送不改朝向，落地后若还要转向才能开火，会输掉转向竞速被敌人先开火击杀
 * （线上对 C罗/biu-biu 等多次因此送死）。因此只接受"落地即面向敌人"的方向：
 * 即落点的射击方向必须等于我当前朝向，落地下一帧就能直接开火。
 */
function findAssassinationPlan(me, enemy, enemyTank, enemyBullet, game) {
  if (!enemyTank || !teleportReady(me) || !gunReady(me)) return null;
  // 敌人隐身或有护盾时不刺杀
  if (enemy.status && (enemy.status.cloaked || enemy.status.shielded)) return null;

  var enemyPos = enemyTank.position;
  var myDir = me.tank.direction;
  var best = null;
  var bestScore = -9999;

  // 只遍历"我当前朝向"这一个方向：落地无需转向，下一帧即可开火
  var di = dirIndex(myDir);
  if (di < 0) return null;
  var dir = DIRS[di];
  for (var range = ASSASSIN_MIN_RANGE; range <= ASSASSIN_MAX_RANGE; range++) {
    var p = [enemyPos[0] - dir.dx * range, enemyPos[1] - dir.dy * range];
    if (samePos(p, me.tank.position)) continue; // 排除当前位置
    if (!isAssassinTile(p, dir.name, enemyTank, enemyBullet, game)) continue;

    // 打分模型：距离越近越好、靠近地图中心更好（已无转向代价，因为强制零转向）
    var centerBias = distanceFromEdges(p, game);
    var score = 100 - range * 2 + centerBias;

    if (score > bestScore) {
      bestScore = score;
      best = { pos: p, dir: dir.name };
    }
  }
  return best;
}

/**
 * 【刺杀落点校验】检查坐标是否适合作为刺杀传送落点
 * - 传送安全（不卡墙、不接子弹、不被瞄准）
 * - 距离>=5格（避免开火锁定）
 * - 落点能直接射击敌人
 */
function isAssassinTile(p, dir, enemyTank, enemyBullet, game) {
  if (!isTeleportSafe(p, enemyTank, enemyBullet, game, false)) return false;
  if (manhattan(p, enemyTank.position) < ASSASSIN_MIN_RANGE) return false;
  if (clearShotDirection(p, enemyTank.position, game) !== dir) return false;
  return true;
}

/**
 * 【星线压制模块】占住星星十字线，不让位
 * - 已占星线且无真实子弹威胁，就守着不离开
 * - 敌人靠近星点时开火压制
 * - 无危险时保持朝向，不让出星线
 * 返回 null（不压制）、{ action:"hold" }（守位）、{ action:"fire" }（开火压制）、{ action:"turn", dir }（转向）
 */
function holdStarLine(me, enemyTank, enemyBullet, game) {
  if (!game.star || !enemyTank) return null;
  var myPos = me.tank.position;
  var enemyPos = enemyTank.position;

  // 检查我是否在星星的十字线上（同行或同列且无遮挡）
  var starDir = clearShotDirection(myPos, game.star, game);
  if (!starDir) return null; // 不在星线上，不压制

  // 检查当前朝向是否对准星星方向
  var aimingAtStar = (me.tank.direction === starDir);

  // 有子弹威胁时让子弹躲避逻辑处理，不在此处压制
  if (bulletThreatens(enemyBullet, myPos, game)) return null;

  // 敌人靠近星点（距离<=3），且我瞄准星星方向，开火压制
  var enemyToStar = manhattan(enemyPos, game.star);
  if (enemyToStar <= 3 && aimingAtStar && gunReady(me)) {
    if (!(enemy.status && enemy.status.shielded)) {
      return { action: "fire" };
    }
  }

  // 已占星线且无危险，守住位置
  if (!aimingAtStar) {
    return { action: "turn", dir: starDir };
  }

  // 已瞄准星星且无危险，守位不动
  return { action: "hold" };
}

/**
 * 【星星争夺预瞄】双方都靠近星星时，提前瞄准星星方向准备开火
 * 条件：敌人距星<=2、我距星<=4、我能瞄准星星、我路径不比敌人长
 */
function findContestedStarGuard(me, enemyTank, game) {
  if (!game.star || !enemyTank || !gunReady(me)) return null;
  var myPos = me.tank.position;
  var enemyPos = enemyTank.position;

  var enemyToStar = manhattan(enemyPos, game.star);
  if (enemyToStar > 2) return null; // 敌人离星星还不够近
  if (manhattan(myPos, game.star) > 4) return null; // 我离星星太远

  var dir = clearShotDirection(myPos, game.star, game);
  if (!dir) return null; // 必须能瞄准星星

  // 确保我跑去星星的路径距离不比敌人长太多
  if (pathDistance(enemyPos, game.star, game, myPos) > enemyToStar) return null;
  return { dir: dir };
}

/**
 * 【紧急逃生传送】受子弹威胁且常规移动无法躲避时，传送逃生
 * preferDistance=true 表示优先远离敌人
 */
function findEscapeTeleport(me, enemyTank, enemyBullet, game) {
  if (!teleportReady(me) || !bulletThreatens(enemyBullet, me.tank.position, game)) return null;
  return bestTeleportTile(me.tank.position, enemyTank, enemyBullet, game, game.star, true);
}

/**
 * 【传送抢星】走路太远时用传送抢星星
 * - 走路<=5步不浪费传送
 * - 优先直接传到星星上
 * - 看不到敌人时估算其位置，避开危险区域
 */
function findStarTeleport(me, enemyTank, enemyBullet, game) {
  if (!teleportReady(me) || !game.star) return null;
  var enemyPos = enemyTank ? enemyTank.position : null;
  var walkDist = pathDistance(me.tank.position, game.star, game, enemyPos);

  // 走路5步以内不浪费传送
  if (walkDist >= 0 && walkDist <= 5) return null;

  // 丢失视野时，估算敌人老家位置，避开可能的危险区域
  if (!enemyTank) {
    var enemyGuess = estimateEnemyHome(me.tank.position, game);
    if (enemyGuess && manhattan(game.star, enemyGuess) <= ASSASSIN_MAX_RANGE) {
      return bestUnknownEnemyStarTeleport(me.tank.position, enemyGuess, enemyBullet, game);
    }
  }

  // 优先直接传送到星星上
  if (isTeleportSafe(game.star, enemyTank, enemyBullet, game, false)) return game.star;

  // 星星上不安全则传送到星星附近最安全的点
  return bestTeleportTile(me.tank.position, enemyTank, enemyBullet, game, game.star, false);
}

/**
 * 【盲区传送抢星】看不到敌人时，找安全的星星附近传送点
 * 避开敌人估算位置，优先靠近星星且远离边缘
 */
function bestUnknownEnemyStarTeleport(myPos, enemyGuess, enemyBullet, game) {
  var best = null;
  var bestScore = -9999;
  for (var x = 0; x < game.map.length; x++) {
    for (var y = 0; y < game.map[x].length; y++) {
      var p = [x, y];
      if (samePos(p, myPos)) continue;
      if (!isPassable(game, p, null)) continue; // 不能是墙或土块
      if (bulletThreatens(enemyBullet, p, game)) continue; // 不能在子弹轨迹上
      if (manhattan(p, enemyGuess) <= ASSASSIN_MAX_RANGE) continue; // 避开敌人可能出现的地方

      var score = -manhattan(p, game.star) * 3 + distanceFromEdges(p, game);
      if (score > bestScore) {
        bestScore = score;
        best = p;
      }
    }
  }
  return best;
}

/**
 * 【通用传送选点】遍历全图，评估并返回最佳传送落点
 * - preferDistance=true：偏好远离敌人（逃生模式）
 * - preferDistance=false：偏好靠近目标（抢星/进攻模式）
 */
function bestTeleportTile(myPos, enemyTank, enemyBullet, game, target, preferDistance) {
  var best = null;
  var bestScore = -9999;
  for (var x = 0; x < game.map.length; x++) {
    for (var y = 0; y < game.map[x].length; y++) {
      var p = [x, y];
      if (samePos(p, myPos)) continue;
      if (!isTeleportSafe(p, enemyTank, enemyBullet, game, preferDistance)) continue;

      var enemyPos = enemyTank ? enemyTank.position : null;
      // 偏好远离敌人
      var enemyScore = enemyPos ? manhattan(p, enemyPos) : 0;
      // 偏好靠近目标（如星星）
      var targetScore = target ? -manhattan(p, target) * 2 : 0;

      var score = distanceFromEdges(p, game) + targetScore + (preferDistance ? enemyScore : 0);
      if (score > bestScore) {
        bestScore = score;
        best = p;
      }
    }
  }
  return best;
}

/**
 * 【传送安全校验】判断坐标是否适合传送
 * - 可通过（空地/草丛）
 * - 不在子弹位置上
 * - 不被敌人瞄准
 * - 不在子弹轨迹上
 * - preferDistance=true时，落点距敌>4（避免开火锁定）
 */
function isTeleportSafe(p, enemyTank, enemyBullet, game, preferDistance) {
  var enemyPos = enemyTank ? enemyTank.position : null;
  if (!isPassable(game, p, enemyPos)) return false;
  if (enemyBullet && samePos(p, enemyBullet.position)) return false;
  if (enemyAimsAt(p, enemyTank, game)) return false;
  if (bulletThreatens(enemyBullet, p, game)) return false;
  // 逃生模式：避免落点在敌人脸前（<=4格会被开火锁定）
  if (preferDistance && enemyPos && manhattan(p, enemyPos) <= 4) return false;
  return true;
}

/**
 * 【战术走位决策】BFS寻路优先级：星星 → 射击轨道 → 靠近敌人 → 地图中心
 * - 领先时不贴脸（保持3-5格距离压制），落后时积极靠近
 * - 快结束时提高吃星紧迫感
 */
function chooseStep(me, enemy, game, enemyPos, isLeading, isTrailing, framesLeft) {
  var myPos = me.tank.position;

  // 1. 有星星时，判断是否值得去追
  if (game.star) {
    var starPath = shortestPathInfo(myPos, game.star, game, enemyPos);
    // 落后或快结束时降低追星门槛
    if (shouldChaseStar(myPos, enemyPos, game, starPath, isTrailing, framesLeft)) return starPath.step;
  }

  // 2. 看到敌人时，走位找射击轨道或靠近敌人
  if (enemyPos) {
    var laneStep = nextStepToFiringLane(myPos, enemyPos, game);
    if (laneStep) return laneStep;
    // 领先时不贴脸靠近（保持距离压制），落后时积极靠近
    if (!isLeading) {
      return nextStepNearEnemy(myPos, enemyPos, game);
    } else {
      // 领先时保持3-5格距离，不主动贴脸
      var dist = manhattan(myPos, enemyPos);
      if (dist > 5) return nextStepNearEnemy(myPos, enemyPos, game);
      return null; // 距离合适，不主动靠近
    }
  }

  // 3. 都没有就往地图中心走
  var center = nearestOpenToCenter(game);
  return center ? nextStepToward(myPos, center, game, null) : null;
}

/**
 * 【追星决策】判断是否值得放弃交战去追星星
 * - 看不到敌人必追
 * - 落后时降低追星门槛（+2格容忍度）
 * - 快结束时更积极抢星（+3格容忍度）
 */
function shouldChaseStar(myPos, enemyPos, game, starPath, isTrailing, framesLeft) {
  if (!game.star || !starPath || starPath.dist < 0) return false;
  if (!enemyPos) return true; // 看不到敌人必追

  // 快结束时更积极抢星
  var urgencyBonus = framesLeft <= 30 ? 3 : 0;
  // 落后时更积极抢星
  var trailBonus = isTrailing ? 2 : 0;

  var closeThreshold = 5 + urgencyBonus + trailBonus;
  if (manhattan(myPos, game.star) <= closeThreshold) return true;

  var enemyDist = pathDistance(enemyPos, game.star, game, myPos);
  // 如果比敌人更近（或差不多），就去抢
  return enemyDist < 0 || starPath.dist <= enemyDist + 2 + urgencyBonus;
}

/**
 * 【BFS寻射击位】寻找能打到敌人的射击轨道的下一步走位
 * 目标：距离敌人2-9格且同线无遮挡
 */
function nextStepToFiringLane(myPos, enemyPos, game) {
  return nextStepToGoal(myPos, game, enemyPos, function (p) {
    if (samePos(p, myPos)) return false;
    var d = manhattan(p, enemyPos);
    return d >= 2 && d <= 9 && !!clearShotDirection(p, enemyPos, game);
  });
}

/**
 * 【BFS靠近敌人】寻找靠近敌人的下一步走位
 * 目标：距离敌人2-4格（安全距离）
 */
function nextStepNearEnemy(myPos, enemyPos, game) {
  return nextStepToGoal(myPos, game, enemyPos, function (p) {
    var d = manhattan(p, enemyPos);
    return d >= 2 && d <= 4;
  });
}

/**
 * 【通用BFS寻路】寻找符合isGoal条件的最近格子，回溯返回第一步移动坐标
 */
function nextStepToGoal(start, game, enemyPos, isGoal) {
  var w = game.map.length;
  var h = game.map[0].length;
  var queue = [start];
  var seen = {};
  var prev = {};
  seen[key(start)] = true;

  for (var qi = 0; qi < queue.length; qi++) {
    var p = queue[qi];
    if (isGoal(p)) return firstStep(start, p, prev); // 找到目标，回溯第一步

    for (var i = 0; i < DIRS.length; i++) {
      var n = [p[0] + DIRS[i].dx, p[1] + DIRS[i].dy];
      var k = key(n);
      if (seen[k]) continue;
      if (n[0] < 0 || n[1] < 0 || n[0] >= w || n[1] >= h) continue;
      if (!isPassable(game, n, enemyPos)) continue;

      seen[k] = true;
      prev[k] = p;
      queue.push(n);
    }
  }
  return null;
}

/**
 * 【破墙寻路】寻找可破坏土块的方向（抄近道）
 * 打分：土块距离*3 + 打碎后到目标的距离，选最优方向
 */
function findDigDirection(pos, game, target) {
  var bestDir = null;
  var bestScore = 9999;
  for (var i = 0; i < DIRS.length; i++) {
    var d = DIRS[i];
    var x = pos[0] + d.dx;
    var y = pos[1] + d.dy;
    var range = 1;

    // 沿该方向查找，直到遇到墙
    while (tileAt(game, [x, y]) !== "x") {
      var t = tileAt(game, [x, y]);
      if (t === "m") { // 发现土块
        var after = [x + d.dx, y + d.dy];
        var targetScore = target ? manhattan(after, target) : 0;
        var score = range * 3 + targetScore;
        if (score < bestScore) {
          bestScore = score;
          bestDir = d.name;
        }
        break;
      }
      x += d.dx;
      y += d.dy;
      range++;
    }
  }
  return bestDir;
}

/**
 * 【破墙收益校验】只有当破墙后能实际缩短到目标的路径时才值得挖
 * 比较：当前绕路 BFS 距离 vs 破墙后的曼哈顿距离（近似）
 */
function digHelpsReach(pos, digDir, target, game) {
  if (!target) return false;
  var walkDist = pathDistance(pos, target, game, null);
  // 找该方向上的土块位置
  var di = dirIndex(digDir);
  if (di < 0) return false;
  var d = DIRS[di];
  var x = pos[0] + d.dx, y = pos[1] + d.dy;
  while (tileAt(game, [x, y]) !== "x") {
    if (tileAt(game, [x, y]) === "m") {
      // 破墙后落点
      var after = [x + d.dx, y + d.dy];
      var afterDist = manhattan(after, target);
      // 只有绕路明显更远时才破墙（至少节省 3 步）
      return walkDist < 0 || afterDist < walkDist - 3;
    }
    x += d.dx; y += d.dy;
  }
  return false;
}

/**
 * 【地图中心定位】寻找最靠近地图中心的可行走空地
 */
function nearestOpenToCenter(game) {
  var cx = Math.floor(game.map.length / 2);
  var cy = Math.floor(game.map[0].length / 2);
  var best = null;
  var bestScore = 9999;

  for (var x = 0; x < game.map.length; x++) {
    for (var y = 0; y < game.map[x].length; y++) {
      var p = [x, y];
      if (!isPassable(game, p, null)) continue;
      var score = Math.abs(x - cx) + Math.abs(y - cy);
      if (score < bestScore) {
        bestScore = score;
        best = p;
      }
    }
  }
  return best;
}

/**
 * 【子弹躲避】寻找躲避子弹的安全邻近格子
 * - 垂直子弹往左右躲，水平子弹往上下躲
 * - 躲避点不能也在子弹轨迹上
 * - overload双弹时检查侧线威胁
 * - 躲避点不能被敌人预瞄
 * - 偏好无需转向、远离边缘、靠近星星的方向
 */
function findBulletDodge(me, enemy, game, enemyPos) {
  if (!enemy || !enemy.bullet) return null;
  var myPos = me.tank.position;
  var b = enemy.bullet;

  // 仅在子弹确实会命中当前格时才需要侧躲（调用方已先判威胁，这里再兜底一次）
  if (!bulletThreatens(b, myPos, game)) return null;

  // 垂直子弹往左右躲，水平子弹往上下躲
  var candidates = [];
  if (b.direction === "left" || b.direction === "right") {
    candidates.push([myPos[0], myPos[1] - 1], [myPos[0], myPos[1] + 1]);
  } else {
    candidates.push([myPos[0] - 1, myPos[1]], [myPos[0] + 1, myPos[1]]);
  }

  // overload双弹：敌方过载时，子弹可能走侧线
  var isOverload = enemy.status && enemy.status.overloaded;

  var best = null;
  var bestScore = -9999;

  for (var i = 0; i < candidates.length; i++) {
    var p = candidates[i];
    if (!isPassable(game, p, enemyPos)) continue;
    if (bulletThreatens(b, p, game)) continue; // 躲避点不能也吃子弹
    // overload双弹时检查侧线威胁
    if (isOverload && overloadSideThreatens(b, p, game)) continue;
    if (enemyAimsAt(p, enemy && enemy.tank, game)) continue; // 躲避点不能被预瞄

    var stepDir = directionBetween(myPos, p);
    // 偏好无需转向、远离边缘、靠近星星
    var score = distanceFromEdges(p, game) + (stepDir === me.tank.direction ? 10 : 0) + (game.star ? -manhattan(p, game.star) * 0.1 : 0);
    if (score > bestScore) {
      bestScore = score;
      best = p;
    }
  }
  return best;
}

/**
 * 【防范预瞄】若敌人正在瞄准我，尝试横向移动避开
 * - 近距离（<=4格）被瞄准必须躲
 * - 远距离（>4格）不躲，可以开火压制
 * - 躲避点不能也被瞄准
 */
function findAimDodge(me, enemyTank, game, enemyPos) {
  if (!enemyAimsAt(me.tank.position, enemyTank, game)) return null;
  var myPos = me.tank.position;
  var dist = enemyPos ? manhattan(myPos, enemyPos) : 99;

  // 远距离被瞄准不急躲，可以开火压制
  if (dist > 4) return null;

  // 收集所有安全的横向躲避候选格
  var candidates = [];
  for (var i = 0; i < DIRS.length; i++) {
    var p = [myPos[0] + DIRS[i].dx, myPos[1] + DIRS[i].dy];
    if (!isPassable(game, p, enemyPos)) continue;
    if (enemyAimsAt(p, enemyTank, game)) continue; // 躲避点不能也被瞄准
    candidates.push(p);
  }

  if (candidates.length === 0) return null;

  // 选最佳躲避格：偏好靠近星星、远离边缘、无需转向
  var best = null;
  var bestScore = -9999;
  for (var j = 0; j < candidates.length; j++) {
    var cp = candidates[j];
    var stepDir = directionBetween(myPos, cp);
    var score = distanceFromEdges(cp, game) + (stepDir === me.tank.direction ? 5 : 0) + (game.star ? -manhattan(cp, game.star) * 0.2 : 0);
    if (score > bestScore) {
      bestScore = score;
      best = cp;
    }
  }
  return best;
}

/**
 * 【子弹威胁判断】判断指定坐标是否受到给定子弹的威胁
 * - 同行/同列 + 子弹朝向正确 + 中间无遮挡 + ETA 在阈值内（按1帧2格的真实速度）
 * - 用 ETA 取代固定格数上限，远距离同线子弹也能被感知（修复原地摇摆被秒）
 */
function bulletThreatens(bullet, pos, game) {
  if (!bullet || !bullet.position) return false;
  var bp = bullet.position;

  // 在同一列且子弹朝下/朝上
  if (bp[0] === pos[0]) {
    var dy = pos[1] - bp[1];
    if (bullet.direction === "down" && dy > 0 && Math.ceil(dy / 2) <= BULLET_THREAT_ETA) return clearBetween(bp, pos, game);
    if (bullet.direction === "up" && dy < 0 && Math.ceil(-dy / 2) <= BULLET_THREAT_ETA) return clearBetween(bp, pos, game);
  }
  // 在同一行且子弹朝右/朝左
  if (bp[1] === pos[1]) {
    var dx = pos[0] - bp[0];
    if (bullet.direction === "right" && dx > 0 && Math.ceil(dx / 2) <= BULLET_THREAT_ETA) return clearBetween(bp, pos, game);
    if (bullet.direction === "left" && dx < 0 && Math.ceil(-dx / 2) <= BULLET_THREAT_ETA) return clearBetween(bp, pos, game);
  }
  return false;
}

/**
 * 【子弹ETA计算】计算子弹到达指定位置的帧数
 * 子弹1帧走2格，向上取整
 */
function bulletETA(bullet, pos) {
  if (!bullet || !bullet.position) return 999;
  var bp = bullet.position;
  var dist = 0;
  if (bp[0] === pos[0]) {
    dist = Math.abs(bp[1] - pos[1]);
  } else if (bp[1] === pos[1]) {
    dist = Math.abs(pos[0] - bp[0]);
  } else {
    return 999; // 不在同线
  }
  return Math.ceil(dist / 2); // 1帧2格
}

/**
 * 【overload侧线威胁】过载双弹时，侧线偏移1格的威胁判断
 * 垂直飞行子弹检查左右侧线，水平飞行子弹检查上下侧线
 */
function overloadSideThreatens(bullet, pos, game) {
  if (!bullet || !bullet.position) return false;
  var bp = bullet.position;

  if (bullet.direction === "up" || bullet.direction === "down") {
    // 垂直飞行，检查左右侧线（x偏移±1）
    if (bp[0] === pos[0] + 1 || bp[0] === pos[0] - 1) {
      var dy = pos[1] - bp[1];
      if (bullet.direction === "down" && dy > 0 && dy <= BULLET_LOOKAHEAD_TILES) return true;
      if (bullet.direction === "up" && dy < 0 && -dy <= BULLET_LOOKAHEAD_TILES) return true;
    }
  } else {
    // 水平飞行，检查上下侧线（y偏移±1）
    if (bp[1] === pos[1] + 1 || bp[1] === pos[1] - 1) {
      var dx = pos[0] - bp[0];
      if (bullet.direction === "right" && dx > 0 && dx <= BULLET_LOOKAHEAD_TILES) return true;
      if (bullet.direction === "left" && dx < 0 && -dx <= BULLET_LOOKAHEAD_TILES) return true;
    }
  }
  return false;
}

/**
 * 【近距炮口必死判断】敌人当前炮口 + 下一帧可能炮口，是否锁定指定格（仅近距启用）
 * 敌人每帧只能 1 个动作，下一发子弹只可能来自 {当前朝向, 左转90, 右转90} 三条线
 * （180度需2帧）。仅在 manhattan<=4 的近距启用，避免远距过度保守不敢占星线。
 * 复用 clearShotDirection（同线+无遮挡）。
 */
function enemyMuzzleLethal(pos, enemyTank, game) {
  if (!enemyTank || !enemyTank.position || !enemyTank.direction) return false;
  var ep = enemyTank.position;
  if (manhattan(pos, ep) > 4) return false; // 仅近距
  var lineDir = clearShotDirection(ep, pos, game);
  if (!lineDir) return false; // 不同线或被遮挡 → 安全
  // 敌人当前已对准 pos
  if (lineDir === enemyTank.direction) return true;
  // 敌人下一帧转 90 度即可对准（左转/右转后的朝向 == lineDir）
  var li = dirIndex(enemyTank.direction);
  if (li < 0) return false;
  var leftDir = DIRS[(li + 3) % 4].name;
  var rightDir = DIRS[(li + 1) % 4].name;
  return lineDir === leftDir || lineDir === rightDir;
}

/**
 * 【必死格统一判断】把多条保命硬约束收敛到一处，供 move 过滤 / hold 校验 / 星点路径校验复用
 * 规则：① 当前在场子弹会按真实ETA命中该格 ② overload 双弹侧线会命中
 *       ③ 敌人近距炮口（含下一帧可能炮口）锁定该格
 * 不在此处做"敌人远距瞄准"——那属于收益权衡，留给评分。
 */
function isLethalTile(pos, enemyTank, enemyBullet, game, foeOverloaded) {
  if (bulletThreatens(enemyBullet, pos, game)) return true;
  if (foeOverloaded && overloadSideThreatens(enemyBullet, pos, game)) return true;
  if (enemyMuzzleLethal(pos, enemyTank, game)) return true;
  return false;
}

/**
 * 【安全移动】向目标方向移动，如果下一步不安全则改走安全邻格
 * 安全检查：可通过、不被预瞄、不在子弹轨迹上
 */
function moveToward(me, game, next, enemyPos, enemyTank, enemyBullet) {
  var myPos = me.tank.position;

  // 危险校验：不通、被预瞄、会接子弹 → 改走其他安全路径
  if (!isPassable(game, next, enemyPos) || enemyAimsAt(next, enemyTank, game) || bulletThreatens(enemyBullet, next, game)) {
    var safer = bestSafeNeighbor(myPos, game, enemyPos, enemyTank, enemyBullet);
    if (safer && !samePos(safer, next)) {
      moveToward(me, game, safer, enemyPos, enemyTank, enemyBullet);
      return;
    }
    // 无路可退，转向
    me.turn("right");
    return;
  }

  var dir = directionBetween(myPos, next);
  if (!dir) return;

  // 方向一致则前进，否则转向该方向
  if (me.tank.direction === dir) {
    me.go();
  } else {
    turnToward(me, dir);
  }
}

/**
 * 【最优转向】根据目标方向选择左转或右转（选最短路径）
 */
function turnToward(me, desired) {
  var cur = dirIndex(me.tank.direction);
  var dst = dirIndex(desired);
  if (cur < 0 || dst < 0 || cur === dst) return;
  var diff = (dst - cur + 4) % 4;
  if (diff === 1) me.turn("right");
  else if (diff === 3) me.turn("left");
  else me.turn("right"); // 转180度时随便选
}

/**
 * 【转向方向预判】turnToward 在当前朝向→目标朝向时会选择的 side（与 turnToward 一致）
 * 返回 "left"/"right"，无需转向时返回 null。供反摇摆迟滞使用。
 */
function turnSideFor(currentDir, desired) {
  var cur = dirIndex(currentDir);
  var dst = dirIndex(desired);
  if (cur < 0 || dst < 0 || cur === dst) return null;
  var diff = (dst - cur + 4) % 4;
  if (diff === 3) return "left";
  return "right"; // diff===1 或 180度
}

/**
 * 【转向代价】计算两个方向之间需要转几次（90度=1，180度=2）
 */
function turnDistance(from, to) {
  var cur = dirIndex(from);
  var dst = dirIndex(to);
  if (cur < 0 || dst < 0) return 2;
  var diff = (dst - cur + 4) % 4;
  return Math.min(diff, 4 - diff);
}

/**
 * 【BFS寻路】获取走向目标坐标的下一步
 */
function nextStepToward(start, target, game, enemyPos) {
  var info = shortestPathInfo(start, target, game, enemyPos);
  return info ? info.step : null;
}

/**
 * 【BFS最短路径】计算到目标的最短路径长度，并返回第一步移动坐标
 * 返回 { dist: 步数, step: [x,y] } 或 null
 */
function shortestPathInfo(start, target, game, blockPos) {
  if (!target) return null;
  if (samePos(start, target)) return { dist: 0, step: null };
  var w = game.map.length;
  var h = game.map[0].length;
  var queue = [start];
  var seen = {};
  var prev = {};
  var dist = {};
  seen[key(start)] = true;
  dist[key(start)] = 0;

  for (var qi = 0; qi < queue.length; qi++) {
    var p = queue[qi];
    for (var i = 0; i < DIRS.length; i++) {
      var n = [p[0] + DIRS[i].dx, p[1] + DIRS[i].dy];
      var k = key(n);
      if (seen[k]) continue;
      if (n[0] < 0 || n[1] < 0 || n[0] >= w || n[1] >= h) continue;

      // 非目标格要求可通过，目标格可以容忍被敌人占据
      if (!samePos(n, target) && !isPassable(game, n, blockPos)) continue;
      if (samePos(n, target) && !isPassable(game, n, null) && !samePos(target, blockPos)) continue;

      seen[k] = true;
      prev[k] = p;
      dist[k] = dist[key(p)] + 1;

      if (samePos(n, target)) {
        return { dist: dist[k], step: firstStep(start, n, prev) };
      }
      queue.push(n);
    }
  }
  return null;
}

/**
 * 【路径回溯】从prev记录中回溯，获取前往目标的第一步坐标
 */
function firstStep(start, target, prev) {
  var cur = target;
  while (prev[key(cur)] && !samePos(prev[key(cur)], start)) {
    cur = prev[key(cur)];
  }
  return samePos(cur, start) ? null : cur;
}

/**
 * 【路径距离】返回经过可行走区域到目标的步数，不可达返回-1
 */
function pathDistance(start, target, game, blockPos) {
  var info = shortestPathInfo(start, target, game, blockPos);
  return info ? info.dist : -1;
}

/**
 * 【安全邻格】寻找当前位置周围最安全的一个可行走邻接格子
 * 避开被瞄准、子弹轨迹上的格子，偏好靠近地图中心
 */
function bestSafeNeighbor(pos, game, enemyPos, enemyTank, enemyBullet) {
  var best = null;
  var bestScore = -9999;
  for (var i = 0; i < DIRS.length; i++) {
    var p = [pos[0] + DIRS[i].dx, pos[1] + DIRS[i].dy];
    if (!isPassable(game, p, enemyPos)) continue;
    if (enemyAimsAt(p, enemyTank, game)) continue;
    if (bulletThreatens(enemyBullet, p, game)) continue;
    var score = distanceFromEdges(p, game); // 尽量往中间靠
    if (score > bestScore) {
      bestScore = score;
      best = p;
    }
  }
  return best;
}

/**
 * 【射击方向】如果两点在同一直线上且无遮挡，返回射击方向，否则null
 */
function clearShotDirection(from, to, game) {
  if (!to) return null;
  if (from[0] === to[0]) {
    if (clearBetween(from, to, game)) return to[1] < from[1] ? "up" : "down";
  }
  if (from[1] === to[1]) {
    if (clearBetween(from, to, game)) return to[0] < from[0] ? "left" : "right";
  }
  return null;
}

/**
 * 【敌方瞄准判断】判断敌方炮口是否正在瞄准指定位置且视线清晰
 */
function enemyAimsAt(pos, enemyTank, game) {
  if (!enemyTank || !enemyTank.position || !enemyTank.direction) return false;
  var dir = clearShotDirection(enemyTank.position, pos, game);
  return dir === enemyTank.direction;
}

/**
 * 【方向前进】获取沿某方向前进一步的坐标
 */
function nextInDirection(pos, dir) {
  var d = DIRS[dirIndex(dir)];
  if (!d) return pos;
  return [pos[0] + d.dx, pos[1] + d.dy];
}

/**
 * 【敌方出生点估算】基于地图对称性估算敌方出生位置
 */
function estimateEnemyHome(myPos, game) {
  if (!myPos || !game || !game.map || !game.map.length) return null;
  return [game.map.length - 1 - myPos[0], game.map[0].length - 1 - myPos[1]];
}

/**
 * 【视线检测】检查两点之间是否没有墙(x)或土块(m)遮挡
 */
function clearBetween(a, b, game) {
  var dx = sign(b[0] - a[0]);
  var dy = sign(b[1] - a[1]);
  var x = a[0] + dx;
  var y = a[1] + dy;
  while (x !== b[0] || y !== b[1]) {
    var t = tileAt(game, [x, y]);
    if (t === "x" || t === "m") return false;
    x += dx;
    y += dy;
  }
  return true;
}

/**
 * 【可通过检查】检查网格是否可行走（空地/草丛，且未被敌人占据）
 */
function isPassable(game, p, enemyPos) {
  var t = tileAt(game, p);
  if (t !== "." && t !== "o") return false; // 只能是空地或草丛
  if (samePos(p, enemyPos)) return false; // 不能是敌人位置
  return true;
}

/**
 * 【安全取格】获取地图上的网格元素，越界当做墙壁"x"
 */
function tileAt(game, p) {
  if (!p || p[0] < 0 || p[1] < 0 || p[0] >= game.map.length || p[1] >= game.map[0].length) return "x";
  return game.map[p[0]][p[1]];
}

/**
 * 【方向判断】获取a到相邻格子b的方向名称
 */
function directionBetween(a, b) {
  if (b[0] === a[0] && b[1] === a[1] - 1) return "up";
  if (b[0] === a[0] + 1 && b[1] === a[1]) return "right";
  if (b[0] === a[0] && b[1] === a[1] + 1) return "down";
  if (b[0] === a[0] - 1 && b[1] === a[1]) return "left";
  return null;
}

/**
 * 【方向索引】根据方向名称获取对应的DIRS数组索引
 */
function dirIndex(dir) {
  for (var i = 0; i < DIRS.length; i++) {
    if (DIRS[i].name === dir) return i;
  }
  return -1;
}

/**
 * 【边缘距离】计算坐标距四条边界的最短距离（越小越靠边，越大越靠中心）
 */
function distanceFromEdges(p, game) {
  return Math.min(p[0], p[1], game.map.length - 1 - p[0], game.map[0].length - 1 - p[1]);
}

/**
 * 【曼哈顿距离】计算两点之间的曼哈顿距离 |dx|+|dy|
 */
function manhattan(a, b) {
  return Math.abs(a[0] - b[0]) + Math.abs(a[1] - b[1]);
}

/**
 * 【坐标相等】判断两点坐标是否相等
 */
function samePos(a, b) {
  return !!a && !!b && a[0] === b[0] && a[1] === b[1];
}

/**
 * 【坐标哈希】生成坐标的哈希Key字符串，用于查重/集合
 */
function key(p) {
  return p[0] + "," + p[1];
}

/**
 * 【符号函数】获取数值的符号位 (-1, 0, 1)
 */
function sign(n) {
  if (n > 0) return 1;
  if (n < 0) return -1;
  return 0;
}

// ==================== 卡死检测模块 ====================

/**
 * 【更新卡死历史】记录当前位置到历史队列，保持最近N个位置
 * 用于检测坦克是否在两点间来回振荡
 */
function updateStuckHistory(pos) {
  var k = key(pos);
  STUCK_HISTORY.push(k);
  if (STUCK_HISTORY.length > STUCK_MAX_HISTORY) {
    STUCK_HISTORY.shift(); // 保持队列长度
  }
}

/**
 * 【振荡检测】检测最近位置是否在两点间来回振荡
 * 如果最近4个位置是 A→B→A→B 模式，判定为卡死
 */
function isStuckOscillating() {
  if (STUCK_HISTORY.length < 4) return false;
  var len = STUCK_HISTORY.length;
  // 检查最近4个位置是否为 A→B→A→B 模式
  var a = STUCK_HISTORY[len - 4];
  var b = STUCK_HISTORY[len - 3];
  var c = STUCK_HISTORY[len - 2];
  var d = STUCK_HISTORY[len - 1];
  if (a === c && b === d && a !== b) {
    STUCK_OSCILLATE_COUNT++;
    return STUCK_OSCILLATE_COUNT >= 2; // 连续2次振荡才触发
  }
  STUCK_OSCILLATE_COUNT = 0;
  return false;
}

/**
 * 【打破卡死】寻找一个安全方向来打破卡死循环
 * 优先选择不被瞄准、不在子弹轨迹上、不靠墙的方向
 */
function findBreakDirection(myPos, game, enemyPos, enemyTank, enemyBullet) {
  var bestDir = null;
  var bestScore = -9999;

  for (var i = 0; i < DIRS.length; i++) {
    var d = DIRS[i];
    var p = [myPos[0] + d.dx, myPos[1] + d.dy];
    if (!isPassable(game, p, enemyPos)) continue;
    if (enemyAimsAt(p, enemyTank, game)) continue;
    if (bulletThreatens(enemyBullet, p, game)) continue;

    // 偏好远离边缘、靠近星星的方向
    var score = distanceFromEdges(p, game) * 2;
    if (game.star) score -= manhattan(p, game.star); // 靠近星星加分
    // 避免走入死角（可通行邻格<2的方向减分）
    if (countOpenNeighbors(p, game, enemyPos) < 2) score -= 20;

    if (score > bestScore) {
      bestScore = score;
      bestDir = d.name;
    }
  }
  return bestDir;
}

// ==================== 死角与地形分析模块 ====================

/**
 * 【死角检测】判断坐标是否为死角（可通行邻格<=1）
 * 走入死角容易被敌人逼死
 */
function isDeadEnd(pos, game, enemyPos) {
  return countOpenNeighbors(pos, game, enemyPos) <= 1;
}

/**
 * 【邻格计数】计算坐标周围可通行的邻接格子数量
 */
function countOpenNeighbors(pos, game, enemyPos) {
  var count = 0;
  for (var i = 0; i < DIRS.length; i++) {
    var p = [pos[0] + DIRS[i].dx, pos[1] + DIRS[i].dy];
    if (isPassable(game, p, enemyPos)) count++;
  }
  return count;
}

// ==================== 反传送防御模块 ====================

/**
 * 【敌方传送就绪检查】判断敌方是否为传送技能且冷却就绪
 */
function enemyTeleportReady(enemy) {
  return enemy && enemy.skill && enemy.skill.type === "teleport" && enemy.skill.remainingCooldownFrames === 0;
}

/**
 * 【反传送防御】面对传送技能敌人时，寻找安全的防御位置
 * 预判敌人可能的传送刺杀落点，避开危险区域
 * 返回安全坐标或null
 */
function findAntiTeleportPosition(myPos, enemyPos, enemyTank, enemyBullet, game) {
  if (!enemyPos) return null;

  // 收集所有安全的邻格
  var safeNeighbors = [];
  for (var i = 0; i < DIRS.length; i++) {
    var p = [myPos[0] + DIRS[i].dx, myPos[1] + DIRS[i].dy];
    if (!isPassable(game, p, enemyPos)) continue;
    if (enemyAimsAt(p, enemyTank, game)) continue;
    if (bulletThreatens(enemyBullet, p, game)) continue;

    // 检查该位置是否可能被敌人传送刺杀
    // 敌人可能传送到距离我5-8格且能射击我的位置
    var vulnerable = false;
    for (var j = 0; j < DIRS.length && !vulnerable; j++) {
      var dir = DIRS[j];
      for (var range = ASSASSIN_MIN_RANGE; range <= ASSASSIN_MAX_RANGE; range++) {
        var ambushPos = [p[0] - dir.dx * range, p[1] - dir.dy * range];
        if (isPassable(game, ambushPos, null) && clearShotDirection(ambushPos, p, game) === dir.name) {
          vulnerable = true;
          break;
        }
      }
    }
    if (!vulnerable) {
      safeNeighbors.push(p);
    }
  }

  if (safeNeighbors.length === 0) return null;

  // 选最佳防御位置：偏好靠近星星、远离边缘
  var best = null;
  var bestScore = -9999;
  for (var k = 0; k < safeNeighbors.length; k++) {
    var sp = safeNeighbors[k];
    var score = distanceFromEdges(sp, game) * 2 + countOpenNeighbors(sp, game, enemyPos) * 3;
    if (game.star) score -= manhattan(sp, game.star);
    if (score > bestScore) {
      bestScore = score;
      best = sp;
    }
  }
  return best;
}

/**
 * 【草丛伏击】检查是否可以利用草丛进行伏击
 * 如果当前位置是草丛且敌人看不到我，可以等待伏击
 * 返回 true 表示应该在草丛中等待
 */
function shouldGrassAmbush(me, enemyTank, game) {
  if (!enemyTank) return false; // 已经看不到敌人了
  var myPos = me.tank.position;
  // 当前位置必须是草丛
  if (tileAt(game, myPos) !== "o") return false;
  // 敌人距离适中（3-6格），太远伏击没意义，太近危险
  var dist = manhattan(myPos, enemyTank.position);
  if (dist < 3 || dist > 6) return false;
  // 炮管就绪才能伏击
  if (!gunReady(me)) return false;
  // 能瞄准敌人才能伏击
  return !!clearShotDirection(myPos, enemyTank.position, game);
}

// ==================== 评分系统：核心打分函数 ====================

function scorePosition(pos, me, enemy, game, enemyPos, enemyTank, enemyBullet, isLeading, isTrailing, framesLeft) {
  var score = 0;
  if (game.star) {
    var foeOL = !!(enemy && enemy.status && enemy.status.overloaded);
    // 规则6：星点本身是必死点时，不给抢星收益，避免评分诱导往必死星走
    var starLethal = isLethalTile(game.star, enemyTank, enemyBullet, game, foeOL);
    if (!starLethal) {
      var ds = manhattan(pos, game.star);
      var urg = isTrailing ? 2.0 : 1.0;
      if (framesLeft <= 30) urg = Math.max(urg, 3.0);
      score += Math.max(0, 25 - ds * 3) * urg;
      if (clearShotDirection(pos, game.star, game)) score += 15 * urg;
      // 站上星星=直接得分，给一个明确的高额收益，避免站在星线上空守不吃免费星
      if (samePos(pos, game.star)) score += 40 * urg;
    }
  }
  if (enemyPos) {
    var de = manhattan(pos, enemyPos);
    var ideal = isLeading ? 5 : 3;
    score += -Math.abs(de - ideal) * 3;
    if (de > 8) score -= 10;
    if (de <= 1) score -= 20;
    var onEnemyLine = !!clearShotDirection(pos, enemyPos, game);
    if (onEnemyLine) score += 12;
    if (enemyAimsAt(pos, enemyTank, game)) {
      score -= de <= 4 ? 35 : 12;
    } else if (onEnemyLine) {
      // 同线但敌人未对准：敌人 1-2 帧可转向反打
      // 扣分要超过 +12 的开火加分，确保净效果为负，不诱导坦克走进炮口线
      score -= de <= 4 ? 20 : 15;
    }
    if (enemyTeleportReady(enemy)) score -= countTeleportVulnerableDirections(pos, enemyPos, game) * 8;
  }
  score += distanceFromEdges(pos, game) * 2;
  var oc = countOpenNeighbors(pos, game, enemyPos);
  if (oc <= 1) score -= 30;
  score += oc * 2;
  if (tileAt(game, pos) === "o" && enemyPos && clearShotDirection(pos, enemyPos, game)) {
    var gd = manhattan(pos, enemyPos);
    if (gd >= 3 && gd <= 6) score += 10;
  }
  return score;
}

function scoreFire(me, enemy, game, myPos, enemyPos, enemyTank, enemyBullet, isLeading, isTrailing, framesLeft) {
  if (enemy.status && enemy.status.shielded) return -9999;
  if (isOneHitKill(me, enemy, game, enemyPos, enemyBullet)) return 200;
  var dist = manhattan(myPos, enemyPos);
  if (dist <= 3) {
    if (enemyAimsAt(myPos, enemyTank, game)) return -9999;
    if (bulletThreatens(enemyBullet, myPos, game)) return -9999;
  }
  var s = dist > 4 ? 30 + Math.min(dist, 10) : 15;
  if (isTrailing && framesLeft > 100 && dist > 6) s -= 12;
  if (game.star && clearShotDirection(myPos, game.star, game) && manhattan(enemyPos, game.star) <= 3) s += 22;
  if (isLeading && dist <= 2) s -= 15;
  return s;
}

function generateTeleportCandidates(me, enemyTank, enemyBullet, game, isLeading, isTrailing, framesLeft) {
  var cands = [];
  var myPos = me.tank.position;
  var enemyPos = enemyTank ? enemyTank.position : null;
  if (bulletThreatens(enemyBullet, myPos, game)) {
    var ep = bestTeleportTile(myPos, enemyTank, enemyBullet, game, game.star, true);
    if (ep) cands.push({ type: 'teleport', pos: ep, dir: 'up', score: 85 });
  }
  var enemyObj = enemyTank ? { tank: enemyTank, status: {} } : null;
  var assassin = findAssassinationPlan(me, enemyObj, enemyTank, enemyBullet, game);
  if (assassin) cands.push({ type: 'teleport', pos: assassin.pos, dir: assassin.dir, score: 95 });
  if (game.star) {
    var walkDist = pathDistance(myPos, game.star, game, enemyPos);
    if (walkDist < 0 || walkDist > 5) {
      if (isTeleportSafe(game.star, enemyTank, enemyBullet, game, false)) {
        cands.push({ type: 'teleport', pos: game.star, dir: 'up', score: 72 });
      } else {
        var ns = bestTeleportTile(myPos, enemyTank, enemyBullet, game, game.star, false);
        if (ns) cands.push({ type: 'teleport', pos: ns, dir: 'up', score: 62 });
      }
    }
  }
  return cands;
}

function countTeleportVulnerableDirections(pos, enemyPos, game) {
  var count = 0;
  for (var i = 0; i < DIRS.length; i++) {
    var d = DIRS[i];
    for (var r = ASSASSIN_MIN_RANGE; r <= ASSASSIN_MAX_RANGE; r++) {
      var ap = [pos[0] - d.dx * r, pos[1] - d.dy * r];
      if (isPassable(game, ap, null) && clearShotDirection(ap, pos, game) === d.name) {
        count++;
        break;
      }
    }
  }
  return count;
}
