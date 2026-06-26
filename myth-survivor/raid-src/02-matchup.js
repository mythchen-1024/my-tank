// ============================================================
// 02-matchup.js — 技能对抗矩阵 + 敌方技能威胁画像
// 移植 all-round-tank/nodes-skill.js + enemy-profiler.js（裁剪）。
// ============================================================

// getMatchup(我技能, 敌技能) -> 施放距离/是否要射线/是否避盾 等阈值。
var MATCHUP_DEFAULTS = {
  freezeKillRange: 5, freezeKillRequireShot: false, freezeAvoidShielded: true,
  stunKillRange: 7, stunBypassShield: true,
  overloadRange: 5, overloadRequireShot: false, overloadWaitShield: true,
  poisonRange: 5, poisonBypassShield: true,
  cloakSneakRange: 8, cloakSneakEnabled: true,
  shieldCounterRange: 4,
  boostChaseRange: 6
};

var MATCHUP_OVERRIDES = {
  freeze: {
    shield: { freezeKillRange: 3, freezeKillRequireShot: true, freezeAvoidShielded: true },
    teleport: { freezeKillRange: 3 }, boost: { freezeKillRange: 3 }, cloak: { freezeKillRange: 3 }
  },
  stun: {
    shield: { stunKillRange: 4, stunBypassShield: true },
    teleport: { stunKillRange: 6 }, freeze: { stunKillRange: 5 }
  },
  overload: {
    shield: { overloadRange: 4, overloadRequireShot: true, overloadWaitShield: true },
    teleport: { overloadRange: 4, overloadRequireShot: true },
    boost: { overloadRange: 4 }, cloak: { overloadRange: 6 }
  },
  poison: {
    shield: { poisonRange: 6, poisonBypassShield: true },
    teleport: { poisonRange: 4 }, boost: { poisonRange: 6 }, freeze: { poisonRange: 5 }
  },
  cloak: {
    cloak: { cloakSneakEnabled: false }, overload: { cloakSneakRange: 5 }, freeze: { cloakSneakRange: 8 }
  },
  shield: {
    freeze: { shieldCounterRange: 3 }, overload: { shieldCounterRange: 3 }, stun: { shieldCounterRange: 3 }
  },
  boost: {
    freeze: { boostChaseRange: 7 }, overload: { boostChaseRange: 4 }, poison: { boostChaseRange: 5 }
  }
};

function getMatchup(mySkill, enemySkill) {
  var p = {};
  for (var k in MATCHUP_DEFAULTS) if (MATCHUP_DEFAULTS.hasOwnProperty(k)) p[k] = MATCHUP_DEFAULTS[k];
  var ov = MATCHUP_OVERRIDES[mySkill] && MATCHUP_OVERRIDES[mySkill][enemySkill];
  if (ov) for (var j in ov) if (ov.hasOwnProperty(j)) p[j] = ov[j];
  return p;
}

// 敌方技能威胁画像：驱动选靶权重 + 落点惩罚（裁剪自 SKILL_PROFILES）。
//   standoff     该敌的安全间距（落点惩罚梯度）
//   threatWeight 选靶威胁权重（越高越优先处理/拉开）
//   doubleLane   过载流：覆盖同列 ±1 相邻列
//   freezeKill   冰冻流：同线 ≤4 必死区
//   cloakSneaker 隐身流：可能蹲草偷袭
var ENEMY_THREAT_PROFILE = {
  overload: { standoff: 6, threatWeight: 6, doubleLane: true, freezeKill: false, cloakSneaker: false },
  freeze:   { standoff: 5, threatWeight: 5, doubleLane: false, freezeKill: true, cloakSneaker: false },
  stun:     { standoff: 4, threatWeight: 4, doubleLane: false, freezeKill: false, cloakSneaker: false },
  poison:   { standoff: 4, threatWeight: 4, doubleLane: false, freezeKill: false, cloakSneaker: false },
  cloak:    { standoff: 4, threatWeight: 4, doubleLane: false, freezeKill: false, cloakSneaker: true },
  teleport: { standoff: 3, threatWeight: 3, doubleLane: false, freezeKill: false, cloakSneaker: false },
  shield:   { standoff: 3, threatWeight: 2, doubleLane: false, freezeKill: false, cloakSneaker: false },
  boost:    { standoff: 4, threatWeight: 3, doubleLane: false, freezeKill: false, cloakSneaker: false }
};
var DEFAULT_THREAT = { standoff: 4, threatWeight: 3, doubleLane: false, freezeKill: false, cloakSneaker: false };
function threatProfile(skillType) {
  return (skillType && ENEMY_THREAT_PROFILE[skillType]) || DEFAULT_THREAT;
}
