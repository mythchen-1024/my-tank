// ============================================================
// 07-positioning.js — 对炮脱线 / 守枪线 / 虚拟巡逻
// ============================================================

// 对炮存活闸门：与某敌同线近距、对方能开火且我不占先手时先脱线。
function findLineDuelDodge(me, foe, threats, game) {
  if (!foe || !foe.tank) return null;
  if (!foeCanFireSoon(foe)) return null;
  var pos = me.tank.position, dir = me.tank.direction, fp = foe.tank.position;
  if (!canShoot(pos, fp, game.map)) return null;
  var dist = manhattan(pos, fp);
  if (dist > 5) return null;
  var lineToFoe = directionTo(pos, fp), lineToMe = directionTo(fp, pos);
  var fly = Math.ceil(dist / BULLET_SPEED);
  var myDuel = turnCountTo(dir, lineToFoe) + fly;
  var foeDuel = turnCountTo(foe.tank.direction, lineToMe) + fly;
  if (myDuel < foeDuel) return null;
  var vertical = (lineToFoe === "up" || lineToFoe === "down");
  var perp = vertical ? ["left", "right"] : ["up", "down"];
  var best = null, bestScore = -Infinity;
  for (var i = 0; i < perp.length; i++) {
    var d = perp[i];
    var p = add(pos, delta(d));
    if (!isOpen(p, game.map)) continue;
    if (stepIntoBulletPath(threats, p, game)) continue;
    if (posHitWithin(threats, p, game, 1)) continue;
    if (canShoot(fp, p, game.map) && pointsAt(foe.tank.direction, fp, p)) continue;
    var escapeFrames = (d === dir) ? 1 : 2;
    if (!((escapeFrames === 1) || (escapeFrames < foeDuel))) continue;
    var facing = (d === dir) ? 100 : 0;
    var counterLine = canShoot(p, fp, game.map) ? 15 : 0;
    var score = facing + counterLine + manhattan(p, fp) + edgeDistance(p, game.map);
    if (score > bestScore) { bestScore = score; best = d; }
  }
  if (best == null) return null;
  return (dir === best) ? { type: "go", tag: "脱线" } : { type: "turn", side: turnDirection(dir, best), tag: "脱线" };
}

function foeCanFireSoon(foe) {
  if (!foe || !foe.tank) return false;
  if (foe.bullet && foe.bullet.position) return false;
  return true;
}

// 守枪线：选靠近星 / 控制走廊咽喉的格位蹲守（黏滞）。
function gunLineStep(me, game, state, foePos) {
  var pos = me.tank.position;
  if (state.gunLine && isOpen(state.gunLine, game.map) && !samePos(state.gunLine, pos)) {
    var step0 = nextStep(pos, state.gunLine, game.map);
    if (step0) return step0;
  }
  var anchor = null;
  if (game.star) anchor = pickStarGuardCell(pos, game.star, game.map);
  if (!anchor) anchor = pickChokeCell(pos, game.map, foePos);
  state.gunLine = anchor;
  if (anchor && !samePos(anchor, pos)) return nextStep(pos, anchor, game.map);
  return null;
}

function pickStarGuardCell(pos, star, map) {
  var best = null, bestScore = -Infinity;
  for (var dx = -3; dx <= 3; dx++) {
    for (var dy = -3; dy <= 3; dy++) {
      var c = [star[0] + dx, star[1] + dy];
      if (!isOpen(c, map)) continue;
      var d = Math.abs(dx) + Math.abs(dy);
      if (d < 2 || d > 3) continue;
      if (!canShoot(c, star, map)) continue;
      var sc = openNeighborCount(c, map) * 10 - manhattan(pos, c);
      if (sc > bestScore) { bestScore = sc; best = c; }
    }
  }
  return best;
}

function pickChokeCell(pos, map, foePos) {
  var w = map.length, h = map[0].length;
  var anchors = [[w >> 1, h >> 1], [1, 1], [w - 2, 1], [1, h - 2], [w - 2, h - 2]];
  var best = null, bestScore = -Infinity;
  for (var i = 0; i < anchors.length; i++) {
    var a = anchors[i];
    if (!isOpen(a, map) || samePos(a, pos)) continue;
    var sc = openNeighborCount(a, map) * 8 + (foePos ? manhattan(a, foePos) : 0) - manhattan(pos, a);
    if (sc > bestScore && nextStep(pos, a, map)) { bestScore = sc; best = a; }
  }
  return best;
}

// 虚拟巡逻兜底：黏滞走向远离敌的锚点，避免原地发呆。
function virtualPatrol(me, game, state, foePos) {
  var pos = me.tank.position;
  var w = game.map.length, h = game.map[0].length;
  if (state.patrol && isOpen(state.patrol, game.map) && !samePos(state.patrol, pos)) {
    if (!foePos || manhattan(state.patrol, foePos) >= 3) {
      var step = nextStep(pos, state.patrol, game.map);
      if (step) return step;
    }
  }
  var anchors = [[1, 1], [w - 2, 1], [1, h - 2], [w - 2, h - 2], [(w >> 1), (h >> 1)]];
  var best = null, bestScore = -Infinity;
  for (var i = 0; i < anchors.length; i++) {
    var a = anchors[i];
    if (!isOpen(a, game.map) || samePos(a, pos)) continue;
    var sc = foePos ? manhattan(a, foePos) : (10 - manhattan(a, pos));
    if (sc > bestScore && nextStep(pos, a, game.map)) { bestScore = sc; best = a; }
  }
  state.patrol = best;
  return best ? nextStep(pos, best, game.map) : null;
}

function patrolForward(pos, dir, map) {
  if (isOpen(add(pos, delta(dir)), map)) return { type: "go", tag: "巡逻" };
  return { type: "turn", side: "right", tag: "巡逻" };
}
