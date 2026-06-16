// ============================================================
// bt-tank-submit.js — 行为树坦克 AI（自动生成，请勿手动编辑）
// 源文件: myth-tank.js, state-store.js, bt-core.js, blackboard.js, enemy-profiler.js, nodes-survival.js, nodes-attack.js, nodes-objective.js, nodes-movement.js, tree-factory.js, entry.js
// 构建时间: 2026-06-16T04:05:51.484Z
// ============================================================
// ===== myth-tank.js =====
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
 * 面对 shield 流敌人时，这一发多半只是骗盾/试探，不能站桩白送对方回敬。
 * 仅当我开火后仍能在敌方最早命中前侧移离线，才允许主动对枪；否则宁可不打。
 */
function canShootThenEvadeShieldCounter(me, enemy, enemyTank, enemyBullets, game, enemyPos) {
  if (!enemyHasShieldSkill(enemy)) return true;
  if (!enemyTank || !enemyPos) return false;
  if (!gunReady(me)) return false;

  const myPos = me.tank.position;
  const dirToEnemy = clearShotDirection(myPos, enemyPos, game);
  if (!dirToEnemy) return false;
  if (!enemyCanFireSoon(enemy)) return true;

  const dirToMe = clearShotDirection(enemyPos, myPos, game);
  if (!dirToMe) return true;

  const dist = manhattan(myPos, enemyPos);
  const enemyHitFrames = turnDistance(enemyTank.direction, dirToMe) + Math.ceil(dist / BULLET_SPEED);
  const perp = (dirToEnemy === "up" || dirToEnemy === "down")
    ? [DIRS[dirIndex("left")], DIRS[dirIndex("right")]]
    : [DIRS[dirIndex("up")], DIRS[dirIndex("down")]];

  for (let i = 0; i < perp.length; i++) {
    const d = perp[i];
    const p = [myPos[0] + d.dx, myPos[1] + d.dy];
    if (!isPassable(game, p, enemyPos)) continue;
    if (anyBulletThreatens(enemyBullets || [], p, game)) continue;
    if (enemyAimsAt(p, enemyTank, game)) continue;
    const escapeFrames = d.name === me.tank.direction ? 1 : 2;
    // 我开火占本帧，下一帧才能移动；敌子弹 enemyHitFrames 帧后到达我当前格。
    // 需要在子弹到达前离开：escapeFrames <= enemyHitFrames（等于时恰好来得及）。
    if (escapeFrames <= enemyHitFrames) return true;
  }
  return false;
}

/**
 * 直射开火是否“不会必死”：用于判断能否把“打面前的敌人”提到预防性软躲避之上。
 * 能进入攻击层说明已无需硬躲的来袭子弹（findBulletDodge/escapeTeleport 都已 return null），
 * 所以这一炮的致死风险只来自敌方炮口。满足以下任一即认定开火不必死：
 *  1. 敌方短期内开不了火（enemyCanFireSoon=false）：纯赚一炮。
 *  2. 我严格先手命中（myDuel<enemyDuel）：敌先倒，不算必死。
 *  2b. 同归于尽（myDuel===enemyDuel）只在**星星严格领先**时才算不必死：星平=运行时长判负=必输
 *      (我方代码一贯更慢)，同归把翻盘机会清零更糟，绝不换命；领先时同归=我赢，可换命锁胜。
 *  3. 我不占先手，但开完火下一帧能侧移离开敌方炮线（不进别的弹道/炮口）：先打再躲，自己没死与星数无关。
 * 皆不满足 -> 这一炮换不回血且躲不掉，判定必死，让位给软躲避。
 *
 * 前置铁律（mat 摇摆送死复盘）：必须车头已对准敌人（turnDistance=0，开火即本帧发出）才算"即时先手直射"。
 * 未对准时开火要先花一帧转向，而敌人往往已在转向过程中/即将开火（replay：敌连续转向对准、我才刚转向
 * 就被抢先开炮），用静态转向距离赌"转向竞速先手"并不可靠——未对准一律让位躲避/机动，绝不站着转向把
 * 先手白送给敌人。这正是"摇摆送死"的源头：直射↔躲避每帧横跳、连转方向却始终没离开弹道。
 */
function directShotNotSuicidal(me, enemy, enemyTank, enemyBullets, game, enemyPos, shotDir) {
  if (!enemyTank || !enemyPos || !shotDir) return false;
  // 未对准敌人 -> 开火非本帧即时，赌转向竞速会被抢先 -> 不算安全直射，让位躲避（及时机动优先）。
  if (turnDistance(me.tank.direction, shotDir) !== 0) return false;
  if (!enemyCanFireSoon(enemy)) return true;

  // shield 流：这一发多半被盾吃掉换不到血，只有“打完仍能侧移离线”才不算白送（与守线/对射同源判定）。
  if (enemyHasShieldSkill(enemy)) {
    return canShootThenEvadeShieldCounter(me, enemy, enemyTank, enemyBullets, game, enemyPos);
  }

  const myPos = me.tank.position;
  const dist = manhattan(myPos, enemyPos);
  const myDuel = turnDistance(me.tank.direction, shotDir) + Math.ceil(dist / BULLET_SPEED);
  const dirToMe = clearShotDirection(enemyPos, myPos, game);
  const enemyDuel = (dirToMe ? turnDistance(enemyTank.direction, dirToMe) : 1) + Math.ceil(dist / BULLET_SPEED);
  if (myDuel < enemyDuel) return true; // 严格先手：敌先倒
  if (myDuel === enemyDuel) {           // 同归：仅星星严格领先才换命，星平/落后必输不换
    const myStars = (me && me.stars) || 0;
    const enmStars = (enemy && enemy.stars) || 0;
    if (myStars > enmStars) return true;
    // 星平/落后：同归=必输，不放行，继续看能否先打再躲（自己不死则无所谓星数）
  }

  const perp = (shotDir === "up" || shotDir === "down")
    ? [DIRS[dirIndex("left")], DIRS[dirIndex("right")]]
    : [DIRS[dirIndex("up")], DIRS[dirIndex("down")]];
  for (let i = 0; i < perp.length; i++) {
    const d = perp[i];
    const p = [myPos[0] + d.dx, myPos[1] + d.dy];
    if (!isPassable(game, p, enemyPos)) continue;
    if (anyBulletThreatens(enemyBullets || [], p, game)) continue;
    if (enemyAimsAt(p, enemyTank, game)) continue;
    const escapeFrames = d.name === me.tank.direction ? 1 : 2;
    if (escapeFrames <= enemyDuel) return true; // 开火占本帧，下帧能在敌弹到达前离线
  }
  return false;
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
 * freeze 流敌人的"被冻致死"预计算：假设敌人此刻冻住我 FREEZE_DURATION(=2) 帧。
 * 关键点：冻结期间我不能移动/转向，而敌人可以**自由转向**(≤2 次转向即可对准任意方向，正好被 2 帧冻结吸收)，
 * 所以致死的硬约束只是子弹飞行时间，不取决于敌人当前朝向。
 * 最坏时序(敌已在我所在行/列、冻结期间开火)：T 冻结(锁 T,T+1)、T+1 开火、子弹 ceil(dist/2) 帧到达；
 * 我 T+2 解冻，需朝向正确本帧脱线、否则要先转向(T+3)。
 *   - dist<=4：ceil(4/2)=2，子弹 T+3 到达，我需转向脱线也是 T+3 -> 命中(必死)。
 *   - dist>=5：ceil(5/2)=3，子弹 T+4，我 T+2/T+3 即可脱线 -> 安全。
 * 故 cell 与 freeze 敌在同一无墙射线上、且曼哈顿 <= 2*FREEZE_DURATION(=4) 即"被冻必死"格。
 * 中间有墙挡住射线则打不到，安全。
 */
function freezeKillsAt(cell, enemyPos, game) {
  if (!enemyPos) return false;
  if (!clearShotDirection(enemyPos, cell, game)) return false; // 不同线或有墙遮挡 -> 冻住也打不到
  return manhattan(enemyPos, cell) <= 2 * FREEZE_DURATION;
}

/**
 * cell 是否落在过载敌人的"双弹覆盖带"内：敌人所在行/列，或相邻 ±1 行/列，且在近距(maxDist)内。
 * 用于传送落点安全判定与走位死区判定——双弹副弹走相邻列，严格同线判定会漏掉。
 */
function inDoubleLaneBand(enemyPos, cell, maxDist) {
  if (!enemyPos) return false;
  if (manhattan(enemyPos, cell) > maxDist) return false;
  const dx = Math.abs(enemyPos[0] - cell[0]);
  const dy = Math.abs(enemyPos[1] - cell[1]);
  // 同列或相邻列(竖直双弹覆盖带) 或 同行或相邻行(水平双弹覆盖带)
  return dx <= 1 || dy <= 1;
}

/**
 * 寻找最佳传送刺杀方案（严格门槛）。
 * 返回 { pos: [x, y], dir: "方向" }
 *
 * 安全模型（子弹 2 格/帧；传送后保持朝向，第 1 帧开火，命中需 ceil(距离/2) 帧）：
 *  - 敌人隐身/有护盾/本局已被标记会躲刺杀 -> 直接放弃。
 *  - 落点必须满足：我方子弹能在敌方反击子弹打到我之前先命中敌人；
 *    且即便敌人转身/横移反击，我方也来得及躲开（见 assassinIsSafe）。
 */
function findAssassinationPlan(me, enemy, enemyTank, enemyBullets, game, state) {
  if (!enemyTank || !teleportReady(me) || !canShoot(me, enemy)) return null;
  // 敌人隐身或有护盾则不刺杀
  if (enemy.status && (enemy.status.cloaked || enemy.status.shielded)) return null;
  // 敌方是传送技能：它能瞬移脱离我的刺杀弹道（甚至反传送到我背后），刺杀收益太低 -> 放弃
  if (enemyHasTeleport(enemy)) return null;
  // 敌方过载(双弹就绪)：刺杀落点必与敌同线(才能直射)，恰好落进双弹正列，反被一帧双弹反杀 -> 放弃刺杀
  if (enemyDoubleLaneThreat(enemy)) return null;
  // overload 流敌人(哪怕此刻冷却中)：刺杀=传送到敌身边对射，它一过载就双弹反杀(刺杀落点必同线=副弹正列)。
  // 对双弹流应"怂"——保留传送躲草丛/抢星，绝不主动凑上去送(呼应 mat_D9W/mat_4YF "别贴双弹敌")。
  if (enemyIsOverloadType(enemy)) return null;
  // 本局敌方已展示过躲刺杀子弹的反应 -> 全局禁用刺杀
  if (state && state.assassinBanned) return null;
  // 脚边有星(走两步内可吃)且我不比敌人远 -> 别把传送浪费在远处刺杀上，留着走过去/传送吃星(mat_E3G 开局[2,2]星在[3,3]却传去刺杀[11,12]丢星)
  if (game && game.star) {
    const myToStar = pathDistance(me.tank.position, game.star, game, enemyTank.position);
    if (myToStar >= 0 && myToStar <= 2) {
      const enemyToStar = pathDistance(enemyTank.position, game.star, game, me.tank.position);
      if (enemyToStar < 0 || myToStar <= enemyToStar) return null;
    }
  }

  const enemyPos = enemyTank.position;
  let best = null;
  let bestScore = -9999;

  // 遍历所有方向和攻击距离，寻找最佳落点
  for (let i = 0; i < DIRS.length; i++) {
    const dir = DIRS[i];
    for (let range = ASSASSIN_MIN_RANGE; range <= ASSASSIN_MAX_RANGE; range++) {
      const p = [enemyPos[0] - dir.dx * range, enemyPos[1] - dir.dy * range];
      if (samePos(p, me.tank.position)) continue; // 排除当前位置
      if (!isAssassinTile(p, dir.name, enemyTank, enemyBullets, game)) continue;
      // 严格安全校验：模拟敌方反击，确认我方先手命中且能躲掉反击
      if (!assassinIsSafe(p, dir, range, me, enemy, enemyTank, game)) continue;

      // 打分模型：转向代价越小越好，距离越近(命中更快)越好，靠近地图中心更好
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

/**
 * 严格刺杀安全判定：在落点 p、朝 dir、与敌距离 range 的前提下，模拟敌方最快反击。
 *
 * 时间线（传送占当前帧，落点朝向已对准 -> 下一帧即我方开火帧记为 t=1）：
 *  - 我方子弹命中敌人耗时：myHitFrames = ceil(range / 2)。
 *  - 敌方反击：最坏情况敌人本就朝向我方所在直线、且炮管就绪，可与我方同帧开火，
 *    其子弹命中我耗时 enemyHitFrames = ceil(range / 2)（同样距离）。
 *  - 若敌人需要先转向对准（不在我方直线朝向上），反击至少晚 1 帧。
 *
 * 通过条件（满足其一即安全）：
 *  A. 我方严格快于敌方反击命中（myHitFrames < enemyReplyHit）；
 *  B. 同时命中但我方落点在"打完后能立刻横移脱离敌方弹道"——保守起见要求落点有可躲的侧向空格。
 * 否则判为不安全（宁可不刺杀）。
 */
function assassinIsSafe(p, dir, range, me, enemy, enemyTank, game) {
  const enemyPos = enemyTank.position;
  const myHitFrames = Math.ceil(range / BULLET_SPEED);

  // 敌方炮管是否就绪（场上已有敌弹则其无法立刻再开火，对我更有利）
  const enemyGunBusy = enemy && enemy.bullet && enemy.bullet.position;

  // 敌人当前是否已朝向能直接打到落点 p（即可与我同帧反击）
  const enemyFacingMe = enemyAimsAt(p, enemyTank, game);
  // 敌方反击命中我所需帧：能直接打则与我同距离；需转身则 +1 帧
  let enemyReplyHit = Math.ceil(range / BULLET_SPEED) + (enemyFacingMe ? 0 : 1);
  if (enemyGunBusy) enemyReplyHit += 1; // 敌人得等旧弹消失，再晚 1 帧

  // A. 我方严格更快命中 -> 安全
  if (myHitFrames < enemyReplyHit) return true;

  // B. 同帧/稍慢：要求落点能在被命中前横向脱离敌方弹道（侧向有可走空格且不被其他弹道封锁）
  if (myHitFrames <= enemyReplyHit) {
    if (hasLateralEscape(p, dir, enemyTank, game)) return true;
  }
  return false;
}

/**
 * 落点 p 沿射击方向 dir 的两个垂直侧向，是否存在可走且不被敌人立刻瞄准的脱离格。
 * 用于刺杀后"开火即走"躲反击。
 */
function hasLateralEscape(p, dir, enemyTank, game) {
  // 垂直于 dir 的两个方向
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

/**
 * 判断一个坐标是否适合作为刺杀传送落点
 */
function isAssassinTile(p, dir, enemyTank, enemyBullets, game) {
  if (!isTeleportSafe(p, enemyTank, enemyBullets, game, 0)) return false; // 必须安全（不卡墙/不接现有子弹/不被预瞄）
  if (manhattan(p, enemyTank.position) < ASSASSIN_MIN_RANGE) return false; // 必须大于最小距离避免开火锁定
  if (clearShotDirection(p, enemyTank.position, game) !== dir) return false; // 落点必须能直接射击敌人
  return true;
}

/**
 * 寻找争夺星星时的预瞄方向
 */
function findContestedStarGuard(me, enemyTank, game) {
  if (!game.star || !enemyTank || !gunReady(me)) return null;
  const myPos = me.tank.position;
  const enemyPos = enemyTank.position;
  
  const enemyToStar = manhattan(enemyPos, game.star);
  if (enemyToStar > 2) return null; // 敌人离星星不远
  if (manhattan(myPos, game.star) > 4) return null; // 我离星星也不远
  
  const dir = clearShotDirection(myPos, game.star, game);
  if (!dir) return null; // 必须能瞄准星星
  
  // 确保我跑去星星的路径距离不比敌人长太多
  if (pathDistance(enemyPos, game.star, game, myPos) > enemyToStar) return null;
  return { dir: dir };
}

/**
 * 隐身守星陷阱判定：仅在以下全部成立时返回 true（窄条件，避免"防过头不敢抢星"）：
 *  - 敌人拥有隐身技能，且此刻不可见(enemyTank=null，即正在隐身)；
 *  - 最近 6 帧内见过敌人（lastEnemyPos 有效），其最后位置与星星同行/同列且视线无遮挡（能直接狙击抢星者）；
 *  - 敌方距星星在开火射程内(<=8)；我离星星也不算远(<=6，确实在争这颗星)。
 * 此时冲过去抢星 = 落点即被狙，应改为守位等待（见 mat_1Hvg / mat_0fCb）。
 */
function inCloakStarTrap(me, enemy, enemyTank, game, state) {
  if (!game.star) return false;
  if (enemyTank) return false;                 // 敌人可见 -> 不算隐身陷阱
  if (!enemy || !enemy.skill || enemy.skill.type !== "cloak") return false;
  if (!state || !state.lastEnemyPos) return false;
  if (((game.frames || 0) - state.lastEnemySeenFrame) > 6) return false; // 太久没见，信息失效

  const ePos = state.lastEnemyPos;
  // 敌最后位置必须卡在星星的射线上（同行/同列且中间无遮挡），否则狙不到抢星者
  if (!clearShotDirection(ePos, game.star, game)) return false;
  if (manhattan(ePos, game.star) > 8) return false;          // 超出开火射程
  if (manhattan(me.tank.position, game.star) > 6) return false; // 我不在争星范围就不必守
  return true;
}

/**
 * 隐身守星时的守位走法：移动到既不在敌方狙击线上、又尽量靠近星星(便于星消失/敌现身时抢)的相邻格。
 * 找不到更优守位则返回 null（原地不动等待）。
 */
function cloakStarGuardStep(me, game, state) {
  const myPos = me.tank.position;
  const ePos = state.lastEnemyPos;
  const star = game.star;
  // 当前格已安全（不在敌狙击线）则原地守，不乱动
  const myDirToStar = clearShotDirection(ePos, myPos, game);
  const onSnipeLine = myDirToStar && manhattan(ePos, myPos) <= 8;
  if (!onSnipeLine) return null;

  // 我正卡在敌方狙击线上 -> 侧移到不在该线、且离星星不更远的相邻格
  let best = null;
  let bestScore = -9999;
  for (let i = 0; i < DIRS.length; i++) {
    const p = [myPos[0] + DIRS[i].dx, myPos[1] + DIRS[i].dy];
    if (!isPassable(game, p, ePos)) continue;
    const stillSniped = clearShotDirection(ePos, p, game) && manhattan(ePos, p) <= 8;
    if (stillSniped) continue;
    const score = -manhattan(p, star) * 2 + distanceFromEdges(p, game);
    if (score > bestScore) {
      bestScore = score;
      best = p;
    }
  }
  return best;
}

/**
 * 隐身敌刚消失后，用最后可见位置 + 消失帧数做 BFS 预测可达格。
 * 这里不假设敌人一定在某格，只用于识别“敌可能隐身卡星点枪线”的高危区域。
 */
function hiddenCloakPositions(enemy, enemyTank, game, state) {
  if (!game || !game.map) return [];
  if (enemyTank) return [];
  if (!enemyIsCloakType(enemy)) return [];
  if (!state || !state.lastEnemyPos) return [];
  const age = (game.frames || 0) - state.lastEnemySeenFrame;
  if (age < 0 || age > 6) return [];

  const maxSteps = Math.min(6, age);
  const start = state.lastEnemyPos;
  const queue = [start];
  const dist = {};
  const seen = {};
  dist[key(start)] = 0;
  seen[key(start)] = true;

  for (let qi = 0; qi < queue.length; qi++) {
    const p = queue[qi];
    const pd = dist[key(p)];
    if (pd >= maxSteps) continue;
    for (let i = 0; i < DIRS.length; i++) {
      const n = [p[0] + DIRS[i].dx, p[1] + DIRS[i].dy];
      const nk = key(n);
      if (seen[nk]) continue;
      if (!isPassable(game, n, null)) continue;
      seen[nk] = true;
      dist[nk] = pd + 1;
      queue.push(n);
    }
  }
  return queue;
}

/**
 * 从隐身可达格里筛出能直接打到星点的位置。
 * 复盘来源：mat_G8，敌在星点同行/同列隐身守枪线，我方直传星点后被下一枪收掉。
 */
function hiddenCloakStarThreatPositions(enemy, enemyTank, game, state) {
  const positions = hiddenCloakPositions(enemy, enemyTank, game, state);
  const threats = [];
  for (let i = 0; i < positions.length; i++) {
    const p = positions[i];
    if (clearShotDirection(p, game.star, game) && manhattan(p, game.star) <= 8) {
      threats.push(p);
    }
  }
  return threats;
}

function snipedByHiddenCloakPositions(p, threats, game) {
  for (let i = 0; i < threats.length; i++) {
    const t = threats[i];
    if (clearShotDirection(t, p, game) && manhattan(t, p) <= 8) return true;
  }
  return false;
}

function minDistanceToPositions(p, positions) {
  let best = 999;
  for (let i = 0; i < positions.length; i++) {
    const d = manhattan(p, positions[i]);
    if (d < best) best = d;
  }
  return best;
}

/**
 * 隐身守星反制传送：星点可能被隐身枪线守住时，不直传星。
 * 优先落到最后隐身格 2 格内、离星不远、且不会被预测枪线直射的压迫位。
 */
function hiddenCloakStarTeleport(me, enemy, enemyTank, enemyBullets, game, state) {
  const threats = hiddenCloakStarThreatPositions(enemy, enemyTank, game, state);
  if (threats.length === 0) return null;

  const myPos = me.tank.position;
  let best = null;
  let bestScore = -9999;

  for (let x = 0; x < game.map.length; x++) {
    for (let y = 0; y < game.map[x].length; y++) {
      const p = [x, y];
      if (samePos(p, myPos) || samePos(p, game.star)) continue;
      if (!isPassable(game, p, null)) continue;
      if (anyBulletThreatens(enemyBullets || [], p, game)) continue;
      if (stepIntoBulletPath(enemyBullets || [], p, game)) continue;
      if (samePos(p, state.lastEnemyPos)) continue; // 别直踩最后隐身格，避免撞上真实敌人
      if (minDistanceToPositions(p, threats) === 0) continue; // 别踩到能卡星线的高危隐身格
      if (snipedByHiddenCloakPositions(p, threats, game)) continue;

      const nearThreat = minDistanceToPositions(p, threats);
      const nearLast = manhattan(p, state.lastEnemyPos);
      if (nearLast > 2) continue; // 贴最后隐身格两格内，保留压迫感且不直送星点

      const starDist = pathDistance(p, game.star, game, null);
      if (starDist < 0 || starDist > 4) continue;

      const score = -starDist * 12 - nearThreat * 3 - nearLast + distanceFromEdges(p, game);
      if (score > bestScore) {
        bestScore = score;
        best = p;
      }
    }
  }
  return best;
}

/**
 * 判断当前朝向能否本帧横移离开敌方瞄准线。
 * 若需要先转向才可脱线，近距枪线下通常会慢一拍，应该交给硬传逃生。
 */
function hasImmediatePerpEscapeFromAim(me, enemyTank, enemyBullets, game, enemyPos, enemy) {
  if (!enemyTank || !enemyTank.position) return true;
  const myPos = me.tank.position;
  const lineDir = clearShotDirection(enemyTank.position, myPos, game);
  if (!lineDir || enemyTank.direction !== lineDir) return true;
  const verticalShot = lineDir === "up" || lineDir === "down";
  const d = DIRS[dirIndex(me.tank.direction)];
  if (!d) return false;
  const movingVertical = d.name === "up" || d.name === "down";
  if (verticalShot === movingVertical) return false; // 当前朝向仍沿弹道轴，不能本帧离线

  const p = [myPos[0] + d.dx, myPos[1] + d.dy];
  if (!isPassable(game, p, enemyPos)) return false;
  if (enemyAimsAt(p, enemyTank, game)) return false;
  if (anyBulletThreatens(enemyBullets || [], p, game)) return false;
  if (stepIntoBulletPath(enemyBullets || [], p, game)) return false;
  if (predictedOverloadThreatens(enemy, p, game)) return false;
  return true;
}

/**
 * 寻找紧急逃生传送点。
 * 触发条件：传送就绪，且当前位置被任意敌方子弹威胁、或常规躲避来不及（隐身/过载场景由调用方先行判断）。
 * 落点要求：远离所有子弹弹道、远离敌人（避免传送后立刻被开火锁定或对射）。
 */
function findEscapeTeleport(me, enemy, enemyTank, enemyBullets, game) {
  if (!teleportReady(me)) return null;
  const myPos = me.tank.position;
  const threatened = anyBulletThreatens(enemyBullets, myPos, game);
  // 过载预警：敌人处于过载(下次开火即双弹)、已瞄准我或与我同线、且近距(<=6)时，双弹几乎躲不掉，提前传送拉开
  const overloadEnemy = enemy && enemy.status && enemy.status.overloaded;
  const overloadAmbush = overloadEnemy && enemyTank && enemyTank.position &&
    !!clearShotDirection(enemyTank.position, myPos, game) &&
    manhattan(enemyTank.position, myPos) <= 6;
  // 近距硬锁：像 mat_4C5，敌已瞄准且我当前朝向无法立刻横移，转向会来不及。
  const pointBlankAimLock = enemyTank && enemyTank.position && enemyCanFireSoon(enemy) &&
    enemyAimsAt(myPos, enemyTank, game) &&
    manhattan(enemyTank.position, myPos) <= 4 &&
    !hasImmediatePerpEscapeFromAim(me, enemyTank, enemyBullets, game, enemyTank.position, enemy);
  if (!threatened && !overloadAmbush && !pointBlankAimLock) return null;
  // 过载敌人弹道更密，逃生落点额外拉开距离
  return bestTeleportTile(myPos, enemyTank, enemyBullets, game, game.star, true, (overloadEnemy || pointBlankAimLock) ? 6 : 4, enemy);
}

/**
 * 寻找抢夺星星的传送点
 */
function findStarTeleport(me, enemy, enemyTank, enemyBullets, game, state) {
  if (!teleportReady(me) || !game.star) return null;
  const enemyPos = enemyTank ? enemyTank.position : null;
  const walkDist = pathDistance(me.tank.position, game.star, game, enemyPos);

  // 终局帧数博弈：临近 128 帧结束时，按星数判胜负。若走路来不及吃星(walkDist>剩余帧)，但传送+剩余帧内
  // 敌人即使立刻开火也打不到我(剩余帧 < 敌开火命中所需帧)，则大胆传送抢星锁分——哪怕落点在敌炮线。
  const endgameGrab = endgameStarTeleport(me, enemy, enemyTank, game, walkDist);
  if (endgameGrab) return endgameGrab;

  // 过载敌人：仅当对方 overload 冷却 <= 10 帧（即将放双弹）时才保留传送做逃生，
  // 其余时间允许传星——传完后靠走位评分避开双弹带，不在这里一刀切禁止。
  if (enemyIsOverloadType(enemy)) {
    // 过载即将开火(已过载状态)：传星后若落点在双弹带内且无法即时逃跑，则留传送做逃生。
    // 注意：overloadCD=0 但敌未激活(status.overloaded=false)，不等于实弹在途，不能一刀切禁用传星。
    // isTeleportSafe / isStarGuardTrap 已过滤落点危险，此处只阻断"敌已过载中(实弹即将飞出)"的情形。
    if (enemy && enemy.status && enemy.status.overloaded) return null; // 已激活，双弹本帧就发出
  }

  // 走路够快(<=5步)时不浪费传送
  if (walkDist >= 0 && walkDist <= 5) return null;

  // 守星陷阱：敌握双弹且星在其覆盖带内时放弃传送（与 shouldChaseStar 走路判断用同一函数）
  if (isStarGuardTrap(enemyPos, enemy, game.star)) return null;

  // 隐身守星：先找贴最后隐身格的安全压迫位；找不到则放弃传星，避免直送星点。
  const hiddenCloakGrab = hiddenCloakStarTeleport(me, enemy, enemyTank, enemyBullets, game, state);
  if (hiddenCloakGrab) return hiddenCloakGrab;
  if (hiddenCloakStarThreatPositions(enemy, enemyTank, game, state).length > 0) return null;

  // 丢失视野时，估算敌人老家位置，避开可能的危险区域传送
  if (!enemyTank) {
    const enemyGuess = estimateEnemyHome(me.tank.position, game);
    if (enemyGuess && manhattan(game.star, enemyGuess) <= ASSASSIN_MAX_RANGE) {
      return bestUnknownEnemyStarTeleport(me.tank.position, enemyGuess, enemyBullets, game);
    }
  }

  const centralContestGrab = centralTeleportStarContest(me, enemy, enemyTank, enemyBullets, game);
  if (centralContestGrab) return centralContestGrab;

  // 双 teleport 抢星对撞：敌方传送也就绪时，直传星点 = 站在对方能预判的靶位上送死(mat_JOj 直传 [17,4]，
  // 敌一跳到 [15,4] 同行右射 2格/帧瞬达把我秒)。星点同时暴露在"行+列"两条线，对方传到任一条线即可命中。
  // 改传星十字相邻一格(只暴露行或列之一、对方猜不到我落哪个十字格)，下一帧再走上去补吃；找不到安全相邻格再退回原逻辑。
  //
  // 门控(mat_FH69 复盘)：十字相邻避狙的前提是"对手也得靠瞬移到星线来抢这颗星"。若对手走路就能到星
  // (foeWalk 近)，它会直接走过去吃，不会瞬移狙我——此时我传旁边一格反而吃不到星、还可能因补吃格贴敌被
  // 死区拦下而丢星(mat_FH69 f51 星[3,5]、敌走路 d=3，我传[4,5]没吃到、补吃[3,5]贴敌 d=1 被拦，丢星+废传送)。
  // 仅当对手走路够不到星(foeWalk 远，会被迫传送瞬移)时才用十字相邻避狙；否则直传星点抢分。
  if (enemyTeleportReady(enemy)) {
    const foeWalk = enemyPos ? pathDistance(enemyPos, game.star, game, me.tank.position) : -1;
    const foeMustTeleport = foeWalk < 0 || foeWalk > 5; // 对手走路够不到(或不可达) -> 才会瞬移狙星线
    if (foeMustTeleport) {
      const crossGrab = crossAdjacentStarTeleport(me, enemyTank, enemyBullets, game, enemy);
      if (crossGrab) return crossGrab;
    }
  }

  // 优先直接传送到星星上（但要排除"落地即被敌方开火打死、又躲不掉"的死亡陷阱）
  // 守星陷阱（双弹敌覆盖带）已由上方 isStarGuardTrap 统一拦截，这里只做落点安全判定。
  // landingNearSweepingBullet：落点紧贴一发横扫子弹、吃完星自然走向会撞进弹道时也判危险(mat_GwxblYdS f51)。
  if (isTeleportSafe(game.star, enemyTank, enemyBullets, game, 0, enemy) &&
      !starLandingDeadly(game.star, me, enemyTank, enemy, game) &&
      !landingNearSweepingBullet(game.star, enemyBullets, game)) {
    return game.star;
  }

  const adjacentUnsafeStarGrab = unsafeStarAdjacentTeleport(me, enemy, enemyTank, enemyBullets, game, walkDist);
  if (adjacentUnsafeStarGrab) return adjacentUnsafeStarGrab;

  const lateContestGrab = lateContestedAdjacentStarTeleport(me, enemy, enemyTank, enemyBullets, game, walkDist);
  if (lateContestGrab) return lateContestGrab;

  // 星星上不安全则传送到星星附近最安全的点
  return bestTeleportTile(me.tank.position, enemyTank, enemyBullets, game, game.star, false, 0, enemy);
}

/**
 * 双 teleport 抢星：传送到星星"十字相邻一格"而非星点本身。
 *
 * 为什么不直传星点：双方都是 teleport 时，对方可瞬移到星星所在行/列上沿线狙击(mat_JOj 敌跳到 [15,4]
 * 与星 [17,4] 同行右射，子弹 2格/帧瞬达把我秒)。星点同时位于"行 y=4"和"列 x=17"两条线，
 * 对方传到任一条线即可命中我。
 *
 * 十字相邻格(星的上/下/左/右一格)只落在"行或列"之一上：例如落星上方 [17,3]，则敌沿星所在行 y=4 的炮弹
 * 打不到 y=3 的我；对方也无法预判我会落四个十字格中的哪个。落点本身用 isTeleportSafe + starLandingDeadly
 * 双重过滤(不卡墙、不在现有子弹/炮线、对射不吃亏)，选离敌最远、最不易被狙的那个。
 * 下一帧 onIdle 会走 1 步上去吃星(走路 1 格/帧)。找不到任何安全十字格则返回 null，退回原直传逻辑。
 */
function crossAdjacentStarTeleport(me, enemyTank, enemyBullets, game, enemy) {
  const star = game.star;
  if (!star) return null;
  const myPos = me.tank.position;
  const enemyPos = enemyTank ? enemyTank.position : null;
  let best = null;
  let bestScore = -Infinity;
  for (let i = 0; i < DIRS.length; i++) {
    const c = [star[0] + DIRS[i].dx, star[1] + DIRS[i].dy];
    if (samePos(c, myPos)) continue;
    // 落点必须能站、不在子弹/炮线上、对射不吃亏
    if (!isTeleportSafe(c, enemyTank, enemyBullets, game, 0, enemy || null)) continue;
    if (starLandingDeadly(c, me, enemyTank, enemy || null, game)) continue;
    // 必须能从该格一步走到星(中间无墙/相邻)——十字相邻天然满足，但星可能贴墙导致某向不可达，复检
    if (!isPassable(game, star, enemyPos)) return null; // 星点本身不可站则无意义
    // 打分：离敌越远越好(越不易被瞬移狙击)；远离地图边缘(留躲闪空间)
    const enemyScore = enemyPos ? manhattan(c, enemyPos) : 0;
    const score = enemyScore * 2 + distanceFromEdges(c, game);
    if (score > bestScore) {
      bestScore = score;
      best = c;
    }
  }
  return best;
}

/**
 * 中央星点的双 teleport 竞星：若星点在开阔中心、敌当前炮线并未锁星，
 * 贴星一格会让敌直接踩星后形成我方 fireLocked 的近距劣势（mat_C28）。
 * 此时优先直传星点抢分；边角星仍走 crossAdjacent，保留 mat_JOj / mat_KBZ 的避狙逻辑。
 */
function centralTeleportStarContest(me, enemy, enemyTank, enemyBullets, game) {
  if (!game.star || !enemyTeleportReady(enemy) || !enemyTank || !enemyTank.position) return null;
  const frame = (game && game.frames) || 0;
  if (frame > 8) return null; // 只处理开局/早局的同帧抢第一颗星，避免中后期过度冒险
  if (distanceFromEdges(game.star, game) < 4) return null; // 边角星被瞬移狙击概率高，继续用十字相邻
  if (clearShotDirection(enemyTank.position, game.star, game)) return null; // 敌当前已锁星线，不直送炮口
  if (!isTeleportSafe(game.star, enemyTank, enemyBullets, game, 0, enemy)) return null;
  if (starLandingDeadly(game.star, me, enemyTank, enemy, game)) return null;
  return game.star;
}

/**
 * 星点本身落地即死时的进攻型补偿。
 * 参考小强 mat_7m1：直接上星不安全就贴星一格，保留下一帧抢星节奏。
 */
function unsafeStarAdjacentTeleport(me, enemy, enemyTank, enemyBullets, game, walkDist) {
  if (!game.star || !enemyTank || !enemyTank.position) return null;
  if (walkDist >= 0 && walkDist <= 5) return null;
  const starSafe = isTeleportSafe(game.star, enemyTank, enemyBullets, game, 0, enemy) &&
    !starLandingDeadly(game.star, me, enemyTank, enemy, game);
  if (starSafe) return null;
  return crossAdjacentStarTeleport(me, enemyTank, enemyBullets, game, enemy);
}

/**
 * 晚局比分胶着时，若直传星点会被敌炮线秒掉，但敌人又明显比我更快接星，
 * 优先传到星的十字相邻安全格，而不是退到泛化安全落点的两三格外。
 * 复盘来源：mat_12d26hXYXtTHzftkj，小强 f115-f118 星在 [14,6]。
 */
function lateContestedAdjacentStarTeleport(me, enemy, enemyTank, enemyBullets, game, walkDist) {
  if (!game.star || !enemyTank || !enemyTank.position) return null;
  const frame = (game && game.frames) || 0;
  const framesLeft = MAX_GAME_FRAMES - frame;
  if (framesLeft > 20) return null;

  const myStars = me && typeof me.stars === "number" ? me.stars : 0;
  const enemyStars = enemy && typeof enemy.stars === "number" ? enemy.stars : 0;
  if (myStars > enemyStars) return null;

  const enemyDist = pathDistance(enemyTank.position, game.star, game, me.tank.position);
  if (enemyDist < 0) return null;
  if (enemyDist > Math.min(5, framesLeft)) return null;
  if (walkDist >= 0 && walkDist <= enemyDist) return null;

  return crossAdjacentStarTeleport(me, enemyTank, enemyBullets, game, enemy);
}


/**
 * 传送抢星前是否应"先转向再传送"，返回应转到的朝向(null=直接传)。
 * 仅当敌方是 teleport 技能(能瞬移到星另一侧对撞) + 双方都离星近(可能同帧抢同一颗星) + 传送落点也贴星时触发：
 * 传送落地朝向不变，若不先对准，落地后转向那帧会被对侧传来的敌人抢先开火(mat_KBZ 传[3,6]朝向不对被秒)。
 * 返回"落点 -> 星"方向：对撞在星周围发生，朝星即朝可能出现的敌人，落地即可对射不被抢先。
 */
function teleportPreTurnDir(me, landing, enemy, enemyTank, game) {
  if (!enemyHasTeleport(enemy)) return null;     // 仅针对会瞬移对撞的 teleport 敌人
  if (!game.star) return null;
  const enemyPos = enemyTank ? enemyTank.position : null;
  if (!enemyPos) return null;
  // 双方都离星近(都可能传送来抢)才有对撞风险；敌离星远则不会来对撞，无需预转
  if (manhattan(enemyPos, game.star) > ASSASSIN_MAX_RANGE) return null;
  // 落点要贴星(对撞区, 距星<=2)才需要预转；远离星的安全落点不必
  if (manhattan(landing, game.star) > 2) return null;
  // 落点已避开敌方当前清晰炮线(如十字相邻安全格)则无对射风险，直接传不必浪费一帧预转；
  // 仅当落点确实在敌当前炮线/即落点就是星点(双方对撞挤同格)时才需先转对准。
  if (!samePos(landing, game.star) && !clearShotDirection(enemyPos, landing, game)) return null;
  // 理想落地朝向 = 落点指向星(对撞方向)。落点即星点时退而指向敌人当前方位。
  const dir = samePos(landing, game.star)
    ? clearShotDirection(landing, enemyPos, game) || directionBetween(landing, enemyPos)
    : directionBetween(landing, game.star);
  return dir || null;
}

/**
 * 终局抢星传送：临近第 128 帧、走路来不及吃星时，若传送到星点后敌人即使立刻开火也来不及在终局前命中，
 * 就传送抢星锁定星数胜负（超时按星数判）。子弹2格/帧：敌最快命中我需 1(传送占帧,敌下帧响应)+敌转向(0或1)+ceil(dist/2)。
 * 剩余帧 < 该命中帧 -> 终局前打不到我 -> 安全抢星，哪怕落点在敌炮线。落点本身必须可站(不卡墙/不接现有子弹)。
 */
function endgameStarTeleport(me, enemy, enemyTank, game, walkDist) {
  const frame = (game && game.frames) || 0;
  const framesLeft = MAX_GAME_FRAMES - frame;
  if (framesLeft <= 0) return null;
  // 只在终局窗口内启用(剩余<=8帧)，且走路确实来不及吃(walkDist 不可达或 > 剩余帧)
  if (framesLeft > 8) return null;
  if (walkDist >= 0 && walkDist <= framesLeft) return null; // 走路来得及，无需传送
  const star = game.star;
  // 落点必须能站(不卡墙/土块；星点格按规则可站)
  if (!isPassable(game, star, enemyTank ? enemyTank.position : null)) return null;
  // 敌人最快命中我所需帧：传送当前帧用掉，敌下一帧起算
  const enemyPos = enemyTank ? enemyTank.position : null;
  if (enemyPos) {
    const lineDir = clearShotDirection(enemyPos, star, game);
    const dist = manhattan(enemyPos, star);
    // 同线无墙才打得到；不同线/有墙则需敌移动+转向，更慢，这里取最快的同线情形保守估计
    const enemyFacing = lineDir && enemyTank.direction === lineDir;
    const hitFrames = 1 + (lineDir ? (enemyFacing ? 0 : 1) : 2) + Math.ceil(dist / BULLET_SPEED);
    if (framesLeft >= hitFrames) return null; // 敌来得及在终局前打到 -> 不强抢
  }
  return star;
}

/**
 * 传送落点是否紧贴一发"横扫中"的飞行子弹，使得我吃完星后的自然走向会撞进它的弹道。
 * 复盘来源：mat_GwxblYdS4ZSDXd0wX f51-f54——我传 [15,14] 吃星(落点本身安全，子弹在 y=12)，
 * 落地后朝 up 一路走 [15,14]->[15,13]->[15,12]，f54 正好撞上沿 y=12 右扫的子弹。
 *
 * 落点本身不在弹道(isTeleportSafe 已过滤)，但若一发子弹与落点只差 1~2 行/列、且落点朝子弹那条行/列
 * 偏移 1~2 格的邻格正落在该子弹的未来飞行路径上(同行/列且子弹朝它飞来)，则落点是"陷阱落点"——
 * 我吃完星自然走 1~2 步进那条行/列时会与扫来的子弹相遇(子弹 2 格/帧 > 我 1 格/帧，迟早撞上)。
 * 用 bulletReachTiles 判邻格是否在子弹未来路径上，不限帧数(走过去就会被扫到)。
 */
function landingNearSweepingBullet(landing, enemyBullets, game) {
  const bullets = enemyBullets || [];
  for (let i = 0; i < bullets.length; i++) {
    const b = bullets[i];
    if (!b || !b.position) continue;
    const horizontal = b.direction === "left" || b.direction === "right";
    // 子弹横扫的是它的飞行轴(水平飞->沿 x 扫，落点在相邻 y)；竖直飞->沿 y 扫，落点在相邻 x。
    const sweepAxisSame = horizontal ? (b.position[1] !== landing[1]) : (b.position[0] !== landing[0]);
    if (!sweepAxisSame) continue; // 落点与子弹同行/列由 isTeleportSafe/stepIntoBulletPath 处理，这里只管相邻带
    const offset = horizontal ? Math.abs(b.position[1] - landing[1]) : Math.abs(b.position[0] - landing[0]);
    if (offset === 0 || offset > 2) continue; // 只防相邻 1~2 行/列(吃完星 1~2 步会踏入)
    for (let s = 1; s <= offset; s++) {
      // 朝子弹弹道方向挪 s 步的落点邻格(模拟吃完星走向弹道行/列)
      const towardBullet = horizontal
        ? [landing[0], landing[1] + (b.position[1] > landing[1] ? s : -s)]
        : [landing[0] + (b.position[0] > landing[0] ? s : -s), landing[1]];
      if (!isPassable(game, towardBullet, null)) break; // 被墙挡住，走不过去，安全
      // 邻格在子弹未来飞行路径上(同行/列、子弹朝它飞来、中间无墙) -> 走过去迟早被扫到
      if (bulletReachTiles(b, towardBullet, game) >= 0) return true;
    }
  }
  return false;
}

/**
 * 判断传送到 landing（如星星）会不会"落地即死"：敌方与落点同线、能在我躲开前开火命中。
 *
 * 时间线（子弹 2 格/帧）：传送占当前帧；敌方下一帧可转向对准(若未对准+1帧)并开火；
 * 子弹命中我耗时 ceil(dist/2) 帧。我方落地后需横向脱离：若有可走且不被敌方再次瞄准的侧格，
 * 当前朝向就是侧向只需 1 帧、否则需转向+前进 2 帧。来不及脱离即判为死亡陷阱。
 */
function starLandingDeadly(landing, me, enemyTank, enemy, game) {
  if (!enemyTank || !enemyTank.position) return false;
  if (!enemyCanFireSoon(enemy)) return false; // 敌方近期无法开火则无威胁

  const enemyPos = enemyTank.position;
  const lineDir = clearShotDirection(enemyPos, landing, game);
  if (!lineDir) return false; // 敌方与落点不同线/被遮挡，打不到

  const dist = manhattan(enemyPos, landing);
  // 敌方反击命中我所需帧：已对准则下一帧即可开火，否则先转向 +1 帧
  const enemyFacing = enemyTank.direction === lineDir;
  const enemyHitFrames = Math.ceil(dist / BULLET_SPEED) + (enemyFacing ? 0 : 1);

  // 对射先手对比：传送后我保持朝向，需转向对准敌人(landing->enemy)再开火。
  // 传送落点距敌<=4 还会被开火锁定2帧，先手更差。只要我不是严格快于敌人，落在其炮线上就视为危险陷阱。
  const myDirToEnemy = clearShotDirection(landing, enemyPos, game);
  const myTurnFrames = myDirToEnemy ? turnDistance(me.tank.direction, myDirToEnemy) : 2;
  const fireLockPenalty = dist <= 4 ? 2 : 0; // 落点太近会 fireLocked 2 帧
  const myHitFrames = myTurnFrames + fireLockPenalty + Math.ceil(dist / BULLET_SPEED);
  if (myHitFrames >= enemyHitFrames) return true; // 对射不占先手 -> 别传到这条炮线上送死

  // 我方脱离所需帧：找垂直于敌方弹道、可走且不会被敌方立刻再瞄准的侧格
  const perp = (lineDir === "up" || lineDir === "down")
    ? [DIRS[dirIndex("left")], DIRS[dirIndex("right")]]
    : [DIRS[dirIndex("up")], DIRS[dirIndex("down")]];
  let escapeFrames = 99;
  for (let i = 0; i < perp.length; i++) {
    const q = [landing[0] + perp[i].dx, landing[1] + perp[i].dy];
    if (!isPassable(game, q, enemyPos)) continue;
    if (enemyAimsAt(q, enemyTank, game)) continue; // 侧格仍在另一条炮线上则无效
    const need = perp[i].name === me.tank.direction ? 1 : 2;
    if (need < escapeFrames) escapeFrames = need;
  }

  // 我无法在敌弹命中前完成脱离 -> 死亡陷阱
  return escapeFrames >= enemyHitFrames;
}

/**
 * 在丢失敌人视野时，寻找安全的星星传送点
 */
function bestUnknownEnemyStarTeleport(myPos, enemyGuess, enemyBullets, game) {
  let best = null;
  let bestScore = -9999;
  for (let x = 0; x < game.map.length; x++) {
    for (let y = 0; y < game.map[x].length; y++) {
      const p = [x, y];
      if (samePos(p, myPos)) continue;
      if (!isPassable(game, p, null)) continue; // 不能是墙或土块
      if (anyBulletThreatens(enemyBullets, p, game)) continue; // 不能在子弹轨迹上
      if (manhattan(p, enemyGuess) <= ASSASSIN_MAX_RANGE) continue; // 避开敌人可能出现的地方

      const score = -manhattan(p, game.star) * 3 + distanceFromEdges(p, game);
      if (score > bestScore) {
        bestScore = score;
        best = p;
      }
    }
  }
  return best;
}

/**
 * 遍历全图，评估并返回最佳的通用传送落点
 * minEnemyDist: 落点与敌人的最小曼哈顿距离门槛（防开火锁定/对射），0 表示不限制。
 */
function bestTeleportTile(myPos, enemyTank, enemyBullets, game, target, preferDistance, minEnemyDist, enemy) {
  let best = null;
  let bestScore = -9999;
  // 抢星落点(target 是星)额外排除"紧贴横扫子弹、走向会撞弹道"的陷阱落点(mat_GwxblYdS)。
  const avoidSweep = target && game.star && samePos(target, game.star);
  for (let x = 0; x < game.map.length; x++) {
    for (let y = 0; y < game.map[x].length; y++) {
      const p = [x, y];
      if (samePos(p, myPos)) continue;
      if (!isTeleportSafe(p, enemyTank, enemyBullets, game, minEnemyDist || 0, enemy)) continue;
      if (avoidSweep && landingNearSweepingBullet(p, enemyBullets, game)) continue;

      const enemyPos = enemyTank ? enemyTank.position : null;
      // 偏好远离敌人打分
      const enemyScore = enemyPos ? manhattan(p, enemyPos) : 0;
      // 偏好靠近目标(如星星)打分
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

/**
 * 判断某个坐标是否适合传送（不卡墙、不接子弹、不被瞄准）
 * minEnemyDist: 与敌人的最小允许曼哈顿距离，0 表示不限制。
 */
function isTeleportSafe(p, enemyTank, enemyBullets, game, minEnemyDist, enemy) {
  const enemyPos = enemyTank ? enemyTank.position : null;
  if (!isPassable(game, p, enemyPos)) return false;
  const bullets = enemyBullets || [];
  for (let i = 0; i < bullets.length; i++) {
    if (bullets[i] && samePos(p, bullets[i].position)) return false;
  }
  if (enemyAimsAt(p, enemyTank, game)) return false;
  if (anyBulletThreatens(bullets, p, game)) return false;
  // 避免落点离敌人太近（曼哈顿距离<=4会被开火锁定，且易被对射）
  if (minEnemyDist > 0 && enemyPos && manhattan(p, enemyPos) <= minEnemyDist) return false;
  // 避免落在敌方清晰炮线上的近距(<=4)：敌人转身即可开火，我落地多半来不及脱离（闪现送死，见 mat_JYuX/mat_1BN）
  if (enemyPos && manhattan(p, enemyPos) <= 4 && clearShotDirection(enemyPos, p, game)) return false;
  // 过载敌人：落点不能进双弹覆盖带(敌同行/列 或 相邻±1 行/列且近距)——副弹走相邻列，严格同线判定会漏(mat_EHR 传 [17,10] 距敌3格相邻列被秒)
  if (enemyPos && enemyDoubleLaneThreat(enemy) && inDoubleLaneBand(enemyPos, p, 6)) return false;
  if (predictedOverloadThreatens(enemy, p, game)) return false;
  return true;
}

/**
 * 战术走位决策引擎。
 * 安全站位核心：根据敌方威胁动态决定与敌人的"最小安全间距"，避免走进会被秒的近身死区；
 * 隐身敌人按最后已知位置避让；逼近敌人时停在能开火又留有躲弹余地的距离。
 */
/**
 * 步伐安全守门：next 格不进死区且不踏入敌能封锁的死胡同。
 * 各分支的死区复检统一走这里，消除重复的 stepEntersKillZone + stepIntoSealedDeadEnd 调用。
 * allowStarDeadEnd：星就在死格里时仍允许进入（不因噎废食）。
 */
function isSafeStep(next, myPos, enemyPos, game, enemy, standoff, allowStarDeadEnd, enemyBullets) {
  if (!next) return false;
  if (enemyPos && stepEntersKillZone(myPos, next, enemyPos, game, enemy, standoff)) return false;
  if (stepIntoSealedDeadEnd(next, enemyPos, game) && !allowStarDeadEnd) return false;
  // M1/M2: overload 流时，走进"横向出口<=1格且无法跨出双弹带"的窄兜也视为危险。
  // 副弹封相邻列时角落里横向根本跑不掉（mat_8xLQ/mat_Ae1A：[17,13]仅[16,13]一个出口被副弹封死）。
  if (enemyPos && enemyIsOverloadType(enemy) && !allowStarDeadEnd) {
    if (!hasDoubleLaneEscapeAt(next, enemyPos, game) && inDoubleLaneBand(enemyPos, next, standoff + 2)) return false;
  }
  // 还要排除下一帧会扫到的子弹轨道，避免“当前安全、下一拍吃弹”的假安全。
  if (enemyBullets && stepIntoBulletPath(enemyBullets, next, game)) return false;
  if (predictedOverloadThreatens(enemy, next, game)) return false;
  return true;
}

/**
 * 走位候选打分核心（收益层评估）。
 * 按照 agile-splashing-willow 重构计划第 5 点：建立打分维度。
 * 综合评估一个格子在抢星、开火、规避、巡逻等多个维度下的价值。
 * 这里不直接决定“走哪步”，而是纯粹地“给这一步打分”，最终选最高分的格子执行。
 * 
 * 评分维度包括：
 * - 生存约束（子弹/死区/预瞄直接扣到底：-9999）
 * - 基础走位收益（远离边缘、开阔度、当前朝向优先）
 * - 对峙/拉扯收益（靠近 standoff 环、控枪线）
 * - 抢星收益（距离缩短奖励、落后/终局时的紧急性乘数）
 * - 特定动作奖励（如之字脱离、跨出双弹带、巡逻粘性保持等）
 */
function scoreMoveCandidate(kind, step, me, enemy, game, enemyPos, enemyTank, enemyBullets, state, meta, isLeading, isTrailing, framesLeft) {
  if (!step) return -9999;

  const myPos = me.tank.position;
  const bullets = enemyBullets || [];
  const safe = meta && meta.allowStarDeadEnd;
  const standoff = safeStandoffDistance(enemy);

  // 【生存硬约束】：直接否决死区和必死位置（重构计划第 3 点：生存层闸门）
  if (!isPassable(game, step, enemyPos)) return -9999;
  if (stepIntoBulletPath(bullets, step, game)) return -9999;
  if (predictedOverloadThreatens(enemy, step, game)) return -9999;
  if (enemyPos && stepEntersKillZone(myPos, step, enemyPos, game, enemy, standoff)) return -9999;
  if (enemyPos && enemyDoubleLaneThreat(enemy) && inDoubleLaneBand(enemyPos, step, standoff) && !hasDoubleLaneEscapeAt(step, enemyPos, game)) return -9999;
  // 追星前瞻（十字线安全原则，mat 吃完星被困空转挨双弹复盘）：对 overload 敌，抢星落点即使此刻有横向脱离，
  // 也要前瞻"吃完星、敌朝我逼近一步后"是否仍在双弹覆盖带且无脱离——过载敌会追着移动，吃星瞬间的出路常在
  // 下一帧被封死(站到星点的下一帧四向全被双弹覆盖 -> 只能原地空转挨双弹)。宁可不吃这颗星，也不钻进会被封的过载十字线。
  if (kind === "star" && enemyPos && enemyDoubleLaneThreat(enemy) &&
      starGrabTrapsInOverloadLane(step, enemyPos, game)) return -9999;
  if (stepIntoSealedDeadEnd(step, enemyPos, game) && !safe) return -9999;

  let score = 0;
  const dir = directionBetween(myPos, step);
  const turnCost = dir ? turnDistance(me.tank.direction, dir) : 0;
  const open = openNeighborCount(step, game);

  // 【基础占位/稳定性收益】：开阔度、降低转头损耗、优先保持当前朝向
  const distEdge = distanceFromEdges(step, game);
  const isOverload = enemyIsOverloadType(enemy);

  if (kind === "star") {
    // 【特判】：抢星时，无视转圈躲避或占中心的规则，以最快吃星为主（只保留微弱的防贴墙）
    score += distEdge * 1;
  } else if (isOverload) {
    // 面对双弹流(Overload)的日常走位：围绕底图边缘转圈躲避（形成环形跑道）
    // 不去正中心（容易被双弹交叉封死四面八方），偏好距边缘 1~2 格的位置
    // 有星星时削减外圈加分，让追星候选能打赢外圈巡逻（星星是唯一得分途径）
    // 面对双弹流(Overload)：在内圈跑道（distEdge=2~4）绕圈，而非贴最外墙皮（distEdge=1）。
    // 内圈原因：① 星星更多刷新在内区；② 机动空间更大；③ 贴墙反而被封死方向。
    // 有星时削减环形加分，让追星候选打赢巡逻。
    const ringBonus = game.star ? 3 : 6;
    if (distEdge <= 1) score -= 4;               // 贴最外墙皮，减分
    else if (distEdge > 4) score -= (distEdge - 4) * 2; // 太靠中心，轻微减分
    else score += ringBonus;                      // distEdge=2~4：理想内圈跑道
  } else {
    // 面对其他技能(如传送、护盾)的日常走位：正常积极走中心，控制视野
    score += distEdge * 3; 
  }

  score += open * 2;
  score -= turnCost * 3;
  if (dir === me.tank.direction) score += 8;
  if (state && state.stuckFrames >= 2 && dir === me.tank.direction) score += 4; // 卡墙时强烈鼓励沿当前方向破局

  // 严厉的死角惩罚：防止为了拉扯距离而退进角落
  if (kind !== "star" && kind !== "bandEscape") {
    if (isDeadEnd(step, game)) {
      score -= 30; // 绝不进单出口的死胡同
    } else if (open <= 2 && distEdge <= 1) {
      score -= 15; // 强烈不建议退到地图边缘的死角(只有2个或更少出口)
    }
  }

  // 【对峙/压制收益】：维护最佳交火距离 (standoff)，争取射击窗口，惩罚送人头贴脸
  if (enemyPos) {
    const de = manhattan(step, enemyPos);
    // 理想距离：若为抢枪线(lane)可更激进，否则保持安全 standoff
    const ideal = kind === "lane" ? Math.max(3, standoff - 1) : standoff;
    
    if (isOverload) {
      // 双弹流：保命优先，严格保持交火拉扯距离
      score += Math.max(0, 16 - Math.abs(de - ideal) * 4);
    } else {
      // 其他流派：积极抢星，放宽对理想交战距离的执念
      if (kind === "star") {
        // 抢星时，偏离理想距离只扣 2 分（原先是 4 分）
        score += Math.max(0, 8 - Math.abs(de - ideal) * 2);
      } else {
        // 日常走位，保持严格拉扯（扣 4 分）
        score += Math.max(0, 16 - Math.abs(de - ideal) * 4);
      }
    }
    
    if (de <= 1) score -= 40; // 严禁贴脸送死
    if (de <= 3 && kind !== "star" && kind !== "bandEscape") score -= 12; // 非抢星/逃生时不靠近
    if (clearShotDirection(step, enemyPos, game)) {
      score += (kind === "lane" || kind === "standoff" || kind === "star") ? 14 : 5; // 获得同线开火权大幅加分
    }
    if (enemyAimsAt(step, enemyTank, game)) score -= de <= 4 ? 30 : 12; // 走进别人枪口重罚
    if (enemyDoubleLaneThreat(enemy) && inDoubleLaneBand(enemyPos, step, standoff)) {
      score -= kind === "bandEscape" ? 5 : 15; // 逗留双弹带重罚，除非就是来逃离的
    }
  }

  // 【抢星收益】：基于当前比分和剩余帧数的动态加权
  if (game.star) {
    const ds = manhattan(step, game.star);
    // 落后时抢星欲望翻倍；领先但我是这颗星的“热门”(明显比敌近)时同样翻倍——该我吃的星别让。
    const isFavorite = !!(meta && meta.favorite);
    const urg = (isTrailing || isFavorite) ? 2 : 1;
    // 拉远感知距离：原 26-ds*4 在 ds>6 时归零，外圈巡逻分数反而更高，导致不追远星。
    // 改为 28-ds*3：感知半径扩至 9 格，平局时远星也有牵引力，不再只靠落后时的 urg 加权。
    const starPulse = Math.max(0, 28 - ds * 3) * urg;
    if (kind === "star") {
      score += starPulse + 12 * urg;
      if (samePos(step, game.star)) score += 40 * urg; // 直接吃到星满分
      if (clearShotDirection(step, game.star, game)) score += 12 * urg; // 拿到抢星防守线加分
      // 第二优先级：最优压制位抢星——抢星路径上的这一格若同时能直射敌人，说明它兼具
      // “吃星”和“压制”双重价值，优先走它，引导坦克沿“能压住敌人的路线”去抢星而非绕远路。
      if (enemyPos && clearShotDirection(step, enemyPos, game)) {
        const de = manhattan(step, enemyPos);
        score += 10;                              // 抢星顺带占枪线
        if (de >= 2 && de <= standoff + 1) score += 8; // 且处于安全压制距离（不贴脸、不太远）
      }
      if (framesLeft <= 30) score += Math.max(0, 18 - ds * 2); // 终局抢星加权
      // 近距离星紧急度：≤4步时补分，防止攻击提案（lane/standoff）靠 clearShot+方向奖励抢走优先级
      const myStarDist = manhattan(myPos, game.star);
      if (myStarDist <= 4) score += Math.max(0, 16 - myStarDist * 3) * urg;
      // 与 scoring.js braveBonus 同步：把外层提案评分的落后/终局加权，
      // 下沉到内部走位竞争，让追星候选能在 chooseMoveCandidateScored 里直接打赢外圈巡逻。
      // 热门星(isFavorite)等同落后处理：领先时也要赢下绕圈/巡逻惯性(mat_2Bc f104 让星复盘)。
      if (isTrailing || isFavorite) score += 20;
      if ((isTrailing || isFavorite) && framesLeft <= 20) score += 25;
      if (framesLeft <= 10) score += 20;
    } else {
      score += Math.max(0, 12 - ds * 2); // 其他移动动作若顺路靠近星也稍微加分
    }
  }

  // ====== 下方为各类特殊策略动作 (kind) 的专有补偿加分 ======

  if (kind === "patrol") {
    // 巡逻逻辑：鼓励向目标靠近，保持意图粘性，远离隐身敌人的最后出没地
    if (meta && meta.target) {
      const stepDist = manhattan(step, meta.target);
      const myDist   = manhattan(myPos, meta.target);
      // 原公式 18-dist*3 在 dist>6 时归零，导致远目标毫无引力，坦克只在起点外圈来回刷。
      // 改为线性衰减：每步 -1 分但始终非负，远目标仍有方向感。
      score += Math.max(0, 20 - stepDist);
      // 额外奖励：每步靠近巡逻目标
      if (stepDist < myDist) score += 8;
    }
    if (state && state.patrolTarget && meta && samePos(meta.target, state.patrolTarget)) score += 12;
    if (!game.star && !enemyPos) score += 20; // 纯垃圾时间巡逻大幅加成，避免罚站
    if (state && state.lastEnemyPos && ((game.frames || 0) - state.lastEnemySeenFrame <= 12)) {
      score -= Math.max(0, 18 - manhattan(step, state.lastEnemyPos) * 4);
      if (enemyIsCloakType(enemy)) score -= 10;
    }
  }

  if (kind === "bush") {
    // 蹲草逻辑：进入草丛大幅奖励，避免被瞄准奖励
    if (tileAt(game, step) === "o") score += 20;
    if (meta && meta.hidden) score += 8;
    if (enemyPos && !enemyAimsAt(step, enemyTank, game)) score += 6;
    if (enemyPos && tileAt(game, step) === "o" && !clearShotDirection(step, enemyPos, game)) score += 10;
  }

  if (kind === "bandEscape") {
    // 逃离双弹带：鼓励彻底跨出覆盖带（x和y都错开），避免在带内平行滑步
    if (enemyPos) {
      const dx = Math.abs(step[0] - enemyPos[0]);
      const dy = Math.abs(step[1] - enemyPos[1]);
      if (dx >= 2 && dy >= 2) score += 30;
      else score -= 10;
      if (manhattan(step, enemyPos) >= manhattan(myPos, enemyPos)) score += 8;
    }
  }

  if (kind === "zigzag") {
    // 之字形逃跑（针对隐身）：强烈鼓励每步换轴走，走出折线，避免顺线被子弹追死
    const axis = Math.abs(step[0] - myPos[0]) !== 0 ? 0 : 1;
    if (state && state.lastEvadeAxis !== undefined) {
      score += axis !== state.lastEvadeAxis ? 10 : -3;
    }
    if (meta && meta.dangerPos) score += manhattan(step, meta.dangerPos) * 2;
  }

  if (kind === "ambush" || kind === "avoid") {
    if (meta && meta.dangerPos) {
      score += manhattan(step, meta.dangerPos) * 2;
      if (step[0] !== meta.dangerPos[0] && step[1] !== meta.dangerPos[1]) score += 8;
    }
  }

  if (kind === "safeNeighbor") {
    score += 8;
  }

  if (kind === "center") {
    const center = nearestOpenToCenter(game);
    if (center) score += Math.max(0, 16 - manhattan(step, center) * 2);
    if (!game.star && !enemyPos) score -= 18;
  }

  if (meta && meta.target && samePos(step, meta.target)) score += 10;
  return score;
}

/**
 * 生成候选步数池 (Candidate Proposal Generation)
 * 按照 agile-splashing-willow 重构计划第 6 点：建立统一提案器。
 * 本方法将过去零散的各类“移动策略”（如追星、拉扯、逃离双弹、防守巡逻等），
 * 全部当做平等的 Proposal 来源。每个策略算出其建议的格子后，统统塞入同一个备选池 (candidates)，
 * 经过 isSafeStep 门控过滤后，由 scoreMoveCandidate 给出评估分。
 */
function buildMoveCandidates(me, enemy, game, enemyPos, state, enemyBullets) {
  const enemyTank = enemy && enemy.tank ? enemy.tank : null;
  const bullets = enemyBullets !== undefined && enemyBullets !== null ? enemyBullets : collectEnemyBullets(enemy);
  const myPos = me.tank.position;
  const frame = (game && game.frames) || 0;
  const framesLeft = MAX_GAME_FRAMES - frame;
  const enemyStars = enemy && typeof enemy.stars === "number" ? enemy.stars : 0;
  const isLeading = (me.stars || 0) > enemyStars;
  const isTrailing = (me.stars || 0) < enemyStars;
  const candidates = [];
  const seen = {};

  // push: 将一种策略建议的格子及其元数据注册到备选池。
  // 内置基于 isSafeStep 的硬生存闸门（重构计划第 3 点生存层），挡掉一切必死步。
  // 通过闸门的格子，才会调用 scoreMoveCandidate 进行打分。
  function push(kind, step, meta) {
    if (!step) return;
    const localMeta = meta || {};
    const allowStarDeadEnd = !!localMeta.allowStarDeadEnd;
    const standoff = safeStandoffDistance(enemy);
    // 【硬约束门控】：必死或踩子弹的格子直接抛弃，不进入打分环节
    if (!isSafeStep(step, myPos, enemyPos, game, enemy, standoff, allowStarDeadEnd, bullets)) return;
    const score = scoreMoveCandidate(kind, step, me, enemy, game, enemyPos, enemyTank, bullets, state, localMeta, isLeading, isTrailing, framesLeft);
    if (score <= -9000) return;
    const k = key(step) + "|" + kind;
    const prev = seen[k];
    const cand = { kind, step, score, meta: localMeta };
    if (!prev || cand.score > prev.score) seen[k] = cand; // 去重保留最高分
  }

  // ====== 以下为原离散策略函数转化为统一动作提案的过程 ======

  // 1. 抢星提案
  if (game.star) {
    const starPath = shortestPathInfo(myPos, game.star, game, enemyPos);
    // fleeMode: 敌人连续背对逃跑达到阈值，追星判定会放宽（对纯跑分流不用再客气）
    if (shouldChaseStar(myPos, enemyPos, game, starPath, enemy, !!(state && state.enemyFleeFrames >= ENEMY_FLEE_THRESHOLD)) && starPath && starPath.step) {
      // 抢星热门判定：我到星的步数 +1(留转向缓冲) 仍严格小于敌人 = 这颗星“该我吃”，
      // 评分时等同落后欲望，避免领先时被 overload 绕圈/巡逻惯性压过让出热门星(mat_2Bc f104)。
      const enemyStarDist = enemyPos ? pathDistance(enemyPos, game.star, game, myPos) : -1;
      const iAmStarFavorite = enemyStarDist < 0 || starPath.dist + 1 < enemyStarDist;
      // kind="star"：追星提案，向星星的最短路径迈进
      push("star", starPath.step, { target: game.star, allowStarDeadEnd: samePos(starPath.step, game.star), favorite: iAmStarFavorite });

      // 贴脸星粘性：星在 2 步内、我是热门、敌此刻无实弹在途(只是预瞄=概率威胁)且抢星步不送死时，
      // 锁定一个 2 步短意图直奔星——避免被防瞄/对峙的逐帧转向打断在原地抖动错失脚边星
      // (mat_GwxblYdS f32-41：星[8,13]就在脚下[8,12]，敌还在远处没开火，我却反复 turn 没走下去，
      //  等敌子弹飞进星行后被弹道判定每帧劝退，星被对手走路抢走)。
      const starWalk = starPath.dist;
      const enemyHasLiveBullet = !!(enemy && enemy.bullet && enemy.bullet.position);
      const standoff = safeStandoffDistance(enemy);
      const grabSafe = isSafeStep(starPath.step, myPos, enemyPos, game, enemy,
        standoff, samePos(starPath.step, game.star), bullets);
      if (state && starWalk >= 0 && starWalk <= 2 && iAmStarFavorite &&
          !enemyHasLiveBullet && !enemyDoubleLaneThreat(enemy) && grabSafe &&
          !(state.shortIntent && state.shortIntent.kind === "star")) {
        primeShortIntent(state, "star", game.star, frame, 2);
      }
    }
  }

  // 2. 视野内敌方压制 / 对峙提案
  if (enemyPos) {
    if (!enemyIsOverloadType(enemy)) {
      // 抢占开火线
      // kind="lane"：寻找并走向能直射敌人的轨道格
      push("lane", nextStepToFiringLane(myPos, enemyPos, game, safeStandoffDistance(enemy)), { target: enemyPos });
    }

    // 维持拉扯距离 (standoff)
    const standoffStep = nextStepToStandoff(myPos, enemyPos, game, safeStandoffDistance(enemy), enemy, bullets);
    if (standoffStep) {
      // kind="standoff"：拉扯提案，保持最佳交火距离（太近后退、太远逼近）
      push("standoff", standoffStep, { target: enemyPos });
      // 如果 standoff 把我逼进死角，抛出破局改道提案
      if (stepIntoSealedDeadEnd(standoffStep, enemyPos, game)) {
        // kind="safeNeighbor"：遇死角时的备用脱困提案（找最安全的邻格）
        push("safeNeighbor", safestNonDeadEndStep(myPos, game, enemyPos, bullets), { target: enemyPos });
      }
    }

    // 若敌人握有双弹，产出紧急跨出双弹带的脱离提案
    // 门控：只在真正危险时触发——已激活过载(d<=6)，或冷却就绪但我已在带内(d<=4)
    if (enemyDoubleLaneThreat(enemy)) {
      const distToEnemy = manhattan(myPos, enemyPos);
      const activeOverload = enemy && enemy.status && enemy.status.overloaded;
      const shouldEscape = activeOverload
        ? (distToEnemy <= 6 && inDoubleLaneBand(enemyPos, myPos, 6))
        : (distToEnemy <= 4 && inDoubleLaneBand(enemyPos, myPos, 4));
      if (shouldEscape) {
        push("bandEscape", escapeDoubleLaneBand(myPos, enemyPos, game, bullets), { target: enemyPos });
      }
    }

    // 对手是过载流且当前无星，抛出草丛蹲守安全位提案
    if (enemyIsOverloadType(enemy) && !game.star) {
      // kind="bush"：蹲草提案，奔向安全草丛隐藏视野，躲避双弹锁定
      push("bush", nextStepToSafeBush(me, enemy, game, enemyPos, safeStandoffDistance(enemy), bullets), { hidden: true });
    }
  }

  // 3. 视野外敌方规避提案（隐身/草丛防御）
  if (state && state.lastEnemyPos && ((game.frames || 0) - state.lastEnemySeenFrame <= 8)) {
    if (enemyIsCloakType(enemy)) {
      // kind="zigzag"：防隐身背刺提案，每步强制交替换轴，走出折线防直线追击
      push("zigzag", diagonalEvadeStep(myPos, state.lastEnemyPos, game, state), { dangerPos: state.lastEnemyPos });
    }
    // kind="ambush"：防伏击提案，横向跨出隐身敌人的最后已知瞄准线
    push("ambush", escapeAmbushLine(myPos, state.lastEnemyPos, game, bullets), { dangerPos: state.lastEnemyPos });
    // kind="avoid"：避让提案，与隐身敌人的已知位置保持安全距离
    push("avoid", nextStepAvoiding(myPos, state.lastEnemyPos, game, safeStandoffDistance(enemy) + 1, bullets, enemy), { dangerPos: state.lastEnemyPos });
  }

  // 4. 兜底移动提案（巡逻、向中心靠拢、安全徘徊）
  const vt = virtualPatrolTarget(me, game, state, enemy);
  if (vt) {
    const patrolStep = nextStepToward(myPos, vt, game, null);
    // kind="patrol"：巡逻提案，向虚拟巡逻点移动，保持机动性防挂机
    push("patrol", patrolStep || safestNonDeadEndStep(myPos, game, enemyPos, bullets), { target: vt });
  }

  // kind="center"：向心提案，向地图中心靠拢，争取更开阔的机动空间
  push("center", nextStepToward(myPos, nearestOpenToCenter(game), game, null), { target: nearestOpenToCenter(game) });
  // kind="safeNeighbor"：终极生存兜底，找最安全的邻格苟活
  push("safeNeighbor", bestSafeNeighbor(myPos, game, enemyPos, enemyTank, bullets, enemy), {});

  const keys = Object.keys(seen);
  for (let i = 0; i < keys.length; i++) candidates.push(seen[keys[i]]);
  return candidates;
}

/**
 * 最终打分裁决与意图固化 (Scoring Adjudication & Intent Priming)
 * 按照 agile-splashing-willow 重构计划，这里将做两件事：
 * 1. 裁决：对 buildMoveCandidates 返回的所有安全候选格子，按分数进行排序。
 *    若分数相同，按策略优先级 (rank) 和远离墙角 (distanceFromEdges) 决胜。
 * 2. 意图固化（重构计划第 3 点计划层）：对于那些具有“长期收益”但当前步得分优势微弱的行动
 *    （比如长途追星、巡逻），将其写入 `shortIntent` 缓存，在接下来几帧内优先续跑，
 *    避免因为分数的微小抖动而反复横跳。
 */
function chooseMoveCandidateScored(me, enemy, game, enemyPos, state, enemyBullets) {
  const bullets = enemyBullets !== undefined && enemyBullets !== null ? enemyBullets : collectEnemyBullets(enemy);
  const candidates = buildMoveCandidates(me, enemy, game, enemyPos, state, bullets);
  if (candidates.length === 0) return null;

  // 策略降级优先级字典，用于同分决胜
  const rank = { star: 9, bandEscape: 8, lane: 7, standoff: 6, bush: 6, zigzag: 5, ambush: 5, avoid: 4, patrol: 3, safeNeighbor: 2, center: 1 };
  const isOverload = enemyIsOverloadType(enemy);
  
  candidates.sort(function (a, b) {
    // 主排序：按得出的总分降序
    if (b.score !== a.score) return b.score - a.score;
    // 同分降级 1：优先执行高阶战术动作
    const rb = rank[b.kind] || 0;
    const ra = rank[a.kind] || 0;
    if (rb !== ra) return rb - ra;
    // 同分降级 2：占位偏好
    if (isOverload && a.kind !== "star" && b.kind !== "star") {
      // 双弹环绕：倾向于边缘距离 1~2
      return Math.abs(distanceFromEdges(a.step, game) - 1.5) - Math.abs(distanceFromEdges(b.step, game) - 1.5);
    }
    return distanceFromEdges(b.step, game) - distanceFromEdges(a.step, game);
  });

  const best = candidates[0];
  if (!best) return null;


  return best;
}

function chooseStepScored(me, enemy, game, enemyPos, state, enemyBullets) {
  const best = chooseMoveCandidateScored(me, enemy, game, enemyPos, state, enemyBullets);
  return best ? best.step : null;
}

// 兼容旧测试与旧调用入口：新版实现仍走统一评分裁决。
function chooseStep(me, enemy, game, enemyPos, state, enemyBullets) {
  return chooseStepScored(me, enemy, game, enemyPos, state, enemyBullets);
}

/**
 * 在四邻里挑一个"非被封锁死胡同"的安全开阔格走一步：优先开口多、离边远、不在敌炮线的格。
 * 用于巡逻/走位即将踏进墙角死路时改道（mat_2Wz）。
 */
function safestNonDeadEndStep(myPos, game, enemyPos, enemyBullets) {
  let best = null, bestScore = -9999;
  const bullets = enemyBullets || [];
  for (let i = 0; i < DIRS.length; i++) {
    const p = [myPos[0] + DIRS[i].dx, myPos[1] + DIRS[i].dy];
    if (!isPassable(game, p, enemyPos)) continue;
    if (stepIntoSealedDeadEnd(p, enemyPos, game)) continue; // 跳过会被封锁的死胡同
    if (stepIntoBulletPath(bullets, p, game)) continue;
    const sealed = enemyPos && clearShotDirection(enemyPos, p, game) ? -4 : 0; // 敌能直线打到的格降权
    const score = openNeighborCount(p, game) * 3 + distanceFromEdges(p, game) + sealed;
    if (score > bestScore) { bestScore = score; best = p; }
  }
  return best;
}

/**
 * 虚拟巡逻目标：无真星星时给坦克一个移动目标，避免原地空转挨打。
 * 目标"粘性"：一旦选定就持续走向它直到到达(或失效/逼近危险)，再换下一个，避免每帧重选导致来回横跳。
 * 选点：四象限中心的开阔格里，离我足够远(保证移动)、且远离隐身敌人最后已知位置。
 *
 * overload 流优化（mat_KxY8/mat_C5iE）：敌从对角逼近时，我会被推进同侧墙角来回震荡。
 * 对 overload 流，给"在敌方对侧象限"的锚点额外加分，驱动绕到敌人背面开阔地而非同侧徘徊。
 * 同时对"贴地图边缘(distanceFromEdges<=2)"的锚点降权，避免选进死角。
 */
function virtualPatrolTarget(me, game, state, enemy) {
  const myPos = me.tank.position;
  const danger = state && state.lastEnemyPos && ((game.frames || 0) - state.lastEnemySeenFrame <= 12)
    ? state.lastEnemyPos : null;
  const enemyPos = enemy && enemy.tank ? enemy.tank.position : null;

  // 已有粘性目标且仍有效(未到达、可通行、不贴危险点) -> 继续用，保持稳定航向
  if (state && state.patrolTarget) {
    const t = state.patrolTarget;
    const reached = manhattan(myPos, t) <= 1;
    const nearDanger = danger && manhattan(t, danger) <= 2;
    if (!reached && isPassable(game, t, null) && !nearDanger) return t;
    state.patrolTarget = null; // 失效，重选
  }

  const w = game.map.length, h = game.map[0].length;
  const cx = Math.floor(w / 2), cy = Math.floor(h / 2);
  const ax = [Math.floor(w / 4), Math.floor(w * 3 / 4)];
  const ay = [Math.floor(h / 4), Math.floor(h * 3 / 4)];
  const anchors = [];
  for (let i = 0; i < ax.length; i++) for (let j = 0; j < ay.length; j++) {
    const o = nearestOpenTo(game, [ax[i], ay[j]]);
    if (o) anchors.push(o);
  }
  // 被动跑分型 teleport 敌：把地图中心也作为候选锚点——守中心十字区离任何方向新刷的星都近(mat_GwxblYdS)。
  const passiveRusher = enemyIsPassiveRusher(enemy, enemy && enemy.tank, game, myPos);
  if (passiveRusher) {
    const center = nearestOpenTo(game, [cx, cy]);
    if (center) anchors.push(center);
  }
  if (anchors.length === 0) return null;

  const isOverload = enemyIsOverloadType(enemy);

  let best = null, bestScore = -9999;
  for (let i = 0; i < anchors.length; i++) {
    const p = anchors[i];
    const distMe = manhattan(p, myPos);
    if (distMe < 4) continue; // 太近的不作为目标(到了就停=空转)
    const dangerScore = danger ? manhattan(p, danger) * 2 : 0;
    const edgeD = distanceFromEdges(p, game);
    // overload 流：贴边锚点降权(-8)；对侧象限加分(+6)，驱动绕到敌人背面
    let overloadBonus = 0;
    if (isOverload && enemyPos) {
      if (edgeD <= 1) overloadBonus -= 8; // 贴最外墙降权，内圈锚点不受影响
      // 对侧象限：x 方向对侧 + y 方向对侧各 +3
      const oppX = (enemyPos[0] > cx) ? p[0] < cx : p[0] > cx;
      const oppY = (enemyPos[1] > cy) ? p[1] < cy : p[1] > cy;
      if (oppX) overloadBonus += 3;
      if (oppY) overloadBonus += 3;
    }
    // 被动跑分敌：不靠"远离敌"拉开(它不主动打)，改为偏好靠近中心十字区(抢下一颗星更快)。
    // 抵消 dangerScore 的远离驱动，并按离中心距离加分(越居中越高)。
    let rusherBonus = 0;
    if (passiveRusher) {
      const centerD = Math.abs(p[0] - cx) + Math.abs(p[1] - cy);
      rusherBonus = Math.max(0, 8 - centerD) * 2; // 居中 +16，外圈逐渐归零
      if (edgeD <= 1) rusherBonus -= 6;            // 仍不选贴墙死角
    }
    const dangerWeight = passiveRusher ? 0 : 1;     // 被动跑分敌不为"远离它"巡逻
    const score = dangerScore * dangerWeight + distMe + edgeD + overloadBonus + rusherBonus;
    if (score > bestScore) { bestScore = score; best = p; }
  }
  if (best && state) state.patrolTarget = best; // 记住，保持航向
  return best;
}

/**
 * 找最接近目标坐标 target 的可通行开阔格(空地/草丛)。
 */
function nearestOpenTo(game, target) {
  let best = null, bestD = 9999;
  for (let x = 0; x < game.map.length; x++) {
    for (let y = 0; y < game.map[x].length; y++) {
      if (!isPassable(game, [x, y], null)) continue;
      const d = Math.abs(x - target[0]) + Math.abs(y - target[1]);
      if (d < bestD) { bestD = d; best = [x, y]; }
    }
  }
  return best;
}

/**
 * 我此刻是否藏在草丛里（对敌方脚本隐身）。草丛 'o' 或被冰冻/技能标记 cloaked 均算。
 */
function iAmHidden(me, game) {
  return !!((me.status && me.status.cloaked) || tileAt(game, me.tank.position) === "o");
}

/**
 * 奔草丛躲双弹：面对 overload 双弹流、无星可安全抢的空窗期，走向最近的"安全草丛"蹲守，
 * 让敌方脚本失去我的位置(enemy.tank=null)——双弹无从瞄准；保留传送等星刷新再闪现抢分(用户策略)。
 * 安全草丛要求：可站、不在敌近距死区(stepEntersKillZone)、不落在握弹敌的双弹覆盖带里。
 * 返回朝最近安全草丛的下一步；找不到(或我已在草丛里)返回 null，交上层巡逻/兜底。
 * 仅对 overload 流敌人触发，避免对普通敌防过头。
 */
function nextStepToSafeBush(me, enemy, game, enemyPos, standoff, enemyBullets) {
  const myPos = me.tank.position;
  const bullets = enemyBullets || [];
  if (tileAt(game, myPos) === "o") return null; // 已在草丛，不必再找
  let bestBush = null, bestD = 9999;
  for (let x = 0; x < game.map.length; x++) {
    for (let y = 0; y < game.map[x].length; y++) {
      if (tileAt(game, [x, y]) !== "o") continue;          // 只找草丛格
      const c = [x, y];
      if (!isPassable(game, c, enemyPos)) continue;
      if (samePos(c, myPos)) continue;
      // 草丛本身不能在敌握弹双弹带/近距死区(躲进去反被秒，mat_EHR 落点不安全的教训)
      if (enemyPos && stepEntersKillZone(myPos, c, enemyPos, game, enemy, standoff)) continue;
      if (enemyPos && enemyDoubleLaneThreat(enemy) && inDoubleLaneBand(enemyPos, c, standoff)) continue;
      if (stepIntoBulletPath(bullets, c, game)) continue;
      const d = pathDistance(myPos, c, game, enemyPos);
      if (d < 0) continue;                                  // 不可达
      if (d < bestD) { bestD = d; bestBush = c; }
    }
  }
  if (!bestBush) return null;
  const step = nextStepToward(myPos, bestBush, game, enemyPos);
  if (!step || !enemyPos) return step;
  // 奔草丛途中这一步也不许进死区(穿过握弹敌炮线)
  if (stepEntersKillZone(myPos, step, enemyPos, game, enemy, standoff)) return null;
  if (stepIntoBulletPath(bullets, step, game)) return null;
  // 握双弹敌：途中这一步也不要顺着敌人正行/列往敌人方向挪(BFS 可能沿敌列直上)，
  // 宁可这一步先横向脱出双弹带——若该步留在带内且比当前更靠近敌人，改用横移脱带步。
  if (enemyDoubleLaneThreat(enemy) && inDoubleLaneBand(enemyPos, step, standoff) &&
      manhattan(step, enemyPos) < manhattan(myPos, enemyPos)) {
    const bandEscape = escapeDoubleLaneBand(myPos, enemyPos, game, bullets);
    if (bandEscape) return bandEscape;
    return null; // 没有更好的脱带步，交上层巡逻，别朝握弹敌挪
  }
  return step;
}


/**
 * 与敌人的最小安全间距：
 * - 双弹威胁(已过载/过载就绪)：6 格(双弹随时来，最危险)；
 * - overload 流但冷却中：5 格(冷却好就双弹，不能贴身缠斗，保守周旋 mat_D9W)；
 * - 隐身敌人：5 格；普通敌人：4 格。5~6 格是子弹约 3 帧到达的距离，配合横移刚好够躲。
 */
function safeStandoffDistance(enemy) {
  if (enemyDoubleLaneThreat(enemy)) return 6;
  if (enemyIsOverloadType(enemy)) return 5;
  // freeze 流：冻我 2 帧期间敌可从容对准开火，贴近(<=4 同线)被冻必死，保守拉到 5 格周旋(mat_0Wmx)。
  if (enemyIsFreezeType(enemy)) return 5;
  if (enemy && enemy.skill && enemy.skill.type === "cloak") return 5;
  return 4;
}

/**
 * 判断走到 next 后是否进入"会被秒的死区"。
 * 子弹 2 格/帧 + 我转向 1 帧：3 格内只要需要转向就躲不掉，故普通敌人 d<=3 即死区。
 * 双弹威胁敌人(过载中 或 过载流冷却就绪)：一帧双弹走"正行/列+相邻±1行/列"，
 * d<=4 一律死区；standoff 内且落在双弹覆盖带、又无法一步横向跨出覆盖带(走廊夹死)亦为死区。
 * overload 流(哪怕此刻冷却中)：敌可"错位一列"站位，过载副弹专打相邻列(mat_4YF 敌[14,8]站我[15,10]相邻列，
 * 过载副弹走 x=15 把我秒)。故对 overload 流敌人，落在其双弹覆盖带(相邻±1)且 standoff 内、无法跨出也判死区——
 * 逼自己离开相邻列到 dx>=2 的安全列，不在 overload 敌身边的副弹道上逗留。
 * 石墙遮挡豁免：敌我之间有墙、敌人当前及移动一步后都打不到 next 时，那条"近距"其实安全(子弹被墙吃掉)。
 */
function stepEntersKillZone(myPos, next, enemyPos, game, enemy, standoff) {
  const d = manhattan(next, enemyPos);
  const doubleLane = enemyDoubleLaneThreat(enemy);   // 真实双弹威胁(已过载/就绪) -> d<=4 一律死区
  const overloadType = enemyIsOverloadType(enemy);    // overload 流(含冷却中) -> 覆盖带逗留也危险(错位射击)
  const freezeType = enemyIsFreezeType(enemy);        // freeze 流 -> 同线 d<=4 被冻必死(冻2帧期间敌从容对准开火)
  // 贴脸 d<=1：无论有无墙，敌一步即可近身/绕射，恒死区
  if (d <= 1) return true;
  // 石墙完全遮挡：敌当前打不到 next、且敌四向移动一步后也仍打不到 next -> 子弹被墙挡，非死区
  if (d >= 2 && wallBlocksEnemyShot(next, enemyPos, game)) {
    // 被墙挡住时只豁免"普通炮线死区"；双弹覆盖带若仍可达则继续走下方判定
    if (!doubleLane && !overloadType) return false;
  }
  // 普通敌人：贴近 3 格内即死区（转向就被追上）。
  // overload 流在“后撤且确实拉开距离”时，允许先退一步再交给下一帧继续评估，避免太近时直接卡死。
  if (d <= 3) {
    if (overloadType && manhattan(next, enemyPos) > manhattan(myPos, enemyPos)) return false;
    return true;
  }
  // 双弹威胁敌人：同行/列或相邻±1行/列内 d<=4 是死区；纯对角(无直射线)放行，
  // 避免封死所有"曼哈顿≤4但方向偏移"的格，让坦克仍能绕路抢星。
  if (doubleLane && d <= 4) {
    if (clearShotDirection(enemyPos, next, game) !== null) return true; // 敌有直射 -> 死区
    if (inDoubleLaneBand(enemyPos, next, 4)) return true;              // 在双弹覆盖带内 -> 死区
    // 纯对角(dx>=2 && dy>=2)且无直射 -> 放行（敌需先转向再瞄准）
  }
  // freeze 流：与敌同行/列、无墙、曼哈顿<=4 时被冻 2 帧期间会被对准击杀(mat_0Wmx d=1 被冻点死) -> 死区。
  // 不同线/有墙(freezeKillsAt 内 clearShotDirection 判定)则不算，避免对开阔地相邻列防过头。
  if (freezeType && freezeKillsAt(next, enemyPos, game)) return true;
  // 双弹威胁/overload流：standoff 内 + 落在双弹覆盖带(同行/列或相邻±1) + 无法一步跨出覆盖带 -> 死区
  // (mat_73I 走廊夹死 / mat_4YF 错位副弹列逗留)。overload流即使冷却中也算——敌会突然过载。
  if ((doubleLane || overloadType) && d < standoff && inDoubleLaneBand(enemyPos, next, standoff)) {
    if (!hasDoubleLaneEscapeAt(next, enemyPos, game)) return true;
  }
  return false;
}

/**
 * 敌人的子弹此刻打不到 next、且敌人朝四个方向各移动一步后也仍打不到 next（中间都有墙遮挡）。
 * 即 next 被石墙保护，敌人近距也无法直射 -> 该格其实安全(mat_7JO [3,10] 与敌[6,10]间 [5,10] 是墙)。
 */
function wallBlocksEnemyShot(next, enemyPos, game) {
  if (clearShotDirection(enemyPos, next, game)) return false; // 当前就能直射 -> 没被墙挡
  // 敌移动一步后的四个位置，任一能直射 next 则不算被墙完全封住
  for (let i = 0; i < DIRS.length; i++) {
    const ep = [enemyPos[0] + DIRS[i].dx, enemyPos[1] + DIRS[i].dy];
    if (!isPassable(game, ep, null)) continue;
    if (clearShotDirection(ep, next, game)) return false;
  }
  return true; // 当前及移动一步后都打不到 -> 被墙挡
}

/**
 * next 是否能横向(垂直于敌我连线)脱离双弹覆盖带：
 * 至少一侧能连走两格(第一格脱出敌人正列/行进入相邻列、第二格再跨出相邻列)到 dx>=2(或 dy>=2)的安全格。
 * 走廊贴墙时一侧是墙、另一侧仅一格就撞回主弹列 -> 无此脱离 -> 双弹夹死(mat_73I 沿 x=17 走廊被相邻列副弹追死)。
 * 开阔地两侧能延伸 -> 有脱离(两帧横移即可躲开)，照常走，避免防过头不敢抢星。
 */
function hasDoubleLaneEscapeAt(next, enemyPos, game) {
  const vertical = enemyPos[0] === next[0] || Math.abs(enemyPos[0] - next[0]) <= 1; // 大体同列 -> 双弹竖直来 -> 需左右(x)脱离
  const lateral = vertical
    ? [{ dx: -1, dy: 0 }, { dx: 1, dy: 0 }]
    : [{ dx: 0, dy: -1 }, { dx: 0, dy: 1 }];
  for (let i = 0; i < lateral.length; i++) {
    const s1 = [next[0] + lateral[i].dx, next[1] + lateral[i].dy];
    if (!isPassable(game, s1, enemyPos)) continue; // 第一步就被墙堵
    const s2 = [s1[0] + lateral[i].dx, s1[1] + lateral[i].dy];
    if (!isPassable(game, s2, enemyPos)) continue; // 第二步被墙堵(走廊) -> 这侧脱不掉
    const dx = Math.abs(enemyPos[0] - s2[0]);
    const dy = Math.abs(enemyPos[1] - s2[1]);
    if (dx >= 2 || dy >= 2) return true; // 两格横移跨出双弹覆盖带
  }
  return false;
}

/**
 * 追星落点前瞻：站到 star 落点后，过载敌朝我逼近一步，落点是否会陷入"双弹覆盖带内且无横向脱离"的死地。
 * 过载敌会追着我移动——吃星瞬间的横向出路常在下一帧被敌逼近而封死(mat：吃完星下一帧四向全被双弹覆盖、
 * 只能原地空转挨双弹)。这里保守预演敌沿"敌->落点"主轴逼近一格，用新敌位复检落点是否仍在带内且脱不掉。
 * 返回 true 表示这颗星是过载十字线陷阱，应放弃(scoreMoveCandidate 据此否决)。
 */
function starGrabTrapsInOverloadLane(starStep, enemyPos, game) {
  // 敌朝落点逼近一步：沿曼哈顿主轴(偏移更大的轴)移动一格，模拟过载敌持续压上
  const dx = starStep[0] - enemyPos[0];
  const dy = starStep[1] - enemyPos[1];
  let advanced = enemyPos;
  if (Math.abs(dx) >= Math.abs(dy) && dx !== 0) {
    advanced = [enemyPos[0] + (dx > 0 ? 1 : -1), enemyPos[1]];
  } else if (dy !== 0) {
    advanced = [enemyPos[0], enemyPos[1] + (dy > 0 ? 1 : -1)];
  }
  // 敌逼近格不可通行(撞墙)则维持原位预演
  if (!samePos(advanced, enemyPos) && !isPassable(game, advanced, null)) advanced = enemyPos;
  // 逼近后：落点仍在双弹覆盖带(同行/列或相邻±1)且无横向脱离 -> 吃完星即被困，判陷阱
  return inDoubleLaneBand(advanced, starStep, 6) && !hasDoubleLaneEscapeAt(starStep, advanced, game);
}

/**
 * 判断是否值得放弃交战去追星星
 */
function shouldChaseStar(myPos, enemyPos, game, starPath, enemy, fleeMode) {
  if (!game.star || !starPath || starPath.dist < 0) return false;
  if (!enemyPos) return true; // 看不到敌人必追星星
  // 守星陷阱：敌"此刻握双弹"且星就贴在它的双弹覆盖带里(它在守这颗星)，冲过去抢 = 落进双弹炮线送死
  // (mat_Jov6 星[1,5]紧贴握弹敌[2,4] d=1，我沿副弹行迎敌抢星被秒)。放弃这颗星，交走位拉开/另寻机会。
  if (enemy && enemyDoubleLaneThreat(enemy) && inDoubleLaneBand(enemyPos, game.star, 4)) return false;
  if (manhattan(myPos, game.star) <= 5) return true; // 星星很近就去吃
  // 跑路流：对方连续背对我逃跑，说明它只抢星不打架——我也不用等"比它近"才追，直接跟进抢星(mat_AAKs)
  if (fleeMode) return true;

  const enemyDist = pathDistance(enemyPos, game.star, game, myPos);
  // 如果比敌人更近（或者差不多），就去抢
  return enemyDist < 0 || starPath.dist <= enemyDist + 2;
}

/**
 * 守星陷阱检查：敌此刻握双弹且星在其覆盖带内（走路和传送共用）。
 * shouldChaseStar 内已含此判断（供走路路径使用）；
 * findStarTeleport 调用此函数做传送路径的统一守星陷阱过滤，
 * 避免走路/传送两套不同的 inDoubleLaneBand 阈值。
 */
function isStarGuardTrap(enemyPos, enemy, starPos) {
  if (!enemyPos || !enemy || !starPos) return false;
  return enemyDoubleLaneThreat(enemy) && inDoubleLaneBand(enemyPos, starPos, 4);
}

/**
 * BFS 寻找能打到敌人的射击轨道的下一步走位（不进入比 standoff 更近的死区）。
 *
 * 先手优化：在多个等距轨道格中，优先选"走过去后我已对准敌人"的格——省去一帧转向，
 * 避免逼近途中方向不对被敌人抢先开炮（mat_CD9x：我从右侧逼近，走到同行时朝 right 背对敌）。
 * 具体打分：走过去后的 clearShotDirection = 当前行进方向 -> +4（原地就能开炮）；
 *           走过去后需要转 1 次 -> +0；其余 -> -4。
 */
function nextStepToFiringLane(myPos, enemyPos, game, standoff) {
  const minD = Math.max(3, standoff - 1);
  // 收集所有候选轨道格（BFS 层序，记录到达每格的第一步和步数）
  const w = game.map.length, h = game.map[0].length;
  const queue = [myPos];
  const seen = {}, dist = {}, firstStep_ = {};
  const startKey = key(myPos);
  seen[startKey] = true; dist[startKey] = 0;
  let candidates = [], minDist = 9999;

  for (let qi = 0; qi < queue.length; qi++) {
    const p = queue[qi];
    const pd = dist[key(p)];
    if (pd > minDist + 1) break; // 只找最近的一批
    const d = manhattan(p, enemyPos);
    if (!samePos(p, myPos) && d >= minD && d <= 9 && clearShotDirection(p, enemyPos, game)) {
      if (pd <= minDist) { minDist = pd; candidates.push(p); }
    }
    for (let i = 0; i < DIRS.length; i++) {
      const n = [p[0] + DIRS[i].dx, p[1] + DIRS[i].dy];
      const nk = key(n);
      if (seen[nk]) continue;
      if (n[0] < 0 || n[1] < 0 || n[0] >= w || n[1] >= h) continue;
      if (!isPassable(game, n, enemyPos)) continue;
      seen[nk] = true;
      dist[nk] = pd + 1;
      // 记录到达 n 的第一步
      firstStep_[nk] = samePos(p, myPos) ? n : firstStep_[key(p)];
      queue.push(n);
    }
  }
  if (candidates.length === 0) return null;

  // 对候选格按"走过去后是否对准敌人"打分
  let best = null, bestScore = -9999;
  for (let i = 0; i < candidates.length; i++) {
    const c = candidates[i];
    const ck = key(c);
    const step = samePos(c, myPos) ? c : (firstStep_[ck] || c);
    const lineDir = clearShotDirection(c, enemyPos, game);
    // 走到 c 的行进方向（第一步方向）
    const moveDir = directionBetween(myPos, step);
    // 若走到 c 后 lineDir 就是我到达时的朝向（即行进中已对准）-> 无需再转向
    const alreadyAimed = lineDir === moveDir ? 4 : 0;
    const score = alreadyAimed + distanceFromEdges(c, game);
    if (score > bestScore) { bestScore = score; best = step; }
  }
  return best;
}

/**
 * 维持安全站位：当前离敌人比 standoff 近则后撤，远则靠近到 standoff 环附近。
 *
 * 三条路径（互斥，从上往下依次判断）：
 *   A. 太近(d < standoff)      → 后撤一步（stepAwayFromEnemy）
 *   B. 在安全环带内(standoff..standoff+2) → 找射击轨道（nextStepToFiringLane），不主动贴近
 *   C. 太远(d > standoff+2)    → 逼近到 standoff 环（BFS 寻路）
 *
 * overload 流特例：逼近会穿过其行/列、走进副弹覆盖带或贴墙副弹行陷阱（mat_LBH）。
 * 路径 B 调 nextStepToFiringLane 可能选"走过去对准"的格，同样有向敌正列逼近的风险。
 * 对 overload 流，路径 B 和路径 C 均禁止，交给上层 bandEscape/bushStep 保持机动。
 */
function nextStepToStandoff(myPos, enemyPos, game, standoff, enemy, enemyBullets) {
  const curD = manhattan(myPos, enemyPos);

  // 路径 A：太近 → 后撤
  if (curD < standoff) {
    return stepAwayFromEnemy(myPos, enemyPos, game, enemy, enemyBullets);
  }

  // 路径 B：已在安全环带内 → 找射击轨道（在此停留，不贴近）
  // overload 流 CD 充裕(>5帧)时压上开炮；CD 快好或已过载则保守交上层。
  if (curD <= standoff + 2) {
    if (enemyIsOverloadType(enemy)) {
      const cd = enemy.skill && enemy.skill.remainingCooldownFrames;
      if (enemyDoubleLaneThreat(enemy) || (cd !== undefined && cd <= 5)) return null;
    }
    return nextStepToFiringLane(myPos, enemyPos, game, standoff);
  }

  // 路径 C：太远 → 逼近到 standoff 环（overload 流 CD 快好时禁止逼近，交上层巡逻）
  if (enemyIsOverloadType(enemy)) {
    const cd = enemy.skill && enemy.skill.remainingCooldownFrames;
    if (enemyDoubleLaneThreat(enemy) || (cd !== undefined && cd <= 5)) return null;
  }
  return nextStepToGoal(myPos, game, enemyPos, function (p) {
    const d = manhattan(p, enemyPos);
    return d >= standoff && d <= standoff + 1;
  });
}

/**
 * 选一个远离敌人、且不撞进敌方炮线的相邻后撤格。
 * 对 overload 流敌人：重罚仍留在其双弹覆盖带(相邻±1行/列)的后撤格，奖励跨出覆盖带的格——
 * 否则只按"远离+离边"打分会在副弹列上下挪(mat_4YF 在 x=15 副弹列徘徊被错位双弹秒)。
 */
function stepAwayFromEnemy(myPos, enemyPos, game, enemy, enemyBullets) {
  const overloadType = enemyIsOverloadType(enemy);
  const bullets = enemyBullets || [];
  let best = null;
  let bestScore = -9999;
  for (let i = 0; i < DIRS.length; i++) {
    const p = [myPos[0] + DIRS[i].dx, myPos[1] + DIRS[i].dy];
    if (!isPassable(game, p, enemyPos)) continue;
    if (stepIntoBulletPath(bullets, p, game)) continue;
    let score = manhattan(p, enemyPos) + distanceFromEdges(p, game) * 0.5;
    if (overloadType) {
      // 跨出双弹覆盖带(既不同行±1也不同列±1)大幅加分，仍在覆盖带内则减分，逼自己离开副弹道
      const dx = Math.abs(enemyPos[0] - p[0]);
      const dy = Math.abs(enemyPos[1] - p[1]);
      if (dx >= 2 && dy >= 2) score += 10;
      else score -= 6;
    }
    if (score > bestScore) {
      bestScore = score;
      best = p;
    }
  }
  return best;
}

/**
 * 横向脱离"双弹覆盖带"：敌此刻握双弹、我站在其正行/列或相邻±1行/列(副弹道)内时，朝垂直于敌我连线的
 * 方向走一步，尽量跨到 dx>=2 且 dy>=2 的覆盖带外安全格(mat_Jov6 在副弹行 y=5 沿带迎敌走="还回头"被秒；
 * mat_EUR 贴 x=16 副弹列顺子弹逃被追)。优先：跨出覆盖带 > 远离边缘 > 当前朝向即可走(省一帧转向)。
 * 只在握双弹(enemyDoubleLaneThreat)时调用；找不到比当前更好的脱离格则返回 null(交巡逻兜底)。
 */
function escapeDoubleLaneBand(myPos, enemyPos, game, enemyBullets) {
  let best = null;
  let bestScore = -9999;
  const bullets = enemyBullets || [];
  for (let i = 0; i < DIRS.length; i++) {
    const p = [myPos[0] + DIRS[i].dx, myPos[1] + DIRS[i].dy];
    if (!isPassable(game, p, enemyPos)) continue;
    if (stepIntoBulletPath(bullets, p, game)) continue;
    const dx = Math.abs(enemyPos[0] - p[0]);
    const dy = Math.abs(enemyPos[1] - p[1]);
    const outOfBand = dx >= 2 && dy >= 2; // 既不在(相邻)列也不在(相邻)行 -> 真正跨出双弹覆盖带
    // 不能往敌人更近处挪(否则是"靠近握弹敌"而非脱离)
    if (manhattan(p, enemyPos) < manhattan(myPos, enemyPos)) continue;
    let score = (outOfBand ? 100 : 0) + manhattan(p, enemyPos) + distanceFromEdges(p, game) * 0.5;
    if (score > bestScore) { bestScore = score; best = p; }
  }
  // 只有当确实能往覆盖带外/更远走才返回；否则 null 让巡逻/兜底接手
  return best;
}

/**
 * 朝远离某危险点(如隐身敌人最后位置)的方向走一步，保持至少 minDist 间距。
 */
function nextStepAvoiding(myPos, dangerPos, game, minDist, enemyBullets, enemy) {
  if (manhattan(myPos, dangerPos) >= minDist + 2) return null; // 已经够远，不必特意避让
  return stepAwayFromEnemy(myPos, dangerPos, game, enemy, enemyBullets);
}

/**
 * 隐身敌"伏击线"横移脱离：我与 dangerPos(敌最后已知位置)同行或同列、且中间无墙遮挡(真能被一炮打到)时，
 * 朝垂直方向走一步彻底离开那条行/列。隐身敌看不见、会沿原线游弋开火，远距也危险。
 * 有石墙挡在中间 -> 那条线其实安全(子弹会被墙吃掉)，返回 null 不避让(避免无谓徘徊、不防过头)。
 */
function escapeAmbushLine(myPos, dangerPos, game, enemyBullets) {
  const lineDir = clearShotDirection(dangerPos, myPos, game); // 敌->我 无遮挡方向(同行/列且无墙)
  if (!lineDir) return null; // 不同线 或 中间有墙(石墙挡子弹) -> 不必横移
  const sameCol = dangerPos[0] === myPos[0]; // 同列(竖直线) -> 需左右(x)脱离; 同行 -> 上下(y)脱离
  const lateral = sameCol
    ? [{ dx: -1, dy: 0 }, { dx: 1, dy: 0 }]
    : [{ dx: 0, dy: -1 }, { dx: 0, dy: 1 }];
  const bullets = enemyBullets || [];
  let best = null, bestScore = -9999;
  for (let i = 0; i < lateral.length; i++) {
    const q = [myPos[0] + lateral[i].dx, myPos[1] + lateral[i].dy];
    if (!isPassable(game, q, null)) continue;
    if (stepIntoBulletPath(bullets, q, game)) continue;
    // 走过去后不能仍与敌最后位置同行/同列(否则没真正离开线)
    if (q[0] === dangerPos[0] || q[1] === dangerPos[1]) continue;
    const score = manhattan(q, dangerPos) + distanceFromEdges(q, game) * 0.5;
    if (score > bestScore) { bestScore = score; best = q; }
  }
  return best;
}

/**
 * 隐身敌"之字斜逃"：面对 cloak 流敌人逃跑时，绝不沿单一行/列直线退（mat_L4l9：敌隐身绕到我正后方
 * 同行 y=6，我沿 y=6 连走 3 格直线退，被 2 格/帧的子弹从背后追死）。隐身时我看不见敌真实位置，
 * 它可能藏在我**任意**行/列背后；走斜向(每帧换行又换列)能让任何一条直线子弹到达时我都已离开那条线。
 *
 * 坦克一帧只能走一格(不能真正对角移动)，所以"之字"靠**逐帧交替换轴**实现：本帧优先选一个
 * "既离 lastEnemyPos 更远、又能为下一帧换轴留出空间"的方向；并尽量避免与上一步同轴(交替 x/y)。
 * lastStepAxis 记录上一步走的轴(0=x,1=y)，本帧优先换另一轴，凑出之字轨迹。
 */
function diagonalEvadeStep(myPos, dangerPos, game, state) {
  const lastAxis = state ? state.lastEvadeAxis : undefined; // 0=x轴(left/right), 1=y轴(up/down)
  let best = null, bestScore = -9999, bestAxis = null;
  for (let i = 0; i < DIRS.length; i++) {
    const d = DIRS[i];
    const p = [myPos[0] + d.dx, myPos[1] + d.dy];
    if (!isPassable(game, p, null)) continue;
    if (manhattan(p, dangerPos) < manhattan(myPos, dangerPos)) continue; // 不往隐身敌方向靠
    const axis = d.dx !== 0 ? 0 : 1;
    // 离开"敌可能藏身"的两条线：走过去后既不与 dangerPos 同行、也不同列最优(彻底脱离任何一条偷袭直线)
    const offDanger = (p[0] !== dangerPos[0] ? 1 : 0) + (p[1] !== dangerPos[1] ? 1 : 0);
    // 交替换轴(之字核心)：本帧换到与上一步不同的轴 -> 加分；同轴(直线退) -> 不加分
    const altBonus = (lastAxis === undefined || axis !== lastAxis) ? 6 : 0;
    const score = altBonus + offDanger * 4 + manhattan(p, dangerPos) + distanceFromEdges(p, game) * 0.5;
    if (score > bestScore) { bestScore = score; best = p; bestAxis = axis; }
  }
  if (best && state) state.lastEvadeAxis = bestAxis;
  return best;
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
 * 寻找破坏土块的方向（为了抄近道）
 */
function findDigDirection(pos, game, target) {
  let bestDir = null;
  let bestScore = 9999;
  for (let i = 0; i < DIRS.length; i++) {
    const d = DIRS[i];
    let x = pos[0] + d.dx;
    let y = pos[1] + d.dy;
    let range = 1;
    
    // 沿该方向查找
    while (tileAt(game, [x, y]) !== "x") {
      const t = tileAt(game, [x, y]);
      if (t === "m") { // 发现土块
        const after = [x + d.dx, y + d.dy];
        // 打分：土块距离 + 打碎后距离目标的距离
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

/**
 * 寻找最靠近地图中心的空地
 */
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

/**
 * 寻找躲避子弹的安全邻近格子。
 * 适配：过载双弹（同时威胁多条弹道）、按子弹真实速度(2格/帧)判断能否在命中前移开、
 * 优先选当前朝向就能直接前进的方向（避免反复转向空耗帧而原地被击中）。
 *
 * 时序模型（关键修复 mat_2cHX/mat_DXZ）：子弹 incomingFrames 帧后命中我当前格。
 *  - 朝向即脱离方向(needFrames=1)：本帧 go 立刻离格，只要 incomingFrames>=1 即安全。
 *  - 需先转向(needFrames=2)：本帧转向仍留在原格，下一帧才离开，故要求 incomingFrames>=3 才真正脱险
 *    （incomingFrames==2 时转向那帧子弹正好到达，会被命中——这正是过去"摇摆送死"的根因）。
 *  - 绝不选"顺着子弹飞行方向"的脱离格（顺向逃会被 2 格/帧的子弹追上，mat_DXZ 屁股后中弹）。
 * 若无来得及的脱离格，返回 null，交由紧急传送处理。
 */
function findBulletDodge(me, enemy, game, enemyPos) {
  const myPos = me.tank.position;
  const bullets = collectEnemyBullets(enemy);
  if (bullets.length === 0) return null;

  // 没有任何子弹威胁到我，就不躲
  if (!anyBulletThreatens(bullets, myPos, game)) return null;

  // 最快多少帧子弹会命中我当前格（含双弹推断），后续时序判断依赖这个窗口
  const incomingFrames = minBulletFramesTo(bullets, myPos, game);
  if (incomingFrames < 0) return null;

  // 威胁我的那些子弹的飞行方向集合（用于排除"顺向逃"的死路方向）
  const threatDirs = {};
  for (let i = 0; i < bullets.length; i++) {
    if (bulletThreatens(bullets[i], myPos, game)) threatDirs[bullets[i].direction] = true;
  }

  // 四个相邻格都作为候选（移开任意弹道即可），逐一评估安全与可达性
  let best = null;
  let bestScore = -9999;
  for (let i = 0; i < DIRS.length; i++) {
    const d = DIRS[i];
    const p = [myPos[0] + d.dx, myPos[1] + d.dy];
    if (!isPassable(game, p, enemyPos)) continue;
    // 落点必须脱离所有子弹弹道
    if (anyBulletThreatens(bullets, p, game)) continue;
    // 落点不能正好撞进敌人能立刻开火的炮口
    if (enemyAimsAt(p, enemy && enemy.tank, game)) continue;
    // 不能顺着来袭子弹方向走（同向只会被追上，且这一步本就还在弹道行/列上）
    if (threatDirs[d.name]) continue;

    const needTurn = d.name !== me.tank.direction;
    // 时序校验：
    // 1. 如果不用转向直接能走，1帧脱离。前面已经校验过 p 目前不在弹道上，所以直接通过。
    if (!needTurn) {
      if (incomingFrames < 1) continue;
    } else {
      // 2. 如果需要转向，移动需要 2 帧（第 1 帧转身，第 2 帧离开）。
      // 致命漏洞修复：转身帧必须保证我不死！
      if (incomingFrames < 3) continue;
      
      // 预演子弹再飞 1 帧（模拟完成转身，即将进行 go 的那个帧）
      // 必须保证那帧里，目标格子 p 不会被子弹扫过或占领
      const bulletsNext = advanceBullets(bullets, BULLET_SPEED);
      if (stepIntoBulletPath(bulletsNext, p, game) || anyBulletThreatens(bulletsNext, p, game)) {
        continue;
      }
    }

    // 打分：当前朝向就能走 > 逃生开口数 > 远离边缘 > 靠近星星
    // 死胡同重罚：开口<=1 时后续无法横移脱困，连续躲避会越走越深进墙角
    const facing = needTurn ? 0 : 100;
    const openExits = openNeighborCount(p, game);
    const deadEndPenalty = openExits <= 1 ? -150 : 0;
    // 对射优化：躲弹后仍能直射敌人 → 立刻还手，不丢制枪机会。+30 让"能还手的侧方格"优先于"更宽裕但丢射线的方向"。
    const counterBonus = enemyPos && clearShotDirection(p, enemyPos, game) ? 30 : 0;
    const score = facing + openExits * 8 + deadEndPenalty + distanceFromEdges(p, game) + counterBonus + (game.star ? -manhattan(p, game.star) * 0.1 : 0);
    if (score > bestScore) {
      bestScore = score;
      best = p;
    }
  }
  return best;
}

/**
 * 时序躲避存在性判定：从 myPos(车头 myDir) 面对给定子弹集，是否存在"来得及"脱离的相邻格。
 * 完全复用 findBulletDodge 的时序铁律（朝向即脱离 incoming>=1；需转向 incoming>=3 才不会在转向帧被命中），
 * 但只返回布尔值，供"先射后走"在开火预演后复用——子弹集为推进过的快照即可。
 * 子弹集已含过载配对弹(collectEnemyBullets 推断)，因此多子弹/双弹一并纳入时序校验。
 */
function hasTimedDodge(myPos, myDir, bullets, game, enemyPos, enemyTank) {
  const list = bullets || [];
  if (!anyBulletThreatens(list, myPos, game)) return true; // 当前格本就不被任何子弹威胁
  const incoming = minBulletFramesTo(list, myPos, game);
  if (incoming < 0) return true;

  // 威胁我的子弹飞行方向集合：排除"顺向逃"（2格/帧必被追上）
  const threatDirs = {};
  for (let i = 0; i < list.length; i++) {
    if (bulletThreatens(list[i], myPos, game)) threatDirs[list[i].direction] = true;
  }

  for (let i = 0; i < DIRS.length; i++) {
    const d = DIRS[i];
    const p = [myPos[0] + d.dx, myPos[1] + d.dy];
    if (!isPassable(game, p, enemyPos)) continue;
    if (enemyAimsAt(p, enemyTank, game)) continue;        // 落点不能正撞敌炮口
    if (threatDirs[d.name]) continue;                     // 不顺着来袭子弹方向逃

    // 如果不用转向直接能走，1帧脱离，前提是落点也是安全的
    if (d.name === myDir) {
      if (!anyBulletThreatens(list, p, game)) return true;
      continue;
    }
    
    // 如果需要转向，移动需要 2 帧（第 1 帧转身，第 2 帧离开）。
    // 【致命漏洞修复】：由于第 1 帧（转身帧）仍停留在当前格子 myPos，
    // 我们必须保证预演的这批 bullets（此时正处于转身帧开始时刻）不会在这一帧内命中 myPos！
    if (incoming < 3) continue; // 子弹距离不足3帧，转身帧/移动帧会被追上
    
    // 预演子弹再飞 1 帧（模拟完成转身，即将进行 go 的那个帧）
    const bulletsNext = advanceBullets(list, BULLET_SPEED);
    if (!stepIntoBulletPath(bulletsNext, p, game) && !anyBulletThreatens(bulletsNext, p, game)) {
      return true;
    }
  }
  return false;
}

/**
 * 绝境横移：被子弹威胁、findBulletDodge 与传送都救不了时的兜底。
 * 在垂直于来袭子弹方向的两个相邻格里挑一个可走、且本身不在弹道上的，朝它移动（哪怕需转向）。
 * 目的：绝不顺着子弹方向直线逃（必被 2 格/帧子弹追上），横向挣一步仍有活命机会。
 */
function findDesperateDodge(me, enemyBullets, game, enemyPos, enemyTank) {
  const myPos = me.tank.position;
  const bullets = enemyBullets || [];
  if (!anyBulletThreatens(bullets, myPos, game)) return null;

  // 收集威胁子弹的飞行方向（顺/逆向都不选，只走垂直方向）
  const blockedAxis = {};
  for (let i = 0; i < bullets.length; i++) {
    if (!bulletThreatens(bullets[i], myPos, game)) continue;
    const dir = bullets[i].direction;
    if (dir === "up" || dir === "down") blockedAxis.vertical = true;
    else blockedAxis.horizontal = true;
  }

  let best = null;
  let bestScore = -9999;
  for (let i = 0; i < DIRS.length; i++) {
    const d = DIRS[i];
    // 子弹竖直来 -> 只走水平(left/right)；水平来 -> 只走竖直(up/down)
    const isVerticalMove = d.name === "up" || d.name === "down";
    if (blockedAxis.vertical && isVerticalMove) continue;
    if (blockedAxis.horizontal && !isVerticalMove) continue;

    const p = [myPos[0] + d.dx, myPos[1] + d.dy];
    if (!isPassable(game, p, enemyPos)) continue;
    if (anyBulletThreatens(bullets, p, game)) continue; // 脱离格不能也在弹道上
    // 偏好当前朝向(本帧即走)、其次远离边缘
    const facing = d.name === me.tank.direction ? 100 : 0;
    const score = facing + distanceFromEdges(p, game);
    if (score > bestScore) {
      bestScore = score;
      best = p;
    }
  }
  return best;
}

/**
 * 两步脱困：单步无安全格（findBulletDodge=null）时的备用逃生。
 * 适用于双弹平行夹击（如 mat_FXI：x=16/x=17 两列都有子弹朝 up，右侧是墙）。
 *
 * 策略：在相邻格中找一个"虽然当前被某子弹威胁、但该子弹还有 ≥3 帧才到、
 * 且从该格出发下一帧能找到真正安全的纵向脱离格"的方向走过去。
 * 优先选远离边界（避免被逼到墙角）、且威胁子弹最远的方向。
 */
function findTwoStepEscape(me, enemyBullets, game, enemyPos, enemyTank) {
  const myPos = me.tank.position;
  const bullets = enemyBullets || [];
  if (!anyBulletThreatens(bullets, myPos, game)) return null;

  let best = null;
  let bestScore = -9999;
  for (let i = 0; i < DIRS.length; i++) {
    const d = DIRS[i];
    const p = [myPos[0] + d.dx, myPos[1] + d.dy];
    if (!isPassable(game, p, enemyPos)) continue;
    if (enemyAimsAt(p, enemyTank, game)) continue;
    // 不走顺着威胁子弹方向的格（顺向必被追上）
    let isAlongThreat = false;
    for (let j = 0; j < bullets.length; j++) {
      if (bulletThreatens(bullets[j], myPos, game) && bullets[j].direction === d.name) {
        isAlongThreat = true; break;
      }
    }
    if (isAlongThreat) continue;

    // 到达 p 所需帧：当前朝向=1(直接 go)，否则 turnDistance+1(先转再走)
    const arriveFrames = (d.name === me.tank.direction) ? 1 : (turnDistance(me.tank.direction, d.name) + 1);
    // 该格被子弹威胁：必须在我到达之后才命中（留出落脚帧），否则走过去就被打
    const framesAtP = minBulletFramesTo(bullets, p, game);
    if (framesAtP >= 0 && framesAtP <= arriveFrames) continue;

    // 二步模型关键：从 p 再迈一步能脱离所有弹道，且时间上能抢在威胁命中前完成
    let nextEscapeOk = false;
    for (let k = 0; k < DIRS.length; k++) {
      const q = [p[0] + DIRS[k].dx, p[1] + DIRS[k].dy];
      if (!isPassable(game, q, enemyPos)) continue;
      if (anyBulletThreatens(bullets, q, game)) continue;
      if (enemyAimsAt(q, enemyTank, game)) continue;
      nextEscapeOk = true; break;
    }
    if (!nextEscapeOk) continue;

    // 打分：远离边界（避免被逼墙角）+ 威胁子弹越远越好 + 到位越快越好
    const edgeScore = distanceFromEdges(p, game);
    const threatDist = framesAtP >= 0 ? framesAtP : 99;
    const score = edgeScore * 3 + threatDist - arriveFrames * 2;
    if (score > bestScore) { bestScore = score; best = p; }
  }
  return best;
}

/**
 * 对射"先射后走"判定：在子弹来袭、findBulletDodge 已确认本帧有躲位的前提下，
 * 若满足以下条件，则先回敬一炮再躲（下一帧子弹更近但仍可躲）：
 *  - 炮管就绪、敌人未开盾、我与敌人同线且视线无遮挡、车头已对准敌人（开火不耗转向帧）；
 *  - 来袭子弹至少 2 帧后才命中我当前格（开火占本帧，留下一帧躲避）；
 *  - 开火后下一帧子弹推进 BULLET_SPEED 格，我仍能找到脱离弹道的相邻格。
 * 化纯被动逃跑为压制对射（见 mat_DtH4：全程只躲不还手被压死）。
 */
/**
 * 反击"先手干净击杀"判定：来袭子弹下，即使开火后自己躲不掉，但只要这一炮能**先于**敌方任何威胁
 * 命中并打死敌人，敌坦克 crash 后其在途子弹威胁随之解除——此时先射就是"不必死还反杀"，
 * 不该怂着躲（落实用户"不必死就先打面前的敌人"第一优先级）。
 *
 * 严格三约束（缺一不可，宁可不打也不送命/锁死平局）：
 *  1. 我严格先手命中：myHit < enemyHit。其中 myHit = 开火占本帧后子弹飞行帧 = ceil(dist/2)；
 *     enemyHit = 来袭子弹命中我当前格的最快帧(minBulletFramesTo，已含过载配对弹)。严格小于才算
 *     "敌中弹时尚未轮到它的弹打到我"。相等=同归于尽，单独按约束3处理。
 *  2. 护盾流敌人盾就绪(正开盾 或 cd=0 可即时格挡)时，这一炮会被盾吃掉，不构成击杀 -> 不放行。
 *  3. 同归于尽(myHit === enemyHit)只在**星星严格领先**时才换命：星平=运行时长判负=必输(我方代码一贯更慢)，
 *     同归把翻盘机会也清零，比被单方打死更糟，绝不换命；严格领先时同归=我赢，可换命锁胜。
 */
function counterShootKillsCleanly(me, enemy, enemyTank, enemyBullets, game, enemyPos) {
  if (!enemyTank || !enemyPos) return false;
  if (!canShoot(me, enemy)) return false;
  const shotDir = clearShotDirection(me.tank.position, enemyPos, game);
  if (!shotDir || shotDir !== me.tank.direction) return false;

  // 约束2：护盾流敌盾就绪 -> 这一炮被吃，不算击杀
  const shieldUp = enemy && enemy.status && enemy.status.shielded;
  const shieldReady = enemyHasShieldSkill(enemy) &&
    enemy.skill && (enemy.skill.remainingCooldownFrames || 0) === 0;
  if (shieldUp || shieldReady) return false;

  const bullets = enemyBullets || [];
  const enemyHit = minBulletFramesTo(bullets, me.tank.position, game);
  if (enemyHit < 0) return false; // 没有来袭弹会命中我 -> 不归本函数（交常规流程）
  const dist = manhattan(me.tank.position, enemyPos);
  const myHit = Math.ceil(dist / BULLET_SPEED); // 开火占本帧，子弹飞行 ceil(dist/2) 帧命中敌

  // 约束1：严格先手 -> 敌中弹时其弹还没打到我，先射反杀
  if (myHit < enemyHit) return true;
  // 约束3：同归于尽，仅星星严格领先时换命锁胜；星平/落后必不换命
  if (myHit === enemyHit) {
    const myStars = (me && me.stars) || 0;
    const enmStars = (enemy && enemy.stars) || 0;
    return myStars > enmStars;
  }
  return false;
}

function shouldCounterShootThenDodge(me, enemy, enemyTank, enemyBullets, game, enemyPos) {
  if (!enemyTank || !enemyPos) return false;
  if (!canShoot(me, enemy)) return false; // 炮管就绪 + 敌未开盾
  // 必须车头已对准敌人（开火不耗转向帧），否则先躲
  const shotDir = clearShotDirection(me.tank.position, enemyPos, game);
  if (!shotDir || shotDir !== me.tank.direction) return false;

  // 先手干净击杀：哪怕开火后自己躲不掉，只要这一炮先反杀敌人(且不锁死平局/不被盾吃)，就先射。
  if (counterShootKillsCleanly(me, enemy, enemyTank, enemyBullets, game, enemyPos)) return true;

  const bullets = enemyBullets || [];
  const incoming = minBulletFramesTo(bullets, me.tank.position, game);
  if (incoming < 2) return false; // 子弹 0~1 帧即到，开火占掉本帧必来不及躲，老实躲

  // 时序验算（用户要求）：开火占掉当前帧、子弹随之推进 1 帧(BULLET_SPEED 格)，剩下的就是一个
  // 全新的"躲子弹"问题。我必朝敌(沿弹道轴)，脱离只能垂直=必先转向一帧再移动，所以唯有
  // "转向帧+移动帧 < 子弹(含双弹)命中帧"时才躲得掉。直接复用 hasTimedDodge 的时序铁律
  // (需转向要求剩余 incoming>=3，等价于开火前 incoming>=4)对**推进后的全部子弹**(已含过载配对弹)
  // 做存在性校验：开火后仍存在来得及的躲位才值得先射，否则白送一发又躲不掉(见用户复盘)。
  const advanced = advanceBullets(bullets, BULLET_SPEED);
  return hasTimedDodge(me.tank.position, me.tank.direction, advanced, game, enemyPos, enemyTank);
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

function findOverloadLaneDodge(me, enemy, enemyTank, game, enemyPos) {
  if (!me || !me.tank || !me.tank.position || !enemyTank) return null;
  if (!enemyDoubleLaneThreat(enemy)) return null;
  if (!enemyCanFireSoon(enemy)) return null;

  const myPos = me.tank.position;
  // 用 ±1 全覆盖检测：敌不确定打哪侧，两侧都视为危险
  const predictedAll = predictedOverloadBulletsAll(enemyTank);
  if (!anyBulletThreatens(predictedAll, myPos, game)) return null;

  const incomingFrames = minBulletFramesTo(predictedAll, myPos, game);
  if (incomingFrames < 0) return null;

  function scoreCell(p, needTurn) {
    const exits = openNeighborCount(p, game);
    const deadEndPenalty = exits <= 1 ? -150 : 0;
    return (needTurn ? 0 : 100) + exits * 8 + distanceFromEdges(p, game) * 3 + deadEndPenalty +
      (game.star ? -manhattan(p, game.star) * 0.1 : 0);
  }

  // 一步逃脱
  let best = null;
  let bestScore = -9999;
  for (let i = 0; i < DIRS.length; i++) {
    const d = DIRS[i];
    const p = [myPos[0] + d.dx, myPos[1] + d.dy];
    if (!isPassable(game, p, enemyPos)) continue;
    if (enemyAimsAt(p, enemyTank, game)) continue;
    if (anyBulletThreatens(predictedAll, p, game)) continue;
    if (stepIntoBulletPath(predictedAll, p, game)) continue;

    const needTurn = d.name !== me.tank.direction;
    if (!needTurn) {
      if (incomingFrames < 1) continue;
    } else {
      if (incomingFrames < 3) continue;
      const predictedNext = advanceBullets(predictedAll, BULLET_SPEED);
      if (stepIntoBulletPath(predictedNext, p, game) || anyBulletThreatens(predictedNext, p, game)) continue;
    }

    const s = scoreCell(p, needTurn);
    if (s > bestScore) { bestScore = s; best = p; }
  }
  if (best) return best;

  // ±1 两侧都被封时（我在双弹带中央），做两步 BFS 找更远脱离格
  if (incomingFrames < 2) return null; // 来不及了
  for (let i = 0; i < DIRS.length; i++) {
    const d1 = DIRS[i];
    const p1 = [myPos[0] + d1.dx, myPos[1] + d1.dy];
    if (!isPassable(game, p1, enemyPos)) continue;
    // p1 也必须不在预测弹道上，否则经过 p1 时会被实际双弹扫到
    if (anyBulletThreatens(predictedAll, p1, game)) continue;
    for (let j = 0; j < DIRS.length; j++) {
      const d2 = DIRS[j];
      const p2 = [p1[0] + d2.dx, p1[1] + d2.dy];
      if (!isPassable(game, p2, enemyPos)) continue;
      if (anyBulletThreatens(predictedAll, p2, game)) continue;
      if (stepIntoBulletPath(predictedAll, p2, game)) continue;
      const s = scoreCell(p2, true);
      if (s > bestScore) { bestScore = s; best = p2; }
    }
  }
  return best;
}

/**
 * 防范敌方预瞄/预发射/守星：若敌人正瞄准我且本帧具备开火能力，提前移动脱离其炮线。
 *
 * 改进点：
 *  - 只在敌方"真能开火"（炮管就绪、未被开火锁定）时才躲，避免对着不能开火的敌人空走。
 *  - 不再只试前方一格：四向择优选一个能脱离敌方炮线、且不撞进现有子弹弹道的格子。
 *  - 隐身敌人(enemyTank=null)交由其他逻辑处理，这里只针对可见敌人的预瞄。
 *  - 抢星豁免：当敌人只是"预瞄"(尚无实弹在途)而我正贴近一颗我更有希望抢到的星时，
 *    不为一次未必命中的瞄准而中断抢星——否则会反复原地转向，把星拱手让人(见 mat_DuPt4ff7Ivt9Hy6Rf)。
 */
function findAimDodge(me, enemy, enemyTank, enemyBullets, game, enemyPos) {
  if (!enemyTank) return null;
  if (!enemyAimsAt(me.tank.position, enemyTank, game)) return null;
  // 敌人本帧无法开火（已有在途子弹且未过载，或被开火锁定）则预瞄无威胁，不必空躲
  if (!enemyCanFireSoon(enemy)) return null;
  // 抢星竞速豁免：敌人只是预瞄、没有实弹在途时，若这颗星我更可能先到，则继续抢星不空躲
  if (shouldContestStarOverAim(me, enemy, enemyTank, enemyBullets, game)) return null;
  // 对射豁免：我也能瞄到敌人、无实弹在途、且对射不慢于敌人(myDuel<=enemyDuel) -> 不在此空躲。
  // 交给下方"近距对射规避"统一裁决：能及时侧移就侧移，来不及就开火换血，避免站着转身送死。
  if (canShoot(me, enemy) && !(enemy && enemy.bullet && enemy.bullet.position)) {
    const myShotDir = clearShotDirection(me.tank.position, enemyPos, game);
    if (myShotDir) {
      const dist = manhattan(me.tank.position, enemyPos);
      const myDuel = turnDistance(me.tank.direction, myShotDir) + Math.ceil(dist / BULLET_SPEED);
      const dirToMe = clearShotDirection(enemyPos, me.tank.position, game);
      const enemyDuel = (dirToMe ? turnDistance(enemyTank.direction, dirToMe) : 1) + Math.ceil(dist / BULLET_SPEED);
      if (myDuel <= enemyDuel) return null;
    }
  }

  const myPos = me.tank.position;
  // 敌最快命中我当前格所需帧：过载双弹/普通单弹都按"敌转向对准 + 子弹飞行(2格/帧)"估。
  // 用于给"需转向才能到达的侧格"做时序闸门——转身那帧我还停在原格，必须保证敌弹此刻打不到。
  const dist = manhattan(myPos, enemyPos);
  const dirToMe = clearShotDirection(enemyPos, myPos, game);
  const enemyHitFrames = (dirToMe ? turnDistance(enemyTank.direction, dirToMe) : 1) + Math.ceil(dist / BULLET_SPEED);

  let best = null;
  let bestScore = -9999;
  for (let i = 0; i < DIRS.length; i++) {
    const d = DIRS[i];
    const p = [myPos[0] + d.dx, myPos[1] + d.dy];
    if (!isPassable(game, p, enemyPos)) continue;
    if (enemyAimsAt(p, enemyTank, game)) continue; // 必须脱离炮线
    if (anyBulletThreatens(enemyBullets || [], p, game)) continue; // 别躲进现有弹道
    if (predictedOverloadThreatens(enemy, p, game)) continue;      // 别躲进过载双弹覆盖带

    const needTurn = d.name !== me.tank.direction;
    // 时序铁律（防摇摆送死，mat 复盘）：当前朝向即脱离方向 -> 本帧 go 一步离线，最快、必接受。
    // 需先转向 -> 转身占 1 帧(人仍在原格)、第 2 帧才移动；只有敌弹这帧打不到我(escapeFrames<enemyHitFrames)
    // 才来得及，否则返回这种格只会让我站着转身被抢先开火、且每帧 best 翻面横跳。来不及就别给侧格，
    // 返回 null 让位硬闸门(传送逃生/绝境横移)——那才是真来不及时的正确兜底。
    const escapeFrames = needTurn ? 2 : 1;
    if (needTurn && escapeFrames >= enemyHitFrames) continue;

    // 偏好当前朝向就能直接走的格子（1 帧脱离，最快）
    const facing = needTurn ? 0 : 100;
    // 加强星星引力：躲弹时若某方向能更快接近星星，优先选（原 0.1 太弱，改为 3，使星星 1 格内相当于 facing 同向）
    const starPull = game.star ? Math.max(0, 6 - manhattan(p, game.star)) * 3 : 0;
    const score = facing + distanceFromEdges(p, game) + starPull;
    if (score > bestScore) {
      bestScore = score;
      best = p;
    }
  }
  return best;
}

/**
 * 抢星是否应优先于防瞄：仅当
 *  - 场上有星，且我离星很近（路径 <= 接近射程）；
 *  - 敌人没有实弹在途（仅预瞄，下帧才可能开火，威胁是概率性的）；
 *  - 我到星的路径距离不比敌人远（我更可能先吃到）。
 * 满足时返回 true，表示宁可吃这一发概率性瞄准也要把星抢下。
 */
function shouldContestStarOverAim(me, enemy, enemyTank, enemyBullets, game) {
  if (!game.star) return false;
  // 敌人已有实弹在途 -> 是真威胁，不豁免（交由子弹躲避/这里继续躲）
  if (enemy && enemy.bullet && enemy.bullet.position) return false;
  // 过载就绪/已过载：威胁高，通常不豁免。
  // 特例：星极近(≤2步)且星所在格不在敌方炮线上——此时"抓星"= "脱线"，两件事合一，应当豁免。
  if (enemyDoubleLaneThreat(enemy)) {
    const myToStar = pathDistance(me.tank.position, game.star, game, enemyTank.position);
    if (myToStar >= 0 && myToStar <= 2 && !enemyAimsAt(game.star, enemyTank, game)) {
      return true; // 抓星格不在炮线，抓星同时完成闪避，不阻止
    }
    return false;
  }

  const myPos = me.tank.position;
  const enemyPos = enemyTank.position;
  const myToStar = pathDistance(myPos, game.star, game, enemyPos);
  if (myToStar < 0 || myToStar > 7) return false; // 星在7步内才值得冒险抢（原先4步过于保守，导致长期缩角落）

  const enemyToStar = pathDistance(enemyPos, game.star, game, myPos);
  // 我不比敌人远即抢（敌人不可达也抢）
  return enemyToStar < 0 || myToStar <= enemyToStar;
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
 * 近距对射规避：敌人与我同行/同列、距离近、且能开火时，权衡"转身对射"谁先命中。
 * 若我不占先手（敌人不晚于我命中），就不要站着转身送死，改为侧移离开这条致命直线。
 *
 * 时间线（子弹 2 格/帧，转向占 1 帧）：
 *  - 我命中敌人帧 = 我转向到对准方向的帧 + ceil(dist/2)
 *  - 敌人命中我帧 = 敌转向到对准方向的帧 + ceil(dist/2)
 *  仅当我严格更快(myDuel < enemyDuel)时才值得对射，否则侧移脱线。
 *  侧移优先当前朝向就能直接前进的方向，避免转向耗帧再次被逼住。
 */
function findLineDuelDodge(me, enemy, enemyTank, enemyBullets, game, enemyPos) {
  if (!enemyTank || !enemyPos) return null;
  if (!enemyCanFireSoon(enemy)) return null; // 敌人开不了火，无近距威胁
  // M3: overload 冷却中且场上无己弹 = 空窗期，炮管实际是空的，不算"能立刻开火"的近距威胁，
  // 允许回敬（mat_Lwm4：对方双弹耗尽后我仍一路侧移躲避，最后被单发打死）。
  if (enemyIsOverloadType(enemy) &&
      !(enemy.status && enemy.status.overloaded) &&
      (enemy.skill && typeof enemy.skill.remainingCooldownFrames === "number" && enemy.skill.remainingCooldownFrames > 0) &&
      !(enemy.bullet && enemy.bullet.position)) return null;

  const myPos = me.tank.position;
  // 必须同线且视线无遮挡
  const dirToEnemy = clearShotDirection(myPos, enemyPos, game);
  if (!dirToEnemy) return null;
  const dist = manhattan(myPos, enemyPos);
  // 只处理"近距"危险区：5 格内对射几乎无容错（子弹<=3帧到）
  if (dist > 5) return null;

  // 对射先手比较（转向帧 + 子弹飞行帧）
  const myDuel = turnDistance(me.tank.direction, dirToEnemy) + Math.ceil(dist / BULLET_SPEED);
  const dirToMe = clearShotDirection(enemyPos, myPos, game);
  const enemyTurn = dirToMe ? turnDistance(enemyTank.direction, dirToMe) : 1;
  const enemyDuel = enemyTurn + Math.ceil(dist / BULLET_SPEED);
  const shieldDuelSafe = canShootThenEvadeShieldCounter(me, enemy, enemyTank, enemyBullets, game, enemyPos);

  // 普通敌人：我严格更快命中 -> 对射占优，不躲，交给后续开火分支
  // shield 流敌人：先手快也不代表能赚，因为这一发常被护盾吃掉；只有打完仍能脱线才值得对枪。
  if (!enemyHasShieldSkill(enemy) && myDuel < enemyDuel) return null;
  if (enemyHasShieldSkill(enemy) && myDuel <= enemyDuel && shieldDuelSafe) return null;

  // 以守为攻：敌人此刻并未瞄准我（炮口不朝我，无实弹在途），且我对射不慢于它(myDuel<=enemyDuel) ->
  // 不必侧移逃避，交给开火/守线分支先手压制（敌没瞄我时侧移只是浪费先手，见 mat_AZpe 被压到墙角）。
  const enemyAimingMe = enemyAimsAt(myPos, enemyTank, game);
  const enemyHasBullet = enemy && enemy.bullet && enemy.bullet.position;
  if (!enemyHasShieldSkill(enemy) && !enemyAimingMe && !enemyHasBullet && myDuel <= enemyDuel) return null;

  // 评估"侧移脱线"能否在敌方子弹到达前离开这条直线。
  // 侧移耗帧：当前朝向即侧向 -> 1 帧(直接 go 离格)；否则需先转向 -> 2 帧(转+走)。
  // 敌方最快命中我的帧 = enemyDuel（已含其转向）。
  // 只有当某个侧向脱离格"可走、不进别的弹道/炮线"，且脱离耗帧 < 敌命中帧 时，侧移才真正活命。
  const perp = (dirToEnemy === "up" || dirToEnemy === "down")
    ? [DIRS[dirIndex("left")], DIRS[dirIndex("right")]]
    : [DIRS[dirIndex("up")], DIRS[dirIndex("down")]];
  let best = null;
  let bestScore = -9999;
  for (let i = 0; i < perp.length; i++) {
    const d = perp[i];
    const p = [myPos[0] + d.dx, myPos[1] + d.dy];
    if (!isPassable(game, p, enemyPos)) continue;
    if (anyBulletThreatens(enemyBullets || [], p, game)) continue; // 别躲进现有弹道
    if (enemyAimsAt(p, enemyTank, game)) continue;                 // 也别进另一条炮线
    const escapeFrames = d.name === me.tank.direction ? 1 : 2;
    // 能否在中弹前离线：朝向即侧向可本帧直接 go 离线(必活)；需先转向(2帧)则要求敌命中更晚。
    const safe = escapeFrames === 1 || escapeFrames < enemyDuel;
    if (!safe) continue; // 来不及离线，侧移反而白送（应转为对射/换血）
    // 偏好当前朝向就能直接走的方向（1 帧脱离），其次保持反击角度，再次远离边缘
    const facing = d.name === me.tank.direction ? 100 : 0;
    // 侧移后仍能直射敌人(如侧方恰好同行/列)→ 保留反击机会，不白跑
    const counterLine = clearShotDirection(p, enemyPos, game) ? 15 : 0;
    const score = facing + counterLine + manhattan(p, enemyPos) + distanceFromEdges(p, game) * 0.5;
    if (score > bestScore) {
      bestScore = score;
      best = p;
    }
  }
  // best 为 null 表示无法及时脱线：交回开火分支去对射/换血，至少不是站着挨打
  return best;
}

/**
 * 以守为攻：敌人近距(<=3)正逼近、即将进入我的同行/同列枪线时，提前把炮口对准那条线（守株待兔）。
 * 返回 { fire:true } 表示本帧开火；{ dir } 表示先转向对准；null 表示不触发。
 *
 * 触发条件（守，所以保守）：
 *  - 炮管就绪、敌人未开盾；
 *  - 没有实弹正威胁我（实弹来袭由上方躲避逻辑优先处理，此处只在安全时主动备战）；
 *  - 敌人曼哈顿距离 <= 3；
 *  - 敌人已在我同行或同列（视线无遮挡）——这是它即将/已经能打我、我也能打它的线。
 * 行为：在该线上且已对准 -> 开火（先手）；在该线上未对准 -> 转向对准；
 *      尚未同线但近在 <=3 -> 朝敌人所在的更近轴向预先转炮口。
 */
/**
 * 敌炮管空窗期反击：检测到敌方子弹已在场（炮管空了）且方向不威胁我时，主动进攻。
 *
 * 逻辑：
 * - 敌方场上有子弹(enemy.bullet)，说明炮管已空，短期内无法再开火
 * - 这发子弹方向不朝我（不是打我的，我安全）
 * - 我与敌方同行/同列视线清晰、炮管就绪、无实弹威胁我
 * - 则返回应该转向/开火的方向
 *
 * 不触发的情况：
 * - 子弹方向朝我（这发子弹在打我，交给躲避逻辑）
 * - 过载流敌人握双弹时（虽然场上有一发，可能还有第二发）
 * - shield 流敌人（开盾会吃掉我这发，不值得）
 */
function findEnemyBulletOpenShot(me, enemy, enemyTank, enemyBullets, game, enemyPos) {
  if (!enemyTank || !enemyPos) return null;
  if (!canShoot(me, enemy)) return null;
  // 必须有敌方子弹在场（炮管空了）
  const eb = enemy && enemy.bullet;
  if (!eb || !eb.position) return null;
  // 子弹不朝我（朝我的交给躲避逻辑，这里只处理"子弹打别处"的窗口）
  const bulletThreatensMe = bulletThreatens(eb, me.tank.position, game);
  if (bulletThreatensMe) return null;
  // 过载流握双弹时不进：场上那发可能是双弹之一
  if (enemyDoubleLaneThreat(enemy)) return null;
  // shield 流不进（开盾吃掉我这发）
  if (enemyHasShieldSkill(enemy)) return null;
  // 无实弹威胁我
  if (anyBulletThreatens(enemyBullets || [], me.tank.position, game)) return null;
  // 同行/同列视线清晰
  const shotDir = clearShotDirection(me.tank.position, enemyPos, game);
  if (!shotDir) return null;
  // 距离合理（太远的不值得浪费一炮）
  const d = manhattan(me.tank.position, enemyPos);
  if (d > 10) return null;
  return shotDir; // 返回应该朝的方向
}


function canPreemptiveShot(myPos, myDir, enemyTank, game) {
  if (!enemyTank) return null;
  const d = { up:[0,-1], down:[0,1], left:[-1,0], right:[1,0] }[enemyTank.direction];
  if (!d) return null;
  const epNext = [enemyTank.position[0] + d[0], enemyTank.position[1] + d[1]];
  if (manhattan(myPos, epNext) > 2) return null;
  const shotDir = clearShotDirection(myPos, epNext, game);
  if (!shotDir) return null;
  if (turnDistance(myDir, shotDir) > 1) return null;
  return shotDir;
}

function findGuardLineShot(me, enemy, enemyTank, enemyBullets, game, enemyPos) {
  if (!enemyTank || !enemyPos) return null;
  if (!canShoot(me, enemy)) return null;                 // 炮管就绪 + 敌未开盾
  // 双弹门控统一用 enemyDoubleLaneThreat(握弹才怂)，与主开火分支“没双弹就刚”一致：
  // overload 流但 CD 充裕(手里没双弹)时，同线开火与未同线预转都照常——只在真握弹(已过载/cd<=1)时全关。
  const shieldEnemy = enemyHasShieldSkill(enemy);
  if (anyBulletThreatens(enemyBullets || [], me.tank.position, game)) return null; // 有实弹来袭 -> 让躲避先处理
  // 距离门控：拉到 safeStandoffDistance（overload 流=5）才不备战——在安全环带就开始预瞄转炮口，
  // 不必贴到 4 格才守线（mat_2Bc fired=0：守线距离门只有4，整局没机会预瞄）。握双弹时同样按 standoff 退。
  const guardDist = safeStandoffDistance(enemy);
  if (manhattan(me.tank.position, enemyPos) > guardDist) return null;

  const myPos = me.tank.position;
  // 预判开炮：敌人朝我走且1帧后进入炮线（仅非双弹威胁时）
  if (!enemyDoubleLaneThreat(enemy) && !enemyIsOverloadType(enemy)) {
    const preDir = canPreemptiveShot(myPos, me.tank.direction, enemyTank, game);
    if (preDir) return me.tank.direction === preDir ? { fire: true } : { dir: preDir };
  }
  // 已在同行/同列且视线清晰：能打就打/对准
  const lineDir = clearShotDirection(myPos, enemyPos, game);
  if (lineDir) {
    // 双弹流（已过载/握双弹）：默认一发换双弹必亏，不主动对枪。
    // 但"预瞄转炮口"本身不发弹、不会同归——握双弹时若我尚未对准，仍先转过去对准，
    // 占住先手姿态(mat_7YQEUd 复盘：因双弹门控连转炮口都不做，被压墙角破墙自曝)。
    // 已对准时只放行"严格先手干净击杀"(敌先倒，双弹来不及发出)：
    //   - 敌短期开不了火(enemyCanFireSoon=false)：纯赚一炮；
    //   - 或我命中帧 < 敌命中帧(myHit<enemyHit)：敌先倒。
    // 同归(myHit===enemyHit)即使我领先也不放行——双弹同归换命风险远高于普通对枪，不靠它锁胜；
    // 劣势更不打。让位后续走位/躲避拉开距离。
    const doubleLane = (enemy.status && enemy.status.overloaded) || enemyDoubleLaneThreat(enemy);
    if (doubleLane) {
      if (me.tank.direction !== lineDir) return { dir: lineDir }; // 转炮口预瞄，不发弹
      if (!enemyCanFireSoon(enemy)) return { fire: true };       // 敌开不了火，纯赚
      const dist = manhattan(myPos, enemyPos);
      const myHit = Math.ceil(dist / BULLET_SPEED);              // 已对准，转向0
      const dirToMe = clearShotDirection(enemyPos, myPos, game);
      const enemyHit = (dirToMe ? turnDistance(enemyTank.direction, dirToMe) : 1) + Math.ceil(dist / BULLET_SPEED);
      if (myHit < enemyHit) return { fire: true };               // 严格先手，敌先倒
      return null; // 同归/劣势：不对枪换命，让位走位/躲避
    }
    if (shieldEnemy && !canShootThenEvadeShieldCounter(me, enemy, enemyTank, enemyBullets, game, enemyPos)) return null;
    if (me.tank.direction === lineDir) return { fire: true };
    return { dir: lineDir };
  }

  // 尚未同线——预转风险更高（主动凑进覆盖带）
  // 已过载或握双弹(cd<=1)时关闭；overload 流但 CD 充裕(手里没双弹)允许预转压制，与主开火“没双弹就刚”一致。
  if (enemy.status && enemy.status.overloaded) return null;
  if (enemyDoubleLaneThreat(enemy)) return null;
  // shield 流敌人不做近距守线预转，避免主动把自己摆进无收益对枪。
  if (shieldEnemy) return null;

  // 敌人很近(<=3)，预判它将从哪条轴进入我的枪线，提前转炮口对准那个轴向。
  const dx = enemyPos[0] - myPos[0];
  const dy = enemyPos[1] - myPos[1];
  // 选”垂直偏移更小”的轴：敌人更快能与我对齐的方向
  if (Math.abs(dx) <= Math.abs(dy)) {
    const dir = dy < 0 ? "up" : "down";
    if (me.tank.direction !== dir) return { dir: dir };
  } else {
    const dir = dx < 0 ? "left" : "right";
    if (me.tank.direction !== dir) return { dir: dir };
  }
  return null;
}

/**
 * 草丛/隐身攻防（mat_1dAV / mat_0BKrG 复盘：走进隐身敌人的同行近距被冒出的子弹秒杀）。
 * 返回 { fire:true } 本帧开火 / { dir } 先转向对准 / null 不触发。炮管就绪、非过载、无实弹来袭时才考虑。
 *
 *  A) 防伏击预射：敌人此刻不可见（藏草丛 或 用 cloak 技能隐身），其最后已知位置与我同行/同列、
 *     距离<=3、视线清晰 -> 朝那条线预先开一炮（打草惊蛇/压制），对准了就开火，没对准先转。
 *     注：草丛蹲坑与 cloak 隐身本质相同（enemy.tank=null 看不见也看不见其子弹），统一处理。
 *  B) 草丛伏击：我正处在草丛中(隐身)、敌人可见、与我同行/同列、距离<=3 -> 主动开火（我占信息优势）。
 */
function findBushLineShot(me, enemy, enemyTank, enemyBullets, game, enemyPos, state) {
  if (!canShoot(me, enemy)) return null;
  if (enemy && enemy.status && enemy.status.overloaded) return null; // 过载太险，交躲避
  const myPos = me.tank.position;
  if (anyBulletThreatens(enemyBullets || [], myPos, game)) return null;

  // B) 草丛伏击：我在草丛、敌可见同线近距 -> 开火
  const iAmInBush = me.status && me.status.cloaked || tileAt(game, myPos) === "o";
  if (iAmInBush && enemyTank && enemyPos && manhattan(myPos, enemyPos) <= 3) {
    const dir = clearShotDirection(myPos, enemyPos, game);
    if (dir) return me.tank.direction === dir ? { fire: true } : { dir: dir };
  }

  // A) 防伏击预射：敌不可见(草丛或cloak隐身)、最后位置与我同线、近距、视线清晰 -> 朝该线预射
  if (!enemyTank && state && state.lastEnemyPos) {
    const ePos = state.lastEnemyPos;
    const enemyHidden = tileAt(game, ePos) === "o" || (enemy && enemy.skill && enemy.skill.type === "cloak");
    if (enemyHidden &&
        ((game.frames || 0) - state.lastEnemySeenFrame) <= 6 &&  // 信息还新鲜
        manhattan(myPos, ePos) <= 3) {                           // 近距才值得预射
      const dir = clearShotDirection(myPos, ePos, game);         // 同行/同列且无遮挡
      if (dir) return me.tank.direction === dir ? { fire: true } : { dir: dir };
    }
  }
  return null;
}

/**
 * 隐身炮口预射（mat_C3Rd）：敌 cloak 刚消失、最后位置在我炮口前方或可能一步切入我的同行/同列时，
 * 主动朝当前炮口/预测伏击线打一发。它比普通草丛预射更宽：不要求 lastEnemyPos 已经与我同线，
 * 而是用 hiddenCloakPositions 预测 1~4 帧内的可达格，找近距离、无遮挡的射击线。
 */
function findCloakPreFireShot(me, enemy, enemyTank, enemyBullets, game, state) {
  if (!canShoot(me, enemy)) return null;
  if (enemyTank) return null; // 敌可见时交给直射/守线
  if (!enemyIsCloakType(enemy)) return null;
  if (!state || !state.lastEnemyPos) return null;
  const age = ((game && game.frames) || 0) - state.lastEnemySeenFrame;
  if (age < 0 || age > 4) return null; // 只打刚隐身的短窗口，避免凭旧记忆乱射

  const myPos = me.tank.position;
  if (anyBulletThreatens(enemyBullets || [], myPos, game)) return null;

  const positions = hiddenCloakPositions(enemy, enemyTank, game, state);
  if (positions.length === 0) positions.push(state.lastEnemyPos);

  let bestDir = null;
  let bestScore = -9999;
  for (let i = 0; i < positions.length; i++) {
    const p = positions[i];
    if (samePos(p, myPos)) continue;
    const dir = clearShotDirection(myPos, p, game);
    if (!dir) continue;
    const dist = manhattan(myPos, p);
    if (dist > 5) continue; // 隐身盲射只覆盖贴近伏击区

    // 当前炮口方向命中优先：符合“敌最后隐身前在我炮口方向，就朝当前方向开炮”。
    const facingBonus = dir === me.tank.direction ? 120 : 0;
    const lastBias = manhattan(p, state.lastEnemyPos) <= 1 ? 12 : 0;
    const score = facingBonus + lastBias - dist * 5 - age * 4;
    if (score > bestScore) {
      bestScore = score;
      bestDir = dir;
    }
  }

  if (!bestDir) return null;
  return me.tank.direction === bestDir ? { fire: true, dir: bestDir } : { dir: bestDir };
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

/**
 * BFS 计算到目标的最短路径长度，并返回第一步移动的坐标
 *
 * 每帧缓存：同一帧内 game/map/blockPos 不变 → 同 (start,target,blockPos) 结果确定。
 * buildMoveCandidates + shouldChaseStar + 巡逻/center/firingLane + braveBonus 每帧会查 5-8 次 BFS，
 * 不少 target 重复(enemyPos、星、巡逻点)。按 game.frames 翻新缓存，命中返回浅拷贝(防调用方改对象污染)。
 */
var _bfsCache = {};
var _bfsCacheFrame = -1;
var _bfsCacheGame = null;
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


// ===== state-store.js =====
// ============================================================
// state-store.js — 跨帧状态层
// 管理 MATCH_STATE 的生命周期、初始化、更新与查询。
// 被 decision-engine.js 在每帧开头调用；也供测试直接引用。
// ============================================================

var MATCH_STATE = null;

/**
 * 获取本局持久状态。靠帧数倒退判断新对局并重置。
 * 状态字段详细说明：
 * - lastFrame: 上次记录的帧数，用于判定是否进入了新对局（帧数倒退意味着新对局）
 * - assassinBanned: 布尔值，本局是否已禁用传送刺杀（如发现敌方有躲避刺杀的反应则禁用）
 * - pendingAssassin: 对象或 null，最近一次传送刺杀的跟踪信息 { dir, targetPos, frame }
 * - lastEnemyPos: 数组 [x, y] 或 null，敌人最后一次可见的位置（隐身或进草丛后依然保留记忆供避让等策略使用）
 * - lastEnemySeenFrame: 数字，敌人最后一次可见时的帧数
 * - lastMyPos: 数组 [x, y] 或 null，我方上一帧的坐标，用于判断是否卡住
 * - lastMyPos2: 数组 [x, y] 或 null，我方上上帧的坐标，用于判断是否在两个格子间反复横跳（震荡死循环）
 * - stuckFrames: 数字，记录当前处于"卡住"（原地不动或反复震荡）状态的连续帧数
 * - patrolTarget: 数组 [x, y] 或 null，当前巡逻的目标坐标
 * - shortIntent: 对象或 null，短期意图缓存，用于保留 2~4 步的低风险连续动作（例如 { kind, target, createdFrame, expireFrame, stepsLeft }）
 * - lastEvadeAxis: 字符串 "x" 或 "y"，或 undefined，记录上一次躲避移动所在的轴，防止在角落被封死时反复无意义同轴移动
 * - enemyFleeFrames: 数字，记录敌人连续"背对逃跑"的帧数（连续逃跑一定帧数会被判定为跑路流）
 * - enemySkillAnnounced: 布尔值，本局是否已播报过敌方技能，避免每帧刷屏
 * - lastSpeakDecisionKey / lastSpeakFrame: 上一次气泡播报的关键决策，用于抑制连续重复气泡
 * - lastPrintDecisionFrames: 对象，按决策 key 记录最近一次 print 帧，用于降低 debug 日志频率
 * - lastChosenType: 字符串或 null，上一帧最终选中的提案 type，用于 selectBestProposal 的决策粘性（防守线↔走位横跳）
 */
function getMatchState(game) {
  const frame = (game && game.frames) || 0;
  // 初始话，重置上一局帧数
  if (!MATCH_STATE || frame < MATCH_STATE.lastFrame - 2) {
    MATCH_STATE = {
      lastFrame: frame,
      assassinBanned: false,
      pendingAssassin: null,
      lastEnemyPos: null,
      lastEnemySeenFrame: -999,
      lastMyPos: null,
      lastMyPos2: null,
      stuckFrames: 0,
      patrolTarget: null,
      shortIntent: null,
      lastEvadeAxis: undefined,
      enemyFleeFrames: 0,
      enemySkillAnnounced: false,
      lastSpeakDecisionKey: null,
      lastSpeakFrame: -999,
      lastPrintDecisionKey: null,
      lastPrintFrame: -999,
      lastPrintDecisionFrames: {},
      lastChosenType: null
    };
  }
  MATCH_STATE.lastFrame = frame;
  return MATCH_STATE;
}

/**
 * 跟踪"原地未移动"帧数：本帧位置与上帧相同则累加，移动了则清零。
 * 用于识别靠墙/拉锯时反复转向却走不出去的死循环（见 mat_Enkd 转 7 帧被打死）。
 */
function trackStuck(state, myPos) {
  if (state.lastMyPos && samePos(state.lastMyPos, myPos)) {
    state.stuckFrames = (state.stuckFrames || 0) + 1;
  } else {
    // 检测"功能性卡住"：在 ≤2 格小区域内来回震荡（如 [12,12]↔[12,13] 来回跳，位置变但进展为0）
    // 记录上上帧位置，若与当前相同（一步来一步回），也计入卡住
    const osc = state.lastMyPos2 && samePos(state.lastMyPos2, myPos);
    state.stuckFrames = osc ? (state.stuckFrames || 0) + 1 : 0;
  }
  state.lastMyPos2 = state.lastMyPos ? state.lastMyPos.slice() : null;
  state.lastMyPos = myPos.slice();
}

// 短期意图只允许短暂续跑，失效后立刻清空，避免旧计划抢占后续决策。
function clearShortIntent(state) {
  if (state) state.shortIntent = null;
}

// 这里只缓存 2~4 步的低风险计划，像巡逻、蹲草、轻度追星这类连续动作。
function primeShortIntent(state, kind, target, frame, steps) {
  if (!state || !target) return;
  state.shortIntent = {
    kind,
    target: target.slice(),
    createdFrame: frame,
    expireFrame: frame + steps,
    stepsLeft: steps,
  };
}

// 每帧续跑前先复核安全条件：一旦目标失效、被敌人盯上或会扫进弹道，就马上中止。
function resolveShortIntentStep(me, enemy, enemyTank, enemyBullets, game, state) {
  const intent = state && state.shortIntent;
  if (!intent) return null;

  const frame = (game && game.frames) || 0;
  if (intent.expireFrame !== undefined && frame > intent.expireFrame) {
    clearShortIntent(state);
    return null;
  }
  if (intent.stepsLeft !== undefined && intent.stepsLeft <= 0) {
    clearShortIntent(state);
    return null;
  }

  const myPos = me.tank.position;
  const enemyPos = enemyTank ? enemyTank.position : null;
  const bullets = enemyBullets || [];

  if (intent.kind === "hold") {
    const stillHidden = iAmHidden(me, game) && !game.star && teleportReady(me) &&
      (!enemyPos || manhattan(myPos, enemyPos) >= 3) &&
      (!enemyTank || !enemyAimsAt(myPos, enemyTank, game)) &&
      !anyBulletThreatens(bullets, myPos, game);
    if (!stillHidden) {
      clearShortIntent(state);
      return null;
    }
    intent.stepsLeft -= 1;
    if (intent.stepsLeft <= 0) clearShortIntent(state);
    return { hold: true };
  }

  // 非抢星意图在近距离（≤4步）星星出现后立即作废：让 chooseStepScored 重新评估，优先抢星
  // bush/patrol/standoff 等意图不应让坦克错过就差几步的星星
  if (intent.kind !== "star" && intent.kind !== "hold" && game.star &&
      manhattan(myPos, game.star) <= 4) {
    clearShortIntent(state);
    return null;
  }

  if (!intent.target || !isPassable(game, intent.target, enemyPos)) {
    clearShortIntent(state);
    return null;
  }

  const step = nextStepToward(myPos, intent.target, game, enemyPos);
  if (!step) {
    clearShortIntent(state);
    return null;
  }

  const standoff = safeStandoffDistance(enemy);
  // 贴脸抢星(kind=star)豁免"被瞄准"这一条：星刷在敌炮口正对的行/列上很常见，但只要敌此刻无实弹
  // 在途(仅预瞄=概率威胁)、且不是握双弹威胁，被瞄准不该阻止脚边抢星——抢星步本身仍要过弹道/死区校验
  // (mat_GwxblYdS f32-41：星[8,13]在敌[14,13]朝left炮口行上，旧逻辑因 enemyAimsAt 每帧退缩，星被对手走路抢走)。
  const enemyHasLiveBullet = !!(enemy && enemy.bullet && enemy.bullet.position);
  const starGrabExempt = intent.kind === "star" && !enemyHasLiveBullet && !enemyDoubleLaneThreat(enemy);
  const aimBlocks = enemyAimsAt(step, enemyTank, game) && !starGrabExempt;
  if (!isPassable(game, step, enemyPos) || aimBlocks ||
      stepIntoBulletPath(bullets, step, game) ||
      (enemyPos && stepEntersKillZone(myPos, step, enemyPos, game, enemy, standoff))) {
    clearShortIntent(state);
    return null;
  }

  intent.stepsLeft -= 1;
  if (intent.stepsLeft <= 0) clearShortIntent(state);
  return { step, kind: intent.kind };
}

/**
 * 更新敌人最后可见位置，同时追踪"敌方逃跑连续帧"（enemyFleeFrames）。
 * 逃跑定义：敌可见 + 我与敌同行/列视线清晰（有对枪机会）+ 敌朝向背对我（朝远离我的方向）。
 * 连续 ENEMY_FLEE_THRESHOLD 帧以上则认定对手是"跑路流"，shouldChaseStar/findStarTeleport 据此
 * 放宽追星竞争条件——不再等"我比敌更近"才追，直接抢（敌根本不进攻，优先拿分）。
 */
function trackEnemy(state, enemyTank, myPos, game) {
  if (enemyTank && enemyTank.position) {
    state.lastEnemyPos = enemyTank.position.slice();
    state.lastEnemySeenFrame = (game && game.frames) || 0;
    if (myPos) {
      const ep = enemyTank.position;
      const dx = ep[0] - myPos[0], dy = ep[1] - myPos[1];
      const isMovingAway =
        (enemyTank.direction === "right" && dx > 0) ||
        (enemyTank.direction === "left"  && dx < 0) ||
        (enemyTank.direction === "down"  && dy > 0) ||
        (enemyTank.direction === "up"    && dy < 0);
      if (isMovingAway) {
        state.enemyFleeFrames = (state.enemyFleeFrames || 0) + 1;
      } else {
        state.enemyFleeFrames = 0;
      }
    }
  } else {
    state.enemyFleeFrames = 0;
  }
}

/**
 * 记录传送刺杀的结局：若上一帧刚发起刺杀，本帧观察敌人是否已移出我方瞄准线（成功躲开）。
 * 一旦发现敌人能反应过来躲刺杀子弹，本局后续禁用刺杀。
 */
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
  // 敌人消失（不可见）不等于“躲开了刺杀”：可能是被这次刺杀打死（成功）、隐身或进草丛。
  // 误把消失判为躲避会出现“刺杀成功反而禁用刺杀”的反逻辑，故此处不下结论——
  // 保留 pendingAssassin 继续观察，等敌人重新可见再裁决，或在 elapsed>3 时由上方逻辑自然清除。
}


// ===== bt-core.js =====
// ============================================================
// bt-core.js — 行为树核心引擎
//
// 6 种基础节点类型，覆盖坦克 AI 全部决策需求。
// 每帧调用 root.tick(bb) → 执行唯一动作。
//
// 节点 tick 返回值：
//   BT_SUCCESS (1) — 条件满足 / 动作已执行
//   BT_FAILURE (0) — 条件不满足 / 无法执行
//   BT_RUNNING (2) — 跨帧继续（保留，暂未使用）
// ============================================================

var BT_SUCCESS = 1;
var BT_FAILURE = 0;
var BT_RUNNING = 2;

/**
 * Selector（选择器）：依次尝试子节点，第一个非 FAILURE 即为结果。
 * 语义："做第一件能做的事"——互斥行为选一个。
 */
function Selector(name, children) {
  var filtered = [];
  for (var i = 0; i < children.length; i++) {
    if (children[i]) filtered.push(children[i]);
  }
  return {
    type: 'selector', name: name, children: filtered,
    tick: function (bb) {
      for (var i = 0; i < this.children.length; i++) {
        var s = this.children[i].tick(bb);
        if (s !== BT_FAILURE) {
          bb._trace.push(this.children[i].name);
          return s;
        }
      }
      return BT_FAILURE;
    }
  };
}

/**
 * Sequence（序列）：依次 tick 子节点，全部 SUCCESS 才返回 SUCCESS。
 * 语义："前置条件全满足 → 执行动作"——Guard + Action 组合。
 */
function Sequence(name, children) {
  var filtered = [];
  for (var i = 0; i < children.length; i++) {
    if (children[i]) filtered.push(children[i]);
  }
  return {
    type: 'sequence', name: name, children: filtered,
    tick: function (bb) {
      for (var i = 0; i < this.children.length; i++) {
        var s = this.children[i].tick(bb);
        if (s !== BT_SUCCESS) return s;
      }
      return BT_SUCCESS;
    }
  };
}

/**
 * Guard（守卫）：纯条件判断，无副作用。
 * condFn(bb) → true = SUCCESS, false = FAILURE。
 */
function Guard(name, condFn) {
  return {
    type: 'guard', name: name,
    tick: function (bb) {
      return condFn(bb) ? BT_SUCCESS : BT_FAILURE;
    }
  };
}

/**
 * Action（动作）：叶子节点，执行一个具体坦克指令。
 * execFn(bb) 执行后返回 SUCCESS。
 */
function Action(name, execFn) {
  return {
    type: 'action', name: name,
    tick: function (bb) {
      execFn(bb);
      bb._lastAction = name;
      return BT_SUCCESS;
    }
  };
}

/**
 * When（条件装饰器）：condFn 为 true 时 tick 子节点，否则 FAILURE。
 * 用于按 Profile / 比分 / 终局 动态启用/禁用整棵子树。
 */
function When(name, condFn, child) {
  return {
    type: 'when', name: name,
    tick: function (bb) {
      return condFn(bb) ? child.tick(bb) : BT_FAILURE;
    }
  };
}

/**
 * Inverter（反转）：SUCCESS↔FAILURE，RUNNING 不变。
 */
function Inverter(name, child) {
  return {
    type: 'inverter', name: name,
    tick: function (bb) {
      var s = child.tick(bb);
      if (s === BT_SUCCESS) return BT_FAILURE;
      if (s === BT_FAILURE) return BT_SUCCESS;
      return s;
    }
  };
}


// ===== blackboard.js =====
// ============================================================
// blackboard.js — 黑板：所有节点共享的感知上下文
//
// 职责：
//   1. 每帧刷新原始数据 + 廉价派生感知
//   2. 惰性传感器缓存（昂贵计算首次访问时才执行，本帧内复用）
//   3. 跨帧记忆管理（包装 state-store 的 MATCH_STATE）
//   4. 动作包装器（bbFire / bbMoveToward 等统一入口）
//
// 设计原则：节点只读黑板，不互相调用；传感器按需计算不浪费。
// ============================================================

var _BLACKBOARD = null;

/**
 * 获取或初始化黑板。帧数倒退视为新对局，重置全部状态。
 */
function getBlackboard(game) {
  var frame = (game && game.frames) || 0;
  if (!_BLACKBOARD || frame < (_BLACKBOARD.lastFrame || 0) - 2) {
    _BLACKBOARD = {
      // ── 原始引用 ──
      me: null, enemy: null, game: null,
      myPos: null, myDir: null,
      enemyTank: null, enemyPos: null,
      enemyBullets: [],
      frame: 0, star: null,

      // ── 廉价派生感知 ──
      gunIsReady: false,
      teleportIsReady: false,
      shotDir: null,
      distToEnemy: 999,
      distToStar: 999,
      framesLeft: 128,
      myStars: 0, enmStars: 0,
      isLosing: false, isWinning: false, isTied: true,

      // ── 惰性传感器缓存 ──
      _cache: {},

      // ── 跨帧记忆（由 state-store.js 的 getMatchState 管理） ──
      memory: null,

      // ── Profile & 行为树 ──
      profile: null,
      tree: null,
      profileFrame: -999,

      // ── 调试追踪 ──
      _trace: [],
      _lastAction: null,
      lastFrame: 0,
    };
  }
  return _BLACKBOARD;
}

/**
 * 每帧刷新黑板：设置原始数据 → 计算廉价感知 → 清空惰性缓存 → 更新跨帧记忆。
 */
function refreshBlackboard(bb, me, enemy, game) {
  // ── 原始数据 ──
  bb.me = me;
  bb.enemy = enemy;
  bb.game = game;
  bb.frame = (game && game.frames) || 0;
  bb.lastFrame = bb.frame;
  bb.myPos = me.tank.position;
  bb.myDir = me.tank.direction;
  bb.enemyTank = (enemy && enemy.tank) ? enemy.tank : null;
  bb.enemyPos = bb.enemyTank ? bb.enemyTank.position : null;
  bb.enemyBullets = collectEnemyBullets(enemy);
  bb.star = game.star;

  // ── 廉价派生感知（每帧必算，O(1)） ──
  bb.gunIsReady = gunReady(me);
  bb.teleportIsReady = teleportReady(me);
  bb.shotDir = bb.enemyPos ? clearShotDirection(bb.myPos, bb.enemyPos, game) : null;
  bb.distToEnemy = bb.enemyPos ? manhattan(bb.myPos, bb.enemyPos) : 999;
  bb.distToStar = bb.star ? manhattan(bb.myPos, bb.star) : 999;
  bb.framesLeft = MAX_GAME_FRAMES - bb.frame;
  bb.myStars = (me && me.stars) || 0;
  bb.enmStars = (enemy && enemy.stars) || 0;
  bb.isLosing = bb.myStars < bb.enmStars;
  bb.isWinning = bb.myStars > bb.enmStars;
  bb.isTied = bb.myStars === bb.enmStars;

  // ── 清空惰性缓存（每帧重新计算） ──
  bb._cache = {};
  bb._trace = [];
  bb._lastAction = null;

  // ── 跨帧记忆更新 ──
  bb.memory = getMatchState(game);
  recordAssassinOutcome(bb.memory, enemy, bb.enemyTank, game);
  trackEnemy(bb.memory, bb.enemyTank, bb.myPos, game);
  trackStuck(bb.memory, bb.myPos);
}

// ============================================================
// 惰性传感器框架
// ============================================================

/**
 * 惰性传感器：首次访问时调用 computeFn 并缓存结果，本帧内不再重复计算。
 * computeFn 返回 null/undefined 时缓存为 null（避免重复调用）。
 */
function sense(bb, key, computeFn) {
  if (!(key in bb._cache)) {
    bb._cache[key] = computeFn() || null;
  }
  return bb._cache[key];
}

// ---- 生存传感器 ----

function senseBulletDodge(bb) {
  return sense(bb, 'bulletDodge', function () {
    return findBulletDodge(bb.me, bb.enemy, bb.game, bb.enemyPos);
  });
}

function senseCounterShoot(bb) {
  return sense(bb, 'counterShoot', function () {
    return shouldCounterShootThenDodge(bb.me, bb.enemy, bb.enemyTank, bb.enemyBullets, bb.game, bb.enemyPos);
  });
}

function senseEscapeTeleport(bb) {
  return sense(bb, 'escapeTeleport', function () {
    return findEscapeTeleport(bb.me, bb.enemy, bb.enemyTank, bb.enemyBullets, bb.game);
  });
}

function senseTwoStepEscape(bb) {
  return sense(bb, 'twoStepEscape', function () {
    return findTwoStepEscape(bb.me, bb.enemyBullets, bb.game, bb.enemyPos, bb.enemyTank);
  });
}

function senseDesperateDodge(bb) {
  return sense(bb, 'desperateDodge', function () {
    return findDesperateDodge(bb.me, bb.enemyBullets, bb.game, bb.enemyPos, bb.enemyTank);
  });
}

// ---- 软生存传感器 ----

function senseOverloadLaneDodge(bb) {
  return sense(bb, 'overloadLaneDodge', function () {
    return findOverloadLaneDodge(bb.me, bb.enemy, bb.enemyTank, bb.game, bb.enemyPos);
  });
}

function senseAimDodge(bb) {
  return sense(bb, 'aimDodge', function () {
    return findAimDodge(bb.me, bb.enemy, bb.enemyTank, bb.enemyBullets, bb.game, bb.enemyPos);
  });
}

function senseLineDuelDodge(bb) {
  return sense(bb, 'lineDuelDodge', function () {
    return findLineDuelDodge(bb.me, bb.enemy, bb.enemyTank, bb.enemyBullets, bb.game, bb.enemyPos);
  });
}

// ---- 攻击传感器 ----

function senseOpenShot(bb) {
  return sense(bb, 'openShot', function () {
    return findEnemyBulletOpenShot(bb.me, bb.enemy, bb.enemyTank, bb.enemyBullets, bb.game, bb.enemyPos);
  });
}

function senseCloakPreFire(bb) {
  return sense(bb, 'cloakPreFire', function () {
    return findCloakPreFireShot(bb.me, bb.enemy, bb.enemyTank, bb.enemyBullets, bb.game, bb.memory);
  });
}

function senseGuardLineShot(bb) {
  return sense(bb, 'guardLineShot', function () {
    return findGuardLineShot(bb.me, bb.enemy, bb.enemyTank, bb.enemyBullets, bb.game, bb.enemyPos);
  });
}

function senseBushLineShot(bb) {
  return sense(bb, 'bushLineShot', function () {
    return findBushLineShot(bb.me, bb.enemy, bb.enemyTank, bb.enemyBullets, bb.game, bb.enemyPos, bb.memory);
  });
}

// ---- 目标传感器 ----

function senseStarTeleport(bb) {
  return sense(bb, 'starTeleport', function () {
    return findStarTeleport(bb.me, bb.enemy, bb.enemyTank, bb.enemyBullets, bb.game, bb.memory);
  });
}

function senseStarGuard(bb) {
  return sense(bb, 'starGuard', function () {
    return findContestedStarGuard(bb.me, bb.enemyTank, bb.game);
  });
}

function senseAssassination(bb) {
  return sense(bb, 'assassination', function () {
    return findAssassinationPlan(bb.me, bb.enemy, bb.enemyTank, bb.enemyBullets, bb.game, bb.memory);
  });
}

// ---- 移动传感器 ----

function senseMoveCandidate(bb) {
  return sense(bb, 'moveCandidate', function () {
    return chooseMoveCandidateScored(bb.me, bb.enemy, bb.game, bb.enemyPos, bb.memory, bb.enemyBullets);
  });
}

function senseSafeNeighbor(bb) {
  return sense(bb, 'safeNeighbor', function () {
    return bestSafeNeighbor(bb.myPos, bb.game, bb.enemyPos, bb.enemyTank, bb.enemyBullets, bb.enemy);
  });
}

function senseDigDirection(bb) {
  return sense(bb, 'digDir', function () {
    var target = bb.star || bb.enemyPos || nearestOpenToCenter(bb.game);
    return findDigDirection(bb.myPos, bb.game, target);
  });
}

// ============================================================
// 动作包装器（统一从 bb 取参数，简化节点代码）
// ============================================================

function bbFire(bb) {
  bb.me.fire();
}

function bbTeleport(bb, pos) {
  bb.me.teleport(pos[0], pos[1]);
}

function bbMoveToward(bb, target) {
  moveToward(bb.me, bb.game, target, bb.enemyPos, bb.enemyTank, bb.enemyBullets, bb.enemy);
}

function bbTurnToward(bb, dir) {
  turnToward(bb.me, dir);
}

function bbSpeak(bb, msg) {
  if (bb.me && typeof bb.me.speak === 'function') bb.me.speak(msg);
}

function bbDirectGo(bb, target) {
  var dir = directionBetween(bb.myPos, target);
  if (dir === bb.myDir) bb.me.go();
  else if (dir) bbTurnToward(bb, dir);
}


// ===== enemy-profiler.js =====
// ============================================================
// enemy-profiler.js — 敌情识别与 Profile 系统
//
// 两层识别：
//   1. 静态 Profile：基于 enemy.skill.type（开局即知，8 种技能 → 8 套参数）
//   2. 动态 Profile：基于对局中观察到的打法风格（前 15 帧识别）
//
// Profile 参数直接驱动 tree-factory.js 的子树组装逻辑。
// ============================================================

// ---- 8 种技能的基础策略参数 ----
var SKILL_PROFILES = {
  overload: {
    name: '双弹流',
    standoffDistance: 6,         // 安全间距大：双弹覆盖 ±1 列
    enableAssassination: false,  // 刺杀=贴脸=落入双弹覆盖带
    attackAggression: 'low',     // 不主动对枪（它一过载就双弹反杀）
    starAggression: 'high',     // 全力抢星（游戏靠星得分）
    bushCamp: true,              // 无星时蹲草等传送抢
    dodgeBand: true,             // 需要躲双弹覆盖带
    freezeZoneAvoid: false,
    zigzagEscape: false,
    prefireOnDisappear: false,
    centerControl: false,
    shieldBait: false,
  },
  shield: {
    name: '护盾流',
    standoffDistance: 3,
    enableAssassination: false,  // 刺杀被盾吃掉 + 回敬
    attackAggression: 'cautious', // 骗盾后窗口期才打
    starAggression: 'high',
    bushCamp: false,
    dodgeBand: false,
    freezeZoneAvoid: false,
    zigzagEscape: false,
    prefireOnDisappear: false,
    centerControl: false,
    shieldBait: true,            // 需要骗盾逻辑
  },
  freeze: {
    name: '冰冻流',
    standoffDistance: 5,         // 被冻致死距离=4，保持 5+
    enableAssassination: true,
    attackAggression: 'medium',
    starAggression: 'high',
    bushCamp: false,
    dodgeBand: false,
    freezeZoneAvoid: true,       // 特殊：避开冰冻致死区
    zigzagEscape: false,
    prefireOnDisappear: false,
    centerControl: false,
    shieldBait: false,
  },
  cloak: {
    name: '隐身流',
    standoffDistance: 4,
    enableAssassination: true,
    attackAggression: 'medium',
    starAggression: 'high',
    bushCamp: false,
    dodgeBand: false,
    freezeZoneAvoid: false,
    zigzagEscape: true,          // 之字形逃跑防背后偷袭
    prefireOnDisappear: true,    // 刚隐身时预射
    centerControl: false,
    shieldBait: false,
  },
  teleport: {
    name: '传送流',
    standoffDistance: 3,
    enableAssassination: false,  // 它能传送逃脱
    attackAggression: 'medium',
    starAggression: 'high',
    bushCamp: false,
    dodgeBand: false,
    freezeZoneAvoid: false,
    zigzagEscape: false,
    prefireOnDisappear: false,
    centerControl: true,         // 守中心等星（它可以从任何位置传送抢星）
    shieldBait: false,
  },
  poison: {
    name: '毒雾流',
    standoffDistance: 4,
    enableAssassination: true,
    attackAggression: 'medium',
    starAggression: 'high',
    bushCamp: false,
    dodgeBand: false,
    freezeZoneAvoid: false,
    zigzagEscape: false,
    prefireOnDisappear: false,
    centerControl: false,
    shieldBait: false,
  },
  stun: {
    name: '眩晕流',
    standoffDistance: 4,
    enableAssassination: true,
    attackAggression: 'medium',
    starAggression: 'high',
    bushCamp: false,
    dodgeBand: false,
    freezeZoneAvoid: false,
    zigzagEscape: false,
    prefireOnDisappear: false,
    centerControl: false,
    shieldBait: false,
  },
  boost: {
    name: '加速流',
    standoffDistance: 4,
    enableAssassination: true,
    attackAggression: 'high',    // 加速流没有直接杀伤技能，可以主动打
    starAggression: 'medium',
    bushCamp: false,
    dodgeBand: false,
    freezeZoneAvoid: false,
    zigzagEscape: false,
    prefireOnDisappear: false,
    centerControl: false,
    shieldBait: false,
  },
};

// ---- 打法风格枚举 ----
var PLAYSTYLE_AGGRESSIVE  = 'aggressive';   // 频繁对线 + 开火
var PLAYSTYLE_DEFENSIVE   = 'defensive';    // 跑路 + 保持距离
var PLAYSTYLE_STAR_RUSHER = 'starRusher';   // 星刷新就冲
var PLAYSTYLE_UNKNOWN     = 'unknown';      // 未识别

// ---- 打法风格检测阈值 ----
var PROFILER_DETECT_AFTER_FRAME = 15;  // 至少观察 15 帧才下结论
var PROFILER_AGGRESSIVE_RATIO = 0.4;   // 朝我方向帧占比 > 40% = 进攻型
var PROFILER_DEFENSIVE_RATIO = 0.35;   // 逃跑帧占比 > 35% = 防守型

/**
 * 每帧更新打法观察数据（写入 bb.memory.profiler）。
 * 在 refreshBlackboard 之后、detectPlaystyle 之前调用。
 */
function updatePlaystyleObservation(bb) {
  var m = bb.memory;
  if (!m._profiler) {
    m._profiler = {
      enemyVisibleFrames: 0,
      enemyFacingMeFrames: 0,
      enemyFleeingFrames: 0,
      enemyStarRushCount: 0,
      lastStarPos: null,
    };
  }
  var p = m._profiler;

  // 敌人可见时统计朝向
  if (bb.enemyTank) {
    p.enemyVisibleFrames++;
    // 敌人是否朝向我（同线且面朝我方向）
    if (bb.shotDir && bb.enemyTank.direction === oppositeDir(bb.shotDir)) {
      p.enemyFacingMeFrames++;
    }
    // 逃跑统计（复用 state-store 的 enemyFleeFrames）
    if (m.enemyFleeFrames > 0) {
      p.enemyFleeingFrames++;
    }
    // 星星刷新后敌人是否立刻朝星走
    if (bb.star) {
      if (!p.lastStarPos || !samePos(p.lastStarPos, bb.star)) {
        p.lastStarPos = bb.star.slice();
        // 新星刷新，检查敌人是否朝星方向
        var eDist = manhattan(bb.enemyPos, bb.star);
        if (eDist <= 5) p.enemyStarRushCount++;
      }
    }
  }
}

/**
 * 根据积累的观察数据判定敌方打法风格。
 */
function detectPlaystyle(bb) {
  var m = bb.memory;
  if (!m._profiler || bb.frame < PROFILER_DETECT_AFTER_FRAME) return PLAYSTYLE_UNKNOWN;
  var p = m._profiler;
  var vis = Math.max(1, p.enemyVisibleFrames);

  if (p.enemyFacingMeFrames / vis > PROFILER_AGGRESSIVE_RATIO) return PLAYSTYLE_AGGRESSIVE;
  if (p.enemyFleeingFrames / vis > PROFILER_DEFENSIVE_RATIO) return PLAYSTYLE_DEFENSIVE;
  if (p.enemyStarRushCount >= 2) return PLAYSTYLE_STAR_RUSHER;
  return PLAYSTYLE_UNKNOWN;
}

/**
 * 反方向辅助函数
 */
function oppositeDir(dir) {
  var m = { up: 'down', down: 'up', left: 'right', right: 'left' };
  return m[dir] || dir;
}

/**
 * 构建最终 Profile：静态技能参数 + 动态打法修正。
 * 返回的 profile 对象直接驱动 tree-factory 的子树组装。
 */
function buildProfile(bb) {
  var skillType = (bb.enemy && bb.enemy.skill && bb.enemy.skill.type) || 'stun';
  var base = SKILL_PROFILES[skillType] || SKILL_PROFILES.stun;

  // 浅拷贝基础 profile
  var profile = {};
  for (var k in base) {
    if (base.hasOwnProperty(k)) profile[k] = base[k];
  }
  profile.skillType = skillType;

  // 动态打法修正
  var playstyle = detectPlaystyle(bb);
  profile.playstyle = playstyle;

  if (playstyle === PLAYSTYLE_AGGRESSIVE) {
    // 对莽夫：加大安全距离、降低攻击欲望、提升躲避
    profile.standoffDistance = Math.max(profile.standoffDistance, 5);
    if (profile.attackAggression === 'high') profile.attackAggression = 'medium';
  }

  if (playstyle === PLAYSTYLE_DEFENSIVE) {
    // 对跑路型：缩小安全距离、全力抢星（它不打我）
    profile.standoffDistance = Math.min(profile.standoffDistance, 3);
    profile.starAggression = 'max';
  }

  if (playstyle === PLAYSTYLE_STAR_RUSHER) {
    // 对抢星型：提升抢星优先级、守星预瞄
    profile.starAggression = 'max';
  }

  // 终局修正：最后 20 帧落后时，无论对手类型都全力抢星
  if (bb.framesLeft <= 20 && bb.isLosing) {
    profile.starAggression = 'max';
    if (profile.attackAggression !== 'none') profile.attackAggression = 'low';
  }

  // 最后 10 帧：极端抢星模式
  if (bb.framesLeft <= 10) {
    profile.starAggression = 'max';
    profile.attackAggression = 'none';
  }

  return profile;
}


// ===== nodes-survival.js =====
// ============================================================
// nodes-survival.js — 生存行为节点
//
// 两类：
//   硬生存（hardSurvival）：子弹来袭等致命威胁，必须立即响应
//   软生存（softSurvival）：预防性躲避，由 profile 控制敏感度
//
// 所有节点复用 myth-tank.js 的 find* 函数，通过 blackboard 惰性传感器访问。
// ============================================================

// ---- 硬生存子树（永远最高优先级，不受 profile 影响） ----

function createHardSurvivalTree() {
  return Selector('hard-survival', [

    // 1. 对射先射后走：来袭子弹 + 能反击 + 开火后仍来得及躲
    Sequence('counter-shoot', [
      Guard('has-bullet-dodge', function (bb) { return !!senseBulletDodge(bb); }),
      Guard('can-counter', function (bb) { return !!senseCounterShoot(bb); }),
      Action('do-counter-fire', function (bb) {
        bbSpeak(bb, '反击!');
        bbFire(bb);
      })
    ]),

    // 2. 常规子弹躲避：预判弹道，移动到相邻安全格
    Sequence('bullet-dodge', [
      Guard('has-bullet-dodge', function (bb) { return !!senseBulletDodge(bb); }),
      Action('do-bullet-dodge', function (bb) {
        bbMoveToward(bb, senseBulletDodge(bb));
      })
    ]),

    // 3. 紧急传送逃生：常规移动躲不开时传送到安全落点
    Sequence('escape-teleport', [
      Guard('no-dodge-available', function (bb) { return !senseBulletDodge(bb); }),
      Guard('has-escape-tp', function (bb) { return !!senseEscapeTeleport(bb); }),
      Action('do-escape-tp', function (bb) {
        bbTeleport(bb, senseEscapeTeleport(bb));
      })
    ]),

    // 4. 两步脱困：双弹夹击导致单步无安全格，走"下一帧还能继续脱离"的格
    Sequence('two-step-escape', [
      Guard('has-two-step', function (bb) { return !!senseTwoStepEscape(bb); }),
      Action('do-two-step', function (bb) {
        bbDirectGo(bb, senseTwoStepEscape(bb));
      })
    ]),

    // 5. 绝境横移：躲不掉也传不了，至少垂直弹道挣一步
    Sequence('desperate-dodge', [
      Guard('has-desperate', function (bb) { return !!senseDesperateDodge(bb); }),
      Action('do-desperate', function (bb) {
        bbMoveToward(bb, senseDesperateDodge(bb));
      })
    ]),
  ]);
}

// ---- 软生存子树（profile 控制包含哪些节点） ----

function createSoftSurvivalTree(profile) {
  var children = [];

  // overload 特有：双弹覆盖带提前脱离
  if (profile.dodgeBand) {
    children.push(
      Sequence('overload-lane-dodge', [
        Guard('in-overload-band', function (bb) { return !!senseOverloadLaneDodge(bb); }),
        Action('dodge-overload-band', function (bb) {
          bbMoveToward(bb, senseOverloadLaneDodge(bb));
        })
      ])
    );
  }

  // freeze 特有：冰冻致死区回避
  if (profile.freezeZoneAvoid) {
    children.push(
      Sequence('freeze-zone-avoid', [
        Guard('in-freeze-zone', function (bb) {
          return bb.enemyPos && freezeKillsAt(bb.myPos, bb.enemyPos, bb.game);
        }),
        Guard('has-aim-dodge', function (bb) { return !!senseAimDodge(bb); }),
        Action('escape-freeze-zone', function (bb) {
          bbMoveToward(bb, senseAimDodge(bb));
        })
      ])
    );
  }

  // 通用：防范敌方瞄准（敌炮口正对我，提前移动离线）
  children.push(
    Sequence('aim-dodge', [
      Guard('has-aim-dodge', function (bb) { return !!senseAimDodge(bb); }),
      Action('do-aim-dodge', function (bb) {
        bbMoveToward(bb, senseAimDodge(bb));
      })
    ])
  );

  // 通用：近距对射规避（近距同线且我不占先手，侧移离线）
  children.push(
    Sequence('line-duel-dodge', [
      Guard('has-line-duel', function (bb) { return !!senseLineDuelDodge(bb); }),
      Action('do-line-duel-dodge', function (bb) {
        bbMoveToward(bb, senseLineDuelDodge(bb));
      })
    ])
  );

  return Selector('soft-survival', children);
}


// ===== nodes-attack.js =====
// ============================================================
// nodes-attack.js — 攻击行为节点
//
// 由 profile.attackAggression 控制挂载哪些攻击子节点：
//   'none'     → 不挂载任何攻击节点（终局纯抢星）
//   'low'      → 只挂空窗反击
//   'cautious' → 空窗反击 + 安全直射（骗盾流专用）
//   'medium'   → 空窗反击 + 直射 + 守线
//   'high'     → 全挂载（空窗 + 隐身预射 + 直射 + 守线 + 草丛）
// ============================================================

function createAttackTree(profile) {
  if (profile.attackAggression === 'none') return null;

  var children = [];

  // 空窗期反击：敌方子弹刚射出（炮管空），我与敌同线时抢射
  children.push(
    Sequence('open-shot', [
      Guard('has-open-shot', function (bb) { return !!senseOpenShot(bb); }),
      Action('do-open-shot', function (bb) {
        var dir = senseOpenShot(bb);
        if (bb.myDir === dir) { bbSpeak(bb, '空窗!'); bbFire(bb); }
        else bbTurnToward(bb, dir);
      })
    ])
  );

  // cloak 敌刚隐身时预射（仅对隐身流启用）
  if (profile.prefireOnDisappear) {
    children.push(
      Sequence('cloak-prefire', [
        Guard('has-cloak-prefire', function (bb) { return !!senseCloakPreFire(bb); }),
        Action('do-cloak-prefire', function (bb) {
          var shot = senseCloakPreFire(bb);
          if (shot.fire) { bbSpeak(bb, '预射!'); bbFire(bb); }
          else bbTurnToward(bb, shot.dir);
        })
      ])
    );
  }

  // 直射：同线无障碍 + 可开火
  if (profile.attackAggression !== 'low') {
    children.push(
      Sequence('fire-direct', [
        Guard('has-clear-shot', function (bb) { return !!bb.shotDir && bb.gunIsReady; }),
        Guard('can-shoot-enemy', function (bb) { return canShoot(bb.me, bb.enemy); }),
        // shield 流特殊处理：需要确认打完能侧移躲开回敬
        Guard('shield-safe', function (bb) {
          if (!enemyHasShieldSkill(bb.enemy)) return true;
          if (profile.shieldBait) {
            return canShootThenEvadeShieldCounter(
              bb.me, bb.enemy, bb.enemyTank, bb.enemyBullets, bb.game, bb.enemyPos
            );
          }
          return true;
        }),
        // 双弹近距不对枪（除非严格先手击杀）
        Guard('not-double-lane-close', function (bb) {
          if (!enemyDoubleLaneThreat(bb.enemy)) return true;
          if (bb.distToEnemy >= safeStandoffDistance(bb.enemy)) return true;
          // 检查严格先手击杀
          if (turnDistance(bb.myDir, bb.shotDir) !== 0) return false;
          if (!enemyCanFireSoon(bb.enemy)) return true;
          var myHit = Math.ceil(bb.distToEnemy / BULLET_SPEED);
          var dirToMe = clearShotDirection(bb.enemyPos, bb.myPos, bb.game);
          var enemyHit = (dirToMe ? turnDistance(bb.enemyTank.direction, dirToMe) : 1)
            + Math.ceil(bb.distToEnemy / BULLET_SPEED);
          return myHit < enemyHit;
        }),
        // 安全直射判定：不会必死才提到高优先级
        Guard('safe-to-fire', function (bb) {
          return directShotNotSuicidal(
            bb.me, bb.enemy, bb.enemyTank, bb.enemyBullets, bb.game, bb.enemyPos, bb.shotDir
          );
        }),
        Action('do-fire-direct', function (bb) {
          if (bb.myDir === bb.shotDir) { bbSpeak(bb, '直射!'); bbFire(bb); }
          else bbTurnToward(bb, bb.shotDir);
        })
      ])
    );

    // 非安全直射（能打但有风险，优先级低于安全直射，高于守线）
    children.push(
      Sequence('fire-risky', [
        Guard('has-clear-shot', function (bb) { return !!bb.shotDir && bb.gunIsReady; }),
        Guard('can-shoot-enemy', function (bb) { return canShoot(bb.me, bb.enemy); }),
        Guard('shield-ok', function (bb) {
          return !enemyHasShieldSkill(bb.enemy) ||
            canShootThenEvadeShieldCounter(bb.me, bb.enemy, bb.enemyTank, bb.enemyBullets, bb.game, bb.enemyPos);
        }),
        Guard('not-double-threat', function (bb) {
          return !enemyDoubleLaneThreat(bb.enemy) ||
            bb.distToEnemy >= safeStandoffDistance(bb.enemy);
        }),
        Action('do-fire-risky', function (bb) {
          if (bb.myDir === bb.shotDir) { bbSpeak(bb, '开炮!'); bbFire(bb); }
          else bbTurnToward(bb, bb.shotDir);
        })
      ])
    );
  }

  // 守线预瞄：提前把炮口对准敌/星可能进入的路线
  if (profile.attackAggression === 'medium' || profile.attackAggression === 'high') {
    children.push(
      Sequence('guard-line', [
        Guard('has-guard-line', function (bb) { return !!senseGuardLineShot(bb); }),
        Action('do-guard-line', function (bb) {
          var shot = senseGuardLineShot(bb);
          if (shot.fire) { bbSpeak(bb, '守线!'); bbFire(bb); }
          else bbTurnToward(bb, shot.dir);
        })
      ])
    );
  }

  // 草丛攻防：预射打草惊蛇 / 草丛伏击
  if (profile.attackAggression === 'high') {
    children.push(
      Sequence('bush-shot', [
        Guard('has-bush-shot', function (bb) { return !!senseBushLineShot(bb); }),
        Action('do-bush-shot', function (bb) {
          var shot = senseBushLineShot(bb);
          if (shot.fire) { bbSpeak(bb, '草枪!'); bbFire(bb); }
          else bbTurnToward(bb, shot.dir);
        })
      ])
    );
  }

  return Selector('attack', children);
}


// ===== nodes-objective.js =====
// ============================================================
// nodes-objective.js — 目标行为节点（星星 & 刺杀）
//
// 星星是唯一直接得分来源，优先级由 profile.starAggression 控制：
//   'low'    → 只在安全时抢星
//   'high'   → 主动抢星（常规对局）
//   'max'    → 全力冲星（终局/落后/对跑路流）
//
// 刺杀由 profile.enableAssassination 开关控制。
// ============================================================

function createObjectiveTree(profile) {
  var children = [];

  // ---- 隐身守星防陷阱（优先于抢星） ----
  children.push(
    Selector('cloak-star-trap', [
      // 有陷阱 + 找到安全守位格 → 移动到守位格
      Sequence('cloak-guard', [
        Guard('in-cloak-trap', function (bb) {
          return inCloakStarTrap(bb.me, bb.enemy, bb.enemyTank, bb.game, bb.memory);
        }),
        Guard('has-guard-step', function (bb) {
          return !!cloakStarGuardStep(bb.me, bb.game, bb.memory);
        }),
        Action('do-cloak-guard', function (bb) {
          bbMoveToward(bb, cloakStarGuardStep(bb.me, bb.game, bb.memory));
        })
      ]),
      // 有陷阱但无安全格 → 原地不动（阻断送死追星）
      Sequence('cloak-trap-hold', [
        Guard('in-cloak-trap', function (bb) {
          return inCloakStarTrap(bb.me, bb.enemy, bb.enemyTank, bb.game, bb.memory);
        }),
        Action('do-trap-hold', function (bb) { /* 原地等待 */ })
      ]),
    ])
  );

  // ---- 传送抢星 ----
  children.push(
    Sequence('star-teleport', [
      Guard('star-exists', function (bb) { return !!bb.star; }),
      Guard('teleport-ready', function (bb) { return bb.teleportIsReady; }),
      Guard('not-in-cloak-trap', function (bb) {
        return !inCloakStarTrap(bb.me, bb.enemy, bb.enemyTank, bb.game, bb.memory);
      }),
      Guard('has-star-tp', function (bb) { return !!senseStarTeleport(bb); }),
      // starAggression='low' 时额外检查：星星附近是否安全
      Guard('aggression-gate', function (bb) {
        if (profile.starAggression === 'low') {
          // 低攻击性：敌人在星附近且面朝我时不抢
          return !bb.enemyTank || bb.distToEnemy > 3 ||
            !enemyAimsAt(bb.myPos, bb.enemyTank, bb.game);
        }
        return true;
      }),
      Action('do-star-tp', function (bb) {
        var tp = senseStarTeleport(bb);
        // 传送前先转好朝向（落地朝向不变）
        var faceDir = teleportPreTurnDir(bb.me, tp, bb.enemy, bb.enemyTank, bb.game);
        if (faceDir && bb.myDir !== faceDir) {
          bbTurnToward(bb, faceDir);
        } else {
          bbSpeak(bb, '传星!');
          bbTeleport(bb, tp);
        }
      })
    ])
  );

  // ---- 星星争夺预瞄守点 ----
  children.push(
    Sequence('star-guard', [
      Guard('has-star-guard', function (bb) { return !!senseStarGuard(bb); }),
      Action('do-star-guard', function (bb) {
        var sg = senseStarGuard(bb);
        if (bb.myDir !== sg.dir) bbTurnToward(bb, sg.dir);
      })
    ])
  );

  // ---- 传送刺杀（profile 开关控制） ----
  if (profile.enableAssassination) {
    children.push(
      Sequence('assassination', [
        Guard('has-assassination', function (bb) { return !!senseAssassination(bb); }),
        Action('do-assassination', function (bb) {
          var plan = senseAssassination(bb);
          if (bb.myDir === plan.dir) {
            bb.memory.pendingAssassin = {
              targetPos: bb.enemyPos.slice(),
              dir: plan.dir,
              frame: bb.frame,
            };
            bbSpeak(bb, '刺杀!');
            bbTeleport(bb, plan.pos);
          } else {
            bbTurnToward(bb, plan.dir);
          }
        })
      ])
    );
  }

  return Selector('objective', children);
}


// ===== nodes-movement.js =====
// ============================================================
// nodes-movement.js — 移动 / 计划 / 兜底行为节点
//
// 最低优先级层：当没有威胁、没有攻击机会、没有目标时执行。
// 包含：蹲草等星 / 短期意图续跑 / BFS 走位 / 破墙 / 安全邻格 / 兜底右转。
// ============================================================

function createMovementTree(profile) {
  var children = [];

  // ---- 蹲草等星（对 overload 双弹流 + 无星 + 我在草丛 + 有传送） ----
  if (profile.bushCamp) {
    children.push(
      Sequence('bush-hold', [
        Guard('is-overload-enemy', function (bb) { return enemyIsOverloadType(bb.enemy); }),
        Guard('no-star', function (bb) { return !bb.star; }),
        Guard('i-am-hidden', function (bb) { return iAmHidden(bb.me, bb.game); }),
        Guard('teleport-ready', function (bb) { return bb.teleportIsReady; }),
        Guard('bush-safe', function (bb) {
          return !anyBulletThreatens(bb.enemyBullets, bb.myPos, bb.game) &&
            (!bb.enemyPos || bb.distToEnemy >= 3) &&
            (!bb.enemyTank || !enemyAimsAt(bb.myPos, bb.enemyTank, bb.game));
        }),
        Action('do-bush-hold', function (bb) {
          primeShortIntent(bb.memory, 'hold', bb.myPos, bb.frame, 3);
          bbSpeak(bb, '蹲草');
        })
      ])
    );
  }

  // ---- 短期意图续跑（缓存的 2~4 步低风险计划） ----
  children.push(
    Sequence('short-intent', [
      Guard('has-short-intent', function (bb) {
        var intent = resolveShortIntentStep(
          bb.me, bb.enemy, bb.enemyTank, bb.enemyBullets, bb.game, bb.memory
        );
        if (!intent) return false;
        // 缓存到 bb 供 Action 使用
        bb._cache._shortIntent = intent;
        return true;
      }),
      Action('do-short-intent', function (bb) {
        var intent = bb._cache._shortIntent;
        if (intent.hold) return; // hold = 原地不动
        if (bb.memory.stuckFrames >= 2) {
          clearShortIntent(bb.memory);
          breakStuckStep(bb.me, bb.game, bb.enemyPos, bb.enemyTank,
            bb.enemyBullets, bb.memory.lastMyPos2, bb.enemy);
          return;
        }
        // 抢星意图：直奔星（不走 moveToward 的二次安全检查，避免被预瞄劝退）
        var starLiveBullet = !!(bb.enemy && bb.enemy.bullet && bb.enemy.bullet.position);
        if (intent.kind === 'star' && !starLiveBullet) {
          bbDirectGo(bb, intent.step);
        } else {
          bbMoveToward(bb, intent.step);
        }
      })
    ])
  );

  // ---- BFS 评分走位 ----
  children.push(
    Sequence('scored-move', [
      Guard('has-move-candidate', function (bb) {
        var mc = senseMoveCandidate(bb);
        return !!(mc && mc.step);
      }),
      Action('do-scored-move', function (bb) {
        if (bb.memory.stuckFrames >= 2) {
          breakStuckStep(bb.me, bb.game, bb.enemyPos, bb.enemyTank,
            bb.enemyBullets, bb.memory.lastMyPos2, bb.enemy);
          return;
        }
        var mc = senseMoveCandidate(bb);
        var enemyHasLiveBullet = !!(bb.enemy && bb.enemy.bullet && bb.enemy.bullet.position);
        // 抢星走位：直奔不走 moveToward（避免 enemyAimsAt 劝退）
        if (mc.kind === 'star' && !enemyHasLiveBullet) {
          bbDirectGo(bb, mc.step);
        } else {
          bbMoveToward(bb, mc.step);
        }
      })
    ])
  );

  // ---- 破墙开路 ----
  children.push(
    Sequence('dig', [
      Guard('has-dig', function (bb) { return !!senseDigDirection(bb) && bb.gunIsReady; }),
      Action('do-dig', function (bb) {
        var dir = senseDigDirection(bb);
        if (bb.myDir === dir) { bbSpeak(bb, '破墙'); bbFire(bb); }
        else bbTurnToward(bb, dir);
      })
    ])
  );

  // ---- 安全邻格徘徊 ----
  children.push(
    Sequence('safe-neighbor', [
      Guard('has-safe-neighbor', function (bb) { return !!senseSafeNeighbor(bb); }),
      Action('do-safe-neighbor', function (bb) {
        bbMoveToward(bb, senseSafeNeighbor(bb));
      })
    ])
  );

  // ---- 终极兜底：原地右转防挂机 ----
  children.push(
    Action('turn-right', function (bb) {
      bb.me.turn('right');
    })
  );

  return Selector('movement', children);
}


// ===== tree-factory.js =====
// ============================================================
// tree-factory.js — 按 Profile 动态组装行为树
//
// 核心函数 buildBehaviorTree(profile) 根据敌情 Profile 参数
// 决定挂载哪些子树、调整子树顺序，返回一棵完整的行为树根节点。
//
// 树结构总览：
//   Root (Selector)
//   ├── [固定] 硬生存（子弹/传送逃生，永远最高）
//   ├── [固定] 冰冻拦截（被冻时跳过本帧）
//   ├── [Profile] 软生存（防瞄/近距规避，敏感度可调）
//   ├── [动态] 终局抢星提权（落后+终局时目标层插到攻击层前）
//   ├── [Profile] 攻击（空窗/直射/守线/草丛，激进度可调）
//   ├── [Profile] 目标（星星/刺杀，开关可控）
//   └── [Profile] 移动（蹲草/走位/破墙/兜底）
// ============================================================

/**
 * 根据 Profile 组装完整行为树。
 *
 * @param {Object} profile - 由 buildProfile(bb) 生成的策略参数
 * @returns {Object} 行为树根节点，调用 root.tick(bb) 执行决策
 */
function buildBehaviorTree(profile) {

  // ═══════ 子树构建 ═══════
  var hardSurvival = createHardSurvivalTree();
  var softSurvival = createSoftSurvivalTree(profile);
  var attack       = createAttackTree(profile);
  var objective    = createObjectiveTree(profile);
  var movement     = createMovementTree(profile);

  // ═══════ 冰冻拦截（被冻时本帧无法操作） ═══════
  var frozenCheck = Sequence('frozen-check', [
    Guard('is-frozen', function (bb) {
      return !!(bb.me.status && bb.me.status.frozen);
    }),
    Action('frozen-wait', function (bb) {
      bbSpeak(bb, '冰冻中');
    })
  ]);

  // ═══════ 动态提权装饰器 ═══════

  // 终局抢星提权：落后 + 最后 20 帧 → 目标层提到攻击层前面
  var endgameStarBoost = When('endgame-star-boost',
    function (bb) { return bb.framesLeft <= 20 && bb.isLosing; },
    objective
  );

  // 最后 10 帧无论输赢：全力冲星（跳过攻击层）
  var lastChanceStar = When('last-chance-star',
    function (bb) { return bb.framesLeft <= 10; },
    objective
  );

  // starAggression='max' 时（跑路流/星极致模式）：目标层也提前
  var maxStarAggression = When('max-star-aggression',
    function (bb) { return profile.starAggression === 'max' && bb.framesLeft > 20; },
    objective
  );

  // ═══════ 组装根节点 ═══════
  var rootChildren = [
    // 第一优先级：被冻住就直接返回
    frozenCheck,

    // 第二优先级：硬生存（来袭子弹必须立即响应）
    hardSurvival,

    // 第三优先级：软生存（预防性躲避）
    softSurvival,

    // 第四优先级（动态）：终局/落后/极致模式时目标层提前
    lastChanceStar,
    endgameStarBoost,
    maxStarAggression,

    // 第五优先级：攻击
    attack,

    // 第六优先级：常规目标（非终局时的正常优先级）
    objective,

    // 第七优先级：移动/兜底
    movement,
  ];

  // 过滤掉 null（如 attackAggression='none' 时 attack 为 null）
  var filtered = [];
  for (var i = 0; i < rootChildren.length; i++) {
    if (rootChildren[i]) filtered.push(rootChildren[i]);
  }

  return Selector('root', filtered);
}


// ===== entry.js =====
// ============================================================
// entry.js — onIdle 入口
//
// 替代 decision-engine.js，每帧执行：
//   [1] 获取/刷新黑板
//   [2] 更新打法观察
//   [3] 按需重建 Profile + 行为树
//   [4] tick 行为树（执行唯一动作）
//   [5] 调试输出
// ============================================================

var PROFILE_REBUILD_INTERVAL = 16; // 每 16 帧重新评估 profile
var DEBUG_TRACE = true;            // 是否输出决策追踪

function onIdle(me, enemy, game) {
  // ─── [1] 黑板刷新 ───
  var bb = getBlackboard(game);
  refreshBlackboard(bb, me, enemy, game);

  // ─── [2] 打法观察更新 ───
  updatePlaystyleObservation(bb);

  // ─── [3] Profile + 行为树构建/重建 ───
  var needRebuild = !bb.tree ||
    !bb.profile ||
    bb.frame - bb.profileFrame >= PROFILE_REBUILD_INTERVAL;

  if (needRebuild) {
    bb.profile = buildProfile(bb);
    bb.tree = buildBehaviorTree(bb.profile);
    bb.profileFrame = bb.frame;
  }

  // ─── [4] 执行行为树 ───
  bb.tree.tick(bb);

  // ─── [5] 调试输出 ───
  if (DEBUG_TRACE && bb._lastAction) {
    var traceMsg = bb._trace.join('>') + ':' + bb._lastAction;
    // 开局播报敌方技能
    if (bb.frame === 5 && bb.profile) {
      traceMsg = '敌:' + bb.profile.name + ' | ' + traceMsg;
    }
    // 限制 speak 频率：关键动作才播报
    var isKeyAction = isKeyActionForSpeak(bb._lastAction);
    if (isKeyAction) {
      bbSpeak(bb, traceMsg.length > 30 ? bb._lastAction : traceMsg);
    }
    // print 始终输出（供 replay 调试）
    if (typeof print === 'function') {
      print('f' + bb.frame + ' ' + traceMsg);
    }
  }
}

/**
 * 判断是否为值得气泡播报的关键动作
 */
function isKeyActionForSpeak(actionName) {
  var keyActions = {
    'do-counter-fire': true,
    'do-bullet-dodge': true,
    'do-escape-tp': true,
    'do-two-step': true,
    'do-desperate': true,
    'do-aim-dodge': true,
    'do-line-duel-dodge': true,
    'do-open-shot': true,
    'do-cloak-prefire': true,
    'do-fire-direct': true,
    'do-fire-risky': true,
    'do-guard-line': true,
    'do-bush-shot': true,
    'do-cloak-guard': true,
    'do-star-tp': true,
    'do-assassination': true,
    'do-bush-hold': true,
    'frozen-wait': true,
  };
  return !!keyActions[actionName];
}
