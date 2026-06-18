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
      // 敌人不可见，或可见但不是传送流距星 > 5，或敌人是传送流（双方都传星 → 蹲守更优）
      Guard('enemy-allows-ambush', function (bb) {
        if (!bb.enemyTank) return true;
        if (enemyHasTeleport(bb.enemy)) return true;
        return manhattan(bb.enemyPos, bb.star) > 5;
      }),
      Guard('not-losing-badly', function (bb) {
        return !(bb.isLosing && bb.enmStars - bb.myStars >= 2);
      }),
      Guard('not-endgame', function (bb) { return bb.framesLeft > 25; }),
      Guard('has-ambush-pos', function (bb) { return !!senseStarBushAmbush(bb); }),
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
          bb.memory.ambushState = { pos: pos.slice(), star: bb.star.slice(), frame: bb.frame };
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
        var faceDir = teleportPreTurnDir(bb.me, tp, bb.enemy, bb.enemyTank, bb.game);
        if (faceDir && bb.myDir !== faceDir) {
          bbTurnToward(bb, faceDir);
        } else {
          bbSpeak(bb, '传星!');
          bbTeleport(bb, tp);
          // 传送削弱：落星旁需补吃，标记高优先级补吃意图
          if (bb.star) {
            bb.memory.pendingStarGrab = { target: bb.star.slice(), frame: bb.frame, ttl: 3 };
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
      if (samePos(bb.myPos, bb.star)) { bb.memory.pendingStarGrab = null; return false; }
      return true;
    }),
    Guard('star-reachable', function (bb) {
      return manhattan(bb.myPos, bb.star) <= 2;
    }),
    Action('do-star-grab', function (bb) {
      bbDirectGo(bb, bb.star);
    })
  ]);
}
