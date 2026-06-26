// ============================================================
// 04-bullets.js — 子弹威胁收集 / 躲弹 / 多发账本
// ============================================================

// 多子弹威胁：合并 game.visibleBullets + enemy.bullet + 各 enemies[].bullet，
// 去重 + 排除己方弹后，按危险半径过滤。
function collectThreatBullets(me, enemy, game) {
  var myPos = me.tank.position;
  var raw = [];
  var vis = game.visibleBullets || [];
  for (var i = 0; i < vis.length; i++) pushBullet(raw, vis[i]);
  if (enemy && enemy.bullet) pushBullet(raw, enemy.bullet);
  var es = game.enemies || [];
  for (var j = 0; j < es.length; j++) if (es[j]) pushBullet(raw, es[j].bullet);

  var out = [];
  for (var k = 0; k < raw.length; k++) {
    if (isMyBullet(raw[k], me)) continue;
    if (manhattan(raw[k].position, myPos) <= DANGER_RADIUS + BULLET_SPEED) out.push(raw[k]);
  }
  return out;
}

function isMyBullet(b, me) {
  var mine = me && me.bullet;
  if (!mine || !mine.position) return false;
  return samePos(b.position, mine.position) && b.direction === mine.direction;
}

function pushBullet(arr, b) {
  if (!b || !b.position || !b.direction) return;
  for (var i = 0; i < arr.length; i++) {
    if (samePos(arr[i].position, b.position) && arr[i].direction === b.direction) return;
  }
  arr.push(b);
}

// 躲弹：在 4 邻格里找「走过去能活」的安全格。转身帧安全严格按子弹时序。
function findBulletDodge(me, bullets, game, foe) {
  var pos = me.tank.position, dir = me.tank.direction;
  if (!bullets || !bullets.length) return null;
  var incoming = minBulletFramesTo(bullets, pos, game);
  var threatDirs = {};
  for (var t = 0; t < bullets.length; t++) {
    if (bulletReachTiles(bullets[t], pos, game) >= 0) threatDirs[bullets[t].direction] = true;
  }
  var best = null, bestScore = -Infinity;
  for (var i = 0; i < DIRS.length; i++) {
    var d = DIRS[i];
    if (threatDirs[d]) continue;
    var cell = add(pos, delta(d));
    if (!isOpen(cell, game.map)) continue;
    if (stepIntoBulletPath(bullets, cell, game)) continue;
    var facing = (dir === d);
    if (facing) {
      if (incoming >= 0 && incoming < 1) continue;
    } else {
      if (incoming >= 0 && incoming < 3) continue;
      var nextB = advanceBullets(bullets, BULLET_SPEED);
      if (stepIntoBulletPath(nextB, cell, game)) continue;
    }
    var exits = openNeighborCount(cell, game.map);
    // facing +150: 已朝向的安全格这帧能直接 go 走出去；转向那帧不移动=白挨一发。
    // 提到 150 让「朝活路直接走」稳压侧向小优势(exits/edge/canShoot 合计≤~98)，
    // 但仍低于死角 -150：朝向是死角时才转身避开。消除原地转身横摆。
    var score = (facing ? 150 : 0) + exits * 12 - (exits <= 1 ? 150 : 0) + edgeDistance(cell, game.map) * 2;
    if (foe && foe.tank && canShoot(cell, foe.tank.position, game.map)) score += 30;
    if (score > bestScore) { bestScore = score; best = d; }
  }
  if (best == null) return null;
  return (dir === best) ? { type: "go", tag: "躲弹" } : { type: "turn", side: turnDirection(dir, best), tag: "躲弹" };
}

function posHitWithin(bullets, pos, game, frames) {
  var list = bullets || [];
  for (var i = 0; i < list.length; i++) {
    var f = bulletFramesTo(list[i], pos, game);
    if (f >= 0 && f <= frames) return true;
    if (samePos(list[i].position, pos)) return true;
  }
  return false;
}

function bulletReachTiles(bullet, pos, game) {
  if (!bullet || !bullet.position) return -1;
  var bp = bullet.position;
  if (bp[0] === pos[0]) {
    var dy = pos[1] - bp[1];
    if (bullet.direction === "down" && dy > 0) return clearBetween(bp, pos, game) ? dy : -1;
    if (bullet.direction === "up" && dy < 0) return clearBetween(bp, pos, game) ? -dy : -1;
  }
  if (bp[1] === pos[1]) {
    var dx = pos[0] - bp[0];
    if (bullet.direction === "right" && dx > 0) return clearBetween(bp, pos, game) ? dx : -1;
    if (bullet.direction === "left" && dx < 0) return clearBetween(bp, pos, game) ? -dx : -1;
  }
  return -1;
}

function bulletFramesTo(bullet, pos, game) {
  var tiles = bulletReachTiles(bullet, pos, game);
  if (tiles < 0) return -1;
  return Math.ceil(tiles / BULLET_SPEED);
}

function minBulletFramesTo(bullets, pos, game) {
  var best = -1;
  for (var i = 0; i < bullets.length; i++) {
    var f = bulletFramesTo(bullets[i], pos, game);
    if (f >= 0 && (best < 0 || f < best)) best = f;
  }
  return best;
}

function advanceBullets(bullets, steps) {
  var out = [];
  for (var i = 0; i < bullets.length; i++) {
    var b = bullets[i];
    if (!b || !b.position) continue;
    var d = delta(b.direction);
    out.push({ position: [b.position[0] + d[0] * steps, b.position[1] + d[1] * steps], direction: b.direction });
  }
  return out;
}

function stepIntoBulletPath(bullets, cell, game) {
  var list = bullets || [];
  for (var i = 0; i < list.length; i++) {
    var b = list[i];
    if (!b || !b.position) continue;
    if (samePos(b.position, cell)) return true;
    var tiles = bulletReachTiles(b, cell, game);
    if (tiles >= 0 && tiles <= BULLET_SPEED) return true;
    var d = delta(b.direction);
    for (var step = 1; step <= BULLET_SPEED; step++) {
      if (samePos([b.position[0] + d[0] * step, b.position[1] + d[1] * step], cell)) return true;
    }
  }
  return false;
}

// ---- 多发子弹账本：相信在场己方弹数 < MULTI_BULLET_CAP 才允许开火 ----
// 双信号取上界：己方开火账本(主) + visibleBullets 轴向校验(下界)。
function gunHasBudget(me, state, game) {
  return countMyBulletsInFlight(me, state, game) < MULTI_BULLET_CAP;
}

function countMyBulletsInFlight(me, state, game) {
  var f = game.frames || 0;
  var alive = 0, kept = [];
  for (var i = 0; i < state.myShots.length; i++) {
    if (f - state.myShots[i].frame < BULLET_LIFETIME) { kept.push(state.myShots[i]); alive += state.myShots[i].count; }
  }
  state.myShots = kept;

  var visMine = 0;
  var pos = me.tank.position, dir = me.tank.direction;
  var vis = game.visibleBullets || [];
  for (var j = 0; j < vis.length; j++) {
    var b = vis[j];
    if (!b || !b.position || b.direction !== dir) continue;
    if (bulletAheadOf(b, pos, dir)) visMine++;
  }
  return Math.max(alive, visMine);
}

// 记一发开火（overload 激活时记 2 弹）。
function recordShot(me, state, game) {
  var count = (me.status && me.status.overloaded) ? 2 : 1;
  state.myShots.push({ frame: game.frames || 0, count: count });
}

function bulletAheadOf(b, pos, dir) {
  var bp = b.position;
  if (dir === "up") return bp[0] === pos[0] && bp[1] < pos[1];
  if (dir === "down") return bp[0] === pos[0] && bp[1] > pos[1];
  if (dir === "left") return bp[1] === pos[1] && bp[0] < pos[0];
  if (dir === "right") return bp[1] === pos[1] && bp[0] > pos[0];
  return false;
}
