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
      lastChosenType: null,
      phantomBullets: [],
      myBombs: [],
      // ── 草丛热力图 ──
      bushHeatmap: {},          // key(pos) → { score, lastFrame, source }
      bushBulletSeen: false,    // 上帧是否有敌弹可见
      bushCamperStats: {        // 蹲草流统计
        teleportIntoBush: 0,
        walkIntoBush: 0,
        fireFromBush: 0,
        bushStationaryFrames: 0,
        lastTeleportIntoBushFrame: -999,
      },
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
    var prevPos = state.lastEnemyPos;
    state.lastEnemyPos = enemyTank.position.slice();
    state.lastEnemySeenFrame = (game && game.frames) || 0;
    if (prevPos && samePos(prevPos, enemyTank.position)) {
      state.enemyStationaryFrames = (state.enemyStationaryFrames || 0) + 1;
    } else {
      state.enemyStationaryFrames = 0;
    }
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


/**
 * 追踪敌方草丛位置热力图。三种收集途径：
 *   1. 走进草丛：上帧可见 + 本帧不可见 + lastEnemyPos 在/邻近 "o" tile
 *   2. 传送进草丛：本帧可见 + 在 "o" tile + 位置跳变 > 1（系统强制显示一帧）
 *   3. 草丛开炮：新子弹出现 + 敌不可见 → 反向回溯弹道找 "o" tile
 *
 * 热力图每帧衰减 score -= 2，score <= 0 时删除。
 */
function trackEnemyBush(state, enemyTank, enemy, game) {
  if (!game || !game.map) return;
  var frame = (game && game.frames) || 0;
  var hm = state.bushHeatmap;
  var stats = state.bushCamperStats;

  // ── 敌方出草重置：可见且不在草丛 → 清空热力图 ──
  if (enemyTank && enemyTank.position && tileAt(game, enemyTank.position) !== "o") {
    for (var k in hm) {
      if (hm.hasOwnProperty(k)) delete hm[k];
    }
    stats.bushStationaryFrames = 0;
    // 更新子弹可见标记，防止下次进草时误判已有老弹为"草丛新开炮"
    state.bushBulletSeen = !!(enemy && enemy.bullet && enemy.bullet.position);
    return;
  }

  // ── 衰减所有条目 ──
  for (var k in hm) {
    if (hm.hasOwnProperty(k)) {
      hm[k].score -= 2;
      if (hm[k].score <= 0) delete hm[k];
    }
  }

  // ── 途径 1：走进草丛 ──
  // 上帧可见（lastEnemyPos 有值且 lastEnemySeenFrame 是上一帧），本帧不可见
  if (!enemyTank && state.lastEnemyPos && state.lastEnemySeenFrame >= frame - 1) {
    var lp = state.lastEnemyPos;
    if (tileAt(game, lp) === "o") {
      _bushHeatAdd(hm, lp, 80, frame, 'walk');
      stats.walkIntoBush++;
    } else {
      // 相邻格有草丛：敌人走一步就进了草
      var adjFound = false;
      for (var i = 0; i < DIRS.length; i++) {
        var adj = [lp[0] + DIRS[i].dx, lp[1] + DIRS[i].dy];
        if (tileAt(game, adj) === "o") {
          _bushHeatAdd(hm, adj, 60, frame, 'walk');
          adjFound = true;
        }
      }
      if (adjFound) stats.walkIntoBush++;
    }
  }

  // ── 途径 2：传送进草丛 ──
  // 本帧可见 + 在草丛 tile + 位置跳变 > 1（上帧位置不相邻 或 上帧不可见）
  if (enemyTank && enemyTank.position && tileAt(game, enemyTank.position) === "o") {
    var jumped = !state.lastEnemyPos ||
      manhattan(state.lastEnemyPos, enemyTank.position) > 1 ||
      state.lastEnemySeenFrame < frame - 1;
    if (jumped) {
      _bushHeatAdd(hm, enemyTank.position, 100, frame, 'teleport');
      stats.teleportIntoBush++;
      stats.lastTeleportIntoBushFrame = frame;
    }
  }

  // ── 途径 3：草丛开炮推算 ──
  var hasBullet = !!(enemy && enemy.bullet && enemy.bullet.position);
  if (hasBullet && !state.bushBulletSeen && !enemyTank) {
    var b = enemy.bullet;
    var rd = { up: [0, 1], down: [0, -1], left: [1, 0], right: [-1, 0] }[b.direction];
    if (rd) {
      var cx = b.position[0], cy = b.position[1];
      for (var step = 1; step <= 10; step++) {
        cx += rd[0]; cy += rd[1];
        var tp = [cx, cy];
        if (!inBounds(tp, game)) break;
        var tile = tileAt(game, tp);
        if (tile === "x" || tile === "m") break;
        if (tile === "o") {
          var addScore = Math.max(20, 50 - step * 5);
          _bushHeatAdd(hm, tp, addScore, frame, 'fire');
        }
      }
      stats.fireFromBush++;
    }
  }
  state.bushBulletSeen = hasBullet;

  // ── 途径 4：推断传送消失 ──
  // 敌上帧可见于非草丛位、本帧消失、且无相邻草丛可解释(非走进草)、敌有传送技能
  // → 推断敌传送进了某个草丛格，将全图草丛加入热力图
  if (!enemyTank && state.lastEnemyPos && state.lastEnemySeenFrame >= frame - 1 &&
      enemyHasTeleport(enemy)) {
    var lp4 = state.lastEnemyPos;
    if (tileAt(game, lp4) !== "o") {
      var hasAdjGrass = false;
      for (var i = 0; i < DIRS.length; i++) {
        if (tileAt(game, [lp4[0] + DIRS[i].dx, lp4[1] + DIRS[i].dy]) === "o") {
          hasAdjGrass = true; break;
        }
      }
      if (!hasAdjGrass) {
        var w = game.map.length, h = game.map[0].length;
        for (var gx = 0; gx < w; gx++) {
          for (var gy = 0; gy < h; gy++) {
            if (tileAt(game, [gx, gy]) === "o") {
              _bushHeatAdd(hm, [gx, gy], 80, frame, 'teleport-infer');
            }
          }
        }
        stats.teleportIntoBush++;
        stats.lastTeleportIntoBushFrame = frame;
      }
    }
  }

  // ── 蹲草不动统计 ──
  if (!enemyTank) {
    var hasHighHeat = false;
    for (var k in hm) {
      if (hm.hasOwnProperty(k) && hm[k].score >= 40) { hasHighHeat = true; break; }
    }
    if (hasHighHeat) stats.bushStationaryFrames++;
  }
}


function _bushHeatAdd(hm, pos, score, frame, source) {
  var k = key(pos);
  if (hm[k]) {
    hm[k].score = Math.min(200, hm[k].score + score);
    hm[k].lastFrame = frame;
    hm[k].source = source;
  } else {
    hm[k] = { score: score, lastFrame: frame, source: source };
  }
}
