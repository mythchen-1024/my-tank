// ============================================================
// blackboard.js — 黑板：所有节点共享的感知上下文
//
// 职责：
//   1. 每帧刷新原始数据 + 廉价派生感知
//   2. 惰性传感器缓存（昂贵计算首次访问时才执行，本帧内复用）
//   3. 跨帧记忆管理（包装 state-store 的 MATCH_STATE）
//   4. 动作包装器（bbFire / bbMoveToward 等统一入口）
//
// 设计原则：节点只读黑板，不互相调用；传感器按需计算不浪费。
// ============================================================

var _BLACKBOARD = null;

/**
 * 获取或初始化黑板。帧数倒退视为新对局，重置全部状态。
 */
function getBlackboard(game) {
  var frame = (game && game.frames) || 0;
  if (!_BLACKBOARD || frame < (_BLACKBOARD.lastFrame || 0) - 2) {
    _BLACKBOARD = {
      // ── 原始引用 ──
      me: null, enemy: null, game: null,
      myPos: null, myDir: null,
      enemyTank: null, enemyPos: null,
      enemyBullets: [],
      frame: 0, star: null,

      // ── 廉价派生感知 ──
      gunIsReady: false,
      teleportIsReady: false,
      mySkillType: 'teleport',
      skillIsReady: false,
      shotDir: null,
      distToEnemy: 999,
      distToStar: 999,
      framesLeft: 128,
      myStars: 0, enmStars: 0,
      isLosing: false, isWinning: false, isTied: true,

      // ── 惰性传感器缓存 ──
      _cache: {},

      // ── 跨帧记忆（由 state-store.js 的 getMatchState 管理） ──
      memory: null,

      // ── Profile & 行为树 ──
      profile: null,
      tree: null,
      profileFrame: -999,

      // ── 调试追踪 ──
      _trace: [],
      _lastAction: null,
      lastFrame: 0,
    };
  }
  return _BLACKBOARD;
}

/**
 * 每帧刷新黑板：设置原始数据 → 计算廉价感知 → 清空惰性缓存 → 更新跨帧记忆。
 */
function refreshBlackboard(bb, me, enemy, game) {
  // ── 原始数据 ──
  bb.me = me;
  bb.enemy = enemy;
  bb.game = game;
  bb.frame = (game && game.frames) || 0;
  bb.lastFrame = bb.frame;
  bb.myPos = me.tank.position;
  bb.myDir = me.tank.direction;
  bb.enemyTank = (enemy && enemy.tank) ? enemy.tank : null;
  bb.enemyPos = bb.enemyTank ? bb.enemyTank.position : null;
  bb.enemyBullets = collectEnemyBullets(enemy);
  bb.star = game.star;
  bb.bombs = (game && game.bombs) || [];

  // ── 廉价派生感知（每帧必算，O(1)） ──
  bb.gunIsReady = gunReady(me);
  bb.teleportIsReady = teleportReady(me);
  bb.bombIsReady = bombReady(me);
  bb.mySkillType = getMySkillType(me);
  bb.skillIsReady = skillReady(me);
  bb.shotDir = bb.enemyPos ? clearShotDirection(bb.myPos, bb.enemyPos, game) : null;
  bb.distToEnemy = bb.enemyPos ? manhattan(bb.myPos, bb.enemyPos) : 999;
  bb.distToStar = bb.star ? manhattan(bb.myPos, bb.star) : 999;
  bb.framesLeft = MAX_GAME_FRAMES - bb.frame;
  bb.myStars = (me && me.stars) || 0;
  bb.enmStars = (enemy && enemy.stars) || 0;
  bb.isLosing = bb.myStars < bb.enmStars;
  bb.isWinning = bb.myStars > bb.enmStars;
  bb.isTied = bb.myStars === bb.enmStars;

  // ── 吃星检测：我方星数增加 → 记录吃星帧（供撤退意图使用） ──
  if (bb._prevMyStars !== undefined && bb.myStars > bb._prevMyStars) {
    bb._lastGrabFrame = bb.frame;
  }
  bb._prevMyStars = bb.myStars;

  // ── 清空惰性缓存（每帧重新计算） ──
  bb._cache = {};
  bb._trace = [];
  bb._lastAction = null;

  // ── 跨帧记忆更新 ──
  bb.memory = getMatchState(game);
  recordAssassinOutcome(bb.memory, enemy, bb.enemyTank, game);
  trackEnemyBush(bb.memory, bb.enemyTank, bb.enemy, game);
  trackEnemy(bb.memory, bb.enemyTank, bb.myPos, game);
  trackStuck(bb.memory, bb.myPos);
  cleanExpiredBombs(bb.memory, bb.frame);
  // 幽灵弹补偿：推算视锥外不可见的子弹位置（必须在 memory 初始化之后）
  var phantoms = updatePhantomBullets(bb.memory, bb.enemyBullets, game);
  for (var i = 0; i < phantoms.length; i++) bb.enemyBullets.push(phantoms[i]);
  // 合并自己的炸弹到 bombs 列表（用于自炸检查）
  for (var i = 0; i < (bb.memory.myBombs || []).length; i++) {
    bb.bombs.push(bb.memory.myBombs[i]);
  }
}

// ============================================================
// 惰性传感器框架
// ============================================================

/**
 * 惰性传感器：首次访问时调用 computeFn 并缓存结果，本帧内不再重复计算。
 * computeFn 返回 null/undefined 时缓存为 null（避免重复调用）。
 */
function sense(bb, key, computeFn) {
  if (!(key in bb._cache)) {
    bb._cache[key] = computeFn() || null;
  }
  return bb._cache[key];
}

// ---- 生存传感器 ----

function senseBulletDodge(bb) {
  return sense(bb, 'bulletDodge', function () {
    return findBulletDodge(bb.me, bb.enemy, bb.game, bb.enemyPos);
  });
}

function senseCounterShoot(bb) {
  return sense(bb, 'counterShoot', function () {
    return shouldCounterShootThenDodge(bb.me, bb.enemy, bb.enemyTank, bb.enemyBullets, bb.game, bb.enemyPos);
  });
}

function senseEscapeTeleport(bb) {
  return sense(bb, 'escapeTeleport', function () {
    return findEscapeTeleport(bb.me, bb.enemy, bb.enemyTank, bb.enemyBullets, bb.game);
  });
}

function senseTwoStepEscape(bb) {
  return sense(bb, 'twoStepEscape', function () {
    return findTwoStepEscape(bb.me, bb.enemyBullets, bb.game, bb.enemyPos, bb.enemyTank);
  });
}

function senseDesperateDodge(bb) {
  return sense(bb, 'desperateDodge', function () {
    return findDesperateDodge(bb.me, bb.enemyBullets, bb.game, bb.enemyPos, bb.enemyTank);
  });
}

function senseBoostThroughDodge(bb) {
  return sense(bb, 'boostThroughDodge', function () {
    return findBoostThroughDodge(bb.me, bb.enemyBullets, bb.game, bb.enemyPos, bb.enemyTank);
  });
}

// ---- 草丛蹲守传感器 ----

function senseBushCamperDodge(bb) {
  return sense(bb, 'bushCamperDodge', function () {
    return findBushCamperFireLineDodge(
      bb.me, bb.enemy, bb.enemyTank, bb.enemyBullets, bb.game, bb.memory
    );
  });
}

// ---- 软生存传感器 ----

function senseOverloadLaneDodge(bb) {
  return sense(bb, 'overloadLaneDodge', function () {
    return findOverloadLaneDodge(bb.me, bb.enemy, bb.enemyTank, bb.game, bb.enemyPos);
  });
}

function senseAimDodge(bb) {
  return sense(bb, 'aimDodge', function () {
    return findAimDodge(bb.me, bb.enemy, bb.enemyTank, bb.enemyBullets, bb.game, bb.enemyPos);
  });
}

function senseLineDuelDodge(bb) {
  return sense(bb, 'lineDuelDodge', function () {
    return findLineDuelDodge(bb.me, bb.enemy, bb.enemyTank, bb.enemyBullets, bb.game, bb.enemyPos);
  });
}

// ---- 攻击传感器 ----

function senseOpenShot(bb) {
  return sense(bb, 'openShot', function () {
    return findEnemyBulletOpenShot(bb.me, bb.enemy, bb.enemyTank, bb.enemyBullets, bb.game, bb.enemyPos);
  });
}

function senseCloakPreFire(bb) {
  return sense(bb, 'cloakPreFire', function () {
    return findCloakPreFireShot(bb.me, bb.enemy, bb.enemyTank, bb.enemyBullets, bb.game, bb.memory);
  });
}

function senseGuardLineShot(bb) {
  return sense(bb, 'guardLineShot', function () {
    return findGuardLineShot(bb.me, bb.enemy, bb.enemyTank, bb.enemyBullets, bb.game, bb.enemyPos, bb.memory);
  });
}

function senseBushLineShot(bb) {
  return sense(bb, 'bushLineShot', function () {
    return findBushLineShot(bb.me, bb.enemy, bb.enemyTank, bb.enemyBullets, bb.game, bb.enemyPos, bb.memory);
  });
}

// ---- 目标传感器 ----

function senseStarTeleport(bb) {
  return sense(bb, 'starTeleport', function () {
    return findStarTeleport(bb.me, bb.enemy, bb.enemyTank, bb.enemyBullets, bb.game, bb.memory);
  });
}

function senseStarGuard(bb) {
  return sense(bb, 'starGuard', function () {
    return findContestedStarGuard(bb.me, bb.enemyTank, bb.game);
  });
}

function senseAssassination(bb) {
  return sense(bb, 'assassination', function () {
    return findAssassinationPlan(bb.me, bb.enemy, bb.enemyTank, bb.enemyBullets, bb.game, bb.memory);
  });
}

// ---- 移动传感器 ----

function senseMoveCandidate(bb) {
  return sense(bb, 'moveCandidate', function () {
    return chooseMoveCandidateScored(bb.me, bb.enemy, bb.game, bb.enemyPos, bb.memory, bb.enemyBullets);
  });
}

function senseSafeNeighbor(bb) {
  return sense(bb, 'safeNeighbor', function () {
    return bestSafeNeighbor(bb.myPos, bb.game, bb.enemyPos, bb.enemyTank, bb.enemyBullets, bb.enemy, bb.memory);
  });
}

function senseDigDirection(bb) {
  return sense(bb, 'digDir', function () {
    var target = bb.star || bb.enemyPos || nearestOpenToCenter(bb.game);
    return findDigDirection(bb.myPos, bb.game, target);
  });
}

// ---- 炸弹传感器 ----

function senseBombThreat(bb) {
  return sense(bb, 'bombThreat', function () {
    return findBombDodge(bb.myPos, bb.bombs, bb.game, bb.enemyPos, bb.enemyBullets, bb.frame);
  });
}

function senseRetreatBomb(bb) {
  return sense(bb, 'retreatBomb', function () {
    return findRetreatBomb(bb.me, bb.enemy, bb.enemyTank, bb.game, bb.memory, bb.frame);
  });
}

function senseStarBomb(bb) {
  return sense(bb, 'starBomb', function () {
    return findStarBomb(bb.me, bb.enemy, bb.enemyTank, bb.game, bb.memory, bb.frame);
  });
}

function senseBushBomb(bb) {
  return sense(bb, 'bushBomb', function () {
    return findBushBomb(bb.me, bb.enemy, bb.enemyTank, bb.game, bb.memory, bb.frame);
  });
}

function senseStarBushAmbush(bb) {
  return sense(bb, 'starBushAmbush', function () {
    return findStarBushAmbush(bb.me, bb.enemy, bb.enemyTank, bb.enemyBullets, bb.game, bb.memory);
  });
}

function senseBushPreFire(bb) {
  return sense(bb, 'bushPreFire', function () {
    return findBushPreFireTarget(bb.me, bb.enemy, bb.enemyTank, bb.game, bb.memory);
  });
}

function senseBlindBushShot(bb) {
  return sense(bb, 'blindBushShot', function () {
    return findBlindBushShot(bb.me, bb.enemy, bb.enemyTank, bb.enemyBullets, bb.game, bb.memory);
  });
}

// ============================================================
// 动作包装器（统一从 bb 取参数，简化节点代码）
// ============================================================

function bbFire(bb) {
  bb.me.fire();
}

function bbTeleport(bb, pos) {
  bb.me.teleport(pos[0], pos[1]);
}

function bbMoveToward(bb, target) {
  if (!bb.enemyPos && bb.memory && target &&
      stepIntoHiddenEnemyFireLine(target, bb.myPos, bb.game, bb.memory,
        !!(bb.star && samePos(target, bb.star)))) {
    var alt = _findSafeAlternativeStep(bb);
    if (alt) moveToward(bb.me, bb.game, alt, null, bb.enemyTank, bb.enemyBullets, bb.enemy);
    else moveToward(bb.me, bb.game, target, null, bb.enemyTank, bb.enemyBullets, bb.enemy);
    return;
  }
  moveToward(bb.me, bb.game, target, bb.enemyPos, bb.enemyTank, bb.enemyBullets, bb.enemy);
}

function bbTurnToward(bb, dir) {
  turnToward(bb.me, dir);
}

function bbThrowBomb(bb) {
  bb.me.throwBomb();
  bb.memory.myBombs.push({
    position: bb.myPos.slice(),
    detonateFrame: bb.frame + BOMB_FUSE_FRAMES
  });
}

function bbSpeak(bb, msg) {
  if (bb.me && typeof bb.me.speak === 'function') bb.me.speak(msg);
}

function bbUseSkill(bb, skillName, arg1, arg2) {
  if (!bb.me || !bb.me[skillName]) return;
  if (arg1 !== undefined && arg2 !== undefined) bb.me[skillName](arg1, arg2);
  else bb.me[skillName]();
}

function bbDirectGo(bb, target) {
  if (!bb.enemyPos && bb.memory && target &&
      stepIntoHiddenEnemyFireLine(target, bb.myPos, bb.game, bb.memory,
        !!(bb.star && samePos(target, bb.star)))) {
    var alt = _findSafeAlternativeStep(bb);
    if (alt) {
      var altDir = directionBetween(bb.myPos, alt);
      if (altDir === bb.myDir) bb.me.go();
      else if (altDir) bbTurnToward(bb, altDir);
    } else {
      var dir = directionBetween(bb.myPos, target);
      if (dir === bb.myDir) bb.me.go();
      else if (dir) bbTurnToward(bb, dir);
    }
    return;
  }
  var dir = directionBetween(bb.myPos, target);
  if (dir === bb.myDir) bb.me.go();
  else if (dir) bbTurnToward(bb, dir);
}

function _findSafeAlternativeStep(bb) {
  var best = null, bestScore = -9999;
  for (var i = 0; i < DIRS.length; i++) {
    var p = [bb.myPos[0] + DIRS[i].dx, bb.myPos[1] + DIRS[i].dy];
    if (!isPassable(bb.game, p, null)) continue;
    if (stepIntoHiddenEnemyFireLine(p, bb.myPos, bb.game, bb.memory, false)) continue;
    if (anyBulletThreatens(bb.enemyBullets, p, bb.game)) continue;
    var score = 0;
    if (bb.star) score += (manhattan(bb.myPos, bb.star) - manhattan(p, bb.star)) * 10;
    if (bb.memory.lastEnemyPos) score += manhattan(p, bb.memory.lastEnemyPos);
    if (score > bestScore) { bestScore = score; best = p; }
  }
  return best;
}