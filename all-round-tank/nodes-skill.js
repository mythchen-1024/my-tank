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
  freezeKillRange: 4,        // 冰杀触发距离
  freezeKillRequireShot: false, // 是否要求已有射线才冻（vs护盾等需更严格）
  stunKillRange: 5,          // 晕杀触发距离
  overloadRange: 5,          // 过载触发距离
  overloadRequireShot: false,// 过载是否要求已对准（vs传送等需更谨慎）
  poisonRange: 5,            // 下毒触发距离
  cloakSneakRange: 6,       // 隐身潜行触发距离
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
    overload: { cloakSneakRange: 4 },
    // vs 冰冻流：隐身后敌人无法冻我（看不到），是好克制
    freeze:   { cloakSneakRange: 7 },
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
// 1. 技能逃生节点 — 插入 hard-survival 的 escape-teleport 之后
// ================================================================

function createSkillSurvivalNodes(mySkillType) {
  var children = [];

  // ---- Shield: 子弹来袭 + 无法移动躲开 → 开盾挡弹 ----
  if (mySkillType === 'shield') {
    children.push(
      Sequence('shield-block', [
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
      ])
    );
  }

  // ---- Freeze: 被追/被夹 → 冰冻敌人争取逃跑窗口 ----
  if (mySkillType === 'freeze') {
    children.push(
      Sequence('freeze-defense', [
        Guard('has-bullet-threat', function (bb) {
          return anyBulletThreatens(bb.enemyBullets, bb.myPos, bb.game);
        }),
        Guard('no-dodge', function (bb) { return !senseBulletDodge(bb); }),
        Guard('enemy-visible', function (bb) { return !!bb.enemyTank; }),
        Guard('freeze-ready', function (bb) { return canFreeze(bb.me, bb.enemy); }),
        Action('do-freeze-defense', function (bb) {
          bbSpeak(bb, '冰冻!');
          bbUseSkill(bb, 'freeze');
        })
      ])
    );
  }

  // ---- Stun: 被追/被夹 → 眩晕敌人后跑路 ----
  if (mySkillType === 'stun') {
    children.push(
      Sequence('stun-escape', [
        Guard('has-bullet-threat', function (bb) {
          return anyBulletThreatens(bb.enemyBullets, bb.myPos, bb.game);
        }),
        Guard('no-dodge', function (bb) { return !senseBulletDodge(bb); }),
        Guard('enemy-visible', function (bb) { return !!bb.enemyTank; }),
        Guard('stun-ready', function (bb) { return canStun(bb.me, bb.enemy); }),
        Action('do-stun-escape', function (bb) {
          bbSpeak(bb, '眩晕!');
          bbUseSkill(bb, 'stun');
        })
      ])
    );
  }

  // ---- Cloak: 被夹/无法躲 → 隐身后敌方丢失目标 ----
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

  // ---- Boost: 被追/被夹 → 加速逃离（双格移动拉开距离）----
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
          // 加速后下帧 go() 会走2格
        })
      ])
    );
  }

  // ---- Poison: 被追 + 无法拉开 → 下毒减速追击者 ----
  if (mySkillType === 'poison') {
    children.push(
      Sequence('poison-escape', [
        Guard('enemy-close-chasing', function (bb) {
          if (!bb.enemyTank) return false;
          if (bb.distToEnemy > 4) return false;
          // 敌人面朝我方向
          return !!bb.shotDir || enemyAimsAt(bb.myPos, bb.enemyTank, bb.game);
        }),
        Guard('has-bullet-threat', function (bb) {
          return anyBulletThreatens(bb.enemyBullets, bb.myPos, bb.game);
        }),
        Guard('no-dodge', function (bb) { return !senseBulletDodge(bb); }),
        Guard('poison-ready', function (bb) { return canPoison(bb.me, bb.enemy); }),
        Action('do-poison-escape', function (bb) {
          bbSpeak(bb, '下毒!');
          bbUseSkill(bb, 'poison');
        })
      ])
    );
  }

  if (children.length === 0) return null;
  return Selector('skill-survival', children);
}


// ================================================================
// 2. 技能攻击节点 — 插入 softSurvival 和 attack 之间
// ================================================================

function createSkillAttackNodes(mySkillType, enemySkillType) {
  enemySkillType = enemySkillType || 'stun';
  var mp = getSkillMatchupParams(mySkillType, enemySkillType);
  var children = [];

  // ---- Freeze-kill: 近距 + 同线/可同线 → 冰冻后瞄准开火 ----
  if (mySkillType === 'freeze') {
    children.push(
      Sequence('freeze-kill', [
        Guard('enemy-visible', function (bb) { return !!bb.enemyTank; }),
        Guard('close-range', function (bb) { return bb.distToEnemy <= mp.freezeKillRange; }),
        Guard('freeze-ready', function (bb) { return canFreeze(bb.me, bb.enemy); }),
        Guard('gun-ready', function (bb) { return bb.gunIsReady; }),
        Guard('can-shoot', function (bb) { return canShoot(bb.me, bb.enemy); }),
        // 敌人开盾时不冻（冻后开火也被盾挡，浪费冰冻）
        Guard('not-shielded', function (bb) {
          if (!mp.freezeAvoidShielded) return true;
          return !(bb.enemy && bb.enemy.status && bb.enemy.status.shielded);
        }),
        // 有射线或1步内可到射线（vs护盾等需更严格：必须有直接射线）
        Guard('has-or-near-shot', function (bb) {
          if (bb.shotDir) return true;
          if (mp.freezeKillRequireShot) return false; // 严格模式：必须有直接射线
          var dx = Math.abs(bb.myPos[0] - bb.enemyPos[0]);
          var dy = Math.abs(bb.myPos[1] - bb.enemyPos[1]);
          return dx <= 1 || dy <= 1;
        }),
        Guard('no-self-danger', function (bb) {
          return !anyBulletThreatens(bb.enemyBullets, bb.myPos, bb.game);
        }),
        Action('do-freeze-kill', function (bb) {
          if (bb.shotDir && bb.myDir === bb.shotDir) {
            bbSpeak(bb, '冰杀!');
            bbUseSkill(bb, 'freeze');
          } else if (bb.shotDir) {
            bbSpeak(bb, '冰冻!');
            bbUseSkill(bb, 'freeze');
          } else {
            var step = nextStepToFiringLane(bb.myPos, bb.enemyPos, bb.game, 1);
            if (step) bbMoveToward(bb, step);
          }
        })
      ])
    );

    // 冰冻后续：敌人被冻住时抓紧瞄准开火
    children.push(
      Sequence('freeze-followup', [
        Guard('enemy-frozen', function (bb) {
          return !!(bb.enemy && bb.enemy.status && bb.enemy.status.frozen);
        }),
        Guard('gun-ready', function (bb) { return bb.gunIsReady; }),
        Guard('enemy-visible', function (bb) { return !!bb.enemyTank; }),
        Action('do-freeze-followup', function (bb) {
          if (bb.shotDir) {
            if (bb.myDir === bb.shotDir) { bbSpeak(bb, '冰杀!'); bbFire(bb); }
            else bbTurnToward(bb, bb.shotDir);
          } else {
            var step = nextStepToFiringLane(bb.myPos, bb.enemyPos, bb.game, 1);
            if (step) bbMoveToward(bb, step);
          }
        })
      ])
    );
  }

  // ---- Stun-kill: 近距 → 眩晕后开火（6帧混乱无法躲）----
  if (mySkillType === 'stun') {
    children.push(
      Sequence('stun-kill', [
        Guard('enemy-visible', function (bb) { return !!bb.enemyTank; }),
        Guard('close-range', function (bb) { return bb.distToEnemy <= mp.stunKillRange; }),
        Guard('stun-ready', function (bb) { return canStun(bb.me, bb.enemy); }),
        Guard('gun-ready', function (bb) { return bb.gunIsReady; }),
        // 眩晕无视护盾（stun 不造成伤害），但后续开火时仍需检查
        Guard('can-shoot-after', function (bb) {
          if (mp.stunBypassShield) return bb.gunIsReady;
          return canShoot(bb.me, bb.enemy);
        }),
        Guard('has-or-near-shot', function (bb) {
          if (bb.shotDir) return true;
          var dx = Math.abs(bb.myPos[0] - bb.enemyPos[0]);
          var dy = Math.abs(bb.myPos[1] - bb.enemyPos[1]);
          return dx <= 1 || dy <= 1;
        }),
        Guard('no-self-danger', function (bb) {
          return !anyBulletThreatens(bb.enemyBullets, bb.myPos, bb.game);
        }),
        Action('do-stun-kill', function (bb) {
          if (bb.shotDir) {
            bbSpeak(bb, '晕杀!');
            bbUseSkill(bb, 'stun');
          } else {
            var step = nextStepToFiringLane(bb.myPos, bb.enemyPos, bb.game, 1);
            if (step) bbMoveToward(bb, step);
          }
        })
      ])
    );

    // 眩晕后续：敌人被眩晕时抓紧瞄准开火
    children.push(
      Sequence('stun-followup', [
        Guard('enemy-stunned', function (bb) {
          return !!(bb.enemy && bb.enemy.status && bb.enemy.status.stunned);
        }),
        Guard('gun-ready', function (bb) { return bb.gunIsReady; }),
        Guard('enemy-visible', function (bb) { return !!bb.enemyTank; }),
        Action('do-stun-followup', function (bb) {
          if (bb.shotDir) {
            if (bb.myDir === bb.shotDir) { bbSpeak(bb, '晕杀!'); bbFire(bb); }
            else bbTurnToward(bb, bb.shotDir);
          } else {
            var step = nextStepToFiringLane(bb.myPos, bb.enemyPos, bb.game, 1);
            if (step) bbMoveToward(bb, step);
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
          if (mp.overloadRequireShot) return false; // 严格模式：必须有射线
          var dx = Math.abs(bb.myPos[0] - bb.enemyPos[0]);
          var dy = Math.abs(bb.myPos[1] - bb.enemyPos[1]);
          return dx <= 2 || dy <= 2;
        }),
        // vs 护盾流：等盾碎再过载
        Guard('enemy-not-shielded', function (bb) {
          if (!mp.overloadWaitShield) return true;
          return !(bb.enemy && bb.enemy.status && bb.enemy.status.shielded);
        }),
        Guard('no-self-danger', function (bb) {
          return !anyBulletThreatens(bb.enemyBullets, bb.myPos, bb.game);
        }),
        Action('do-overload-prep', function (bb) {
          bbSpeak(bb, '过载!');
          bbUseSkill(bb, 'overload');
        })
      ])
    );

    // 过载后续：已过载 + 有射线 → 立即开火
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

  // ---- Cloak-sneak: 隐身 → 移到射线位 → 解除隐身开火 ----
  if (mySkillType === 'cloak') {
    // 隐身偷袭整体开关（vs cloak镜像对局禁用）
    if (mp.cloakSneakEnabled) {
      children.push(
        Sequence('cloak-sneak', [
          Guard('enemy-visible', function (bb) { return !!bb.enemyTank; }),
          Guard('not-on-shot-line', function (bb) { return !bb.shotDir; }),
          Guard('close-range', function (bb) { return bb.distToEnemy <= mp.cloakSneakRange; }),
          Guard('cloak-ready', function (bb) { return canCloak(bb.me); }),
          Guard('gun-ready', function (bb) { return bb.gunIsReady; }),
          Guard('no-self-danger', function (bb) {
            return !anyBulletThreatens(bb.enemyBullets, bb.myPos, bb.game);
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
        Guard('enemy-visible', function (bb) { return !!bb.enemyTank; }),
        Guard('no-shot', function (bb) { return !bb.shotDir; }),
        Action('do-cloak-move', function (bb) {
          var step = nextStepToFiringLane(bb.myPos, bb.enemyPos, bb.game, 1);
          if (step) bbMoveToward(bb, step);
        })
      ])
    );
  }

  // ---- Shield-counter: 与敌同线 → 开盾安全对射 ----
  if (mySkillType === 'shield') {
    children.push(
      Sequence('shield-counter', [
        Guard('enemy-visible', function (bb) { return !!bb.enemyTank; }),
        Guard('has-clear-shot', function (bb) { return !!bb.shotDir; }),
        Guard('gun-ready', function (bb) { return bb.gunIsReady; }),
        Guard('can-shoot', function (bb) { return canShoot(bb.me, bb.enemy); }),
        Guard('shield-ready', function (bb) { return canShieldSkill(bb.me); }),
        Guard('enemy-aims-at-me', function (bb) {
          return enemyAimsAt(bb.myPos, bb.enemyTank, bb.game);
        }),
        Guard('close-range', function (bb) { return bb.distToEnemy <= mp.shieldCounterRange; }),
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
  }

  // ---- Boost-chase-attack: 加速移到射线位开火 ----
  if (mySkillType === 'boost') {
    children.push(
      Sequence('boost-chase-attack', [
        Guard('enemy-visible', function (bb) { return !!bb.enemyTank; }),
        Guard('not-on-shot-line', function (bb) { return !bb.shotDir; }),
        Guard('medium-range', function (bb) {
          return bb.distToEnemy <= mp.boostChaseRange && bb.distToEnemy >= 3;
        }),
        Guard('boost-ready', function (bb) { return canBoost(bb.me); }),
        Guard('gun-ready', function (bb) { return bb.gunIsReady; }),
        Guard('no-self-danger', function (bb) {
          return !anyBulletThreatens(bb.enemyBullets, bb.myPos, bb.game);
        }),
        Action('do-boost-chase', function (bb) {
          bbSpeak(bb, '加速攻!');
          bbUseSkill(bb, 'boost');
        })
      ])
    );
  }

  if (children.length === 0) return null;
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
  if (mySkillType === 'boost') {
    children.push(
      Sequence('boost-star-rush', [
        Guard('star-exists', function (bb) { return !!bb.star; }),
        Guard('boost-ready', function (bb) { return canBoost(bb.me); }),
        Guard('star-distance', function (bb) { return bb.distToStar >= 3; }),
        Guard('no-self-danger', function (bb) {
          return !anyBulletThreatens(bb.enemyBullets, bb.myPos, bb.game);
        }),
        // 竞争激烈时才用：敌人也在追星或距星差不多
        Guard('star-contested', function (bb) {
          if (!bb.enemyTank) return true;
          var enemyStarDist = manhattan(bb.enemyPos, bb.star);
          return enemyStarDist <= bb.distToStar + 3 + mp.skillStarContestDelta;
        }),
        Action('do-boost-star', function (bb) {
          bbSpeak(bb, '加速星!');
          bbUseSkill(bb, 'boost');
        })
      ])
    );

    // 加速中的追星：已加速 + 面朝星方向 → go()（走2格）
    children.push(
      Sequence('boost-star-go', [
        Guard('is-boosted', function (bb) {
          return !!(bb.me.status && bb.me.status.boosted);
        }),
        Guard('star-exists', function (bb) { return !!bb.star; }),
        Guard('path-safe', function (bb) {
          return boostPathSafe(bb.myPos, bb.myDir, bb.game, bb.enemyPos, bb.enemyBullets);
        }),
        Action('do-boost-go', function (bb) {
          var starDir = directionBetween(bb.myPos, bb.star);
          if (starDir && bb.myDir === starDir) {
            bb.me.go();
          } else if (starDir) {
            bbTurnToward(bb, starDir);
          } else {
            bbMoveToward(bb, bb.star);
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
        Guard('no-self-danger', function (bb) {
          return !anyBulletThreatens(bb.enemyBullets, bb.myPos, bb.game);
        }),
        Action('do-cloak-star', function (bb) {
          bbSpeak(bb, '隐身星!');
          bbUseSkill(bb, 'cloak');
        })
      ])
    );
  }

  // ---- Shield-star-rush: 开盾冲星（抢星路上有危险时）----
  if (mySkillType === 'shield') {
    children.push(
      Sequence('shield-star-rush', [
        Guard('star-exists', function (bb) { return !!bb.star; }),
        Guard('shield-ready', function (bb) { return canShieldSkill(bb.me); }),
        Guard('star-close', function (bb) { return bb.distToStar <= 4; }),
        // 只在有危险时才用盾（敌瞄着星或有子弹威胁路线）
        Guard('star-dangerous', function (bb) {
          if (!bb.enemyTank) return false;
          // 敌人在我去星的路上且瞄着我
          return enemyAimsAt(bb.myPos, bb.enemyTank, bb.game) && bb.distToEnemy <= 5;
        }),
        Guard('no-self-danger', function (bb) {
          return !anyBulletThreatens(bb.enemyBullets, bb.myPos, bb.game);
        }),
        Action('do-shield-star', function (bb) {
          bbSpeak(bb, '盾星!');
          bbUseSkill(bb, 'shield');
        })
      ])
    );
  }

  // ---- Freeze-star: 抢星竞争时冻住对手 ----
  if (mySkillType === 'freeze') {
    children.push(
      Sequence('freeze-star', [
        Guard('star-exists', function (bb) { return !!bb.star; }),
        Guard('freeze-ready', function (bb) { return canFreeze(bb.me, bb.enemy); }),
        Guard('enemy-visible', function (bb) { return !!bb.enemyTank; }),
        // 敌人比我更近星或差不多 → 冻住它先吃
        Guard('enemy-closer', function (bb) {
          var enemyStarDist = manhattan(bb.enemyPos, bb.star);
          return enemyStarDist <= bb.distToStar + mp.skillStarContestDelta && bb.distToStar <= 6;
        }),
        Guard('no-self-danger', function (bb) {
          return !anyBulletThreatens(bb.enemyBullets, bb.myPos, bb.game);
        }),
        Action('do-freeze-star', function (bb) {
          bbSpeak(bb, '冰星!');
          bbUseSkill(bb, 'freeze');
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
