// ============================================================
// scoring.js — 统一评分引擎
// 负责：候选提案的数据结构、打分公式、硬约束校验、最优提案裁决。
// 所有权重均集中在此文件，Phase 5 校准时只改这里。
// ============================================================

// ---- 权重配置（Phase 5 校准入口） ----
var SCORE_WEIGHTS = {
  // 收益(抢星/击杀/压制)
  reward:    1.0,
  // 风险(子弹/炮口/死胡同)
  risk:      1.2,
  // 计划连续性
  stability: 0.3,
};

// ---- 提案基准分（Phase 5 校准入口） ----
// 这里维护“顶层 proposal”的默认 reward / risk / stability / tags。
// 实际总分公式见 scoreProposal：
//   total = reward * 1.0 - risk * 1.2 + stability * 0.3 + braveBonus(tags)
//
// 使用约定：
// 1. action-proposals.js 只需要 buildProposal(type, exec, opts)，若 opts 不显式传分数，
//    就会自动继承这里的默认值；需要临时覆盖某一项时，再在 opts 里单独传入。
// 2. hardGate 类动作（子弹躲避/逃生传送等）会在 decision-engine 中直接执行，
//    不依赖分数竞争；这里仍保留高分，主要用于 trace、调试和语义对齐。
// 3. tags 会被 braveBonus 使用：star 表示可吃分，attack 表示压制，survival 表示保命，
//    hold-line 表示守线稳定性，plan 表示跨帧计划，move/fallback 表示普通兜底。
// 4. 软红线：aim-dodge 约 70、line-duel-dodge 约 65、open-shot 约 55。
//    调高抢星/攻击类动作时，要确认不会无意越过这些生存/反击红线。
//
// 当前 tag 统一释义：
// - star：直接或间接服务于吃星/守星。braveBonus 会在落后、终局、最后10帧时加权。
// - attack：服务于开火、压制、刺杀或抢射击窗口。落后时有小幅勇敢加成。
// - survival：服务于躲弹、防瞄、逃离危险区或保持安全。领先时有小幅生存加成。
// - hold-line：服务于守线/预瞄/守星线。无论比分如何都有固定稳定加成。
// - plan：服务于跨帧计划和行为粘性，如短期意图、蹲草、巡逻。
// - move：普通移动/走位候选的基础标签；scored-move 会按内部 kind 再补 star/survival/plan/attack。
// - fallback：兜底动作标签，当前只用于 turn-right，避免无动作挂机。
//
// 当前 proposal type 统一释义：
// - counter-shoot：硬闸门反击；来袭子弹下确认开火后仍能躲，先射一炮。
// - bullet-dodge：硬闸门躲弹；常规相邻格躲避来袭子弹。
// - escape-teleport：硬闸门逃生传送；常规移动躲不开时传送到安全落点。
// - two-step-escape：硬闸门两步脱困；双弹夹击下先走到“下一帧还能继续脱离”的格。
// - desperate-dodge：硬闸门绝境横移；躲不了也传不了时，至少垂直弹道挣一步。
// - aim-dodge：软生存防瞄；敌方炮口/预瞄威胁下提前离线。
// - line-duel-dodge：软生存近距对射规避；近距同线且我不占先手时侧移。
// - open-shot：攻击空窗期反击；敌方炮管被场上子弹占用时抢开火窗口。
// - cloak-prefire：攻击隐身预射；敌 cloak 刚消失且可能进入我炮口/伏击线时提前开火。
// - fire-direct：攻击直射；同线无遮挡且可开火时直接射击或转向。
// - guard-line：攻击守线；提前把炮口对准敌/星可能进入的路线。
// - bush-shot：攻击草丛；预射草丛伏击线或我方草丛伏击。
// - cloak-guard：目标防陷阱；隐身敌卡星线时侧向守位。
// - cloak-trap-hold：目标防陷阱；找不到安全守位时原地等待，阻断送死追星。
// - star-teleport：目标抢星；传送到星或星附近安全格。
// - star-guard：目标守星；双方争星时预瞄守点。
// - assassination：目标刺杀；传送到敌方盲区尝试近身击杀。
// - bush-hold：计划蹲草；对 overload 流无星时藏草等星刷新。
// - short-intent-hold：计划原地保持；短期 hold 意图续跑。
// - short-intent：计划移动续跑；短期移动意图续跑。
// - scored-move：移动层胜出的走位候选；具体 kind 写入 reason/detailScore/meta。
// - dig：移动层破墙；无更高价值动作时开路。
// - safe-neighbor：移动层安全邻格；找一个相对安全的相邻格苟活。
// - turn-right：最终兜底；避免无动作挂机。
var SCORE_PRESETS = {
  // 第一梯队：硬生存/立即响应。实际执行时绕过评分，分数只作为语义与调试基准。
  'counter-shoot':     { reward: 79, risk: 10, stability: 0, tags: ['attack', 'survival'] },
  'bullet-dodge':      { reward: 88, risk:  8, stability: 0, tags: ['survival'] },
  'escape-teleport':   { reward: 90, risk:  5, stability: 0, tags: ['survival'] },
  'two-step-escape':   { reward: 85, risk: 10, stability: 0, tags: ['survival'] },
  'desperate-dodge':   { reward: 80, risk: 12, stability: 0, tags: ['survival'] },

  // 第二梯队：软生存。参与评分竞争，但设计上应压过常规攻击/抢位。
  'aim-dodge':         { reward: 82, risk: 10, stability: 0, tags: ['survival'] },
  'line-duel-dodge':   { reward: 83, risk: 15, stability: 0, tags: ['survival'] },

  // 第三梯队：主动攻击。攻击不直接得分，所以整体低于软生存，但高于普通走位。
  'open-shot':         { reward: 79, risk: 20, stability: 0, tags: ['attack'] },
  'cloak-prefire':     { reward: 76, risk: 18, stability: 0, tags: ['attack'] },
  'fire-direct':       { reward: 75, risk: 25, stability: 0, tags: ['attack'] },
  'guard-line':        { reward: 65, risk: 20, stability: 0, tags: ['attack', 'hold-line'] },
  'bush-shot':         { reward: 60, risk: 15, stability: 0, tags: ['attack'] },

  // 第四梯队：目标任务。星星是唯一直接得分来源，落后/终局会通过 braveBonus 动态提权。
  'cloak-guard':       { reward: 56, risk: 15, stability: 0, tags: ['survival', 'star'] },
  'cloak-trap-hold':   { reward: 58, risk: 12, stability: 0, tags: ['survival'] },
  'star-teleport':     { reward: 80, risk: 25, stability: 5, tags: ['star'] },
  'star-guard':        { reward: 50, risk: 15, stability: 0, tags: ['star', 'hold-line'] },
  'assassination':     { reward: 70, risk: 35, stability: 0, tags: ['attack'] },

  // 第五梯队：计划/普通移动/兜底。负责不挂机、保留短期意图和无仗可打时的机动性。
  // scored-move 的内部 kind（star/bandEscape/patrol 等）会在 action-proposals.js 中补充 tags。
  'bush-hold':         { reward: 34, risk: 10, stability: 15, tags: ['survival', 'plan'] },
  'short-intent-hold': { reward: 36, risk: 10, stability: 0, tags: ['plan'] },
  'short-intent':      { reward: 38, risk: 17, stability: 10, tags: ['plan'] },
  'scored-move':       { reward: 35, risk: 18, stability: 3, tags: ['move'] },
  'dig':               { reward: 26, risk: 15, stability: 0, tags: ['move'] },
  'safe-neighbor':     { reward: 28, risk: 20, stability: 0, tags: ['move'] },
  'turn-right':        { reward: 40, risk: 40, stability: 0, tags: ['fallback'] },
};

// ---- 提案工厂 ----
/**
 * 构造一个候选动作提案。
 * @param {string}   type     动作类型（用于日志与分析；见 SCORE_PRESETS 上方 type 统一释义）
 * @param {Function} exec     执行闭包（调用时无参数）
 * @param {Object}   opts     评分元数据
 *   reward    {number}  0-100 收益分（默认30）
 *   risk      {number}  0-100 风险分（默认50）
 *   stability {number}  跨帧连续性加成（默认0）
 *   hardGate  {boolean} true=绕过打分直接执行（用于致命威胁的硬闸门）
 *   step      {Array}   目标坐标，供 isDeadlyProposal 复检
 *   tags      {Array}   标签，供 braveBonus 识别（见 SCORE_PRESETS 上方 tag 统一释义）
 *   reason    {string}  调试说明
 */
function buildProposal(type, exec, opts) {
  opts = opts || {};
  var preset = SCORE_PRESETS[type] || {};
  return {
    type:      type,
    exec:      exec,
    reward:    opts.reward    !== undefined ? opts.reward    : (preset.reward    !== undefined ? preset.reward    : 30),
    risk:      opts.risk      !== undefined ? opts.risk      : (preset.risk      !== undefined ? preset.risk      : 50),
    stability: opts.stability !== undefined ? opts.stability : (preset.stability !== undefined ? preset.stability : 0),
    hardGate:  opts.hardGate  || false,
    step:      opts.step      || null,
    tags:      opts.tags      || preset.tags || [],
    reason:    opts.reason    || '',
    meta:      opts.meta      || null,
    detailScore: opts.detailScore !== undefined ? opts.detailScore : null,
  };
}

// ---- 评分上下文构建 ----
function buildScoringContext(me, enemy, game, state, enemyBullets, enemyTank, enemyPos) {
  const frame     = (game && game.frames) || 0;
  const myStars   = (me && me.stars)            || 0;
  const enmStars  = (enemy && enemy.stars)      || 0;
  const framesLeft = MAX_GAME_FRAMES - frame;
  // 抢星热门：我到星步数 +1(转向缓冲) 仍严格小于敌人 = 这颗星“该我吃”。
  // 与 buildMoveCandidates 的 favorite 判定同源，靠 shortestPathInfo 每帧缓存避免重复 BFS。
  let isStarFavorite = false;
  if (game && game.star && enemyPos && me && me.tank) {
    const myStarDist  = pathDistance(me.tank.position, game.star, game, enemyPos);
    const enmStarDist = pathDistance(enemyPos, game.star, game, me.tank.position);
    if (myStarDist >= 0) isStarFavorite = enmStarDist < 0 || myStarDist + 1 < enmStarDist;
  }
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
    isStarFavorite,
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

  // ── 抢星热门：这颗星明显该我吃(我比敌近)，无论输赢都加码，别让外圈巡逻/绕圈惯性压过(mat_2Bc f104)
  if (ctx.isStarFavorite && tags.indexOf('star') >= 0) bonus += 18;

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
    p.score = s;
    if (s > bestScore) {
      bestScore = s;
      best = p;
    }
  }
  return best;
}
