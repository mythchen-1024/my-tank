function onIdle(me, enemy, game) {
const myPos = me.tank.position;
const enemyTank = enemy && enemy.tank ? enemy.tank : null;
const enemyPos = enemyTank ? enemyTank.position : null;
const enemyBullets = collectEnemyBullets(enemy);
const state = getMatchState(game);
recordAssassinOutcome(state, enemy, enemyTank, game);
if (me.status && (me.status.stunned || me.status.frozen)) return;
const dodge = findBulletDodge(me, enemy, game, enemyPos);
if (dodge) {
moveToward(me, game, dodge, enemyPos, enemyTank, enemyBullets);
return;
}
const escapeTeleport = findEscapeTeleport(me, enemy, enemyTank, enemyBullets, game);
if (escapeTeleport) {
me.teleport(escapeTeleport[0], escapeTeleport[1]);
return;
}
const aimDodge = findAimDodge(me, enemy, enemyTank, enemyBullets, game, enemyPos);
if (aimDodge) {
moveToward(me, game, aimDodge, enemyPos, enemyTank, enemyBullets);
return;
}
const shotDir = enemyPos ? clearShotDirection(myPos, enemyPos, game) : null;
if (shotDir && canShoot(me, enemy)) {
if (me.tank.direction === shotDir) {
me.fire();
} else {
turnToward(me, shotDir);
}
return;
}
const starTeleport = findStarTeleport(me, enemyTank, enemyBullets, game);
if (starTeleport) {
me.teleport(starTeleport[0], starTeleport[1]);
return;
}
const starGuard = findContestedStarGuard(me, enemyTank, game);
if (starGuard) {
if (me.tank.direction !== starGuard.dir) {
turnToward(me, starGuard.dir);
}
return;
}
const assassination = findAssassinationPlan(me, enemy, enemyTank, enemyBullets, game, state);
if (assassination) {
if (me.tank.direction === assassination.dir) {
state.pendingAssassin = { targetPos: enemyPos.slice(), dir: assassination.dir, frame: (game && game.frames) || 0 };
me.teleport(assassination.pos[0], assassination.pos[1]);
} else {
turnToward(me, assassination.dir);
}
return;
}
const step = chooseStep(me, enemy, game, enemyPos);
if (step) {
moveToward(me, game, step, enemyPos, enemyTank, enemyBullets);
return;
}
const digDir = findDigDirection(myPos, game, game.star || enemyPos || nearestOpenToCenter(game));
if (digDir && gunReady(me)) {
if (me.tank.direction === digDir) {
me.fire();
} else {
turnToward(me, digDir);
}
return;
}
const safeStep = bestSafeNeighbor(myPos, game, enemyPos, enemyTank, enemyBullets);
if (safeStep) {
moveToward(me, game, safeStep, enemyPos, enemyTank, enemyBullets);
return;
}
me.turn("right");
}
const DIRS = [
{ name: "up", dx: 0, dy: -1 },
{ name: "right", dx: 1, dy: 0 },
{ name: "down", dx: 0, dy: 1 },
{ name: "left", dx: -1, dy: 0 }
];
const BULLET_LOOKAHEAD_TILES = 8;
const BULLET_SPEED = 2;
const ASSASSIN_MIN_RANGE = 5;
const ASSASSIN_MAX_RANGE = 8;
let MATCH_STATE = null;
function getMatchState(game) {
const frame = (game && game.frames) || 0;
if (!MATCH_STATE || frame < MATCH_STATE.lastFrame - 2) {
MATCH_STATE = { lastFrame: frame, assassinBanned: false, pendingAssassin: null };
}
MATCH_STATE.lastFrame = frame;
return MATCH_STATE;
}
function canShoot(me, enemy) {
if (!gunReady(me)) return false;
if (enemy.status && enemy.status.shielded) return false;
return true;
}
function gunReady(me) {
return !me.bullet && !(me.status && me.status.fireLocked);
}
function teleportReady(me) {
return !!me.teleport && me.skill && me.skill.remainingCooldownFrames === 0;
}
function enemyHasTeleport(enemy) {
return !!(enemy && enemy.skill && enemy.skill.type === "teleport");
}
function findAssassinationPlan(me, enemy, enemyTank, enemyBullets, game, state) {
if (!enemyTank || !teleportReady(me) || !canShoot(me, enemy)) return null;
if (enemy.status && (enemy.status.cloaked || enemy.status.shielded)) return null;
if (enemyHasTeleport(enemy)) return null;
if (state && state.assassinBanned) return null;
const enemyPos = enemyTank.position;
let best = null;
let bestScore = -9999;
for (let i = 0; i < DIRS.length; i++) {
const dir = DIRS[i];
for (let range = ASSASSIN_MIN_RANGE; range <= ASSASSIN_MAX_RANGE; range++) {
const p = [enemyPos[0] - dir.dx * range, enemyPos[1] - dir.dy * range];
if (samePos(p, me.tank.position)) continue;
if (!isAssassinTile(p, dir.name, enemyTank, enemyBullets, game)) continue;
if (!assassinIsSafe(p, dir, range, me, enemy, enemyTank, game)) continue;
const turns = turnDistance(me.tank.direction, dir.name);
const centerBias = distanceFromEdges(p, game);
const score = 100 - turns * 35 - range * 2 + centerBias;
if (score > bestScore) {
bestScore = score;
best = { pos: p, dir: dir.name };
}
}
}
return best;
}
function assassinIsSafe(p, dir, range, me, enemy, enemyTank, game) {
const enemyPos = enemyTank.position;
const myHitFrames = Math.ceil(range / BULLET_SPEED);
const enemyGunBusy = enemy && enemy.bullet && enemy.bullet.position;
const enemyFacingMe = enemyAimsAt(p, enemyTank, game);
let enemyReplyHit = Math.ceil(range / BULLET_SPEED) + (enemyFacingMe ? 0 : 1);
if (enemyGunBusy) enemyReplyHit += 1;
if (myHitFrames < enemyReplyHit) return true;
if (myHitFrames <= enemyReplyHit) {
if (hasLateralEscape(p, dir, enemyTank, game)) return true;
}
return false;
}
function hasLateralEscape(p, dir, enemyTank, game) {
const perp = (dir.name === "up" || dir.name === "down")
? [DIRS[dirIndex("left")], DIRS[dirIndex("right")]]
: [DIRS[dirIndex("up")], DIRS[dirIndex("down")]];
for (let i = 0; i < perp.length; i++) {
const q = [p[0] + perp[i].dx, p[1] + perp[i].dy];
if (!isPassable(game, q, enemyTank.position)) continue;
if (enemyAimsAt(q, enemyTank, game)) continue;
return true;
}
return false;
}
function isAssassinTile(p, dir, enemyTank, enemyBullets, game) {
if (!isTeleportSafe(p, enemyTank, enemyBullets, game, 0)) return false;
if (manhattan(p, enemyTank.position) < ASSASSIN_MIN_RANGE) return false;
if (clearShotDirection(p, enemyTank.position, game) !== dir) return false;
return true;
}
function recordAssassinOutcome(state, enemy, enemyTank, game) {
const pending = state.pendingAssassin;
if (!pending) return;
const frame = (game && game.frames) || 0;
const elapsed = frame - pending.frame;
if (elapsed < 1 || elapsed > 3) {
if (elapsed > 3) state.pendingAssassin = null;
return;
}
if (enemyTank && enemyTank.position && !samePos(enemyTank.position, pending.targetPos)) {
state.assassinBanned = true;
state.pendingAssassin = null;
return;
}
if (!enemyTank) {
state.assassinBanned = true;
state.pendingAssassin = null;
}
}
function findContestedStarGuard(me, enemyTank, game) {
if (!game.star || !enemyTank || !gunReady(me)) return null;
const myPos = me.tank.position;
const enemyPos = enemyTank.position;
const enemyToStar = manhattan(enemyPos, game.star);
if (enemyToStar > 2) return null;
if (manhattan(myPos, game.star) > 4) return null;
const dir = clearShotDirection(myPos, game.star, game);
if (!dir) return null;
if (pathDistance(enemyPos, game.star, game, myPos) > enemyToStar) return null;
return { dir: dir };
}
function findEscapeTeleport(me, enemy, enemyTank, enemyBullets, game) {
if (!teleportReady(me)) return null;
const myPos = me.tank.position;
const threatened = anyBulletThreatens(enemyBullets, myPos, game);
if (!threatened) return null;
const overloadEnemy = enemy && enemy.status && enemy.status.overloaded;
return bestTeleportTile(myPos, enemyTank, enemyBullets, game, game.star, true, overloadEnemy ? 6 : 4);
}
function findStarTeleport(me, enemyTank, enemyBullets, game) {
if (!teleportReady(me) || !game.star) return null;
const enemyPos = enemyTank ? enemyTank.position : null;
const walkDist = pathDistance(me.tank.position, game.star, game, enemyPos);
if (walkDist >= 0 && walkDist <= 5) return null;
if (!enemyTank) {
const enemyGuess = estimateEnemyHome(me.tank.position, game);
if (enemyGuess && manhattan(game.star, enemyGuess) <= ASSASSIN_MAX_RANGE) {
return bestUnknownEnemyStarTeleport(me.tank.position, enemyGuess, enemyBullets, game);
}
}
if (isTeleportSafe(game.star, enemyTank, enemyBullets, game, 0)) return game.star;
return bestTeleportTile(me.tank.position, enemyTank, enemyBullets, game, game.star, false, 0);
}
function bestUnknownEnemyStarTeleport(myPos, enemyGuess, enemyBullets, game) {
let best = null;
let bestScore = -9999;
for (let x = 0; x < game.map.length; x++) {
for (let y = 0; y < game.map[x].length; y++) {
const p = [x, y];
if (samePos(p, myPos)) continue;
if (!isPassable(game, p, null)) continue;
if (anyBulletThreatens(enemyBullets, p, game)) continue;
if (manhattan(p, enemyGuess) <= ASSASSIN_MAX_RANGE) continue;
const score = -manhattan(p, game.star) * 3 + distanceFromEdges(p, game);
if (score > bestScore) {
bestScore = score;
best = p;
}
}
}
return best;
}
function bestTeleportTile(myPos, enemyTank, enemyBullets, game, target, preferDistance, minEnemyDist) {
let best = null;
let bestScore = -9999;
for (let x = 0; x < game.map.length; x++) {
for (let y = 0; y < game.map[x].length; y++) {
const p = [x, y];
if (samePos(p, myPos)) continue;
if (!isTeleportSafe(p, enemyTank, enemyBullets, game, minEnemyDist || 0)) continue;
const enemyPos = enemyTank ? enemyTank.position : null;
const enemyScore = enemyPos ? manhattan(p, enemyPos) : 0;
const targetScore = target ? -manhattan(p, target) * 2 : 0;
const score = distanceFromEdges(p, game) + targetScore + (preferDistance ? enemyScore : 0);
if (score > bestScore) {
bestScore = score;
best = p;
}
}
}
return best;
}
function isTeleportSafe(p, enemyTank, enemyBullets, game, minEnemyDist) {
const enemyPos = enemyTank ? enemyTank.position : null;
if (!isPassable(game, p, enemyPos)) return false;
const bullets = enemyBullets || [];
for (let i = 0; i < bullets.length; i++) {
if (bullets[i] && samePos(p, bullets[i].position)) return false;
}
if (enemyAimsAt(p, enemyTank, game)) return false;
if (anyBulletThreatens(bullets, p, game)) return false;
if (minEnemyDist > 0 && enemyPos && manhattan(p, enemyPos) <= minEnemyDist) return false;
return true;
}
function chooseStep(me, enemy, game, enemyPos) {
const myPos = me.tank.position;
if (game.star) {
const starPath = shortestPathInfo(myPos, game.star, game, enemyPos);
if (shouldChaseStar(myPos, enemyPos, game, starPath)) return starPath.step;
}
if (enemyPos) {
const laneStep = nextStepToFiringLane(myPos, enemyPos, game);
if (laneStep) return laneStep;
return nextStepNearEnemy(myPos, enemyPos, game);
}
const center = nearestOpenToCenter(game);
return center ? nextStepToward(myPos, center, game, null) : null;
}
function shouldChaseStar(myPos, enemyPos, game, starPath) {
if (!game.star || !starPath || starPath.dist < 0) return false;
if (!enemyPos) return true;
if (manhattan(myPos, game.star) <= 5) return true;
const enemyDist = pathDistance(enemyPos, game.star, game, myPos);
return enemyDist < 0 || starPath.dist <= enemyDist + 2;
}
function nextStepToFiringLane(myPos, enemyPos, game) {
return nextStepToGoal(myPos, game, enemyPos, function (p) {
if (samePos(p, myPos)) return false;
const d = manhattan(p, enemyPos);
return d >= 2 && d <= 9 && !!clearShotDirection(p, enemyPos, game);
});
}
function nextStepNearEnemy(myPos, enemyPos, game) {
return nextStepToGoal(myPos, game, enemyPos, function (p) {
const d = manhattan(p, enemyPos);
return d >= 2 && d <= 4;
});
}
function nextStepToGoal(start, game, enemyPos, isGoal) {
const w = game.map.length;
const h = game.map[0].length;
const queue = [start];
const seen = {};
const prev = {};
seen[key(start)] = true;
for (let qi = 0; qi < queue.length; qi++) {
const p = queue[qi];
if (isGoal(p)) return firstStep(start, p, prev);
for (let i = 0; i < DIRS.length; i++) {
const n = [p[0] + DIRS[i].dx, p[1] + DIRS[i].dy];
const k = key(n);
if (seen[k]) continue;
if (n[0] < 0 || n[1] < 0 || n[0] >= w || n[1] >= h) continue;
if (!isPassable(game, n, enemyPos)) continue;
seen[k] = true;
prev[k] = p;
queue.push(n);
}
}
return null;
}
function findDigDirection(pos, game, target) {
let bestDir = null;
let bestScore = 9999;
for (let i = 0; i < DIRS.length; i++) {
const d = DIRS[i];
let x = pos[0] + d.dx;
let y = pos[1] + d.dy;
let range = 1;
while (tileAt(game, [x, y]) !== "x") {
const t = tileAt(game, [x, y]);
if (t === "m") {
const after = [x + d.dx, y + d.dy];
const targetScore = target ? manhattan(after, target) : 0;
const score = range * 3 + targetScore;
if (score < bestScore) {
bestScore = score;
bestDir = d.name;
}
break;
}
x += d.dx;
y += d.dy;
range++;
}
}
return bestDir;
}
function nearestOpenToCenter(game) {
const cx = Math.floor(game.map.length / 2);
const cy = Math.floor(game.map[0].length / 2);
let best = null;
let bestScore = 9999;
for (let x = 0; x < game.map.length; x++) {
for (let y = 0; y < game.map[x].length; y++) {
const p = [x, y];
if (!isPassable(game, p, null)) continue;
const score = Math.abs(x - cx) + Math.abs(y - cy);
if (score < bestScore) {
bestScore = score;
best = p;
}
}
}
return best;
}
function findBulletDodge(me, enemy, game, enemyPos) {
const myPos = me.tank.position;
const bullets = collectEnemyBullets(enemy);
if (bullets.length === 0) return null;
if (!anyBulletThreatens(bullets, myPos, game)) return null;
const incomingFrames = minBulletFramesTo(bullets, myPos, game);
if (incomingFrames < 0) return null;
let best = null;
let bestScore = -9999;
for (let i = 0; i < DIRS.length; i++) {
const d = DIRS[i];
const p = [myPos[0] + d.dx, myPos[1] + d.dy];
if (!isPassable(game, p, enemyPos)) continue;
if (anyBulletThreatens(bullets, p, game)) continue;
if (enemyAimsAt(p, enemy && enemy.tank, game)) continue;
const needFrames = d.name === me.tank.direction ? 1 : 2;
if (incomingFrames < needFrames) continue;
const facing = d.name === me.tank.direction ? 100 : 0;
const score = facing + distanceFromEdges(p, game) + (game.star ? -manhattan(p, game.star) * 0.1 : 0);
if (score > bestScore) {
bestScore = score;
best = p;
}
}
return best;
}
function findAimDodge(me, enemy, enemyTank, enemyBullets, game, enemyPos) {
if (!enemyTank) return null;
if (!enemyAimsAt(me.tank.position, enemyTank, game)) return null;
if (!enemyCanFireSoon(enemy)) return null;
const myPos = me.tank.position;
let best = null;
let bestScore = -9999;
for (let i = 0; i < DIRS.length; i++) {
const d = DIRS[i];
const p = [myPos[0] + d.dx, myPos[1] + d.dy];
if (!isPassable(game, p, enemyPos)) continue;
if (enemyAimsAt(p, enemyTank, game)) continue;
if (anyBulletThreatens(enemyBullets || [], p, game)) continue;
const facing = d.name === me.tank.direction ? 100 : 0;
const score = facing + distanceFromEdges(p, game) + (game.star ? -manhattan(p, game.star) * 0.1 : 0);
if (score > bestScore) {
bestScore = score;
best = p;
}
}
return best;
}
function enemyCanFireSoon(enemy) {
if (!enemy) return false;
const overloaded = enemy.status && enemy.status.overloaded;
const hasBulletOut = enemy.bullet && enemy.bullet.position;
if (overloaded) return true;
return !hasBulletOut;
}
function bulletReachTiles(bullet, pos, game) {
if (!bullet || !bullet.position) return -1;
const bp = bullet.position;
if (bp[0] === pos[0]) {
const dy = pos[1] - bp[1];
if (bullet.direction === "down" && dy > 0) return clearBetween(bp, pos, game) ? dy : -1;
if (bullet.direction === "up" && dy < 0) return clearBetween(bp, pos, game) ? -dy : -1;
}
if (bp[1] === pos[1]) {
const dx = pos[0] - bp[0];
if (bullet.direction === "right" && dx > 0) return clearBetween(bp, pos, game) ? dx : -1;
if (bullet.direction === "left" && dx < 0) return clearBetween(bp, pos, game) ? -dx : -1;
}
return -1;
}
function bulletFramesTo(bullet, pos, game) {
const tiles = bulletReachTiles(bullet, pos, game);
if (tiles < 0) return -1;
return Math.ceil(tiles / BULLET_SPEED);
}
function bulletThreatens(bullet, pos, game) {
const tiles = bulletReachTiles(bullet, pos, game);
return tiles >= 0 && tiles <= BULLET_LOOKAHEAD_TILES;
}
function collectEnemyBullets(enemy) {
if (!enemy) return [];
const out = [];
if (Array.isArray(enemy.bullets)) {
for (let i = 0; i < enemy.bullets.length; i++) {
if (enemy.bullets[i] && enemy.bullets[i].position) out.push(enemy.bullets[i]);
}
}
if (enemy.bullet && enemy.bullet.position) {
let dup = false;
for (let i = 0; i < out.length; i++) {
if (samePos(out[i].position, enemy.bullet.position) && out[i].direction === enemy.bullet.direction) dup = true;
}
if (!dup) out.push(enemy.bullet);
}
return out;
}
function anyBulletThreatens(bullets, pos, game) {
for (let i = 0; i < bullets.length; i++) {
if (bulletThreatens(bullets[i], pos, game)) return true;
}
return false;
}
function minBulletFramesTo(bullets, pos, game) {
let best = -1;
for (let i = 0; i < bullets.length; i++) {
const f = bulletFramesTo(bullets[i], pos, game);
if (f >= 0 && (best < 0 || f < best)) best = f;
}
return best;
}
function moveToward(me, game, next, enemyPos, enemyTank, enemyBullets) {
const myPos = me.tank.position;
if (!isPassable(game, next, enemyPos) || enemyAimsAt(next, enemyTank, game) || anyBulletThreatens(enemyBullets || [], next, game)) {
const safer = bestSafeNeighbor(myPos, game, enemyPos, enemyTank, enemyBullets);
if (safer && !samePos(safer, next)) {
moveToward(me, game, safer, enemyPos, enemyTank, enemyBullets);
return;
}
me.turn("right");
return;
}
const dir = directionBetween(myPos, next);
if (!dir) return;
if (me.tank.direction === dir) {
me.go();
} else {
turnToward(me, dir);
}
}
function turnToward(me, desired) {
const cur = dirIndex(me.tank.direction);
const dst = dirIndex(desired);
if (cur < 0 || dst < 0 || cur === dst) return;
const diff = (dst - cur + 4) % 4;
if (diff === 1) me.turn("right");
else if (diff === 3) me.turn("left");
else me.turn("right");
}
function turnDistance(from, to) {
const cur = dirIndex(from);
const dst = dirIndex(to);
if (cur < 0 || dst < 0) return 2;
const diff = (dst - cur + 4) % 4;
return Math.min(diff, 4 - diff);
}
function nextStepToward(start, target, game, enemyPos) {
const info = shortestPathInfo(start, target, game, enemyPos);
return info ? info.step : null;
}
function shortestPathInfo(start, target, game, blockPos) {
if (!target) return null;
if (samePos(start, target)) return { dist: 0, step: null };
const w = game.map.length;
const h = game.map[0].length;
const queue = [start];
const seen = {};
const prev = {};
const dist = {};
seen[key(start)] = true;
dist[key(start)] = 0;
for (let qi = 0; qi < queue.length; qi++) {
const p = queue[qi];
for (let i = 0; i < DIRS.length; i++) {
const n = [p[0] + DIRS[i].dx, p[1] + DIRS[i].dy];
const k = key(n);
if (seen[k]) continue;
if (n[0] < 0 || n[1] < 0 || n[0] >= w || n[1] >= h) continue;
if (!samePos(n, target) && !isPassable(game, n, blockPos)) continue;
if (samePos(n, target) && !isPassable(game, n, null) && !samePos(target, blockPos)) continue;
seen[k] = true;
prev[k] = p;
dist[k] = dist[key(p)] + 1;
if (samePos(n, target)) {
return { dist: dist[k], step: firstStep(start, n, prev) };
}
queue.push(n);
}
}
return null;
}
function firstStep(start, target, prev) {
let cur = target;
while (prev[key(cur)] && !samePos(prev[key(cur)], start)) {
cur = prev[key(cur)];
}
return samePos(cur, start) ? null : cur;
}
function pathDistance(start, target, game, blockPos) {
const info = shortestPathInfo(start, target, game, blockPos);
return info ? info.dist : -1;
}
function bestSafeNeighbor(pos, game, enemyPos, enemyTank, enemyBullets) {
let best = null;
let bestScore = -9999;
for (let i = 0; i < DIRS.length; i++) {
const p = [pos[0] + DIRS[i].dx, pos[1] + DIRS[i].dy];
if (!isPassable(game, p, enemyPos)) continue;
if (enemyAimsAt(p, enemyTank, game)) continue;
if (anyBulletThreatens(enemyBullets || [], p, game)) continue;
const score = distanceFromEdges(p, game);
if (score > bestScore) {
bestScore = score;
best = p;
}
}
return best;
}
function clearShotDirection(from, to, game) {
if (!to) return null;
if (from[0] === to[0]) {
if (clearBetween(from, to, game)) return to[1] < from[1] ? "up" : "down";
}
if (from[1] === to[1]) {
if (clearBetween(from, to, game)) return to[0] < from[0] ? "left" : "right";
}
return null;
}
function enemyAimsAt(pos, enemyTank, game) {
if (!enemyTank || !enemyTank.position || !enemyTank.direction) return false;
const dir = clearShotDirection(enemyTank.position, pos, game);
return dir === enemyTank.direction;
}
function nextInDirection(pos, dir) {
const d = DIRS[dirIndex(dir)];
if (!d) return pos;
return [pos[0] + d.dx, pos[1] + d.dy];
}
function estimateEnemyHome(myPos, game) {
if (!myPos || !game || !game.map || !game.map.length) return null;
return [game.map.length - 1 - myPos[0], game.map[0].length - 1 - myPos[1]];
}
function clearBetween(a, b, game) {
const dx = sign(b[0] - a[0]);
const dy = sign(b[1] - a[1]);
let x = a[0] + dx;
let y = a[1] + dy;
while (x !== b[0] || y !== b[1]) {
const t = tileAt(game, [x, y]);
if (t === "x" || t === "m") return false;
x += dx;
y += dy;
}
return true;
}
function isPassable(game, p, enemyPos) {
const t = tileAt(game, p);
if (t !== "." && t !== "o") return false;
if (samePos(p, enemyPos)) return false;
return true;
}
function tileAt(game, p) {
if (!p || p[0] < 0 || p[1] < 0 || p[0] >= game.map.length || p[1] >= game.map[0].length) return "x";
return game.map[p[0]][p[1]];
}
function directionBetween(a, b) {
if (b[0] === a[0] && b[1] === a[1] - 1) return "up";
if (b[0] === a[0] + 1 && b[1] === a[1]) return "right";
if (b[0] === a[0] && b[1] === a[1] + 1) return "down";
if (b[0] === a[0] - 1 && b[1] === a[1]) return "left";
return null;
}
function dirIndex(dir) {
for (let i = 0; i < DIRS.length; i++) {
if (DIRS[i].name === dir) return i;
}
return -1;
}
function distanceFromEdges(p, game) {
return Math.min(p[0], p[1], game.map.length - 1 - p[0], game.map[0].length - 1 - p[1]);
}
function manhattan(a, b) {
return Math.abs(a[0] - b[0]) + Math.abs(a[1] - b[1]);
}
function samePos(a, b) {
return !!a && !!b && a[0] === b[0] && a[1] === b[1];
}
function key(p) {
return p[0] + "," + p[1];
}
function sign(n) {
if (n > 0) return 1;
if (n < 0) return -1;
return 0;
}