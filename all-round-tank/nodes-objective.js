// ============================================================
// nodes-objective.js — 目标行为节点（星星 & 刺杀）
//
// 星星是唯一直接得分来源，优先级由 profile.starAggression 控制：
//   'low'    → 只在安全时抢星
//   'high'   → 主动抢星（常规对局）
//   'max'    → 全力冲星（终局/落后/对跑路流）
//
// 刺杀由 profile.enableAssassination 开关控制。
// ============================================================

function createObjectiveTree(profile) {
  var children = [];

  // ---- 隐身守星防陷阱（优先于抢星） ----
  children.push(
    Selector('cloak-star-trap', [
      // 有陷阱 + 找到安全守位格 → 移动到守位格
      Sequence('cloak-guard', [
        Guard('in-cloak-trap', function (bb) {
          return inCloakStarTrap(bb.me, bb.enemy, bb.enemyTank, bb.game, bb.memory);
        }),
        Guard('has-guard-step', function (bb) {
          return !!cloakStarGuardStep(bb.me, bb.game, bb.memory);
        }),
        Action('do-cloak-guard', function (bb) {
          bbMoveToward(bb, cloakStarGuardStep(bb.me, bb.game, bb.memory));
        })
      ]),
      // 有陷阱但无安全格 → 原地不动（阻断送死追星）
      Sequence('cloak-trap-hold', [
        Guard('in-cloak-trap', function (bb) {
          return inCloakStarTrap(bb.me, bb.enemy, bb.enemyTank, bb.game, bb.memory);
        }),
        Action('do-trap-hold', function (bb) { /* 原地等待 */ })
      ]),
    ])
  );

  // ---- 星点草丛伏击（优先于直接传送抢星） ----
  children.push(
    Sequence('star-bush-ambush', [
      Guard('star-exists', function (bb) { return !!bb.star; }),
      Guard('teleport-ready', function (bb) { return bb.teleportIsReady; }),
      // 敌人不可见，或可见但不是传送流距星 > 5，或敌人是传送流且距星较远
      Guard('enemy-allows-ambush', function (bb) {
        if (!bb.enemyTank) return true;
        // 敌人可见且已逼近星(≤5)：走路追星中，守线/传星优于蹲草
        if (manhattan(bb.enemyPos, bb.star) <= 5) return false;
        // 敌有传送就绪且走路来不及星(>5)：双方都靠传送抢星，ambush多花1-2帧预转向必输，
        // 交 star-teleport 快速直传
        if (enemyHasTeleport(bb.enemy) && enemyTeleportReady(bb.enemy)) {
          var foeWalk = pathDistance(bb.enemyPos, bb.star, bb.game, bb.myPos);
          if (foeWalk < 0 || foeWalk > 5) return false;
        }
        return true;
      }),
      Guard('not-losing-badly', function (bb) {
        return !(bb.isLosing && bb.enmStars - bb.myStars >= 2);
      }),
      Guard('not-endgame', function (bb) { return bb.framesLeft > 25; }),
      Guard('has-ambush-pos', function (bb) { return !!senseStarBushAmbush(bb); }),
      // 敌人可见时：伏击位必须能射到星(拦截必经之路)或射到敌人，否则蹲草=放弃守线
      Guard('ambush-covers-approach', function (bb) {
        if (!bb.enemyTank) return true;
        var pos = senseStarBushAmbush(bb);
        if (clearShotDirection(pos, bb.star, bb.game)) return true;
        if (clearShotDirection(pos, bb.enemyPos, bb.game)) return true;
        return false;
      }),
      Action('do-star-ambush', function (bb) {
        var pos = senseStarBushAmbush(bb);
        // 选择预瞄方向：优先对星射线，其次对敌来路方向
        var faceDir = clearShotDirection(pos, bb.star, bb.game);
        if (!faceDir && bb.enemyPos) {
          faceDir = clearShotDirection(pos, bb.enemyPos, bb.game);
        }
        // 枪未就绪：先转向对准射击线等待，下帧枪好后再传送
        if (!bb.gunIsReady) {
          if (faceDir && bb.myDir !== faceDir) bbTurnToward(bb, faceDir);
          return;
        }
        if (faceDir && bb.myDir !== faceDir) {
          bbTurnToward(bb, faceDir);
        } else {
          bbSpeak(bb, '伏击!');
          bbTeleport(bb, pos);
          bb.memory.ambushState = { pos: pos.slice(), star: bb.star.slice(), frame: bb.frame, shifted: false, shiftTarget: null };
          bb.memory.ambushScannedDirs = {};
        }
      })
    ])
  );

  // ---- 传送抢星 ----
  children.push(
    Sequence('star-teleport', [
      Guard('star-exists', function (bb) { return !!bb.star; }),
      Guard('teleport-ready', function (bb) { return bb.teleportIsReady; }),
      Guard('not-in-cloak-trap', function (bb) {
        return !inCloakStarTrap(bb.me, bb.enemy, bb.enemyTank, bb.game, bb.memory);
      }),
      Guard('not-in-bush-trap', function (bb) {
        return !inBushStarTrap(bb.me, bb.enemy, bb.enemyTank, bb.game, bb.memory);
      }),
      Guard('has-star-tp', function (bb) { return !!senseStarTeleport(bb); }),
      // starAggression='low' 时额外检查：星星附近是否安全
      Guard('aggression-gate', function (bb) {
        if (profile.starAggression === 'low') {
          // 低攻击性：敌人在星附近且面朝我时不抢
          return !bb.enemyTank || bb.distToEnemy > 3 ||
            !enemyAimsAt(bb.myPos, bb.enemyTank, bb.game);
        }
        return true;
      }),
      Action('do-star-tp', function (bb) {
        var tp = senseStarTeleport(bb);
        // 终局预转向：确保传送后面朝星方向，省去落地后的转向帧
        if (bb.framesLeft <= 10 && bb.star) {
          var postDir = directionBetween(tp, bb.star);
          if (postDir && bb.myDir !== postDir) {
            var turns = turnDistance(bb.myDir, postDir);
            if (bb.framesLeft >= turns + 4) { // turns帧转 + 1传送 + 2等待 + 1走
              bbTurnToward(bb, postDir);
              return;
            }
          }
        }
        // 竞争激烈时跳过预转向：敌人距星<=5步且比我走路更近(或持平)，1帧预转可能丢星
        var skipPreTurn = false;
        if (bb.enemyTank && bb.star) {
          var enemyStarDist = manhattan(bb.enemyPos, bb.star);
          var myWalkDist = bb._cache._myStarWalkDist;
          if (myWalkDist === undefined) {
            myWalkDist = pathDistance(bb.myPos, bb.star, bb.game, bb.enemyPos);
            bb._cache._myStarWalkDist = myWalkDist;
          }
          if (enemyStarDist <= 5 && (myWalkDist < 0 || enemyStarDist <= myWalkDist)) {
            skipPreTurn = true;
          }
        }
        var faceDir = skipPreTurn ? null : teleportPreTurnDir(bb.me, tp, bb.enemy, bb.enemyTank, bb.game);
        if (faceDir && bb.myDir !== faceDir) {
          bbTurnToward(bb, faceDir);
        } else {
          bbSpeak(bb, '传星!');
          bbTeleport(bb, tp);
          // 传送削弱：落星旁需补吃，标记高优先级补吃意图
          if (bb.star) {
            bb.memory.pendingStarGrab = { target: bb.star.slice(), frame: bb.frame, ttl: 5 };
          }
        }
      })
    ])
  );

  // ---- 星星争夺预瞄守点 ----
  children.push(
    Sequence('star-guard', [
      Guard('has-star-guard', function (bb) { return !!senseStarGuard(bb); }),
      Action('do-star-guard', function (bb) {
        var sg = senseStarGuard(bb);
        if (bb.myDir !== sg.dir) bbTurnToward(bb, sg.dir);
      })
    ])
  );

  // ---- 传送刺杀（profile 开关控制） ----
  if (profile.enableAssassination) {
    children.push(
      Sequence('assassination', [
        Guard('no-star', function (bb) { return !bb.star; }),
        Guard('has-assassination', function (bb) { return !!senseAssassination(bb); }),
        Action('do-assassination', function (bb) {
          var plan = senseAssassination(bb);
          if (bb.myDir === plan.dir) {
            bb.memory.pendingAssassin = {
              targetPos: bb.enemyPos.slice(),
              dir: plan.dir,
              frame: bb.frame,
            };
            bbSpeak(bb, '刺杀!');
            bbTeleport(bb, plan.pos);
          } else {
            bbTurnToward(bb, plan.dir);
          }
        })
      ])
    );
  }

  return Selector('objective', children);
}

// ---- 传送补吃星节点（独立于 objective 子树，挂载在根节点硬生存之后） ----

function createStarGrabNode() {
  return Sequence('star-grab', [
    Guard('has-pending-grab', function (bb) {
      var g = bb.memory.pendingStarGrab;
      if (!g) return false;
      if (bb.frame - g.frame > g.ttl) { bb.memory.pendingStarGrab = null; return false; }
      if (!bb.star || !samePos(bb.star, g.target)) { bb.memory.pendingStarGrab = null; return false; }
      // 已站在星上：传送后2帧内引擎不让拾取，但2帧后会自动拾取，无需再走
      if (samePos(bb.myPos, bb.star)) {
        if (bb.frame - g.frame >= 2) { bb.memory.pendingStarGrab = null; return false; }
        return false; // 等待中，不走动但也不清除意图
      }
      return true;
    }),
    Guard('star-reachable', function (bb) {
      return manhattan(bb.myPos, bb.star) <= 2;
    }),
    Guard('no-bullet-incoming', function (bb) {
      // 补吃路径上有子弹即将命中 → 先躲再吃（交 hardSurvival 处理）
      if (anyBulletThreatens(bb.enemyBullets, bb.star, bb.game)) return false;
      if (anyBulletThreatens(bb.enemyBullets, bb.myPos, bb.game)) return false;
      return true;
    }),
    Action('do-star-grab', function (bb) {
      bbDirectGo(bb, bb.star);
    })
  ]);
}
