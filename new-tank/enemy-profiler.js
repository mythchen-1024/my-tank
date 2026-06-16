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
