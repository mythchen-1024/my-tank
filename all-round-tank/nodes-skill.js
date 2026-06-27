// ============================================================
// nodes-skill.js — 我方技能行为节点（8 种技能完整战术体系）
//
// 三类子树工厂：
//   1. createSkillSurvivalNodes(mySkillType) — 技能逃生（硬生存补充）
//   2. createSkillAttackNodes(mySkillType)   — 技能攻击（攻击层前置）
//   3. createSkillObjectiveNodes(mySkillType)— 技能目标（目标层前置）
//
// 所有节点通过 bb.mySkillType / bb.skillIsReady Guard 门控，
// 运行时自动匹配当前技能，非本技能节点返回 FAILURE。
//
// 动态对抗参数：getSkillMatchupParams(mySkillType, enemySkillType)
// 根据敌我技能组合动态调整阈值，避免硬编码。
// ============================================================

// ================================================================
// 技能对抗参数表 — 根据 (我方技能, 敌方技能) 动态调整行为阈值
// ================================================================

/**
 * 默认参数（通用基线）
 */
var SKILL_MATCHUP_DEFAULTS = {
  freezeKillRange: 5,        // 冰冻设置触发距离（无射线时，≤此距离才冻+走位；有射线时≤4限制）
  freezeKillRequireShot: false, // 是否要求已有射线才冻（vs护盾等需更严格）
  stunKillRange: 7,          // 眩晕设置触发距离（无射线时；有射线时无距离限制，6帧够走位）
  overloadRange: 5,          // 过载触发距离
  overloadRequireShot: false,// 过载是否要求已对准（vs传送等需更谨慎）
  poisonRange: 5,            // 下毒触发距离
  cloakSneakRange: 8,       // 隐身潜行触发距离
  cloakSneakEnabled: true,   // 是否启用隐身偷袭
  shieldCounterRange: 4,    // 盾击触发距离
  boostChaseRange: 6,       // 加速追击触发距离
  skillStarContestDelta: 0,  // 技能抢星距离容差（敌距星 <= 我距星 + delta 时触发）
  freezeAvoidShielded: true, // 冰冻时是否回避已开盾的敌人
  stunBypassShield: true,    // 眩晕是否无视护盾（stun 本身不造成伤害）
  overloadWaitShield: true,  // 过载是否等护盾碎裂后再开火
  poisonBypassShield: true,  // 下毒是否无视护盾
};

/**
 * 技能对抗修正表：MATCHUP_OVERRIDES[我方技能][敌方技能] = { ...覆盖参数 }
 * 仅列出需要覆盖默认值的组合。
 */
var MATCHUP_OVERRIDES = {
  freeze: {
    // vs 护盾流：敌人被冻后可能开盾挡火，需确认无盾再冻+要求已有射线确保即冻即杀
    shield:   { freezeKillRange: 3, freezeKillRequireShot: true, freezeAvoidShielded: true },
    // vs 传送流：对方冻住也可能提前传走（冻住时不能传但冻前可能预判传），近距才值得冻
    teleport: { freezeKillRange: 3 },
    // vs 加速流：对方加速中移动快，冻距需更近确保命中窗口
    boost:    { freezeKillRange: 3 },
    // vs 隐身流：看不到时别浪费冻
    cloak:    { freezeKillRange: 3 },
  },
  stun: {
    // vs 护盾流：眩晕不造成伤害，无视护盾；但晕后开火时敌人可能盾还在
    shield:   { stunKillRange: 4, stunBypassShield: true },
    // vs 传送流：眩晕使其6帧混乱无法精确传送，是克制传送的好手段
    teleport: { stunKillRange: 6 },
    // vs 冰冻流：近身时先晕可防止对方先冻我
    freeze:   { stunKillRange: 5 },
  },
  overload: {
    // vs 护盾流：等盾碎再过载开火，否则双弹浪费
    shield:   { overloadRange: 4, overloadRequireShot: true, overloadWaitShield: true },
    // vs 传送流：对方可能瞬移躲双弹，更近距才过载
    teleport: { overloadRange: 4, overloadRequireShot: true },
    // vs 加速流：对方速度快，过载后尽快开火
    boost:    { overloadRange: 4 },
    // vs 隐身流：看得到时立刻过载（消失后就没机会了）
    cloak:    { overloadRange: 6 },
  },
  poison: {
    // vs 护盾流：毒是 debuff 无视护盾，可放心下毒
    shield:   { poisonRange: 6, poisonBypassShield: true },
    // vs 传送流：对方中毒后行动变慢但仍可传送逃离，效果有限
    teleport: { poisonRange: 4 },
    // vs 加速流：毒克加速（减速效果抵消加速），优先下毒
    boost:    { poisonRange: 6 },
    // vs 冰冻流：中毒后躲冰冻更难，优先在被冻前下毒
    freeze:   { poisonRange: 5 },
  },
  cloak: {
    // vs 隐身流：双方都隐身效果互相抵消，降低优先级
    cloak:    { cloakSneakEnabled: false },
    // vs 过载流：隐身后被双弹覆盖危险大，潜行距离缩短
    overload: { cloakSneakRange: 5 },
    // vs 冰冻流：隐身后敌人无法冻我（看不到），是好克制
    freeze:   { cloakSneakRange: 8 },
  },
  shield: {
    // vs 冰冻流：被冻2帧可能被连杀，盾无法防冻，盾击距离缩短保命
    freeze:   { shieldCounterRange: 3 },
    // vs 过载流：盾能挡一发，但双弹第二发仍会命中，盾击范围缩短
    overload: { shieldCounterRange: 3 },
    // vs 眩晕流：被晕后混乱，开盾时机可能失误，距离保守
    stun:     { shieldCounterRange: 3 },
  },
  boost: {
    // vs 冰冻流：加速可快速脱离冰冻射程，追击距离可拉大
    freeze:   { boostChaseRange: 7 },
    // vs 过载流：加速冲入双弹带很危险，追击距离缩短
    overload: { boostChaseRange: 4 },
    // vs 毒药流：中毒后加速失效期更痛苦，保持距离
    poison:   { boostChaseRange: 5 },
  },
};

/**
 * 获取当前对局的技能对抗参数。
 * 在每次 buildBehaviorTree 或技能节点 Guard 中调用。
 *
 * @param {string} mySkill  - 我方技能类型
 * @param {string} enemySkill - 敌方技能类型
 * @returns {Object} 合并后的参数对象
 */
function getSkillMatchupParams(mySkill, enemySkill) {
  var params = {};
  var k;
  for (k in SKILL_MATCHUP_DEFAULTS) {
    if (SKILL_MATCHUP_DEFAULTS.hasOwnProperty(k)) {
      params[k] = SKILL_MATCHUP_DEFAULTS[k];
    }
  }
  var overrides = MATCHUP_OVERRIDES[mySkill] && MATCHUP_OVERRIDES[mySkill][enemySkill];
  if (overrides) {
    for (k in overrides) {
      if (overrides.hasOwnProperty(k)) {
        params[k] = overrides[k];
      }
    }
  }
  return params;
}

// ================================================================
// 1. 技能逃生节点 — 分两类：
//    (a) 即时挡弹：Shield 开盾真能挡子弹 → 放在 escape-teleport 之后、two-step 之前
//    (b) 延迟反制：其他技能不能阻止已发射子弹 → 放在 desperate-dodge 之后
//        （物理逃跑全失败再用技能，阻止敌人追杀/补枪）
// ================================================================

/**
 * 护盾挡弹节点（仅 shield 技能）。
 * 护盾激活后立即生效，能真正挡住来袭子弹，所以优先于 two-step。
 */
function createShieldBlockNode(mySkillType) {
  if (mySkillType !== 'shield') return null;
  return Sequence('shield-block', [
    Guard('has-bullet-threat', function (bb) {
      return anyBulletThreatens(bb.enemyBullets, bb.myPos, bb.game);
    }),
    Guard('no-dodge', function (bb) { return !senseBulletDodge(bb); }),
    Guard('no-escape-tp', function (bb) { return !senseEscapeTeleport(bb); }),
    Guard('shield-ready', function (bb) { return canShieldSkill(bb.me); }),
    Action('do-shield-block', function (bb) {
      bbSpeak(bb, '挡弹!');
      bbUseSkill(bb, 'shield');
    })
  ]);
}

/**
 * 护盾保位挡弹节点（仅 shield，且仅 vs overload）。
 *
 * 设计动机（用户方案①）：vs overload 的双弹，副弹在 +1 偏移车道，同一帧只有主弹能命中我格。
 * 横移躲弹虽能脱离弹道（findBulletDodge 已排除被命中落点），但会让出当前对敌的清晰射线位
 * = 放敌人自由走位。盾流天然不怕双弹（站着开盾稳挡主弹，副弹隔壁车道打不到），
 * 所以应优先"原地开盾保住射线位"而非横移让位，挡完主弹下帧由 shield-fire 反杀压制。
 *
 * 门控极窄（避免烧掉 12% 可用率的稀缺盾）：
 *   - 仅 vs overload（普通单弹横移躲掉即可，不值得烧盾）
 *   - 必须当前已占清晰射线位（bb.shotDir）——保位才有意义
 *   - 必须"横移会丢射线位"：若横移落点仍保有对敌射线，让横移走更省盾
 *   - 盾就绪 + 有来弹威胁
 * 优先级：插在 counter-shoot 之后、bullet-dodge 之前（反击 > 保位挡弹 > 横移让位）。
 */
function createShieldHoldNode(mySkillType) {
  if (mySkillType !== 'shield') return null;
  return Sequence('shield-hold-position', [
    Guard('enemy-is-overload', function (bb) {
      return !!(bb.enemy && bb.enemy.skill && bb.enemy.skill.type === 'overload');
    }),
    Guard('has-bullet-threat', function (bb) {
      return anyBulletThreatens(bb.enemyBullets, bb.myPos, bb.game);
    }),
    Guard('holding-fire-position', function (bb) {
      // 当前已占对敌清晰射线位（保位才有价值）
      return !!bb.shotDir && !!bb.enemyTank;
    }),
    Guard('shield-ready', function (bb) { return canShieldSkill(bb.me); }),
    Guard('dodge-loses-position', function (bb) {
      // 横移落点若仍保有对敌清晰射线 → 让横移走（省盾）；只有横移会丢射线位才开盾保位
      var dodge = senseBulletDodge(bb);
      if (!dodge) return true; // 横移无解 → 必须开盾保命+保位
      return !clearShotDirection(dodge, bb.enemyPos, bb.game);
    }),
    Action('do-shield-hold', function (bb) {
      bbSpeak(bb, '保位!');
      bbUseSkill(bb, 'shield');
    })
  ]);
}

/**
 * 延迟技能逃生节点（仅 cloak / boost）。
 * 物理逃跑（two-step/desperate）全失败后的最后手段。
 *
 * 设计原则：
 *   freeze/stun/poison 等 debuff 技能不放在防御端——
 *   它们不能阻止已发射子弹，防御使用=白烧 25~32 帧冷却，
 *   不如留给 freeze-kill/stun-kill/poison-fire（进攻击杀）
 *   或 freeze-star/stun-star/poison-star（抢星阻敌），收益远大于防御。
 *
 *   cloak：隐身后敌方丢失目标，阻止后续追射，有真实续命价值。
 *   boost：下帧 go() 走2格脱离，有真实逃跑价值。
 */
function createDeferredSkillEscape(mySkillType) {
  var children = [];

  // ---- Cloak: 物理逃跑失败 → 隐身，敌方丢失目标不再追射 ----
  if (mySkillType === 'cloak') {
    children.push(
      Sequence('cloak-escape', [
        Guard('has-bullet-threat', function (bb) {
          return anyBulletThreatens(bb.enemyBullets, bb.myPos, bb.game);
        }),
        Guard('no-dodge', function (bb) { return !senseBulletDodge(bb); }),
        Guard('cloak-ready', function (bb) { return canCloak(bb.me); }),
        Action('do-cloak-escape', function (bb) {
          bbSpeak(bb, '隐身!');
          bbUseSkill(bb, 'cloak');
        })
      ])
    );
  }

  // ---- Boost: 物理逃跑失败 → 加速，下帧 go() 走2格脱离 ----
  if (mySkillType === 'boost') {
    children.push(
      Sequence('boost-escape', [
        Guard('has-bullet-threat', function (bb) {
          return anyBulletThreatens(bb.enemyBullets, bb.myPos, bb.game);
        }),
        Guard('no-dodge', function (bb) { return !senseBulletDodge(bb); }),
        Guard('boost-ready', function (bb) { return canBoost(bb.me); }),
        Action('do-boost-escape', function (bb) {
          bbSpeak(bb, '加速逃!');
          bbUseSkill(bb, 'boost');
        })
      ])
    );
  }

  if (children.length === 0) return null;
  return Selector('deferred-skill-escape', children);
}


// ================================================================
// 2. 技能攻击节点 — 插入 softSurvival 和 attack 之间
// ================================================================

function createSkillAttackNodes(mySkillType, enemySkillType) {
  enemySkillType = enemySkillType || 'stun';
  var mp = getSkillMatchupParams(mySkillType, enemySkillType);
  var children = [];

  // ---- Freeze 系列：冰冻是全局技能（无距离限制），冻2帧内敌方无法行动 ----
  // 冻住=敌2帧无法闪避+无法抢星+无法走位，压制价值极高。有射线就冻，高频压制。
  // 伏击combo：草丛开火后下帧冻（敌刚传送落地位置固定，先射后冻=必中）。
  if (mySkillType === 'freeze') {

    // (0) freeze-combo-followup：上帧伏击开炮 → 本帧冻（子弹在飞 + 敌刚落地 = 必中）
    children.push(
      Sequence('freeze-combo-followup', [
        Guard('fired-last-frame', function (bb) {
          return bb.memory && bb.memory._firedForFreeze === bb.frame - 1;
        }),
        Guard('freeze-ready', function (bb) { return canFreeze(bb.me, bb.enemy); }),
        Guard('enemy-visible', function (bb) { return !!bb.enemyTank; }),
        Action('do-freeze-combo', function (bb) {
          bbSpeak(bb, '冰锁!');
          bbUseSkill(bb, 'freeze');
        })
      ])
    );

    // (0.5) freeze-star-deny：星竞争时冻住对手让自己先吃
    //     优先级高于 freeze-snipe：有星争时 deny > kill attempt
    children.push(
      Sequence('freeze-star-deny', [
        Guard('star-exists', function (bb) { return !!bb.star; }),
        Guard('freeze-ready', function (bb) { return canFreeze(bb.me, bb.enemy); }),
        Guard('enemy-visible', function (bb) { return !!bb.enemyTank; }),
        Guard('star-contested', function (bb) {
          var enemyStarDist = manhattan(bb.enemyPos, bb.star);
          return enemyStarDist <= bb.distToStar + 2 && bb.distToStar <= 8;
        }),
        Guard('no-self-danger', function (bb) {
          return !anyBulletThreatens(bb.enemyBullets, bb.myPos, bb.game);
        }),
        Action('do-freeze-star-deny', function (bb) {
          bbSpeak(bb, '冰星!');
          bbUseSkill(bb, 'freeze');
        })
      ])
    );

    // (1) freeze-snipe：有射线 + 近距(≤4) → 直接冻 → 下帧开火
    //     已对准时：F0冻→F1射→距4:F2到(冻中)=必杀
    //     差1转时：F0冻→F1转→F2射→距2:命中/距4:解冻帧≈50%命中
    children.push(
      Sequence('freeze-snipe', [
        Guard('enemy-visible', function (bb) { return !!bb.enemyTank; }),
        Guard('freeze-ready', function (bb) { return canFreeze(bb.me, bb.enemy); }),
        Guard('has-clear-shot', function (bb) { return !!bb.shotDir; }),
        Guard('in-kill-range', function (bb) { return bb.distToEnemy <= 4; }),
        Guard('gun-ready', function (bb) { return bb.gunIsReady; }),
        Guard('can-shoot', function (bb) { return canShoot(bb.me, bb.enemy); }),
        Guard('not-shielded', function (bb) {
          if (!mp.freezeAvoidShielded) return true;
          return !(bb.enemy && bb.enemy.status && bb.enemy.status.shielded);
        }),
        Guard('no-self-danger', function (bb) {
          return !anyBulletThreatens(bb.enemyBullets, bb.myPos, bb.game);
        }),
        Action('do-freeze-snipe', function (bb) {
          bbSpeak(bb, '冰杀!');
          bbUseSkill(bb, 'freeze');
        })
      ])
    );

    // (2) freeze-setup：无射线但可见 + 近/中距 → 冻住后利用2帧走到射线位
    //     距离 ≤ freezeKillRange(默认6)：冻后2帧走位到线上有机会开火
    children.push(
      Sequence('freeze-setup', [
        Guard('enemy-visible', function (bb) { return !!bb.enemyTank; }),
        Guard('freeze-ready', function (bb) { return canFreeze(bb.me, bb.enemy); }),
        Guard('no-direct-shot', function (bb) { return !bb.shotDir; }),
        Guard('reachable-range', function (bb) { return bb.distToEnemy <= mp.freezeKillRange; }),
        Guard('gun-ready', function (bb) { return bb.gunIsReady; }),
        Guard('can-shoot', function (bb) { return canShoot(bb.me, bb.enemy); }),
        Guard('not-shielded', function (bb) {
          if (!mp.freezeAvoidShielded) return true;
          return !(bb.enemy && bb.enemy.status && bb.enemy.status.shielded);
        }),
        Guard('near-firing-lane', function (bb) {
          return hasNearbyFiringLane(bb.myPos, bb.enemyPos, bb.game, 2);
        }),
        Guard('no-self-danger', function (bb) {
          return !anyBulletThreatens(bb.enemyBullets, bb.myPos, bb.game);
        }),
        Action('do-freeze-setup', function (bb) {
          bbSpeak(bb, '冰冻!');
          bbUseSkill(bb, 'freeze');
        })
      ])
    );

    // (3) freeze-followup：敌人被冻住时抓紧瞄准开火（仅在杀伤区内追杀）
    //     门控：冻锁 2 帧 + 子弹 2 格/帧 → 同线无墙曼哈顿 ≤4 才追得上(解冻前子弹已在途)。
    //     远距/不同线的冻是 freeze-star 抢星冻敌——此处必须让位，否则会去
    //     nextStepToFiringLane 朝够不着的敌人挪步，把抢星的 2 帧白白浪费（mat_CyF 复盘）。
    children.push(
      Sequence('freeze-followup', [
        Guard('enemy-frozen', function (bb) {
          return !!(bb.enemy && bb.enemy.status && bb.enemy.status.frozen);
        }),
        Guard('enemy-visible', function (bb) { return !!bb.enemyTank; }),
        Guard('in-freeze-kill-range', function (bb) {
          // 同线(shotDir 存在)且 ≤4 格才可能在冻结窗口内命中；否则让位给抢星
          return !!bb.shotDir && bb.distToEnemy <= 4;
        }),
        Action('do-freeze-followup', function (bb) {
          if (bb.gunIsReady && bb.myDir === bb.shotDir) { bbSpeak(bb, '冰杀!'); bbFire(bb); }
          else if (bb.myDir !== bb.shotDir) bbTurnToward(bb, bb.shotDir);
          // 已对准但枪没好：等下帧再射（不浪费冰冻窗口去做别的）
        })
      ])
    );
  }

  // ---- Stun 系列：眩晕是全局技能，6帧混乱（go/turn 50%反向）无法有效闪避 ----
  // 6帧比freeze的2帧更宽裕，有更多走位+瞄准时间
  if (mySkillType === 'stun') {

    // (1) stun-snipe：有射线（任意距离）→ 晕 → 下帧开火
    //     6帧混乱期间敌人无法有效闪避，距离越近命中越稳
    children.push(
      Sequence('stun-snipe', [
        Guard('enemy-visible', function (bb) { return !!bb.enemyTank; }),
        Guard('stun-ready', function (bb) { return canStun(bb.me, bb.enemy); }),
        Guard('has-clear-shot', function (bb) { return !!bb.shotDir; }),
        Guard('gun-ready', function (bb) { return bb.gunIsReady; }),
        Guard('can-shoot-after', function (bb) {
          if (mp.stunBypassShield) return true;
          return canShoot(bb.me, bb.enemy);
        }),
        Guard('no-self-danger', function (bb) {
          return !anyBulletThreatens(bb.enemyBullets, bb.myPos, bb.game);
        }),
        Action('do-stun-snipe', function (bb) {
          bbSpeak(bb, bb.distToEnemy <= 4 ? '晕杀!' : '晕射!');
          bbUseSkill(bb, 'stun');
          bb.memory.stunCastFrame = bb.frame;
        })
      ])
    );

    // (2) stun-setup：无射线但中距 → 晕住后利用6帧走到射线位开火
    children.push(
      Sequence('stun-setup', [
        Guard('enemy-visible', function (bb) { return !!bb.enemyTank; }),
        Guard('stun-ready', function (bb) { return canStun(bb.me, bb.enemy); }),
        Guard('no-direct-shot', function (bb) { return !bb.shotDir; }),
        Guard('reachable-range', function (bb) { return bb.distToEnemy <= mp.stunKillRange; }),
        Guard('gun-ready', function (bb) { return bb.gunIsReady; }),
        Guard('can-shoot-after', function (bb) {
          if (mp.stunBypassShield) return true;
          return canShoot(bb.me, bb.enemy);
        }),
        Guard('near-firing-lane', function (bb) {
          return hasNearbyFiringLane(bb.myPos, bb.enemyPos, bb.game, 3);
        }),
        Guard('no-self-danger', function (bb) {
          return !anyBulletThreatens(bb.enemyBullets, bb.myPos, bb.game);
        }),
        Action('do-stun-setup', function (bb) {
          bbSpeak(bb, '眩晕!');
          bbUseSkill(bb, 'stun');
          bb.memory.stunCastFrame = bb.frame;
        })
      ])
    );

    // (3) stun-followup：敌人被眩晕时抓紧瞄准开火
    children.push(
      Sequence('stun-followup', [
        Guard('enemy-stunned', function (bb) {
          return !!(bb.enemy && bb.enemy.status && bb.enemy.status.stunned);
        }),
        Guard('enemy-visible', function (bb) { return !!bb.enemyTank; }),
        Action('do-stun-followup', function (bb) {
          if (bb.shotDir) {
            if (bb.gunIsReady && bb.myDir === bb.shotDir) { bbSpeak(bb, '晕杀!'); bbFire(bb); }
            else if (bb.myDir !== bb.shotDir) bbTurnToward(bb, bb.shotDir);
          } else {
            // 帧预算门控：剩余眩晕帧内走到射线位+转向+开火算得过来才追。
            // 算不过来就不走进贴脸——眩晕一过自己成活靶(mat_BlS0:追5步到贴脸,眩晕耗尽被双弹秒)。
            var cast = bb.memory.stunCastFrame;
            var remain = (cast != null) ? (cast + 6 - bb.frame) : 6;
            if (stunKillReachable(bb.myPos, bb.enemyPos, bb.game, remain)) {
              var step = nextStepToFiringLane(bb.myPos, bb.enemyPos, bb.game, 1);
              if (step) bbMoveToward(bb, step);
            }
            // 杀不掉:不动(让位给后续抢星/保持距离层),绝不贴脸送死
          }
        })
      ])
    );
  }

  // ---- Overload-fire: 同线 + 过载 → 双弹覆盖 ----
  if (mySkillType === 'overload') {
    // 预过载蓄力：近距时先开过载存着
    children.push(
      Sequence('overload-prep', [
        Guard('enemy-visible', function (bb) { return !!bb.enemyTank; }),
        Guard('close-range', function (bb) { return bb.distToEnemy <= mp.overloadRange; }),
        Guard('overload-ready', function (bb) { return canOverload(bb.me); }),
        Guard('gun-ready', function (bb) { return bb.gunIsReady; }),
        // vs 护盾等需要已对准才过载（避免过载后10帧内找不到射线浪费）
        Guard('has-or-near-shot', function (bb) {
          if (bb.shotDir) return true;
          if (overloadOffsetShotDir(bb.myPos, bb.enemyPos, bb.game)) return true;
          if (mp.overloadRequireShot) return false;
          return hasNearbyFiringLane(bb.myPos, bb.enemyPos, bb.game, 2);
        }),
        // vs 护盾流：等盾碎再过载
        Guard('enemy-not-shielded', function (bb) {
          if (!mp.overloadWaitShield) return true;
          return !(bb.enemy && bb.enemy.status && bb.enemy.status.shielded);
        }),
        Guard('no-self-danger', function (bb) {
          if (anyBulletThreatens(bb.enemyBullets, bb.myPos, bb.game)) return false;
          // 技能激活占1帧无法移动：若敌正瞄准我且能开火，距离≤4格(2帧内到)则不激活
          if (bb.enemyTank && enemyAimsAt(bb.myPos, bb.enemyTank, bb.game) &&
              enemyCanFireSoon(bb.enemy) && bb.distToEnemy <= 4) return false;
          return true;
        }),
        Action('do-overload-prep', function (bb) {
          bbSpeak(bb, '过载!');
          bbUseSkill(bb, 'overload');
        })
      ])
    );

    // 过载后续：已过载 + 有射线 → 立即开火（主弹+副弹都命中）
    children.push(
      Sequence('overload-fire', [
        Guard('is-overloaded', function (bb) {
          return !!(bb.me.status && bb.me.status.overloaded);
        }),
        Guard('has-clear-shot', function (bb) { return !!bb.shotDir && bb.gunIsReady; }),
        Guard('can-shoot', function (bb) { return canShoot(bb.me, bb.enemy); }),
        Action('do-overload-fire', function (bb) {
          if (bb.myDir === bb.shotDir) { bbSpeak(bb, '双弹!'); bbFire(bb); }
          else bbTurnToward(bb, bb.shotDir);
        })
      ])
    );

    // 过载错位射击：已过载 + 敌在 +1 偏移线 → 副弹命中（主弹走空，副弹打人）
    // 利用3格宽弹道优势：敌人以为不同线安全，副弹恰好覆盖
    children.push(
      Sequence('overload-offset-fire', [
        Guard('is-overloaded', function (bb) {
          return !!(bb.me.status && bb.me.status.overloaded);
        }),
        Guard('no-direct-shot', function (bb) { return !bb.shotDir; }),
        Guard('gun-ready', function (bb) { return bb.gunIsReady; }),
        Guard('has-offset-shot', function (bb) {
          bb._overloadOffsetDir = overloadOffsetShotDir(bb.myPos, bb.enemyPos, bb.game);
          return !!bb._overloadOffsetDir;
        }),
        Guard('can-shoot', function (bb) { return canShoot(bb.me, bb.enemy); }),
        Action('do-overload-offset', function (bb) {
          var dir = bb._overloadOffsetDir;
          if (bb.myDir === dir) { bbSpeak(bb, '错位双弹!'); bbFire(bb); }
          else bbTurnToward(bb, dir);
        })
      ])
    );
  }

  // ---- Poison-fire: 近距 + 下毒 → 趁敌变慢开火 ----
  if (mySkillType === 'poison') {
    children.push(
      Sequence('poison-fire', [
        Guard('enemy-visible', function (bb) { return !!bb.enemyTank; }),
        Guard('close-range', function (bb) { return bb.distToEnemy <= mp.poisonRange; }),
        Guard('poison-ready', function (bb) { return canPoison(bb.me, bb.enemy); }),
        Guard('has-or-near-shot', function (bb) {
          if (bb.shotDir) return true;
          var dx = Math.abs(bb.myPos[0] - bb.enemyPos[0]);
          var dy = Math.abs(bb.myPos[1] - bb.enemyPos[1]);
          return dx <= 2 || dy <= 2;
        }),
        Guard('no-self-danger', function (bb) {
          return !anyBulletThreatens(bb.enemyBullets, bb.myPos, bb.game);
        }),
        Action('do-poison-fire', function (bb) {
          bbSpeak(bb, '下毒!');
          bbUseSkill(bb, 'poison');
        })
      ])
    );

    // 中毒后续：敌人中毒时抓紧开火（变慢难躲）
    children.push(
      Sequence('poison-followup', [
        Guard('enemy-poisoned', function (bb) {
          return !!(bb.enemy && bb.enemy.effects && bb.enemy.effects.debuff &&
                    bb.enemy.effects.debuff.type === 'poison');
        }),
        Guard('gun-ready', function (bb) { return bb.gunIsReady; }),
        Guard('enemy-visible', function (bb) { return !!bb.enemyTank; }),
        Guard('has-clear-shot', function (bb) { return !!bb.shotDir; }),
        Guard('can-shoot', function (bb) { return canShoot(bb.me, bb.enemy); }),
        Action('do-poison-followup', function (bb) {
          if (bb.myDir === bb.shotDir) { bbSpeak(bb, '毒杀!'); bbFire(bb); }
          else bbTurnToward(bb, bb.shotDir);
        })
      ])
    );
  }

  // ---- Cloak 系列：隐身蹲草（高优先）→ 隐身偷袭（近距兜底）----
  if (mySkillType === 'cloak') {
    // 隐身蹲草：有星时隐身走向星附近草丛卡位，等敌人追星时伏击
    children.push(
      Sequence('cloak-bush-ambush', [
        Guard('cloak-ready-cba', function (bb) { return canCloak(bb.me); }),
        Guard('not-already-in-bush', function (bb) {
          return !iAmHidden(bb.me, bb.game);
        }),
        Guard('has-bush-target', function (bb) { return !!senseCloakBushPosition(bb); }),
        Guard('no-self-danger-cba', function (bb) {
          if (anyBulletThreatens(bb.enemyBullets, bb.myPos, bb.game)) return false;
          if (bb.enemyTank && enemyAimsAt(bb.myPos, bb.enemyTank, bb.game) &&
              enemyCanFireSoon(bb.enemy) && bb.distToEnemy <= 4) return false;
          return true;
        }),
        Action('do-cloak-bush', function (bb) {
          var bushPos = senseCloakBushPosition(bb);
          bbSpeak(bb, '潜伏!');
          bbUseSkill(bb, 'cloak');
          bb.memory.cloakBushTarget = {
            pos: bushPos.slice(),
            star: bb.star ? bb.star.slice() : null,
            frame: bb.frame
          };
        })
      ])
    );

    // 隐身偷袭：无星/无草可蹲时近距直冲（vs cloak镜像对局禁用）
    if (mp.cloakSneakEnabled) {
      children.push(
        Sequence('cloak-sneak', [
          Guard('enemy-visible', function (bb) { return !!bb.enemyTank; }),
          Guard('not-on-shot-line', function (bb) { return !bb.shotDir; }),
          Guard('not-about-to-ambush', function (bb) {
            // 我正蹲草 + 敌即将穿过我的伏击射线 → 别开隐身奔袭,留草里等撞线。
            // 隐身奔袭去追一个会撞我现成炮线的敌=主动放弃免费伏击+白耗技能。
            // 根因 mat_4arB: 我蹲[5,2],敌沿row4左行将于[5,4]穿我第5列(canAmbushPreAim→down),
            // 但 cloak-sneak(优先级6)抢在 bush-hold(11)前开隐身,把我从第5列拽到第6列追屁股,
            // 隐身6帧一炮没放。蹲草伏击敌看不见我不会躲,命中率更高且不耗 cloak。
            if (!iAmHidden(bb.me, bb.game)) return true;
            if (canAmbushPreAim(bb.myPos, bb.myDir, bb.enemyTank, bb.star, bb.game)) return false;
            if (canAmbushLeadShot(bb.myPos, bb.myDir, bb.enemyTank, bb.game)) return false;
            return true;
          }),
          Guard('close-range', function (bb) { return bb.distToEnemy <= mp.cloakSneakRange; }),
          Guard('cloak-ready', function (bb) { return canCloak(bb.me); }),
          Guard('gun-ready', function (bb) { return bb.gunIsReady; }),
          Guard('no-self-danger', function (bb) {
            if (anyBulletThreatens(bb.enemyBullets, bb.myPos, bb.game)) return false;
            if (bb.enemyTank && enemyAimsAt(bb.myPos, bb.enemyTank, bb.game) &&
                enemyCanFireSoon(bb.enemy) && bb.distToEnemy <= 4) return false;
            return true;
          }),
          Action('do-cloak-sneak', function (bb) {
            bbSpeak(bb, '潜行!');
            bbUseSkill(bb, 'cloak');
          })
        ])
      );
    }

    // 隐身状态下的伏击：已隐身 + 有射线 → 直接开火
    children.push(
      Sequence('cloak-ambush', [
        Guard('is-cloaked', function (bb) {
          return !!(bb.me.status && bb.me.status.cloaked);
        }),
        Guard('enemy-visible', function (bb) { return !!bb.enemyTank; }),
        Guard('gun-ready', function (bb) { return bb.gunIsReady; }),
        Guard('has-clear-shot', function (bb) { return !!bb.shotDir; }),
        Guard('can-shoot', function (bb) { return canShoot(bb.me, bb.enemy); }),
        Action('do-cloak-ambush', function (bb) {
          if (bb.myDir === bb.shotDir) { bbSpeak(bb, '偷袭!'); bbFire(bb); }
          else bbTurnToward(bb, bb.shotDir);
        })
      ])
    );

    // 隐身移动：已隐身 + 无射线 → 移动到射线位
    children.push(
      Sequence('cloak-move-to-lane', [
        Guard('is-cloaked', function (bb) {
          return !!(bb.me.status && bb.me.status.cloaked);
        }),
        Guard('not-cloak-bushing', function (bb) {
          // 隐身奔草途中不抢控制权：cloak-bush-ambush 已设伏击草目标且尚未到达时,
          // 让位给 cloak-bush-hold(movement层)全程奔草,否则会被拽去贴脸导致隐身期不进草
          // (mat_KxUDSb: 开隐身后 cloak-move-to-lane 立刻接管贴脸,坦克永远奔敌不奔草)。
          var t = bb.memory.cloakBushTarget;
          if (t && bb.frame - t.frame <= 8 && !samePos(bb.myPos, t.pos)) return false;
          return true;
        }),
        Guard('enemy-visible', function (bb) { return !!bb.enemyTank; }),
        Guard('no-shot', function (bb) { return !bb.shotDir; }),
        Action('do-cloak-move', function (bb) {
          var rearDir = oppositeDir(bb.enemyTank.direction);
          // 学 Wraith 贴脸流（mat_IPCTB3G1tD58lkHdK）：隐身期绕到背后近身，到期秒射。
          // 但贴到2格对 freeze(被冻秒)/boost(快速反扑)反噬(bench -3.8/-2.5pp)，
          // 仅对 overload/shield 这类无快速反制的敌用更近地板(2)，其余保持默认(3)。
          var es = (bb.enemy && bb.enemy.skill && bb.enemy.skill.type) || null;
          var floor = (es === 'overload' || es === 'shield') ? 2 : undefined;
          var step = nextStepToFiringLane(bb.myPos, bb.enemyPos, bb.game, 1, rearDir, 8, floor);
          if (step) bbMoveToward(bb, step);
        })
      ])
    );
  }

  // ---- Shield-mirror-rush: 敌方开盾逼近时我方也开盾对抗 ----
  if (mySkillType === 'shield') {
    children.push(
      Sequence('shield-mirror-rush', [
        Guard('enemy-shielded', function (bb) {
          return !!(bb.enemyTank && bb.enemy && bb.enemy.status && bb.enemy.status.shielded);
        }),
        Guard('shield-ready', function (bb) { return canShieldSkill(bb.me); }),
        Guard('not-stunned', function (bb) {
          return !(bb.me.status && bb.me.status.stunned);
        }),
        Guard('enemy-close', function (bb) { return bb.distToEnemy <= 6; }),
        Action('do-shield-mirror', function (bb) {
          bbSpeak(bb, '盾对盾!');
          bbUseSkill(bb, 'shield');
        })
      ])
    );
  }

  // ---- Shield-counter: 与敌同线 → 开盾安全对射 ----
  if (mySkillType === 'shield') {
    children.push(
      Sequence('shield-counter', [
        Guard('enemy-visible', function (bb) { return !!bb.enemyTank; }),
        Guard('not-stunned', function (bb) {
          return !(bb.me.status && bb.me.status.stunned);
        }),
        Guard('has-clear-shot', function (bb) { return !!bb.shotDir; }),
        Guard('gun-ready', function (bb) { return bb.gunIsReady; }),
        Guard('can-shoot', function (bb) { return canShoot(bb.me, bb.enemy); }),
        Guard('shield-ready', function (bb) { return canShieldSkill(bb.me); }),
        Guard('enemy-aims-at-me', function (bb) {
          return enemyAimsAt(bb.myPos, bb.enemyTank, bb.game);
        }),
        Guard('close-range', function (bb) { return bb.distToEnemy <= mp.shieldCounterRange; }),
        // 盾碎后反击可行性（shield-two-hit 2026-06-27：盾挡 2 发才碎）：
        //   盾击站位窗口很短(myCounterFrames=转向+开火≤3帧)。窗口内敌受开火锁(≈3帧)限制最多补
        //   1 发,被盾第 1 层吸收;要打穿需第 2 发,隔装弹(≈3帧)到达必 > 窗口。故 2 发盾下盾击恒安全。
        //   旧 1 发盾时:敌补 1 发即碎盾、第 2 发就能杀,所以 enemyNextHit<=myCounter 就放弃。
        //   现按 2 层建模:仅当敌能在我反击前打满 2 发(打穿双层)才放弃(实际几乎不可能)。
        Guard('can-counter-after-shield', function (bb) {
          var turnFrames = turnDistance(bb.myDir, bb.shotDir);
          var myCounterFrames = turnFrames + 1; // 转向+开火，子弹还要飞
          // 敌人下一发到达我的帧数：距离/弹速 (距离1时 = 1帧就到)
          var enemyNextHitFrames = Math.ceil(bb.distToEnemy / BULLET_SPEED);
          if (enemyCanFireSoon(bb.enemy)) {
            // 第 2 发需隔开火锁(≈3帧)才能再射 → 打穿双层盾的那一发到达帧
            var enemyBreakThroughFrames = enemyNextHitFrames + 3;
            if (enemyBreakThroughFrames <= myCounterFrames) return false;
          }
          return true;
        }),
        Action('do-shield-counter', function (bb) {
          bbSpeak(bb, '盾击!');
          bbUseSkill(bb, 'shield');
        })
      ])
    );

    // 护盾后续：开盾中 + 有射线 → 安全开火
    children.push(
      Sequence('shield-fire', [
        Guard('is-shielded', function (bb) {
          return !!(bb.me.status && bb.me.status.shielded);
        }),
        Guard('has-clear-shot', function (bb) { return !!bb.shotDir && bb.gunIsReady; }),
        Guard('can-shoot', function (bb) { return canShoot(bb.me, bb.enemy); }),
        Action('do-shield-fire', function (bb) {
          if (bb.myDir === bb.shotDir) { bbSpeak(bb, '盾射!'); bbFire(bb); }
          else bbTurnToward(bb, bb.shotDir);
        })
      ])
    );

    // 护盾逼近：开盾中 + 无射线 → 利用无敌时间逼近到射线位
    children.push(
      Sequence('shield-advance', [
        Guard('is-shielded', function (bb) {
          return !!(bb.me.status && bb.me.status.shielded);
        }),
        Guard('enemy-visible', function (bb) { return !!bb.enemyTank; }),
        Guard('no-shot-line', function (bb) { return !bb.shotDir; }),
        Action('do-shield-advance', function (bb) {
          var step = nextStepToFiringLane(bb.myPos, bb.enemyPos, bb.game, 2);
          if (step) bbMoveToward(bb, step);
        })
      ])
    );

    // 护盾主动冲拼（用户方案②）：未开盾 + 当前无射线 + 差1步到射线位 + 裸走进位会被秒
    //   → 主动开盾顶着冲这关键一步。下帧由 shield-advance 逼近、shield-fire 开火。
    //
    // 帧预算：开盾占当帧（不能同时移动），盾期 4 帧实际只够"走1步+转向+开火"，
    // 所以仅"1步即到射线位"时先开盾再冲赶得及；差≥2步盾会先失效（那种远距
    // 留给"先裸走逼近、敌弹来时再开盾"——已由 shield-block/shield-hold 覆盖）。
    //
    // 口径统一：one-step 与 deadly 都基于 nextStepToFiringLane(...,2) 的第一步，
    // 与下帧 shield-advance 完全同口径（minDistFloor=3，找 dist>=3 的射线位），
    // 避免"算的进位格 ≠ 实际走的格"。step 本身有射线 = 走1步就到射线位。
    //
    // 省盾哲学（同①）：裸走进位本就安全（敌没瞄那格 / 敌不能即射）就不烧稀缺盾，
    // 让 movement 层裸走逼近；只有"这一步进位会被秒"时盾才有真实续命价值。
    children.push(
      Sequence('shield-rush', [
        Guard('enemy-visible', function (bb) { return !!bb.enemyTank; }),
        Guard('not-shielded', function (bb) {
          return !(bb.me.status && bb.me.status.shielded);
        }),
        Guard('no-shot-line', function (bb) { return !bb.shotDir; }),
        Guard('gun-ready', function (bb) { return bb.gunIsReady; }),
        Guard('shield-ready', function (bb) { return canShieldSkill(bb.me); }),
        Guard('rush-step-deadly', function (bb) {
          // 与 shield-advance 同口径取第一步；走1步即到射线位(step有射线)才算赶得及，
          // 且该进位格被敌瞄准+敌能即射(裸走被秒)→开盾顶着冲；否则不烧盾让 movement 裸走
          var step = nextStepToFiringLane(bb.myPos, bb.enemyPos, bb.game, 2);
          if (!step) return false;
          if (!clearShotDirection(step, bb.enemyPos, bb.game)) return false; // 差>=2步,盾先失效
          return enemyAimsAt(step, bb.enemyTank, bb.game) && enemyCanFireSoon(bb.enemy);
        }),
        Action('do-shield-rush', function (bb) {
          bbSpeak(bb, '冲!');
          bbUseSkill(bb, 'shield');
        })
      ])
    );
  }

  // ---- Boost-chase-attack: 加速移到射线位开火 ----
  if (mySkillType === 'boost') {
    children.push(
      Sequence('boost-chase-attack', [
        Guard('enemy-visible', function (bb) { return !!bb.enemyTank; }),
        Guard('not-on-shot-line', function (bb) { return !bb.shotDir; }),
        Guard('not-leading-with-star', function (bb) {
          if (bb.myStars - bb.enmStars >= 2) return false;
          if (bb.star && enemySkillType === 'teleport' && bb.distToStar <= 3) return false;
          if (enemySkillType === 'overload' && bb.isWinning) return false;
          return true;
        }),
        Guard('medium-range', function (bb) {
          return bb.distToEnemy <= mp.boostChaseRange && bb.distToEnemy >= 3;
        }),
        Guard('boost-ready', function (bb) { return canBoost(bb.me); }),
        Guard('gun-ready', function (bb) { return bb.gunIsReady; }),
        Guard('no-self-danger', function (bb) {
          if (anyBulletThreatens(bb.enemyBullets, bb.myPos, bb.game)) return false;
          if (bb.enemyTank && enemyAimsAt(bb.myPos, bb.enemyTank, bb.game) &&
              enemyCanFireSoon(bb.enemy) && bb.distToEnemy <= 4) return false;
          return true;
        }),
        Action('do-boost-chase', function (bb) {
          bbSpeak(bb, '加速攻!');
          bbUseSkill(bb, 'boost');
        })
      ])
    );

    // boost 甩狙：加速中 + 同行/列 + 只差90°转向 → turn+fire 同帧
    children.push(
      Sequence('boost-flick-shot', [
        Guard('is-boosted', function (bb) {
          return !!(bb.me.status && bb.me.status.boosted);
        }),
        Guard('enemy-visible', function (bb) { return !!bb.enemyTank; }),
        Guard('gun-ready', function (bb) { return bb.gunIsReady; }),
        Guard('can-shoot', function (bb) { return canShoot(bb.me, bb.enemy); }),
        Guard('not-on-shot-line', function (bb) { return !bb.shotDir; }),
        Guard('flick-available', function (bb) {
          var flickDir = clearShotDirection(bb.myPos, bb.enemyPos, bb.game);
          if (!flickDir) return false;
          if (turnDistance(bb.myDir, flickDir) !== 1) return false;
          bb._cache._flickDir = flickDir;
          return true;
        }),
        Guard('no-self-danger', function (bb) {
          return !anyBulletThreatens(bb.enemyBullets, bb.myPos, bb.game);
        }),
        Action('do-flick-shot', function (bb) {
          bbSpeak(bb, '甩狙!');
          bbTurnToward(bb, bb._cache._flickDir);
          bbFire(bb);
        })
      ])
    );
  }

  if (children.length === 0) return null;
  // 眩晕期间抑制 debuff 技能(freeze/stun/poison/overload)：
  // 技能本身不被逆转，但后续走位被随机化。对于 freeze：
  //   - 已对准(myDir===shotDir)时冻了仍能下帧射(fire不被逆转) → 允许
  //   - 没对准时冻了无法转向追杀 → 阻止
  //   - combo-followup(子弹在飞)时 → 允许
  // 对于 stun/poison/overload：统一阻止（需要后续精确操作才有价值）。
  var debuffSkills = { freeze: 1, stun: 1, poison: 1, overload: 1 };
  if (debuffSkills[mySkillType]) {
    return Sequence('skill-attack-gate', [
      Guard('not-stunned-or-aimed', function (bb) {
        if (!(bb.me.status && bb.me.status.stunned)) return true;
        // 被晕中的例外：
        if (bb.memory && bb.memory._firedForFreeze === bb.frame - 1) return true;
        if (mySkillType === 'freeze' && bb.shotDir && bb.myDir === bb.shotDir && bb.gunIsReady) return true;
        return false;
      }),
      Selector('skill-attack', children)
    ]);
  }
  return Selector('skill-attack', children);
}


// ================================================================
// 3. 技能目标节点 — 插入 attack 和 objective 之间
// ================================================================

function createSkillObjectiveNodes(mySkillType, enemySkillType) {
  enemySkillType = enemySkillType || 'stun';
  var mp = getSkillMatchupParams(mySkillType, enemySkillType);
  var children = [];

  // ---- Boost-star-rush: 加速冲星（go() 走2格）----
  // 策略：只在高置信能先到时才冲星，否则留 CD 给甩狙
  if (mySkillType === 'boost') {
    children.push(
      Sequence('boost-star-rush', [
        Guard('star-exists', function (bb) { return !!bb.star; }),
        Guard('boost-ready', function (bb) { return canBoost(bb.me); }),
        Guard('star-distance', function (bb) { return bb.distToStar >= 3; }),
        Guard('no-self-danger', function (bb) {
          if (anyBulletThreatens(bb.enemyBullets, bb.myPos, bb.game)) return false;
          if (bb.enemyTank && enemyAimsAt(bb.myPos, bb.enemyTank, bb.game) &&
              enemyCanFireSoon(bb.enemy) && bb.distToEnemy <= 4) return false;
          return true;
        }),
        Guard('not-tp-unwinnable', function (bb) {
          if (enemySkillType !== 'teleport') return true;
          if (!enemyTeleportReady(bb.enemy)) return true;
          if (!bb.enemyTank) return true;
          var enemyStarDist = manhattan(bb.enemyPos, bb.star);
          return bb.distToStar < enemyStarDist - 1;
        }),
        // 竞速判定：boost 给予约6步有效优势（6帧×1额外步）
        // 对传送敌另有 not-tp-unwinnable 专门处理，此处保持宽泛允许冲星
        Guard('star-race-winnable', function (bb) {
          if (!bb.enemyTank) return true;
          var enemyStarDist = manhattan(bb.enemyPos, bb.star);
          return bb.distToStar <= enemyStarDist + 6;
        }),
        // 竞争激烈时才用：敌人也在追星或距星差不多（不浪费在无竞争的安全星上）
        Guard('star-contested', function (bb) {
          if (!bb.enemyTank) return true;
          var enemyStarDist = manhattan(bb.enemyPos, bb.star);
          return enemyStarDist <= bb.distToStar + 3;
        }),
        Guard('endpoint-safe', function (bb) {
          if (!bb.enemyTank) return true;
          var starEnemyDist = manhattan(bb.star, bb.enemyPos);
          if (starEnemyDist <= 3 && enemyCanFireSoon(bb.enemy)) return false;
          if (starEnemyDist <= 5 && enemyCanFireSoon(bb.enemy)) {
            var shotToStar = clearShotDirection(bb.enemyPos, bb.star, bb.game);
            if (shotToStar) return false;
          }
          var myEnemyDist = bb.distToEnemy;
          if (myEnemyDist <= 8 && enemyCanFireSoon(bb.enemy)) {
            var step = nextStepToward(bb.myPos, bb.star, bb.game, bb.enemyPos);
            if (step) {
              var stepDir = directionBetween(bb.myPos, step);
              if (stepDir) {
                var dv = { up: [0, -1], down: [0, 1], left: [-1, 0], right: [1, 0] }[stepDir];
                for (var look = 1; look <= 6; look++) {
                  var proj = [bb.myPos[0] + dv[0] * look, bb.myPos[1] + dv[1] * look];
                  if (!inBounds(proj, bb.game)) break;
                  if (manhattan(proj, bb.enemyPos) <= 2) return false;
                }
              }
            }
          }
          return true;
        }),
        Action('do-boost-star', function (bb) {
          bbSpeak(bb, '加速星!');
          bbUseSkill(bb, 'boost');
        })
      ])
    );

    // 加速中的追星：已加速 → 朝星的真实走向前进（走2格）。
    // 旧实现用 directionBetween(只对相邻格有效)+path-safe 卡当前朝向，星远时
    // directionBetween 恒 null、path-safe 又按"当前朝向"判定：需要转向才能去星时
    // 整个节点失败、回落蹲草，6帧 boost 站桩浪费(mat_28DHb)。改为 BFS 取下一步真实
    // 走向：未对准先转(转向原地不进入危险)，已对准再按"实际前进方向"判 boostPathSafe。
    children.push(
      Sequence('boost-star-go', [
        Guard('is-boosted', function (bb) {
          return !!(bb.me.status && bb.me.status.boosted);
        }),
        Guard('star-exists', function (bb) { return !!bb.star; }),
        Guard('has-path-to-star', function (bb) {
          var step = nextStepToward(bb.myPos, bb.star, bb.game, bb.enemyPos);
          if (!step) return false;
          bb._cache._boostStarStep = step;
          return true;
        }),
        Action('do-boost-go', function (bb) {
          var step = bb._cache._boostStarStep;
          var goDir = directionBetween(bb.myPos, step);
          if (!goDir) { bbMoveToward(bb, bb.star); return; }
          // 已对准：前进方向安全才 go(走2格)，否则交回常规安全移动(走1格)
          if (bb.myDir === goDir) {
            if (boostPathSafe(bb.myPos, goDir, bb.game, bb.enemyPos, bb.enemyBullets, bb.enemyTank, bb.enemy, bb.memory)) bb.me.go();
            else bbMoveToward(bb, bb.star);
            return;
          }
          // 未对准：boost 免费转向窗口(06-01加强)——单次90°转向时同帧 turn+go,
          // 引擎合并成 turnGo(转后朝新方向走2格)，不再白丢一帧只转不走。
          // 仅当(a)只需转1次(180°掉头吃不到免费窗口) 且 (b)转后方向安全 才组合;
          // 否则照常只转向(下一帧再走)。
          if (turnDistance(bb.myDir, goDir) === 1 &&
              boostPathSafe(bb.myPos, goDir, bb.game, bb.enemyPos, bb.enemyBullets, bb.enemyTank, bb.enemy, bb.memory)) {
            bbTurnToward(bb, goDir);
            bb.me.go();
          } else {
            bbTurnToward(bb, goDir);
          }
        })
      ])
    );
  }

  // ---- Cloak-star: 隐身偷星 ----
  if (mySkillType === 'cloak') {
    children.push(
      Sequence('cloak-star', [
        Guard('star-exists', function (bb) { return !!bb.star; }),
        Guard('cloak-ready', function (bb) { return canCloak(bb.me); }),
        Guard('star-contested', function (bb) {
          if (!bb.enemyTank) return false;
          var enemyStarDist = manhattan(bb.enemyPos, bb.star);
          return enemyStarDist <= bb.distToStar + 2 + mp.skillStarContestDelta && bb.distToStar <= 6;
        }),
        Guard('not-hidden-losing-star', function (bb) {
          // 已藏草蹲守时,若这颗星敌人更近(真抢不到)→别开隐身出草白费+暴露,留在草里
          // 蹲守等敌来抢星时伏击更优(mat_KxUDSb f72:草[14,7]距星5,敌距星4更近,出草追星
          // f89 仍被敌先收,隐身白开还丢伏击位)。窄门控:仅"已藏草+敌更近"才让位,不丢可抢星权。
          if (!iAmHidden(bb.me, bb.game)) return true;
          if (!bb.enemyTank) return true;
          var eStarDist = manhattan(bb.enemyPos, bb.star);
          if (eStarDist < bb.distToStar) return false;
          return true;
        }),
        Guard('no-self-danger', function (bb) {
          if (anyBulletThreatens(bb.enemyBullets, bb.myPos, bb.game)) return false;
          if (bb.enemyTank && enemyAimsAt(bb.myPos, bb.enemyTank, bb.game) &&
              enemyCanFireSoon(bb.enemy) && bb.distToEnemy <= 4) return false;
          return true;
        }),
        Action('do-cloak-star', function (bb) {
          bbSpeak(bb, '隐身星!');
          bbUseSkill(bb, 'cloak');
        })
      ])
    );
  }

  // ---- Shield-star-rush: 开盾冲星（竞争抢星时勇敢开盾）----
  if (mySkillType === 'shield') {
    children.push(
      Sequence('shield-star-rush', [
        Guard('star-exists', function (bb) { return !!bb.star; }),
        Guard('not-stunned', function (bb) {
          return !(bb.me.status && bb.me.status.stunned);
        }),
        Guard('shield-ready', function (bb) { return canShieldSkill(bb.me); }),
        Guard('star-close', function (bb) { return bb.distToStar <= 6; }),
        // stun 敌人同线近距 + stun 就绪 → 不冲（stun 先手使盾失效）
        Guard('no-stun-preempt', function (bb) {
          if (!bb.enemyTank || !enemyIsStunType(bb.enemy)) return true;
          if (bb.enemy.skill && bb.enemy.skill.remainingCooldownFrames > 0) return true;
          if (!clearShotDirection(bb.enemyPos, bb.myPos, bb.game)) return true;
          return bb.distToEnemy > 5;
        }),
        // overload 守星陷阱：盾期赶不到的星不该烧盾冲。
        // 根因 mat_zzzzzz(f17 crashed)：星[15,2]紧贴 overload 敌[15,5]同列(双弹覆盖带)，
        //   f10 我[10,2]离星 distToStar=5，shield-star-rush 因"敌离星(d=3)比我(d=5)近"开盾冲星。
        //   但盾仅4帧、星5步根本赶不到；盾下 shield-advance 推进到 d=3 双弹带，f14 盾过期，f13
        //   敌过载，f15-16 双弹覆盖我列 x=12 → f17 被秒。盾白花在赶不到的贴敌星上。
        // 两个子条件前提不同:
        //   ① distToStar>4(盾4帧赶不到)——盾时长不变,保留。
        //   ② 星在双弹带——【shield-two-hit 2026-06-27 适配】2 发盾能同时吸收 overload 一次齐射
        //      (主弹+副弹同帧=2 发) → 星在双弹带不再必死,前提是盾窗能覆盖到拿星(distToStar<=3,
        //      否则盾在最后一步前过期、裸进双弹带被秒)。旧(1发盾):双弹带一律拦(副弹秒你拿不到星)。
        //      现:distToStar<=3 的双弹带星照常开盾冲(2发盾扛齐射、抢到星);distToStar=4 仍拦(盾覆盖不到)。
        Guard('no-overload-star-trap', function (bb) {
          if (!enemyIsOverloadType(bb.enemy)) return true;
          if (bb.distToStar > 4) return false;
          if (bb.enemyPos && inDoubleLaneBand(bb.enemyPos, bb.star, 4) && bb.distToStar > 3) return false;
          return true;
        }),
        // 存在竞争或威胁就开盾（不要求敌人必须瞄我）
        Guard('star-contested-or-dangerous', function (bb) {
          // 有子弹正飞来 → 开盾挡
          if (anyBulletThreatens(bb.enemyBullets, bb.myPos, bb.game)) return true;
          if (!bb.enemyTank) return false;
          // 敌人瞄着我
          if (enemyAimsAt(bb.myPos, bb.enemyTank, bb.game) && bb.distToEnemy <= 6) return true;
          // 敌人也在追星（距星差不多或比我近）→ 仅当盾窗能覆盖拿星瞬间才开
          // 根因 mat_AlSqd/mat_Ak0(f9 开盾)：distToStar=6、无在途弹、敌没瞄我，仅凭"敌也在抢星"
          //   就开盾。但盾仅 4 帧(cast 占当帧+3 步移动≈管 3 格)，dist=6 时盾 f13 过期、离星还 2~3
          //   格，盾纯浪费；真致命弹 f20~22 来时盾早没了→挨 1 炮死。符合"盾留给躲不掉的弹"。
          //   故纯距离竞争分支加盾窗门控：只有 distToStar<=3(盾能覆盖拿星)才因竞争开盾；远距
          //   纯推测留盾不烧。在途弹/敌瞄我两条具体威胁分支不动(dist6 照常挡真弹)。
          //   阈值 3 = 盾 4 帧 - cast 占当帧 = 剩 3 步移动可达星。
          var enemyStarDist = manhattan(bb.enemyPos, bb.star);
          if (enemyStarDist <= bb.distToStar + 2 && bb.distToStar <= 3) return true;
          // 追星路径经过敌人射线
          var starPath = shortestPathInfo(bb.myPos, bb.star, bb.game, bb.enemyPos);
          if (starPath && starPath.step && clearShotDirection(bb.enemyPos, starPath.step, bb.game)) return true;
          return false;
        }),
        Action('do-shield-star', function (bb) {
          bbSpeak(bb, '盾星!');
          bbUseSkill(bb, 'shield');
        })
      ])
    );
  }

  // ---- Freeze-ambush：蹲草伏击（通用策略） ----
  if (mySkillType === 'freeze') {
    // 敌人比我更快到星时，与其正面竞速不如蹲在星附近草丛：
    //   敌来抢星进入射线 → 我已对准 → 开火+冰冻 = 击杀/重伤
    //   敌人看不到我（草丛隐身）→ 没有预判躲避能力
    // 触发条件：星存在 + 敌人比我更近星 + 星附近有合适草丛
    children.push(
      Sequence('freeze-ambush', [
        Guard('star-exists', function (bb) { return !!bb.star; }),
        Guard('ambush-viable-enemy', function (bb) {
          if (enemyIsOverloadType(bb.enemy)) return false;
          if (bb.enemy && bb.enemy.skill && bb.enemy.skill.type === 'shield') return false;
          if (bb.enemy && bb.enemy.skill && bb.enemy.skill.type === 'boost') return false;
          return true;
        }),
        Guard('enemy-faster-to-star', function (bb) {
          if (!bb.enemyPos) return true;
          var myDist = pathDistance(bb.myPos, bb.star, bb.game, bb.enemyPos);
          var eDist = manhattan(bb.enemyPos, bb.star);
          if (myDist < 0) return true;
          return eDist + 2 < myDist;
        }),
        Guard('not-already-ambush', function (bb) {
          var a = bb.memory._freezeAmbush;
          if (!a) return true;
          if (!bb.star || !samePos(bb.star, a.star)) { bb.memory._freezeAmbush = null; return true; }
          if (bb.frame - a.frame > 25) { bb.memory._freezeAmbush = null; return true; }
          if (samePos(bb.myPos, a.bush)) return false;
          return true;
        }),
        Guard('no-self-danger', function (bb) {
          return !anyBulletThreatens(bb.enemyBullets, bb.myPos, bb.game);
        }),
        Guard('has-ambush-bush', function (bb) {
          var a = bb.memory._freezeAmbush;
          if (a && bb.star && samePos(bb.star, a.star) && bb.frame - a.frame <= 25) {
            bb._cache._freezeAmbushBush = a.bush;
            return true;
          }
          var bush = findFreezeAmbushBush(bb.myPos, bb.star, bb.game, bb.enemyPos);
          if (!bush) return false;
          bb._cache._freezeAmbushBush = bush;
          return true;
        }),
        Action('do-freeze-ambush-move', function (bb) {
          var bush = bb._cache._freezeAmbushBush;
          if (!bb.memory._freezeAmbush || !samePos(bb.memory._freezeAmbush.bush, bush)) {
            bb.memory._freezeAmbush = { bush: bush, star: bb.star.slice(), frame: bb.frame };
          }
          bbSpeak(bb, '埋伏');
          var step = nextStepToward(bb.myPos, bush, bb.game, bb.enemyPos);
          if (step) bbMoveToward(bb, step);
        })
      ])
    );

    // 蹲守阶段：已到达草丛位，等待敌人出现
    children.push(
      Sequence('freeze-ambush-hold', [
        Guard('in-ambush-bush', function (bb) {
          var a = bb.memory._freezeAmbush;
          if (!a) return false;
          if (!bb.star || !samePos(bb.star, a.star)) { bb.memory._freezeAmbush = null; return false; }
          if (bb.frame - a.frame > 25) { bb.memory._freezeAmbush = null; return false; }
          return samePos(bb.myPos, a.bush) && iAmHidden(bb.me, bb.game);
        }),
        Guard('still-safe', function (bb) {
          return !anyBulletThreatens(bb.enemyBullets, bb.myPos, bb.game);
        }),
        Action('do-freeze-ambush-hold', function (bb) {
          if (bb.enemyTank && bb.gunIsReady) {
            var shotDir = clearShotDirection(bb.myPos, bb.enemyPos, bb.game);
            if (shotDir) {
              if (bb.myDir === shotDir) {
                if (canFreeze(bb.me, bb.enemy)) {
                  bbSpeak(bb, '伏击!'); bbFire(bb);
                  bb.memory._firedForFreeze = bb.frame;
                } else {
                  bbSpeak(bb, '伏击!'); bbFire(bb);
                }
              } else {
                if (canFreeze(bb.me, bb.enemy)) {
                  bbSpeak(bb, '冰伏!'); bbUseSkill(bb, 'freeze');
                } else {
                  bbTurnToward(bb, shotDir);
                }
              }
              bb.memory._freezeAmbush = null;
              return;
            }
          }
          var faceDir = clearShotDirection(bb.myPos, bb.star, bb.game);
          if (faceDir && bb.myDir !== faceDir) { bbTurnToward(bb, faceDir); return; }
          bbSpeak(bb, '蹲伏');
        })
      ])
    );
  }

  // ---- Stun-star: 抢星时眩晕竞争者 ----
  if (mySkillType === 'stun') {
    children.push(
      Sequence('stun-star', [
        Guard('star-exists', function (bb) { return !!bb.star; }),
        Guard('stun-ready', function (bb) { return canStun(bb.me, bb.enemy); }),
        Guard('enemy-visible', function (bb) { return !!bb.enemyTank; }),
        Guard('enemy-closer', function (bb) {
          var enemyStarDist = manhattan(bb.enemyPos, bb.star);
          return enemyStarDist <= bb.distToStar + mp.skillStarContestDelta && bb.distToStar <= 6;
        }),
        Guard('no-self-danger', function (bb) {
          return !anyBulletThreatens(bb.enemyBullets, bb.myPos, bb.game);
        }),
        Action('do-stun-star', function (bb) {
          bbSpeak(bb, '晕星!');
          bbUseSkill(bb, 'stun');
          bb.memory.stunCastFrame = bb.frame;
        })
      ])
    );
  }

  // ---- Poison-star: 抢星时下毒减慢敌人 ----
  if (mySkillType === 'poison') {
    children.push(
      Sequence('poison-star', [
        Guard('star-exists', function (bb) { return !!bb.star; }),
        Guard('poison-ready', function (bb) { return canPoison(bb.me, bb.enemy); }),
        Guard('enemy-visible', function (bb) { return !!bb.enemyTank; }),
        Guard('enemy-closer', function (bb) {
          var enemyStarDist = manhattan(bb.enemyPos, bb.star);
          return enemyStarDist <= bb.distToStar + mp.skillStarContestDelta && bb.distToStar <= 5;
        }),
        Guard('no-self-danger', function (bb) {
          return !anyBulletThreatens(bb.enemyBullets, bb.myPos, bb.game);
        }),
        Action('do-poison-star', function (bb) {
          bbSpeak(bb, '毒星!');
          bbUseSkill(bb, 'poison');
        })
      ])
    );
  }

  // ---- Overload 无专属目标节点（过载纯攻击，不辅助抢星） ----

  if (children.length === 0) return null;
  return Selector('skill-objective', children);
}
