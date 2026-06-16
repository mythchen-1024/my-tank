// ============================================================
// nodes-movement.js — 移动 / 计划 / 兜底行为节点
//
// 最低优先级层：当没有威胁、没有攻击机会、没有目标时执行。
// 包含：蹲草等星 / 短期意图续跑 / BFS 走位 / 破墙 / 安全邻格 / 兜底右转。
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

  // ---- 短期意图续跑（缓存的 2~4 步低风险计划） ----
  children.push(
    Sequence('short-intent', [
      Guard('has-short-intent', function (bb) {
        var intent = resolveShortIntentStep(
          bb.me, bb.enemy, bb.enemyTank, bb.enemyBullets, bb.game, bb.memory
        );
        if (!intent) return false;
        // 缓存到 bb 供 Action 使用
        bb._cache._shortIntent = intent;
        return true;
      }),
      Action('do-short-intent', function (bb) {
        var intent = bb._cache._shortIntent;
        if (intent.hold) return; // hold = 原地不动
        if (bb.memory.stuckFrames >= 2) {
          clearShortIntent(bb.memory);
          breakStuckStep(bb.me, bb.game, bb.enemyPos, bb.enemyTank,
            bb.enemyBullets, bb.memory.lastMyPos2, bb.enemy);
          return;
        }
        // 抢星意图：直奔星（不走 moveToward 的二次安全检查，避免被预瞄劝退）
        var starLiveBullet = !!(bb.enemy && bb.enemy.bullet && bb.enemy.bullet.position);
        if (intent.kind === 'star' && !starLiveBullet) {
          bbDirectGo(bb, intent.step);
        } else {
          bbMoveToward(bb, intent.step);
        }
      })
    ])
  );

  // ---- BFS 评分走位 ----
  children.push(
    Sequence('scored-move', [
      Guard('has-move-candidate', function (bb) {
        var mc = senseMoveCandidate(bb);
        return !!(mc && mc.step);
      }),
      Action('do-scored-move', function (bb) {
        if (bb.memory.stuckFrames >= 2) {
          breakStuckStep(bb.me, bb.game, bb.enemyPos, bb.enemyTank,
            bb.enemyBullets, bb.memory.lastMyPos2, bb.enemy);
          return;
        }
        var mc = senseMoveCandidate(bb);
        var enemyHasLiveBullet = !!(bb.enemy && bb.enemy.bullet && bb.enemy.bullet.position);
        // 抢星走位：直奔不走 moveToward（避免 enemyAimsAt 劝退）
        if (mc.kind === 'star' && !enemyHasLiveBullet) {
          bbDirectGo(bb, mc.step);
        } else {
          bbMoveToward(bb, mc.step);
        }
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
