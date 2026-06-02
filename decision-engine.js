// ============================================================
// decision-engine.js — 决策引擎入口
//
// 新版 onIdle：六层管线
//   [1] 状态采集
//   [2] 跨帧记忆更新
//   [3] 硬状态拦截（冰冻/眩晕）
//   [4] 生存硬闸门（子弹/传送逃生，直接执行，不参与打分）
//   [5] 全候选提案采集 + 统一评分裁决
//   [6] 执行最优提案
//
// 依赖加载顺序（build.js 或 _scenario_test.js 中保证）：
//   state-store.js → scoring.js → action-proposals.js → myth-tank.js → decision-engine.js
// ============================================================

function onIdle(me, enemy, game) {
  // ---- [1] 状态采集 ----
  const myPos      = me.tank.position;
  const enemyTank  = enemy && enemy.tank ? enemy.tank : null;
  const enemyPos   = enemyTank ? enemyTank.position : null;
  const enemyBullets = collectEnemyBullets(enemy);

  // ---- [2] 跨帧记忆更新 ----
  const state = getMatchState(game);
  recordAssassinOutcome(state, enemy, enemyTank, game);
  trackEnemy(state, enemyTank, myPos, game);
  trackStuck(state, myPos);

  // ---- [3] 硬状态拦截 ----
  if (me.status && me.status.frozen) {
    me.speak("我被冰冻了");
    return;
  }

  // ---- [4] 生存硬闸门 ----
  // 只要存在 hardGate=true 提案，立刻执行并返回，不进入打分流程。
  const hardAction = collectHardSurvivalAction(
    me, enemy, game, state, enemyBullets, enemyTank, enemyPos
  );
  if (hardAction) {
    hardAction.exec();
    return;
  }

  // ---- [5] 采集全部候选提案 ----
  const ctx = buildScoringContext(
    me, enemy, game, state, enemyBullets, enemyTank, enemyPos
  );

  const proposals = [].concat(
    collectSoftSurvivalProposals(me, enemy, game, state, enemyBullets, enemyTank, enemyPos),
    collectAttackProposals      (me, enemy, game, state, enemyBullets, enemyTank, enemyPos),
    collectTargetProposals      (me, enemy, game, state, enemyBullets, enemyTank, enemyPos),
    collectMoveProposals        (me, enemy, game, state, enemyBullets, enemyTank, enemyPos)
  );

  // ---- [6] 打分裁决并执行 ----
  const best = selectBestProposal(proposals, ctx);
  if (best && best.exec) {
    best.exec();
  }
}
