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

  // ---- 传送落点偏移：传送后首帧立即移到相邻草丛 ----
  children.push(
    Sequence('ambush-shift', [
      Guard('needs-shift', function (bb) {
        var a = bb.memory.ambushState;
        if (!a) return false;
        if (bb.frame - a.frame > 1) return false;
        if (a.shifted) return false;
        return samePos(bb.myPos, a.pos);
      }),
      Guard('shift-safe', function (bb) {
        return !anyBulletThreatens(bb.enemyBullets, bb.myPos, bb.game);
      }),
      Action('do-ambush-shift', function (bb) {
        var a = bb.memory.ambushState;
        var shiftTarget = findPostTeleportShift(a.pos, a.star, bb.game, bb.enemyBullets);
        if (!shiftTarget) {
          a.shifted = true;
          return;
        }
        bbDirectGo(bb, shiftTarget);
        a.shiftTarget = shiftTarget;
      })
    ])
  );

  // ---- 传送落点偏移完成确认 ----
  children.push(
    Sequence('ambush-shift-confirm', [
      Guard('has-shift-target', function (bb) {
        var a = bb.memory.ambushState;
        if (!a || !a.shiftTarget) return false;
        if (a.shifted) return false;
        return true;
      }),
      Action('confirm-shift', function (bb) {
        var a = bb.memory.ambushState;
        if (samePos(bb.myPos, a.shiftTarget)) {
          a.pos = a.shiftTarget.slice();
          a.shifted = true;
          a.shiftTarget = null;
        } else if (bb.frame - a.frame > 3) {
          a.pos = bb.myPos.slice();
          a.shifted = true;
          a.shiftTarget = null;
        } else {
          bbDirectGo(bb, a.shiftTarget);
        }
      })
    ])
  );

  // ---- 伏击蹲守：传送到伏击位后原地等待射击 ----
  children.push(
    Sequence('ambush-hold', [
      Guard('in-ambush', function (bb) {
        var a = bb.memory.ambushState;
        if (!a) return false;
        if (a.shiftTarget && !a.shifted) return false;
        // 连续3发打墙: 伏击无效，退出
        if (bb.memory.ambushShotsFired >= 3) {
          bb.memory.ambushState = null; bb.memory.ambushShotsFired = 0;
          bb.memory.ambushCooldown = bb.frame; return false;
        }
        var timeout = 15;
        if (bb.enemyTank && bb.star && manhattan(bb.enemyPos, bb.star) <= 8) timeout = 30;
        if (bb.enemyTank && bb.memory.lastEnemyPos && manhattan(bb.enemyPos, bb.myPos) < manhattan(bb.memory.lastEnemyPos, bb.myPos)) {
          timeout = Math.max(timeout, 25);
        }
        if (bb.frame - a.frame > timeout) { bb.memory.ambushState = null; bb.memory.ambushCooldown = bb.frame; return false; }
        if (!bb.star || !samePos(bb.star, a.star)) { bb.memory.ambushState = null; return false; }
        // 敌人比我更快到星且我射线不通 → 放弃伏击去追星
        if (bb.enemyTank && bb.star) {
          var myDistToStar = manhattan(bb.myPos, bb.star);
          var enemyDistToStar = manhattan(bb.enemyPos, bb.star);
          if (enemyDistToStar <= myDistToStar && !clearShotDirection(bb.myPos, bb.enemyPos, bb.game)) {
            bb.memory.ambushState = null; return false;
          }
          // 伏击位无法覆盖星+敌人且敌已逼近(≤5) → 守线价值归零，放弃
          if (enemyDistToStar <= 5 &&
              !clearShotDirection(bb.myPos, bb.star, bb.game) &&
              !clearShotDirection(bb.myPos, bb.enemyPos, bb.game)) {
            bb.memory.ambushState = null; return false;
          }
          // 我距星近(≤5)且伏击位无射线覆盖星和敌来路 → 蹲守无价值，不如直接去吃星
          if (myDistToStar <= 5 &&
              !clearShotDirection(bb.myPos, bb.star, bb.game) &&
              !clearShotDirection(bb.myPos, bb.enemyPos, bb.game) &&
              bb.frame - a.frame >= 3) {
            bb.memory.ambushState = null; return false;
          }
        }
        // 敌不可见时：伏击位无射线覆盖星，且等了 5 帧以上 → 伏击无拦截价值，去追星
        if (!bb.enemyTank && bb.star && bb.frame - a.frame >= 5 &&
            !clearShotDirection(bb.myPos, bb.star, bb.game)) {
          bb.memory.ambushState = null; return false;
        }
        return samePos(bb.myPos, a.pos) && iAmHidden(bb.me, bb.game);
      }),
      Guard('still-safe', function (bb) {
        return !anyBulletThreatens(bb.enemyBullets, bb.myPos, bb.game);
      }),
      Action('do-ambush-hold', function (bb) {
        var a = bb.memory.ambushState;
        // 选择蹲守朝向：对星射线 > 对敌方最后已知位置射线
        var faceDir = clearShotDirection(bb.myPos, a.star, bb.game);
        if (!faceDir && bb.memory.lastEnemyPos) {
          faceDir = clearShotDirection(bb.myPos, bb.memory.lastEnemyPos, bb.game);
        }
        // 敌人进入射线：直接开火（命中重置打墙计数）
        if (bb.enemyTank && bb.gunIsReady) {
          var shotDir = clearShotDirection(bb.myPos, bb.enemyPos, bb.game);
          if (shotDir) {
            if (bb.myDir === shotDir) { bbSpeak(bb, '伏击!'); bbFire(bb); bb.memory.ambushShotsFired = 0; }
            else { bbTurnToward(bb, shotDir); }
            return;
          }
          // 预射击：敌人下一步将进入我的射线
          var preDir = canPreemptiveShot(bb.myPos, bb.myDir, bb.enemyTank, bb.game);
          if (!preDir) {
            preDir = canAmbushLeadShot(bb.myPos, bb.myDir, bb.enemyTank, bb.game);
          }
          if (preDir) {
            if (bb.myDir === preDir) { bbSpeak(bb, '伏击!'); bbFire(bb); }
            else { bbTurnToward(bb, preDir); }
            return;
          }
        }
        // 障碍清除：星方向有土块挡住射线 → 打碎它
        if (bb.gunIsReady && bb.star) {
          var starLineDir = null;
          if (bb.star[0] === bb.myPos[0]) starLineDir = bb.star[1] < bb.myPos[1] ? 'up' : 'down';
          else if (bb.star[1] === bb.myPos[1]) starLineDir = bb.star[0] < bb.myPos[0] ? 'left' : 'right';
          if (starLineDir && !clearShotDirection(bb.myPos, bb.star, bb.game)) {
            var dd = { up:[0,-1], down:[0,1], left:[-1,0], right:[1,0] }[starLineDir];
            var cx = bb.myPos[0] + dd[0], cy = bb.myPos[1] + dd[1];
            var foundBlock = false;
            while (tileAt(bb.game, [cx, cy]) !== 'x') {
              if (tileAt(bb.game, [cx, cy]) === 'm') { foundBlock = true; break; }
              if (cx === bb.star[0] && cy === bb.star[1]) break;
              cx += dd[0]; cy += dd[1];
            }
            if (foundBlock) {
              if (bb.myDir === starLineDir) { bbSpeak(bb, '清障!'); bbFire(bb); bb.memory.ambushShotsFired = (bb.memory.ambushShotsFired || 0) + 1; }
              else { bbTurnToward(bb, starLineDir); }
              return;
            }
          }
        }
        // 伏击扫草：敌人不可见 + 伏击刚开始 → 朝草丛开炮扫描
        if (!bb.enemyTank && bb.gunIsReady && (bb.frame - a.frame) <= 8) {
          if (!bb.memory.ambushScannedDirs) bb.memory.ambushScannedDirs = {};
          var scanDir = findAmbushGrassScan(bb.myPos, bb.myDir, a.star, bb.game, bb.memory);
          if (scanDir) {
            if (bb.myDir === scanDir) {
              bbSpeak(bb, '扫草!');
              bbFire(bb);
              bb.memory.ambushShotsFired = (bb.memory.ambushShotsFired || 0) + 1;
              bb.memory.ambushScannedDirs[scanDir] = true;
            } else {
              bbTurnToward(bb, scanDir);
            }
            return;
          }
        }
        // 面朝最佳射线方向等待
        if (faceDir && bb.myDir !== faceDir) {
          bbTurnToward(bb, faceDir);
        }
      })
    ])
  );

  // ---- 蹲草等星（对 overload 双弹流 + 无星/可利用星诱敌 + 我在草丛） ----
  // 注意：不要求传送就绪——无星时原地藏着比暴露在外更安全，传送冷却中也应坚守
  // 有星时：
  //   - 星在我炮线上（与我同行/同列视线清晰）→ 敌人来追星必经我的射程，蹲守价值最高
  //   - 星不在炮线但敌人距星 ≤ 6 → 出草传星会暴露自己，继续蹲守更安全
  //   - 其他情况 → 出草追星
  if (profile.bushCamp) {
    children.push(
      Sequence('bush-hold', [
        Guard('is-overload-enemy', function (bb) { return enemyIsOverloadType(bb.enemy); }),
        Guard('no-star-or-star-bait', function (bb) {
          if (!bb.star) return true;
          // 传送就绪 + 星不在近身: 应去传送抢星而不是继续蹲守
          if (bb.teleportIsReady && manhattan(bb.myPos, bb.star) >= 4) return false;
          // 星在我炮线上且距离近(≤6): 敌追星必经我射程
          if (clearShotDirection(bb.myPos, bb.star, bb.game) &&
              manhattan(bb.myPos, bb.star) <= 6) return true;
          // 敌人近星(≤6)且我无传送: 出草走路不如蹲守
          return !!bb.enemyPos && manhattan(bb.enemyPos, bb.star) <= 6 && !bb.teleportIsReady;
        }),
        Guard('i-am-hidden', function (bb) { return iAmHidden(bb.me, bb.game); }),
        Guard('bush-safe', function (bb) {
          if (anyBulletThreatens(bb.enemyBullets, bb.myPos, bb.game)) return false;
          // overload CD快好(≤8帧) + 我在覆盖带内 + 近距: 必须脱离蹲草
          if (bb.enemyPos && enemyIsOverloadType(bb.enemy)) {
            var cd = bb.enemy.skill && bb.enemy.skill.remainingCooldownFrames;
            if (cd !== undefined && cd <= 8 && bb.distToEnemy <= 6) {
              var dx = Math.abs(bb.myPos[0] - bb.enemyPos[0]);
              var dy = Math.abs(bb.myPos[1] - bb.enemyPos[1]);
              if (dx <= 1 || dy <= 1) return false;
            }
          }
          // 敌人近距瞄着我时仍通过——交 action 层反击/逃跑，防止死锁
          return true;
        }),
        Action('do-bush-hold', function (bb) {
          // 近距被瞄应急：反击或传送逃跑，避免死锁
          if (bb.enemyTank && bb.distToEnemy < 3 && enemyAimsAt(bb.myPos, bb.enemyTank, bb.game)) {
            if (bb.gunIsReady && bb.shotDir) {
              if (bb.myDir === bb.shotDir) { bbSpeak(bb, '草伏!'); bbFire(bb); return; }
              bbTurnToward(bb, bb.shotDir); return;
            }
            if (bb.teleportIsReady) {
              var escPos = senseEscapeTeleport(bb);
              if (escPos) { bbSpeak(bb, '逃!'); bbTeleport(bb, escPos); return; }
            }
          }
          // 草丛伏击：不受 attackAggression 限制
          if (bb.gunIsReady && bb.enemyTank) {
            // 敌已在炮线上
            if (bb.shotDir) {
              if (bb.myDir === bb.shotDir) { bbSpeak(bb, '草伏!'); bbFire(bb); return; }
              bbTurnToward(bb, bb.shotDir); return;
            }
            // 敌下一步将进入炮线：提前转向等待
            var preDir = canPreemptiveShot(bb.myPos, bb.myDir, bb.enemyTank, bb.game);
            if (!preDir) {
              preDir = canAmbushLeadShot(bb.myPos, bb.myDir, bb.enemyTank, bb.game);
            }
            if (preDir) {
              if (bb.myDir === preDir) { bbSpeak(bb, '草伏!'); bbFire(bb); return; }
              bbTurnToward(bb, preDir); return;
            }
          }
          // 炮口追敌：敌可见但未进炮线时，把炮口转向敌人的主轴方向（offset 更大的轴），
          // 这样敌人一旦走进同行/同列我已对准、可即时开火，不必临时转向浪费一帧。
          // mat_1l2 复盘：蹲草32帧炮口始终朝 'right' 不动，敌在 y=2 行游走我在 y=3，
          // 炮口若追敌(对 x 轴/对敌方向)就能在对齐瞬间抢先开火。
          if (bb.enemyPos) {
            var dx = bb.enemyPos[0] - bb.myPos[0];
            var dy = bb.enemyPos[1] - bb.myPos[1];
            var aimDir = Math.abs(dx) >= Math.abs(dy)
              ? (dx >= 0 ? 'right' : 'left')
              : (dy >= 0 ? 'down' : 'up');
            if (aimDir && bb.myDir !== aimDir) { bbTurnToward(bb, aimDir); bbSpeak(bb, '蹲草'); return; }
          }
          primeShortIntent(bb.memory, 'hold', bb.myPos, bb.frame, 3);
          bbSpeak(bb, '蹲草');
        })
      ])
    );
  }

  // ---- 吃星后撤退意图：刚吃完星的短窗口内主动远离危险 ----
  children.push(
    Sequence('post-star-retreat', [
      Guard('just-ate-star', function (bb) {
        if (bb.memory.shortIntent) return false; // 已有意图不覆盖
        if (bb.star) return false; // 星还在则没吃到
        if (!bb._lastGrabFrame || bb.frame - bb._lastGrabFrame > 1) return false;
        return true;
      }),
      Action('do-retreat', function (bb) {
        var dangerPos = bb.enemyPos || bb.memory.lastEnemyPos;
        if (!dangerPos) return;
        // 找远离危险且开阔的方向走2步
        var best = null, bestScore = -9999;
        for (var i = 0; i < DIRS.length; i++) {
          var p = [bb.myPos[0] + DIRS[i].dx, bb.myPos[1] + DIRS[i].dy];
          if (!isPassable(bb.game, p, bb.enemyPos)) continue;
          if (anyBulletThreatens(bb.enemyBullets, p, bb.game)) continue;
          var score = manhattan(p, dangerPos) * 3 + openNeighborCount(p, bb.game);
          if (score > bestScore) { bestScore = score; best = p; }
        }
        if (best) primeShortIntent(bb.memory, 'retreat', best, bb.frame, 2);
      })
    ])
  );

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
        if (!shouldChaseStar(bb.myPos, bb.enemyPos, bb.game, starPath, bb.enemy, fleeMode, bb.me, bb.enemyTank)) return false;
        // 草丛伏击陷阱：敌人消失 + 星附近有草丛在射击线上
        if (!bb.enemyTank && inBushStarTrap(bb.me, bb.enemy, bb.enemyTank, bb.game, bb.memory)) return false;
        bb._cache._starPath = starPath;
        // overload 陷阱标记（降级：不再否决追星，仅标记供 star-step-safe 加严）
        bb._cache._overloadTrap = !!(bb.enemyPos && enemyDoubleLaneThreat(bb.enemy) &&
            starGrabTrapsInOverloadLane(starPath.step, bb.enemyPos, bb.game));
        return true;
      }),
      Guard('star-step-safe', function (bb) {
        var starPath = bb._cache._starPath;
        var standoff = safeStandoffDistance(bb.enemy);
        // overload 陷阱时对最优步额外检查：落点被覆盖才拒（不覆盖仍可走）
        var trapBlocked = bb._cache._overloadTrap &&
          bb.enemyPos && predictedOverloadThreatens(bb.enemy, starPath.step, bb.game);
        if (!trapBlocked && isSafeStep(starPath.step, bb.myPos, bb.enemyPos, bb.game,
          bb.enemy, standoff, samePos(starPath.step, bb.star), bb.enemyBullets, bb.memory)) {
          return true;
        }
        // 最优步不安全 → 探索次优路径：尝试其他方向的邻格作为第一步
        var bestAlt = null, bestAltDist = 9999;
        for (var i = 0; i < DIRS.length; i++) {
          var p = [bb.myPos[0] + DIRS[i].dx, bb.myPos[1] + DIRS[i].dy];
          if (samePos(p, starPath.step)) continue;
          if (!isPassable(bb.game, p, bb.enemyPos)) continue;
          if (!isSafeStep(p, bb.myPos, bb.enemyPos, bb.game,
            bb.enemy, standoff, samePos(p, bb.star), bb.enemyBullets, bb.memory)) continue;
          // overload 陷阱时次优步也检查预测弹道
          if (bb._cache._overloadTrap && predictedOverloadThreatens(bb.enemy, p, bb.game)) continue;
          var altDist = pathDistance(p, bb.star, bb.game, bb.enemyPos);
          if (altDist < 0) continue;
          if (altDist < bestAltDist) { bestAltDist = altDist; bestAlt = p; }
        }
        if (bestAlt && bestAltDist <= starPath.dist + 2) {
          bb._cache._starPath = { step: bestAlt, dist: bestAltDist + 1 };
          return true;
        }
        // 陷阱标记但找不到安全绕路 → 距星很近(≤3)时仍放行（吃星收益 > 预测风险）
        if (bb._cache._overloadTrap && starPath.dist <= 3 &&
          isSafeStep(starPath.step, bb.myPos, bb.enemyPos, bb.game,
            bb.enemy, standoff, samePos(starPath.step, bb.star), bb.enemyBullets, bb.memory)) {
          return true;
        }
        return false;
      }),
      Action('do-star-chase', function (bb) {
        var starPath = bb._cache._starPath;
        // 近距追星意图粘性: 距星≤5时锁定方向防振荡
        if (starPath.dist <= 5 && !bb.memory.shortIntent) {
          primeShortIntent(bb.memory, 'star', bb.star, bb.frame, Math.min(starPath.dist, 4));
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
        // 取 profile 期望距离与硬安全底线中的较大值
        var profileStandoff = (bb.profile && bb.profile.standoffDistance) || 4;
        var standoff = Math.max(profileStandoff, safeStandoffDistance(bb.enemy));
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
        // 敌人贴近时（≤ 3 格）不去奔草，移动本身会暴露在炮线上，交 maintain-standoff 处理
        Guard('enemy-not-too-close', function (bb) {
          return !bb.enemyPos || bb.distToEnemy > 3;
        }),
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
            bb.enemy, safeStandoffDistance(bb.enemy), false, bb.enemyBullets, bb.memory)) {
          bbMoveToward(bb, zigStep);
          return;
        }
        // 尝试 ambush escape
        var ambushStep = escapeAmbushLine(bb.myPos, dangerPos, bb.game, bb.enemyBullets);
        if (ambushStep && isSafeStep(ambushStep, bb.myPos, bb.enemyPos, bb.game,
            bb.enemy, safeStandoffDistance(bb.enemy), false, bb.enemyBullets, bb.memory)) {
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

  // ---- 终极兜底：尝试移动到任何可通行格，只避子弹不避射线 ----
  children.push(
    Action('fallback-move', function (bb) {
      var bullets = bb.enemyBullets || [];
      var best = null;
      var bestScore = -9999;
      for (var i = 0; i < DIRS.length; i++) {
        var p = [bb.myPos[0] + DIRS[i].dx, bb.myPos[1] + DIRS[i].dy];
        if (!isPassable(bb.game, p, bb.enemyPos)) continue;
        if (anyBulletThreatens(bullets, p, bb.game)) continue;
        var score = distanceFromEdges(p, bb.game);
        if (bb.enemyPos) score += manhattan(p, bb.enemyPos);
        if (score > bestScore) { bestScore = score; best = p; }
      }
      if (best) { bbDirectGo(bb, best); return; }
      if (bb.shotDir && bb.myDir !== bb.shotDir) { bbTurnToward(bb, bb.shotDir); return; }
      bb.me.turn('right');
    })
  );

  return Selector('movement', children);
}
