// ============================================================
// 08-entry.js — onIdle 入口 + 评分决策 + 动作执行 + 播报 + 评分辅助
// ============================================================

function onIdle(me, enemy, game) {
  if (!me || !me.tank || !me.tank.position) return;
  var state = getState(game);

  // [1] frozen 硬拦截：被冻结无法行动
  if (me.status && me.status.frozen) return;

  var mySkill = (me.skill && me.skill.type) || null;
  var threats = collectThreatBullets(me, enemy, game);

  // per-enemy 记忆刷新：记可见敌位置/朝向，标记进草丛隐身的蹲草敌。
  updateEnemyMemory(me, enemy, game, state);

  // [2] 首帧白嫖开火：每条命第一次决策直接 fire（敌不躲弹，白嫖一发）。
  if (!state.firedThisLife) {
    state.firedThisLife = true;
    if (gunHasBudget(me, state, game)) {
      recordShot(me, state, game);
      execAction(me, { type: "fire" });
      say(me, state, "首发");
      return;
    }
  }

  // [3] 生存硬闸门：当前位置受威胁 → 优先躲，躲不掉再用防御技能。
  var pos = me.tank.position;
  if (posHitWithin(threats, pos, game, DODGE_LOOKAHEAD)) {
    var dodge = findBulletDodge(me, threats, game, chooseMainTarget(me, enemy, game), state);
    if (dodge) { execAction(me, dodge); say(me, state, "躲弹"); return; }
    var defend = defensiveSkill(me, mySkill, threats, game);
    if (defend) { execAction(me, defend); say(me, state, defend.tag); return; }
    // 都不行：落到评分流程兜底（可能换掉对射）。
  }

  // [4~10] 评分裁决
  var decision = chooseScoredDecision(me, enemy, game, threats, state, mySkill);
  execAction(me, decision);
  if (decision && decision.fired) recordShot(me, state, game);
  say(me, state, decision ? decision.tag : "");
}

// 评分式决策：收集候选动作，减去危险惩罚，取最高分。
function chooseScoredDecision(me, enemy, game, threats, state, mySkill) {
  var pos = me.tank.position;
  var dir = me.tank.direction;
  var foe = chooseMainTarget(me, enemy, game);
  var foePos = foe && foe.tank ? foe.tank.position : null;
  var alive = (typeof game.alivePlayers === "number") ? game.alivePlayers : 2;
  var late = game.frames > 80;
  var hasBudget = gunHasBudget(me, state, game);

  var cands = [];

  // [4] 进攻技能击杀（技能无关分派 + 多目标）：对任一可击杀敌取最高分候选。
  var skillAtk = mySkill ? skillOffenseBest(me, enemy, game, threats, mySkill, hasBudget) : null;
  if (skillAtk) cands.push(skillAtk);

  // [4.5] 对炮存活闸门：与主目标同线近距、对方能开火且我不占先手 → 先脱线，别站着换命。
  var duelDodge = (foePos) ? findLineDuelDodge(me, foe, threats, game) : null;
  if (duelDodge) cands.push(withScore(duelDodge, 880, duelDodge.tag));

  // [5] 同轴狂射（raid 核心，高于抢星）：扫描全部敌人，谁在我轴上无遮挡就打谁。
  //     敌不躲弹 → 射程拉满（不偏好近距）。已对准+budget+不脱线→开火；未对准→预瞄转向。
  var shootList = enemyCandidates(enemy, game);
  for (var si = 0; si < shootList.length; si++) {
    var sfp = shootList[si].tank.position;
    if (!canShoot(pos, sfp, game.map)) continue;
    var sDir = directionTo(pos, sfp);
    if (dir === sDir) {
      if (hasBudget && !duelDodge) cands.push(withScore({ type: "fire" }, 850 + lineRangeBonus(pos, sfp), "狂射"));
    } else {
      // 多敌平分防抽搐：减转身代价(转身少优先)与距离(近敌优先)，让瞄准稳定锁一个目标，
      // 不再每帧因另一敌微动而左右翻转。tiebreak 幅度小，不改变「优先打同线敌」的大局。
      var aimScore = 700 - turnCountTo(dir, sDir) * 8 - Math.min(20, manhattan(pos, sfp));
      cands.push(withScore({ type: "turn", side: turnDirection(dir, sDir) }, aimScore, "瞄准"));
    }
  }

  // [6] 守枪线：无即时射击目标时，走到控星道/走廊咽喉的格位蹲守。
  var holdStep = gunLineStep(me, game, state, foePos);
  if (holdStep) {
    cands.push(withScore(actionToDir(pos, dir, directionTo(pos, holdStep), "go"),
      300 + starLineScore(holdStep, game.star, game.map, late), "守线"));
  }

  // [7] 抢星：BFS 下一步（排在狂射后）。
  // [8] 末位 farm：只剩我+1 敌且有星 → 优先抢星不打死它（除非它瞄我，已被狂射/脱线处理）。
  var starStep = game.star && nextStep(pos, game.star, game.map);
  if (starStep) {
    var farmBonus = (alive <= 2 && game.star) ? 120 : 0; // 末位时抬高抢星
    cands.push(withScore(actionToDir(pos, dir, directionTo(pos, starStep), "go"),
      560 + farmBonus + starUrgency(pos, starStep, game.star) + starLineScore(starStep, game.star, game.map, late), "抢星"));
  }

  // [9] 破墙开路：前方/邻格土堆射穿（有预算才射）。
  var dig = hasBudget ? digDirection(pos, dir, game.map) : null;
  if (dig) {
    cands.push(withScore(actionToDir(pos, dir, dig, "fire"),
      260 + (starStep ? 0 : 120), "破墙"));
  }

  // [10] 巡逻兜底：朝持久巡逻点走，无则前进/右转。
  var patrolStep = virtualPatrol(me, game, state, foePos);
  var patrolAct = patrolStep
    ? actionToDir(pos, dir, directionTo(pos, patrolStep), "go")
    : patrolForward(pos, dir, game.map);
  cands.push(withScore(patrolAct,
    100 + starLineScore(add(pos, delta(dir)), game.star, game.map, late), "巡逻"));

  // 危险惩罚硬过滤：每个走/转候选减去落点危险（接入 per-enemy 分型）。
  for (var j = 0; j < cands.length; j++) {
    cands[j].score -= actionDanger(cands[j], me, foe, threats, game, state);
  }

  var best = cands[0];
  for (var i = 1; i < cands.length; i++) if (cands[i].score > best.score) best = cands[i];
  // 标记开火候选，供账本记账。
  if (best && (best.type === "fire" || best.fire)) best.fired = true;
  return best;
}

// 动作执行：单命令为主；flick(boost甩狙)是唯一同帧 turn+fire。
function execAction(me, a) {
  if (!a) return;
  if (a.type === "useskill") {
    if (typeof me[a.skill] === "function") me[a.skill]();
  } else if (a.type === "flick") {
    if (me.status && me.status.boosted) {
      me.turn(a.side);
      if (a.fire) me.fire();
    } else {
      me.turn(a.side);
    }
  } else if (a.type === "fire") {
    me.fire();
  } else if (a.type === "go") {
    me.go();
  } else if (a.type === "turn") {
    me.turn(a.side);
  }
}

function say(me, state, tag) {
  if (!tag || !me || typeof me.speak !== "function") return;
  if (state.speakCount >= 30 || state.lastSpeak === tag) return;
  state.lastSpeak = tag;
  state.speakCount++;
  me.speak(tag);
}

// ---- 评分辅助 ----
function withScore(action, score, tag) {
  action.score = score;
  if (tag) action.tag = tag;
  return action;
}

function actionToDir(pos, curDir, tgtDir, aligned) {
  if (curDir === tgtDir) return { type: aligned };
  return { type: "turn", side: turnDirection(curDir, tgtDir) };
}

// 同轴狂射：射程拉满（敌不躲弹，远距也命中），不偏好近距。
function lineRangeBonus(a, b) {
  return Math.min(12, manhattan(a, b)) * 2;
}

function starUrgency(pos, step, star) {
  if (samePos(step, star)) return 180;
  return Math.max(0, 8 - manhattan(pos, star)) * 10;
}

function starLineScore(pos, star, map, late) {
  if (!star) return 0;
  if (samePos(pos, star)) return 160;
  if ((pos[0] === star[0] || pos[1] === star[1]) && canShoot(pos, star, map)) return late ? 30 : 60;
  return 0;
}
