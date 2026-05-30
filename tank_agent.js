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
  // 获取敌方场上的子弹对象
  const enemyBullet = enemy && enemy.bullet ? enemy.bullet : null;

  // 1. 异常状态拦截：如果处于眩晕或冰冻状态，无法操作，直接返回
  if (me.status && (me.status.stunned || me.status.frozen)) return;

  // 2. 常规子弹躲避：预判敌方子弹轨迹，寻找安全的相邻格子
  const dodge = findBulletDodge(me, enemy, game, enemyPos);
  if (dodge) {
    moveToward(me, game, dodge, enemyPos, enemyTank, enemyBullet);
    return;
  }

  // 3. 紧急传送躲避：常规移动无法躲避子弹时，尝试全图传送逃生
  const escapeTeleport = findEscapeTeleport(me, enemyTank, enemyBullet, game);
  if (escapeTeleport) {
    me.teleport(escapeTeleport[0], escapeTeleport[1]);
    return;
  }

  // 4. 防范敌方瞄准：如果敌方正瞄准自己，提前移动躲避（防开火）
  const aimDodge = findAimDodge(me, enemyTank, game, enemyPos);
  if (aimDodge) {
    moveToward(me, game, aimDodge, enemyPos, enemyTank, enemyBullet);
    return;
  }

  // 5. 施放毒药技能：条件允许时对敌人下毒
  if (shouldPoison(me, enemy, enemyPos, game)) {
    me.poison();
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

  // 7. 传送刺杀：寻找敌方附近的射击盲区进行传送突袭
  const assassination = findAssassinationPlan(me, enemy, enemyTank, enemyBullet, game);
  if (assassination) {
    // 传送后车头朝向不会变，所以如果当前朝向不对，先转向目标方向再传送
    if (me.tank.direction === assassination.dir) {
      me.teleport(assassination.pos[0], assassination.pos[1]);
    } else {
      turnToward(me, assassination.dir);
    }
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

  // 9. 传送抢星：寻找星星附近最安全的格子进行传送抢分
  const starTeleport = findStarTeleport(me, enemyTank, enemyBullet, game);
  if (starTeleport) {
    me.teleport(starTeleport[0], starTeleport[1]);
    return;
  }

  // 10. 战术走位：基于 BFS 寻路（优先星星 -> 射击轨道 -> 靠近敌人 -> 地图中心）
  const step = chooseStep(me, enemy, game, enemyPos);
  if (step) {
    moveToward(me, game, step, enemyPos, enemyTank, enemyBullet);
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
  const safeStep = bestSafeNeighbor(myPos, game, enemyPos, enemyTank, enemyBullet);
  if (safeStep) {
    moveToward(me, game, safeStep, enemyPos, enemyTank, enemyBullet);
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
// 刺杀传送的最小与最大距离
const ASSASSIN_MIN_RANGE = 5;
const ASSASSIN_MAX_RANGE = 8;

// ================= 辅助函数 =================

/**
 * 判断是否应该施放毒药技能
 */
function shouldPoison(me, enemy, enemyPos, game) {
  // 必须有毒药技能、看到敌人、技能不在冷却中
  if (!me.poison || !enemyPos || !me.skill || me.skill.remainingCooldownFrames !== 0) return false;
  // 敌人不能已经被毒了
  if (enemy.status && enemy.status.poisoned) return false;
  
  const d = manhattan(me.tank.position, enemyPos);
  // 距离在 5 以内直接毒
  if (d <= 5) return true;
  // 距离在 8 以内，且在同一直线上（无遮挡）也毒
  return d <= 8 && !!clearShotDirection(me.tank.position, enemyPos, game);
}

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
 * 寻找最佳传送刺杀方案
 * 返回 { pos: [x, y], dir: "方向" }
 */
function findAssassinationPlan(me, enemy, enemyTank, enemyBullet, game) {
  if (!enemyTank || !teleportReady(me) || !canShoot(me, enemy)) return null;
  // 敌人隐身或有护盾则不刺杀
  if (enemy.status && (enemy.status.cloaked || enemy.status.shielded)) return null;
  
  const enemyPos = enemyTank.position;
  let best = null;
  let bestScore = -9999;

  // 遍历所有方向和攻击距离，寻找最佳落点
  for (let i = 0; i < DIRS.length; i++) {
    const dir = DIRS[i];
    for (let range = ASSASSIN_MIN_RANGE; range <= ASSASSIN_MAX_RANGE; range++) {
      const p = [enemyPos[0] - dir.dx * range, enemyPos[1] - dir.dy * range];
      if (samePos(p, me.tank.position)) continue; // 排除当前位置
      if (!isAssassinTile(p, dir.name, enemyTank, enemyBullet, game)) continue;
      
      // 打分模型：转向代价越小越好，距离越近越好，靠近地图中心更好
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
 * 判断一个坐标是否适合作为刺杀传送落点
 */
function isAssassinTile(p, dir, enemyTank, enemyBullet, game) {
  if (!isTeleportSafe(p, enemyTank, enemyBullet, game, false)) return false; // 必须安全
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
 * 寻找紧急逃生传送点
 */
function findEscapeTeleport(me, enemyTank, enemyBullet, game) {
  // 传送未就绪或未受子弹威胁则不需要逃生
  if (!teleportReady(me) || !bulletThreatens(enemyBullet, me.tank.position, game)) return null;
  return bestTeleportTile(me.tank.position, enemyTank, enemyBullet, game, game.star, true);
}

/**
 * 寻找抢夺星星的传送点
 */
function findStarTeleport(me, enemyTank, enemyBullet, game) {
  if (!teleportReady(me) || !game.star) return null;
  const enemyPos = enemyTank ? enemyTank.position : null;
  const walkDist = pathDistance(me.tank.position, game.star, game, enemyPos);
  
  // 如果走路过去只要5步以内，就不浪费传送了
  if (walkDist >= 0 && walkDist <= 5) return null;
  
  // 丢失视野时，估算敌人老家位置，避开可能的危险区域传送
  if (!enemyTank) {
    const enemyGuess = estimateEnemyHome(me.tank.position, game);
    if (enemyGuess && manhattan(game.star, enemyGuess) <= ASSASSIN_MAX_RANGE) {
      return bestUnknownEnemyStarTeleport(me.tank.position, enemyGuess, enemyBullet, game);
    }
  }
  
  // 优先直接传送到星星上
  if (isTeleportSafe(game.star, enemyTank, enemyBullet, game, false)) return game.star;
  
  // 星星上不安全则传送到星星附近最安全的点
  return bestTeleportTile(me.tank.position, enemyTank, enemyBullet, game, game.star, false);
}

/**
 * 在丢失敌人视野时，寻找安全的星星传送点
 */
function bestUnknownEnemyStarTeleport(myPos, enemyGuess, enemyBullet, game) {
  let best = null;
  let bestScore = -9999;
  for (let x = 0; x < game.map.length; x++) {
    for (let y = 0; y < game.map[x].length; y++) {
      const p = [x, y];
      if (samePos(p, myPos)) continue;
      if (!isPassable(game, p, null)) continue; // 不能是墙或土块
      if (bulletThreatens(enemyBullet, p, game)) continue; // 不能在子弹轨迹上
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
 */
function bestTeleportTile(myPos, enemyTank, enemyBullet, game, target, preferDistance) {
  let best = null;
  let bestScore = -9999;
  for (let x = 0; x < game.map.length; x++) {
    for (let y = 0; y < game.map[x].length; y++) {
      const p = [x, y];
      if (samePos(p, myPos)) continue;
      if (!isTeleportSafe(p, enemyTank, enemyBullet, game, preferDistance)) continue;
      
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
 */
function isTeleportSafe(p, enemyTank, enemyBullet, game, preferDistance) {
  const enemyPos = enemyTank ? enemyTank.position : null;
  if (!isPassable(game, p, enemyPos)) return false;
  if (enemyBullet && samePos(p, enemyBullet.position)) return false;
  if (enemyAimsAt(p, enemyTank, game)) return false;
  if (bulletThreatens(enemyBullet, p, game)) return false;
  // 偏好拉开距离时，避免落点在敌人脸前（曼哈顿距离<=4会被开火锁定）
  if (preferDistance && enemyPos && manhattan(p, enemyPos) <= 4) return false;
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
 * 寻找躲避子弹的安全邻近格子
 */
function findBulletDodge(me, enemy, game, enemyPos) {
  if (!enemy || !enemy.bullet) return null;
  const myPos = me.tank.position;
  const b = enemy.bullet;
  
  // 如果子弹没有威胁到我，就不躲
  if (!bulletThreatens(b, myPos, game)) return null;

  // 垂直子弹往左右躲，水平子弹往上下躲
  const candidates = [];
  if (b.direction === "left" || b.direction === "right") {
    candidates.push([myPos[0], myPos[1] - 1], [myPos[0], myPos[1] + 1]);
  } else {
    candidates.push([myPos[0] - 1, myPos[1]], [myPos[0] + 1, myPos[1]]);
  }

  let best = null;
  let bestScore = -9999;
  
  for (let i = 0; i < candidates.length; i++) {
    const p = candidates[i];
    if (!isPassable(game, p, enemyPos)) continue;
    if (bulletThreatens(b, p, game)) continue; // 躲避点不能也吃子弹
    if (enemyAimsAt(p, enemy && enemy.tank, game)) continue; // 躲避点不能刚好被敌人预瞄
    
    const stepDir = directionBetween(myPos, p);
    // 偏好无需转向的方向、远离边缘的方向、靠近星星的方向
    const score = distanceFromEdges(p, game) + (stepDir === me.tank.direction ? 10 : 0) + (game.star ? -manhattan(p, game.star) * 0.1 : 0);
    if (score > bestScore) {
      bestScore = score;
      best = p;
    }
  }
  return best;
}

/**
 * 防范敌方预瞄：若敌人正在瞄准我，尝试横向移动避开
 */
function findAimDodge(me, enemyTank, game, enemyPos) {
  if (!enemyAimsAt(me.tank.position, enemyTank, game)) return null;
  const myPos = me.tank.position;
  
  // 试探前方一格是否安全（不被继续瞄准）
  const ahead = nextInDirection(myPos, me.tank.direction);
  if (isPassable(game, ahead, enemyPos) && !enemyAimsAt(ahead, enemyTank, game)) return ahead;
  
  return null;
}

/**
 * 判断指定坐标是否受到给定子弹的威胁
 */
function bulletThreatens(bullet, pos, game) {
  if (!bullet || !bullet.position) return false;
  const bp = bullet.position;
  
  // 在同一列且子弹朝下/朝上
  if (bp[0] === pos[0]) {
    const dy = pos[1] - bp[1];
    if (bullet.direction === "down" && dy > 0 && dy <= BULLET_LOOKAHEAD_TILES) return clearBetween(bp, pos, game);
    if (bullet.direction === "up" && dy < 0 && -dy <= BULLET_LOOKAHEAD_TILES) return clearBetween(bp, pos, game);
  }
  // 在同一行且子弹朝右/朝左
  if (bp[1] === pos[1]) {
    const dx = pos[0] - bp[0];
    if (bullet.direction === "right" && dx > 0 && dx <= BULLET_LOOKAHEAD_TILES) return clearBetween(bp, pos, game);
    if (bullet.direction === "left" && dx < 0 && -dx <= BULLET_LOOKAHEAD_TILES) return clearBetween(bp, pos, game);
  }
  return false;
}

/**
 * 寻路移动助手。如果下一步不安全，就临时寻找一个安全的邻接格子
 */
function moveToward(me, game, next, enemyPos, enemyTank, enemyBullet) {
  const myPos = me.tank.position;
  
  // 危险校验：不通、被预瞄、会接子弹 -> 改走其他安全路径
  if (!isPassable(game, next, enemyPos) || enemyAimsAt(next, enemyTank, game) || bulletThreatens(enemyBullet, next, game)) {
    const safer = bestSafeNeighbor(myPos, game, enemyPos, enemyTank, enemyBullet);
    if (safer && !samePos(safer, next)) {
      moveToward(me, game, safer, enemyPos, enemyTank, enemyBullet);
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
function bestSafeNeighbor(pos, game, enemyPos, enemyTank, enemyBullet) {
  let best = null;
  let bestScore = -9999;
  for (let i = 0; i < DIRS.length; i++) {
    const p = [pos[0] + DIRS[i].dx, pos[1] + DIRS[i].dy];
    if (!isPassable(game, p, enemyPos)) continue;
    if (enemyAimsAt(p, enemyTank, game)) continue;
    if (bulletThreatens(enemyBullet, p, game)) continue;
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
