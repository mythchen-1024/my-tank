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

  // ---- 传送抢星 ----
  children.push(
    Sequence('star-teleport', [
      Guard('star-exists', function (bb) { return !!bb.star; }),
      Guard('teleport-ready', function (bb) { return bb.teleportIsReady; }),
      Guard('not-in-cloak-trap', function (bb) {
        return !inCloakStarTrap(bb.me, bb.enemy, bb.enemyTank, bb.game, bb.memory);
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
        // 传送前先转好朝向（落地朝向不变）
        var faceDir = teleportPreTurnDir(bb.me, tp, bb.enemy, bb.enemyTank, bb.game);
        if (faceDir && bb.myDir !== faceDir) {
          bbTurnToward(bb, faceDir);
        } else {
          bbSpeak(bb, '传星!');
          bbTeleport(bb, tp);
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
