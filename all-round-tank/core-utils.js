// ============================================================
// core-utils.js — 纯工具函数层
//
// 几何/寻路/子弹计算/敌情感知/移动执行等无策略逻辑的基础函数。
// 所有上层模块（tactics.js / movement-engine.js / BT nodes）共同依赖此文件。
// ============================================================

/**
 * AgenTank 坦克对战 AI 脚本
 * 
 * 引擎会在你的坦克空闲（动作队列为空）时调用 onIdle 函数。
 * 该脚本实现了一个基于优先级决策树的战术 AI，按紧急程度从上到下进行判断。
 * 
 * ================= onIdle 参数详解 =================
 * 
 * 1. me (自身状态与动作接口)
 * ---------------------------------------------------
 * - me.tank.id: 坦克ID
 * - me.tank.position: 你的坐标，格式为 [x, y]
 * - me.tank.direction: 你的车头朝向 ("up", "down", "left", "right")
 * - me.tank.crashed: 是否处于撞击状态（布尔值）
 * - me.bullet: 你当前发射在场上的子弹对象（无则为 null）
 *    └─ me.bullet.position: 子弹坐标 [x, y]
 *    └─ me.bullet.direction: 子弹飞行方向 ("up", "down", "left", "right")
 * - me.stars: 当前收集到的星星数量
 * - me.skill: 技能信息
 *    └─ me.skill.type: 技能类型字符串（如 "shield", "teleport" 等）
 *    └─ me.skill.cooldownFrames: 技能基础冷却帧数
 *    └─ me.skill.remainingCooldownFrames: 距离下次可用的剩余冷却帧数（0 表示可用）
 *    └─ me.skill.activeRemainingFrames: 技能生效中的剩余帧数
 *    └─ me.skill.activeType: 生效中的技能类型
 * - me.effects: 包含正在影响你的 Buff/Debuff
 *    └─ me.effects.self: 自身增益效果对象，如 { type: "shield", remainingFrames: 2 } 或 null
 *    └─ me.effects.debuff: 负面状态对象，如 { type: "stun", remainingFrames: 1 } 或 null
 * - me.status: 状态集合（布尔值）
 *    └─ shielded(护盾中), cloaked(隐身中), boosted(加速中), overloaded(过载中)
 *    └─ frozen(冰冻), stunned(眩晕), poisoned(中毒)
 *    └─ fireLocked(传送开火锁定)
 *    └─ actionSpeed: 动作速度（默认为 1，即每帧处理 1 个指令）
 *    └─ canActThisFrame: 此帧是否可以行动
 * 
 * 可调用的动作（调用后将加入队列延后执行）：
 * - me.go() / me.go(2) : 前进一格 / 放入两次前进指令
 * - me.turn("left") / me.turn("right") : 转向
 * - me.fire() : 开火
 * - me.speak("text") / speak("text") : 气泡发言（仅回放视觉效果）
 * - me.shield() / me.teleport(x, y) / me.poison() 等技能调用 (需匹配你的技能类型)
 * 
 * 2. enemy (敌方状态)
 * ---------------------------------------------------
 * (注意：当敌人隐身或躲在草丛时，enemy.tank 和部分信息可能为 null)
 * - enemy.tank: 敌方坦克对象
 *    └─ enemy.tank.id / position [x,y] / direction / crashed
 * - enemy.bullet: 敌方发射且在你有视野范围内的子弹对象
 *    └─ enemy.bullet.position [x,y] / direction
 * - enemy.skill: 敌方的技能对象（结构同 me.skill，完全公开）
 * - enemy.effects / enemy.status: 敌方身上的状态信息集合（结构同 me，用于判断敌方是否开盾、被控等）
 * 
 * 3. game (全局游戏与地图状态)
 * ---------------------------------------------------
 * - game.map: 二维数组，game.map[x][y] 表示特定坐标的地形：
 *             "x"=墙壁，"m"=可破坏的土块，"o"=草丛(可隐蔽)，"."=空地
 * - game.star: 当前地图上星星的坐标 [x, y]，无星星时为 null
 * - game.frames: 比赛当前进行到的帧数
 * 
 * ================= 游戏与胜利规则 =================
 * 1. 胜利条件：
 *    - 击毁敌方坦克：子弹命中且未被护盾抵挡。
 *    - 当比赛超时未分出胜负时，收集星星（game.star）更多的一方获胜。
 * 
 * 2. 基础规则：
 *    - 回合制网格：游戏按帧(Frame)推进，每帧你默认能执行1个动作指令（如 me.go()）。
 *    - 视野规则：所有坐标均为 [x,y] 数组。草丛 "o" 会让坦克隐身（此时 enemy.tank = null）；敌方子弹在没有视野遮挡时才可见。
 *    - 开火限制：场上同时只能存在1发己方子弹（除非使用过载）。只有当上一发子弹销毁（撞墙、打碎土块、击中坦克、飞出边界或被护盾阻挡）后，你才能再次发射。
 * 
 * 3. 计分与排位防刷机制：
 *    - 挑战同一对手的同一张固定地图，只有第一次计入排位分，后续重复挑战只记录胜负不加分。
 *    - 使用随机地图（Random map）挑战同一对手可重复加分，但如果在24小时内连胜同一个对手 50 次，后续胜场将不再加分，直到连胜中断。
 *    - 冠军段位的坦克击败非冠军段位的坦克，不会获得排位分。
 * 
 * ================= 专属技能详解 (Skills) =================
 * 每个坦克只有 1 个固定技能，调用前需检查冷却：me.skill.remainingCooldownFrames === 0
 * 
 * 1. me.shield() - 护盾
 *    - 执行前限制：无特殊要求。
 *    - 效果：获得最多持续 4 帧的护盾，能抵挡 1 发子弹（抵挡后立刻碎裂）。
 *    - 执行后限制：冷却 30 帧。
 * 
 * 2. me.freeze() - 冰冻
 *    - 执行前限制：无特殊要求，但建议确认敌方未处于冰冻/无敌状态。
 *    - 效果：使敌方坦克在接下来的 2 帧内无法执行动作（对方动作队列暂停，结束后恢复）。
 *    - 执行后限制：冷却 34 帧。
 * 
 * 3. me.stun() - 眩晕
 *    - 执行前限制：无特殊要求。
 *    - 效果：使敌方坦克的转向和移动控制在 6 帧内随机化（可能正常执行或反向执行）。
 *    - 执行后限制：冷却 25 帧。
 * 
 * 4. me.overload() - 过载
 *    - 执行前限制：无特殊要求。
 *    - 效果：使下一次有效射击直接发射 2 颗子弹。该状态最多保持 10 帧，超时未开火则失效。
 *    - 执行后限制：冷却 32 帧。
 * 
 * 5. me.cloak() - 隐身
 *    - 执行前限制：无特殊要求。
 *    - 效果：对敌方脚本隐身 6 帧（在此期间敌方读取 enemy.tank 会得到 null）。
 *    - 执行后限制：冷却 35 帧。
 * 
 * 6. me.poison() - 毒药
 *    - 执行前限制：无系统硬性限制，但建议在有效范围内且敌方未中毒时施放。
 *    - 效果：减慢敌方坦克的动作执行频率，持续 4 帧。
 *    - 执行后限制：冷却 25 帧。
 * 
 * 7. me.boost() - 加速
 *    - 执行前限制：无特殊要求。
 *    - 效果：提升移动速度持续 6 帧。期间执行一次 me.go() 可前进最多 2 格（遇障碍提前停）。
 *    - 执行后限制：冷却 31 帧。
 * 
 * 8. me.teleport(x, y) - 传送
 *    - 执行前限制：目标 [x, y] 必须是合法空地或草丛，不能是墙壁、土块或被敌方坦克/子弹占据。目标无效依然会导致传送失败并消耗冷却！
 *    - 效果：瞬间传送到目标坐标，但不改变车头朝向（建议先瞄准再传）。
 *    - 执行后限制：冷却 40 帧。特别注意：若落点距敌方曼哈顿距离 <= 4，在接下来的 2 帧内将被“开火锁定”(fireLocked)，无法射击。
 * 
 * ===================================================
 */

// ================= 常量定义 =================

// 四个基本方向及其坐标偏移量
const DIRS = [
  { name: "up", dx: 0, dy: -1 },
  { name: "right", dx: 1, dy: 0 },
  { name: "down", dx: 0, dy: 1 },
  { name: "left", dx: -1, dy: 0 }
];

// 子弹轨迹预判距离（格）
const BULLET_LOOKAHEAD_TILES = 8;
// 子弹速度：每帧前进 2 格（由对局 replay 逆向得出，弹道时间换算的核心参数）
const BULLET_SPEED = 2;
// 刺杀传送的最小与最大距离
const ASSASSIN_MIN_RANGE = 5;
const ASSASSIN_MAX_RANGE = 8;
// 一局总帧数（从 replay 逆向：超时按星数判胜负，见 mat_7JO 打满 128 帧）
var MAX_GAME_FRAMES = 128;
// 冰冻技能锁定帧数（replay mat_0Wmx 逆向：applied durationFrames:2，被冻 2 帧不能移动/转向）
const FREEZE_DURATION = 2;
// 认定对方是"跑路流"的连续背向帧阈值：对方连续 N 帧同线却背对我，视为只逃不战（mat_AAKs "小虾"）
const ENEMY_FLEE_THRESHOLD = 5;

const DIR_DELTAS = { up: [0, -1], down: [0, 1], left: [-1, 0], right: [1, 0] };
const BOMB_FUSE_FRAMES = 10;
const BOMB_BLAST_RANGE = 2;
const BOMB_COOLDOWN_FRAMES = 10;

var _bfsCache = {};
var _bfsCacheFrame = -1;
var _bfsCacheGame = null;


// ================= 辅助函数 =================

/**
 * 判断是否可以射击
 */
function canShoot(me, enemy) {
  if (!gunReady(me)) return false; // 炮管未就绪
  if (enemy.status && enemy.status.shielded) return false; // 敌人开着护盾不打
  return true;
}


/**
 * 敌方是否为 shield 流：拥有 shield 技能，不论此刻是否已开盾。
 */
function enemyHasShieldSkill(enemy) {
  return !!(enemy && enemy.skill && enemy.skill.type === "shield");
}


/**
 * 判断炮管是否就绪（场上无自己子弹且未被开火锁定）
 */
function gunReady(me) {
  return !me.bullet && !(me.status && me.status.fireLocked);
}


/**
 * 判断传送技能是否就绪
 */
function teleportReady(me) {
  return !!me.teleport && me.skill && me.skill.remainingCooldownFrames === 0;
}


/**
 * 敌方是否拥有传送技能（结构同 me.skill，完全公开）。用于禁用对传送敌人的刺杀。
 */
function enemyHasTeleport(enemy) {
  return !!(enemy && enemy.skill && enemy.skill.type === "teleport");
}


/**
 * 敌方传送是否就绪（本帧/下帧可瞬移）。teleport 敌人威胁来自"能瞬移到星星的行/列上狙击星点"，
 * 与它当前离星远近无关（mat_JOj 敌从 [16,12] 一跳到星同行 [15,4]，曼哈顿 9 也够得着）。
 * 所以"是否会来抢这颗星"要看传送冷却，不能只看当前距离。
 */
function enemyTeleportReady(enemy) {
  return enemyHasTeleport(enemy) && enemy.skill && (enemy.skill.remainingCooldownFrames || 0) <= 1;
}


/**
 * 敌方是否构成"双弹相邻列"威胁：已过载(下次开火即双弹)，或技能是 overload 且冷却就绪(随时可过载)。
 * 过载双弹一发走敌人正行/列，另一发走相邻 ±1 行/列(replay mat_EHR/mat_73I 逆向证实)，
 * 故安全判定不能只看严格同线，敌人相邻行/列近距也要算危险。
 */
function enemyDoubleLaneThreat(enemy) {
  if (!enemy) return false;
  if (enemy.status && enemy.status.overloaded) return true; // 已过载，下一发就是双弹
  // overload 流且冷却就绪：逼近到位即可放过载双弹(mat_73I 敌迎面逼近才过载)
  return !!(enemy.skill && enemy.skill.type === "overload" &&
    enemy.skill.remainingCooldownFrames !== undefined &&
    enemy.skill.remainingCooldownFrames <= 1);
}


/**
 * 敌方是否为 overload(双弹)流：拥有 overload 技能，不论此刻冷却与否。
 * 即使技能在冷却，它也会冷却好就过载双弹——所以对这类敌人不能贴身缠斗，应保持保守间距、以抢星走位为主。
 * (mat_D9W：金闪闪 overload 冷却中时我 standoff 退回4格贴到 d=1~4 缠斗，等它冷却好一过载就被双弹贴脸秒。)
 */
function enemyIsOverloadType(enemy) {
  return !!(enemy && enemy.skill && enemy.skill.type === "overload");
}


/**
 * 敌方是否为 freeze(冰冻)流：拥有 freeze 技能，不论此刻冷却与否。
 * 冰冻命中后锁我 FREEZE_DURATION(=2) 帧不能移动/转向——这 2 帧里敌人可从容转向对准再开火，
 * 我完全无法躲(mat_0Wmx：敌贴到相邻列 d=1 冻我 2 帧，转身一炮点死)。
 * 故对 freeze 流敌人不能贴身，必须保持"即使被冻也来不及被打到"的安全间距。
 */
function enemyIsFreezeType(enemy) {
  return !!(enemy && enemy.skill && enemy.skill.type === "freeze");
}


/**
 * 敌方是否为 stun(眩晕)流：拥有 stun 技能，不论此刻冷却与否。
 * stun 全图施放无视距离，命中后 6 帧内我方 go/turn 各 50% 反向(fire 不受影响)。
 * 拉不开"施放距离"，但保持 5 格可让"眩晕期间敌对准+开火"打不满，留侧移离线余量。
 */
function enemyIsStunType(enemy) {
  return !!(enemy && enemy.skill && enemy.skill.type === "stun");
}


/**
 * 敌方是否为 poison(毒雾)流：拥有 poison 技能，不论此刻冷却与否。
 * poison 全图施放无视距离，命中后 4 帧内我方只偶数帧能动(动作减半)。
 * 移动方向不乱，但反应被拖慢——保持 5 格留出隔帧躲弹的余量。
 */
function enemyIsPoisonType(enemy) {
  return !!(enemy && enemy.skill && enemy.skill.type === "poison");
}


/**
 * 敌方是否为 cloak(隐身)流：拥有 cloak 技能，不论此刻是否隐身。
 * 隐身敌会 cast cloak 后悄悄绕到我正后方同行/同列(我看不见它真实位置)，再从背后一炮偷袭。
 * 此时若我沿单一行/列直线逃，2 格/帧的子弹必从背后追上(mat_L4l9：敌隐身滑到我同行 y=6 背后，
 * 我沿 y=6 连走 3 格直线退被追死)。对这类敌人逃跑要走"斜线/之字"——每帧换行又换列，
 * 让隐身敌无论藏在我哪条线背后，其直线子弹到达时我都已离开那条线。
 */
function enemyIsCloakType(enemy) {
  return !!(enemy && enemy.skill && enemy.skill.type === "cloak");
}


/**
 * 敌方是否为"被动跑分型 teleport 流"：拥有 teleport 技能(双弹/过载等近身杀伤威胁低)，且此刻没有实弹在途、
 * 也没瞄准我。这类对手(mat_GwxblYdS 小强)只靠走路/瞬移抢星、几乎不主动对射——我吃完星后无需为躲它而跑向
 * 外圈/对侧远角(那样会把中心争星位让出去，下一颗星刷新时反而离得远)。无星空窗期应守在地图中心十字区，
 * 离任何方向新刷的星都近，抢星更快。仅 teleport 流且当前安全时成立；敌有实弹/瞄我时仍正常避让。
 */
function enemyIsPassiveRusher(enemy, enemyTank, game, myPos) {
  if (!enemyHasTeleport(enemy)) return false;            // 仅针对 teleport 流(无双弹近身秒杀威胁)
  if (enemy && enemy.bullet && enemy.bullet.position) return false; // 有实弹在途 -> 真威胁，正常避让
  if (enemyTank && myPos && enemyAimsAt(myPos, enemyTank, game)) return false; // 正瞄我 -> 正常避让
  return true;
}


/**
 * 我此刻是否藏在草丛里（对敌方脚本隐身）。草丛 'o' 或被冰冻/技能标记 cloaked 均算。
 */
function iAmHidden(me, game) {
  return !!((me.status && me.status.cloaked) || tileAt(game, me.tank.position) === "o");
}


/**
 * 通用 BFS 寻路算法（寻找符合 isGoal 条件的最近格子，并返回第一步移动方向）
 */
function nextStepToGoal(start, game, enemyPos, isGoal) {
  const w = game.map.length;
  const h = game.map[0].length;
  const queue = [start];
  const seen = {};
  const prev = {};
  seen[key(start)] = true;

  for (let qi = 0; qi < queue.length; qi++) {
    const p = queue[qi];
    if (isGoal(p)) return firstStep(start, p, prev); // 找到目标，回溯第一步
    
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


/**
 * 将一组子弹沿各自方向推进 steps 格，返回推进后的子弹快照（仅用于躲避预演，不改原对象）。
 */
function advanceBullets(bullets, steps) {
  const out = [];
  for (let i = 0; i < bullets.length; i++) {
    const b = bullets[i];
    if (!b || !b.position) continue;
    const d = DIRS[dirIndex(b.direction)];
    if (!d) { out.push(b); continue; }
    out.push({ position: [b.position[0] + d.dx * steps, b.position[1] + d.dy * steps], direction: b.direction });
  }
  return out;
}


/**
 * 过载预判：overload 已生效但实弹尚未出现在 enemy.bullet 时，敌人下一次开火会覆盖
 * 当前炮线 + 固定偏移副弹线。若我正站在这两条线的前方，提前按防瞄脱线。
 *
 * 复盘来源：
 * - mat_1guaZzTITzy2DLjwn：敌 up 双弹覆盖 x=13/14，我在 x=14 线上继续走位被副弹命中。
 * - mat_L2dcAhIU0ia3QghC6：敌 right 双弹覆盖 y=3/4，我在 y=4 线上横走被副弹命中。
 */
function predictedOverloadBullets(enemyTank) {
  if (!enemyTank || !enemyTank.position || !enemyTank.direction) return [];
  const ep = enemyTank.position;
  const dir = enemyTank.direction;
  const bullets = [{ position: [ep[0], ep[1]], direction: dir, _predictedOverload: true }];
  if (dir === "left" || dir === "right") {
    bullets.push({ position: [ep[0], ep[1] + 1], direction: dir, _predictedOverload: true });
  } else {
    bullets.push({ position: [ep[0] + 1, ep[1]], direction: dir, _predictedOverload: true });
  }
  return bullets;
}


// 预判双弹覆盖带（含两侧 ±1 行/列）。
// 实际副弹固定走 +1，但我方不知道敌人会向哪侧开火；±1 都预测，
// 确保-1侧（对角方向）也被 predictedOverloadThreatens 识别为危险区。
function predictedOverloadBulletsAll(enemyTank) {
  if (!enemyTank || !enemyTank.position || !enemyTank.direction) return [];
  const ep = enemyTank.position;
  const dir = enemyTank.direction;
  const bullets = [{ position: [ep[0], ep[1]], direction: dir, _predictedOverload: true }];
  if (dir === "left" || dir === "right") {
    bullets.push({ position: [ep[0], ep[1] + 1], direction: dir, _predictedOverload: true });
    bullets.push({ position: [ep[0], ep[1] - 1], direction: dir, _predictedOverload: true });
  } else {
    bullets.push({ position: [ep[0] + 1, ep[1]], direction: dir, _predictedOverload: true });
    bullets.push({ position: [ep[0] - 1, ep[1]], direction: dir, _predictedOverload: true });
  }
  return bullets;
}


function predictedOverloadThreatens(enemy, pos, game) {
  if (!enemy || !pos) return false;
  if (!enemyDoubleLaneThreat(enemy)) return false;
  if (!enemyCanFireSoon(enemy)) return false;
  const predicted = predictedOverloadBulletsAll(enemy.tank);
  return anyBulletThreatens(predicted, pos, game) || stepIntoBulletPath(predicted, pos, game);
}


/**
 * 敌人是否在接下来一两帧内具备开火能力：炮管就绪（场上无敌弹）或处于过载（可补发第二弹）。
 */
function enemyCanFireSoon(enemy) {
  if (!enemy) return false;
  const overloaded = enemy.status && enemy.status.overloaded;
  const hasBulletOut = enemy.bullet && enemy.bullet.position;
  // 过载时即使有一发在途仍能再发；否则需场上无己弹才能开火
  if (overloaded) return true;
  return !hasBulletOut;
}


/**
 * 计算子弹沿其飞行方向到达 pos 还需经过多少格；若 pos 不在弹道上、方向不对或中间有遮挡，返回 -1。
 */
function bulletReachTiles(bullet, pos, game) {
  if (!bullet || !bullet.position) return -1;
  const bp = bullet.position;
  // 同一列：子弹上下飞
  if (bp[0] === pos[0]) {
    const dy = pos[1] - bp[1];
    // 我在子弹下方
    if (bullet.direction === "down" && dy > 0) return clearBetween(bp, pos, game) ? dy : -1;
    // 我在子弹上方
    if (bullet.direction === "up" && dy < 0) return clearBetween(bp, pos, game) ? -dy : -1;
  }
  // 同一行：子弹左右飞
  if (bp[1] === pos[1]) {
    const dx = pos[0] - bp[0];
    // 我在子弹右方
    if (bullet.direction === "right" && dx > 0) return clearBetween(bp, pos, game) ? dx : -1;
    // 我在子弹左方
    if (bullet.direction === "left" && dx < 0) return clearBetween(bp, pos, game) ? -dx : -1;
  }
  return -1;
}


/**
 * 子弹还要几帧才会到达 pos（子弹 2 格/帧）。不在弹道上返回 -1。
 */
function bulletFramesTo(bullet, pos, game) {
  const tiles = bulletReachTiles(bullet, pos, game);
  if (tiles < 0) return -1;
  return Math.ceil(tiles / BULLET_SPEED);
}


/**
 * 判断指定坐标是否受到给定子弹的威胁
 */
function bulletThreatens(bullet, pos, game) {
  const tiles = bulletReachTiles(bullet, pos, game);
  return tiles >= 0 && tiles <= BULLET_LOOKAHEAD_TILES;
}


/**
 * 走位安全：走到 cell 这一帧子弹也会前进 BULLET_SPEED 格，判断 cell 是否会被子弹"扫到"。
 * 覆盖三种：
 *  1. cell 当前就在弹道(bulletThreatens)；
 *  2. 子弹推进一帧后正好落在 cell（走过去同帧相撞）；
 *  3. 子弹当前已在 cell（bulletReachTiles 对 dx=0 返回 -1，bulletThreatens 漏判）。
 * 修复"从安全行/列走进相邻子弹路径被同帧撞死"（mat_1BN/mat_KkKOc/mat_HTmg）。
 * 修复"子弹停在目标格时走过去送死"（mat_5Otwt1NRz03KNip9H：子弹 dx=0 漏判）。
 */
function stepIntoBulletPath(bullets, cell, game) {
  const list = bullets || [];
  for (let i = 0; i < list.length; i++) {
    const b = list[i];
    if (!b || !b.position) continue;
    if (samePos(b.position, cell)) return true;         // 子弹已在目标格，走过去必被命中
    if (bulletThreatens(b, cell, game)) return true;    // 已在弹道
    // 子弹推进一帧(2格)后是否落在/扫过 cell
    const d = DIRS[dirIndex(b.direction)];
    if (!d) continue;
    for (let step = 1; step <= BULLET_SPEED; step++) {
      const bp = [b.position[0] + d.dx * step, b.position[1] + d.dy * step];
      if (samePos(bp, cell)) return true;
    }
  }
  return false;
}


/**
 * 汇总当前所有可见的敌方子弹（过载会发 2 发，引擎可能用 enemy.bullets 数组或 enemy.bullet 单体暴露）。
 */
function collectEnemyBullets(enemy) {
  if (!enemy) return [];
  const out = [];
  if (Array.isArray(enemy.bullets)) {
    for (let i = 0; i < enemy.bullets.length; i++) {
      if (enemy.bullets[i] && enemy.bullets[i].position) out.push(enemy.bullets[i]);
    }
  }
  if (enemy.bullet && enemy.bullet.position) {
    // 避免与 bullets 数组重复
    let dup = false;
    for (let i = 0; i < out.length; i++) {
      if (samePos(out[i].position, enemy.bullet.position) && out[i].direction === enemy.bullet.direction) dup = true;
    }
    if (!dup) out.push(enemy.bullet);
  }
  // 过载双弹但 API 只暴露 1 发：按双弹机制补出平行的配对弹(同方向同进度，在相邻车道)。
  // 否则闪避时只看到副弹、把主弹行当安全躲过去送死(mat_LBH 副弹y=13可见、主弹y=12看不见，误往y=12躲)。
  // 敌开火后垂直移开车道时锚点不可信，inferOverloadPairedBullet 会两侧都补，保证真实弹不漏判(mat_8iF)。
  const paired = inferOverloadPairedBullet(enemy, out);
  for (let i = 0; i < paired.length; i++) out.push(paired[i]);
  return out;
}


/**
 * 过载双弹只可见 1 发时，推断配对弹的位置。
 * 双弹走两条平行相邻车道(敌正行/列 + 相邻±1)，同方向同进度。已知可见弹与敌人位置：
 * - 可见弹在敌正行/列 -> 配对弹在相邻车道(朝飞行方向的右手侧或离敌正行 ±1)；
 * - 可见弹在相邻行/列 -> 配对弹在敌正行/列。
 * 用"敌正行/列"锚定：配对车道 = 关于敌正行/列对称镜像或敌正行/列本身。保守地：取与可见弹平行、
 * 垂直偏移到"敌人所在的那条行/列"的弹（覆盖最危险的主弹道）；若可见弹已在敌正行/列，则补相邻一条。
 */
function inferOverloadPairedBullet(enemy, bullets) {
  if (!enemy || bullets.length !== 1) return []; // 只在恰好可见 1 发时推断
  const overloadActive = (enemy.status && enemy.status.overloaded) ||
    (enemy.skill && enemy.skill.type === "overload");
  if (!overloadActive) return [];
  const ep = enemy.tank && enemy.tank.position;
  if (!ep) return [];
  const b = bullets[0];
  const dir = b.direction;
  const horizontal = dir === "left" || dir === "right"; // 水平飞 -> 双弹分布在不同行(y)；竖直飞 -> 不同列(x)
  // 可见弹所在车道(水平飞看 y，竖直飞看 x)。双弹是相邻两条平行车道(差 1)：主弹在敌开火行/列，
  // 副弹恒在主弹 +1。给定可见弹，真实配对弹只可能在 visLane-1(可见的是副弹) 或 visLane+1(可见的是主弹)。
  // 这里用“敌开火行/列”为锚点再镜像出对侧车道，保证无论敌在后续移动到哪，真实主/副弹都被覆盖到。
  const visLane = horizontal ? b.position[1] : b.position[0];
  const enemyLane = horizontal ? ep[1] : ep[0];
  // 关键修复(mat_8iF)：双弹车道在**开火瞬间**由敌位置决定且固定不变。敌开火后会移动——
  // 用敌"当前"位置锚定哪侧是配对弹并不可靠(敌沿子弹方向移动时锚点恰好可信，垂直移动后就失真，
  // 会把配对弹算到错误行/列、漏判真实那发被秒)。鉴于漏判=被秒，无法 100% 确定哪侧时宁可**两侧都补**：
  //   - 敌仍在可见弹车道(可见主弹) -> 配对副弹必在 +1，补单侧(不过度保守)；
  //   - 否则(可见副弹 或 敌已垂直移开) -> 真实配对弹在 -1 或 +1 不确定，两侧都补，保证真实弹必被覆盖。
  const lanes = (enemyLane === visLane) ? [visLane + 1] : [visLane - 1, visLane + 1];
  const inferredBullets = lanes.map(lane => ({
    position: horizontal ? [b.position[0], lane] : [lane, b.position[1]],
    direction: dir,
    _inferred: true
  }));

  return inferredBullets;
}


/**
 * 任意一发子弹是否威胁到 pos
 */
function anyBulletThreatens(bullets, pos, game) {
  for (let i = 0; i < bullets.length; i++) {
    if (bulletThreatens(bullets[i], pos, game)) return true;
  }
  return false;
}


/**
 * 这些子弹中，最快多少帧会打到 pos（取最小）。都打不到返回 -1。
 */
function minBulletFramesTo(bullets, pos, game) {
  let best = -1;
  for (let i = 0; i < bullets.length; i++) {
    const f = bulletFramesTo(bullets[i], pos, game);
    if (f >= 0 && (best < 0 || f < best)) best = f;
  }
  return best;
}


/**
 * 寻路移动助手。如果下一步不安全，就改走最快脱离的安全方向（避免转向→撞墙→转回的死循环）。
 */
function moveToward(me, game, next, enemyPos, enemyTank, enemyBullets, enemy) {
  const myPos = me.tank.position;
  const bullets = enemyBullets || [];

  // 危险校验：不通、被预瞄、会接子弹(含子弹下一帧扫过该格) -> 改用最快脱离逻辑
  if (!isPassable(game, next, enemyPos) ||
      enemyAimsAt(next, enemyTank, game) ||
      stepIntoBulletPath(bullets, next, game) ||
      predictedOverloadThreatens(enemy, next, game)) {
    const escape = fastestEscapeNeighbor(me, game, enemyPos, enemyTank, bullets, enemy);
    if (escape) {
      const edir = directionBetween(myPos, escape);
      // 当前朝向即脱离方向 -> 立刻前进（不浪费一帧转向）；否则转向它
      if (edir === me.tank.direction) me.go();
      else turnToward(me, edir);
      return;
    }
    // 实在没有更优安全格：只有当前前方也安全时才直走；否则宁可原地转向也不能踩进子弹。
    // No.1 复盘(mat_FPf/mat_8aY)：旧兜底只检查可通行，会把我从 [1,12] 推进 [2,12] 接下行弹。
    const ahead = nextInDirection(myPos, me.tank.direction);
    if (isPassable(game, ahead, enemyPos) &&
        !enemyAimsAt(ahead, enemyTank, game) &&
        !stepIntoBulletPath(bullets, ahead, game) &&
        !predictedOverloadThreatens(enemy, ahead, game)) me.go();
    else me.turn("right");
    return;
  }

  const dir = directionBetween(myPos, next);
  if (!dir) return;

  // 方向一致则前进，否则转向该方向
  if (me.tank.direction === dir) {
    me.go();
  } else {
    turnToward(me, dir);
  }
}


/**
 * 打破"靠墙原地空转"死循环（见 mat_Enkd 转 7 帧被打死）。
 * 已连续多帧没移动，说明走位目标一直要求转向却走不出去。此处确定性地：
 *  - 优先：当前朝向格可走且安全 -> 立刻 go（一帧就移动，彻底脱离）；
 *  - 否则：按固定方向顺序挑第一个"可走且安全"的方向转过去（下一帧即可 go）；
 *  - 都不安全：挑第一个可走方向转过去（至少打破原地空转）。
 * "安全"= 可通行、不在敌方炮线、不在子弹弹道。
 */
function breakStuckStep(me, game, enemyPos, enemyTank, enemyBullets, prevPos, enemy) {
  const myPos = me.tank.position;
  const bullets = enemyBullets || [];
  // prevPos: 上上帧的坐标（lastMyPos2），排除"回头格"，防止 A↔B 乒乓震荡
  const safe = (p) => isPassable(game, p, enemyPos) &&
    !enemyAimsAt(p, enemyTank, game) &&
    !anyBulletThreatens(bullets, p, game) &&
    !predictedOverloadThreatens(enemy, p, game) &&
    !(prevPos && samePos(p, prevPos));

  // 当前朝向可直接走且安全 -> 立刻前进
  const ahead = nextInDirection(myPos, me.tank.direction);
  if (safe(ahead)) { me.go(); return; }

  // 破墙优先：若有土块可打通通道，优先破墙而非来回横跳
  // （mat_BavjL：[12,12]↔[12,13]震荡，right=[13,12]是土块，打通后可真正逃离）
  if (gunReady(me)) {
    // 只要被卡住了，就尽量往地图中心方向破墙逃生，不要管是不是离敌人更远了（被卡死必输）
    const digTarget = nearestOpenToCenter(game);
    const digDir = findDigDirection(myPos, game, digTarget);
    if (digDir) {
      if (me.tank.direction === digDir) { me.speak("破墙！"); me.fire(); }
      else turnToward(me, digDir);
      return;
    }
  }

  // 找第一个可走且安全的方向转过去（确定性，避免左右横跳）
  let fallback = null;
  for (let i = 0; i < DIRS.length; i++) {
    const p = [myPos[0] + DIRS[i].dx, myPos[1] + DIRS[i].dy];
    if (!isPassable(game, p, enemyPos)) continue;
    if (fallback === null) fallback = DIRS[i].name;
    if (safe(p)) { turnToward(me, DIRS[i].name); return; }
  }

  if (fallback) { turnToward(me, fallback); return; }
  me.turn("right"); // 四面皆墙，原地转
}


/**
 * 在被子弹/预瞄威胁时，选出"最快脱离"的相邻安全格。
 * 评分核心：脱离总耗时 = 转向帧(当前朝向=0,否则1) + 前进帧(1)，越小越优；
 * 同耗时再比远离边缘。当前朝向方向享有优先级，确保跨帧决策稳定、不横跳。
 */
function fastestEscapeNeighbor(me, game, enemyPos, enemyTank, bullets, enemy) {
  const myPos = me.tank.position;
  let best = null;
  let bestCost = 99;
  let bestTie = -9999;
  for (let i = 0; i < DIRS.length; i++) {
    const d = DIRS[i];
    const p = [myPos[0] + d.dx, myPos[1] + d.dy];
    if (!isPassable(game, p, enemyPos)) continue;
    if (stepIntoBulletPath(bullets, p, game)) continue; // 脱离格不能在弹道上，也不能被子弹下一帧扫到
    if (predictedOverloadThreatens(enemy, p, game)) continue; // 过载就绪时，预判双弹车道也不能作为逃生格
    if (enemyAimsAt(p, enemyTank, game)) continue;       // 也不能撞进敌方炮线

    const turnFrames = d.name === me.tank.direction ? 0 : 1;
    const cost = turnFrames + 1; // +1 为前进帧
    const tie = distanceFromEdges(p, game);
    if (cost < bestCost || (cost === bestCost && tie > bestTie)) {
      bestCost = cost;
      bestTie = tie;
      best = p;
    }
  }
  return best;
}


/**
 * 根据目标方向，选择最优的左转或右转策略
 */
function turnToward(me, desired) {
  const cur = dirIndex(me.tank.direction);
  const dst = dirIndex(desired);
  if (cur < 0 || dst < 0 || cur === dst) return;
  const diff = (dst - cur + 4) % 4;
  if (diff === 1) me.turn("right");
  else if (diff === 3) me.turn("left");
  else me.turn("right"); // 转180度时随便选一个方向
}


/**
 * 计算两个方向之间需要转几次（90度=1次，180度=2次）
 */
function turnDistance(from, to) {
  const cur = dirIndex(from);
  const dst = dirIndex(to);
  if (cur < 0 || dst < 0) return 2;
  const diff = (dst - cur + 4) % 4;
  return Math.min(diff, 4 - diff);
}


/**
 * 获取走向目标坐标的下一步（基于BFS）
 */
function nextStepToward(start, target, game, enemyPos) {
  const info = shortestPathInfo(start, target, game, enemyPos);
  return info ? info.step : null;
}

function shortestPathInfo(start, target, game, blockPos) {
  if (!target) return null;
  if (samePos(start, target)) return { dist: 0, step: null };

  const frame = (game && game.frames) || 0;
  // 帧号变化 或 game 对象本身换了(不同对局/不同测试场景常都在 frame 0) → 翻新缓存，防跨场景脏命中
  if (frame !== _bfsCacheFrame || game !== _bfsCacheGame) {
    _bfsCache = {}; _bfsCacheFrame = frame; _bfsCacheGame = game;
  }
  const cacheKey = key(start) + ">" + key(target) + ">" + (blockPos ? key(blockPos) : "_");
  const cached = _bfsCache[cacheKey];
  if (cached !== undefined) {
    return cached ? { dist: cached.dist, step: cached.step ? [cached.step[0], cached.step[1]] : null } : null;
  }

  const result = _computeShortestPathInfo(start, target, game, blockPos);
  _bfsCache[cacheKey] = result;
  return result ? { dist: result.dist, step: result.step ? [result.step[0], result.step[1]] : null } : null;
}


function _computeShortestPathInfo(start, target, game, blockPos) {
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

      // 非目标格要求可通过，目标格可以容忍被敌人占据
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


/**
 * 回溯记录本获取前往目标的第一步坐标
 */
function firstStep(start, target, prev) {
  let cur = target;
  while (prev[key(cur)] && !samePos(prev[key(cur)], start)) {
    cur = prev[key(cur)];
  }
  return samePos(cur, start) ? null : cur;
}


/**
 * 返回经过可行走区域到目标的步数距离，不可达返回 -1
 */
function pathDistance(start, target, game, blockPos) {
  const info = shortestPathInfo(start, target, game, blockPos);
  return info ? info.dist : -1;
}


/**
 * 寻找当前位置周围最安全的一个可行走邻接格子
 */
function bestSafeNeighbor(pos, game, enemyPos, enemyTank, enemyBullets, enemy) {
  let best = null;
  let bestScore = -9999;
  const bullets = enemyBullets || [];
  for (let i = 0; i < DIRS.length; i++) {
    const p = [pos[0] + DIRS[i].dx, pos[1] + DIRS[i].dy];
    if (!isPassable(game, p, enemyPos)) continue;
    if (enemyAimsAt(p, enemyTank, game)) continue;
    if (anyBulletThreatens(enemyBullets || [], p, game)) continue;
    // 连下一帧扫过的轨道也不能碰，免得“看起来安全”的邻格把自己送进弹道。
    if (stepIntoBulletPath(bullets, p, game)) continue;
    if (predictedOverloadThreatens(enemy, p, game)) continue;
    const score = distanceFromEdges(p, game); // 尽量往中间靠
    if (score > bestScore) {
      bestScore = score;
      best = p;
    }
  }
  return best;
}


/**
 * 如果两者在同一直线上且无遮挡，返回应该射击的方向，否则返回 null
 */
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


/**
 * 判断敌方坦克的炮口是否正在瞄准指定位置且视线清晰
 */
function enemyAimsAt(pos, enemyTank, game) {
  if (!enemyTank || !enemyTank.position || !enemyTank.direction) return false;
  const dir = clearShotDirection(enemyTank.position, pos, game);
  return dir === enemyTank.direction;
}


/**
 * 获取沿某方向前进一步的坐标
 */
function nextInDirection(pos, dir) {
  const d = DIRS[dirIndex(dir)];
  if (!d) return pos;
  return [pos[0] + d.dx, pos[1] + d.dy];
}


/**
 * 基于自身位置估算敌方出生点（对称性）
 */
function estimateEnemyHome(myPos, game) {
  if (!myPos || !game || !game.map || !game.map.length) return null;
  return [game.map.length - 1 - myPos[0], game.map[0].length - 1 - myPos[1]];
}


/**
 * 检查两点之间是否没有墙(x)或土块(m)遮挡（视野/弹道检测）
 * a 子弹坐标
 * b 我的坐标
 */
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


/**
 * 检查网格是否可行走（空地、草丛、且没有被敌方占据）
 */
function isPassable(game, p, enemyPos) {
  const t = tileAt(game, p);
  if (t !== "." && t !== "o") return false; // 只能是空地或草丛
  if (samePos(p, enemyPos)) return false; // 不能是敌人位置
  return true;
}


/**
 * 安全获取地图上的网格元素，越界则当做墙壁 "x"
 */
function tileAt(game, p) {
  if (!p || p[0] < 0 || p[1] < 0 || p[0] >= game.map.length || p[1] >= game.map[0].length) return "x";
  return game.map[p[0]][p[1]];
}


/**
 * 获取 a 到相邻格子 b 的方向名称
 */
function directionBetween(a, b) {
  if (b[0] === a[0] && b[1] === a[1] - 1) return "up";
  if (b[0] === a[0] + 1 && b[1] === a[1]) return "right";
  if (b[0] === a[0] && b[1] === a[1] + 1) return "down";
  if (b[0] === a[0] - 1 && b[1] === a[1]) return "left";
  return null;
}


/**
 * 根据方向名称获取对应的索引
 */
function dirIndex(dir) {
  for (let i = 0; i < DIRS.length; i++) {
    if (DIRS[i].name === dir) return i;
  }
  return -1;
}


/**
 * 计算坐标距四条边界的最短距离（越小说明越靠近边缘，越大越靠近中心）
 */
function distanceFromEdges(p, game) {
  return Math.min(p[0], p[1], game.map.length - 1 - p[0], game.map[0].length - 1 - p[1]);
}


/**
 * 统计某格的"可通行开口"数量(四邻里非墙非土块的格)。
 */
function openNeighborCount(p, game) {
  let c = 0;
  for (let i = 0; i < DIRS.length; i++) {
    const q = [p[0] + DIRS[i].dx, p[1] + DIRS[i].dy];
    if (isPassable(game, q, null)) c++;
  }
  return c;
}


/**
 * 死胡同判定：某格只有 ≤1 个可通行开口(走进去只能原路退出)。
 * 面对能封锁开口的敌人(同行/列子弹封住唯一出口)时，走进死胡同 = 没有垂直脱离方向，必被秒
 * (mat_2Wz：沿 y=1 边行抢星走到右上角 [17,1]，右/上/下三面墙、唯一开口 [16,1] 被敌同行子弹封死，
 * 原地对射我慢一拍被击毁)。走位/巡逻应避免走进死胡同，除非那里有星值得冒险。
 */
function isDeadEnd(p, game) {
  return openNeighborCount(p, game) <= 1;
}


/**
 * 走到 next 是否会陷入"被封锁的死胡同"：next 是死胡同(≤1开口)，且敌人当前与 next 同行/列、视线无墙
 * (能用子弹封住唯一出口方向)。此时 next 无垂直脱离、对射又常慢一拍 -> 判危险，走位应避开。
 */
function stepIntoSealedDeadEnd(next, enemyPos, game) {
  if (!enemyPos) return false;
  if (!isDeadEnd(next, game)) return false;
  return !!clearShotDirection(enemyPos, next, game); // 敌能直线打到 next(封锁唯一开口)
}


/**
 * 计算两点之间的曼哈顿距离
 */
function manhattan(a, b) {
  return Math.abs(a[0] - b[0]) + Math.abs(a[1] - b[1]);
}


/**
 * 判断两点坐标是否相等
 */
function samePos(a, b) {
  return !!a && !!b && a[0] === b[0] && a[1] === b[1];
}


/**
 * 生成坐标的哈希 Key 字符串，用于查重/集合
 */
function key(p) {
  return p[0] + "," + p[1];
}


/**
 * 获取数值的符号位 (-1, 0, 1)
 */
function sign(n) {
  if (n > 0) return 1;
  if (n < 0) return -1;
  return 0;
}


function advanceBulletPos(pos, dir, speed) {
  const d = DIR_DELTAS[dir];
  if (!d) return pos;
  return [pos[0] + d[0] * speed, pos[1] + d[1] * speed];
}


function inBounds(pos, game) {
  return pos[0] >= 0 && pos[1] >= 0 &&
    pos[0] < game.map.length && pos[1] < game.map[0].length;
}


function isWallTile(game, pos) {
  return game.map[pos[0]] && game.map[pos[0]][pos[1]] === 'x';
}


function updatePhantomBullets(state, visibleBullets, game) {
  const phantoms = state.phantomBullets || [];
  const alive = [];
  for (let i = 0; i < phantoms.length; i++) {
    const p = phantoms[i];
    const newPos = advanceBulletPos(p.position, p.direction, BULLET_SPEED);
    if (!inBounds(newPos, game) || isWallTile(game, newPos)) continue;
    let dup = false;
    for (let j = 0; j < visibleBullets.length; j++) {
      if (samePos(visibleBullets[j].position, newPos) &&
          visibleBullets[j].direction === p.direction) { dup = true; break; }
    }
    if (!dup) alive.push({ position: newPos, direction: p.direction });
  }
  state.phantomBullets = [];
  for (let i = 0; i < visibleBullets.length; i++) {
    if (visibleBullets[i] && visibleBullets[i].position) {
      state.phantomBullets.push({
        position: visibleBullets[i].position.slice(),
        direction: visibleBullets[i].direction
      });
    }
  }
  for (let i = 0; i < alive.length; i++) {
    state.phantomBullets.push(alive[i]);
  }
  return alive;
}


function inBombBlast(pos, bombPos, game) {
  if (samePos(pos, bombPos)) return true;
  for (let i = 0; i < DIRS.length; i++) {
    for (let r = 1; r <= BOMB_BLAST_RANGE; r++) {
      const p = [bombPos[0] + DIRS[i].dx * r, bombPos[1] + DIRS[i].dy * r];
      if (!inBounds(p, game)) break;
      const tile = game.map[p[0]][p[1]];
      if (tile === 'x') break;
      if (samePos(pos, p)) return true;
      if (tile === 'm') break;
    }
  }
  return false;
}


function bombTimeLeft(bomb, frame) {
  if (bomb.detonateFrame !== undefined) return bomb.detonateFrame - frame;
  if (bomb.placedFrame !== undefined) return (bomb.placedFrame + BOMB_FUSE_FRAMES) - frame;
  return BOMB_FUSE_FRAMES;
}


function inMyBombBlast(pos, state, game, frame) {
  const myBombs = state.myBombs || [];
  for (let i = 0; i < myBombs.length; i++) {
    const b = myBombs[i];
    if (frame >= b.detonateFrame) continue;
    if (frame < b.detonateFrame - 2 && !samePos(pos, b.position)) continue;
    if (inBombBlast(pos, b.position, game)) return true;
  }
  return false;
}


function cleanExpiredBombs(state, frame) {
  if (!state.myBombs) { state.myBombs = []; return; }
  const live = [];
  for (let i = 0; i < state.myBombs.length; i++) {
    if (frame < state.myBombs[i].detonateFrame + 1) live.push(state.myBombs[i]);
  }
  state.myBombs = live;
}


function bombReady(me) {
  if (!me || !me.status) return true;
  if (me.status.bombActive) return false;
  if (me.status.bombCooldownFrames && me.status.bombCooldownFrames > 0) return false;
  return true;
}


function canEscapeAfterBomb(myPos, myDir, game, enemyPos, bombs, state, frame) {
  for (let i = 0; i < DIRS.length; i++) {
    const p = [myPos[0] + DIRS[i].dx, myPos[1] + DIRS[i].dy];
    if (!isPassable(game, p, enemyPos)) continue;
    if (inBombBlast(p, myPos, game)) continue;
    if (inMyBombBlast(p, state, game, frame)) continue;
    return true;
  }
  return false;
}

function isPerpendicularDir(d1, d2) {
  var horiz = { left: true, right: true };
  var vert = { up: true, down: true };
  return (!!horiz[d1] && !!vert[d2]) || (!!vert[d1] && !!horiz[d2]);
}

// ================= 我方技能工具函数 =================

/**
 * 获取我方技能类型
 */
function getMySkillType(me) {
  return (me && me.skill && me.skill.type) || 'teleport';
}

/**
 * 通用技能冷却检查
 */
function skillReady(me) {
  return !!(me && me.skill && me.skill.remainingCooldownFrames === 0);
}

/**
 * 技能是否处于激活状态
 */
function skillActive(me) {
  return !!(me && me.skill && me.skill.activeRemainingFrames && me.skill.activeRemainingFrames > 0);
}

/**
 * 冰冻可用：冷却好 + 敌未被冻 + 敌未无敌
 */
function canFreeze(me, enemy) {
  if (!skillReady(me)) return false;
  if (getMySkillType(me) !== 'freeze') return false;
  if (enemy && enemy.status && enemy.status.frozen) return false;
  if (enemy && enemy.effects && enemy.effects.debuff && enemy.effects.debuff.type === 'freeze') return false;
  return true;
}

/**
 * 眩晕可用：冷却好
 */
function canStun(me, enemy) {
  if (!skillReady(me)) return false;
  if (getMySkillType(me) !== 'stun') return false;
  if (enemy && enemy.status && enemy.status.stunned) return false;
  return true;
}

/**
 * 下毒可用：冷却好 + 敌未中毒
 */
function canPoison(me, enemy) {
  if (!skillReady(me)) return false;
  if (getMySkillType(me) !== 'poison') return false;
  if (enemy && enemy.effects && enemy.effects.debuff && enemy.effects.debuff.type === 'poison') return false;
  return true;
}

/**
 * 过载可用：冷却好 + 未处于过载状态
 */
function canOverload(me) {
  if (!skillReady(me)) return false;
  if (getMySkillType(me) !== 'overload') return false;
  if (me.status && me.status.overloaded) return false;
  return true;
}

/**
 * 隐身可用：冷却好 + 未处于隐身状态
 */
function canCloak(me) {
  if (!skillReady(me)) return false;
  if (getMySkillType(me) !== 'cloak') return false;
  if (me.status && me.status.cloaked) return false;
  return true;
}

/**
 * 加速可用：冷却好 + 未处于加速状态
 */
function canBoost(me) {
  if (!skillReady(me)) return false;
  if (getMySkillType(me) !== 'boost') return false;
  if (me.status && me.status.boosted) return false;
  return true;
}

/**
 * 护盾可用：冷却好 + 未开盾中
 */
function canShieldSkill(me) {
  if (!skillReady(me)) return false;
  if (getMySkillType(me) !== 'shield') return false;
  if (me.status && me.status.shielded) return false;
  return true;
}

/**
 * 过载错位射击方向检测：利用副弹固定走 +1 偏移车道的特性，
 * 当敌人恰好在 +1 偏移线上时，返回应射击的方向（副弹命中）。
 *
 * 过载副弹规则（由 replay 逆向证实）：
 *   水平射击(left/right)：副弹走 y+1 车道
 *   垂直射击(up/down)：副弹走 x+1 车道
 *
 * 场景示例：我[5,5] 敌[10,6] → dy=1 → 火力方向 right → 副弹沿 y=6 命中敌人
 *          我[5,5] 敌[6,10] → dx=1 → 火力方向 down → 副弹沿 x=6 命中敌人
 *
 * @returns {string|null} 射击方向（副弹可命中），或 null（不满足错位条件）
 */
function overloadOffsetShotDir(myPos, enemyPos, game) {
  if (!myPos || !enemyPos) return null;
  var dx = enemyPos[0] - myPos[0];
  var dy = enemyPos[1] - myPos[1];

  // 水平射击时副弹走 y+1 车道 → 敌人须在 myY+1 行
  if (dy === 1 && dx !== 0) {
    var start = [myPos[0], myPos[1] + 1]; // 副弹起点
    var t = tileAt(game, start);
    if (t !== 'x' && t !== 'm') {
      if (clearBetween(start, enemyPos, game)) {
        return dx > 0 ? 'right' : 'left';
      }
    }
  }

  // 垂直射击时副弹走 x+1 车道 → 敌人须在 myX+1 列
  if (dx === 1 && dy !== 0) {
    var start2 = [myPos[0] + 1, myPos[1]]; // 副弹起点
    var t2 = tileAt(game, start2);
    if (t2 !== 'x' && t2 !== 'm') {
      if (clearBetween(start2, enemyPos, game)) {
        return dy > 0 ? 'down' : 'up';
      }
    }
  }

  return null;
}

/**
 * 判断 boost go() 前方2格是否安全可通行
 */
function boostPathSafe(myPos, myDir, game, enemyPos, enemyBullets) {
  var dd = { up: [0, -1], down: [0, 1], left: [-1, 0], right: [1, 0] }[myDir];
  if (!dd) return false;
  var p1 = [myPos[0] + dd[0], myPos[1] + dd[1]];
  var p2 = [myPos[0] + dd[0] * 2, myPos[1] + dd[1] * 2];
  if (!isPassable(game, p1, enemyPos)) return false;
  if (!isPassable(game, p2, enemyPos)) {
    // 第二格不通也可以，boost 遇障碍提前停（走1格也有价值）
    if (anyBulletThreatens(enemyBullets, p1, game)) return false;
    return true;
  }
  if (anyBulletThreatens(enemyBullets, p1, game)) return false;
  if (anyBulletThreatens(enemyBullets, p2, game)) return false;
  return true;
}
