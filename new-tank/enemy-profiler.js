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
var PLAYSTYLE_BUSH_CAMPER = 'bushCamper';   // 传送蹲草流
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
 * 检测所有活跃特征标志（可同时激活多个）。
 * isBushCamper 有即时响应路径，传送进草那帧立刻激活，无需等 15 帧观察期。
 */
var BUSH_TELEPORT_RESPONSE_WINDOW = 12; // 传送进草后保持激活的帧数
var TRAIT_HOLD_FRAMES = 32; // trait 一旦激活，至少保持 32 帧（2 个 rebuild 周期）防振荡

function detectTraits(bb) {
  var traits = {
    isAggressive: false,
    isDefensive:  false,
    isStarRusher: false,
    isBushCamper: false,
  };
  var m = bb.memory;
  var frame = bb.frame;
  var bs = m.bushCamperStats || {};

  // 滞后状态存储（首次初始化）
  if (!m._traitHold) {
    m._traitHold = { aggressive: -999, defensive: -999, starRusher: -999, bushCamper: -999 };
  }
  var hold = m._traitHold;

  // ── 即时路径：传送进草 → 立刻激活 isBushCamper，不等 15 帧 ──
  if ((bs.lastTeleportIntoBushFrame || -999) >= frame - BUSH_TELEPORT_RESPONSE_WINDOW) {
    traits.isBushCamper = true;
    hold.bushCamper = frame;
  }

  // ── 常规路径：需满足 PROFILER_DETECT_AFTER_FRAME ──
  if (m._profiler && frame >= PROFILER_DETECT_AFTER_FRAME) {
    var p = m._profiler;
    var vis = Math.max(1, p.enemyVisibleFrames);
    var facingRatio = p.enemyFacingMeFrames / vis;
    var fleeRatio = p.enemyFleeingFrames / vis;

    // aggressive / defensive 互斥：取占比更高的那个
    if (facingRatio > PROFILER_AGGRESSIVE_RATIO && facingRatio >= fleeRatio) {
      traits.isAggressive = true;
      hold.aggressive = frame;
    }
    if (fleeRatio > PROFILER_DEFENSIVE_RATIO && fleeRatio > facingRatio) {
      traits.isDefensive = true;
      hold.defensive = frame;
    }

    if (p.enemyStarRushCount >= 2) {
      traits.isStarRusher = true;
      hold.starRusher = frame;
    }
    if ((bs.teleportIntoBush >= 1 && bs.bushStationaryFrames >= 5) ||
        (bs.walkIntoBush >= 2 && bs.bushStationaryFrames >= 8) ||
        (bs.fireFromBush >= 2)) {
      traits.isBushCamper = true;
      hold.bushCamper = frame;
    }
  }

  // ── 滞后保持：trait 激活后至少保持 TRAIT_HOLD_FRAMES 帧 ──
  if (!traits.isAggressive && hold.aggressive >= frame - TRAIT_HOLD_FRAMES) traits.isAggressive = true;
  if (!traits.isDefensive  && hold.defensive  >= frame - TRAIT_HOLD_FRAMES) traits.isDefensive  = true;
  if (!traits.isStarRusher && hold.starRusher >= frame - TRAIT_HOLD_FRAMES) traits.isStarRusher = true;
  if (!traits.isBushCamper && hold.bushCamper >= frame - TRAIT_HOLD_FRAMES) traits.isBushCamper = true;

  // 滞后恢复后仍强制互斥（不会同时 aggressive + defensive）
  if (traits.isAggressive && traits.isDefensive) {
    if (hold.aggressive >= hold.defensive) traits.isDefensive = false;
    else traits.isAggressive = false;
  }

  return traits;
}


/**
 * starAggression 取较大值（low < medium < high < max）
 */
function starAggrMax(a, b) {
  var order = ['low', 'medium', 'high', 'max'];
  return order[Math.max(order.indexOf(a), order.indexOf(b))];
}


/**
 * 将特征标志集转为可读摘要字符串，如 "starRusher+bushCamper"
 */
function _traitsSummary(traits) {
  var active = [];
  if (traits.isAggressive) active.push('aggressive');
  if (traits.isDefensive)  active.push('defensive');
  if (traits.isStarRusher) active.push('starRusher');
  if (traits.isBushCamper) active.push('bushCamper');
  return active.length ? active.join('+') : 'unknown';
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

  // 动态打法修正（多特征标志，各自独立叠加）
  var traits = detectTraits(bb);
  profile.traits = traits;
  profile.playstyle = _traitsSummary(traits);  // 供 speak/debug 显示

  if (traits.isAggressive) {
    // 对莽夫：加大安全距离、降低攻击欲望
    profile.standoffDistance = Math.max(profile.standoffDistance, 5);
    if (profile.attackAggression === 'high') profile.attackAggression = 'medium';
  }

  if (traits.isDefensive) {
    // 对跑路型：缩小安全距离、全力抢星（它不打我）
    profile.standoffDistance = Math.min(profile.standoffDistance, 3);
    profile.starAggression = starAggrMax(profile.starAggression, 'max');
  }

  if (traits.isStarRusher) {
    // 对抢星型：提升抢星优先级
    profile.starAggression = starAggrMax(profile.starAggression, 'max');
  }

  if (traits.isBushCamper) {
    // 对蹲草流：固定炮线威胁，安心吃星 + 启用草丛炮线回避
    profile.starAggression = starAggrMax(profile.starAggression, 'high');
    if (profile.attackAggression === 'low') profile.attackAggression = 'medium';
    profile.bushCamperDefense = true;
    // aggressive(min 5) + bushCamper(min 4)：bushCamper 优先（蹲草敌不追人）
    profile.standoffDistance = Math.min(profile.standoffDistance, 4);
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
