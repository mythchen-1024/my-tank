// ============================================================
// entry.js — onIdle 入口
//
// 替代 decision-engine.js，每帧执行：
//   [1] 获取/刷新黑板
//   [2] 更新打法观察
//   [3] 按需重建 Profile + 行为树
//   [4] tick 行为树（执行唯一动作）
//   [5] 调试输出
// ============================================================

var PROFILE_REBUILD_INTERVAL = 16; // 每 16 帧重新评估 profile

// 行为树结构签名：仅包含会改变"挂载哪些节点 / 闭包内运行时判断"的 profile 字段。
// 任一字段变化才重建树；否则复用旧树（省每 16 帧一次的几十个闭包/对象构建）。
// 注意：traits/playstyle/name 只供 speak/debug，不影响树结构，不纳入签名。
//   standoffDistance 运行时经 bb.profile 读取（不靠闭包），本可不入签名，
//   但变化即重建无副作用，纳入更保险。
function treeSignature(profile, mySkillType) {
  if (!profile) return '';
  return mySkillType + '|' +
    profile.skillType + '|' +
    profile.attackAggression + '|' +
    profile.starAggression + '|' +
    profile.standoffDistance + '|' +
    (profile.enableAssassination ? 1 : 0) + '|' +
    (profile.bushCamp ? 1 : 0) + '|' +
    (profile.bushCamperDefense ? 1 : 0) + '|' +
    (profile.dodgeBand ? 1 : 0) + '|' +
    (profile.freezeZoneAvoid ? 1 : 0) + '|' +
    (profile.prefireOnDisappear ? 1 : 0) + '|' +
    (profile.shieldBait ? 1 : 0);
}

function onIdle(me, enemy, game) {
  // ─── [1] 黑板刷新 ───
  var bb = getBlackboard(game);
  refreshBlackboard(bb, me, enemy, game);

  // ─── [2] 打法观察更新 ───
  updatePlaystyleObservation(bb);

  // ─── [3] Profile + 行为树构建/重建 ───
  // 每 PROFILE_REBUILD_INTERVAL 帧（或首帧/传送进草事件）重算 profile（廉价），
  // 但仅当树结构签名变化时才重建行为树（昂贵）。
  var enemyJustTeleportedToBush =
    !!(bb.memory.bushCamperStats &&
       bb.memory.bushCamperStats.lastTeleportIntoBushFrame === bb.frame);
  var needProfile = !bb.profile ||
    bb.frame - bb.profileFrame >= PROFILE_REBUILD_INTERVAL ||
    enemyJustTeleportedToBush;

  if (needProfile) {
    bb.profile = buildProfile(bb);
    bb.profileFrame = bb.frame;
    var sig = treeSignature(bb.profile, bb.mySkillType);
    if (!bb.tree || sig !== bb._treeSig) {
      bb.tree = buildBehaviorTree(bb.profile, bb.mySkillType);
      bb._treeSig = sig;
    }
  }

  // ─── [4] 执行行为树 ───
  bb.tree.tick(bb);

  // ─── [5] 调试输出 ───
  if (BT_DEBUG && bb._lastAction) {
    var traceMsg = bb._trace.join('>') + ':' + bb._lastAction;
    // 开局播报敌方技能
    if (bb.frame === 5 && bb.profile) {
      traceMsg = '我:' + bb.mySkillType + ' vs 敌:' + bb.profile.name + ' | ' + traceMsg;
    }
    // 限制 speak 频率：关键动作才播报
    var isKeyAction = isKeyActionForSpeak(bb._lastAction);
    if (isKeyAction) {
      bbSpeak(bb, traceMsg.length > 30 ? bb._lastAction : traceMsg);
    }
    // print 始终输出（供 replay 调试）
    if (typeof print === 'function') {
      print('f' + bb.frame + ' ' + traceMsg);
    }
  }
}

/**
 * 判断是否为值得气泡播报的关键动作
 */
function isKeyActionForSpeak(actionName) {
  var keyActions = {
    'do-counter-fire': true,
    'do-bullet-dodge': true,
    'do-escape-tp': true,
    'do-two-step': true,
    'do-desperate': true,
    'do-aim-dodge': true,
    'do-line-duel-dodge': true,
    'do-open-shot': true,
    'do-cloak-prefire': true,
    'do-fire-direct': true,
    'do-fire-risky': true,
    'do-guard-line': true,
    'do-bush-shot': true,
    'do-cloak-guard': true,
    'do-star-tp': true,
    'do-assassination': true,
    'do-bush-hold': true,
    'do-bush-camper-dodge': true,
    'frozen-wait': true,
  };
  return !!keyActions[actionName];
}
