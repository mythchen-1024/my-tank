// ============================================================
// 03-geometry.js — 几何 / 寻路 / 地图工具（底层，无依赖）
// ============================================================

// BFS 求 start->goal 最短路的第一步坐标，无路返回 null。
function nextStep(start, goal, map) {
  if (!goal) return null;
  var queue = [{ pos: start, first: null }];
  var seen = {};
  seen[key(start)] = true;
  for (var head = 0; head < queue.length; head++) {
    var item = queue[head];
    if (samePos(item.pos, goal)) return item.first;
    for (var i = 0; i < DIRS.length; i++) {
      var next = add(item.pos, delta(DIRS[i]));
      var k = key(next);
      if (seen[k] || !isOpen(next, map)) continue;
      seen[k] = true;
      queue.push({ pos: next, first: item.first || next });
    }
  }
  return null;
}

// near firing lane：pos 附近 within 格内是否有能射到 target 的格（技能 setup）。
function nearFiringLane(pos, target, map, within) {
  for (var dx = -within; dx <= within; dx++) {
    for (var dy = -within; dy <= within; dy++) {
      if (Math.abs(dx) + Math.abs(dy) > within) continue;
      var c = [pos[0] + dx, pos[1] + dy];
      if (!isOpen(c, map)) continue;
      if (canShoot(c, target, map)) return true;
    }
  }
  return false;
}

// 过载错位线：与敌相邻 ±1 列/行时，副弹覆盖方向。
function overloadOffsetDir(pos, fp, map) {
  if (Math.abs(pos[0] - fp[0]) === 1 && Math.abs(pos[1] - fp[1]) >= 1) {
    return fp[1] > pos[1] ? "down" : "up";
  }
  if (Math.abs(pos[1] - fp[1]) === 1 && Math.abs(pos[0] - fp[0]) >= 1) {
    return fp[0] > pos[0] ? "right" : "left";
  }
  return null;
}

function digDirection(pos, curDir, map) {
  if (isMound(add(pos, delta(curDir)), map)) return curDir;
  for (var i = 0; i < DIRS.length; i++) {
    if (isMound(add(pos, delta(DIRS[i])), map)) return DIRS[i];
  }
  return null;
}

function canShoot(a, b, map) {
  if (!a || !b || samePos(a, b)) return false;
  if (a[0] !== b[0] && a[1] !== b[1]) return false;
  var step = delta(directionTo(a, b));
  var pos = add(a, step);
  while (!samePos(pos, b)) {
    if (!isOpen(pos, map)) return false;
    pos = add(pos, step);
  }
  return true;
}

function pointsAt(dir, from, target) {
  if (dir === "up") return from[0] === target[0] && target[1] < from[1];
  if (dir === "right") return from[1] === target[1] && target[0] > from[0];
  if (dir === "down") return from[0] === target[0] && target[1] > from[1];
  if (dir === "left") return from[1] === target[1] && target[0] < from[0];
  return false;
}

function directionTo(a, b) {
  if (b[0] > a[0]) return "right";
  if (b[0] < a[0]) return "left";
  if (b[1] > a[1]) return "down";
  return "up";
}

function turnDirection(curDir, tgtDir) {
  var cur = DIRS.indexOf(curDir), tgt = DIRS.indexOf(tgtDir);
  if (cur < 0 || tgt < 0) return "right";
  var diff = (tgt - cur + 4) % 4;
  return diff === 3 ? "left" : "right";
}

function turnCountTo(curDir, tgtDir) {
  var a = DIRS.indexOf(curDir), b = DIRS.indexOf(tgtDir);
  if (a < 0 || b < 0) return 2;
  var diff = (b - a + 4) % 4;
  return Math.min(diff, 4 - diff);
}

function turnAfter(curDir, side) {
  var cur = DIRS.indexOf(curDir);
  if (cur < 0) return "up";
  return DIRS[(cur + (side === "left" ? 3 : 1)) % 4];
}

function delta(dir) {
  if (dir === "up") return [0, -1];
  if (dir === "right") return [1, 0];
  if (dir === "down") return [0, 1];
  return [-1, 0];
}

function add(pos, d) { return [pos[0] + d[0], pos[1] + d[1]]; }

function isOpen(pos, map) {
  return !!(map[pos[0]] && map[pos[0]][pos[1]] !== undefined &&
    map[pos[0]][pos[1]] !== "x" && map[pos[0]][pos[1]] !== "m");
}

function isMound(pos, map) {
  return !!(map[pos[0]] && map[pos[0]][pos[1]] === "m");
}

function isGrass(pos, map) {
  return !!(map[pos[0]] && map[pos[0]][pos[1]] === "o");
}

function openNeighborCount(pos, map) {
  var n = 0;
  for (var i = 0; i < DIRS.length; i++) if (isOpen(add(pos, delta(DIRS[i])), map)) n++;
  return n;
}

function edgeDistance(pos, map) {
  var w = map.length, h = map[0].length;
  return Math.min(pos[0], w - 1 - pos[0], pos[1], h - 1 - pos[1]);
}

function samePos(a, b) { return a && b && a[0] === b[0] && a[1] === b[1]; }
function manhattan(a, b) { return Math.abs(a[0] - b[0]) + Math.abs(a[1] - b[1]); }
function key(pos) { return pos[0] + "," + pos[1]; }

function clearBetween(a, b, game) {
  var step = delta(directionTo(a, b));
  var pos = add(a, step);
  while (!samePos(pos, b)) {
    if (!isOpen(pos, game.map)) return false;
    pos = add(pos, step);
  }
  return true;
}
