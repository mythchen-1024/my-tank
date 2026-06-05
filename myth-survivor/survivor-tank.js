// ============================================================
// survivor-tank.js — AgenTank 生存 / 出击模式坦克（技能：freeze 冰冻）
//
// 目标分支：raid（出击分支）/ multiplayer（多人分支）
// 入口：onIdle(me, enemy, game)，向后兼容 1v1。
//
// 设计基线：以已验证的 raid v9 freeze 评分式 bot 为骨架，叠加排名坦克
// 的优秀策略，并加入多坦克生存逻辑。决策严格分层（呼应 CLAUDE.md 朴素规则）：
//   [1] 多子弹威胁躲避（最高，含转身帧安全）
//   [2] freeze 技能（敌瞄准我且近距时冻结）
//   [3] 同线先转后射
//   [4] 抢星 / 追击评分
//   [5] 虚拟巡逻兜底（无射线无星不发呆）
//   每个走/转候选都减去 actionDanger（贴脸 / 被瞄格重罚 = 致命硬红线）
//
// 引擎机制：子弹 2 格/帧、坦克 1 格/帧、转向占 1 帧。
// 多人字段：game.enemies / game.visibleBullets / game.alivePlayers（均做 null 防御）。
// ============================================================

var BULLET_SPEED = 2;          // 子弹每帧移动格数
var DODGE_LOOKAHEAD = 3;       // 躲弹预判帧数
var DANGER_RADIUS = 4;         // 威胁子弹危险半径（曼哈顿）
var DIRS = ["up", "right", "down", "left"];

// 跨帧持久状态（巡逻点黏滞，避免每帧重选导致横跳）
var SURV_STATE = { lastFrame: -1, patrol: null, speakCount: 0, lastSpeak: "" };

function onIdle(me, enemy, game) {
  var pos = me.tank.position;
  var dir = me.tank.direction;
  var state = getState(game);

  // 硬状态拦截：被冻结时无法行动
  if (me.status && me.status.frozen) return;

  var threats = collectThreatBullets(me, enemy, game);

  // ---- [1] 生存硬闸门：当前位置受威胁则优先躲避 ----
  if (posHitWithin(threats, pos, game, DODGE_LOOKAHEAD)) {
    var dodge = findBulletDodge(me, threats, game, enemy);
    if (dodge) { execAction(me, dodge); say(me, state, "躲弹"); return; }
    // 无安全邻格：尝试反击（同帧可能换掉对射），否则保持评分流程兜底
  }

  // ---- [2~5] 评分裁决 ----
  var decision = chooseScoredDecision(me, enemy, game, threats, state);
  execAction(me, decision);
  say(me, state, decision.tag);
}

// ============================================================
// 评分式决策：收集候选动作，减去危险惩罚，取最高分。
// ============================================================
function chooseScoredDecision(me, enemy, game, threats, state) {
  var pos = me.tank.position;
  var dir = me.tank.direction;
  var foe = chooseMainTarget(me, enemy, game);
  var foePos = foe && foe.tank ? foe.tank.position : null;
  var alive = (typeof game.alivePlayers === "number") ? game.alivePlayers : 2;
  // 存活越多越保守：抬高生存权重、压低主动贴脸（仅剩 2 家时归零）
  var crowd = Math.max(0, alive - 2);
  var late = game.frames > 80;

  var cands = [];

  // [2] freeze：敌瞄准我、同线、近距、冷却好 -> 冻结（多敌取最近瞄我之敌）
  if (canFreeze(me, game, threateningFoe(me, enemy, game))) {
    cands.push({ type: "freeze", score: 1000, tag: "冰冻" });
  }

  // [2.5] 对炮存活闸门：与目标同线近距、对方能开火且我不占先手时，先侧移脱线而非站着对射。
  // 这是出击分支的基线红线——绝不在不占先手的对炮里站着换命。
  var duelDodge = (foePos) ? findLineDuelDodge(me, foe, threats, game) : null;
  if (duelDodge) {
    cands.push(withScore(duelDodge, 900, duelDodge.tag)); // 高于直射(850)，低于躲实弹/冰冻
  }

  // [3] 同线先转后射：与目标同行/列且无遮挡。
  // 但若对炮闸门判定我不占先手(duelDodge 已生成脱线提案)，则压制本帧开火，避免换命。
  if (foePos && canShoot(pos, foePos, game.map) && !duelDodge) {
    cands.push(withScore(actionToDir(pos, dir, directionTo(pos, foePos), "fire"),
      850 + closeBonus(pos, foePos) + starLineScore(pos, game.star, game.map, late), "直射"));
  }

  // [4] 抢星：BFS 下一步。出击分支本质是赚星，安全时吃星应压过"顺手对射"(直射850)。
  // 基础分提到 900：仍低于生存层(躲实弹硬闸门/冰冻1000/对炮脱线900)，危险落点由 actionDanger 重罚拦下。
  var starStep = game.star && nextStep(pos, game.star, game.map);
  if (starStep) {
    cands.push(withScore(actionToDir(pos, dir, directionTo(pos, starStep), "go"),
      900 + starUrgency(pos, starStep, game.star) + starLineScore(starStep, game.star, game.map, late), "抢星"));
  }

  // [4b] 追击：无星或残局，且存活数少时才主动逼近（避免混战贴脸）
  var chase = ((!starStep || late) && foePos && crowd === 0) ? nextStep(pos, foePos, game.map) : null;
  if (chase) {
    cands.push(withScore(actionToDir(pos, dir, directionTo(pos, chase), "go"),
      500 + (late ? 200 : 0), "追击"));
  }

  // [4c] 破墙开路：前方/邻格是土堆时射穿
  var dig = digDirection(pos, dir, game.map);
  if (dig) {
    cands.push(withScore(actionToDir(pos, dir, dig, "fire"),
      360 + (starStep ? 0 : 120) + (late ? 130 : 0), "破墙"));
  }

  // [5] 虚拟巡逻兜底：朝持久巡逻点走，无则前进/右转
  var patrolStep = virtualPatrol(me, game, state, foePos);
  var patrolAct = patrolStep
    ? actionToDir(pos, dir, directionTo(pos, patrolStep), "go")
    : patrolForward(pos, dir, game.map);
  cands.push(withScore(patrolAct,
    100 + starLineScore(add(pos, delta(dir)), game.star, game.map, late), "巡逻"));

  // ---- 危险惩罚硬过滤：每个走/转候选减去落点危险 ----
  for (var j = 0; j < cands.length; j++) {
    cands[j].score -= actionDanger(cands[j], me, foe, threats, game, crowd);
  }

  var best = cands[0];
  for (var i = 1; i < cands.length; i++) {
    if (cands[i].score > best.score) best = cands[i];
  }
  return best;
}

// ============================================================
// 多坦克选靶：曼哈顿距离 + 星优势(-3) + 持弹威胁(-5)，分越低越优先。
// 无可见敌时回落引擎主敌 enemy。
// ============================================================
function chooseMainTarget(me, enemy, game) {
  var myPos = me.tank.position;
  var myStars = me.stars || 0;
  var list = (game.enemies || []).filter(function (e) { return e && e.tank && e.tank.position; });
  if (!list.length) return (enemy && enemy.tank) ? enemy : null;

  var best = null, bestScore = Infinity;
  for (var i = 0; i < list.length; i++) {
    var s = targetScore(list[i], myPos, myStars);
    if (s < bestScore) { bestScore = s; best = list[i]; }
  }
  return best;
}

function targetScore(e, myPos, myStars) {
  var pos = e.tank.position;
  var score = manhattan(pos, myPos);
  if ((e.stars || 0) > myStars) score -= 3;            // 星星领先者更值得打
  if (e.bullet && e.bullet.position) score -= 5;        // 持弹敌人威胁更高
  if (e.status && e.status.crashed) score += 999;       // 已出局排最后
  if (e.tank.crashed) score += 999;
  return score;
}

// 找出"正瞄准我且同线"的敌人（多敌取最近的），用于 freeze 判定。
function threateningFoe(me, enemy, game) {
  var pos = me.tank.position;
  var list = (game.enemies || []).filter(function (e) { return e && e.tank && e.tank.position; });
  if (!list.length && enemy && enemy.tank) list = [enemy];
  var best = null, bestD = Infinity;
  for (var i = 0; i < list.length; i++) {
    var fp = list[i].tank.position;
    if (canShoot(fp, pos, game.map) && pointsAt(list[i].tank.direction, fp, pos)) {
      var d = manhattan(pos, fp);
      if (d < bestD) { bestD = d; best = list[i]; }
    }
  }
  return best;
}

// ============================================================
// 多子弹威胁：合并 game.visibleBullets + enemy.bullet + 各 enemies[].bullet，
// 去重 + 排除自己的子弹(me.bullet)后，按危险半径过滤。每项含 { position:[x,y], direction }。
// 排除己方弹的理由：自己刚发射的子弹若被当威胁，会触发无谓躲避、打断抢星节奏。
// 引擎契约(1v1 文档)：me.bullet 是己方在场子弹(position+direction)，同位同向即同一发。
// ============================================================
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
    if (isMyBullet(raw[k], me)) continue;                 // 排除自己的子弹，别躲自己的弹
    if (manhattan(raw[k].position, myPos) <= DANGER_RADIUS + BULLET_SPEED) out.push(raw[k]);
  }
  return out;
}

// 判断一发子弹是否是我自己的：与 me.bullet 同位置同方向即同一发。
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

// ============================================================
// 躲弹：在 4 个邻格里找一个"走过去能活"的安全格。
// 关键——转身帧安全：若需先转向，子弹会再飞 1 帧；要求来袭帧数足够。
//   · 已朝向该方向：1 帧直接 go，要求子弹此刻不命中目标格。
//   · 需转向：先转(1帧)再走，期间子弹推进；用 posHitWithin 多帧预演。
// 评分：朝向加成 + 出口数 - 死角罚 + 边缘距 + 反击加成。
// ============================================================
function findBulletDodge(me, bullets, game, enemy) {
  var pos = me.tank.position;
  var dir = me.tank.direction;
  if (!bullets || !bullets.length) return null;

  // 当前格最快多少帧被命中——后续转身帧时序判断依赖此窗口。
  var incoming = minBulletFramesTo(bullets, pos, game);

  // 正在威胁我的子弹飞行方向集合：绝不顺着它逃（2 格/帧必从背后追上）。
  var threatDirs = {};
  for (var t = 0; t < bullets.length; t++) {
    if (bulletReachTiles(bullets[t], pos, game) >= 0) threatDirs[bullets[t].direction] = true;
  }

  var best = null, bestScore = -Infinity;
  for (var i = 0; i < DIRS.length; i++) {
    var d = DIRS[i];
    if (threatDirs[d]) continue;                               // 顺向逃必被追，跳过
    var cell = add(pos, delta(d));
    if (!isOpen(cell, game.map)) continue;
    if (stepIntoBulletPath(bullets, cell, game)) continue;     // 走过去同帧被扫到

    var facing = (dir === d);
    // 时序铁律（子弹 2 格/帧，转向占 1 帧）：
    //  · 朝向即脱离：1 帧 go 出格，要求 incoming>=1（incoming<0 表示无直线威胁，放行）。
    //  · 需先转向：转身帧仍停原地，要求 incoming>=3；并预演子弹推进 1 帧后落点 cell 仍安全。
    if (facing) {
      if (incoming >= 0 && incoming < 1) continue;
    } else {
      if (incoming >= 0 && incoming < 3) continue;
      var nextB = advanceBullets(bullets, BULLET_SPEED);
      if (stepIntoBulletPath(nextB, cell, game)) continue;
    }

    var exits = openNeighborCount(cell, game.map);
    var score = (facing ? 100 : 0) + exits * 12 - (exits <= 1 ? 150 : 0)
      + edgeDistance(cell, game.map) * 2;
    // 反击加成：躲完还能瞄到敌人
    if (enemy && enemy.tank && canShoot(cell, enemy.tank.position, game.map)) score += 30;

    if (score > bestScore) { bestScore = score; best = d; }
  }

  if (best == null) return null;
  return (me.tank.direction === best)
    ? { type: "go", tag: "躲弹" }
    : { type: "turn", side: turnDirection(me.tank.direction, best), tag: "躲弹" };
}

// pos 在未来 frames 帧内是否会被任一子弹命中（子弹 2 格/帧）。
function posHitWithin(bullets, pos, game, frames) {
  var list = bullets || [];
  for (var i = 0; i < list.length; i++) {
    var f = bulletFramesTo(list[i], pos, game);
    if (f >= 0 && f <= frames) return true;
    if (samePos(list[i].position, pos)) return true;
  }
  return false;
}

// 子弹沿飞行方向到 pos 还需几格；不在弹道/方向不对/有遮挡返回 -1。
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

// 一组子弹中最快多少帧命中 pos；都打不到返回 -1。
function minBulletFramesTo(bullets, pos, game) {
  var best = -1;
  for (var i = 0; i < bullets.length; i++) {
    var f = bulletFramesTo(bullets[i], pos, game);
    if (f >= 0 && (best < 0 || f < best)) best = f;
  }
  return best;
}

// 将子弹沿各自方向推进 steps 格，返回快照（仅用于躲避预演，不改原对象）。
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

// 走到 cell 这帧子弹也会前进 BULLET_SPEED 格，判断 cell 是否会被扫到。
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

// 两点间（不含端点）是否畅通——视线 / 弹道遮挡判定。
function clearBetween(a, b, game) {
  var dir = directionTo(a, b);
  var step = delta(dir);
  var pos = add(a, step);
  while (!samePos(pos, b)) {
    if (!isOpen(pos, game.map)) return false;
    pos = add(pos, step);
  }
  return true;
}

// ============================================================
// freeze 技能：敌正瞄我、同线、曼哈顿 ≤4、冷却好时冻结，打断其开火。
// ============================================================
function canFreeze(me, game, foe) {
  if (!foe || !foe.tank) return false;
  if (!me.freeze || !me.skill || me.skill.remainingCooldownFrames !== 0) return false;
  var pos = me.tank.position;
  var fp = foe.tank.position;
  return canShoot(fp, pos, game.map) && pointsAt(foe.tank.direction, fp, pos) && manhattan(pos, fp) <= 4;
}

// ============================================================
// 危险惩罚：走/转后的落点若贴脸 / 被瞄 / 走入弹道，重罚（致命硬红线）。
// crowd（额外存活数）越大，惩罚整体放大，促使多敌时更保守。
// ============================================================
function actionDanger(action, me, foe, threats, game, crowd) {
  if (action.type === "fire" || action.type === "freeze") return 0;
  var pos = me.tank.position;
  var dir = me.tank.direction;
  var nextPos = pos, nextDir = dir;
  if (action.type === "go") nextPos = add(pos, delta(dir));
  if (action.type === "turn") nextDir = turnAfter(dir, action.side);

  var penalty = 0;
  // 走入子弹路径 = 死，最高罚
  if (action.type === "go" && stepIntoBulletPath(threats, nextPos, game)) penalty += 2000;
  if (posHitWithin(threats, nextPos, game, 1)) penalty += 800;

  // 贴脸 / 被瞄敌格
  if (foe && foe.tank) {
    var fp = foe.tank.position;
    var d = manhattan(nextPos, fp);
    if (d <= 1) penalty += 1500;
    else if (d <= 4 && canShoot(fp, nextPos, game.map) && pointsAt(foe.tank.direction, fp, nextPos)) penalty += 1200;
    else if (d <= 6 && canShoot(fp, nextPos, game.map) && pointsAt(foe.tank.direction, fp, nextPos)) penalty += 180;
  }
  return penalty + crowd * 30;
}

// ============================================================
// 对炮存活基线（移植自 1v1 验证逻辑，适配多敌）：
// 与某敌同线近距、对方又能开火时，先算"对射先手"——子弹 2 格/帧、转向占 1 帧：
//   我命中敌帧 = 我转向到对准的帧 + ceil(dist/2)
//   敌命中我帧 = 敌转向到对准的帧 + ceil(dist/2)
// 只有我"严格更快"(myDuel < foeDuel) 才值得站着对射；否则不占先手，应侧移脱线，
// 绝不站着转身换命（多敌混战里换命=被第三家收掉）。
// 侧移耗帧 < 敌命中帧 才真能活着离线；来不及则返回 null，交回开火分支换血。
// ============================================================

// 敌人接下来一两帧能否开火：场上没有它的在途子弹(炮管空就能发)即视为能开火。
function foeCanFireSoon(foe) {
  if (!foe || !foe.tank) return false;
  if (foe.bullet && foe.bullet.position) return false; // 已有在途子弹，短期内打不了我
  return true;
}

// from 沿 lineDir 转到对准 to 的转向次数（90°=1，180°=2，已对准=0）。
function turnCountTo(curDir, lineDir) {
  var a = DIRS.indexOf(curDir), b = DIRS.indexOf(lineDir);
  if (a < 0 || b < 0) return 2;
  var diff = (b - a + 4) % 4;
  return Math.min(diff, 4 - diff);
}

function findLineDuelDodge(me, foe, threats, game) {
  if (!foe || !foe.tank) return null;
  if (!foeCanFireSoon(foe)) return null;          // 敌打不了我，无近距对射威胁
  var pos = me.tank.position, dir = me.tank.direction;
  var fp = foe.tank.position;
  // 必须同线、视线无遮挡
  if (!canShoot(pos, fp, game.map)) return null;
  var dist = manhattan(pos, fp);
  if (dist > 5) return null;                       // 只管 5 格内近距死区，远了有躲闪余地

  var lineToFoe = directionTo(pos, fp);            // 我对准敌人要朝的方向
  var lineToMe  = directionTo(fp, pos);            // 敌对准我要朝的方向
  var fly = Math.ceil(dist / BULLET_SPEED);
  var myDuel  = turnCountTo(dir, lineToFoe) + fly;
  var foeDuel = turnCountTo(foe.tank.direction, lineToMe) + fly;
  if (myDuel < foeDuel) return null;               // 我严格更快=干净先手，交开火分支去刚

  // 不占先手：找垂直于这条弹道、能在敌命中前离线的侧格。
  var vertical = (lineToFoe === "up" || lineToFoe === "down");
  var perp = vertical ? ["left", "right"] : ["up", "down"];
  var best = null, bestScore = -Infinity;
  for (var i = 0; i < perp.length; i++) {
    var d = perp[i];
    var p = add(pos, delta(d));
    if (!isOpen(p, game.map)) continue;
    if (stepIntoBulletPath(threats, p, game)) continue;       // 别躲进现有弹道
    if (posHitWithin(threats, p, game, 1)) continue;
    // 落点不能正撞另一敌的炮口（多敌）
    if (foe.tank && canShoot(fp, p, game.map) && pointsAt(foe.tank.direction, fp, p)) continue;
    var escapeFrames = (d === dir) ? 1 : 2;        // 朝向即侧向=1帧；否则转+走=2帧
    var safe = (escapeFrames === 1) || (escapeFrames < foeDuel);
    if (!safe) continue;                            // 来不及离线，侧移=白送，交回开火换血
    var facing = (d === dir) ? 100 : 0;
    var counterLine = canShoot(p, fp, game.map) ? 15 : 0; // 侧移后仍能还手
    var score = facing + counterLine + manhattan(p, fp) + edgeDistance(p, game.map);
    if (score > bestScore) { bestScore = score; best = d; }
  }
  if (best == null) return null;
  return (dir === best)
    ? { type: "go", tag: "脱线" }
    : { type: "turn", side: turnDirection(dir, best), tag: "脱线" };
}

// ============================================================
// 虚拟巡逻：选一个远离敌人 / 远离危险的持久目标点，黏滞走向它，
// 到达 / 失效 / 逼近危险才换点，避免每帧重选导致来回横跳。
// ============================================================
function virtualPatrol(me, game, state, foePos) {
  var pos = me.tank.position;
  var w = game.map.length, h = game.map[0].length;

  // 现有巡逻点仍有效则继续
  if (state.patrol && isOpen(state.patrol, game.map) && !samePos(state.patrol, pos)) {
    if (!foePos || manhattan(state.patrol, foePos) >= 3) {
      var step = nextStep(pos, state.patrol, game.map);
      if (step) return step;
    }
  }

  // 重选：四角锚点中挑一个离敌最远、可达的
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

// ============================================================
// 跨帧状态：新对局（帧号回退）自动重置。
// ============================================================
function getState(game) {
  var f = game.frames || 0;
  if (f < SURV_STATE.lastFrame) SURV_STATE = { lastFrame: f, patrol: null, speakCount: 0, lastSpeak: "" };
  SURV_STATE.lastFrame = f;
  return SURV_STATE;
}

// ============================================================
// 动作执行 + 极简播报（每帧≤1次、全局≤32次、同内容节流）。
// ============================================================
function execAction(me, a) {
  if (!a) return;
  if (a.type === "freeze") { if (me.freeze) me.freeze(); }
  else if (a.type === "fire") me.fire();
  else if (a.type === "go") me.go();
  else if (a.type === "turn") me.turn(a.side);
}

function say(me, state, tag) {
  if (!tag || !me || typeof me.speak !== "function") return;
  if (state.speakCount >= 30 || state.lastSpeak === tag) return;
  state.lastSpeak = tag;
  state.speakCount++;
  me.speak(tag);
}

// ============================================================
// 评分辅助
// ============================================================
function withScore(action, score, tag) {
  action.score = score;
  if (tag) action.tag = tag;
  return action;
}

// 当前朝向即目标方向 -> 执行对齐动作（fire/go）；否则转向。
function actionToDir(pos, curDir, tgtDir, aligned) {
  if (curDir === tgtDir) return { type: aligned };
  return { type: "turn", side: turnDirection(curDir, tgtDir) };
}

function closeBonus(a, b) { return Math.max(0, 8 - manhattan(a, b)) * 10; }

function starUrgency(pos, step, star) {
  if (samePos(step, star)) return 180;
  return Math.max(0, 8 - manhattan(pos, star)) * 10;
}

function starLineScore(pos, star, map, late) {
  if (!star) return 0;
  if (samePos(pos, star)) return 160;
  if ((pos[0] === star[0] || pos[1] === star[1]) && canShoot(pos, star, map)) return late ? 30 : 85;
  return 0;
}

// ============================================================
// 几何 / 寻路 / 地图工具
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

// 朝当前方向若有土堆可破，返回应射方向；否则查四邻；无返回 null。
function digDirection(pos, curDir, map) {
  if (isMound(add(pos, delta(curDir)), map)) return curDir;
  for (var i = 0; i < DIRS.length; i++) {
    if (isMound(add(pos, delta(DIRS[i])), map)) return DIRS[i];
  }
  return null;
}

// a 能否直线射到 b（同行/列且中间畅通）。
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

// 朝向 dir 的坦克在 from 是否正指向 target。
function pointsAt(dir, from, target) {
  if (dir === "up") return from[0] === target[0] && target[1] < from[1];
  if (dir === "right") return from[1] === target[1] && target[0] > from[0];
  if (dir === "down") return from[0] === target[0] && target[1] > from[1];
  if (dir === "left") return from[1] === target[1] && target[0] < from[0];
  return false;
}

// a 指向 b 的主方向（同行/列时唯一；否则取较大轴）。
function directionTo(a, b) {
  if (b[0] > a[0]) return "right";
  if (b[0] < a[0]) return "left";
  if (b[1] > a[1]) return "down";
  return "up";
}

// 从 curDir 转到 tgtDir 的最短转向（diff===3 时左转更快）。
function turnDirection(curDir, tgtDir) {
  var cur = DIRS.indexOf(curDir), tgt = DIRS.indexOf(tgtDir);
  if (cur < 0 || tgt < 0) return "right";
  var diff = (tgt - cur + 4) % 4;
  return diff === 3 ? "left" : "right";
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










