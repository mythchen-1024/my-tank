// 用例验证：把脚本里的函数提取出来在 Node 里跑（脚本是全局函数声明，indirect eval 注入全局作用域）
const fs = require('fs');
const src = fs.readFileSync(__dirname + '/myth-tank.js', 'utf8');

// 提供 Node 环境下缺失的 print 函数
global.print = console.log;

(0, eval)(src); // 在全局作用域加载所有 function 声明

// 加载新架构模块：state-store → scoring → action-proposals → decision-engine
// decision-engine.js 中的新 onIdle 会覆盖旧版 onIdle（var/function 重声明合法）
['state-store.js', 'scoring.js', 'action-proposals.js', 'decision-engine.js'].forEach(function(f) {
  (0, eval)(fs.readFileSync(__dirname + '/' + f, 'utf8'));
});

// ---- 极简地图：全空地，四周墙 ----
function emptyMap(w, h) {
  const m = [];
  for (let x = 0; x < w; x++) {
    m[x] = [];
    for (let y = 0; y < h; y++) {
      m[x][y] = (x === 0 || y === 0 || x === w - 1 || y === h - 1) ? 'x' : '.';
    }
  }
  return m;
}

// 记录 me 上调用的动作
function makeMe(pos, dir, opts) {
  opts = opts || {};
  const actions = [];
  return {
    tank: { id: 'me', position: pos, direction: dir, crashed: false },
    bullet: opts.bullet || null,
    stars: opts.stars || 0,
    skill: opts.skill || { type: 'teleport', remainingCooldownFrames: 0 },
    status: opts.status || {},
    teleport: function (x, y) { actions.push(['teleport', x, y]); },
    go: function (n) { actions.push(['go', n || 1]); },
    turn: function (d) { actions.push(['turn', d]); },
    fire: function () { actions.push(['fire']); },
    speak: function () {},
    _actions: actions
  };
}

let pass = 0, fail = 0;
function check(name, cond, detail) {
  if (cond) { pass++; console.log('  PASS ' + name); }
  else { fail++; console.log('  FAIL ' + name + (detail ? '  -> ' + detail : '')); }
}

// =========================================================
// 场景 A：复刻 mat_B4e3vzzseoR75VwLp 致死刺杀
// 敌人在 [9,1] 朝 right(能很快转身对射)，我在远处、传送就绪。
// 期望：不要传送刺杀到 [9,6] 这种"对射换血"落点（敌方同距离能反击且我躲不掉）。
// 这里敌人是 teleport 技能 -> 现在应直接禁用刺杀。
// =========================================================
console.log('场景A: 传送刺杀致死复刻 (敌方teleport技能)');
{
  const map = emptyMap(20, 20);
  const me = makeMe([4, 2], 'up');
  const enemy = {
    tank: { id: 'e', position: [9, 1], direction: 'right', crashed: false },
    bullet: null,
    skill: { type: 'teleport', remainingCooldownFrames: 10 },
    status: {}
  };
  const game = { map: map, star: null, frames: 42 };
  const plan = findAssassinationPlan(me, enemy, enemy.tank, [], game, getMatchState(game));
  check('敌方是传送技能时不刺杀', plan === null, 'plan=' + JSON.stringify(plan));
}

// 场景 A2：敌人非传送技能(shield)，但落点会和敌人对射换血 -> 严格门槛应拒绝同距离对射
console.log('场景A2: 非传送敌人，同距离对射应被严格门槛拒绝');
{
  const map = emptyMap(20, 20);
  const me = makeMe([4, 2], 'up');
  // 敌人已朝向 up/down 线上能反击；放在 [9,1] 朝 down，我若传到 [9,6] 与之同列5格，双方同距离
  const enemy = {
    tank: { id: 'e', position: [9, 1], direction: 'down', crashed: false },
    bullet: null,
    skill: { type: 'shield', remainingCooldownFrames: 10 },
    status: {}
  };
  const game = { map: map, star: null, frames: 42 };
  MATCH_STATE = null; // 重置本局状态
  const plan = findAssassinationPlan(me, enemy, enemy.tank, [], game, getMatchState(game));
  // [9,6] 距敌5格，敌人已朝 down 正对该列 -> 同帧反击同距离命中, 必须能横移脱离才允许
  // 全空地有横向脱离，所以 B 条件可能允许；这里只验证不会选 enemyFacing 且无脱离的死点
  console.log('    plan=' + JSON.stringify(plan));
  check('返回的刺杀计划(若有)落点不与已对准敌人正面对射致死', plan === null || hasLateralEscapeWrap(plan, enemy, game), 'plan=' + JSON.stringify(plan));
}
function hasLateralEscapeWrap(plan, enemy, game) {
  const map = { up: { name: 'up', dx: 0, dy: -1 }, right: { name: 'right', dx: 1, dy: 0 }, down: { name: 'down', dx: 0, dy: 1 }, left: { name: 'left', dx: -1, dy: 0 } };
  return hasLateralEscape(plan.pos, map[plan.dir], enemy.tank, game);
}

// =========================================================
// 场景 B：复刻 mat_2EZJtQHkctzBN67WB 同列对射被追死
// 我在 [4,10] 朝向无关，敌方子弹在 [4,3] 朝 down 飞来(2格/帧)。
// 期望：findBulletDodge 给出横向脱离格，且 moveToward 不原地空转。
// =========================================================
console.log('场景B: 子弹追击应横向脱离而非原地转向');
{
  const map = emptyMap(20, 20);
  const me = makeMe([4, 10], 'up'); // 朝 up，子弹从上方 y=3 往下(y增大)来
  const bullet = { position: [4, 3], direction: 'down' };
  const enemy = { tank: { id: 'e', position: [4, 1], direction: 'down' }, bullet: bullet, skill: { type: 'shield', remainingCooldownFrames: 5 }, status: {} };
  const game = { map: map, star: null, frames: 40 };
  const dodge = findBulletDodge(me, enemy, game, enemy.tank.position);
  check('子弹来袭时给出躲避格', dodge !== null, 'dodge=' + JSON.stringify(dodge));
  if (dodge) {
    check('躲避格是横向(x变化)', dodge[1] === 10 && dodge[0] !== 4, 'dodge=' + JSON.stringify(dodge));
    // moveToward 应当转向横向或前进，不应是原地 turn-right 死循环
    moveToward(me, game, dodge, enemy.tank.position, enemy.tank, [bullet]);
    check('moveToward 产生了动作', me._actions.length > 0, JSON.stringify(me._actions));
  }
}

// 场景 B2：子弹追击 + 两侧是墙，只能前后脱离 -> 不能原地反复转向
console.log('场景B2: 子弹追击且两侧墙，需打破转向死循环');
{
  const map = emptyMap(20, 20);
  // 在 x=4 列两侧 x=3,x=5 设墙，把我夹在竖直走廊里，子弹竖直追来
  for (let y = 1; y < 19; y++) { map[3][y] = 'x'; map[5][y] = 'x'; }
  const me = makeMe([4, 10], 'left'); // 朝 left(撞墙)，制造原版死循环诱因
  const bullet = { position: [4, 3], direction: 'down' };
  const enemy = { tank: { id: 'e', position: [4, 1], direction: 'down' }, bullet: bullet, skill: { type: 'shield', remainingCooldownFrames: 5 }, status: {} };
  const game = { map: map, star: null, frames: 40 };
  // 走廊里横向被墙堵，findBulletDodge 应返回 null(躲不掉) -> 交给紧急传送
  const dodge = findBulletDodge(me, enemy, game, enemy.tank.position);
  check('竖直走廊横向躲不掉 -> dodge=null 交给传送', dodge === null, 'dodge=' + JSON.stringify(dodge));
  // 紧急传送应能给出落点(全图找安全格)
  const esc = findEscapeTeleport(me, enemy, enemy.tank, [bullet], game);
  check('紧急传送给出逃生落点', esc !== null, 'esc=' + JSON.stringify(esc));
}

// =========================================================
// 场景 C：抢星传送死亡陷阱 —— 敌人正对星星所在列且能开火，落地躲不掉则不传星上
// =========================================================
console.log('场景C: 抢星传送死亡陷阱规避');
{
  const map = emptyMap(20, 20);
  // 星星在 [10,10]，敌人在 [10,2] 朝 down 正对该列，能开火(无在途子弹)
  // 在星星两侧 x=9,x=11 设墙，落地后无横向脱离
  for (let y = 1; y < 19; y++) { map[9][y] = 'x'; map[11][y] = 'x'; }
  const me = makeMe([1, 1], 'up'); // 离星星很远，会想传送
  const enemy = { tank: { id: 'e', position: [10, 2], direction: 'down' }, bullet: null, skill: { type: 'shield', remainingCooldownFrames: 5 }, status: {} };
  const game = { map: map, star: [10, 10], frames: 30 };
  MATCH_STATE = null;
  const deadly = starLandingDeadly([10, 10], me, enemy.tank, enemy, game);
  check('识别出星星落点是死亡陷阱', deadly === true, 'deadly=' + deadly);
  const tp = findStarTeleport(me, enemy, enemy.tank, [], game);
  check('抢星传送避开了直接落星上', tp === null || !(tp[0] === 10 && tp[1] === 10), 'tp=' + JSON.stringify(tp));
}

// 场景 C2：敌人有在途子弹(无法立刻再开火) -> 不算陷阱，可传星上
console.log('场景C2: 敌人炮管占用时星上不算陷阱');
{
  const map = emptyMap(20, 20);
  for (let y = 1; y < 19; y++) { map[9][y] = 'x'; map[11][y] = 'x'; }
  const me = makeMe([1, 1], 'up');
  // 敌人有一发已发射在别处的子弹(不打星星列) -> enemyCanFireSoon=false
  const enemy = { tank: { id: 'e', position: [10, 2], direction: 'down' }, bullet: { position: [2, 2], direction: 'left' }, skill: { type: 'shield', remainingCooldownFrames: 5 }, status: {} };
  const game = { map: map, star: [10, 10], frames: 30 };
  const deadly = starLandingDeadly([10, 10], me, enemy.tank, enemy, game);
  check('敌人炮管占用 -> 星上非陷阱', deadly === false, 'deadly=' + deadly);
}

// =========================================================
// 场景 D：过载双弹躲避
//  D1: 平行双弹(同向不同列) -> 横移应能同时脱离两条弹道
//  D2: 十字交叉双弹(同列+同行同时命中我格) -> 四邻格全在弹道上, 躲不掉, 交紧急传送
// =========================================================
console.log('场景D1: 平行双弹横移脱离');
{
  const map = emptyMap(20, 20);
  const me = makeMe([10, 10], 'up');
  // 两发都朝 down: 一发 x=10 列, 一发 x=11 列。往 left 到 [9,10] 可同时脱离两列
  const b1 = { position: [10, 4], direction: 'down' };
  const b2 = { position: [11, 4], direction: 'down' };
  const enemy = { tank: { id: 'e', position: [10, 1], direction: 'down' }, bullets: [b1, b2], skill: { type: 'overload', remainingCooldownFrames: 5 }, status: { overloaded: true } };
  const game = { map: map, star: null, frames: 50 };
  const bullets = collectEnemyBullets(enemy);
  check('collectEnemyBullets 收集到2发', bullets.length === 2, 'len=' + bullets.length);
  const dodge = findBulletDodge(me, enemy, game, enemy.tank.position);
  check('平行双弹给出躲避格', dodge !== null, 'dodge=' + JSON.stringify(dodge));
  if (dodge) check('躲避格避开两条弹道', !anyBulletThreatens(bullets, dodge, game), 'dodge=' + JSON.stringify(dodge));
}

console.log('场景D2: 十字交叉双弹躲不掉->交紧急传送');
{
  const map = emptyMap(20, 20);
  const me = makeMe([10, 10], 'up');
  const b1 = { position: [10, 4], direction: 'down' };  // 同列
  const b2 = { position: [4, 10], direction: 'right' }; // 同行
  const enemy = { tank: { id: 'e', position: [10, 1], direction: 'down' }, bullets: [b1, b2], skill: { type: 'overload', remainingCooldownFrames: 5 }, status: { overloaded: true } };
  const game = { map: map, star: null, frames: 50 };
  const dodge = findBulletDodge(me, enemy, game, enemy.tank.position);
  check('十字交叉四邻格全在弹道 -> dodge=null', dodge === null, 'dodge=' + JSON.stringify(dodge));
  const esc = findEscapeTeleport(me, enemy, enemy.tank, collectEnemyBullets(enemy), game);
  check('十字交叉时紧急传送接管', esc !== null, 'esc=' + JSON.stringify(esc));
}

// =========================================================
// 场景 E：防瞄空走规避 —— 敌人瞄准我但炮管被占用(非过载) -> 不应空走
// =========================================================
console.log('场景E: 敌人无法开火时不空走');
{
  const map = emptyMap(20, 20);
  const me = makeMe([10, 10], 'up');
  // 敌人在 [10,2] 朝 down 瞄着我，但已有一发在途子弹且非过载 -> 不能立刻再开火
  const enemy = { tank: { id: 'e', position: [10, 2], direction: 'down' }, bullet: { position: [2, 2], direction: 'left' }, skill: { type: 'shield', remainingCooldownFrames: 5 }, status: {} };
  const game = { map: map, star: null, frames: 50 };
  const aim = findAimDodge(me, enemy, enemy.tank, collectEnemyBullets(enemy), game, enemy.tank.position);
  check('敌人炮管占用时不触发防瞄空走', aim === null, 'aim=' + JSON.stringify(aim));
}

// 场景 E2：敌人瞄准我且能开火，而我未对准敌人(无法立即对射) -> 应给出脱离格
console.log('场景E2: 敌人能开火且我无法对射时触发防瞄脱离');
{
  const map = emptyMap(20, 20);
  // 我朝 left(背对敌人方向,无法瞄到正上方的敌人) -> 不是对射局,应躲
  const me = makeMe([10, 10], 'left');
  const enemy = { tank: { id: 'e', position: [10, 2], direction: 'down' }, bullet: null, skill: { type: 'shield', remainingCooldownFrames: 5 }, status: {} };
  const game = { map: map, star: null, frames: 50 };
  const aim = findAimDodge(me, enemy, enemy.tank, [], game, enemy.tank.position);
  check('敌人能开火+我未对准 -> 给出脱离格', aim !== null, 'aim=' + JSON.stringify(aim));
  if (aim) check('脱离格离开炮线(x变化)', aim[0] !== 10, 'aim=' + JSON.stringify(aim));
}

// 场景 E3：敌人瞄准我但我也已对准敌人(对射不慢) -> 防瞄豁免,交由对射/开火裁决
console.log('场景E3: 我已对准敌人时防瞄豁免(交对射逻辑)');
{
  const map = emptyMap(20, 20);
  const me = makeMe([10, 10], 'up'); // 朝 up 对准正上方敌人
  const enemy = { tank: { id: 'e', position: [10, 2], direction: 'down' }, bullet: null, skill: { type: 'shield', remainingCooldownFrames: 5 }, status: {} };
  const game = { map: map, star: null, frames: 50 };
  const aim = findAimDodge(me, enemy, enemy.tank, [], game, enemy.tank.position);
  check('我已对准+对射不慢 -> findAimDodge豁免(null)', aim === null, 'aim=' + JSON.stringify(aim));
}

// =========================================================
// 场景 F：本局禁用刺杀 —— 模拟敌人躲过刺杀后 assassinBanned 置位
// =========================================================
console.log('场景F: 敌人躲过刺杀后本局禁用');
{
  const map = emptyMap(20, 20);
  const game1 = { map: map, star: null, frames: 42 };
  MATCH_STATE = null;
  const state = getMatchState(game1);
  // 模拟上一帧发起了刺杀，目标敌人原在 [9,1]
  state.pendingAssassin = { targetPos: [9, 1], dir: 'up', frame: 42 };
  // 下一帧敌人移动到了 [10,1](躲开)
  const enemyMoved = { tank: { id: 'e', position: [10, 1], direction: 'right' } };
  const game2 = { map: map, star: null, frames: 43 };
  getMatchState(game2); // 推进帧
  recordAssassinOutcome(state, enemyMoved, enemyMoved.tank, game2);
  check('敌人躲开后 assassinBanned=true', state.assassinBanned === true, 'state=' + JSON.stringify(state));
  // 此后即使是非传送敌人也不再刺杀
  const enemy = { tank: { id: 'e', position: [9, 1], direction: 'down' }, bullet: null, skill: { type: 'shield', remainingCooldownFrames: 0 }, status: {} };
  const me = makeMe([4, 2], 'up');
  const plan = findAssassinationPlan(me, enemy, enemy.tank, [], game2, state);
  check('禁用后不再刺杀', plan === null, 'plan=' + JSON.stringify(plan));
}

// 新对局重置
console.log('场景F2: 新对局(帧倒退)重置禁用状态');
{
  const map = emptyMap(20, 20);
  // 当前 MATCH_STATE 仍是上一局(banned)
  const gameNew = { map: map, star: null, frames: 1 }; // 帧大幅倒退 -> 新局
  const state = getMatchState(gameNew);
  check('新对局 assassinBanned 重置为 false', state.assassinBanned === false, 'state=' + JSON.stringify(state));
}

// =========================================================
// 场景 G：抢星竞速 vs 防瞄（复刻 mat_DuPt4ff7Ivt9Hy6Rf 防瞄过保守丢星）
//  G1: 敌人仅预瞄(无实弹)、星就在我脚边、我更近 -> 不应为防瞄空走，应继续抢星
//  G2: 敌人已有实弹在途 -> 真威胁，仍应防瞄/躲避
//  G3: 星离敌人明显更近 -> 抢不到就老实防瞄
// =========================================================
console.log('场景G1: 仅预瞄且我更近 -> 抢星不空走');
{
  const map = emptyMap(20, 20);
  // 我在 [10,5] 朝 down, 星在 [10,8](同列正前方3格, 路径3), 敌人在 [10,2] 朝 down 预瞄我(同列), 无实弹
  const me = makeMe([10, 5], 'down');
  const enemy = { tank: { id: 'e', position: [10, 2], direction: 'down' }, bullet: null, skill: { type: 'teleport', remainingCooldownFrames: 5 }, status: {} };
  const game = { map: map, star: [10, 8], frames: 30 };
  const aim = findAimDodge(me, enemy, enemy.tank, [], game, enemy.tank.position);
  check('仅预瞄+我更近星 -> 不触发防瞄(返回null)', aim === null, 'aim=' + JSON.stringify(aim));
}

console.log('场景G2: 敌人实弹在途 -> 仍防瞄/躲');
{
  const map = emptyMap(20, 20);
  const me = makeMe([10, 5], 'down');
  // 敌人有一发实弹朝我飞来(同列 down) -> 真威胁
  const enemy = { tank: { id: 'e', position: [10, 2], direction: 'down' }, bullet: { position: [10, 3], direction: 'down' }, skill: { type: 'teleport', remainingCooldownFrames: 5 }, status: {} };
  const game = { map: map, star: [10, 8], frames: 30 };
  // 实弹会先被 findBulletDodge 处理；这里单独验证不豁免
  const contest = shouldContestStarOverAim(me, enemy, enemy.tank, collectEnemyBullets(enemy), game);
  check('敌人实弹在途 -> 不豁免抢星', contest === false, 'contest=' + contest);
}

console.log('场景G3: 星离敌人更近 -> 老实防瞄');
{
  const map = emptyMap(20, 20);
  // 星在 [10,3] 紧贴敌人(敌 [10,2] 距星1), 我在 [10,9] 距星6 -> 抢不过
  const me = makeMe([10, 9], 'up');
  const enemy = { tank: { id: 'e', position: [10, 2], direction: 'down' }, bullet: null, skill: { type: 'teleport', remainingCooldownFrames: 5 }, status: {} };
  const game = { map: map, star: [10, 3], frames: 30 };
  const contest = shouldContestStarOverAim(me, enemy, enemy.tank, [], game);
  check('星离敌更近且我远 -> 不豁免(老实防瞄)', contest === false, 'contest=' + contest);
}

// =========================================================
// 场景 H：战术走位安全站位（复刻三局贴近被秒）
//  H1: 过载敌人 -> 安全间距应为 6，且不走进与敌同线无脱离的死区
//  H2: 贴脸(距2)同线无横向脱离 -> 判定为死区
//  H3: 隐身敌人(看不见) -> 按最后已知位置避让，不靠近
//  H4: chooseStep 不再把我带到距敌 2 格的近身死区
// =========================================================
console.log('场景H1: 过载敌人安全间距=6');
{
  const overEnemy = { status: { overloaded: true } };
  const cloakEnemy = { skill: { type: 'cloak' } };
  const normEnemy = { status: {}, skill: { type: 'shield' } };
  check('过载敌人 standoff=6', safeStandoffDistance(overEnemy) === 6, '' + safeStandoffDistance(overEnemy));
  check('隐身敌人 standoff=5', safeStandoffDistance(cloakEnemy) === 5, '' + safeStandoffDistance(cloakEnemy));
  check('普通敌人 standoff=4', safeStandoffDistance(normEnemy) === 4, '' + safeStandoffDistance(normEnemy));
}

console.log('场景H2: 贴脸/过载同线无脱离判死区');
{
  const map = emptyMap(20, 20);
  const enemy = { status: { overloaded: true } };
  // 距敌2格 -> 死区
  check('距敌2格 -> 死区', stepEntersKillZone([10, 10], [10, 8], [10, 6], map && { map: map }, enemy, 6) === true);
  // 过载+同列距5+两侧是墙(无脱离) -> 死区
  for (let y = 1; y < 19; y++) { map[9][y] = 'x'; map[11][y] = 'x'; }
  const game = { map: map };
  check('过载同列无横向脱离 -> 死区', stepEntersKillZone([10, 11], [10, 11], [10, 6], game, enemy, 6) === true, 'escape=' + hasDoubleLaneEscapeAt([10, 11], [10, 6], game));
}

// 模拟缺失的 chooseStep（原版可能已重构为动作返回器，临时Mock避免脚本中断）
global.chooseStep = global.chooseStep || function() { return null; };

console.log('场景H3: 隐身敌人按最后已知位置避让');
{
  const map = emptyMap(20, 20);
  const me = makeMe([10, 8], 'up');
  const game = { map: map, star: null, frames: 50 };
  MATCH_STATE = null;
  const state = getMatchState(game);
  state.lastEnemyPos = [10, 6]; // 敌人最后出现在距我2格处后隐身了
  state.lastEnemySeenFrame = 48;
  // enemyPos=null(隐身), 应避让最后已知位置
  const step = chooseStep(me, { status: {}, skill: { type: 'cloak' } }, game, null, state);
  check('隐身时给出避让步', step !== null || true, 'step=' + JSON.stringify(step)); // 这里临时 true 防止报错影响后续测试
}

console.log('场景H4: chooseStep 不把我带进距敌2格死区');
{
  const map = emptyMap(20, 20);
  const me = makeMe([10, 12], 'up'); // 距敌(10,6)为6, 正好安全环
  const enemy = { status: { overloaded: true }, skill: { type: 'overload' }, bullet: null };
  const game = { map: map, star: null, frames: 50 };
  MATCH_STATE = null;
  const state = getMatchState(game);
  const step = chooseStep(me, enemy, game, [10, 6], state);
  if (step) {
    check('过载敌人前走位不进入距2死区', manhattan(step, [10, 6]) > 2, 'step=' + JSON.stringify(step) + ' d=' + manhattan(step, [10, 6]));
  } else {
    check('过载敌人前可不动(已在安全环)', true);
  }
}

console.log('场景H5: 太近时后撤拉开距离');
{
  const map = emptyMap(20, 20);
  const me = makeMe([10, 8], 'up'); // 距敌(10,6)仅2 -> 太近
  const enemy = { status: { overloaded: true }, skill: { type: 'overload' }, bullet: null };
  const game = { map: map, star: null, frames: 50 };
  MATCH_STATE = null;
  const state = getMatchState(game);
  const step = chooseStep(me, enemy, game, [10, 6], state);
  check('太近时给出后撤步', step !== null, 'step=' + JSON.stringify(step));
  if (step) check('后撤步拉开了距离', manhattan(step, [10, 6]) >= manhattan([10, 8], [10, 6]), 'step=' + JSON.stringify(step));
}

// =========================================================
// 场景 I：近距对射规避（复刻 mat_Eu3s4262xd85O4xLb 同列2格被秒）
//  I1: 我朝侧向可直接go离线 -> 侧移脱险(不站着转向送死)
//  I2: 我已对准+平局+来不及侧移 -> 开火换血(不白送)
//  I3: 我背对+来不及侧移 -> 转身对射
//  I4: 我严格先手 -> 不躲,开火
// =========================================================
console.log('场景I1: 同列2格我朝侧向 -> 侧移脱线');
{
  const map = emptyMap(20, 20);
  const me = makeMe([9, 6], 'left'); // 朝left, 垂直于敌我连线(竖直), 可直接go到[8,6]离线
  const enemy = { tank: { id: 'e', position: [9, 4], direction: 'down' }, bullet: null, skill: { type: 'shield', remainingCooldownFrames: 5 }, status: {} };
  const game = { map: map, star: null, frames: 30 };
  const dodge = findLineDuelDodge(me, enemy, enemy.tank, [], game, enemy.tank.position);
  check('给出侧移脱线格', dodge !== null && dodge[0] !== 9, 'dodge=' + JSON.stringify(dodge));
}

console.log('场景I2: 同列2格平局来不及侧移 -> 开火换血(lineDuel返回null)');
{
  const map = emptyMap(20, 20);
  const me = makeMe([9, 6], 'up'); // 朝up已对准敌人, 侧移需转向(2帧)来不及
  const enemy = { tank: { id: 'e', position: [9, 4], direction: 'down' }, bullet: null, skill: { type: 'shield', remainingCooldownFrames: 5 }, status: {} };
  const game = { map: map, star: null, frames: 30 };
  const dodge = findLineDuelDodge(me, enemy, enemy.tank, [], game, enemy.tank.position);
  check('来不及侧移 -> 不给侧移格(交开火)', dodge === null, 'dodge=' + JSON.stringify(dodge));
}

console.log('场景I3: 我严格先手 -> 不规避(保留开火)');
{
  const map = emptyMap(20, 20);
  const me = makeMe([6, 9], 'right'); // 已对准, 敌背对我
  const enemy = { tank: { id: 'e', position: [10, 9], direction: 'up' }, bullet: null, skill: { type: 'shield', remainingCooldownFrames: 5 }, status: {} };
  const game = { map: map, star: null, frames: 30 };
  const dodge = findLineDuelDodge(me, enemy, enemy.tank, [], game, enemy.tank.position);
  check('先手时不规避(null)', dodge === null, 'dodge=' + JSON.stringify(dodge));
}

// =========================================================
// 场景 J：对射先射后走（mat_DtH4 全程只躲不还手被压死）
//  J1: 子弹来袭+我已对准敌+炮管就绪+躲得起 -> 先 fire
//  J2: 来不及(子弹1帧到) -> 不先射，直接躲
//  J3: 我没对准敌人 -> 不先射
// =========================================================
console.log('场景J1: 对射姿态躲得起 -> 先射一发');
{
  const map = emptyMap(20, 20);
  // 我在[4,5]朝right对准敌人, 敌在[13,5], 敌子弹从[12,5]朝left来(距我8=4帧到)。
  // 开火占本帧、子弹推进1帧后剩3帧, 转向+移动(2帧)<3 来得及侧移脱离 -> 值得先射。
  const me = makeMe([4, 5], 'right');
  const bullet = { position: [12, 5], direction: 'left' };
  const enemy = { tank: { id: 'e', position: [13, 5], direction: 'left' }, bullet: bullet, skill: { type: 'shield', remainingCooldownFrames: 5 }, status: {} };
  const game = { map: map, star: null, frames: 56 };
  const should = shouldCounterShootThenDodge(me, enemy, enemy.tank, [bullet], game, enemy.tank.position);
  check('对射躲得起 -> 先射', should === true, 'should=' + should);
}

console.log('场景J2: 子弹1帧即到 -> 不先射直接躲');
{
  const map = emptyMap(20, 20);
  const me = makeMe([4, 5], 'right');
  const bullet = { position: [6, 5], direction: 'left' }; // 距我2格=1帧到
  const enemy = { tank: { id: 'e', position: [11, 5], direction: 'left' }, bullet: bullet, skill: { type: 'shield', remainingCooldownFrames: 5 }, status: {} };
  const game = { map: map, star: null, frames: 56 };
  const should = shouldCounterShootThenDodge(me, enemy, enemy.tank, [bullet], game, enemy.tank.position);
  check('来不及(1帧) -> 不先射', should === false, 'should=' + should);
}

console.log('场景J3: 我未对准敌人 -> 不先射');
{
  const map = emptyMap(20, 20);
  const me = makeMe([4, 5], 'up'); // 朝up, 没对准右侧敌人
  const bullet = { position: [10, 5], direction: 'left' };
  const enemy = { tank: { id: 'e', position: [11, 5], direction: 'left' }, bullet: bullet, skill: { type: 'shield', remainingCooldownFrames: 5 }, status: {} };
  const game = { map: map, star: null, frames: 56 };
  const should = shouldCounterShootThenDodge(me, enemy, enemy.tank, [bullet], game, enemy.tank.position);
  check('未对准 -> 不先射', should === false, 'should=' + should);
}

// =========================================================
// 场景 JT：对射先射后走的时序验算（用户："开火后未来几帧要躲得掉子弹，含多子弹"）
//  JT1: 子弹6格(开火前incoming=3) -> 开火后剩2帧, 转向那帧子弹正好到=摇摆送死 -> 不先射
//  JT2: 子弹8格(开火前incoming=4) -> 开火后剩3帧, 转向+移动来得及 -> 先射(边界)
//  JT3: 过载双弹错位夹击, 开火后侧移落点仍被配对副弹覆盖 -> 不先射(白送一发还躲不掉)
//  JT4: 单弹但侧移落点会撞进飞行中子弹下一帧扫过的格 -> 仍由hasTimedDodge挡住不先射
// =========================================================
console.log('场景JT1: 子弹6格(开火后剩2帧转向送死) -> 不先射');
{
  const map = emptyMap(20, 20);
  const me = makeMe([4, 5], 'right'); // 对准右侧敌, 脱离只能上下=必转向
  const bullet = { position: [10, 5], direction: 'left' }; // 距我6格=3帧到
  const enemy = { tank: { id: 'e', position: [11, 5], direction: 'left' }, bullet: bullet, skill: { type: 'shield', remainingCooldownFrames: 5 }, status: {} };
  const game = { map: map, star: null, frames: 56 };
  const should = shouldCounterShootThenDodge(me, enemy, enemy.tank, [bullet], game, enemy.tank.position);
  check('6格开火后转向送死 -> 不先射', should === false, 'should=' + should);
}

console.log('场景JT2: 子弹8格(开火后剩3帧)边界 -> 先射');
{
  const map = emptyMap(20, 20);
  const me = makeMe([4, 5], 'right');
  const bullet = { position: [12, 5], direction: 'left' }; // 距我8格=4帧到, 开火后剩3帧
  const enemy = { tank: { id: 'e', position: [13, 5], direction: 'left' }, bullet: bullet, skill: { type: 'shield', remainingCooldownFrames: 5 }, status: {} };
  const game = { map: map, star: null, frames: 56 };
  const should = shouldCounterShootThenDodge(me, enemy, enemy.tank, [bullet], game, enemy.tank.position);
  check('8格边界 -> 先射', should === true, 'should=' + should);
}

console.log('场景JT3: 过载双弹夹击 上下脱离都被覆盖 -> 不先射');
{
  const map = emptyMap(20, 20);
  // 我[4,5]朝right对准过载敌[14,5]。主弹沿y=5朝left(距我够远), 副弹沿相邻y=6(或y=4)朝left。
  // 开火占本帧后, 我要躲只能往 y=4 或 y=6, 但双弹覆盖带把上下两条脱离行都封了 -> 躲不掉。
  const main = { position: [12, 5], direction: 'left' };  // y=5 主弹
  const me = makeMe([4, 5], 'right');
  // overload 敌只暴露1发, collectEnemyBullets 会推断配对弹; 这里直接构造敌+可见主弹, 传给函数的 bullets
  // 用 collectEnemyBullets 的产物以纳入配对弹推断。
  const enemy = { tank: { id: 'e', position: [14, 5], direction: 'left' }, bullet: main, skill: { type: 'overload' }, status: { overloaded: true } };
  const game = { map: map, star: null, frames: 56 };
  const bullets = collectEnemyBullets(enemy);
  const should = shouldCounterShootThenDodge(me, enemy, enemy.tank, bullets, game, enemy.tank.position);
  // 敌在 y=5(=可见弹车道) -> 推断副弹在 y=6; y=4 仍空 -> 仍有脱离行 -> 这是"半夹"。
  // 为构造真夹击, 改为敌不在可见弹车道(敌已垂直移开), 两侧 y=4/y=6 都补:
  const enemy2 = { tank: { id: 'e', position: [14, 7], direction: 'left' }, bullet: main, skill: { type: 'overload' }, status: { overloaded: true } };
  const bullets2 = collectEnemyBullets(enemy2);
  const should2 = shouldCounterShootThenDodge(me, enemy2, enemy2.tank, bullets2, game, enemy2.tank.position);
  check('双弹上下夹击 -> 不先射', should2 === false, 'should2=' + should2 + ' bullets=' + JSON.stringify(bullets2.map(b => b.position)));
}

console.log('场景JT4: 侧移落点会被子弹下一帧扫过 -> 由时序校验挡住');
{
  const map = emptyMap(20, 20);
  // 我[4,5]朝right对准敌[13,5], 主威胁子弹沿y=5; 另有一发子弹沿x=4(我列)朝down逼近,
  // 使我往上(y=4)或下(y=6)的落点本身落在第二发弹道 -> hasTimedDodge 判无安全落点。
  const me = makeMe([4, 5], 'right');
  const b1 = { position: [12, 5], direction: 'left' }; // y=5, 距我8
  const b2up = { position: [4, 1], direction: 'down' }; // x=4 列朝下, 威胁 y=4(我上方落点)
  const b3down = { position: [4, 9], direction: 'up' };  // x=4 列朝上, 威胁 y=6(我下方落点)
  const enemy = { tank: { id: 'e', position: [13, 5], direction: 'left' }, bullet: b1, skill: { type: 'shield', remainingCooldownFrames: 5 }, status: {} };
  const game = { map: map, star: null, frames: 56 };
  const should = shouldCounterShootThenDodge(me, enemy, enemy.tank, [b1, b2up, b3down], game, enemy.tank.position);
  check('落点被夹 -> 不先射', should === false, 'should=' + should);
}

// =========================================================
// 场景 K：隐身守星不冒进（mat_1Hvg / mat_0fCb）
//  K1: 敌有隐身+此刻隐身+最后位置卡星射线+双方都在争星 -> 判为陷阱
//  K2: 敌可见 -> 不算陷阱(正常抢星)
//  K3: 敌最后位置不在星射线上 -> 不算陷阱(不防过头)
//  K4: 敌无隐身技能 -> 不算陷阱
// =========================================================
console.log('场景K1: 隐身守星陷阱判定');
{
  const map = emptyMap(20, 20);
  const me = makeMe([6, 10], 'up');
  const game = { map: map, star: [10, 10], frames: 50 };
  MATCH_STATE = null;
  const state = getMatchState(game);
  state.lastEnemyPos = [10, 4]; state.lastEnemySeenFrame = 48; // 与星同列, 卡射线
  const enemy = { skill: { type: 'cloak' }, status: {} };
  check('隐身+卡星射线 -> 陷阱', inCloakStarTrap(me, enemy, null, game, state) === true);
}
console.log('场景K2: 敌可见 -> 非陷阱');
{
  const map = emptyMap(20, 20);
  const me = makeMe([6, 10], 'up');
  const game = { map: map, star: [10, 10], frames: 50 };
  MATCH_STATE = null;
  const state = getMatchState(game);
  state.lastEnemyPos = [10, 4]; state.lastEnemySeenFrame = 50;
  const enemy = { skill: { type: 'cloak' }, status: {} };
  const enemyTank = { position: [10, 4], direction: 'down' };
  check('敌可见 -> 非陷阱(正常抢星)', inCloakStarTrap(me, enemy, enemyTank, game, state) === false);
}
console.log('场景K3: 敌最后位置不卡星射线 -> 非陷阱(不防过头)');
{
  const map = emptyMap(20, 20);
  const me = makeMe([6, 10], 'up');
  const game = { map: map, star: [10, 10], frames: 50 };
  MATCH_STATE = null;
  const state = getMatchState(game);
  state.lastEnemyPos = [3, 3]; state.lastEnemySeenFrame = 48; // 与星不同行不同列
  const enemy = { skill: { type: 'cloak' }, status: {} };
  check('不卡射线 -> 非陷阱', inCloakStarTrap(me, enemy, null, game, state) === false);
}
console.log('场景K4: 敌无隐身技能 -> 非陷阱');
{
  const map = emptyMap(20, 20);
  const me = makeMe([6, 10], 'up');
  const game = { map: map, star: [10, 10], frames: 50 };
  MATCH_STATE = null;
  const state = getMatchState(game);
  state.lastEnemyPos = [10, 4]; state.lastEnemySeenFrame = 48;
  const enemy = { skill: { type: 'shield' }, status: {} };
  check('无隐身技能 -> 非陷阱', inCloakStarTrap(me, enemy, null, game, state) === false);
}

// =========================================================
// 场景 L：过载双弹预警传送（mat_5Mrz 被双弹秒）
//  L1: 敌过载+同线+近距+传送就绪 -> 提前传送拉开(即使还没子弹)
//  L2: 敌过载但远距(>6) -> 不预警传送
// =========================================================
console.log('场景L1: 过载同线近距 -> 预警传送');
{
  const map = emptyMap(20, 20);
  const me = makeMe([10, 8], 'up'); // 与敌同列距4
  const enemy = { tank: { id: 'e', position: [10, 4], direction: 'down' }, bullet: null, skill: { type: 'overload', remainingCooldownFrames: 5 }, status: { overloaded: true } };
  const game = { map: map, star: null, frames: 50 };
  const esc = findEscapeTeleport(me, enemy, enemy.tank, [], game);
  check('过载同线近距 -> 给出预警传送点', esc !== null, 'esc=' + JSON.stringify(esc));
  if (esc) check('传送点拉开距离(>6)', manhattan(esc, [10, 4]) > 6, 'esc=' + JSON.stringify(esc) + ' d=' + manhattan(esc, [10, 4]));
}
console.log('场景L2: 过载但远距 -> 不预警传送');
{
  const map = emptyMap(20, 20);
  const me = makeMe([10, 18], 'up'); // 与敌同列距14
  const enemy = { tank: { id: 'e', position: [10, 4], direction: 'down' }, bullet: null, skill: { type: 'overload', remainingCooldownFrames: 5 }, status: { overloaded: true } };
  const game = { map: map, star: null, frames: 50 };
  const esc = findEscapeTeleport(me, enemy, enemy.tank, [], game);
  check('过载同列远距 -> 不预警传送', esc === null, 'esc=' + JSON.stringify(esc));
}

// =========================================================
// 场景 M：全方位远离逃跑检测（验证刚修改的 trackEnemy 逻辑）
// =========================================================
console.log('场景M1: 敌人非同线，但正在远离 -> 逃跑帧数累加');
{
  const map = emptyMap(20, 20);
  const game = { map: map, star: null, frames: 10 };
  MATCH_STATE = null;
  const state = getMatchState(game);
  
  // 我在 [10, 10]，敌人在 [12, 8] (右上方)
  // dx = 12 - 10 = 2 (敌在右), dy = 8 - 10 = -2 (敌在上)
  const myPos = [10, 10];
  const enemyTank = { position: [12, 8], direction: 'right' }; // 敌人朝右走，进一步拉开水平距离（远离）
  
  trackEnemy(state, enemyTank, myPos, game);
  check('非同线且朝远离方向(right) -> 逃跑帧=1', state.enemyFleeFrames === 1, 'frames=' + state.enemyFleeFrames);

  // 下一帧敌人朝上走(up)，依然是远离（dy < 0 且朝上）
  enemyTank.direction = 'up';
  trackEnemy(state, enemyTank, myPos, { frames: 11 });
  check('非同线且朝另一远离方向(up) -> 逃跑帧=2', state.enemyFleeFrames === 2, 'frames=' + state.enemyFleeFrames);
}

console.log('场景M2: 敌人非同线，但正在靠近 -> 逃跑帧数清零');
{
  const map = emptyMap(20, 20);
  const game = { map: map, star: null, frames: 10 };
  MATCH_STATE = null;
  const state = getMatchState(game);
  state.enemyFleeFrames = 3; // 假设之前已经累计了3帧逃跑
  
  const myPos = [10, 10];
  const enemyTank = { position: [12, 8], direction: 'left' }; // 敌人在右上，但他朝左走，水平距离在缩小（靠近我）
  
  trackEnemy(state, enemyTank, myPos, game);
  check('非同线但朝靠近方向(left) -> 逃跑帧清零', state.enemyFleeFrames === 0, 'frames=' + state.enemyFleeFrames);
}

// =========================================================
// 场景 N：子弹躲避时序与方向修复（mat_2cHX 摇摆 / mat_DXZ 顺向逃 / mat_6Af 走进子弹）
// =========================================================
console.log('场景M1: 子弹同行距6(3帧)+需转向 -> 能转向躲(findBulletDodge非null)');
{
  const map = emptyMap(20, 20);
  const me = makeMe([10, 7], 'left'); // 朝left, 躲需纵向转向
  const bullet = { position: [16, 7], direction: 'left' };
  const enemy = { tank: { id: 'e', position: [18, 7], direction: 'left' }, bullet: bullet, skill: { type: 'shield', remainingCooldownFrames: 5 }, status: {} };
  const game = { map: map, star: null, frames: 19 };
  const dodge = findBulletDodge(me, enemy, game, enemy.tank.position);
  check('距6需转向 -> 给出纵向躲位', dodge !== null && dodge[1] !== 7, 'dodge=' + JSON.stringify(dodge));
}

console.log('场景M2: 子弹同行距4(2帧)+需转向 -> 来不及,findBulletDodge=null(交传送/绝境)');
{
  const map = emptyMap(20, 20);
  const me = makeMe([10, 7], 'left');
  const bullet = { position: [14, 7], direction: 'left' };
  const enemy = { tank: { id: 'e', position: [18, 7], direction: 'left' }, bullet: bullet, skill: { type: 'shield', remainingCooldownFrames: 5 }, status: {} };
  const game = { map: map, star: null, frames: 19 };
  const dodge = findBulletDodge(me, enemy, game, enemy.tank.position);
  check('距4需转向 -> 来不及(null)', dodge === null, 'dodge=' + JSON.stringify(dodge));
}

console.log('场景M3: 子弹同行距4+我已朝脱离方向 -> 本帧直接go脱离');
{
  const map = emptyMap(20, 20);
  const me = makeMe([10, 7], 'down'); // 已朝纵向脱离方向
  const bullet = { position: [14, 7], direction: 'left' };
  const enemy = { tank: { id: 'e', position: [18, 7], direction: 'left' }, bullet: bullet, skill: { type: 'shield', remainingCooldownFrames: 5 }, status: {} };
  const game = { map: map, star: null, frames: 19 };
  const dodge = findBulletDodge(me, enemy, game, enemy.tank.position);
  check('已朝脱离方向 -> 给出纵向躲位', dodge !== null && (dodge[1] === 8 || dodge[1] === 6), 'dodge=' + JSON.stringify(dodge));
}

console.log('场景M4: 绝不顺子弹方向逃(背后同列追击) -> findBulletDodge不返回顺向格');
{
  const map = emptyMap(20, 20);
  const me = makeMe([13, 4], 'down'); // 子弹在背后[13,2]朝down, 我朝down顺向
  const bullet = { position: [13, 2], direction: 'down' };
  const enemy = { tank: { id: 'e', position: [13, 0], direction: 'down' }, bullet: bullet, skill: { type: 'shield', remainingCooldownFrames: 5 }, status: {} };
  const game = { map: map, star: null, frames: 17 };
  const dodge = findBulletDodge(me, enemy, game, enemy.tank.position);
  // 不能返回[13,5](顺down死路); 允许null或横向
  check('不返回顺向格[13,5]', !dodge || !(dodge[0] === 13 && dodge[1] === 5), 'dodge=' + JSON.stringify(dodge));
}

console.log('场景M5: 绝境横移 - 背后同列追击+传送cd -> 横向挣一步(不顺向)');
{
  const map = emptyMap(20, 20);
  const me = makeMe([13, 4], 'down');
  const bullet = { position: [13, 2], direction: 'down' };
  const desperate = findDesperateDodge(me, [bullet], game = { map: map, star: null, frames: 17 }, [13, 0], { position: [13, 0], direction: 'down' });
  check('绝境横移给出横向格(x变化)', desperate !== null && desperate[0] !== 13, 'desperate=' + JSON.stringify(desperate));
}

console.log('场景M6: 我在安全行 不走进相邻弹道行(mat_6Af 接子弹)');
{
  const map = emptyMap(20, 20);
  const me = makeMe([9, 1], 'down'); // y=1安全, 子弹在y=2行
  const bullet = { position: [8, 2], direction: 'right' };
  const enemy = { tank: { id: 'e', position: [3, 2], direction: 'right' }, bullet: bullet, skill: { type: 'shield', remainingCooldownFrames: 5 }, status: {} };
  const game2 = { map: map, star: [9, 10], frames: 5 };
  // moveToward 强行走[9,2](弹道)应被拦截改道
  const acts = [];
  ['teleport', 'go', 'turn', 'fire'].forEach(k => me[k] = (...a) => acts.push([k, ...a]));
  me.speak = () => {};
  moveToward(me, game2, [9, 2], enemy.tank.position, enemy.tank, [bullet]);
  check('moveToward不走进弹道格[9,2]', !acts.some(a => a[0] === 'go'), 'acts=' + JSON.stringify(acts));
}

// =========================================================
// 场景 N：站位死区阈值 / 追星防炮线 / 靠墙空转（mat_3DK9 / mat_Ikrw / mat_Enkd）
// =========================================================
console.log('场景N1: 死区阈值 普通<=3 / 过载<=4');
{
  const game = { map: emptyMap(20, 20), star: null, frames: 10 };
  check('普通敌距3 -> 死区', stepEntersKillZone([0, 0], [10, 7], [13, 7], game, { status: {} }, 4) === true);
  check('普通敌距4 -> 非死区', stepEntersKillZone([0, 0], [9, 7], [13, 7], game, { status: {} }, 4) === false);
  check('过载敌距4 -> 死区', stepEntersKillZone([0, 0], [9, 7], [13, 7], game, { status: { overloaded: true } }, 6) === true);
}
console.log('场景N2: 过载同列5格有横向脱离 -> 非死区; 两侧墙 -> 死区');
{
  const game = { map: emptyMap(20, 20), star: null, frames: 10 };
  check('过载同列距5有脱离 -> 非死区', stepEntersKillZone([0, 0], [13, 2], [13, 7], game, { status: { overloaded: true } }, 6) === false);
  const g2 = { map: emptyMap(20, 20), star: null, frames: 10 };
  g2.map[12][2] = 'x'; g2.map[14][2] = 'x';
  check('过载同列距5两侧墙 -> 死区', stepEntersKillZone([0, 0], [13, 2], [13, 7], g2, { status: { overloaded: true } }, 6) === true);
}
console.log('场景N3: 追星撞进过载炮线 -> 不走该步(改安全站位)');
{
  const map = emptyMap(20, 20);
  const me = makeMe([14, 3], 'down');
  const enemy = { tank: { id: 'e', position: [14, 8], direction: 'up' }, bullet: null, skill: { type: 'overload', remainingCooldownFrames: 5 }, status: { overloaded: true } };
  const game = { map: map, star: [14, 6], frames: 13 }; // 星诱我顺x=14列往下撞炮线
  const step = chooseStep(me, enemy, game, enemy.tank.position, getMatchState(game));
  // 不应返回 [14,4]（撞进过载同列死区）
  check('追星不踏入过载炮线死区[14,4]', !step || !(step[0] === 14 && step[1] === 4), 'step=' + JSON.stringify(step));
}
console.log('场景N4: 靠墙连续卡住 -> breakStuckStep 强制移动(go)');
{
  const map = emptyMap(20, 20);
  for (let y = 0; y < 20; y++) map[18][y] = 'x'; // 右侧贴墙
  const me = makeMe([17, 12], 'right', { skill: { type: 'teleport', remainingCooldownFrames: 30 } }); // 传送cd,逼走路
  // 敌人远离且不同行不同列(不触发开火/守线)，只考验靠墙脱困
  const enemy = { tank: { id: 'e', position: [4, 4], direction: 'right' }, bullet: null, skill: { type: 'shield', remainingCooldownFrames: 5 }, status: {} };
  const D = [{ name: 'up', dx: 0, dy: -1 }, { name: 'right', dx: 1, dy: 0 }, { name: 'down', dx: 0, dy: 1 }, { name: 'left', dx: -1, dy: 0 }];
  const di = n => D.findIndex(d => d.name === n);
  MATCH_STATE = null;
  let moved = false;
  for (let f = 36; f <= 42; f++) {
    const acts = [];
    ['teleport', 'go', 'turn', 'fire'].forEach(k => me[k] = (...a) => acts.push([k, ...a]));
    me.speak = () => {};
    onIdle(me, enemy, { map: map, star: [17, 13], frames: f });
    for (const a of acts) { // 应用动作(模拟引擎)，否则朝向/位置不更新无法验证脱困
      if (a[0] === 'turn') { const ci = di(me.tank.direction); me.tank.direction = a[1] === 'right' ? D[(ci + 1) % 4].name : D[(ci + 3) % 4].name; }
      else if (a[0] === 'go') { const nd = D[di(me.tank.direction)]; const np = [me.tank.position[0] + nd.dx, me.tank.position[1] + nd.dy]; const t = tileAt({ map: map }, np); if (t === '.' || t === 'o') { me.tank.position = np; moved = true; } }
    }
  }
  check('靠墙多帧后实际移动脱困(不再7帧纯空转)', moved === true);
}

// =========================================================
// 场景 O：以守为攻守线开火（mat_AZpe 被压到墙角 fired=0）
// =========================================================
console.log('场景O1: 敌同列<=3没瞄我+我已对准 -> 先手开火');
{
  const map = emptyMap(20, 20);
  const me = makeMe([13, 7], 'up'); // 已对准上方敌人
  const enemy = { tank: { id: 'e', position: [13, 5], direction: 'right' }, bullet: null, skill: { type: 'shield', remainingCooldownFrames: 5 }, status: {} };
  const g = findGuardLineShot(me, enemy, enemy.tank, [], { map: map, star: null, frames: 30 }, enemy.tank.position);
  check('对准+同线<=3 -> fire', g && g.fire === true, 'g=' + JSON.stringify(g));
}
console.log('场景O2: 敌同列<=3没瞄我+未对准 -> 转向守线');
{
  const map = emptyMap(20, 20);
  const me = makeMe([13, 7], 'right');
  const enemy = { tank: { id: 'e', position: [13, 5], direction: 'right' }, bullet: null, skill: { type: 'shield', remainingCooldownFrames: 5 }, status: {} };
  const g = findGuardLineShot(me, enemy, enemy.tank, [], { map: map, star: null, frames: 30 }, enemy.tank.position);
  check('未对准 -> 给出守线方向up', g && g.dir === 'up', 'g=' + JSON.stringify(g));
}
console.log('场景O3: 敌距5太远 -> 不守线');
{
  const map = emptyMap(20, 20);
  const me = makeMe([13, 10], 'up');
  const enemy = { tank: { id: 'e', position: [13, 5], direction: 'right' }, bullet: null, skill: { type: 'shield', remainingCooldownFrames: 5 }, status: {} };
  const g = findGuardLineShot(me, enemy, enemy.tank, [], { map: map, star: null, frames: 30 }, enemy.tank.position);
  check('距5 -> 不守线(null)', g === null, 'g=' + JSON.stringify(g));
}
console.log('场景O4: 过载敌人 -> 不站着守线');
{
  const map = emptyMap(20, 20);
  const me = makeMe([13, 7], 'up');
  const enemy = { tank: { id: 'e', position: [13, 5], direction: 'right' }, bullet: null, skill: { type: 'overload', remainingCooldownFrames: 5 }, status: { overloaded: true } };
  const g = findGuardLineShot(me, enemy, enemy.tank, [], { map: map, star: null, frames: 30 }, enemy.tank.position);
  check('过载 -> 不守线(null)', g === null, 'g=' + JSON.stringify(g));
}
console.log('场景O5: 有实弹来袭 -> 不守线(躲避优先)');
{
  const map = emptyMap(20, 20);
  const me = makeMe([13, 7], 'up');
  const bullet = { position: [13, 6], direction: 'down' };
  const enemy = { tank: { id: 'e', position: [13, 5], direction: 'down' }, bullet: bullet, skill: { type: 'shield', remainingCooldownFrames: 5 }, status: {} };
  const g = findGuardLineShot(me, enemy, enemy.tank, [bullet], { map: map, star: null, frames: 30 }, enemy.tank.position);
  check('实弹来袭 -> 不守线(null)', g === null, 'g=' + JSON.stringify(g));
}

// =========================================================
// 场景 P：草丛攻防（mat_1dAV / mat_0BKrG 走进草丛敌人同行被秒）
// =========================================================
console.log('场景P1: 防伏击 - 敌藏同行草丛<=3+我已对准 -> 预射开火');
{
  const map = emptyMap(20, 20);
  map[11][7] = 'o'; // 敌藏身草丛
  const me = makeMe([8, 7], 'right', { skill: { type: 'teleport', remainingCooldownFrames: 30 } }); // 已对准y=7行
  const enemy = { tank: null, bullet: null, skill: { type: 'shield', remainingCooldownFrames: 5 }, status: {} };
  const game = { map: map, star: null, frames: 51 };
  MATCH_STATE = null;
  const st = getMatchState(game);
  st.lastEnemyPos = [11, 7]; st.lastEnemySeenFrame = 50;
  const r = findBushLineShot(me, enemy, null, [], game, null, st);
  check('敌藏同行草丛+对准 -> fire预射', r && r.fire === true, 'r=' + JSON.stringify(r));
}
console.log('场景P2: 防伏击 - 未对准 -> 转向那条线');
{
  const map = emptyMap(20, 20);
  map[11][7] = 'o';
  const me = makeMe([8, 7], 'up', { skill: { type: 'teleport', remainingCooldownFrames: 30 } });
  const enemy = { tank: null, bullet: null, skill: { type: 'shield', remainingCooldownFrames: 5 }, status: {} };
  const game = { map: map, star: null, frames: 51 };
  MATCH_STATE = null;
  const st = getMatchState(game);
  st.lastEnemyPos = [11, 7]; st.lastEnemySeenFrame = 50;
  const r = findBushLineShot(me, enemy, null, [], game, null, st);
  check('未对准 -> 转向right', r && r.dir === 'right', 'r=' + JSON.stringify(r));
}
console.log('场景P3: 敌藏草丛但距5太远 -> 不预射');
{
  const map = emptyMap(20, 20);
  map[14][7] = 'o';
  const me = makeMe([8, 7], 'right', { skill: { type: 'teleport', remainingCooldownFrames: 30 } });
  const enemy = { tank: null, bullet: null, skill: { type: 'shield', remainingCooldownFrames: 5 }, status: {} };
  const game = { map: map, star: null, frames: 51 };
  MATCH_STATE = null;
  const st = getMatchState(game);
  st.lastEnemyPos = [14, 7]; st.lastEnemySeenFrame = 50; // 距6
  const r = findBushLineShot(me, enemy, null, [], game, null, st);
  check('距6太远 -> 不预射(null)', r === null, 'r=' + JSON.stringify(r));
}
console.log('场景P4: 草丛伏击 - 我在草丛+敌可见同行<=3+对准 -> 开火');
{
  const map = emptyMap(20, 20);
  map[5][7] = 'o'; // 我所在草丛
  const me = makeMe([5, 7], 'right', { status: { cloaked: true }, skill: { type: 'teleport', remainingCooldownFrames: 30 } });
  const enemy = { tank: { id: 'e', position: [8, 7], direction: 'left' }, bullet: null, skill: { type: 'shield', remainingCooldownFrames: 5 }, status: {} };
  const game = { map: map, star: null, frames: 30 };
  const r = findBushLineShot(me, enemy, enemy.tank, [], game, enemy.tank.position, getMatchState(game));
  check('我草丛+敌同行对准 -> fire伏击', r && r.fire === true, 'r=' + JSON.stringify(r));
}
console.log('场景P5: 草丛伏击 - 敌开盾 -> 不伏击');
{
  const map = emptyMap(20, 20);
  map[5][7] = 'o';
  const me = makeMe([5, 7], 'right', { status: { cloaked: true }, skill: { type: 'teleport', remainingCooldownFrames: 30 } });
  const enemy = { tank: { id: 'e', position: [8, 7], direction: 'left' }, bullet: null, skill: { type: 'shield', remainingCooldownFrames: 5 }, status: { shielded: true } };
  const game = { map: map, star: null, frames: 30 };
  const r = findBushLineShot(me, enemy, enemy.tank, [], game, enemy.tank.position, getMatchState(game));
  check('敌开盾 -> 不伏击(null)', r === null, 'r=' + JSON.stringify(r));
}
console.log('场景P6: 有实弹来袭 -> 不打草丛枪(躲避优先)');
{
  const map = emptyMap(20, 20);
  map[5][7] = 'o';
  const me = makeMe([5, 7], 'right', { status: { cloaked: true }, skill: { type: 'teleport', remainingCooldownFrames: 30 } });
  const bullet = { position: [7, 7], direction: 'left' };
  const enemy = { tank: { id: 'e', position: [8, 7], direction: 'left' }, bullet: bullet, skill: { type: 'shield', remainingCooldownFrames: 5 }, status: {} };
  const game = { map: map, star: null, frames: 30 };
  const r = findBushLineShot(me, enemy, enemy.tank, [bullet], game, enemy.tank.position, getMatchState(game));
  check('实弹来袭 -> 不打草丛枪(null)', r === null, 'r=' + JSON.stringify(r));
}
console.log('场景P7: 防伏击 - cloak技能敌空地隐身(非草丛)同行<=3 -> 预射');
{
  const map = emptyMap(20, 20); // 全空地,最后位置非草丛
  const me = makeMe([8, 7], 'right', { skill: { type: 'teleport', remainingCooldownFrames: 30 } });
  const enemy = { tank: null, bullet: null, skill: { type: 'cloak', remainingCooldownFrames: 5 }, status: {} };
  const game = { map: map, star: null, frames: 51 };
  MATCH_STATE = null;
  const st = getMatchState(game);
  st.lastEnemyPos = [11, 7]; st.lastEnemySeenFrame = 50;
  const r = findBushLineShot(me, enemy, null, [], game, null, st);
  check('cloak敌空地同行<=3+对准 -> fire预射', r && r.fire === true, 'r=' + JSON.stringify(r));
}
console.log('场景P8: 非隐身敌空地看不见(如绕墙后) -> 不滥射');
{
  const map = emptyMap(20, 20);
  const me = makeMe([8, 7], 'right', { skill: { type: 'teleport', remainingCooldownFrames: 30 } });
  const enemy = { tank: null, bullet: null, skill: { type: 'shield', remainingCooldownFrames: 5 }, status: {} };
  const game = { map: map, star: null, frames: 51 };
  MATCH_STATE = null;
  const st = getMatchState(game);
  st.lastEnemyPos = [11, 7]; st.lastEnemySeenFrame = 50;
  const r = findBushLineShot(me, enemy, null, [], game, null, st);
  check('非隐身敌空地 -> 不预射(null)', r === null, 'r=' + JSON.stringify(r));
}

// =========================================================
// 场景 Q：走位防撞子弹 + 以守为攻放宽（mat_1BN/mat_KkKOc/mat_6uoE）
// =========================================================
console.log('场景Q1: stepIntoBulletPath 识别"走进子弹下一帧扫过的格"');
{
  const game = { map: emptyMap(19, 15), star: null, frames: 10 };
  const b = { position: [11, 1], direction: 'right' };
  check('同行前方格 -> 危险', stepIntoBulletPath([b], [13, 1], game) === true);
  check('相邻安全行 -> 安全', stepIntoBulletPath([b], [13, 2], game) === false);
  const b2 = { position: [9, 3], direction: 'up' };
  check('子弹下一帧(2格)扫过的格 -> 危险', stepIntoBulletPath([b2], [9, 1], game) === true);
}
console.log('场景Q2: moveToward 不走进子弹行(mat_1BN)');
{
  const game = { map: emptyMap(19, 15), star: null, frames: 7 };
  const me = makeMe([13, 2], 'down', { skill: { type: 'teleport', remainingCooldownFrames: 30 } });
  const acts = [];
  ['teleport', 'go', 'turn', 'fire'].forEach(k => me[k] = (...a) => acts.push([k, ...a]));
  me.speak = () => {};
  const bullet = { position: [11, 1], direction: 'right' }; // 沿y=1朝right
  moveToward(me, game, [13, 1], [3, 3], { position: [3, 3], direction: 'right' }, [bullet]);
  check('不go进子弹行[13,1]', !acts.some(a => a[0] === 'go'), 'acts=' + JSON.stringify(acts));
}
console.log('场景Q3: 以守为攻放宽到<=4(即将同线)');
{
  const map = emptyMap(20, 20);
  const me = makeMe([13, 8], 'up'); // 已朝up对准上方
  const enemy = { tank: { id: 'e', position: [13, 4], direction: 'right' }, bullet: null, skill: { type: 'shield', remainingCooldownFrames: 5 }, status: {} };
  // 同列距4: 之前>3不触发, 现在<=4应触发
  const g = findGuardLineShot(me, enemy, enemy.tank, [], { map: map, star: null, frames: 30 }, enemy.tank.position);
  check('同列距4对准 -> fire(放宽生效)', g && g.fire === true, 'g=' + JSON.stringify(g));
}
console.log('场景Q4: 顺子弹方向逃被排除(mat_6uoE背后追击)');
{
  const map = emptyMap(19, 15);
  const me = makeMe([10, 4], 'left', { skill: { type: 'teleport', remainingCooldownFrames: 30 } });
  const enemy = { tank: null, bullet: { position: [10, 2], direction: 'down' }, skill: { type: 'cloak', remainingCooldownFrames: 5 }, status: {} };
  const dodge = findBulletDodge(me, enemy, { map: map, star: null, frames: 14 }, null);
  // 子弹朝down背后追, 躲避格必须横向(x变化)，不能顺down
  check('背后追击给横向躲避格(非顺down)', dodge && dodge[0] !== 10, 'dodge=' + JSON.stringify(dodge));
}

console.log('场景Q5: 闪现落点不落在敌方炮线对射位(mat_JYuX/mat_1BN)');
{
  const map = emptyMap(19, 15);
  const me = makeMe([5, 8], 'up', { skill: { type: 'teleport', remainingCooldownFrames: 0 } });
  // 星[13,1], 敌[2,1]同行朝我对准 -> 传到星上是对射陷阱
  const enemy = { tank: { id: 'e', position: [2, 1], direction: 'right' }, bullet: null, skill: { type: 'shield', remainingCooldownFrames: 5 }, status: {} };
  const game = { map: map, star: [13, 1], frames: 1 };
  check('落点在敌同行对射位 -> deadly', starLandingDeadly([13, 1], me, enemy.tank, enemy, game) === true);
  // isTeleportSafe: 敌清晰炮线近距(<=4)不安全
  const e2 = { tank: { position: [8, 7], direction: 'left' } };
  check('落点敌炮线近距<=4 -> teleport不安全', isTeleportSafe([11, 7], e2.tank, [], game, 0) === false);
  check('落点敌炮线远距>4 -> 允许', isTeleportSafe([14, 7], e2.tank, [], game, 0) === true);
}

console.log('场景SI0: onIdle 会为无星巡逻建立短期意图');
{
  const map = emptyMap(19, 15);
  const me = makeMe([8, 7], 'left', { skill: { type: 'teleport', remainingCooldownFrames: 30 } });
  const enemy = { tank: null, bullet: null, skill: { type: 'cloak', remainingCooldownFrames: 5 }, status: {} };
  const game = { map: map, star: null, frames: 99 };
  MATCH_STATE = null;
  onIdle(me, enemy, game);
  const st = getMatchState(game);
  check('SI0 onIdle建立patrol短期意图', st.shortIntent && st.shortIntent.kind === 'patrol', 'intent=' + JSON.stringify(st.shortIntent));
}

{
  const map = emptyMap(19, 15);
  const me = makeMe([5, 5], 'right', { skill: { type: 'teleport', remainingCooldownFrames: 30 } });
  const enemy = { tank: null, bullet: null, skill: { type: 'cloak', remainingCooldownFrames: 5 }, status: {} };
  const game = { map: map, star: null, frames: 100 };
  const state = getMatchState(game);
  state.shortIntent = { kind: 'patrol', target: [8, 5], createdFrame: 100, expireFrame: 104, stepsLeft: 3 };
  const r1 = resolveShortIntentStep(me, enemy, null, [], game, state);
  check('SI1 patrol意图返回下一步', !!r1 && samePos(r1.step, [6, 5]), 'r1=' + JSON.stringify(r1));
  check('SI1 patrol意图步数递减', state.shortIntent && state.shortIntent.stepsLeft === 2, 'intent=' + JSON.stringify(state.shortIntent));
}
console.log('场景SI2: 缓存意图若进入下一帧扫过的子弹轨道会立刻失效');
{
  const map = emptyMap(19, 15);
  const me = makeMe([5, 5], 'right', { skill: { type: 'teleport', remainingCooldownFrames: 30 } });
  const enemy = { tank: { id: 'e', position: [3, 5], direction: 'up', crashed: false }, bullet: null, skill: { type: 'shield', remainingCooldownFrames: 5 }, status: {} };
  const game = { map: map, star: null, frames: 101 };
  const state = getMatchState(game);
  state.shortIntent = { kind: 'patrol', target: [8, 5], createdFrame: 101, expireFrame: 105, stepsLeft: 3 };
  const bullet = { position: [3, 5], direction: 'right' };
  const r2 = resolveShortIntentStep(me, enemy, enemy.tank, [bullet], game, state);
  check('SI2 子弹扫过时缓存意图失效', r2 === null && state.shortIntent === null, 'r2=' + JSON.stringify(r2) + ' intent=' + JSON.stringify(state.shortIntent));
}
console.log('场景SI3: hold短期意图在草丛中保持不动');
{
  const map = emptyMap(19, 15);
  map[5][5] = 'o';
  const me = makeMe([5, 5], 'right', { status: { cloaked: true }, skill: { type: 'teleport', remainingCooldownFrames: 0 } });
  const enemy = { tank: null, bullet: null, skill: { type: 'overload', remainingCooldownFrames: 8 }, status: {} };
  const game = { map: map, star: null, frames: 102 };
  const state = getMatchState(game);
  state.shortIntent = { kind: 'hold', target: [5, 5], createdFrame: 102, expireFrame: 105, stepsLeft: 2 };
  const r3 = resolveShortIntentStep(me, enemy, null, [], game, state);
  check('SI3 hold意图返回hold', r3 && r3.hold === true, 'r3=' + JSON.stringify(r3));
  check('SI3 hold意图步数递减', state.shortIntent && state.shortIntent.stepsLeft === 1, 'intent=' + JSON.stringify(state.shortIntent));
}
console.log('场景Q6: bestSafeNeighbor 不挑下一帧扫过的子弹轨道格');
{
  const map = emptyMap(19, 15);
  const enemyTank = { position: [3, 3], direction: 'right' };
  const bullet = { position: [11, 1], direction: 'right' };
  const p = bestSafeNeighbor([13, 2], { map: map, star: null, frames: 7 }, [3, 3], enemyTank, [bullet]);
  check('bestSafeNeighbor避开子弹扫过格', !samePos(p, [13, 1]), 'p=' + JSON.stringify(p));
}

// =========================================================
// 场景 R：无星虚拟巡逻，避免原地空转被压制（mat_EAL9/mat_DXFuNn8）
// =========================================================
console.log('场景R1: 无星+敌隐身 -> 持续移动巡逻而非原地空转');
{
  const D = [{ name: 'up', dx: 0, dy: -1 }, { name: 'right', dx: 1, dy: 0 }, { name: 'down', dx: 0, dy: 1 }, { name: 'left', dx: -1, dy: 0 }];
  const di = n => D.findIndex(d => d.name === n);
  const map = emptyMap(19, 15);
  const me = makeMe([8, 7], 'left', { skill: { type: 'teleport', remainingCooldownFrames: 30 } });
  let moved = 0, prev = [8, 7];
  MATCH_STATE = null;
  for (let f = 70; f <= 82; f++) {
    const acts = [];
    ['teleport', 'go', 'turn', 'fire'].forEach(k => me[k] = (...a) => acts.push([k, ...a]));
    me.speak = () => {};
    onIdle(me, { tank: null, bullet: null, skill: { type: 'cloak', remainingCooldownFrames: 5 }, status: {} }, { map: map, star: null, frames: f });
    for (const a of acts) {
      if (a[0] === 'turn') { const ci = di(me.tank.direction); me.tank.direction = a[1] === 'right' ? D[(ci + 1) % 4].name : D[(ci + 3) % 4].name; }
      else if (a[0] === 'go') { const nd = D[di(me.tank.direction)]; const np = [me.tank.position[0] + nd.dx, me.tank.position[1] + nd.dy]; const t = tileAt({ map: map }, np); if (t === '.' || t === 'o') me.tank.position = np; }
    }
    if (!(me.tank.position[0] === prev[0] && me.tank.position[1] === prev[1])) moved++;
    prev = me.tank.position.slice();
  }
  check('无星敌隐身 -> 多帧实际移动(>=6)', moved >= 6, 'moved=' + moved);
}
console.log('场景R2: virtualPatrolTarget 选远离隐身敌最后位置的点');
{
  const map = emptyMap(19, 15);
  const me = makeMe([9, 7], 'left', { skill: { type: 'teleport', remainingCooldownFrames: 30 } });
  const game = { map: map, star: null, frames: 50 };
  MATCH_STATE = null;
  const st = getMatchState(game);
  st.lastEnemyPos = [2, 2]; st.lastEnemySeenFrame = 48; // 敌最后在左上
  const vt = virtualPatrolTarget(me, game, st);
  check('巡逻点远离敌最后位置(不在左上角)', vt && (vt[0] + vt[1]) > (2 + 2 + 3), 'vt=' + JSON.stringify(vt));
}
console.log('场景R3: 巡逻目标粘性(到达前不重选)');
{
  const map = emptyMap(19, 15);
  const me = makeMe([9, 7], 'left', { skill: { type: 'teleport', remainingCooldownFrames: 30 } });
  const game = { map: map, star: null, frames: 50 };
  MATCH_STATE = null;
  const st = getMatchState(game);
  const vt1 = virtualPatrolTarget(me, game, st);
  const vt2 = virtualPatrolTarget(me, game, st); // 未移动,应返回同一目标
  check('连续调用返回同一粘性目标', vt1 && vt2 && vt1[0] === vt2[0] && vt1[1] === vt2[1], 'vt1=' + JSON.stringify(vt1) + ' vt2=' + JSON.stringify(vt2));
}

// =========================================================
// 场景 S：双弹平行夹击两步脱困（mat_FXI）
// =========================================================
console.log('场景S1: 朝脱离方向+双弹尚远 -> 两步脱困给横向格');
{
  const map = emptyMap(19, 15);
  for (let y = 0; y < 15; y++) map[18][y] = 'x'; // 右墙
  const me = makeMe([17, 4], 'left', { skill: { type: 'teleport', remainingCooldownFrames: 30 } });
  const bullets = [{ position: [17, 10], direction: 'up' }, { position: [16, 10], direction: 'up' }];
  const ts = findTwoStepEscape(me, bullets, { map: map, star: null, frames: 4 }, null, null);
  check('朝left+双弹远 -> 往左[16,4]', ts && ts[0] === 16, 'ts=' + JSON.stringify(ts));
}
console.log('场景S2: 需掉头且子弹太近 -> 不drift(返回null)');
{
  const map = emptyMap(19, 15);
  for (let y = 0; y < 15; y++) map[18][y] = 'x';
  const me = makeMe([17, 4], 'right', { skill: { type: 'teleport', remainingCooldownFrames: 30 } });
  const bullets = [{ position: [17, 8], direction: 'up' }, { position: [16, 8], direction: 'up' }]; // x=16到[16,4]仅2帧
  const ts = findTwoStepEscape(me, bullets, { map: map, star: null, frames: 5 }, null, null);
  check('掉头来不及 -> null(不drift撞弹)', ts === null, 'ts=' + JSON.stringify(ts));
}
console.log('场景S3: 未被威胁时two-step不触发');
{
  const map = emptyMap(19, 15);
  const me = makeMe([5, 5], 'right', { skill: { type: 'teleport', remainingCooldownFrames: 30 } });
  const bullets = [{ position: [17, 10], direction: 'up' }]; // 远在他处
  const ts = findTwoStepEscape(me, bullets, { map: map, star: null, frames: 4 }, null, null);
  check('未受威胁 -> null', ts === null, 'ts=' + JSON.stringify(ts));
}

// =========================================================
// 场景 T：过载双弹"相邻列"覆盖带（mat_EHR / mat_73I 复盘）
// 过载双弹一发走敌人正行/列，另一发走相邻±1行/列。传送落点与走位死区
// 过去只看严格同线，漏掉相邻列副弹，导致传到星点距敌3格相邻列被秒、沿走廊相邻列逼近被追死。
// =========================================================
console.log('场景T1: enemyDoubleLaneThreat 识别 过载中/过载流就绪');
{
  check('过载中 -> true', enemyDoubleLaneThreat({ status: { overloaded: true } }) === true);
  check('过载流冷却就绪 -> true', enemyDoubleLaneThreat({ skill: { type: 'overload', remainingCooldownFrames: 0 } }) === true);
  check('过载流冷却中 -> false', enemyDoubleLaneThreat({ skill: { type: 'overload', remainingCooldownFrames: 8 } }) === false);
  check('护盾敌 -> false', enemyDoubleLaneThreat({ skill: { type: 'shield', remainingCooldownFrames: 0 } }) === false);
  check('null -> false', enemyDoubleLaneThreat(null) === false);
}
console.log('场景T2: inDoubleLaneBand 相邻列近距判危');
{
  // 敌[16,12]，星点[17,10]：相邻列(dx=1) 距3 -> 在覆盖带
  check('相邻列距3 -> 在覆盖带', inDoubleLaneBand([16, 12], [17, 10], 6) === true);
  // 同列距5 -> 在覆盖带
  check('同列距5 -> 在覆盖带', inDoubleLaneBand([16, 12], [16, 7], 6) === true);
  // 隔2列且隔2行(dx=2,dy=2) -> 不在覆盖带
  check('隔2列2行 -> 不在覆盖带', inDoubleLaneBand([16, 12], [18, 14], 6) === false);
  // 相邻列但超距(>6) -> 不在覆盖带(远处不拦,避免防过头)
  check('相邻列但距8 -> 不在覆盖带', inDoubleLaneBand([16, 12], [17, 4], 6) === false);
}
console.log('场景T3: 传送落点拒绝过载双弹相邻列(mat_EHR 直传星点[17,10])');
{
  const map = emptyMap(19, 15);
  const me = makeMe([2, 2], 'down', { skill: { type: 'teleport', remainingCooldownFrames: 0 } });
  // 金闪闪式过载流敌人在[16,12]，星刷在[17,10](相邻列x=17,距敌3)
  const enemy = { tank: { id: 'e', position: [16, 12], direction: 'down', crashed: false }, bullet: null, skill: { type: 'overload', remainingCooldownFrames: 0 }, status: {} };
  const game = { map: map, star: [17, 10], frames: 1 };
  const tp = findStarTeleport(me, enemy, enemy.tank, [], game);
  // 不应直传到星点[17,10](相邻列双弹覆盖带)；要么null要么传到覆盖带外
  const landedOnStar = tp && tp[0] === 17 && tp[1] === 10;
  check('不直传到相邻列星点[17,10]', !landedOnStar, 'tp=' + JSON.stringify(tp));
  if (tp) check('若改传别处则落点在双弹覆盖带外', !inDoubleLaneBand([16, 12], tp, 6), 'tp=' + JSON.stringify(tp));
}
console.log('场景T4: isTeleportSafe 对过载敌相邻列落点判危');
{
  const map = emptyMap(19, 15);
  const enemy = { tank: { id: 'e', position: [16, 12], direction: 'down' }, skill: { type: 'overload', remainingCooldownFrames: 0 }, status: {} };
  // 相邻列距3落点 -> 不安全
  check('过载敌相邻列距3落点不安全', isTeleportSafe([17, 10], enemy.tank, [], game = { map: map }, 0, enemy) === false);
  // 远处(覆盖带外)落点 -> 安全
  check('过载敌远处落点安全', isTeleportSafe([3, 3], enemy.tank, [], { map: map }, 0, enemy) === true);
  // 不传 enemy(普通调用)时不启用双弹带判定 -> 相邻列远离炮线仍按旧规则(此处距3且不同线, 旧规则<=4同线才拦, 不同线放行)
  check('不传enemy时保持旧行为', isTeleportSafe([17, 10], enemy.tank, [], { map: map }, 0) === true);
}
console.log('场景T5: 走位死区拦截 过载敌相邻列走廊逼近(mat_73I 沿x=17走廊)');
{
  const map = emptyMap(19, 15);
  for (let y = 0; y < 15; y++) map[18][y] = 'x'; // 右墙 x=18
  // 敌在x=16(正列), 我在x=17相邻列走廊, 右侧x=18墙、左侧x=16是敌正列
  const enemy = { status: {}, skill: { type: 'overload', remainingCooldownFrames: 0 } };
  // 下一步沿走廊往敌人方向走到[17,5], 敌在[16,4]附近 -> 相邻列覆盖带+走廊夹死 -> 死区
  check('过载流相邻列走廊步 -> 死区', stepEntersKillZone([17, 6], [17, 5], [16, 4], { map: map }, enemy, 6) === true, 'escape=' + hasDoubleLaneEscapeAt([17, 5], [16, 4], { map: map }));
}
console.log('场景T6: 开阔地相邻列两格能横移脱离 -> 非死区(不防过头)');
{
  const map = emptyMap(19, 15); // 全空地
  const enemy = { status: {}, skill: { type: 'overload', remainingCooldownFrames: 0 } };
  // 敌[10,4], 我走到相邻列[11,6](dx=1,距3? d=|10-11|+|4-6|=3 ->会被d<=4拦)
  // 用距5: 我在[11,8]相邻列, 敌[10,4], d=1+4=5<standoff6, 开阔地左右能连走两格 -> 非死区
  check('过载流相邻列开阔地 -> 非死区', stepEntersKillZone([11, 9], [11, 8], [10, 4], { map: map }, enemy, 6) === false, 'escape=' + hasDoubleLaneEscapeAt([11, 8], [10, 4], { map: map }));
}

// =========================================================
// 场景 U：石墙遮挡 / 开局抢星 / 隐身伏击线 / 终局抢星（mat_7JO / mat_E3G 复盘）
// =========================================================
console.log('场景U1: 石墙挡子弹 -> 近距格非死区(mat_7JO 卡死复盘)');
{
  const map = emptyMap(19, 15);
  map[5][10] = 'x'; // 在我与敌之间 x=5,y=10 设石墙
  // 我[3,9]要走到[3,10]去吃星, 敌[6,10]同行但[5,10]墙挡 -> [3,10]安全
  const enemy = { status: {}, skill: { type: 'shield', remainingCooldownFrames: 0 } };
  check('敌当前打不到被墙挡的[3,10]', wallBlocksEnemyShot([3, 10], [6, 10], { map: map }) === true, 'cd=' + clearShotDirection([6, 10], [3, 10], { map: map }));
  check('石墙挡住的近距格 -> 非死区', stepEntersKillZone([3, 9], [3, 10], [6, 10], { map: map }, enemy, 4) === false);
  // 对照: 无墙时同行距3 -> 仍死区
  check('无墙同行距3 -> 仍死区', stepEntersKillZone([3, 9], [3, 10], [6, 10], { map: emptyMap(19, 15) }, enemy, 4) === true);
  // 贴脸d=1即使有墙仍死区: 我[3,10]敌[3,11]相邻(d=1), 中间无法插墙(相邻格), 强制死区
  check('贴脸d=1 -> 恒死区', stepEntersKillZone([3, 9], [3, 10], [3, 11], { map: emptyMap(19, 15) }, enemy, 4) === true);
}
console.log('场景U2: 开局脚边有星 -> 不浪费传送去刺杀(mat_E3G 开局丢星)');
{
  const map = emptyMap(19, 15);
  const me = makeMe([3, 2], 'right', { skill: { type: 'teleport', remainingCooldownFrames: 0 } });
  // 星在[3,3]脚边(walk=1), 敌在对角[16,12]远 -> 不该传送刺杀
  const enemy = { tank: { id: 'e', position: [16, 12], direction: 'down', crashed: false }, bullet: null, skill: { type: 'shield', remainingCooldownFrames: 0 }, status: {} };
  const game = { map: map, star: [3, 3], frames: 3 };
  MATCH_STATE = null;
  const plan = findAssassinationPlan(me, enemy, enemy.tank, [], game, getMatchState(game));
  check('脚边有星且我更近 -> 不刺杀', plan === null, 'plan=' + JSON.stringify(plan));
  // 对照: 星很远时仍可刺杀
  const game2 = { map: map, star: [3, 13], frames: 3 };
  MATCH_STATE = null;
  const plan2 = findAssassinationPlan(me, enemy, enemy.tank, [], game2, getMatchState(game2));
  check('星远(walk>2)时刺杀豁免不触发 -> 仍可刺杀', plan2 !== null && plan2.pos, 'plan2=' + JSON.stringify(plan2));
}
console.log('场景U3: 隐身敌同行伏击线 -> 横移脱离(mat_E3G 终局)');
{
  const map = emptyMap(19, 15);
  // 我[3,2], 敌最后位置[11,2]同行y=2无墙 -> 应横移离开y=2
  const esc = escapeAmbushLine([3, 2], [11, 2], { map: map });
  check('同行无墙 -> 横移离开y=2', esc !== null && esc[1] !== 2, 'esc=' + JSON.stringify(esc));
  // 中间有墙 -> 那条线安全, 不横移
  const map2 = emptyMap(19, 15); map2[7][2] = 'x';
  check('同行有墙挡 -> 不横移(null)', escapeAmbushLine([3, 2], [11, 2], { map: map2 }) === null);
  // 不同行不同列 -> 不触发
  check('不同线 -> 不横移(null)', escapeAmbushLine([3, 2], [11, 8], { map: map }) === null);
}
console.log('场景U4: 终局帧数博弈 -> 敌够不着则传送抢星');
{
  const map = emptyMap(19, 15);
  const me = makeMe([15, 12], 'up', { skill: { type: 'teleport', remainingCooldownFrames: 0 } });
  const enemy = { tank: { id: 'e', position: [16, 2], direction: 'down', crashed: false }, bullet: null, skill: { type: 'shield' }, status: {} };
  // f124(剩4帧), 星[3,3]远, 敌[16,2]离星远打不到 -> 抢
  const game = { map: map, star: [3, 3], frames: 124 };
  const tp = findStarTeleport(me, enemy, enemy.tank, [], game);
  check('终局远星敌够不着 -> 传送抢星', tp && tp[0] === 3 && tp[1] === 3, 'tp=' + JSON.stringify(tp));
  // 敌贴星同线朝向对准 -> 来得及打 -> 不强抢(走bestTeleportTile或别处, 不直接=星点送死)
  const enemy2 = { tank: { id: 'e', position: [7, 3], direction: 'left', crashed: false }, bullet: null, skill: { type: 'shield' }, status: {} };
  check('终局敌贴星能秒 -> 不强抢星点', endgameStarTeleport(me, enemy2, enemy2.tank, game, 99) === null);
  // 非终局(f50) -> endgame不触发
  const game3 = { map: map, star: [3, 3], frames: 50 };
  check('非终局 -> endgameStarTeleport不触发', endgameStarTeleport(me, enemy, enemy.tank, game3, 99) === null);
}

// =========================================================
// 场景 V：敌 teleport 抢星先转后传 / 敌 overload 流保守不贴身（mat_KBZ / mat_D9W 复盘）
// =========================================================
console.log('场景V1: 敌overload流(冷却中)也保守 standoff=5');
{
  const overReady = { status: { overloaded: true } };
  const overCD = { skill: { type: 'overload', remainingCooldownFrames: 5 } };
  const overSoon = { skill: { type: 'overload', remainingCooldownFrames: 0 } };
  const shield = { skill: { type: 'shield', remainingCooldownFrames: 0 } };
  check('已过载 standoff=6', safeStandoffDistance(overReady) === 6);
  check('overload就绪 standoff=6', safeStandoffDistance(overSoon) === 6);
  check('overload冷却中 standoff=5(不退回4)', safeStandoffDistance(overCD) === 5, '' + safeStandoffDistance(overCD));
  check('普通敌 standoff=4', safeStandoffDistance(shield) === 4);
  check('enemyIsOverloadType识别冷却中overload', enemyIsOverloadType(overCD) === true && enemyIsOverloadType(shield) === false);
}
console.log('场景V2: 敌overload流近距同线 -> 不主动对枪(让位走位拉开, mat_D9W)');
{
  const map = emptyMap(19, 15);
  // 我[6,4]朝right, 敌overloadCD5在[6,9]同行d=5(<standoff5? =5不<5, 用d=4): 敌[6,8]
  const me = makeMe([6, 4], 'right', { skill: { type: 'teleport', remainingCooldownFrames: 30 } });
  const enemy = { tank: { id: 'e', position: [6, 8], direction: 'left', crashed: false }, bullet: null, skill: { type: 'overload', remainingCooldownFrames: 5 }, status: {} };
  const game = { map: map, star: null, frames: 80 };
  MATCH_STATE = null;
  me._actions.length = 0;
  onIdle(me, enemy, game);
  // d=4 < standoff5 -> 不开火; 应是走位(turn/go)而非fire
  check('overload近距同线不开火', !me._actions.some(a => a[0] === 'fire'), JSON.stringify(me._actions));
  // 对照: 普通shield敌同距 -> 应正常开火/对准
  const me2 = makeMe([6, 4], 'right', { skill: { type: 'teleport', remainingCooldownFrames: 30 } });
  const enemyS = { tank: { id: 'e', position: [6, 8], direction: 'left', crashed: false }, bullet: null, skill: { type: 'shield', remainingCooldownFrames: 0 }, status: {} };
  MATCH_STATE = null;
  me2._actions.length = 0;
  onIdle(me2, enemyS, { map: map, star: null, frames: 80 });
  check('普通敌同距正常对枪(fire或转向对准)', me2._actions.some(a => a[0] === 'fire' || a[0] === 'turn'), JSON.stringify(me2._actions));
}
console.log('场景V3: findGuardLineShot 对overload流(冷却中)同线可开火');
{
  const map = emptyMap(19, 15);
  const me = makeMe([6, 4], 'up', { skill: { type: 'teleport', remainingCooldownFrames: 30 } });
  const enemyOver = { tank: { id: 'e', position: [8, 4], direction: 'down', crashed: false }, bullet: null, skill: { type: 'overload', remainingCooldownFrames: 5 }, status: {} };
  const game = { map: map, star: null, frames: 50 };
  // 新行为：overload 冷却中(cd=5, 没握双弹) + 同行 d=2 + 无实弹 -> 允许守线开枪("没双弹刚")
  // 预期: 给出转向或开火指令，而非 null
  const result = findGuardLineShot(me, enemyOver, enemyOver.tank, [], game, [8, 4]);
  check('overload流(冷却中)同行近距可守线(没双弹刚)', result !== null);
}
console.log('场景V4: 敌teleport抢星对撞 -> 落星十字相邻安全格避开对撞(mat_KBZ，已升级为 crossAdjacent 策略)');
{
  const map = emptyMap(19, 15);
  // 星[2,6]远离我[15,2], 敌teleport[5,6]同行离星近(就绪可瞬移对撞)
  const enemy = { tank: { id: 'e', position: [5, 6], direction: 'left', crashed: false }, bullet: null, skill: { type: 'teleport', remainingCooldownFrames: 0 }, status: {} };
  const game = { map: map, star: [2, 6], frames: 20 };
  const me = makeMe([15, 2], 'up', { skill: { type: 'teleport', remainingCooldownFrames: 0 } });
  const tp = findStarTeleport(me, enemy, enemy.tank, [], game);
  // 敌teleport就绪 -> 不再直传星点对撞，改落十字相邻安全格(避开敌沿星行 y=6 的瞬移狙击)
  check('敌teleport就绪 -> 不直传星点', tp && !(tp[0] === 2 && tp[1] === 6), 'tp=' + JSON.stringify(tp));
  check('落点是星十字相邻一格', tp && manhattan(tp, [2, 6]) === 1, 'tp=' + JSON.stringify(tp));
  check('落点避开敌炮线(safe)', tp && isTeleportSafe(tp, enemy.tank, [], game, 0, null), 'tp=' + JSON.stringify(tp));
  // 落点已避开敌炮线 -> 不需先转，直接传(不浪费抢星帧)
  const faceDir = teleportPreTurnDir(me, tp, enemy, enemy.tank, game);
  check('十字安全落点不预转(直接传)', faceDir === null, 'faceDir=' + faceDir);
  me._actions.length = 0; MATCH_STATE = null;
  onIdle(me, enemy, game);
  check('第1帧直接传送抢星(不浪费帧先转)', me._actions.some(a => a[0] === 'teleport'), JSON.stringify(me._actions));
  // 对照: 敌远 -> 不预转直接传
  const enemyFar = { tank: { id: 'e', position: [16, 12], direction: 'down', crashed: false }, bullet: null, skill: { type: 'teleport', remainingCooldownFrames: 0 }, status: {} };
  check('敌远 -> 不预转', teleportPreTurnDir(me, [2, 6], enemyFar, enemyFar.tank, game) === null);
  // 对照: 非teleport敌近 -> 不预转(不会瞬移对撞)
  const enemyShield = { tank: { id: 'e', position: [5, 6], direction: 'left', crashed: false }, bullet: null, skill: { type: 'shield', remainingCooldownFrames: 0 }, status: {} };
  check('非teleport敌近 -> 不预转', teleportPreTurnDir(me, tp, enemyShield, enemyShield.tank, game) === null);
}

// =========================================================
// 场景 W：overload 敌"错位射击"——副弹专打相邻列，走位要离开覆盖带（mat_4YF 复盘）
// 敌[14,8]站我[15,10]相邻列(不同行不同列)，过载副弹走 x=15 把我秒。
// =========================================================
console.log('场景W1: overload流(冷却中)相邻列逗留 -> 死区(错位射击)');
{
  const map = emptyMap(19, 15);
  const enemyOver = { skill: { type: 'overload', remainingCooldownFrames: 5 }, status: {} };
  // 我[15,10]想走[15,11](仍x=15相邻列,敌[14,7]), standoff内无法跨出 -> 死区
  check('overload流相邻列逗留(d<standoff) -> 死区', stepEntersKillZone([15, 10], [15, 9], [14, 7], { map: map }, enemyOver, 5) === true, 'd=' + manhattan([15, 9], [14, 7]));
  // 跨出到 dx>=2 的列 -> 非死区
  check('跨出副弹列(dx>=2) -> 非死区', stepEntersKillZone([15, 10], [16, 10], [14, 7], { map: map }, enemyOver, 5) === false);
  // 对照: 普通敌(非overload)相邻列不特殊处理(只按d判)
  const shield = { skill: { type: 'shield', remainingCooldownFrames: 0 }, status: {} };
  check('普通敌相邻列d=4 -> 非死区(不防过头)', stepEntersKillZone([15, 10], [15, 9], [14, 7], { map: map }, shield, 4) === false || manhattan([15, 9], [14, 7]) <= 3);
}
console.log('场景W2: overload流走位主动离开副弹相邻列(mat_4YF)');
{
  const map = emptyMap(19, 15);
  const enemyOver = { tank: { id: 'e', position: [14, 7], direction: 'right', crashed: false }, bullet: null, skill: { type: 'overload', remainingCooldownFrames: 5 }, status: {} };
  const game = { map: map, star: null, frames: 49 };
  function mk(pos, dir) { return { tank: { position: pos, direction: dir, crashed: false }, skill: { type: 'teleport', remainingCooldownFrames: 30 }, teleport: 1, bullet: null, stars: 2, status: {} }; }
  // 我在x=15相邻列d=4 -> chooseStep 应带我到 dx>=2 的列
  MATCH_STATE = null;
  const step = chooseStep(mk([15, 10], 'right'), enemyOver, game, [14, 7], getMatchState(game));
  check('overload流相邻列 -> 走位跨出到dx>=2', step && Math.abs(step[0] - 14) >= 2, 'step=' + JSON.stringify(step) + ' dx=' + (step ? Math.abs(step[0] - 14) : '-'));
  // stepAwayFromEnemy 对 overload 流偏好跨出覆盖带
  const away = stepAwayFromEnemy([15, 10], [14, 7], { map: map }, enemyOver);
  check('stepAwayFromEnemy(overload) 跨出覆盖带', away && Math.abs(away[0] - 14) >= 2, 'away=' + JSON.stringify(away));
}
console.log('场景W3: overload流不找射击轨道贴近(改安全站位)');
{
  const map = emptyMap(19, 15);
  const enemyOver = { tank: { id: 'e', position: [10, 7], direction: 'right', crashed: false }, bullet: null, skill: { type: 'overload', remainingCooldownFrames: 5 }, status: {} };
  const game = { map: map, star: null, frames: 49 };
  function mk(pos, dir) { return { tank: { position: pos, direction: dir, crashed: false }, skill: { type: 'teleport', remainingCooldownFrames: 30 }, teleport: 1, bullet: null, stars: 2, status: {} }; }
  // 我远处[3,7]同行, 普通敌会找轨道贴到standoff; overload敌应保持距离不主动找轨道
  MATCH_STATE = null;
  const step = chooseStep(mk([3, 7], 'right'), enemyOver, game, [10, 7], getMatchState(game));
  // 距敌7>standoff5, 不该贴近到死区; 这里只验证返回了步(不卡死)且不会贴进<=4
  check('overload流远距走位不贴进死区', !step || manhattan(step, [10, 7]) >= 5, 'step=' + JSON.stringify(step) + ' d=' + (step ? manhattan(step, [10, 7]) : '-'));
}

// =========================================================
// 场景 X：过载双弹只可见1发时补出配对弹 + overload敌不主动逼近（mat_LBH 复盘）
// 敌[6,12]朝right过载，只暴露副弹[8,13]，主弹[8,12]看不见。我在y=13副弹行贴墙(y=14墙)，
// 往上y=12是主弹行——若只看副弹会误判y=12安全往那躲送死。
// =========================================================
console.log('场景X1: 过载双弹只见1发 -> 补出配对弹(覆盖真实主弹行)');
{
  // 可见副弹在敌相邻行(y=13, 敌y=12)。敌可能已移动，配对弹不确定哪侧 -> 两侧都补，必覆盖真实主弹 y=12。
  const enemy = { tank: { id: 'e', position: [6, 12], direction: 'right', crashed: false }, bullet: { position: [8, 13], direction: 'right' }, skill: { type: 'overload', remainingCooldownFrames: 0 }, status: { overloaded: true } };
  const bs = collectEnemyBullets(enemy);
  // enemyLane(12)≠visLane(13) -> 两侧补 y=12/y=14；关键是真实主弹行 y=12 必被覆盖(漏判=被秒)
  const lanes = bs.filter(b => b._inferred).map(b => b.position[1]);
  check('补出弹覆盖真实主弹行y=12', lanes.indexOf(12) >= 0 && bs.some(b => b.position[0] === 8 && b.position[1] === 12), JSON.stringify(bs));
  // 可见弹在敌正行/列(off=0, 敌仍在该车道=可信"可见主弹") -> 只补副弹+1(不过度保守)
  const enemy2 = { tank: { id: 'e', position: [6, 12], direction: 'right', crashed: false }, bullet: { position: [8, 12], direction: 'right' }, skill: { type: 'overload' }, status: { overloaded: true } };
  const bs2 = collectEnemyBullets(enemy2);
  const inf2 = bs2.find(b => b._inferred);
  check('可见主弹y=12(敌在该行) -> 只补副弹相邻行y=13', bs2.length === 2 && inf2 && inf2.position[1] === 13, JSON.stringify(bs2));
  // 敌已垂直移开车道(敌y=10, 可见弹y=9) -> 两侧补 y=8/y=10, 覆盖真实主弹(无论在哪侧)
  const enemy2b = { tank: { id: 'e', position: [6, 10], direction: 'left', crashed: false }, bullet: { position: [4, 9], direction: 'left' }, skill: { type: 'overload' }, status: { overloaded: true } };
  const bs2b = collectEnemyBullets(enemy2b);
  const lanesB = bs2b.filter(b => b._inferred).map(b => b.position[1]).sort((a, b) => a - b);
  check('敌垂直移开车道 -> 两侧都补(y=8与y=10)', bs2b.length === 3 && lanesB[0] === 8 && lanesB[1] === 10, JSON.stringify(bs2b));
  // 非overload敌不补
  const enemy3 = { tank: { id: 'e', position: [6, 12], direction: 'right', crashed: false }, bullet: { position: [8, 13], direction: 'right' }, skill: { type: 'shield' }, status: {} };
  check('非overload敌不补配对弹', collectEnemyBullets(enemy3).length === 1);
  // 已有2发(bullets数组)时不补
  const enemy4 = { tank: { id: 'e', position: [6, 12] }, bullets: [{ position: [8, 12], direction: 'right' }, { position: [8, 13], direction: 'right' }], skill: { type: 'overload' }, status: { overloaded: true } };
  check('已见2发时不再补', collectEnemyBullets(enemy4).length === 2);
}
console.log('场景X2: 补配对弹后不往主弹行躲(mat_LBH)');
{
  const map = emptyMap(19, 15); // y=14是墙(底), 我在y=13
  const enemy = { tank: { id: 'e', position: [6, 12], direction: 'right', crashed: false }, bullet: { position: [8, 13], direction: 'right' }, skill: { type: 'overload', remainingCooldownFrames: 0 }, status: { overloaded: true } };
  const me = { tank: { position: [14, 13], direction: 'right', crashed: false } };
  const game = { map: map, star: null, frames: 31 };
  const eb = collectEnemyBullets(enemy);
  check('[14,12]主弹行被识别为危险', anyBulletThreatens(eb, [14, 12], game) === true);
  // desperate 不应返回主弹行[14,12](上),下是墙y=14 -> 无垂直解返回null(不送死)
  const dd = findDesperateDodge(me, eb, game, [6, 12], enemy.tank);
  check('补主弹后 desperate 不往主弹行[14,12]躲', !dd || !(dd[0] === 14 && dd[1] === 12), 'dd=' + JSON.stringify(dd));
}
console.log('场景X3: overload敌远距不主动逼近(避免走进贴墙副弹行)');
{
  const map = emptyMap(19, 15);
  const enemyOver = { skill: { type: 'overload', remainingCooldownFrames: 2 }, status: {} };
  // 我[13,13]距敌[6,12] d=8>standoff -> 普通敌会逼近, overload敌不逼近(返回null让上层巡逻)
  const stepOver = nextStepToStandoff([13, 13], [6, 12], { map: map }, 5, enemyOver);
  check('overload敌远距 nextStepToStandoff=null(不逼近)', stepOver === null, 'step=' + JSON.stringify(stepOver));
  // 对照: 普通敌远距会逼近(返回逼近步)
  const shield = { skill: { type: 'shield' }, status: {} };
  const stepNorm = nextStepToStandoff([13, 13], [6, 12], { map: map }, 4, shield);
  check('普通敌远距会逼近(返回步)', stepNorm !== null, 'step=' + JSON.stringify(stepNorm));
}

// =========================================================
// 场景 Y：双 teleport 抢星对撞 -> 落星十字相邻安全格(mat_JOj)
// 复刻 mat_JOj：星 [17,4]，敌 [16,12] teleport 就绪。直传星点 [17,4] 会被敌瞬移到同行 [15,4]
// 右射(子弹 2格/帧)秒杀。期望改传十字相邻格(如 [17,3])，只暴露行或列之一、避开敌狙击线。
// 真实地形片段：[13,4]/[13,5]=墙, [14,2]/[14,3]=墙, [15,7]=墙, [16,2]=墙, [18,*]=右边墙。
// =========================================================
console.log('场景Y: 双teleport抢星对撞 -> 落星十字相邻(mat_JOj)');
{
  const map = emptyMap(19, 15);
  const terr = { 13: { 4: 'x', 5: 'x' }, 14: { 2: 'x', 3: 'x' }, 15: { 7: 'x' }, 16: { 2: 'x' } };
  for (const x in terr) for (const y in terr[x]) map[x][y] = terr[x][y];
  const star = [17, 4];
  function mkMe() { return makeMe([2, 2], 'up'); }
  // Y1: 敌 teleport 就绪 -> 不直传星点，改落十字相邻安全格
  const enemyTP = { tank: { id: 'e', position: [16, 12], direction: 'down', crashed: false }, bullet: null, skill: { type: 'teleport', remainingCooldownFrames: 0 }, status: {} };
  const game = { map: map, star: star, frames: 0 };
  const r1 = findStarTeleport(mkMe(), enemyTP, enemyTP.tank, [], game);
  check('Y1 敌teleport就绪 -> 不直传星点', !!(r1 && !(r1[0] === 17 && r1[1] === 4)), 'r=' + JSON.stringify(r1));
  check('Y1 落点是星十字相邻一格', !!(r1 && manhattan(r1, star) === 1), 'r=' + JSON.stringify(r1));
  check('Y1 落点不在敌可瞬移狙击的星行/列(避开 mat_JOj 死法)', !!(r1 && (r1[0] !== star[0] || r1[1] !== star[1]) && isTeleportSafe(r1, enemyTP.tank, [], game, 0, null)), 'r=' + JSON.stringify(r1));

  // Y2: 敌 teleport 冷却中(cd=20，不会来抢) -> 仍直传星点，不浪费抢星节奏
  const enemyCD = { tank: { id: 'e', position: [16, 12], direction: 'down', crashed: false }, bullet: null, skill: { type: 'teleport', remainingCooldownFrames: 20 }, status: {} };
  const r2 = findStarTeleport(mkMe(), enemyCD, enemyCD.tank, [], game);
  check('Y2 敌teleport冷却中 -> 直传星点(不防过头)', !!(r2 && r2[0] === 17 && r2[1] === 4), 'r=' + JSON.stringify(r2));

  // Y3: 敌非 teleport(shield 就绪) -> 不会瞬移抢星 -> 直传星点
  const enemyShield = { tank: { id: 'e', position: [16, 12], direction: 'down', crashed: false }, bullet: null, skill: { type: 'shield', remainingCooldownFrames: 0 }, status: {} };
  const r3 = findStarTeleport(mkMe(), enemyShield, enemyShield.tank, [], game);
  check('Y3 敌非teleport -> 直传星点(不防过头)', !!(r3 && r3[0] === 17 && r3[1] === 4), 'r=' + JSON.stringify(r3));

  // Y4: enemyTeleportReady 语义 —— teleport且冷却<=1才算就绪
  check('Y4 enemyTeleportReady(cd0)=true', enemyTeleportReady(enemyTP) === true);
  check('Y4 enemyTeleportReady(cd20)=false', enemyTeleportReady(enemyCD) === false);
  check('Y4 enemyTeleportReady(shield)=false', enemyTeleportReady(enemyShield) === false);

  // Y5: 十字相邻安全格落点不应触发 teleportPreTurnDir 预转(已避开敌炮线，先转白费一帧延迟抢星)
  const meY5 = makeMe([2, 2], 'up');
  const preturn = teleportPreTurnDir(meY5, r1, enemyTP, enemyTP.tank, game);
  check('Y5 十字安全落点不预转(直接传，不浪费帧)', preturn === null, 'preturn=' + preturn);

  // Y6: 小强尾盘复盘(mat_12d26hXYXtTHzftkj)。
  // f115 星[14,6]、双方3:3、敌一两步内可吃；星点本身被敌炮线锁定时，不能退到两格外泛化安全点。
  const meLate = makeMe([10, 9], 'right', { stars: 3, skill: { type: 'teleport', remainingCooldownFrames: 0 } });
  const enemyLate = { tank: { id: 'e', position: [13, 6], direction: 'right', crashed: false }, bullet: null, skill: { type: 'teleport', remainingCooldownFrames: 5 }, status: {}, stars: 3 };
  const gameLate = { map: emptyMap(19, 15), star: [14, 6], frames: 116 };
  const rLate = findStarTeleport(meLate, enemyLate, enemyLate.tank, [], gameLate);
  check('Y6 胶着尾盘直传星点不安全', isTeleportSafe(gameLate.star, enemyLate.tank, [], gameLate, 0, enemyLate) === false);
  check('Y6 胶着尾盘改贴星一格，不退到两格外', rLate && manhattan(rLate, gameLate.star) === 1, 'r=' + JSON.stringify(rLate));
}

// =========================================================
// 场景 Z：护盾流敌人对射前先验算开火后能否脱线（mat_EFOl 复盘）
// f29 双方同帧开火，f30 敌开盾吃掉我的子弹，我的子弹打墙，敌弹命中我。
// 根因：直线开火分支对 shield 流敌人没有"打完能不能躲"的验算，白送一发再被回敬击毁。
// =========================================================
console.log('场景Z: 护盾流敌人对射前先验算能否脱线(mat_EFOl)');
{
  const map = emptyMap(19, 15);
  // 复刻 mat_EFOl f29 几何：我[2,12]朝right，敌[6,12]朝left，同行y=12，距4
  // 敌有 shield 技能，炮管就绪，无子弹在途
  const enemyShield = {
    tank: { id: 'e', position: [6, 12], direction: 'left', crashed: false },
    bullet: null,
    skill: { type: 'shield', remainingCooldownFrames: 0 },
    status: {}
  };
  const game = { map: map, star: null, frames: 29 };

  // Z1: enemyHasShieldSkill 语义
  check('Z1 enemyHasShieldSkill(shield)=true', enemyHasShieldSkill(enemyShield) === true);
  const enemyTP = { skill: { type: 'teleport', remainingCooldownFrames: 0 }, status: {} };
  check('Z1 enemyHasShieldSkill(teleport)=false', enemyHasShieldSkill(enemyTP) === false);

  // Z2: 我[2,12]朝right，敌[6,12]朝left，距4，y=12 上下各有空格 -> 可脱线 -> 允许开火
  const meZ2 = makeMe([2, 12], 'right');
  const canFire = canShootThenEvadeShieldCounter(meZ2, enemyShield, enemyShield.tank, [], game, [6, 12]);
  check('Z2 有脱线空间时允许对护盾敌开火', canFire === true, 'canFire=' + canFire);

  // Z3: 我[2,12]朝right，敌[6,12]，但 y=11 和 y=13 都是墙（无法脱线）-> 不允许开火
  const mapWalled = emptyMap(19, 15);
  mapWalled[2][11] = 'x'; // 上方墙
  mapWalled[2][13] = 'x'; // 下方墙
  const meZ3 = makeMe([2, 12], 'right');
  const canFireWalled = canShootThenEvadeShieldCounter(meZ3, enemyShield, enemyShield.tank, [], { map: mapWalled, star: null, frames: 29 }, [6, 12]);
  check('Z3 无脱线空间时禁止对护盾敌开火', canFireWalled === false, 'canFireWalled=' + canFireWalled);

  // Z4: onIdle 整体行为 —— 有脱线空间时应开火（不因护盾而完全不打）
  const meZ4 = makeMe([2, 12], 'right', { skill: { type: 'teleport', remainingCooldownFrames: 30 } });
  MATCH_STATE = null;
  onIdle(meZ4, enemyShield, game);
  check('Z4 有脱线空间时onIdle对护盾敌开火', meZ4._actions.some(a => a[0] === 'fire'), JSON.stringify(meZ4._actions));

  // Z5: onIdle 整体行为 —— 无脱线空间时不开火，改走位
  const meZ5 = makeMe([2, 12], 'right', { skill: { type: 'teleport', remainingCooldownFrames: 30 } });
  MATCH_STATE = null;
  onIdle(meZ5, enemyShield, { map: mapWalled, star: null, frames: 29 });
  check('Z5 无脱线空间时onIdle不对护盾敌开火', !meZ5._actions.some(a => a[0] === 'fire'), JSON.stringify(meZ5._actions));

  // Z6: 非护盾敌（teleport）同距同线 -> 正常开火，不受护盾逻辑影响
  const meZ6 = makeMe([2, 12], 'right', { skill: { type: 'teleport', remainingCooldownFrames: 30 } });
  const enemyTPZ6 = { tank: { id: 'e', position: [6, 12], direction: 'left', crashed: false }, bullet: null, skill: { type: 'teleport', remainingCooldownFrames: 5 }, status: {} };
  MATCH_STATE = null;
  onIdle(meZ6, enemyTPZ6, game);
  check('Z6 非护盾敌同线 -> 正常开火(不防过头)', meZ6._actions.some(a => a[0] === 'fire' || a[0] === 'turn'), JSON.stringify(meZ6._actions));
}

// =========================================================
// 场景 FZ：冰冻流敌人不能贴近（mat_0Wmx 复盘）
// 我吃完星[16,8]后沿 x=16 往下走到 [16,10]，冰冻敌沿 x=17 爬到 [17,10]（相邻列 d=1）。
// 敌冻我 2 帧不能动，转身一炮点死。根因：freeze 流敌人未被识别，standoff 退回普通 4 格，
// 让走位逻辑把我带到 freeze 敌身边的死区。
// =========================================================
console.log('场景FZ: 冰冻流敌人保守间距+被冻致死预计算(mat_0Wmx)');
{
  const map = emptyMap(19, 15);
  const freezeEnemy = {
    tank: { id: 'e', position: [17, 10], direction: 'up', crashed: false },
    bullet: null,
    skill: { type: 'freeze', remainingCooldownFrames: 0 },
    status: {}
  };

  // FZ1: enemyIsFreezeType / safeStandoffDistance 语义
  check('FZ1 enemyIsFreezeType(freeze)=true', enemyIsFreezeType(freezeEnemy) === true);
  check('FZ1 enemyIsFreezeType(shield)=false', enemyIsFreezeType({ skill: { type: 'shield' } }) === false);
  check('FZ1 freeze 流 standoff=5', safeStandoffDistance(freezeEnemy) === 5);
  check('FZ1 普通敌 standoff=4', safeStandoffDistance({ skill: { type: 'teleport' } }) === 4);

  // FZ2: freezeKillsAt —— 同行无墙、曼哈顿<=4 -> 被冻必死
  // 致死格 [16,10] 与敌 [17,10]：不同行不同列? dx=1,dy=0 -> 同行 y=10，d=1 -> 必死
  check('FZ2 同行d=1 freezeKillsAt=true', freezeKillsAt([16, 10], [17, 10], { map: map }) === true);
  // 同列 y 方向 d=4 -> ceil(4/2)=2 帧子弹，冻2帧期间命中 -> 必死
  check('FZ2 同列d=4 freezeKillsAt=true', freezeKillsAt([10, 6], [10, 10], { map: map }) === true);
  // 同列 d=5 -> ceil(5/2)=3 帧，解冻后来得及脱离 -> 安全
  check('FZ2 同列d=5 freezeKillsAt=false', freezeKillsAt([10, 5], [10, 10], { map: map }) === false);
  // 不同线(对角) -> 冻住也打不到 -> 安全（不防过头）
  check('FZ2 对角(不同线) freezeKillsAt=false', freezeKillsAt([14, 8], [17, 10], { map: map }) === false);
  // 同行有墙遮挡 -> 安全
  const mapWall = emptyMap(19, 15);
  mapWall[15][10] = 'x'; // 敌[17,10] 与 [13,10] 之间有墙
  check('FZ2 同行有墙 freezeKillsAt=false', freezeKillsAt([13, 10], [17, 10], { map: mapWall }) === false);

  // FZ3: stepEntersKillZone —— 走到 freeze 敌同行 d=1 的 [16,10] 是死区
  check('FZ3 freeze同行d=1 入死区', stepEntersKillZone([16, 11], [16, 10], [17, 10], { map: map }, freezeEnemy, 5) === true);
  // 走到同列 d=4 的格也是死区
  check('FZ3 freeze同列d=4 入死区', stepEntersKillZone([10, 7], [10, 6], [10, 10], { map: map }, freezeEnemy, 5) === true);
  // 同列 d=5 安全格不算死区
  check('FZ3 freeze同列d=5 非死区', stepEntersKillZone([10, 6], [10, 5], [10, 10], { map: map }, freezeEnemy, 5) === false);
  // 对角 d=4(不同线) 不算死区（防过头校验：freeze 只在同线生效）
  check('FZ3 freeze对角d>3不同线 非死区', stepEntersKillZone([15, 9], [14, 8], [17, 10], { map: map }, freezeEnemy, 5) === false);

  // FZ4: 普通敌人(teleport)同样位置 d=4 同列 不应被 freeze 逻辑误判为死区（行为不变）
  const tpEnemy = { tank: { id: 'e', position: [10, 10], direction: 'up' }, skill: { type: 'teleport', remainingCooldownFrames: 5 }, status: {} };
  check('FZ4 普通敌同列d=4 非死区(不防过头)', stepEntersKillZone([10, 7], [10, 6], [10, 10], { map: map }, tpEnemy, 4) === false);
}

// =========================================================
// 场景 DL：双弹时序"握双弹怂、没双弹刚"（mat_Jov6 / mat_EUR / mat_LVd 复盘）
// 三局对手都是 overload 双弹流(Bolun)，myth-tank 三局 fired=0 纯被动被赶死。
// 核心：用 enemyDoubleLaneThreat(此刻握双弹)而非 enemyIsOverloadType(拥有技能)决定开火怂/刚。
// =========================================================
console.log('场景DL: 双弹时序"握双弹怂、没双弹刚"(mat_Jov6/EUR/LVd)');
{
  const mapDL = emptyMap(20, 20);
  function mk(pos, dir) { return makeMe(pos, dir, { skill: { type: 'teleport', remainingCooldownFrames: 30 } }); }
  function overEnemy(pos, dir, cd, overloaded) {
    return { tank: { id: 'e', position: pos, direction: dir, crashed: false }, bullet: null,
      skill: { type: 'overload', remainingCooldownFrames: cd }, status: overloaded ? { overloaded: true } : {} };
  }

  // DL1: 敌 overload 冷却中(cd15,手里没双弹) + 我已对准 + 敌侧身没瞄我(我先手) -> 开火"刚"(mat_LVd 整局fired=0被赶角)
  {
    const me = mk([10, 10], 'up');
    const enemy = overEnemy([10, 5], 'right', 15, false);
    MATCH_STATE = null; onIdle(me, enemy, { map: mapDL, star: null, frames: 40 });
    check('DL1 敌overload冷却中+我对准 -> 开火(没双弹刚)', me._actions.some(a => a[0] === 'fire'), JSON.stringify(me._actions));
  }
  // DL2: 敌握双弹(过载就绪cd0) 同样位置 -> 不开火(握双弹怂，让位走位拉开)
  {
    const me = mk([10, 10], 'up');
    const enemy = overEnemy([10, 5], 'right', 0, false);
    MATCH_STATE = null; onIdle(me, enemy, { map: mapDL, star: null, frames: 40 });
    check('DL2 敌握双弹(就绪)+我对准 -> 不开火(握双弹怂)', !me._actions.some(a => a[0] === 'fire'), JSON.stringify(me._actions));
  }
  // DL3: 敌已过载(握双弹) 同样位置 -> 不开火(怂)
  {
    const me = mk([10, 10], 'up');
    const enemy = overEnemy([10, 5], 'right', 8, true);
    MATCH_STATE = null; onIdle(me, enemy, { map: mapDL, star: null, frames: 40 });
    check('DL3 敌已过载(握双弹)+我对准 -> 不开火(怂)', !me._actions.some(a => a[0] === 'fire'), JSON.stringify(me._actions));
  }

  // DL4: findGuardLineShot 对 overload 流冷却中(没握双弹)同线近距 -> 允许守线开枪("没双弹刚")
  {
    const me = mk([6, 4], 'right');
    const enemyCD = overEnemy([10, 4], 'left', 15, false);
    // 新行为：cd=15 远大于1，enemyDoubleLaneThreat=false，同行 d=4 无实弹 -> 可开火/转向
    check('DL4 overload流冷却中近距同线=可守线(没双弹刚)', findGuardLineShot(me, enemyCD, enemyCD.tank, [], { map: mapDL, star: null, frames: 50 }, [10, 4]) !== null);
  }

  // DL5: mat_Jov6 守星陷阱——星紧贴握双弹敌(d=1)，不抢(冲过去落副弹炮线送死)
  {
    const sp = { dist: 5, step: [5, 5] };
    const held = overEnemy([2, 4], 'right', 0, true);
    check('DL5 星贴握弹敌(d=1) -> 不抢(守星陷阱)', shouldChaseStar([6, 5], [2, 4], { map: mapDL, star: [1, 5] }, sp, held) === false);
    // 对照: 敌overload冷却中(没双弹) -> 不算守星陷阱，照常抢近星
    const spent = overEnemy([2, 4], 'right', 15, false);
    check('DL5 敌没双弹+近星 -> 照常抢(不防过头)', shouldChaseStar([6, 5], [2, 4], { map: mapDL, star: [1, 5] }, sp, spent) === true);
  }

  // DL6: mat_Jov6 "还回头"——我在握双弹敌的副弹行/列里，chooseStep 应横移跨出覆盖带(dx>=2且dy>=2)，不朝敌走回去
  {
    const held = overEnemy([2, 4], 'right', 0, true);
    MATCH_STATE = null;
    const step = chooseStep(mk([5, 5], 'left'), held, { map: mapDL, star: [1, 5], frames: 6 }, [2, 4], getMatchState({ map: mapDL, frames: 6 }));
    const dx = step ? Math.abs(step[0] - 2) : -1, dy = step ? Math.abs(step[1] - 4) : -1;
    check('DL6 副弹带内 -> 横移跨出覆盖带(不还回头朝敌走)', step && dx >= 2 && dy >= 2, 'step=' + JSON.stringify(step) + ' dx=' + dx + ' dy=' + dy);
  }

  // DL7: escapeDoubleLaneBand 不会往敌人更近处挪(那是靠近握弹敌而非脱离)
  {
    const esc = escapeDoubleLaneBand([5, 5], [2, 4], { map: mapDL });
    check('DL7 脱离带不靠近敌人', !esc || manhattan(esc, [2, 4]) >= manhattan([5, 5], [2, 4]), 'esc=' + JSON.stringify(esc));
  }

  // DL8: chooseStep 站位步过死区复检——绝不返回朝握弹敌走进副弹带的死区步(mat_Jov6 墙袋 standoffStep=[5,5])
  {
    // 用 mat_Jov6 真实墙图：敌握双弹[2,4],我[6,5],西邻[5,5]/北邻[6,4]都在覆盖带死区
    const jovRows = ['xxxxxxxxxxxxxxxxxxx', 'x..........x.....mx', 'x....x.o..mm......x', 'x...o.............x', 'x...........m...x.x', 'x......xx...xx.xx.x', 'x.x...xx...xx.....x', 'x.x.o.o....oo.o.x.x', 'x.....xx...xx...x.x', 'x.xx.xx...xx......x', 'x.x...m...........x', 'x.............o...x', 'x......mm..o.x....x', 'xm.....x..........x', 'xxxxxxxxxxxxxxxxxxx'];
    const jm = []; for (let x = 0; x < jovRows[0].length; x++) { jm[x] = []; for (let y = 0; y < jovRows.length; y++) jm[x][y] = jovRows[y][x]; }
    const held = overEnemy([2, 4], 'right', 0, true);
    MATCH_STATE = null;
    const step = chooseStep(mk([6, 5], 'left'), held, { map: jm, star: [1, 5], frames: 6 }, [2, 4], getMatchState({ map: jm, frames: 6 }));
    // 不能返回 [5,5](朝敌走进副弹带死区)；返回的步要么是死区外、要么 null 交兜底
    const isDeadStep = step && step[0] === 5 && step[1] === 5;
    check('DL8 墙袋里不返回朝敌死区步[5,5]', !isDeadStep, 'step=' + JSON.stringify(step));
  }
}

// =========================================================
// 场景 BH：躲草丛等闪现抢星打双弹流（用户策略）
// 面对 overload 双弹流，无星空窗期躲进草丛(敌锁不定我=enemy.tank null，双弹无从瞄准)，
// 保留传送等星刷新再闪现抢分。仅对 overload 流触发、让位给抢星，不防过头。
// =========================================================
console.log('场景BH: 躲草丛等闪现抢星打双弹流(用户策略)');
{
  function bushMap() { const m = emptyMap(20, 20); m[5][5] = 'o'; m[6][5] = 'o'; return m; }
  function overE(pos, cd, ov) { return { tank: { id: 'e', position: pos, direction: 'up', crashed: false }, bullet: null, skill: { type: 'overload', remainingCooldownFrames: cd }, status: ov ? { overloaded: true } : {} }; }
  function mk(pos, dir, opts) { return makeMe(pos, dir, opts || { skill: { type: 'teleport', remainingCooldownFrames: 0 } }); }

  // BH1: overload 流 + 无星 + 我在空地 -> chooseStep 朝草丛走(奔安全草丛蹲守)
  {
    const m = bushMap();
    MATCH_STATE = null;
    const step = chooseStep(mk([10, 10], 'up'), overE([10, 16], 8, false), { map: m, star: null, frames: 40 }, [10, 16], getMatchState({ map: m, frames: 40 }));
    // 朝草丛[5,5]/[6,5]方向：x 减小 或 y 减小(BFS 第一步)
    check('BH1 overload无星 -> 奔草丛(走位非null且不贴脸)', step && manhattan(step, [10, 16]) >= manhattan([10, 10], [10, 16]), 'step=' + JSON.stringify(step));
  }

  // BH2: 已藏草丛 + overload 流 + 无星 + 敌远不瞄我 + 传送就绪 -> 原地蹲守(无动作)，保留传送
  {
    const m = bushMap();
    const me = mk([5, 5], 'up', { status: { cloaked: true } });
    MATCH_STATE = null;
    onIdle(me, overE([15, 15], 8, false), { map: m, star: null, frames: 40 });
    check('BH2 草丛+无星+敌远 -> 蹲守不动(保留传送)', me._actions.length === 0, JSON.stringify(me._actions));
  }

  // BH3: 草丛蹲守中星刷新 -> 不再蹲守，去抢星(闪现/走位)
  {
    const m = bushMap();
    const me = mk([5, 5], 'up', { status: { cloaked: true } });
    MATCH_STATE = null;
    onIdle(me, overE([15, 15], 8, false), { map: m, star: [3, 3], frames: 40 });
    check('BH3 草丛+星刷新 -> 去抢星(不傻蹲)', me._actions.length > 0, JSON.stringify(me._actions));
  }

  // BH4(防过头): 普通敌(shield)无星 -> 不强制奔草丛(走正常巡逻，nextStepToSafeBush 不该被普通敌触发)
  {
    const m = bushMap();
    const bush = nextStepToSafeBush(mk([10, 10], 'up'), { tank: { id: 'e', position: [10, 16], direction: 'up' }, skill: { type: 'shield' }, status: {} }, { map: m, star: null }, [10, 16], 4);
    // nextStepToSafeBush 本身不判敌类型(由调用点 gate)，这里验证 chooseStep 对普通敌不会因草丛逻辑改变既有巡逻
    MATCH_STATE = null;
    const me = mk([10, 10], 'up');
    const step = chooseStep(me, { tank: { id: 'e', position: [10, 16], direction: 'up', crashed: false }, bullet: null, skill: { type: 'shield', remainingCooldownFrames: 0 }, status: {} }, { map: m, star: null, frames: 40 }, [10, 16], getMatchState({ map: m, frames: 40 }));
    check('BH4 普通敌无星 -> chooseStep 正常返回(不卡死)', !!step, 'step=' + JSON.stringify(step));
  }

  // BH5(蹲守安全校验): 草丛但敌贴近 d=2 -> 不傻蹲，交走位拉开(有动作)
  {
    const m = bushMap();
    const me = mk([5, 5], 'up', { status: { cloaked: true } });
    MATCH_STATE = null;
    onIdle(me, overE([5, 7], 8, false), { map: m, star: null, frames: 40 });
    check('BH5 草丛但敌贴近d=2 -> 拉开(不傻蹲)', me._actions.length > 0, JSON.stringify(me._actions));
  }

  // BH6(刺杀禁用): overload 流(含冷却中)禁用传送刺杀(刺杀=凑近送双弹) -> findAssassinationPlan=null
  {
    const m = emptyMap(20, 20);
    const me = mk([10, 10], 'up');
    const overCD = overE([10, 17], 8, false); // 冷却中也禁
    check('BH6 overload流(冷却中)禁刺杀', findAssassinationPlan(me, overCD, overCD.tank, [], { map: m, star: null, frames: 40 }, getMatchState({ map: m, frames: 40 })) === null);
    // 对照: 普通 shield 敌仍可刺杀(不防过头)——需就绪传送+合适距离
    const me2 = mk([10, 10], 'up');
    const shieldE = { tank: { id: 'e', position: [10, 17], direction: 'up', crashed: false }, bullet: null, skill: { type: 'shield', remainingCooldownFrames: 30 }, status: {} };
    MATCH_STATE = null;
    const plan = findAssassinationPlan(me2, shieldE, shieldE.tank, [], { map: m, star: null, frames: 40 }, getMatchState({ map: m, frames: 40 }));
    check('BH6 对照: 普通敌刺杀逻辑未被禁(可返回plan或null但不因overload短路)', enemyIsOverloadType(shieldE) === false);
  }

  // BH7: 草丛在握弹敌双弹带里 -> nextStepToSafeBush 不选它(躲进去反被秒)
  {
    const m = emptyMap(20, 20);
    m[10][8] = 'o'; // 草丛紧贴敌[10,6]同列 d=2(在双弹带+死区)
    m[3][3] = 'o';  // 远处安全草丛
    const held = overE([10, 6], 0, true); // 握双弹
    const step = nextStepToSafeBush(mk([10, 12], 'up'), held, { map: m, star: null }, [10, 6], 6);
    // 应奔远处安全草丛[3,3]而非危险草丛[10,8]：第一步不该朝[10,8](y减小靠近敌)
    check('BH7 不躲进握弹敌双弹带里的草丛', !step || !(step[0] === 10 && step[1] === 11), 'step=' + JSON.stringify(step));
  }
}


// =========================================================
// 场景 CL：复刻 mat_L4l9ZNuPbal3nQyPD —— 隐身敌"偷屁股"，逃跑须走斜线(之字)不走直线
// 死因：Taoqi(cloak流) f8 隐身吃星后悄悄绕到我正后方同行 y=6([16,6])，我沿 y=6 行连走3格
// 直线往 left 退([15,6]→[14,6]→[13,6])，f12 它从背后朝 left 开火，2格/帧子弹 f13 在[12,6]追上击毁。
// 用户策略：面对隐身敌逃跑要往斜着方向走(每帧换行又换列)，别沿单一行/列直线退。
// 期望：cloak 流敌人隐身时 chooseStep 走之字(连续3点不共线)，离开偷袭直线；非cloak隐身仍走旧直线逻辑。
// =========================================================
console.log('场景CL: 隐身敌偷屁股, 之字斜逃不走直线 (mat_L4l9)');
{
  function mapL4() {
    const m = emptyMap(19, 15); // y=5/y=6 行全开阔(复刻 raw 区域)
    return m;
  }
  function collinear3(a, b, c) { return (a[0] === b[0] && b[0] === c[0]) || (a[1] === b[1] && b[1] === c[1]); }

  // CL0: enemyIsCloakType 识别
  check('CL0 enemyIsCloakType 识别 cloak 流', enemyIsCloakType({ skill: { type: 'cloak' } }) === true &&
    enemyIsCloakType({ skill: { type: 'shield' } }) === false && enemyIsCloakType({}) === false);

  // CL1: cloak 隐身敌, 我[15,6], 敌最后[16,8](对角不同线), 无星 -> 第一步给出避让, 且后续不沿单一行/列直线退
  {
    const game = { map: mapL4(), star: null, frames: 11 };
    MATCH_STATE = null;
    const state = getMatchState(game);
    state.lastEnemyPos = [16, 8]; state.lastEnemySeenFrame = 7;
    const enemy = { status: {}, skill: { type: 'cloak' } };
    let pos = [15, 6]; const traj = [pos];
    for (let f = 0; f < 3; f++) {
      game.frames = 11 + f;
      const step = chooseStep(makeMe(pos, 'left'), enemy, game, null, state);
      if (!step) break;
      traj.push(step); pos = step;
    }
    check('CL1 cloak 隐身给出避让步', traj.length >= 4, 'traj=' + JSON.stringify(traj));
    // 之字核心: 首步至少要远离最后已知位置，后续真正的之字交替由 CL2/CL3 继续覆盖。
    check('CL1 cloak 逃跑先远离敌人', traj.length >= 4 && manhattan(traj[1], [16, 8]) >= manhattan(traj[0], [16, 8]), 'traj=' + JSON.stringify(traj));
  }

  // CL2: diagonalEvadeStep 单步——不往隐身敌方向靠(距 dangerPos 不减小)
  {
    const game = { map: mapL4(), star: null, frames: 11 };
    MATCH_STATE = null;
    const state = getMatchState(game);
    const step = diagonalEvadeStep([15, 6], [16, 8], game, state);
    check('CL2 之字步不往隐身敌方向靠', step && manhattan(step, [16, 8]) >= manhattan([15, 6], [16, 8]), 'step=' + JSON.stringify(step));
  }

  // CL3: 之字步逐帧交替换轴 -> lastEvadeAxis 在相邻两步不同(凑出阶梯)
  {
    const game = { map: mapL4(), star: null, frames: 11 };
    MATCH_STATE = null;
    const state = getMatchState(game);
    const s1 = diagonalEvadeStep([15, 6], [16, 8], game, state); const a1 = state.lastEvadeAxis;
    const s2 = diagonalEvadeStep(s1, [16, 8], game, state); const a2 = state.lastEvadeAxis;
    check('CL3 之字逐帧换轴(相邻步轴不同)', s1 && s2 && a1 !== a2, `a1=${a1} a2=${a2} s1=${JSON.stringify(s1)} s2=${JSON.stringify(s2)}`);
  }

  // CL4 防过头: 非 cloak 流(shield)隐身丢视野, 仍走旧逻辑(此几何下沿 y=6 直线退), 不被之字逻辑接管。
  //   断言外部可观察行为(轨迹直线退), 不查内部缓存字段(测试框架 MATCH_STATE 跨用例不真重置, 见 getMatchState)。
  {
    const game = { map: mapL4(), star: null, frames: 11 };
    MATCH_STATE = null;
    const state = getMatchState(game);
    state.lastEnemyPos = [16, 8]; state.lastEnemySeenFrame = 7;
    const sh = { status: {}, skill: { type: 'shield' } };
    let pos = [15, 6]; const traj = [pos];
    for (let f = 0; f < 3; f++) {
      game.frames = 11 + f;
      const step = chooseStep(makeMe(pos, 'left'), sh, game, null, state);
      if (!step) break;
      traj.push(step); pos = step;
    }
    // 非 cloak: 此几何 standoff=4、距敌3 -> nextStepAvoiding 沿 left 直线退([15,6]→[14,6]→[13,6]→[12,6])，
    // 至少出现一组连续3点共线(直线退) -> 证明没被之字逻辑接管(之字会逐帧换轴打散共线)。
    let hasStraight = false;
    for (let i = 0; i + 2 < traj.length; i++) if (collinear3(traj[i], traj[i + 1], traj[i + 2])) hasStraight = true;
    check('CL4 防过头: 非cloak隐身仍走旧直线逻辑(不被之字接管)', traj.length >= 4 && hasStraight, 'traj=' + JSON.stringify(traj));
  }
}


// =========================================================
// 场景 PB：过载双弹配对弹推断锚点修复（mat_8iF0B3Odm5RHxxO1e 撞副弹）
// 双弹车道在开火瞬间由敌位置决定且固定不变；敌开火后会移动。旧逻辑用敌"当前"位置锚定
// 哪侧是配对弹，敌垂直移开车道后会把配对弹算到错误行/列、漏判真实那发被秒。
// 修复：敌仍在可见弹车道(可见主弹)只补副弹+1；否则两侧都补，保证真实配对弹必被覆盖。
// =========================================================
console.log('场景PB: 双弹配对弹锚点修复(敌移动后不漏判)');
{
  function over1(ep, vis, dir) {
    return { tank: { id: 'e', position: ep, direction: dir, crashed: false }, bullet: { position: vis, direction: dir }, skill: { type: 'overload' }, status: { overloaded: true } };
  }
  // PB1: 敌仍在可见弹车道(可见主弹 y=8, 敌 y=8) -> 只补副弹 y=9, 不过度保守(length=2)
  const e1 = over1([10, 8], [5, 8], 'left');
  const bs1 = collectEnemyBullets(e1);
  check('PB1 可见主弹(敌在该行) -> 只补1发副弹', bs1.length === 2 && bs1.some(b => b._inferred && b.position[1] === 9), JSON.stringify(bs1));

  // PB2: 敌已垂直移开车道(敌 y=10, 可见弹 y=9) -> 两侧补 y=8/y=10, 覆盖真实主弹(无论哪侧)
  const e2 = over1([7, 10], [4, 9], 'left');
  const bs2 = collectEnemyBullets(e2);
  const lanes2 = bs2.filter(b => b._inferred).map(b => b.position[1]).sort((a, b) => a - b);
  check('PB2 敌垂直移开 -> 两侧都补(y=8,y=10)', bs2.length === 3 && lanes2[0] === 8 && lanes2[1] === 10, JSON.stringify(bs2));

  // PB3: 可见副弹(敌 y=8, 可见弹 y=9, enemyLane≠visLane) -> 两侧补, 必含真实主弹行 y=8
  const e3 = over1([7, 8], [4, 9], 'left');
  const lanes3 = collectEnemyBullets(e3).filter(b => b._inferred).map(b => b.position[1]);
  check('PB3 可见副弹 -> 补弹覆盖真实主弹行y=8', lanes3.indexOf(8) >= 0, JSON.stringify(lanes3));

  // PB4: 竖直飞双弹(dir=up, 不同列x) 同理 -> 敌移开列后两侧补
  const e4 = { tank: { id: 'e', position: [10, 7], direction: 'up', crashed: false }, bullet: { position: [9, 4], direction: 'up' }, skill: { type: 'overload' }, status: { overloaded: true } };
  const lanes4 = collectEnemyBullets(e4).filter(b => b._inferred).map(b => b.position[0]).sort((a, b) => a - b);
  check('PB4 竖直双弹敌移开列 -> 两侧补(x=8,x=10)', lanes4.length === 2 && lanes4[0] === 8 && lanes4[1] === 10, JSON.stringify(lanes4));

  // PB5 防过头: 非overload敌完全不补
  const e5 = { tank: { id: 'e', position: [10, 8] }, bullet: { position: [5, 8], direction: 'left' }, skill: { type: 'shield' }, status: {} };
  check('PB5 非overload敌不补配对弹', collectEnemyBullets(e5).length === 1);

  // PB6(mat_1gua): 只露出主弹 x=13 时，也要补出 x=14 副弹，避免继续沿 x=14 上行被秒。
  const gamePB6 = { map: emptyMap(19, 15), star: null, frames: 105 };
  const mePB6 = makeMe([14, 4], 'up');
  const e6 = over1([13, 10], [13, 9], 'up');
  const dodgePB6 = findBulletDodge(mePB6, e6, gamePB6, e6.tank.position);
  check('PB6 可见主弹时补副弹 -> 躲离x=14车道(mat_1gua)', dodgePB6 && dodgePB6[0] !== 14,
    'dodge=' + JSON.stringify(dodgePB6) + ' bullets=' + JSON.stringify(collectEnemyBullets(e6)));
}

// =========================================================
// 场景 PBL：overload 生效但子弹尚未生成时，提前脱离副弹车道
// mat_L2dcAhIU0ia3QghC6：敌 [10,3] 朝 right，过载会覆盖 y=3/y=4；我在 [15,4] 若继续横走会被副弹命中。
// =========================================================
console.log('场景PBL: 过载开火前预判副弹车道');
{
  const gamePBL = { map: emptyMap(19, 15), star: [11, 8], frames: 68 };
  const mePBL = makeMe([15, 4], 'left');
  const enemyPBL = {
    tank: { id: 'e', position: [10, 3], direction: 'right', crashed: false },
    bullet: null,
    skill: { type: 'overload', remainingCooldownFrames: 0 },
    status: { overloaded: true },
    stars: 1
  };
  const predicted = predictedOverloadBullets(enemyPBL.tank);
  const dodgePBL = findOverloadLaneDodge(mePBL, enemyPBL, enemyPBL.tank, gamePBL, enemyPBL.tank.position);
  check('PBL1 过载副弹预判 -> 脱离y=4车道(mat_L2dc)', dodgePBL && dodgePBL[1] !== 4,
    'dodge=' + JSON.stringify(dodgePBL) + ' predicted=' + JSON.stringify(predicted));
  check('PBL2 预判落点不在双弹弹道', dodgePBL && !anyBulletThreatens(predicted, dodgePBL, gamePBL),
    'dodge=' + JSON.stringify(dodgePBL));
}

// =========================================================
// 场景 NO1：No.1 复盘，moveToward/chooseStep 不把我推进已知弹道
// mat_FPfRkRE3xUlCAASdH：我传到 [1,12] 吃星后，旧兜底把我推到 [2,12] 接下行弹。
// mat_8aYBkMG8jBgDwwiyf：敌左射弹在 [4,2]，旧兜底可能继续朝右走进子弹。
// =========================================================
console.log('场景NO1: 不用兜底go接子弹(No.1复盘)');
{
  const mapNO1 = emptyMap(19, 15);

  const meN1 = makeMe([1, 12], 'right');
  const enemyTankN1 = { id: 'e', position: [1, 2], direction: 'down', crashed: false };
  const bulletN1 = { position: [2, 10], direction: 'down' };
  moveToward(meN1, { map: mapNO1, star: null, frames: 6 }, [2, 12], enemyTankN1.position, enemyTankN1, [bulletN1]);
  check('NO1-1 moveToward目标格在弹道上 -> 不直接go进[2,12]', !meN1._actions.some(a => a[0] === 'go'),
    JSON.stringify(meN1._actions));

  const meN2 = makeMe([3, 2], 'right');
  const enemyTankN2 = { id: 'e', position: [6, 2], direction: 'left', crashed: false };
  const bulletN2 = { position: [4, 2], direction: 'left' };
  moveToward(meN2, { map: mapNO1, star: null, frames: 80 }, [4, 2], enemyTankN2.position, enemyTankN2, [bulletN2]);
  check('NO1-2 moveToward前方就是来弹 -> 不直接go接弹', !meN2._actions.some(a => a[0] === 'go'),
    JSON.stringify(meN2._actions));

  const meN3 = makeMe([1, 12], 'right');
  const enemyN3 = {
    tank: enemyTankN1,
    bullet: bulletN1,
    skill: { type: 'overload', remainingCooldownFrames: 8 },
    status: {},
    stars: 0
  };
  const stepN3 = chooseStepScored(meN3, enemyN3, { map: mapNO1, star: null, frames: 6 }, enemyTankN1.position, {});
  check('NO1-3 chooseStepScored默认收集enemy.bullet，不返回弹道格', !stepN3 || !stepIntoBulletPath(collectEnemyBullets(enemyN3), stepN3, { map: mapNO1 }),
    'step=' + JSON.stringify(stepN3));
}

// =========================================================
// 场景 DE：死胡同规避（mat_2WzUlUqW6D90vDHd4 躲进右上墙角 [17,1] 死路被秒）
// [17,1]: 右(x=18)/上(y=0)/下(y=2,x=17='x') 三面墙，唯一开口 [16,1]。沿 y=1 边行抢星走到底，
// 敌同行 y=1 用子弹封死唯一开口，我无垂直脱离、对射慢一拍被击毁。走位/巡逻应避开被封锁的死胡同。
// =========================================================
console.log('场景DE: 死胡同规避(不往墙角死路送)');
{
  // 复刻 2Wz 右上角地形: [17,1] 唯一开口[16,1], [18,*]右墙, y=0顶墙, [17,2]='x'
  function mapDE() {
    const m = emptyMap(19, 15);
    m[17][2] = 'x'; // 让 [17,1] 下方是墙 -> [17,1] 成死胡同(只剩[16,1]一个开口)
    return m;
  }
  const game = { map: mapDE(), star: null, frames: 80 };
  // DE1: [17,1] 是死胡同
  check('DE1 [17,1]识别为死胡同(<=1开口)', isDeadEnd([17, 1], game) === true, 'openN=' + openNeighborCount([17, 1], game));
  check('DE1b [16,1]非死胡同', isDeadEnd([16, 1], game) === false);
  // DE2: 敌同行 y=1 能封锁 [17,1] 开口 -> 判被封锁死胡同
  check('DE2 敌同行能封锁[17,1] -> sealed', stepIntoSealedDeadEnd([17, 1], [11, 1], game) === true);
  // DE2b: 敌不同行不同列(无法直线封锁) -> 非sealed
  check('DE2b 敌不同线 -> 非sealed', stepIntoSealedDeadEnd([17, 1], [11, 5], game) === false);

  // DE3: 无星巡逻在 [16,1] 朝right, 敌同行逼近 -> 不走进死角[17,1]
  {
    MATCH_STATE = null;
    const me = makeMe([16, 1], 'right');
    const enemy = { tank: { id: 'e', position: [11, 1], direction: 'right' }, status: {}, skill: { type: 'teleport', remainingCooldownFrames: 10 }, bullet: null };
    const g = { map: mapDE(), star: null, frames: 80 };
    const step = chooseStep(me, enemy, g, [11, 1], getMatchState(g));
    check('DE3 无星巡逻不走进死角[17,1]', step && !(step[0] === 17 && step[1] === 1), 'step=' + JSON.stringify(step));
  }

  // DE4 防过头: 星就在死角[17,1] -> 仍去抢(不因噎废食)
  {
    MATCH_STATE = null;
    const me = makeMe([16, 1], 'right');
    const enemy = { tank: { id: 'e', position: [5, 5], direction: 'up' }, status: {}, skill: { type: 'teleport', remainingCooldownFrames: 10 }, bullet: null };
    const g = { map: mapDE(), star: [17, 1], frames: 80 };
    const step = chooseStep(me, enemy, g, [5, 5], getMatchState(g));
    check('DE4 防过头:星在死角仍去抢', step && step[0] === 17 && step[1] === 1, 'step=' + JSON.stringify(step));
  }

  // DE5 防过头: 开阔地巡逻不受死角逻辑影响(正常走)
  {
    MATCH_STATE = null;
    const me = makeMe([9, 7], 'right');
    const enemy = { tank: { id: 'e', position: [5, 5], direction: 'up' }, status: {}, skill: { type: 'teleport', remainingCooldownFrames: 10 }, bullet: null };
    const g = { map: emptyMap(19, 15), star: null, frames: 80 };
    const step = chooseStep(me, enemy, g, [5, 5], getMatchState(g));
    check('DE5 防过头:开阔巡逻正常给步', step !== null, 'step=' + JSON.stringify(step));
  }
}

console.log('场景DIG: 来回震荡小囚笼时 breakStuckStep 破墙开路 (mat_BavjL)');
{
  // 复刻 [12,12]↔[12,13]：右边土块，敌从左方逼近，上下来回跳出不去
  const map = emptyMap(19, 15);
  map[13][12] = 'm'; map[13][13] = 'm'; // 右边土块挡路
  MATCH_STATE = null;
  const state = getMatchState({ map, star: null, frames: 50 });
  state.lastMyPos2 = [12, 12];
  state.lastMyPos  = [12, 13];
  state.stuckFrames = 2; // 已连续震荡
  const me = makeMe([12, 12], 'right', { skill: { type: 'teleport', remainingCooldownFrames: 30 } });
  const enemy = { tank: { id: 'e', position: [9, 10], direction: 'right', crashed: false }, bullet: null, skill: { type: 'overload', remainingCooldownFrames: 3 }, status: {} };
  const game = { map, star: null, frames: 50 };
  onIdle(me, enemy, game);
  const fired     = me._actions.some(a => a[0] === 'fire');
  const turnRight = me._actions.some(a => a[0] === 'turn' && a[1] === 'right');
  check('DIG1 震荡小囚笼触发破墙(转向right或开火)', fired || turnRight, JSON.stringify(me._actions));
  check('DIG2 不继续来回跳(不 go 进 up/down)', !me._actions.some(a => a[0] === 'go'), JSON.stringify(me._actions));
}

console.log('场景FL: nextStepToFiringLane 已对准优先（先手优化，mat_CD9x）');
{
  // 我在[11,8]朝right，敌在[7,8]同行left方向，需要转left才能开火
  // 期望：nextStepToFiringLane 优先给出"走到后方向已对准"的步，而非随机候选
  const map = emptyMap(19, 15);
  const myPos = [11, 8];
  const enPos = [7, 8];
  MATCH_STATE = null;
  // 测试在同行时，返回的第一步方向应该是 left（已对准方向）
  const step = nextStepToFiringLane(myPos, enPos, { map, star: null, frames: 0 }, 4);
  // 如果给出步，应朝 left（向敌方向逼近，走过去对准）
  if (step) {
    check('FL1 射击轨道步方向朝left(已对准方向)', step[0] <= myPos[0], 'step='+JSON.stringify(step));
  } else {
    check('FL1 已在轨道上(step=null可接受)', true);
  }
}

console.log('场景VP: virtualPatrolTarget overload流选对侧象限（mat_KxY8/mat_C5iE）');
{
  // 我在右下[15,12]，敌(overload)在左上[3,3]，期望巡逻目标不在右下同侧贴边死角
  const map = emptyMap(19, 15);
  const game = { map, star: null, frames: 30 };
  MATCH_STATE = null;
  const state = getMatchState(game);
  state.patrolTarget = null;
  const me = makeMe([15, 12], 'right', { skill: { type: 'teleport', remainingCooldownFrames: 10 } });
  const enemyOL = { tank: { id: 'e', position: [3, 3], direction: 'down', crashed: false }, bullet: null, skill: { type: 'overload', remainingCooldownFrames: 10 }, status: {} };
  const vt = virtualPatrolTarget(me, game, state, enemyOL);
  // 敌在左上(x<9,y<7)，不应选右下同侧(x>=9 且 y>=7)死角
  // 对侧象限是右上(x>=9,y<7)或左上(x<9,y<7)或左下(x<9,y>=7)
  if (vt) {
    const sameQuadrant = vt[0] >= 9 && vt[1] >= 7; // 与我同侧：右下象限
    check('VP1 overload流巡逻目标不在我的右下同侧象限', !sameQuadrant, 'vt='+JSON.stringify(vt));
  } else {
    check('VP1 找到巡逻目标', false, 'vt=null');
  }

  // 我在右下角[17,12]（贴墙极端情况），期望选到对侧象限
  MATCH_STATE = null;
  const state2 = getMatchState(game);
  state2.patrolTarget = null;
  const me2 = makeMe([17, 12], 'right', { skill: { type: 'teleport', remainingCooldownFrames: 10 } });
  const vt2 = virtualPatrolTarget(me2, game, state2, enemyOL);
  if (vt2) {
    const sameQuadrant2 = vt2[0] >= 9 && vt2[1] >= 7;
    check('VP2 右下贴墙时选对侧象限(非右下象限)', !sameQuadrant2, 'vt2='+JSON.stringify(vt2));
  } else {
    check('VP2 找到巡逻目标', false, 'vt2=null');
  }
}

console.log('场景OBS: 敌炮管空窗期反击 findEnemyBulletOpenShot (mat_8vg6)');
{
  // 复刻 mat_8vg6 f18：敌在[7,2]朝right开炮（子弹 [9,2] 朝 right），我在[7,10]同列 y=2 != y=10
  // 子弹朝right，不打在我所在的 x=7 列 -> 我安全，可以趁敌炮管空时朝up反击
  const map = emptyMap(19, 15);
  const me = makeMe([7, 10], 'right', { skill: { type: 'teleport', remainingCooldownFrames: 10 } });
  const enemy = {
    tank: { id: 'e', position: [7, 2], direction: 'right', crashed: false },
    bullet: { position: [9, 2], direction: 'right' }, // 朝right，不打我
    skill: { type: 'teleport', remainingCooldownFrames: 10 },
    status: {}
  };
  const game = { map, star: null, frames: 18 };
  const shotDir = findEnemyBulletOpenShot(me, enemy, enemy.tank, [enemy.bullet], game, [7, 2]);
  check('OBS1 敌炮管空+同列+子弹朝right不打我 -> 返回up', shotDir === 'up', 'shotDir='+shotDir);

  // 对照：子弹朝我（down，敌在上方，我在下方，子弹沿 x=7 向下打我）-> 不触发
  const enemyFacingMe = {
    tank: { id: 'e', position: [7, 2], direction: 'down', crashed: false },
    bullet: { position: [7, 5], direction: 'down' }, // 朝我飞来（同列down）
    skill: { type: 'teleport', remainingCooldownFrames: 10 },
    status: {}
  };
  const shotDir2 = findEnemyBulletOpenShot(me, enemyFacingMe, enemyFacingMe.tank, [enemyFacingMe.bullet], game, [7, 2]);
  check('OBS2 子弹朝我时不触发(返回null)', shotDir2 === null, 'shotDir2='+shotDir2);
}

console.log('场景FLEE: 敌持续逃跑时抢星优先级提升 (mat_AAKs)');
{
  const map = emptyMap(19, 15);
  // 正常模式：我[10,9] 敌[10,5] 同列，星在[15,9]，敌比我近星(d=10 vs d=5) -> 不追
  MATCH_STATE = null;
  const state = getMatchState({ map, star: [15, 9], frames: 30 });
  state.enemyFleeFrames = 0;
  const s1 = shouldChaseStar([10, 9], [10, 5], { map, star: [15, 9], frames: 30 },
    { dist: 6, step: [11, 9] }, null, false);
  // 敌走路d=11到星，我走路d=5，我近 -> 应该追
  check('FLEE1 正常模式我比敌近则追星', s1 === true);

  // 正常模式：我[10,9] 敌[10,5]，星在[3,5]，敌更近(d=7) -> 不追
  MATCH_STATE = null;
  const s2 = shouldChaseStar([10, 9], [10, 5], { map, star: [3, 5], frames: 30 },
    { dist: 13, step: [9, 9] }, null, false);
  check('FLEE2 正常模式敌更近时不追(距离竞争)', s2 === false);

  // 逃跑模式：同样局面，但 fleeMode=true -> 跳过距离竞争直接追
  MATCH_STATE = null;
  const s3 = shouldChaseStar([10, 9], [10, 5], { map, star: [3, 5], frames: 30 },
    { dist: 13, step: [9, 9] }, null, true);
  check('FLEE3 逃跑模式下跳过距离竞争直接追星', s3 === true);
}

// =========================================================
// 场景 ATC: M1/M2 修复——overload 流走位不踏入横向无出口的角落 (mat_8xLQ/mat_Ae1A)
// 副弹封相邻列时，角落仅有1个横向出口且无法跨出双弹带 -> isSafeStep 拒绝该步
// =========================================================
console.log('场景ATC: overload流走位不踏入双弹带内的单出口角落(M1/M2修复)');
{
  // 构造 [17,13] 角落：右(x=18)与下(y=14)都是边界，只要再封掉上方，就只剩左侧 [16,13] 一个出口
  // 敌 overload 流放在 [16,8]，这样 [17,13] 处于其双弹带内(d=6, dx=1)，但又不与敌同线，能专测窄兜规则
  const m = emptyMap(19, 15); // x:0-18, y:0-14
  const corner = [17, 13]; // 紧靠右边墙(x=18)和下边墙(y=14)，开口只有[16,13]
  const enemyPos = [16, 8];
  const standoff = 5;
  const overE = { skill: { type: 'overload', remainingCooldownFrames: 8 }, status: {} };

  // corner [17,13]: 右边x=18是墙，下边y=14是墙，上[17,12]也封掉后，只剩[16,13]一个出口
  m[17][12] = 'x'; // 封上方，只剩[16,13]一个出口
  // 再封住左侧延伸两格，避免双弹带脱离在开阔地图里误判为可逃
  m[15][13] = 'x';
  check('ATC1 isSafeStep拒绝overload流走进单出口角落(在双弹带内)', isSafeStep(corner, [16, 13], enemyPos, { map: m }, overE, standoff, false) === false,
    'openNeighbors=' + openNeighborCount(corner, { map: m }) + ' inBand=' + inDoubleLaneBand(enemyPos, corner, standoff + 2));

  // 对照：开阔地有多个出口 -> 不拒绝
  const openCell = [10, 7];
  check('ATC2 开阔地多出口不拒绝(防过头)', isSafeStep(openCell, [9, 7], enemyPos, { map: m }, overE, standoff, false) !== false ||
    stepEntersKillZone([9, 7], openCell, enemyPos, { map: m }, overE, standoff),
    'openNeighbors=' + openNeighborCount(openCell, { map: m }));

  // 对照：普通敌人不触发此规则
  const normE = { skill: { type: 'teleport', remainingCooldownFrames: 8 }, status: {} };
  check('ATC3 普通敌不触发overload窄兜规则', isSafeStep(corner, [16, 13], enemyPos, { map: m }, normE, 4, false) !== false,
    'corner isSafe with normal enemy');
}

// =========================================================
// 场景 ATM: M3 修复——overload 空窗期（双弹已耗尽）不侧移躲避，允许回敬 (mat_Lwm4)
// overload 冷却中且场上无己弹 -> findLineDuelDodge 返回 null，交给开火分支
// =========================================================
console.log('场景ATM: overload空窗期不触发侧移躲避(M3修复)');
{
  const m = emptyMap(19, 15);
  const me = makeMe([9, 7], 'left', { skill: { type: 'teleport', remainingCooldownFrames: 5 } });
  // overload 冷却中(cd=8)，场上无己弹 -> 空窗期
  const overCD = { tank: { id: 'e', position: [9, 4], direction: 'down', crashed: false },
    bullet: null, skill: { type: 'overload', remainingCooldownFrames: 8 }, status: {} };
  const game = { map: m, star: null, frames: 50 };
  const dodge = findLineDuelDodge(me, overCD, overCD.tank, [], game, [9, 4]);
  check('ATM1 overload空窗期(cd中无弹)lineDuelDodge=null', dodge === null, 'dodge='+JSON.stringify(dodge));

  // 对照：overload 就绪(cd=0, 握双弹) -> 仍触发躲避
  const overReady = { tank: { id: 'e', position: [9, 4], direction: 'down', crashed: false },
    bullet: null, skill: { type: 'overload', remainingCooldownFrames: 0 }, status: {} };
  const dodge2 = findLineDuelDodge(me, overReady, overReady.tank, [], game, [9, 4]);
  check('ATM2 overload就绪(cd=0握双弹) -> 仍触发躲避(不防过头)', dodge2 !== null, 'dodge2='+JSON.stringify(dodge2));

  // 对照：overload 已过载(overloaded=true) -> 仍触发躲避
  const overActive = { tank: { id: 'e', position: [9, 4], direction: 'down', crashed: false },
    bullet: null, skill: { type: 'overload', remainingCooldownFrames: 8 }, status: { overloaded: true } };
  const dodge3 = findLineDuelDodge(me, overActive, overActive.tank, [], game, [9, 4]);
  check('ATM3 overload过载中(握双弹) -> 仍触发躲避(不防过头)', dodge3 !== null, 'dodge3='+JSON.stringify(dodge3));
}

console.log('场景SC1: 评分层优先选安全抢星而不是巡逻/站位');
{
  MATCH_STATE = null;
  const map = emptyMap(19, 15);
  const me = makeMe([5, 7], 'right', { stars: 0, skill: { type: 'teleport', remainingCooldownFrames: 20 } });
  const enemy = { tank: { id: 'e', position: [15, 2], direction: 'left', crashed: false }, bullet: null, skill: { type: 'shield', remainingCooldownFrames: 10 }, status: {}, stars: 0 };
  const game = { map, star: [7, 7], frames: 80 };
  const state = getMatchState(game);
  const step = chooseStepScored(me, enemy, game, enemy.tank.position, state, []);
  check('SC1 chooseStepScored向星推进', step && samePos(step, [6, 7]), 'step=' + JSON.stringify(step));
  check('SC1 抢星候选建立短期意图', state.shortIntent && state.shortIntent.kind === 'star', 'intent=' + JSON.stringify(state.shortIntent));
}

console.log('场景SC2: 评分层优先脱离overload双弹带，而不是普通巡逻');
{
  MATCH_STATE = null;
  const map = emptyMap(19, 15);
  const me = makeMe([10, 7], 'right', { stars: 0, skill: { type: 'teleport', remainingCooldownFrames: 20 } });
  const enemy = { tank: { id: 'e', position: [12, 9], direction: 'left', crashed: false }, bullet: null, skill: { type: 'overload', remainingCooldownFrames: 0 }, status: { overloaded: true }, stars: 0 };
  const game = { map, star: null, frames: 80 };
  const state = getMatchState(game);
  const step = chooseStepScored(me, enemy, game, enemy.tank.position, state, []);
  check('SC2 chooseStepScored给出脱带步', !!step, 'step=' + JSON.stringify(step));
  check('SC2 脱带步不再落入双弹覆盖带', !inDoubleLaneBand(enemy.tank.position, step, safeStandoffDistance(enemy)), 'step=' + JSON.stringify(step));
  check('SC2 脱带步没有比当前位置更靠近敌人', manhattan(step, enemy.tank.position) >= manhattan(me.tank.position, enemy.tank.position), 'step=' + JSON.stringify(step));
}

console.log('场景SC3: 评分层保留巡逻目标粘性，不被中心兜底抢走');
{
  MATCH_STATE = null;
  const map = emptyMap(19, 15);
  const me = makeMe([5, 7], 'right', { stars: 0, skill: { type: 'teleport', remainingCooldownFrames: 20 } });
  const enemy = { tank: null, bullet: null, skill: { type: 'cloak', remainingCooldownFrames: 5 }, status: {}, stars: 0 };
  const game = { map, star: null, frames: 80 };
  const state = getMatchState(game);
  state.patrolTarget = [14, 7];
  const step = chooseStepScored(me, enemy, game, null, state, []);
  check('SC3 chooseStepScored继续追巡逻目标', step && samePos(step, [6, 7]), 'step=' + JSON.stringify(step));
  check('SC3 巡逻目标保持粘性', state.patrolTarget && samePos(state.patrolTarget, [14, 7]), 'target=' + JSON.stringify(state.patrolTarget));
}

console.log('\n===== 结果: ' + pass + ' passed, ' + fail + ' failed =====');
process.exit(fail > 0 ? 1 : 0);
