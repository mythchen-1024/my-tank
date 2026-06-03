// ============================================================
// action-proposals.js — 候选动作提案构建器
//
// 将原 onIdle 中散落的 if/return 规则，按行为族重组为
// 返回 Proposal 数组的函数族。所有函数只负责"提案"，
// 不做执行决定——由 decision-engine.js 统一裁决。
//
// 调用约定：每个 collect* 函数返回 Proposal[]（可以为空数组）。
// hardGate=true 的提案由调用方在进入打分前直接执行。
//
// 评分基准值（Phase 5 校准后：星星优先于直接开火，追星是首要目标）：
//   survival soft  aim-dodge   r=82 risk=10  s=0  ~70
//   survival soft  line-duel   r=83 risk=15  s=0  ~65
//   attack         open-shot   r=79 risk=20  s=0  ~55  (敌炮管空窗期)
//   target         star-tele   r=80 risk=25  s=5  ~50  (星=直接得分)
//   attack         fire-direct r=75 risk=25  s=0  ~45  (战略价值)
//   attack         guard-line  r=65 risk=20  s=0  ~41
//   attack         bush-shot   r=60 risk=15  s=0  ~42
//   target         cloak-guard r=56 risk=15  s=0  ~38
//   target         star-guard  r=50 risk=15  s=0  ~32
//   target         assassin    r=70 risk=35  s=0  ~28
//   move           bush-hold   r=34 risk=10  s=15 ~26  (蹲守粘性)
//   move           short-int   r=38 risk=17  s=10 ~20  (计划连续性)
//   move           scored-move r=35 risk=18  s=3  ~14
//   move           dig         r=26 risk=15  s=0  ~8
//   move           safe-nbr    r=28 risk=20  s=0  ~4
//   move           turn-right  r=40 risk=40  s=0  ~-8
// ============================================================

// scored-move 是移动层内部二次裁决后的顶层提案。它默认只有 move 标签，
// 这里根据内部 kind 补充语义标签，让 braveBonus 能识别“步行抢星/脱险/进攻走位/计划走位”。
// 动态映射：
// - star -> star：步行抢星，允许落后/终局勇敢提权。
// - bandEscape / zigzag / ambush / avoid / safeNeighbor -> survival：逃离双弹带、隐身伏击线或危险格。
// - lane / standoff -> attack：走位服务于获得枪线或维持交火距离。
// - patrol / bush / center -> plan：巡逻、奔草、向心走位属于跨帧计划/机动性。
// - 其他 kind 保留 move：普通移动候选，不额外触发 braveBonus。
function tagsForMoveCandidate(kind) {
  const tags = ['move'];
  if (kind === 'star') tags.push('star');
  if (kind === 'bandEscape' || kind === 'zigzag' || kind === 'ambush' ||
      kind === 'avoid' || kind === 'safeNeighbor') {
    tags.push('survival');
  }
  if (kind === 'lane' || kind === 'standoff') tags.push('attack');
  if (kind === 'patrol' || kind === 'bush' || kind === 'center') tags.push('plan');
  return tags;
}

// ---- 硬闸门层（步骤 2–3.5，直接返回单个提案或 null，不进入打分） ----

/**
 * 检查所有必须立即响应的致命威胁。
 * 返回单个带 hardGate=true 的 Proposal，或 null（无紧急威胁）。
 * 调用方应在进入打分流程前执行并返回。
 */
function collectHardSurvivalAction(me, enemy, game, state, enemyBullets, enemyTank, enemyPos) {
  const myPos = me.tank.position;

  // 步骤 2：常规子弹躲避
  const dodge = findBulletDodge(me, enemy, game, enemyPos);
  if (dodge) {
    // 对射先射后走：来袭子弹下可先反击一炮
    if (shouldCounterShootThenDodge(me, enemy, enemyTank, enemyBullets, game, enemyPos)) {
      return buildProposal('counter-shoot', function () {
        me.speak("开炮！！！");
        me.fire();
      }, { hardGate: true, reason: 'counter-shoot-then-dodge' });
    }
    return buildProposal('bullet-dodge', function () {
      moveToward(me, game, dodge, enemyPos, enemyTank, enemyBullets);
    }, { hardGate: true, step: dodge, reason: 'bullet-dodge' });
  }

  // 步骤 3：紧急传送逃生
  const escapeTeleport = findEscapeTeleport(me, enemy, enemyTank, enemyBullets, game);
  if (escapeTeleport) {
    return buildProposal('escape-teleport', function () {
      me.teleport(escapeTeleport[0], escapeTeleport[1]);
    }, { hardGate: true, step: escapeTeleport, reason: 'escape-teleport' });
  }

  // 步骤 3.4：两步脱困（双弹夹击）
  const twoStep = findTwoStepEscape(me, enemyBullets, game, enemyPos, enemyTank);
  if (twoStep) {
    return buildProposal('two-step-escape', function () {
      const tdir = directionBetween(myPos, twoStep);
      if (tdir === me.tank.direction) me.go();
      else if (tdir) turnToward(me, tdir);
    }, { hardGate: true, step: twoStep, reason: 'two-step-escape' });
  }

  // 步骤 3.5：绝境横移
  const desperate = findDesperateDodge(me, enemyBullets, game, enemyPos, enemyTank);
  if (desperate) {
    return buildProposal('desperate-dodge', function () {
      moveToward(me, game, desperate, enemyPos, enemyTank, enemyBullets);
    }, { hardGate: true, step: desperate, reason: 'desperate-dodge' });
  }

  return null;
}

// ---- 软生存层（步骤 4–5，不再硬返回，以高分参与竞争） ----

/**
 * 防瞄移动 + 近距对射规避。
 * 返回 Proposal[]（0 或 1 个），分数足够高确保优先于攻击提案。
 */
function collectSoftSurvivalProposals(me, enemy, game, state, enemyBullets, enemyTank, enemyPos) {
  const proposals = [];

  // 步骤 4：防范敌方瞄准
  const aimDodge = findAimDodge(me, enemy, enemyTank, enemyBullets, game, enemyPos);
  if (aimDodge) {
    proposals.push(buildProposal('aim-dodge', function () {
      moveToward(me, game, aimDodge, enemyPos, enemyTank, enemyBullets);
    }, { step: aimDodge, reason: 'aim-dodge' }));
    return proposals; // aim-dodge 命中则 line-duel 不再评估（优先级更高）
  }

  // 步骤 5：近距对射规避
  const lineDodge = findLineDuelDodge(me, enemy, enemyTank, enemyBullets, game, enemyPos);
  if (lineDodge) {
    proposals.push(buildProposal('line-duel-dodge', function () {
      moveToward(me, game, lineDodge, enemyPos, enemyTank, enemyBullets);
    }, { step: lineDodge, reason: 'line-duel-dodge' }));
  }

  return proposals;
}

// ---- 攻击层（步骤 5.5–6.6） ----

/**
 * 开火/预瞄等主动攻击提案。
 */
function collectAttackProposals(me, enemy, game, state, enemyBullets, enemyTank, enemyPos) {
  const proposals = [];
  const myPos = me.tank.position;

  // 步骤 5.5：敌炮管空窗期反击
  const openShot = findEnemyBulletOpenShot(me, enemy, enemyTank, enemyBullets, game, enemyPos);
  if (openShot) {
    proposals.push(buildProposal('open-shot', function () {
      if (me.tank.direction === openShot) { me.speak("开炮！！！"); me.fire(); }
      else turnToward(me, openShot);
    }, { reason: 'open-shot-window' }));
  }

  // 步骤 6：同线无障碍直接开火
  const shotDir = enemyPos ? clearShotDirection(myPos, enemyPos, game) : null;
  if (shotDir && canShoot(me, enemy)) {
    const shieldDuelSafe = canShootThenEvadeShieldCounter(me, enemy, enemyTank, enemyBullets, game, enemyPos);
    const shieldBlock    = enemyHasShieldSkill(enemy) && !shieldDuelSafe;
    const doubleLaneClose = enemyDoubleLaneThreat(enemy) &&
      manhattan(myPos, enemyPos) < safeStandoffDistance(enemy);
    if (!shieldBlock && !doubleLaneClose) {
      proposals.push(buildProposal('fire-direct', function () {
        if (me.tank.direction === shotDir) { me.speak("开炮！！！"); me.fire(); }
        else turnToward(me, shotDir);
      }, { reason: 'fire-direct' }));
    }
  }

  // 步骤 6.5：以守为攻——预瞄守线
  const guardShot = findGuardLineShot(me, enemy, enemyTank, enemyBullets, game, enemyPos);
  if (guardShot) {
    proposals.push(buildProposal('guard-line', function () {
      if (guardShot.fire) { me.speak("开炮！！！"); me.fire(); }
      else turnToward(me, guardShot.dir);
    }, { reason: 'guard-line-shot' }));
  }

  // 步骤 6.6：草丛攻防（预射打草惊蛇 / 草丛伏击）
  const bushShot = findBushLineShot(me, enemy, enemyTank, enemyBullets, game, enemyPos, state);
  if (bushShot) {
    proposals.push(buildProposal('bush-shot', function () {
      if (bushShot.fire) { me.speak("开炮！！！"); me.fire(); }
      else turnToward(me, bushShot.dir);
    }, { reason: 'bush-shot' }));
  }

  return proposals;
}

// ---- 目标层（星星 & 刺杀） ----

/**
 * 与星星相关的高收益动作 + 刺杀提案。
 */
function collectTargetProposals(me, enemy, game, state, enemyBullets, enemyTank, enemyPos) {
  const proposals = [];
  const myPos = me.tank.position;
  const frame  = (game && game.frames) || 0;

  // 提案 1：隐身守星防陷阱（优先于追星）
  if (inCloakStarTrap(me, enemy, enemyTank, game, state)) {
    const guard = cloakStarGuardStep(me, game, state);
    if (guard) {
      proposals.push(buildProposal('cloak-guard', function () {
        moveToward(me, game, guard, enemyPos, enemyTank, enemyBullets);
      }, { step: guard, reason: 'cloak-star-trap' }));
    } else {
      // 有陷阱但找不到安全格，原地不动（高分阻断追星）
      proposals.push(buildProposal('cloak-trap-hold', function () {}, {
        reason: 'cloak-trap-no-guard',
      }));
    }
    return proposals; // 陷阱状态下不评估其他目标提案
  }

  // 提案 2：传送抢星（终局加分）
  const starTeleport = findStarTeleport(me, enemy, enemyTank, enemyBullets, game);
  if (starTeleport) {
    const faceDir = teleportPreTurnDir(me, starTeleport, enemy, enemyTank, game);
    proposals.push(buildProposal('star-teleport', function () {
      if (faceDir && me.tank.direction !== faceDir) { turnToward(me, faceDir); return; }
      me.teleport(starTeleport[0], starTeleport[1]);
    }, { step: starTeleport, reason: 'star-teleport' }));
  }

  // 提案 3：星星争夺预瞄守点
  const starGuard = findContestedStarGuard(me, enemyTank, game);
  if (starGuard) {
    proposals.push(buildProposal('star-guard', function () {
      if (me.tank.direction !== starGuard.dir) turnToward(me, starGuard.dir);
    }, { reason: 'contested-star-guard' }));
  }

  // 提案 4：传送刺杀
  const assassination = findAssassinationPlan(me, enemy, enemyTank, enemyBullets, game, state);
  if (assassination) {
    proposals.push(buildProposal('assassination', function () {
      if (me.tank.direction === assassination.dir) {
        state.pendingAssassin = {
          targetPos: enemyPos.slice(),
          dir:       assassination.dir,
          frame:     frame,
        };
        me.teleport(assassination.pos[0], assassination.pos[1]);
      } else {
        turnToward(me, assassination.dir);
      }
    }, { step: assassination.pos, reason: 'assassination' }));
  }

  return proposals;
}

// ---- 移动/计划层（步骤 9 后段） ----

/**
 * 巡逻、短期意图、评分走位、破墙、安全邻格、兜底转向。
 */
function collectMoveProposals(me, enemy, game, state, enemyBullets, enemyTank, enemyPos) {
  const proposals = [];
  const myPos = me.tank.position;

  // 计划层：草丛蹲守（overload 双弹流 + 无星）
  if (enemyIsOverloadType(enemy) && !game.star && iAmHidden(me, game) && teleportReady(me)) {
    const safeInBush = !anyBulletThreatens(enemyBullets, myPos, game) &&
      (!enemyPos || manhattan(myPos, enemyPos) >= 3) &&
      (!enemyTank || !enemyAimsAt(myPos, enemyTank, game));
    if (safeInBush) {
      primeShortIntent(state, "hold", myPos, (game && game.frames) || 0, 3);
      proposals.push(buildProposal('bush-hold', function () {
        // 静止即行动：原地隐身等待
      }, { reason: 'overload-bush-hold' }));
      return proposals;
    }
  }

  // 计划层：执行缓存的短期意图
  const shortIntent = resolveShortIntentStep(me, enemy, enemyTank, enemyBullets, game, state);
  if (shortIntent) {
    if (shortIntent.hold) {
      proposals.push(buildProposal('short-intent-hold', function () {}, {
        reason: 'short-intent-hold',
      }));
    } else {
      proposals.push(buildProposal('short-intent', function () {
        if (state.stuckFrames >= 2) {
          clearShortIntent(state);
          breakStuckStep(me, game, enemyPos, enemyTank, enemyBullets, state.lastMyPos2);
          return;
        }
        moveToward(me, game, shortIntent.step, enemyPos, enemyTank, enemyBullets);
      }, { step: shortIntent.step, reason: 'short-intent' }));
    }
    return proposals; // 短期意图命中时不再叠加走位提案
  }

  // 收益核心：评分走位 chooseStepScored
  const moveCandidate = chooseMoveCandidateScored(me, enemy, game, enemyPos, state, enemyBullets);
  if (moveCandidate && moveCandidate.step) {
    const step = moveCandidate.step;
    proposals.push(buildProposal('scored-move', function () {
      if (state.stuckFrames >= 2) {
        breakStuckStep(me, game, enemyPos, enemyTank, enemyBullets, state.lastMyPos2);
        return;
      }
      moveToward(me, game, step, enemyPos, enemyTank, enemyBullets);
    }, {
      step: step,
      tags: tagsForMoveCandidate(moveCandidate.kind),
      reason: 'scored-move:' + moveCandidate.kind,
      meta: moveCandidate.meta,
      detailScore: moveCandidate.score
    }));
  }

  // 破墙开路
  const digTarget = game.star || enemyPos || nearestOpenToCenter(game);
  const digDir    = findDigDirection(myPos, game, digTarget);
  if (digDir && gunReady(me)) {
    proposals.push(buildProposal('dig', function () {
      if (me.tank.direction === digDir) { me.speak("开炮！！！"); me.fire(); }
      else turnToward(me, digDir);
    }, { reason: 'dig-wall' }));
  }

  // 生存兜底：安全徘徊
  const safeStep = bestSafeNeighbor(myPos, game, enemyPos, enemyTank, enemyBullets);
  if (safeStep) {
    proposals.push(buildProposal('safe-neighbor', function () {
      moveToward(me, game, safeStep, enemyPos, enemyTank, enemyBullets);
    }, { step: safeStep, reason: 'safe-neighbor' }));
  }

  // 终极兜底：原地右转防挂机
  proposals.push(buildProposal('turn-right', function () {
    me.turn("right");
  }, { reason: 'turn-right-fallback' }));

  return proposals;
}
