// ============================================================
// nodes-movement-v2.js — 移动层 BT 子树（替代评分引擎）
//
// 用 Selector 优先级替代 buildMoveCandidates + scoreMoveCandidate 的统一评分竞争。
// 每个策略是独立的 Sequence 节点：Guard 检查前置条件 → Action 执行移动。
// 优先级从高到低：追星 > 脱离双弹带 > 占射击线 > 保持距离 > 蹲草 > 防隐身 > 巡逻 > 兜底。
//
// 依赖：core-utils.js, tactics.js, movement-engine.js, bt-core.js, blackboard.js
// ============================================================

function createMovementTree(profile) {
  var children = [];

  // ---- 蹲草等星（对 overload 双弹流 + 无星 + 我在草丛 + 有传送） ----
  if (profile.bushCamp) {
    children.push(
      Sequence('bush-hold', [
        Guard('is-overload-enemy', function (bb) { return enemyIsOverloadType(bb.enemy); }),
        Guard('no-star', function (bb) { return !bb.star; }),
        Guard('i-am-hidden', function (bb) { return iAmHidden(bb.me, bb.game); }),
        Guard('teleport-ready', function (bb) { return bb.teleportIsReady; }),
        Guard('bush-safe', function (bb) {
          return !anyBulletThreatens(bb.enemyBullets, bb.myPos, bb.game) &&
            (!bb.enemyPos || bb.distToEnemy >= 3) &&
            (!bb.enemyTank || !enemyAimsAt(bb.myPos, bb.enemyTank, bb.game));
        }),
        Action('do-bush-hold', function (bb) {
          primeShortIntent(bb.memory, 'hold', bb.myPos, bb.frame, 3);
          bbSpeak(bb, '蹲草');
        })
      ])
    );
  }

  // ---- 短期意图续跑（缓存的 2~4 步低风险计划，防横跳） ----
  children.push(
    Sequence('short-intent', [
      Guard('has-short-intent', function (bb) {
        var intent = resolveShortIntentStep(
          bb.me, bb.enemy, bb.enemyTank, bb.enemyBullets, bb.game, bb.memory
        );
        if (!intent) return false;
        bb._cache._shortIntent = intent;
        return true;
      }),
      Action('do-short-intent', function (bb) {
        var intent = bb._cache._shortIntent;
        if (intent.hold) return;
        if (bb.memory.stuckFrames >= 2) {
          clearShortIntent(bb.memory);
          breakStuckStep(bb.me, bb.game, bb.enemyPos, bb.enemyTank,
            bb.enemyBullets, bb.memory.lastMyPos2, bb.enemy);
          return;
        }
        var starLiveBullet = !!(bb.enemy && bb.enemy.bullet && bb.enemy.bullet.position);
        if (intent.kind === 'star' && !starLiveBullet) {
          bbDirectGo(bb, intent.step);
        } else {
          bbMoveToward(bb, intent.step);
        }
      })
    ])
  );

  // ---- 追星 ----
  children.push(
    Sequence('star-chase', [
      Guard('star-exists', function (bb) { return !!bb.star; }),
      Guard('should-chase', function (bb) {
        var starPath = shortestPathInfo(bb.myPos, bb.star, bb.game, bb.enemyPos);
        if (!starPath || !starPath.step) return false;
        var fleeMode = !!(bb.memory && bb.memory.enemyFleeFrames >= ENEMY_FLEE_THRESHOLD);
        if (!shouldChaseStar(bb.myPos, bb.enemyPos, bb.game, starPath, bb.enemy, fleeMode)) return false;
        // overload 陷阱检查
        if (bb.enemyPos && enemyDoubleLaneThreat(bb.enemy) &&
            starGrabTrapsInOverloadLane(starPath.step, bb.enemyPos, bb.game)) return false;
        bb._cache._starPath = starPath;
        return true;
      }),
      Guard('star-step-safe', function (bb) {
        var starPath = bb._cache._starPath;
        var standoff = safeStandoffDistance(bb.enemy);
        return isSafeStep(starPath.step, bb.myPos, bb.enemyPos, bb.game,
          bb.enemy, standoff, samePos(starPath.step, bb.star), bb.enemyBullets);
      }),
      Action('do-star-chase', function (bb) {
        var starPath = bb._cache._starPath;
        // 贴脸星短意图
        if (starPath.dist <= 2 && !bb.memory.shortIntent) {
          primeShortIntent(bb.memory, 'star', bb.star, bb.frame, 2);
        }
        var enemyHasLiveBullet = !!(bb.enemy && bb.enemy.bullet && bb.enemy.bullet.position);
        if (!enemyHasLiveBullet && !enemyDoubleLaneThreat(bb.enemy)) {
          bbDirectGo(bb, starPath.step);
        } else {
          bbMoveToward(bb, starPath.step);
        }
      })
    ])
  );

  // ---- 脱离双弹覆盖带 ----
  children.push(
    Sequence('band-escape', [
      Guard('overload-threat', function (bb) {
        return !!bb.enemyPos && enemyDoubleLaneThreat(bb.enemy);
      }),
      Guard('in-band', function (bb) {
        var distToEnemy = manhattan(bb.myPos, bb.enemyPos);
        var activeOverload = bb.enemy && bb.enemy.status && bb.enemy.status.overloaded;
        return activeOverload
          ? (distToEnemy <= 6 && inDoubleLaneBand(bb.enemyPos, bb.myPos, 6))
          : (distToEnemy <= 4 && inDoubleLaneBand(bb.enemyPos, bb.myPos, 4));
      }),
      Guard('escape-exists', function (bb) {
        var step = escapeDoubleLaneBand(bb.myPos, bb.enemyPos, bb.game, bb.enemyBullets);
        if (!step) return false;
        bb._cache._bandEscape = step;
        return true;
      }),
      Action('do-band-escape', function (bb) {
        bbMoveToward(bb, bb._cache._bandEscape);
      })
    ])
  );

  // ---- 占据射击线位（非 overload 敌人） ----
  if (!profile.bushCamp) {
    children.push(
      Sequence('occupy-lane', [
        Guard('enemy-visible', function (bb) { return !!bb.enemyPos; }),
        Guard('not-overload', function (bb) { return !enemyIsOverloadType(bb.enemy); }),
        Guard('lane-exists', function (bb) {
          var standoff = safeStandoffDistance(bb.enemy);
          var step = nextStepToFiringLane(bb.myPos, bb.enemyPos, bb.game, standoff);
          if (!step) return false;
          bb._cache._laneStep = step;
          return true;
        }),
        Action('do-lane', function (bb) {
          bbMoveToward(bb, bb._cache._laneStep);
        })
      ])
    );
  }

  // ---- 保持安全交火距离 ----
  children.push(
    Sequence('maintain-standoff', [
      Guard('enemy-visible', function (bb) { return !!bb.enemyPos; }),
      Guard('standoff-step', function (bb) {
        var standoff = safeStandoffDistance(bb.enemy);
        var step = nextStepToStandoff(bb.myPos, bb.enemyPos, bb.game, standoff, bb.enemy, bb.enemyBullets);
        if (!step) return false;
        // 不进死胡同
        if (stepIntoSealedDeadEnd(step, bb.enemyPos, bb.game)) {
          step = safestNonDeadEndStep(bb.myPos, bb.game, bb.enemyPos, bb.enemyBullets);
        }
        if (!step) return false;
        bb._cache._standoffStep = step;
        return true;
      }),
      Action('do-standoff', function (bb) {
        bbMoveToward(bb, bb._cache._standoffStep);
      })
    ])
  );

  // ---- 蹲草躲避（overload 敌 + 无星） ----
  if (profile.bushCamp) {
    children.push(
      Sequence('seek-bush', [
        Guard('overload-enemy', function (bb) { return enemyIsOverloadType(bb.enemy); }),
        Guard('no-star', function (bb) { return !bb.star; }),
        Guard('not-hidden', function (bb) { return !iAmHidden(bb.me, bb.game); }),
        Guard('bush-step', function (bb) {
          var standoff = safeStandoffDistance(bb.enemy);
          var step = nextStepToSafeBush(bb.me, bb.enemy, bb.game, bb.enemyPos, standoff, bb.enemyBullets);
          if (!step) return false;
          bb._cache._bushStep = step;
          return true;
        }),
        Action('do-seek-bush', function (bb) {
          bbMoveToward(bb, bb._cache._bushStep);
        })
      ])
    );
  }

  // ---- 防隐身：之字形 + 逃脱伏击线 + 保持距离 ----
  children.push(
    Sequence('cloak-defense', [
      Guard('cloak-recently-seen', function (bb) {
        return !!bb.memory.lastEnemyPos &&
          enemyIsCloakType(bb.enemy) &&
          (bb.frame - bb.memory.lastEnemySeenFrame <= 8);
      }),
      // 内嵌 Selector：zigzag 优先，然后 ambush，最后 avoid
      Action('do-cloak-defense', function (bb) {
        var dangerPos = bb.memory.lastEnemyPos;
        // 尝试 zigzag
        var zigStep = diagonalEvadeStep(bb.myPos, dangerPos, bb.game, bb.memory);
        if (zigStep && isSafeStep(zigStep, bb.myPos, bb.enemyPos, bb.game,
            bb.enemy, safeStandoffDistance(bb.enemy), false, bb.enemyBullets)) {
          bbMoveToward(bb, zigStep);
          return;
        }
        // 尝试 ambush escape
        var ambushStep = escapeAmbushLine(bb.myPos, dangerPos, bb.game, bb.enemyBullets);
        if (ambushStep && isSafeStep(ambushStep, bb.myPos, bb.enemyPos, bb.game,
            bb.enemy, safeStandoffDistance(bb.enemy), false, bb.enemyBullets)) {
          bbMoveToward(bb, ambushStep);
          return;
        }
        // 尝试 avoid
        var avoidStep = nextStepAvoiding(bb.myPos, dangerPos, bb.game,
          safeStandoffDistance(bb.enemy) + 1, bb.enemyBullets, bb.enemy);
        if (avoidStep) {
          bbMoveToward(bb, avoidStep);
          return;
        }
      })
    ])
  );

  // ---- 非隐身敌人的伏击线逃离 ----
  children.push(
    Sequence('escape-ambush', [
      Guard('enemy-recently-seen', function (bb) {
        return !!bb.memory.lastEnemyPos && !bb.enemyPos &&
          (bb.frame - bb.memory.lastEnemySeenFrame <= 8) &&
          !enemyIsCloakType(bb.enemy);
      }),
      Guard('ambush-step', function (bb) {
        var step = escapeAmbushLine(bb.myPos, bb.memory.lastEnemyPos, bb.game, bb.enemyBullets);
        if (!step) return false;
        bb._cache._ambushStep = step;
        return true;
      }),
      Action('do-escape-ambush', function (bb) {
        bbMoveToward(bb, bb._cache._ambushStep);
      })
    ])
  );

  // ---- 巡逻 ----
  children.push(
    Sequence('patrol', [
      Guard('patrol-target', function (bb) {
        var vt = virtualPatrolTarget(bb.me, bb.game, bb.memory, bb.enemy);
        if (!vt) return false;
        var step = nextStepToward(bb.myPos, vt, bb.game, null);
        if (!step) return false;
        bb._cache._patrolStep = step;
        return true;
      }),
      Action('do-patrol', function (bb) {
        bbMoveToward(bb, bb._cache._patrolStep);
      })
    ])
  );

  // ---- 破墙开路 ----
  children.push(
    Sequence('dig', [
      Guard('has-dig', function (bb) { return !!senseDigDirection(bb) && bb.gunIsReady; }),
      Action('do-dig', function (bb) {
        var dir = senseDigDirection(bb);
        if (bb.myDir === dir) { bbSpeak(bb, '破墙'); bbFire(bb); }
        else bbTurnToward(bb, dir);
      })
    ])
  );

  // ---- 安全邻格徘徊 ----
  children.push(
    Sequence('safe-neighbor', [
      Guard('has-safe-neighbor', function (bb) { return !!senseSafeNeighbor(bb); }),
      Action('do-safe-neighbor', function (bb) {
        bbMoveToward(bb, senseSafeNeighbor(bb));
      })
    ])
  );

  // ---- 终极兜底：原地右转防挂机 ----
  children.push(
    Action('turn-right', function (bb) {
      bb.me.turn('right');
    })
  );

  return Selector('movement', children);
}
