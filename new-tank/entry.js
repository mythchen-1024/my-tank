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
var DEBUG_TRACE = true;            // 是否输出决策追踪

function onIdle(me, enemy, game) {
  // ─── [1] 黑板刷新 ───
  var bb = getBlackboard(game);
  refreshBlackboard(bb, me, enemy, game);

  // ─── [2] 打法观察更新 ───
  updatePlaystyleObservation(bb);

  // ─── [3] Profile + 行为树构建/重建 ───
  var needRebuild = !bb.tree ||
    !bb.profile ||
    bb.frame - bb.profileFrame >= PROFILE_REBUILD_INTERVAL;

  if (needRebuild) {
    bb.profile = buildProfile(bb);
    bb.tree = buildBehaviorTree(bb.profile);
    bb.profileFrame = bb.frame;
  }

  // ─── [4] 执行行为树 ───
  bb.tree.tick(bb);

  // ─── [5] 调试输出 ───
  if (DEBUG_TRACE && bb._lastAction) {
    var traceMsg = bb._trace.join('>') + ':' + bb._lastAction;
    // 开局播报敌方技能
    if (bb.frame === 5 && bb.profile) {
      traceMsg = '敌:' + bb.profile.name + ' | ' + traceMsg;
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
