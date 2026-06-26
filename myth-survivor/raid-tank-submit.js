// ============================================================
// raid-tank-submit.js — 出击(raid)攻击优先坦克 AI（自动生成，请勿手动编辑）
// 源目录: raid-src/  顺序: 01-constants.js, 02-matchup.js, 03-geometry.js, 04-bullets.js, 05-targeting.js, 06-skills.js, 07-positioning.js, 08-entry.js
// 构建时间: 2026-06-26T03:21:40.731Z
// ============================================================
// ===== 01-constants.js =====
// ============================================================
// 01-constants.js — 常量 + 跨帧状态
// ============================================================

var BULLET_SPEED = 2;          // 子弹每帧移动格数
var DODGE_LOOKAHEAD = 3;       // 躲弹预判帧数
var DANGER_RADIUS = 4;         // 威胁子弹危险半径（曼哈顿）
var DIRS = ["up", "right", "down", "left"];

// 多发子弹账本：相信在场的己方弹数 < 此值才允许开火。
// 默认 1 = 单弹在场就不重复开火。线上拿到多发等级后调高（overload 一发记 2 弹）。
var MULTI_BULLET_CAP = 1;
var BULLET_LIFETIME = 14;      // 一发弹在场的最长追踪帧数（地图最长边/2 + 余量）

// 跨帧持久状态（新对局/新生命自动重置）。
var RAID_STATE = {
  lastFrame: -1, firedThisLife: false, myShots: [],
  patrol: null, gunLine: null, speakCount: 0, lastSpeak: ""
};

// 新对局（帧号回退）或新生命（帧号大跳变）自动重置。
function getState(game) {
  var f = game.frames || 0;
  if (f < RAID_STATE.lastFrame || f - RAID_STATE.lastFrame > 4) {
    RAID_STATE = { lastFrame: f, firedThisLife: false, myShots: [], patrol: null, gunLine: null, speakCount: 0, lastSpeak: "" };
  }
  RAID_STATE.lastFrame = f;
  return RAID_STATE;
}


// ===== 02-matchup.js =====
// ============================================================
// 02-matchup.js — 技能对抗矩阵 + 敌方技能威胁画像
// 移植 all-round-tank/nodes-skill.js + enemy-profiler.js（裁剪）。
// ============================================================

// getMatchup(我技能, 敌技能) -> 施放距离/是否要射线/是否避盾 等阈值。
var MATCHUP_DEFAULTS = {
  freezeKillRange: 5, freezeKillRequireShot: false, freezeAvoidShielded: true,
  stunKillRange: 7, stunBypassShield: true,
  overloadRange: 5, overloadRequireShot: false, overloadWaitShield: true,
  poisonRange: 5, poisonBypassShield: true,
  cloakSneakRange: 8, cloakSneakEnabled: true,
  shieldCounterRange: 4,
  boostChaseRange: 6
};

var MATCHUP_OVERRIDES = {
  freeze: {
    shield: { freezeKillRange: 3, freezeKillRequireShot: true, freezeAvoidShielded: true },
    teleport: { freezeKillRange: 3 }, boost: { freezeKillRange: 3 }, cloak: { freezeKillRange: 3 }
  },
  stun: {
    shield: { stunKillRange: 4, stunBypassShield: true },
    teleport: { stunKillRange: 6 }, freeze: { stunKillRange: 5 }
  },
  overload: {
    shield: { overloadRange: 4, overloadRequireShot: true, overloadWaitShield: true },
    teleport: { overloadRange: 4, overloadRequireShot: true },
    boost: { overloadRange: 4 }, cloak: { overloadRange: 6 }
  },
  poison: {
    shield: { poisonRange: 6, poisonBypassShield: true },
    teleport: { poisonRange: 4 }, boost: { poisonRange: 6 }, freeze: { poisonRange: 5 }
  },
  cloak: {
    cloak: { cloakSneakEnabled: false }, overload: { cloakSneakRange: 5 }, freeze: { cloakSneakRange: 8 }
  },
  shield: {
    freeze: { shieldCounterRange: 3 }, overload: { shieldCounterRange: 3 }, stun: { shieldCounterRange: 3 }
  },
  boost: {
    freeze: { boostChaseRange: 7 }, overload: { boostChaseRange: 4 }, poison: { boostChaseRange: 5 }
  }
};

function getMatchup(mySkill, enemySkill) {
  var p = {};
  for (var k in MATCHUP_DEFAULTS) if (MATCHUP_DEFAULTS.hasOwnProperty(k)) p[k] = MATCHUP_DEFAULTS[k];
  var ov = MATCHUP_OVERRIDES[mySkill] && MATCHUP_OVERRIDES[mySkill][enemySkill];
  if (ov) for (var j in ov) if (ov.hasOwnProperty(j)) p[j] = ov[j];
  return p;
}

// 敌方技能威胁画像：驱动选靶权重 + 落点惩罚（裁剪自 SKILL_PROFILES）。
//   standoff     该敌的安全间距（落点惩罚梯度）
//   threatWeight 选靶威胁权重（越高越优先处理/拉开）
//   doubleLane   过载流：覆盖同列 ±1 相邻列
//   freezeKill   冰冻流：同线 ≤4 必死区
//   cloakSneaker 隐身流：可能蹲草偷袭
var ENEMY_THREAT_PROFILE = {
  overload: { standoff: 6, threatWeight: 6, doubleLane: true, freezeKill: false, cloakSneaker: false },
  freeze:   { standoff: 5, threatWeight: 5, doubleLane: false, freezeKill: true, cloakSneaker: false },
  stun:     { standoff: 4, threatWeight: 4, doubleLane: false, freezeKill: false, cloakSneaker: false },
  poison:   { standoff: 4, threatWeight: 4, doubleLane: false, freezeKill: false, cloakSneaker: false },
  cloak:    { standoff: 4, threatWeight: 4, doubleLane: false, freezeKill: false, cloakSneaker: true },
  teleport: { standoff: 3, threatWeight: 3, doubleLane: false, freezeKill: false, cloakSneaker: false },
  shield:   { standoff: 3, threatWeight: 2, doubleLane: false, freezeKill: false, cloakSneaker: false },
  boost:    { standoff: 4, threatWeight: 3, doubleLane: false, freezeKill: false, cloakSneaker: false }
};
var DEFAULT_THREAT = { standoff: 4, threatWeight: 3, doubleLane: false, freezeKill: false, cloakSneaker: false };
function threatProfile(skillType) {
  return (skillType && ENEMY_THREAT_PROFILE[skillType]) || DEFAULT_THREAT;
}


// ===== 03-geometry.js =====
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


// ===== 04-bullets.js =====
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
    var score = (facing ? 100 : 0) + exits * 12 - (exits <= 1 ? 150 : 0) + edgeDistance(cell, game.map) * 2;
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


// ===== 05-targeting.js =====
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
function actionDanger(action, me, foe, threats, game) {
  if (action.type === "useskill" || action.type === "fire" || action.type === "flick") return 0;
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


// ===== 06-skills.js =====
// ============================================================
// 06-skills.js — 进攻技能分派(技能无关) + 已激活技能后续 + 防御技能
// raid 敌不躲弹 → 冻/晕/双弹/毒/偷袭命中率极高，给高分(>狂射850)。
// 施放阈值走 getMatchup(mySkill, 该敌skill)。每个动作单命令（boost 甩狙除外）。
// ============================================================

function skillOffense(me, foe, game, threats, mySkill, hasBudget) {
  if (!foe || !foe.tank || !foe.tank.position) return null;
  if (!skillReady(me)) {
    // 技能没好：处理「已激活技能」的后续开火（过载/护盾/隐身中对准就射）。
    return activeSkillFollowup(me, foe, game, hasBudget);
  }
  var pos = me.tank.position, dir = me.tank.direction;
  var fp = foe.tank.position;
  var d = manhattan(pos, fp);
  var es = (foe.skill && foe.skill.type) || null;
  var mp = getMatchup(mySkill, es);
  var hasShot = canShoot(pos, fp, game.map);
  var selfDanger = posHitWithin(threats, pos, game, 1);
  if (selfDanger) return null; // 技能激活占1帧，受威胁时别站着放
  var enemyShielded = foe.status && foe.status.shielded;

  // freeze：可见+同线+近距+冷却好 → 冻（下帧补刀）
  if (mySkill === "freeze") {
    if (mp.freezeAvoidShielded && enemyShielded) return null;
    if (hasShot && d <= 4 && hasBudget) return { type: "useskill", skill: "freeze", score: 970, tag: "冰杀" };
    if (!hasShot && d <= mp.freezeKillRange && !mp.freezeKillRequireShot && nearFiringLane(pos, fp, game.map, 2))
      return { type: "useskill", skill: "freeze", score: 940, tag: "冰冻" };
    return null;
  }
  // stun：有射线任意距离 → 晕（6帧窗口宽）
  if (mySkill === "stun") {
    if (hasShot) return { type: "useskill", skill: "stun", score: 965, tag: "眩晕" };
    if (d <= mp.stunKillRange && nearFiringLane(pos, fp, game.map, 3))
      return { type: "useskill", skill: "stun", score: 935, tag: "眩晕" };
    return null;
  }
  // overload：同线/偏移线近距 → 过载（双弹覆盖）。等盾碎。
  if (mySkill === "overload") {
    if (mp.overloadWaitShield && enemyShielded) return null;
    var offset = overloadOffsetDir(pos, fp, game.map);
    if (d <= mp.overloadRange && (hasShot || offset || (!mp.overloadRequireShot && nearFiringLane(pos, fp, game.map, 2))))
      return { type: "useskill", skill: "overload", score: 960, tag: "过载" };
    return null;
  }
  // poison：近距 → 下毒（无视盾）
  if (mySkill === "poison") {
    var dx = Math.abs(pos[0] - fp[0]), dy = Math.abs(pos[1] - fp[1]);
    if (d <= mp.poisonRange && (hasShot || dx <= 2 || dy <= 2))
      return { type: "useskill", skill: "poison", score: 955, tag: "下毒" };
    return null;
  }
  // cloak：中距未对准未被发现 → 隐身潜行偷袭
  if (mySkill === "cloak") {
    if (mp.cloakSneakEnabled && !hasShot && d <= mp.cloakSneakRange)
      return { type: "useskill", skill: "cloak", score: 930, tag: "潜行" };
    return null;
  }
  // shield：敌瞄我同线近距 → 开盾安全对射
  if (mySkill === "shield") {
    if (hasShot && hasBudget && d <= mp.shieldCounterRange && pointsAt(foe.tank.direction, fp, pos))
      return { type: "useskill", skill: "shield", score: 945, tag: "盾击" };
    return null;
  }
  // boost：中距未对准 → 加速逼近到射线位
  if (mySkill === "boost") {
    if (!hasShot && d >= 3 && d <= mp.boostChaseRange)
      return { type: "useskill", skill: "boost", score: 600, tag: "加速攻" };
    return null;
  }
  return null;
}

// 已激活技能（过载/护盾/隐身/加速）的后续开火：对准就射，未对准转向。
function activeSkillFollowup(me, foe, game, hasBudget) {
  if (!foe || !foe.tank) return null;
  var pos = me.tank.position, dir = me.tank.direction, fp = foe.tank.position;
  var st = me.status || {};
  var hasShot = canShoot(pos, fp, game.map);

  // boost 甩狙：加速中 + 同线无遮挡 + 差 90° → turn+fire 同帧（唯一同帧多命令）。
  if (st.boosted && hasBudget && hasShot && !pointsAt(dir, pos, fp)) {
    var fd = directionTo(pos, fp);
    if (turnCountTo(dir, fd) === 1)
      return { type: "flick", side: turnDirection(dir, fd), fire: true, score: 980, tag: "甩狙" };
  }
  // 过载/护盾/隐身激活中：对准就射，未对准转向。
  if (st.overloaded || st.shielded || st.cloaked) {
    if (hasShot && hasBudget) {
      if (pointsAt(dir, pos, fp)) return { type: "fire", fire: true, score: 975, tag: "技射" };
      return { type: "turn", side: turnDirection(dir, directionTo(pos, fp)), score: 760, tag: "技瞄" };
    }
    if (st.overloaded && hasBudget) {
      var off = overloadOffsetDir(pos, fp, game.map);
      if (off) {
        if (dir === off) return { type: "fire", fire: true, score: 940, tag: "错位弹" };
        return { type: "turn", side: turnDirection(dir, off), score: 740, tag: "错位瞄" };
      }
    }
  }
  return null;
}

// 防御技能（仅躲不掉实弹时）：shield 挡 / cloak·boost 逃。debuff 技能不做防御。
function defensiveSkill(me, mySkill, threats, game) {
  if (!skillReady(me)) return null;
  if (mySkill === "shield") return { type: "useskill", skill: "shield", tag: "挡弹" };
  if (mySkill === "cloak") return { type: "useskill", skill: "cloak", tag: "隐遁" };
  if (mySkill === "boost") return { type: "useskill", skill: "boost", tag: "加速逃" };
  return null;
}

function skillReady(me) {
  return !!(me.skill && me.skill.remainingCooldownFrames === 0);
}


// ===== 07-positioning.js =====
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


// ===== 08-entry.js =====
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
    var dodge = findBulletDodge(me, threats, game, chooseMainTarget(me, enemy, game));
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

  // [4] 进攻技能击杀（技能无关分派）：返回评分候选或 null。
  var skillAtk = mySkill ? skillOffense(me, foe, game, threats, mySkill, hasBudget) : null;
  if (skillAtk) cands.push(skillAtk);

  // [4.5] 对炮存活闸门：与目标同线近距、对方能开火且我不占先手 → 先脱线，别站着换命。
  var duelDodge = (foePos) ? findLineDuelDodge(me, foe, threats, game) : null;
  if (duelDodge) cands.push(withScore(duelDodge, 880, duelDodge.tag));

  // [5] 同轴狂射（raid 核心，高于抢星）：任一敌同线无遮挡、炮管有预算 → 对准开火。
  //     敌不躲弹 → 射程拉满（不偏好近距）。无遮挡且 budget 才打。
  if (foePos && hasBudget && canShoot(pos, foePos, game.map) && !duelDodge) {
    var fireAct = actionToDir(pos, dir, directionTo(pos, foePos), "fire");
    cands.push(withScore(fireAct, 850 + lineRangeBonus(pos, foePos), "狂射"));
  }
  // 同轴但未对准/无预算：仍预瞄转向（不射子弹，保持先手姿态）。
  if (foePos && canShoot(pos, foePos, game.map) && dir !== directionTo(pos, foePos)) {
    cands.push(withScore({ type: "turn", side: turnDirection(dir, directionTo(pos, foePos)) }, 700, "瞄准"));
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
    cands[j].score -= actionDanger(cands[j], me, foe, threats, game);
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
