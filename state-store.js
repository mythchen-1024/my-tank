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
      enemyFleeFrames: 0
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

  // bush 意图在星星出现后立即作废：让 chooseStepScored 重新评估，优先抢星
  if (intent.kind === "bush" && game.star) {
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
  if (!isPassable(game, step, enemyPos) || enemyAimsAt(step, enemyTank, game) ||
      stepIntoBulletPath(bullets, step, game) ||
      (enemyPos && stepEntersKillZone(myPos, step, enemyPos, game, enemy, standoff))) {
    clearShortIntent(state);
    return null;
  }

  intent.stepsLeft -= 1;
  if (intent.stepsLeft <= 0) clearShortIntent(state);
  return { step };
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
  if (!enemyTank) {
    state.assassinBanned = true;
    state.pendingAssassin = null;
  }
}
