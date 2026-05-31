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

function onIdle(me, enemy, game) {
  // 获取己方坐标
  const myPos = me.tank.position;
  // 获取敌方坦克对象和坐标（如果丢失视野则为 null）
  const enemyTank = enemy && enemy.tank ? enemy.tank : null;
  const enemyPos = enemyTank ? enemyTank.position : null;
  // 汇总敌方所有可见子弹（过载会同时存在 2 发）
  const enemyBullets = collectEnemyBullets(enemy);

  // 跨帧状态：检测敌方是否曾躲过我方刺杀子弹，本局据此禁用刺杀
  const state = getMatchState(game);
  recordAssassinOutcome(state, enemy, enemyTank, game);

  // 1. 异常状态拦截：如果处于眩晕或冰冻状态，无法操作，直接返回
  if (me.status && (me.status.stunned || me.status.frozen)) return;

  // 2. 常规子弹躲避：预判敌方子弹轨迹（含过载双弹），按子弹真实速度寻找来得及躲的相邻格

  // [fix] 1. 敌方是传送技能时，也不要进行暗杀findAssassinationPlan
  // [fix] 2.传送抢星星findStarTeleport时也要考虑敌方能在当前帧或未来几帧立即开火然后我躲避不了的情况
  // [fix] 3.moveToward需要优化一下，如果地方子弹正在射向我，我周围有墙，要找最快脱离的方向，不要一直转向->有墙->转回来->有子弹转向->有墙，这种循环，这块要考虑未来几帧的情况
  const dodge = findBulletDodge(me, enemy, game, enemyPos);
  if (dodge) {
    moveToward(me, game, dodge, enemyPos, enemyTank, enemyBullets);
    return;
  }

  // 3. 紧急传送躲避：常规移动无法躲避子弹时，尝试全图传送逃生
  const escapeTeleport = findEscapeTeleport(me, enemy, enemyTank, enemyBullets, game);
  if (escapeTeleport) {
    me.teleport(escapeTeleport[0], escapeTeleport[1]);
    return;
  }

  // 4. 防范敌方瞄准：如果敌方正瞄准自己且本帧能开火，提前移动躲避（防开火/预发射/守星预瞄）
  // https://agentank.ai/api/matches/mat_DuPt4ff7Ivt9Hy6Rf/agent.json 这一场很有意思，对方也是传送，比我会吃星星，我的防范敌方瞄准算法是否过于保守
  const aimDodge = findAimDodge(me, enemy, enemyTank, enemyBullets, game, enemyPos);
  if (aimDodge) {
    moveToward(me, game, aimDodge, enemyPos, enemyTank, enemyBullets);
    return;
  }

  // 6. 射击敌人：判断是否在同一直线上且无障碍物
  const shotDir = enemyPos ? clearShotDirection(myPos, enemyPos, game) : null;
  if (shotDir && canShoot(me, enemy)) {
    // 方向一致直接开火，否则先转向敌人
    if (me.tank.direction === shotDir) {
      me.fire();
    } else {
      turnToward(me, shotDir);
    }
    return;
  }

  // 9. 传送抢星：寻找星星附近最安全的格子进行传送抢分
  const starTeleport = findStarTeleport(me, enemy, enemyTank, enemyBullets, game);
  if (starTeleport) {
    me.teleport(starTeleport[0], starTeleport[1]);
    return;
  }

  // 8. 星星争夺预瞄：如果双方都在星星附近，提前将炮口对准星星方向迎击
  const starGuard = findContestedStarGuard(me, enemyTank, game);
  if (starGuard) {
    if (me.tank.direction !== starGuard.dir) {
      turnToward(me, starGuard.dir);
    }
    return;
  }

  // 7. 传送刺杀：寻找敌方附近的射击盲区进行传送突袭（严格模拟敌方反击，敌方反应过对刺杀则本局禁用）
  const assassination = findAssassinationPlan(me, enemy, enemyTank, enemyBullets, game, state);
  if (assassination) {
    // 传送后车头朝向不会变，所以如果当前朝向不对，先转向目标方向再传送
    if (me.tank.direction === assassination.dir) {
      // 记录本次刺杀，下一帧据此观察敌方是否躲开
      state.pendingAssassin = { targetPos: enemyPos.slice(), dir: assassination.dir, frame: (game && game.frames) || 0 };
      me.teleport(assassination.pos[0], assassination.pos[1]);
    } else {
      turnToward(me, assassination.dir);
    }
    return;
  }

  // 10. 战术走位：基于 BFS 寻路（优先星星 -> 射击轨道 -> 靠近敌人 -> 地图中心）
  // [fix] https://agentank.ai/api/matches/mat_JKcxMFuxEJEI519UG/agent.json 这一局对方是隐身，如果对方是隐身的时候 我们在战术走位chooseStep时要小心不要离他太近
  // [fix] https://agentank.ai/api/matches/mat_BznPx6Ce1Pp2cGJp8/agent.json 这一局同理，对方是超载，我们的战术走位也不能离太近
  // [fix] https://agentank.ai/api/matches/mat_8WDFMd9GpPyGb9s1O/agent.json 战术走位时要考虑后面几步能否躲过去地方的子弹速度
  const step = chooseStep(me, enemy, game, enemyPos);
  if (step) {
    moveToward(me, game, step, enemyPos, enemyTank, enemyBullets);
    return;
  }

  // 11. 破墙开路：面前有土块且子弹就绪，开火打碎土块
  const digDir = findDigDirection(myPos, game, game.star || enemyPos || nearestOpenToCenter(game));
  if (digDir && gunReady(me)) {
    if (me.tank.direction === digDir) {
      me.fire();
    } else {
      turnToward(me, digDir);
    }
    return;
  }

  // 12. 安全徘徊：如果无事可做，找一个最安全的格子走一步
  const safeStep = bestSafeNeighbor(myPos, game, enemyPos, enemyTank, enemyBullets);
  if (safeStep) {
    moveToward(me, game, safeStep, enemyPos, enemyTank, enemyBullets);
    return;
  }

  // 13. 原地转向：连安全的格子都没有时，原地向右转，避免卡死
  me.turn("right");
}

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

// ================= 跨帧状态（onIdle 每帧无状态调用，用模块级变量在帧间持久化） =================
let MATCH_STATE = null;

/**
 * 获取本局持久状态。靠帧数倒退判断新对局并重置。
 * - assassinBanned: 本局是否已禁用传送刺杀（敌方展示过躲刺杀子弹的反应）
 * - pendingAssassin: 最近一次传送刺杀的跟踪信息 { dir, targetPos, frame }
 */
function getMatchState(game) {
  const frame = (game && game.frames) || 0;
  if (!MATCH_STATE || frame < MATCH_STATE.lastFrame - 2) {
    MATCH_STATE = { lastFrame: frame, assassinBanned: false, pendingAssassin: null };
  }
  MATCH_STATE.lastFrame = frame;
  return MATCH_STATE;
}

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
  // 本局敌方已展示过躲刺杀子弹的反应 -> 全局禁用刺杀
  if (state && state.assassinBanned) return null;

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
 * 记录传送刺杀的结局：若上一帧刚发起刺杀，本帧观察敌人是否已移出我方瞄准线（成功躲开）。
 * 一旦发现敌人能反应过来躲刺杀子弹，本局后续禁用刺杀。
 */
function recordAssassinOutcome(state, enemy, enemyTank, game) {
  const pending = state.pendingAssassin;
  if (!pending) return;
  const frame = (game && game.frames) || 0;
  // 刺杀后给 1~3 帧观察窗口
  const elapsed = frame - pending.frame;
  if (elapsed < 1 || elapsed > 3) {
    if (elapsed > 3) state.pendingAssassin = null;
    return;
  }
  // 敌人仍可见且已离开原刺杀目标格 -> 视为成功躲开了我的刺杀，本局禁用刺杀
  if (enemyTank && enemyTank.position && !samePos(enemyTank.position, pending.targetPos)) {
    state.assassinBanned = true;
    state.pendingAssassin = null;
    return;
  }
  // 敌人隐身消失也按会反应处理（保守）
  if (!enemyTank) {
    state.assassinBanned = true;
    state.pendingAssassin = null;
  }
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
 * 寻找紧急逃生传送点。
 * 触发条件：传送就绪，且当前位置被任意敌方子弹威胁、或常规躲避来不及（隐身/过载场景由调用方先行判断）。
 * 落点要求：远离所有子弹弹道、远离敌人（避免传送后立刻被开火锁定或对射）。
 */
function findEscapeTeleport(me, enemy, enemyTank, enemyBullets, game) {
  if (!teleportReady(me)) return null;
  const myPos = me.tank.position;
  const threatened = anyBulletThreatens(enemyBullets, myPos, game);
  if (!threatened) return null;
  // 过载敌人弹道更密，逃生落点额外拉开距离
  const overloadEnemy = enemy && enemy.status && enemy.status.overloaded;
  return bestTeleportTile(myPos, enemyTank, enemyBullets, game, game.star, true, overloadEnemy ? 6 : 4);
}

/**
 * 寻找抢夺星星的传送点
 */
function findStarTeleport(me, enemy, enemyTank, enemyBullets, game) {
  if (!teleportReady(me) || !game.star) return null;
  const enemyPos = enemyTank ? enemyTank.position : null;
  const walkDist = pathDistance(me.tank.position, game.star, game, enemyPos);

  // 如果走路过去只要5步以内，就不浪费传送了
  if (walkDist >= 0 && walkDist <= 5) return null;

  // 丢失视野时，估算敌人老家位置，避开可能的危险区域传送
  if (!enemyTank) {
    const enemyGuess = estimateEnemyHome(me.tank.position, game);
    if (enemyGuess && manhattan(game.star, enemyGuess) <= ASSASSIN_MAX_RANGE) {
      return bestUnknownEnemyStarTeleport(me.tank.position, enemyGuess, enemyBullets, game);
    }
  }

  // 优先直接传送到星星上（但要排除"落地即被敌方开火打死、又躲不掉"的死亡陷阱）
  if (isTeleportSafe(game.star, enemyTank, enemyBullets, game, 0) &&
      !starLandingDeadly(game.star, me, enemyTank, enemy, game)) {
    return game.star;
  }

  // 星星上不安全则传送到星星附近最安全的点
  return bestTeleportTile(me.tank.position, enemyTank, enemyBullets, game, game.star, false, 0);
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
function bestTeleportTile(myPos, enemyTank, enemyBullets, game, target, preferDistance, minEnemyDist) {
  let best = null;
  let bestScore = -9999;
  for (let x = 0; x < game.map.length; x++) {
    for (let y = 0; y < game.map[x].length; y++) {
      const p = [x, y];
      if (samePos(p, myPos)) continue;
      if (!isTeleportSafe(p, enemyTank, enemyBullets, game, minEnemyDist || 0)) continue;

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
function isTeleportSafe(p, enemyTank, enemyBullets, game, minEnemyDist) {
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
  return true;
}

/**
 * 战术走位决策引擎
 */
function chooseStep(me, enemy, game, enemyPos) {
  const myPos = me.tank.position;
  
  // 1. 如果有星星，决定是否要去追星星
  if (game.star) {
    const starPath = shortestPathInfo(myPos, game.star, game, enemyPos);
    if (shouldChaseStar(myPos, enemyPos, game, starPath)) return starPath.step;
  }

  // 2. 如果看到敌人，尝试走位找射击轨道，或者靠近敌人
  if (enemyPos) {
    const laneStep = nextStepToFiringLane(myPos, enemyPos, game);
    if (laneStep) return laneStep;
    return nextStepNearEnemy(myPos, enemyPos, game);
  }

  // 3. 都没有的话，往地图中心走
  const center = nearestOpenToCenter(game);
  return center ? nextStepToward(myPos, center, game, null) : null;
}

/**
 * 判断是否值得放弃交战去追星星
 */
function shouldChaseStar(myPos, enemyPos, game, starPath) {
  if (!game.star || !starPath || starPath.dist < 0) return false;
  if (!enemyPos) return true; // 看不到敌人必追星星
  if (manhattan(myPos, game.star) <= 5) return true; // 星星很近就去吃
  
  const enemyDist = pathDistance(enemyPos, game.star, game, myPos);
  // 如果比敌人更近（或者差不多），就去抢
  return enemyDist < 0 || starPath.dist <= enemyDist + 2;
}

/**
 * BFS 寻找能打到敌人的射击轨道的下一步走位
 */
function nextStepToFiringLane(myPos, enemyPos, game) {
  return nextStepToGoal(myPos, game, enemyPos, function (p) {
    if (samePos(p, myPos)) return false;
    const d = manhattan(p, enemyPos);
    return d >= 2 && d <= 9 && !!clearShotDirection(p, enemyPos, game);
  });
}

/**
 * BFS 寻找靠近敌人的下一步走位
 */
function nextStepNearEnemy(myPos, enemyPos, game) {
  return nextStepToGoal(myPos, game, enemyPos, function (p) {
    const d = manhattan(p, enemyPos);
    return d >= 2 && d <= 4;
  });
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
 * 若无法在子弹到达前移开（来不及躲），返回 null，交由紧急传送处理。
 */
function findBulletDodge(me, enemy, game, enemyPos) {
  const myPos = me.tank.position;
  const bullets = collectEnemyBullets(enemy);
  if (bullets.length === 0) return null;

  // 没有任何子弹威胁到我，就不躲
  if (!anyBulletThreatens(bullets, myPos, game)) return null;

  // 最快多少帧子弹会命中我当前格
  const incomingFrames = minBulletFramesTo(bullets, myPos, game);
  if (incomingFrames < 0) return null;

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

    // 时间校验：当前朝向一致只需 1 帧(go)；否则要先转向(1帧)再走，需 2 帧。
    // 必须在子弹命中前完成移动（留 1 帧余量）。
    const needFrames = d.name === me.tank.direction ? 1 : 2;
    if (incomingFrames < needFrames) continue;

    // 打分：当前朝向就能走 > 远离边缘 > 靠近星星。确保确定性、抑制抖动。
    const facing = d.name === me.tank.direction ? 100 : 0;
    const score = facing + distanceFromEdges(p, game) + (game.star ? -manhattan(p, game.star) * 0.1 : 0);
    if (score > bestScore) {
      bestScore = score;
      best = p;
    }
  }
  return best;
}

/**
 * 防范敌方预瞄/预发射/守星：若敌人正瞄准我且本帧具备开火能力，提前移动脱离其炮线。
 *
 * 改进点：
 *  - 只在敌方"真能开火"（炮管就绪、未被开火锁定、无护盾限制无关）时才躲，避免对着不能开火的敌人空走。
 *  - 不再只试前方一格：四向择优选一个能脱离敌方炮线、且不撞进现有子弹弹道的格子。
 *  - 隐身敌人(enemyTank=null)交由其他逻辑处理，这里只针对可见敌人的预瞄。
 */
function findAimDodge(me, enemy, enemyTank, enemyBullets, game, enemyPos) {
  if (!enemyTank) return null;
  if (!enemyAimsAt(me.tank.position, enemyTank, game)) return null;
  // 敌人本帧无法开火（已有在途子弹且未过载，或被开火锁定）则预瞄无威胁，不必空躲
  if (!enemyCanFireSoon(enemy)) return null;

  const myPos = me.tank.position;
  let best = null;
  let bestScore = -9999;
  for (let i = 0; i < DIRS.length; i++) {
    const d = DIRS[i];
    const p = [myPos[0] + d.dx, myPos[1] + d.dy];
    if (!isPassable(game, p, enemyPos)) continue;
    if (enemyAimsAt(p, enemyTank, game)) continue; // 必须脱离炮线
    if (anyBulletThreatens(enemyBullets || [], p, game)) continue; // 别躲进现有弹道

    // 偏好当前朝向就能直接走的格子（1 帧脱离，最快）
    const facing = d.name === me.tank.direction ? 100 : 0;
    const score = facing + distanceFromEdges(p, game) + (game.star ? -manhattan(p, game.star) * 0.1 : 0);
    if (score > bestScore) {
      bestScore = score;
      best = p;
    }
  }
  return best;
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
    if (bullet.direction === "down" && dy > 0) return clearBetween(bp, pos, game) ? dy : -1;
    if (bullet.direction === "up" && dy < 0) return clearBetween(bp, pos, game) ? -dy : -1;
  }
  // 同一行：子弹左右飞
  if (bp[1] === pos[1]) {
    const dx = pos[0] - bp[0];
    if (bullet.direction === "right" && dx > 0) return clearBetween(bp, pos, game) ? dx : -1;
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
  return out;
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
 * 寻路移动助手。如果下一步不安全，就临时寻找一个安全的邻接格子
 */
function moveToward(me, game, next, enemyPos, enemyTank, enemyBullets) {
  const myPos = me.tank.position;

  // 危险校验：不通、被预瞄、会接子弹 -> 改走其他安全路径
  if (!isPassable(game, next, enemyPos) || enemyAimsAt(next, enemyTank, game) || anyBulletThreatens(enemyBullets || [], next, game)) {
    const safer = bestSafeNeighbor(myPos, game, enemyPos, enemyTank, enemyBullets);
    if (safer && !samePos(safer, next)) {
      moveToward(me, game, safer, enemyPos, enemyTank, enemyBullets);
      return;
    }
    // 无路可退，转向
    me.turn("right");
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
 */
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
function bestSafeNeighbor(pos, game, enemyPos, enemyTank, enemyBullets) {
  let best = null;
  let bestScore = -9999;
  for (let i = 0; i < DIRS.length; i++) {
    const p = [pos[0] + DIRS[i].dx, pos[1] + DIRS[i].dy];
    if (!isPassable(game, p, enemyPos)) continue;
    if (enemyAimsAt(p, enemyTank, game)) continue;
    if (anyBulletThreatens(enemyBullets || [], p, game)) continue;
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
