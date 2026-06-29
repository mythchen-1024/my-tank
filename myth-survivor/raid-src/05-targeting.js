// ============================================================
// 05-targeting.js — 多坦克选靶 + 落点危险惩罚（接入 per-enemy 分型）
// ============================================================

// 多坦克选靶：曼哈顿距离 - 星优势(-3) - 持弹威胁(-5) - threatWeight(分型)，
// 分越低越优先。无可见敌回落引擎主敌 enemy。
function chooseMainTarget(me, enemy, game) {
  var myPos = me.tank.position;
  var myStars = me.stars || 0;
  var list = enemyCandidates(enemy, game);
  if (!list.length) return null;
  var best = null, bestScore = Infinity;
  for (var i = 0; i < list.length; i++) {
    var s = targetScore(list[i], myPos, myStars);
    if (s < bestScore) { bestScore = s; best = list[i]; }
  }
  return best;
}

// 合并 game.enemies + 回落 enemy，过滤可见且未出局者。
function enemyCandidates(enemy, game) {
  var out = [];
  var es = game.enemies || [];
  for (var i = 0; i < es.length; i++) {
    var e = es[i];
    if (e && e.tank && e.tank.position && !e.tank.crashed) out.push(e);
  }
  if (!out.length && enemy && enemy.tank && enemy.tank.position && !enemy.tank.crashed) out.push(enemy);
  return out;
}

function targetScore(e, myPos, myStars) {
  var pos = e.tank.position;
  var score = manhattan(pos, myPos);
  if ((e.stars || 0) > myStars) score -= 3;
  if (e.bullet && e.bullet.position) score -= 5;
  var tp = threatProfile(e.skill && e.skill.type);
  score -= tp.threatWeight;                  // 高威胁技能敌更优先处理
  if (e.status && e.status.crashed) score += 999;
  if (e.tank.crashed) score += 999;
  return score;
}

// 危险惩罚：走/转后落点若贴脸 / 走入弹道 / 落入敌技能死区，重罚（接入分型）。
function actionDanger(action, me, foe, threats, game, state) {
  if (action.type === "useskill" || action.type === "fire" || action.type === "flick") {
    // 攻击/技能本身不移动。但当前格这帧就会被实弹命中还站着输出 = 送死(子弹2格/帧追不回)，
    // 重罚逼评分改选能脱离弹道的走位。多敌多方向来弹封死躲弹层时，这是不站着挨打的兜底。
    if (posHitWithin(threats, me.tank.position, game, 1)) return 1400;
    return 0;
  }
  var pos = me.tank.position;
  var nextPos = (action.type === "go") ? add(pos, delta(me.tank.direction)) : pos;

  var penalty = 0;
  if (action.type === "go") {
    if (stepIntoBulletPath(threats, nextPos, game)) penalty += 2000;
    // 朝「即将命中落点」的子弹走一步：落点在 DODGE_LOOKAHEAD 帧内被实弹命中 → 重罚压过抢星(峰值~1170)。
    // 修窄道开局秒杀：还没踩进弹道时 posHitWithin(1) 不报警→走一步正好进弹道→下帧无侧逃路被秒。
    // 前瞻拉到 3 帧与躲弹闸门/idle-farm 安全门一致，让「占位/抢星」永不踩进 3 帧内会到的弹。
    if (posHitWithin(threats, nextPos, game, DODGE_LOOKAHEAD)) penalty += 1300;
  } else if (posHitWithin(threats, nextPos, game, 1)) {
    penalty += 800; // 转身原地不移动：当前格这帧仍被命中却站着转 → 罚（落到走位逃离）。
  }

  // 全体敌人炮线避让（多敌核心）：任一敌已装弹(无在途弹)且能射到落点 → 按距离/是否已瞄准罚，
  // 不主动走进它炮口。主敌额外叠贴脸+技能死区；非主敌技能死区打 6 折(实弹炮口同样致命，仅预测性技能降权)。
  var foeTank = (foe && foe.tank) ? foe.tank : null;
  var list = enemyCandidates(foe, game);
  for (var i = 0; i < list.length; i++) {
    var e = list[i];
    var isFoe = foeTank && e.tank === foeTank;
    penalty += fireLineDanger(e, nextPos, game);
    penalty += skillZonePenalty(e, nextPos, game) * (isFoe ? 1 : 0.6);
    if (isFoe && manhattan(nextPos, e.tank.position) <= 1) penalty += 1500; // 贴脸（仅主敌，撞死）
  }
  // 蹲草伏击：走/转后落点踩进确认蹲草敌的火线 → 罚（窄门控，仅记忆窗内）。
  if (action.type === "go") penalty += hiddenCamperRisk(nextPos, game, state);
  return penalty;
}

// 敌已装弹(无在途弹)的炮线威胁：能射到落点才算。已瞄准近距重罚(压过抢星峰值~1170)、
// 仅同线可转身射轻罚。敌有在途弹→补射要等(子弹2格/帧)，本帧走出炮线就活→降级避免过度让位。
function fireLineDanger(e, cell, game) {
  if (!e || !e.tank || !e.tank.position || e.tank.crashed) return 0;
  var fp = e.tank.position;
  if (samePos(fp, cell)) return 0;
  if (!canShoot(fp, cell, game.map)) return 0;
  var d = manhattan(fp, cell);
  if (d > 8) return 0;
  var loaded = !(e.bullet && e.bullet.position); // 无在途弹=随时能开火
  var aimed = pointsAt(e.tank.direction, fp, cell);
  if (loaded) {
    if (aimed) return d <= 4 ? 1300 : (d <= 6 ? 200 : 60); // 已瞄准:近距压过抢星
    return d <= 4 ? 220 : 60;                              // 仅同线可转身再射
  }
  // 有在途弹:补射隔 BULLET 飞行时间,本帧走出去即活,只轻罚已瞄准近距(防贴脸二次)
  return (aimed && d <= 2) ? 200 : 0;
}

// 按 per-enemy 分型给落点惩罚：双弹覆盖带 / 冰冻同线死区 / standoff 梯度。
function skillZonePenalty(e, cell, game) {
  var tp = threatProfile(e.skill && e.skill.type);
  var fp = e.tank.position;
  var d = manhattan(cell, fp);
  var p = 0;
  // standoff 梯度：太近且能被射到
  if (d <= tp.standoff && canShoot(fp, cell, game.map)) p += (tp.standoff - d + 1) * 25;
  // 过载双弹覆盖带：同列/±1 相邻列且近距
  if (tp.doubleLane && d <= tp.standoff) {
    if (Math.abs(cell[0] - fp[0]) <= 1 || Math.abs(cell[1] - fp[1]) <= 1) p += 200;
  }
  // 冰冻同线 ≤4 必死区
  if (tp.freezeKill && d <= 4 && canShoot(fp, cell, game.map)) p += 300;
  return p;
}
