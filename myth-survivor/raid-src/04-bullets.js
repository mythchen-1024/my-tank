// ============================================================
// 04-bullets.js — 子弹威胁收集 / 躲弹 / 多发账本
// ============================================================

// 多子弹威胁：合并 game.visibleBullets + enemy.bullet + 各 enemies[].bullet + 子弹记忆，
// 去重 + 排除己方弹后，按危险半径过滤。state 传入则把移出视野锥的旧弹按外推位置补回。
function collectThreatBullets(me, enemy, game, state) {
  var myPos = me.tank.position;
  var raw = [];
  var vis = game.visibleBullets || [];
  for (var i = 0; i < vis.length; i++) pushBullet(raw, vis[i]);
  if (enemy && enemy.bullet) pushBullet(raw, enemy.bullet);
  var es = game.enemies || [];
  for (var j = 0; j < es.length; j++) if (es[j]) pushBullet(raw, es[j].bullet);

  // 子弹记忆：把见过、按速外推的敌弹补进来（即使本帧移出视野锥），去重交给 pushBullet。
  if (state) {
    updateBulletMemory(raw, state, game);
    for (var m = 0; m < state.bulletMem.length; m++) pushBullet(raw, state.bulletMem[m]);
  }

  var out = [];
  for (var k = 0; k < raw.length; k++) {
    if (isMyBullet(raw[k], me)) continue;
    if (manhattan(raw[k].position, myPos) <= DANGER_RADIUS + BULLET_SPEED) out.push(raw[k]);
  }
  return out;
}

// 子弹记忆更新：旧条目按速度外推一帧；本帧可见弹刷新对应轨迹(同向同定轴)的位置/帧号；超窗或出界丢弃。
// raw 为本帧实见敌弹(已含 visibleBullets 等，未排己方)。轨迹键=方向+定轴坐标(子弹直线飞，定轴不变)。
function updateBulletMemory(raw, state, game) {
  var f = game.frames || 0;
  var W = game.map ? game.map.length : 0, H = (game.map && game.map[0]) ? game.map[0].length : 0;
  var next = [];
  // 1) 旧记忆外推一帧。
  for (var i = 0; i < state.bulletMem.length; i++) {
    var b = state.bulletMem[i];
    if (f - b.frame >= BULLET_MEMORY_FRAMES) continue;
    var d = delta(b.direction);
    var np = [b.position[0] + d[0] * BULLET_SPEED, b.position[1] + d[1] * BULLET_SPEED];
    if (np[0] < 0 || np[1] < 0 || (W && np[0] >= W) || (H && np[1] >= H)) continue; // 飞出地图
    if (game.map && game.map[np[0]] && game.map[np[0]][np[1]] === "x") continue;     // 撞墙(子弹只被x挡,土堆可穿)
    next.push({ position: np, direction: b.direction, frame: b.frame, axis: b.axis });
  }
  // 2) 本帧实见弹刷新/新增（覆盖外推预测，位置更准）。
  for (var j = 0; j < raw.length; j++) {
    var rb = raw[j];
    if (!rb || !rb.position || !rb.direction) continue;
    var axis = (rb.direction === "left" || rb.direction === "right") ? rb.position[1] : rb.position[0];
    var hit = false;
    for (var n = 0; n < next.length; n++) {
      if (next[n].direction === rb.direction && next[n].axis === axis) {
        next[n].position = rb.position.slice(); next[n].frame = f; hit = true; break;
      }
    }
    if (!hit) next.push({ position: rb.position.slice(), direction: rb.direction, frame: f, axis: axis });
  }
  state.bulletMem = next;
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
function findBulletDodge(me, bullets, game, foe, state) {
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
    // 落点同轴前瞻：迎面冲向来弹（同行/列反向）时落点仍在弹道上，DODGE_LOOKAHEAD 帧内会被扫到→拒绝。
    // threatDirs 只屏蔽子弹行进方向、不挡迎面，facing 分支又只查当前格，故必须按落点判命中逼选垂直逃路。
    if (posHitWithin(bullets, cell, game, DODGE_LOOKAHEAD)) continue;
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
    // 多人：别躲进别的坦克炮口。落点被任一敌瞄准/可射 → 减分（不硬禁，留兜底）。
    score -= enemyFireLineRisk(cell, game);
    // 蹲草伏击：落点踩进确认蹲草敌的火线 → 减分（窄门控，仅记忆窗内）。
    score -= hiddenCamperRisk(cell, game, state);
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

// 多人躲弹辅助：落点 cell 被场上敌人炮线覆盖的风险分。
// 已对准 cell 的敌(近距)风险最高；仅能射到 cell 的次之。本地 1v1 无 enemies → 返回 0。
function enemyFireLineRisk(cell, game) {
  var es = game.enemies || [];
  var risk = 0;
  for (var i = 0; i < es.length; i++) {
    var e = es[i];
    if (!e || !e.tank || !e.tank.position || e.tank.crashed) continue;
    var fp = e.tank.position;
    if (!canShoot(fp, cell, game.map)) continue;
    var d = manhattan(fp, cell);
    if (d > 8) continue;
    if (pointsAt(e.tank.direction, fp, cell)) risk += 120 - d * 8; // 已瞄准：越近越凶
    else risk += 40 - d * 3;                                       // 仅同线可转身射
  }
  return risk > 0 ? risk : 0;
}

// 每帧维护 per-enemy 记忆（key=tank.id）：记可见敌的最后位置/朝向/技能/帧。
// 某敌这帧没刷新且最后位置在草丛 → 标记蹲草(hidden)，火线在记忆窗内仍当威胁。
function updateEnemyMemory(me, enemy, game, state) {
  if (!state.enemyMem) state.enemyMem = {};
  var mem = state.enemyMem;
  var f = game.frames || 0;
  var seen = {};
  var list = enemyCandidates(enemy, game);
  for (var i = 0; i < list.length; i++) {
    var e = list[i];
    var id = e.tank.id;
    if (id == null) continue;
    seen[id] = true;
    mem[id] = {
      pos: e.tank.position.slice(), dir: e.tank.direction,
      skill: (e.skill && e.skill.type) || null, frame: f, hidden: false
    };
  }
  // 未刷新的旧条目：在草丛上消失=蹲草；超窗或非草消失=丢弃。
  for (var k in mem) {
    if (!mem.hasOwnProperty(k) || seen[k]) continue;
    var m = mem[k];
    if (f - m.frame > CAMPER_MEMORY_FRAMES || !isGrass(m.pos, game.map)) { delete mem[k]; continue; }
    m.hidden = true;
  }
}

// 落点 cell 被「确认蹲草敌」火线覆盖的风险分。本地/线上同样有效（草丛隐身机制相同）。
function hiddenCamperRisk(cell, game, state) {
  if (!state || !state.enemyMem) return 0;
  var mem = state.enemyMem;
  var risk = 0;
  for (var k in mem) {
    if (!mem.hasOwnProperty(k)) continue;
    var m = mem[k];
    if (!m.hidden) continue;
    var d = manhattan(m.pos, cell);
    if (d === 0) { risk += 200; continue; }          // 别踩进它真身格
    if (d > CAMPER_FIRELINE_RANGE) continue;
    if (!canShoot(m.pos, cell, game.map)) continue;  // 须同线无遮挡
    if (pointsAt(m.dir, m.pos, cell)) risk += 160 - d * 10; // 已朝向 cell：越近越凶
    else risk += 50 - d * 4;                               // 仅同线可转身射
  }
  return risk > 0 ? risk : 0;
}
