// ============================================================
// scoring.js — 统一评分引擎
// 负责：候选提案的数据结构、打分公式、硬约束校验、最优提案裁决。
// 所有权重均集中在此文件，Phase 5 校准时只改这里。
// ============================================================

// ---- 权重配置（Phase 5 校准入口） ----
var SCORE_WEIGHTS = {
  reward:    1.0,
  risk:      1.2,
  stability: 0.3,
};

// ---- 提案工厂 ----
/**
 * 构造一个候选动作提案。
 * @param {string}   type     动作类型（用于日志与分析）
 * @param {Function} exec     执行闭包（调用时无参数）
 * @param {Object}   opts     评分元数据
 *   reward    {number}  0-100 收益分（默认30）
 *   risk      {number}  0-100 风险分（默认50）
 *   stability {number}  跨帧连续性加成（默认0）
 *   hardGate  {boolean} true=绕过打分直接执行（用于致命威胁的硬闸门）
 *   step      {Array}   目标坐标，供 isDeadlyProposal 复检
 *   tags      {Array}   标签，供 braveBonus 识别（'star','attack','hold-line'）
 *   reason    {string}  调试说明
 */
function buildProposal(type, exec, opts) {
  opts = opts || {};
  return {
    type:      type,
    exec:      exec,
    reward:    opts.reward    !== undefined ? opts.reward    : 30,
    risk:      opts.risk      !== undefined ? opts.risk      : 50,
    stability: opts.stability !== undefined ? opts.stability : 0,
    hardGate:  opts.hardGate  || false,
    step:      opts.step      || null,
    tags:      opts.tags      || [],
    reason:    opts.reason    || '',
  };
}

// ---- 评分上下文构建 ----
function buildScoringContext(me, enemy, game, state, enemyBullets, enemyTank, enemyPos) {
  const frame     = (game && game.frames) || 0;
  const myStars   = (me && me.stars)            || 0;
  const enmStars  = (enemy && enemy.stars)      || 0;
  const framesLeft = MAX_GAME_FRAMES - frame;
  return {
    me, enemy, game, state,
    enemyBullets: enemyBullets || [],
    enemyTank, enemyPos,
    myPos:      me.tank.position,
    myStars,
    enmStars,
    frame,
    framesLeft,
    isEndgame:  framesLeft <= 20,
    isLosing:   myStars < enmStars,
    isWinning:  myStars > enmStars,
  };
}

// ---- 勇敢基线奖励（防止坦克过于保守不进攻） ----
function braveBonus(proposal, ctx) {
  var bonus = 0;
  var tags  = proposal.tags;

  // ── 落后时：大幅提升抢星动力（游戏只靠星得分，攻击无直接收益）
  if (ctx.isLosing) {
    if (tags.indexOf('star')   >= 0) bonus += 20;   // 落后时抢星比攻击更直接
    if (tags.indexOf('attack') >= 0) bonus +=  6;   // 攻击仍有战略价值，但低于抢星
  }

  // ── 终局（剩余≤20帧）+ 落后：再加码抢星
  if (ctx.isEndgame && ctx.isLosing) {
    if (tags.indexOf('star') >= 0) bonus += 25;     // 终局落后必须全力冲星
  }

  // ── 最后10帧无论输赢：全力冲星（最后机会）
  if (ctx.framesLeft <= 10) {
    if (tags.indexOf('star') >= 0) bonus += 20;
  }

  // ── 领先时：提高生存稳定性，不要冒险（守住优势）
  if (ctx.isWinning) {
    if (tags.indexOf('survival') >= 0) bonus += 5; // 领先时更积极躲避
    if (tags.indexOf('star')     >= 0) bonus += 8; // 领先时仍追星，但幅度小
  }

  // ── 持线稳定性：守在己方星线附近
  if (tags.indexOf('hold-line') >= 0) bonus += 8;

  return bonus;
}

// ---- 硬约束：绝对致命的提案（不参与打分，直接丢弃） ----
/**
 * 对提案进行致死性复检，返回 true 则该提案被丢弃。
 * Phase 1：只做最基础的子弹弹道检测，其余约束留 Phase 2 补充。
 */
function isDeadlyProposal(proposal, ctx) {
  if (!proposal.step) return false;
  // 下一步落入子弹弹道
  if (stepIntoBulletPath(ctx.enemyBullets, proposal.step, ctx.game)) return true;
  // 踏入封闭死胡同（仅在能拿到对方坐标时校验）
  if (stepIntoSealedDeadEnd(proposal.step, ctx.enemyPos, ctx.game)) return true;
  return false;
}

// ---- 单个提案打分 ----
function scoreProposal(proposal, ctx) {
  if (isDeadlyProposal(proposal, ctx)) return -9999;
  var w = SCORE_WEIGHTS;
  return proposal.reward    * w.reward
       - proposal.risk      * w.risk
       + proposal.stability * w.stability
       + braveBonus(proposal, ctx);
}

// ---- 从候选列表裁决最优提案 ----
/**
 * 依次检查 hardGate 提案（直接返回）；否则对所有提案打分取最高。
 */
function selectBestProposal(proposals, ctx) {
  // 硬闸门提案已在 decision-engine 中提前处理，此处不再重复。
  var best      = null;
  var bestScore = -Infinity;
  for (var i = 0; i < proposals.length; i++) {
    var p = proposals[i];
    if (!p || !p.exec) continue;
    var s = scoreProposal(p, ctx);
    if (s > bestScore) {
      bestScore = s;
      best = p;
    }
  }
  return best;
}
