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

var DECISION_TRACE_PRINT = true; // print 只记录关键/变化决策；speak 只播报关键决策，节省气泡额度。
var DECISION_PRINT_REPEAT_GAP = 16; // 同一类调试日志至少间隔 N 帧，避免 debug 日志拖慢 runTime。
var DECISION_SPEAK_REPEAT_GAP = 4; // 同一关键决策连续出现时，至少间隔 N 帧才再次 speak。
var ENEMY_SKILL_ANNOUNCE_FRAME = 5; // 开局第5帧后再播报敌方技能，避免出生瞬间气泡一闪而过。

function enemySkillNameZh(enemy) {
  const type = enemy && enemy.skill && enemy.skill.type;
  if (!type) return "无";
  const names = {
    shield:   "护盾",
    freeze:   "冰冻",
    stun:     "眩晕",
    overload: "过载",
    cloak:    "隐身",
    poison:   "毒雾",
    teleport: "传送",
    boost:    "加速"
  };
  return names[type] || ("未知(" + type + ")");
}

function openingSkillMessage(state, enemy, game) {
  if (!state || state.enemySkillAnnounced) return "";
  const frame = (game && game.frames) || 0;
  if (frame < ENEMY_SKILL_ANNOUNCE_FRAME) return "";
  state.enemySkillAnnounced = true;
  return "敌技能:" + enemySkillNameZh(enemy);
}

function shortType(type) {
  const names = {
    'counter-shoot': '反击',
    'bullet-dodge': '躲弹',
    'escape-teleport': '传逃',
    'two-step-escape': '两步逃',
    'desperate-dodge': '绝境闪',
    'aim-dodge': '防瞄',
    'line-duel-dodge': '近距躲',
    'open-shot': '空窗枪',
    'cloak-prefire': '隐预枪',
    'fire-direct': '直射',
    'guard-line': '守线',
    'bush-shot': '草枪',
    'cloak-guard': '防隐星',
    'cloak-trap-hold': '守陷阱',
    'star-teleport': '传星',
    'star-guard': '守星',
    'assassination': '刺杀',
    'bush-hold': '蹲草',
    'short-intent-hold': '续停',
    'short-intent': '续走',
    'scored-move': '走位',
    'dig': '破墙',
    'safe-neighbor': '邻安',
    'turn-right': '右转',
    frozen: '冰冻'
  };
  return names[type] || type || "未知";
}

function formatDecisionBubble(prefix, proposal) {
  const parts = [];
  if (prefix) parts.push(prefix);
  if (proposal) {
    const typeName = shortType(proposal.type);
    if (proposal.hardGate) {
      parts.push("硬:" + typeName);
    } else if (typeof proposal.score === "number") {
      parts.push(typeName + ":" + Math.round(proposal.score));
    } else {
      parts.push(typeName);
    }
    if (proposal.type === "scored-move" && proposal.reason) {
      parts.push(proposal.reason.replace("scored-move:", ""));
    }
    if (typeof proposal.detailScore === "number") {
      parts.push("内" + Math.round(proposal.detailScore));
    }
  }
  return parts.join(" | ");
}

function isKeyDecisionForSpeak(prefix, proposal) {
  if (prefix) return true; // 开局敌方技能必须播报一次
  if (!proposal) return false;
  if (proposal.hardGate) return true; // 硬生存闸门都是关键决策

  const keyTypes = {
    'aim-dodge': true,
    'line-duel-dodge': true,
    'open-shot': true,
    'cloak-prefire': true,
    'fire-direct': true,
    'guard-line': true,
    'bush-shot': true,
    'cloak-guard': true,
    'cloak-trap-hold': true,
    'star-teleport': true,
    'star-guard': true,
    'assassination': true,
    'bush-hold': true,
  };
  if (keyTypes[proposal.type]) return true;

  if (proposal.type === "scored-move" && proposal.reason) {
    const kind = proposal.reason.replace("scored-move:", "");
    return kind === "star" || kind === "bandEscape" || kind === "zigzag" ||
      kind === "ambush" || kind === "avoid" || kind === "bush" || kind === "safeNeighbor";
  }
  return false;
}

function decisionSpeakKey(prefix, proposal) {
  if (prefix) return "opening:" + prefix;
  if (!proposal) return "none";
  return proposal.type + ":" + (proposal.reason || "");
}

function isKeyDecisionForPrint(prefix, proposal) {
  if (prefix) return true;
  if (!proposal) return false;
  if (proposal.hardGate) return true;
  const keyTypes = {
    'counter-shoot': true,
    'bullet-dodge': true,
    'escape-teleport': true,
    'two-step-escape': true,
    'desperate-dodge': true,
    'aim-dodge': true,
    'line-duel-dodge': true,
    'open-shot': true,
    'cloak-prefire': true,
    'fire-direct': true,
    'guard-line': true,
    'bush-shot': true,
    'cloak-guard': true,
    'cloak-trap-hold': true,
    'star-teleport': true,
    'star-guard': true,
    'assassination': true,
    'bush-hold': true,
    'dig': true,
    'safe-neighbor': true
  };
  if (keyTypes[proposal.type]) return true;

  if (proposal.type === "scored-move" && proposal.reason) {
    const kind = proposal.reason.replace("scored-move:", "");
    return kind === "star" || kind === "bandEscape" || kind === "zigzag" ||
      kind === "ambush" || kind === "avoid" || kind === "bush" || kind === "safeNeighbor";
  }
  return false;
}

function decisionPrintKey(prefix, proposal) {
  if (prefix) return "opening:" + prefix;
  if (!proposal) return "none";
  return proposal.type + ":" + (proposal.reason || "");
}

function shouldPrintDecision(state, prefix, proposal) {
  if (!DECISION_TRACE_PRINT || typeof print !== "function") return false;
  if (!isKeyDecisionForPrint(prefix, proposal)) return false;
  if (prefix || !state) return true;

  const frame = state.lastFrame || 0;
  const key = decisionPrintKey(prefix, proposal);
  const framesByKey = state.lastPrintDecisionFrames || (state.lastPrintDecisionFrames = {});
  const lastFrame = framesByKey[key];
  if (lastFrame !== undefined && frame - lastFrame < DECISION_PRINT_REPEAT_GAP) return false;

  framesByKey[key] = frame;
  state.lastPrintDecisionKey = key;
  state.lastPrintFrame = frame;
  return true;
}

function shouldSpeakDecision(state, prefix, proposal) {
  if (!isKeyDecisionForSpeak(prefix, proposal)) return false;
  if (prefix) return true;
  if (!state) return true;

  const frame = state.lastFrame || 0;
  const key = decisionSpeakKey(prefix, proposal);
  if (state.lastSpeakDecisionKey === key &&
      frame - (state.lastSpeakFrame || -999) < DECISION_SPEAK_REPEAT_GAP) {
    return false;
  }
  state.lastSpeakDecisionKey = key;
  state.lastSpeakFrame = frame;
  return true;
}

function emitDecisionBubble(me, state, prefix, proposal) {
  const msg = formatDecisionBubble(prefix, proposal);
  if (!msg) return;
  if (shouldPrintDecision(state, prefix, proposal)) print(msg);
  if (shouldSpeakDecision(state, prefix, proposal) && me && typeof me.speak === "function") {
    me.speak(msg);
  }
}

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
  const openingMsg = openingSkillMessage(state, enemy, game);

  // ---- [3] 硬状态拦截 ----
  if (me.status && me.status.frozen) {
    emitDecisionBubble(me, state, openingMsg, { type: "frozen" });
    return;
  }

  // ---- [4] 生存硬闸门 ----
  // 只要存在 hardGate=true 提案，立刻执行并返回，不进入打分流程。
  const hardAction = collectHardSurvivalAction(
    me, enemy, game, state, enemyBullets, enemyTank, enemyPos
  );
  if (hardAction) {
    hardAction.exec();
    emitDecisionBubble(me, state, openingMsg, hardAction);
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
    emitDecisionBubble(me, state, openingMsg, best);
  } else {
    emitDecisionBubble(me, state, openingMsg, null);
  }
}
