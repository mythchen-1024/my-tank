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
  var pos = me.tank.position, dir = me.tank.direction;
  var nextPos = pos, nextDir = dir;
  if (action.type === "go") nextPos = add(pos, delta(dir));
  if (action.type === "turn") nextDir = turnAfter(dir, action.side);

  var penalty = 0;
  if (action.type === "go" && stepIntoBulletPath(threats, nextPos, game)) penalty += 2000;
  if (posHitWithin(threats, nextPos, game, 1)) penalty += 800;

  // 主敌贴脸 / 被瞄
  if (foe && foe.tank) {
    penalty += enemyDanger(foe, nextPos, game);
  }
  // 全体敌人的技能死区（双弹覆盖带 / 冰冻同线死区 / standoff 梯度）
  var es = game.enemies || [];
  for (var i = 0; i < es.length; i++) {
    var e = es[i];
    if (!e || !e.tank || !e.tank.position || e.tank.crashed) continue;
    if (foe && e === foe) continue;
    penalty += skillZonePenalty(e, nextPos, game) * 0.6; // 非主敌折扣
  }
  // 蹲草伏击：走/转后落点踩进确认蹲草敌的火线 → 罚（窄门控，仅记忆窗内）。
  if (action.type === "go") penalty += hiddenCamperRisk(nextPos, game, state);
  return penalty;
}

// 主敌的贴脸/被瞄/技能死区惩罚。
function enemyDanger(foe, nextPos, game) {
  var fp = foe.tank.position;
  var d = manhattan(nextPos, fp);
  var p = 0;
  if (d <= 1) p += 1500;
  else if (d <= 4 && canShoot(fp, nextPos, game.map) && pointsAt(foe.tank.direction, fp, nextPos)) p += 1200;
  else if (d <= 6 && canShoot(fp, nextPos, game.map) && pointsAt(foe.tank.direction, fp, nextPos)) p += 180;
  p += skillZonePenalty(foe, nextPos, game);
  return p;
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
