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
  trackEnemy(state, enemyTank, game);
  trackStuck(state, myPos);

  // 1. 异常状态拦截：如果处于眩晕或冰冻状态，无法操作，直接返回
  if (me.status && (me.status.stunned || me.status.frozen)) return;

  // 2. 常规子弹躲避：预判敌方子弹轨迹（含过载双弹），按子弹真实速度寻找来得及躲的相邻格
  const dodge = findBulletDodge(me, enemy, game, enemyPos);
  if (dodge) {
    // 对射先射后走：来袭子弹下、我与敌同线且炮口对准、开火后仍来得及躲，则先回敬一炮再躲（化被动为压制）
    if (shouldCounterShootThenDodge(me, enemy, enemyTank, enemyBullets, game, enemyPos)) {
      me.fire();
      return;
    }
    moveToward(me, game, dodge, enemyPos, enemyTank, enemyBullets);
    return;
  }

  // 3. 紧急传送躲避：常规移动无法躲避子弹时，尝试全图传送逃生
  const escapeTeleport = findEscapeTeleport(me, enemy, enemyTank, enemyBullets, game);
  if (escapeTeleport) {
    me.teleport(escapeTeleport[0], escapeTeleport[1]);
    return;
  }

  // 3.5 绝境横移：被子弹威胁、又躲不掉也传送不了时，至少朝垂直方向挣一步脱离弹道，
  //     绝不顺着子弹方向逃（顺向必被 2 格/帧的子弹追上，见 mat_DXZ）。
  const desperate = findDesperateDodge(me, enemyBullets, game, enemyPos, enemyTank);
  if (desperate) {
    moveToward(me, game, desperate, enemyPos, enemyTank, enemyBullets);
    return;
  }

  // 4. 防范敌方瞄准：如果敌方正瞄准自己且本帧能开火，提前移动躲避（防开火/预发射/守星预瞄）
  const aimDodge = findAimDodge(me, enemy, enemyTank, enemyBullets, game, enemyPos);
  if (aimDodge) {
    moveToward(me, game, aimDodge, enemyPos, enemyTank, enemyBullets);
    return;
  }

  // 5. 近距对射规避：敌人与我同线且距离近、能开火，若转身对射我不占先手，则侧移离线（不站着转身送死）
  const lineDodge = findLineDuelDodge(me, enemy, enemyTank, enemyBullets, game, enemyPos);
  if (lineDodge) {
    moveToward(me, game, lineDodge, enemyPos, enemyTank, enemyBullets);
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

  // 6.5 以守为攻：敌人近距(<=3)正逼近、即将进入我的同行/同列枪线时，提前把炮口对准那条线（守株待兔）。
  //     躲避优先（已在上方处理实弹来袭），这里只在无实弹威胁时主动备战，避免被动逃到墙角挨打。
  const guardShot = findGuardLineShot(me, enemy, enemyTank, enemyBullets, game, enemyPos);
  if (guardShot) {
    if (guardShot.fire) me.fire();
    else turnToward(me, guardShot.dir);
    return;
  }

  // 9. 传送抢星：寻找星星附近最安全的格子进行传送抢分
  // 隐身守星陷阱：敌有隐身且此刻隐身、其最后位置正卡住星星射线时，冲过去抢星=送死，改为侧向守位等待
  if (!inCloakStarTrap(me, enemy, enemyTank, game, state)) {
    const starTeleport = findStarTeleport(me, enemy, enemyTank, enemyBullets, game);
    if (starTeleport) {
      me.teleport(starTeleport[0], starTeleport[1]);
      return;
    }
  } else {
    const guard = cloakStarGuardStep(me, game, state);
    if (guard) {
      moveToward(me, game, guard, enemyPos, enemyTank, enemyBullets);
      return;
    }
    return; // 守位已最优：原地不动等敌现身/星消失，避免步入陷阱
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
  // 安全站位：对过载/隐身敌人保持更大间距，且只走"走过去后仍能躲开敌方子弹"的格子
  const step = chooseStep(me, enemy, game, enemyPos, state);
  if (step) {
    // 防靠墙空转：已连续多帧原地未动时，强制打破死循环——朝向可直接走就走，否则确定性转向一个可通行安全方向
    if (state.stuckFrames >= 2) {
      breakStuckStep(me, game, enemyPos, enemyTank, enemyBullets);
      return;
    }
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
 * - lastEnemyPos / lastEnemySeenFrame: 敌人最后一次可见的位置与帧（隐身后据此避让）
 */
function getMatchState(game) {
  const frame = (game && game.frames) || 0;
  if (!MATCH_STATE || frame < MATCH_STATE.lastFrame - 2) {
    MATCH_STATE = { lastFrame: frame, assassinBanned: false, pendingAssassin: null, lastEnemyPos: null, lastEnemySeenFrame: -999, lastMyPos: null, stuckFrames: 0 };
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
    state.stuckFrames = 0;
  }
  state.lastMyPos = myPos.slice();
}

/**
 * 更新敌人最后可见位置：可见则刷新；不可见(隐身/草丛)则保留旧值供避让。
 */
function trackEnemy(state, enemyTank, game) {
  if (enemyTank && enemyTank.position) {
    state.lastEnemyPos = enemyTank.position.slice();
    state.lastEnemySeenFrame = (game && game.frames) || 0;
  }
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
  if (!threatened && !overloadAmbush) return null;
  // 过载敌人弹道更密，逃生落点额外拉开距离
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
 * 战术走位决策引擎。
 * 安全站位核心：根据敌方威胁动态决定与敌人的"最小安全间距"，避免走进会被秒的近身死区；
 * 隐身敌人按最后已知位置避让；逼近敌人时停在能开火又留有躲弹余地的距离。
 */
function chooseStep(me, enemy, game, enemyPos, state) {
  const myPos = me.tank.position;
  const standoff = safeStandoffDistance(enemy);

  // 1. 如果有星星，决定是否要去追星星（但追星的下一步不能撞进敌人近距死区/过载炮线）
  if (game.star) {
    const starPath = shortestPathInfo(myPos, game.star, game, enemyPos);
    if (shouldChaseStar(myPos, enemyPos, game, starPath) && starPath.step) {
      if (!enemyPos || !stepEntersKillZone(myPos, starPath.step, enemyPos, game, enemy, standoff)) {
        return starPath.step;
      }
      // 追星会撞进死区：放弃这一步，转入安全站位逻辑（下方）重新决策
    }
  }

  // 2. 看得见敌人：走位找射击轨道(但不进死区)，否则保持安全间距，不再无脑贴近
  if (enemyPos) {
    const laneStep = nextStepToFiringLane(myPos, enemyPos, game, standoff);
    if (laneStep && !stepEntersKillZone(myPos, laneStep, enemyPos, game, enemy, standoff)) return laneStep;
    // 维持安全站位：太近则后撤到 standoff 环，太远才靠近
    return nextStepToStandoff(myPos, enemyPos, game, standoff, enemy);
  }

  // 3. 看不见敌人(隐身/草丛)：若最近见过，避开其最后已知位置周边的危险区
  if (state && state.lastEnemyPos && (game.frames || 0) - state.lastEnemySeenFrame <= 8) {
    const avoidStep = nextStepAvoiding(myPos, state.lastEnemyPos, game, standoff + 1);
    if (avoidStep) return avoidStep;
  }

  // 4. 都没有的话，往地图中心走
  const center = nearestOpenToCenter(game);
  return center ? nextStepToward(myPos, center, game, null) : null;
}

/**
 * 与敌人的最小安全间距：过载敌人双弹难躲，需拉到 6 格外；隐身/普通敌人 5 格；
 * 5 格是子弹约 3 帧到达的距离，配合横移刚好够躲。
 */
function safeStandoffDistance(enemy) {
  if (enemy && enemy.status && enemy.status.overloaded) return 6;
  if (enemy && enemy.skill && enemy.skill.type === "cloak") return 5;
  return 4;
}

/**
 * 判断走到 next 后是否进入"会被秒的死区"。
 * 子弹 2 格/帧 + 我转向 1 帧：3 格内只要需要转向就躲不掉，故普通敌人 d<=3 即死区。
 * 过载敌人一帧双弹更难躲：d<=4、或在其同行/同列 standoff 内且无横向脱离，都算死区。
 */
function stepEntersKillZone(myPos, next, enemyPos, game, enemy, standoff) {
  const d = manhattan(next, enemyPos);
  const overloaded = enemy && enemy.status && enemy.status.overloaded;
  // 普通敌人：贴近 3 格内即死区（转向就被追上）
  if (d <= 3) return true;
  // 过载敌人：4 格内一律死区
  if (overloaded && d <= 4) return true;
  // 过载敌人：进入 standoff 内且与之同行/同列(可被直接命中)且无横向脱离 -> 死区
  if (overloaded && d < standoff) {
    if (enemyPos[0] === next[0] || enemyPos[1] === next[1]) {
      if (!hasLateralEscapeAt(next, enemyPos, game)) return true;
    }
  }
  return false;
}

/**
 * next 是否有垂直于"敌->next 连线"的可走脱离格（用于评估走过去后还能不能躲弹）。
 */
function hasLateralEscapeAt(next, enemyPos, game) {
  const horizontal = enemyPos[1] === next[1]; // 同行 -> 子弹水平来 -> 需上下脱离
  const dirs = horizontal
    ? [{ dx: 0, dy: -1 }, { dx: 0, dy: 1 }]
    : [{ dx: -1, dy: 0 }, { dx: 1, dy: 0 }];
  for (let i = 0; i < dirs.length; i++) {
    const q = [next[0] + dirs[i].dx, next[1] + dirs[i].dy];
    if (isPassable(game, q, enemyPos)) return true;
  }
  return false;
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
 * BFS 寻找能打到敌人的射击轨道的下一步走位（不进入比 standoff 更近的死区）
 */
function nextStepToFiringLane(myPos, enemyPos, game, standoff) {
  const minD = Math.max(3, standoff - 1); // 轨道点不能比安全站位近太多
  return nextStepToGoal(myPos, game, enemyPos, function (p) {
    if (samePos(p, myPos)) return false;
    const d = manhattan(p, enemyPos);
    return d >= minD && d <= 9 && !!clearShotDirection(p, enemyPos, game);
  });
}

/**
 * 维持安全站位：当前离敌人比 standoff 近则后撤，远则靠近到 standoff 环附近。
 */
function nextStepToStandoff(myPos, enemyPos, game, standoff, enemy) {
  const curD = manhattan(myPos, enemyPos);
  // 已在安全环带内(standoff..standoff+2)，原地附近找能瞄到敌人的格，不主动贴近
  if (curD >= standoff && curD <= standoff + 2) {
    return nextStepToFiringLane(myPos, enemyPos, game, standoff);
  }
  if (curD < standoff) {
    // 太近 -> 朝远离敌人的可走方向后撤一步
    return stepAwayFromEnemy(myPos, enemyPos, game);
  }
  // 太远 -> 逼近到 standoff 环
  return nextStepToGoal(myPos, game, enemyPos, function (p) {
    const d = manhattan(p, enemyPos);
    return d >= standoff && d <= standoff + 1;
  });
}

/**
 * 选一个远离敌人、且不撞进敌方炮线的相邻后撤格。
 */
function stepAwayFromEnemy(myPos, enemyPos, game) {
  let best = null;
  let bestScore = -9999;
  for (let i = 0; i < DIRS.length; i++) {
    const p = [myPos[0] + DIRS[i].dx, myPos[1] + DIRS[i].dy];
    if (!isPassable(game, p, enemyPos)) continue;
    const score = manhattan(p, enemyPos) + distanceFromEdges(p, game) * 0.5;
    if (score > bestScore) {
      bestScore = score;
      best = p;
    }
  }
  return best;
}

/**
 * 朝远离某危险点(如隐身敌人最后位置)的方向走一步，保持至少 minDist 间距。
 */
function nextStepAvoiding(myPos, dangerPos, game, minDist) {
  if (manhattan(myPos, dangerPos) >= minDist + 2) return null; // 已经够远，不必特意避让
  return stepAwayFromEnemy(myPos, dangerPos, game);
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

  // 最快多少帧子弹会命中我当前格
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

    // 时序校验：朝向即脱离方向本帧 go 离格(needFrames=1, incoming>=1即可)；
    // 需转向则本帧不动、下帧才走，要求 incoming>=3 才不会在转向帧被命中。
    const needTurn = d.name !== me.tank.direction;
    if (needTurn) {
      if (incomingFrames < 3) continue;
    } else {
      if (incomingFrames < 1) continue;
    }

    // 打分：当前朝向就能走 > 远离边缘 > 靠近星星。确保确定性、抑制抖动。
    const facing = needTurn ? 0 : 100;
    const score = facing + distanceFromEdges(p, game) + (game.star ? -manhattan(p, game.star) * 0.1 : 0);
    if (score > bestScore) {
      bestScore = score;
      best = p;
    }
  }
  return best;
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
 * 对射"先射后走"判定：在子弹来袭、findBulletDodge 已确认本帧有躲位的前提下，
 * 若满足以下条件，则先回敬一炮再躲（下一帧子弹更近但仍可躲）：
 *  - 炮管就绪、敌人未开盾、我与敌人同线且视线无遮挡、车头已对准敌人（开火不耗转向帧）；
 *  - 来袭子弹至少 2 帧后才命中我当前格（开火占本帧，留下一帧躲避）；
 *  - 开火后下一帧子弹推进 BULLET_SPEED 格，我仍能找到脱离弹道的相邻格。
 * 化纯被动逃跑为压制对射（见 mat_DtH4：全程只躲不还手被压死）。
 */
function shouldCounterShootThenDodge(me, enemy, enemyTank, enemyBullets, game, enemyPos) {
  if (!enemyTank || !enemyPos) return false;
  if (!canShoot(me, enemy)) return false; // 炮管就绪 + 敌未开盾
  // 必须车头已对准敌人（开火不耗转向帧），否则先躲
  const shotDir = clearShotDirection(me.tank.position, enemyPos, game);
  if (!shotDir || shotDir !== me.tank.direction) return false;

  const bullets = enemyBullets || [];
  const incoming = minBulletFramesTo(bullets, me.tank.position, game);
  if (incoming < 2) return false; // 来不及"开火再躲"，老实躲

  // 预演：开火后下一帧，子弹各推进 BULLET_SPEED 格，检查我是否仍有脱离弹道的相邻格
  const advanced = advanceBullets(bullets, BULLET_SPEED);
  const myPos = me.tank.position;
  for (let i = 0; i < DIRS.length; i++) {
    const p = [myPos[0] + DIRS[i].dx, myPos[1] + DIRS[i].dy];
    if (!isPassable(game, p, enemyPos)) continue;
    if (anyBulletThreatens(advanced, p, game)) continue;
    if (enemyAimsAt(p, enemyTank, game)) continue;
    return true; // 开火后下一帧仍有活路 -> 值得先射一发
  }
  return false;
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
  // 过载敌人随时能补弹，威胁高，不豁免
  if (enemy && enemy.status && enemy.status.overloaded) return false;

  const myPos = me.tank.position;
  const enemyPos = enemyTank.position;
  const myToStar = pathDistance(myPos, game.star, game, enemyPos);
  if (myToStar < 0 || myToStar > 4) return false; // 星不够近就老实防瞄

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

  // 我严格更快命中 -> 对射占优，不躲，交给后续开火分支
  if (myDuel < enemyDuel) return null;

  // 以守为攻：敌人此刻并未瞄准我（炮口不朝我，无实弹在途），且我对射不慢于它(myDuel<=enemyDuel) ->
  // 不必侧移逃避，交给开火/守线分支先手压制（敌没瞄我时侧移只是浪费先手，见 mat_AZpe 被压到墙角）。
  const enemyAimingMe = enemyAimsAt(myPos, enemyTank, game);
  const enemyHasBullet = enemy && enemy.bullet && enemy.bullet.position;
  if (!enemyAimingMe && !enemyHasBullet && myDuel <= enemyDuel) return null;

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
    // 偏好当前朝向就能直接走的方向（1 帧脱离），其次远离敌人、远离边缘
    const facing = d.name === me.tank.direction ? 100 : 0;
    const score = facing + manhattan(p, enemyPos) + distanceFromEdges(p, game) * 0.5;
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
function findGuardLineShot(me, enemy, enemyTank, enemyBullets, game, enemyPos) {
  if (!enemyTank || !enemyPos) return null;
  if (!canShoot(me, enemy)) return null;                 // 炮管就绪 + 敌未开盾
  if (enemy.status && enemy.status.overloaded) return null; // 过载敌人近距太危险，交给躲避/拉距离，不站着对枪
  if (anyBulletThreatens(enemyBullets || [], me.tank.position, game)) return null; // 有实弹来袭 -> 让躲避先处理
  if (manhattan(me.tank.position, enemyPos) > 3) return null;

  const myPos = me.tank.position;
  // 已在同行/同列且视线清晰：能打就打/对准
  const lineDir = clearShotDirection(myPos, enemyPos, game);
  if (lineDir) {
    if (me.tank.direction === lineDir) return { fire: true };
    return { dir: lineDir };
  }

  // 尚未同线：敌人很近(<=3)，预判它将从哪条轴进入我的枪线，提前转炮口对准那个轴向。
  const dx = enemyPos[0] - myPos[0];
  const dy = enemyPos[1] - myPos[1];
  // 选“垂直偏移更小”的轴：敌人更快能与我对齐的方向
  if (Math.abs(dx) <= Math.abs(dy)) {
    // 敌人横向几乎对齐(dx 小) -> 它会进入我的竖直线(同列)，朝它的上/下方向预瞄
    const dir = dy < 0 ? "up" : "down";
    if (me.tank.direction !== dir) return { dir: dir };
  } else {
    const dir = dx < 0 ? "left" : "right";
    if (me.tank.direction !== dir) return { dir: dir };
  }
  return null;
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
 * 寻路移动助手。如果下一步不安全，就改走最快脱离的安全方向（避免转向→撞墙→转回的死循环）。
 */
function moveToward(me, game, next, enemyPos, enemyTank, enemyBullets) {
  const myPos = me.tank.position;
  const bullets = enemyBullets || [];

  // 危险校验：不通、被预瞄、会接子弹 -> 改用最快脱离逻辑（考虑未来几帧的转向/前进耗时）
  if (!isPassable(game, next, enemyPos) || enemyAimsAt(next, enemyTank, game) || anyBulletThreatens(bullets, next, game)) {
    const escape = fastestEscapeNeighbor(me, game, enemyPos, enemyTank, bullets);
    if (escape) {
      const edir = directionBetween(myPos, escape);
      // 当前朝向即脱离方向 -> 立刻前进（不浪费一帧转向）；否则转向它
      if (edir === me.tank.direction) me.go();
      else turnToward(me, edir);
      return;
    }
    // 实在没有更优安全格：保持朝向直走（若前方可走）打破"原地转向"死循环，否则才转向
    const ahead = nextInDirection(myPos, me.tank.direction);
    if (isPassable(game, ahead, enemyPos)) me.go();
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
function breakStuckStep(me, game, enemyPos, enemyTank, enemyBullets) {
  const myPos = me.tank.position;
  const bullets = enemyBullets || [];
  const safe = (p) => isPassable(game, p, enemyPos) && !enemyAimsAt(p, enemyTank, game) && !anyBulletThreatens(bullets, p, game);

  // 当前朝向可直接走且安全 -> 立刻前进
  const ahead = nextInDirection(myPos, me.tank.direction);
  if (safe(ahead)) { me.go(); return; }

  // 否则按固定顺序找第一个可走且安全的方向转过去（确定性，避免再次左右横跳）
  let fallback = null;
  for (let i = 0; i < DIRS.length; i++) {
    const p = [myPos[0] + DIRS[i].dx, myPos[1] + DIRS[i].dy];
    if (!isPassable(game, p, enemyPos)) continue;
    if (fallback === null) fallback = DIRS[i].name; // 记一个纯可通行方向兜底
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
function fastestEscapeNeighbor(me, game, enemyPos, enemyTank, bullets) {
  const myPos = me.tank.position;
  let best = null;
  let bestCost = 99;
  let bestTie = -9999;
  for (let i = 0; i < DIRS.length; i++) {
    const d = DIRS[i];
    const p = [myPos[0] + d.dx, myPos[1] + d.dy];
    if (!isPassable(game, p, enemyPos)) continue;
    if (anyBulletThreatens(bullets, p, game)) continue; // 脱离格不能仍在弹道上
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
