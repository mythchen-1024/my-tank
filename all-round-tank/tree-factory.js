// ============================================================
// tree-factory.js — 按 Profile + 我方技能动态组装行为树
//
// 核心函数 buildBehaviorTree(profile) 根据敌情 Profile 参数
// 和我方技能类型（运行时自动检测 me.skill.type）
// 决定挂载哪些子树、调整子树顺序，返回一棵完整的行为树根节点。
//
// 树结构总览：
//   Root (Selector)
//   ├── [固定] 被控拦截（被冻/被眩晕时跳过本帧）
//   ├── [固定] 硬生存（子弹/传送逃生 + 技能逃生内嵌，永远最高）
//   │   ├── counter-shoot（对射先射后走）
//   │   ├── bullet-dodge（常规弹道躲避）
//   │   ├── escape-teleport（传送逃生，仅传送技能）
//   │   ├── 【技能逃生】shield-block/freeze-defense/stun-escape/cloak-escape/boost-escape/poison-escape
//   │   ├── two-step-escape（两步脱困）
//   │   ├── desperate-dodge（绝境横移）
//   │   └── bomb-dodge（炸弹躲避）
//   ├── [传送] 传送补吃星（仅传送技能）
//   ├── [Profile] 软生存（防瞄/近距规避，敏感度可调）
//   ├── [动态] 终局抢星提权
//   ├── [技能] 技能攻击（冰杀/晕杀/过载/下毒/隐袭/盾击/加速攻）
//   ├── [Profile] 攻击（空窗/直射/守线/草丛，激进度可调）
//   ├── [Profile] 主动放弹
//   ├── [技能] 技能目标（加速星/隐身星/盾星/冰星/晕星/毒星）
//   ├── [Profile] 目标（传星/刺杀，开关可控）
//   └── [Profile] 移动（蹲草/走位/破墙/兜底）
// ============================================================

/**
 * 根据 Profile 组装完整行为树。
 * 我方技能类型在运行时从 bb.mySkillType 读取，构建时通过闭包传入。
 *
 * @param {Object} profile - 由 buildProfile(bb) 生成的策略参数
 * @param {string} mySkillType - 我方技能类型（me.skill.type）
 * @returns {Object} 行为树根节点，调用 root.tick(bb) 执行决策
 */
function buildBehaviorTree(profile, mySkillType) {
  mySkillType = mySkillType || 'teleport';

  // ═══════ 子树构建 ═══════
  var enemySkillType = (profile && profile.skillType) || 'stun';
  var skillSurvival  = createSkillSurvivalNodes(mySkillType);
  var hardSurvival   = createHardSurvivalTree(skillSurvival);
  var starGrab       = (mySkillType === 'teleport') ? createStarGrabNode() : null;
  var softSurvival   = createSoftSurvivalTree(profile);
  var skillAttack    = createSkillAttackNodes(mySkillType, enemySkillType);
  var bombAttack     = createBombNodes(profile);
  var attack         = createAttackTree(profile);
  var skillObjective = createSkillObjectiveNodes(mySkillType, enemySkillType);
  var objective      = createObjectiveTree(profile, mySkillType);
  var movement       = createMovementTree(profile, mySkillType);

  // ═══════ 被控拦截（被冻/被眩晕时本帧无法操作） ═══════
  var ccCheck = Sequence('cc-check', [
    Guard('is-cc', function (bb) {
      return !!(bb.me.status && (bb.me.status.frozen || bb.me.status.stunned));
    }),
    Action('frozen-wait', function (bb) {
      var ccType = bb.me.status.frozen ? '冰冻中' : '眩晕中';
      bbSpeak(bb, ccType);
    })
  ]);

  // ═══════ 动态提权装饰器 ═══════

  // 终局抢星提权：落后 + 最后 20 帧 → 目标层提到攻击层前面
  var endgameStarBoost = When('endgame-star-boost',
    function (bb) { return bb.framesLeft <= 20 && bb.isLosing; },
    objective
  );

  // 最后 10 帧无论输赢：全力冲星（跳过攻击层）
  var lastChanceStar = When('last-chance-star',
    function (bb) { return bb.framesLeft <= 10; },
    objective
  );

  // starAggression='max' 时（跑路流/星极致模式）：目标层也提前
  var maxStarAggression = When('max-star-aggression',
    function (bb) { return profile.starAggression === 'max' && bb.framesLeft > 20; },
    objective
  );

  // ═══════ 组装根节点 ═══════
  var rootChildren = [
    // 第一优先级：被控（冰冻/眩晕）就直接返回
    ccCheck,

    // 第二优先级：硬生存（来袭子弹 + 炸弹躲避 + 技能逃生内嵌其中）
    hardSurvival,

    // 第三优先级：传送补吃星（仅传送技能，只有来弹才打断）
    starGrab,

    // 第四优先级：软生存（预防性躲避）
    softSurvival,

    // 第五优先级（动态）：终局/落后/极致模式时目标层提前
    lastChanceStar,
    endgameStarBoost,
    maxStarAggression,

    // 第六优先级：技能攻击（冰杀/晕杀/过载/下毒/隐袭/盾击/加速攻）
    skillAttack,

    // 第七优先级：攻击（炮弹）
    attack,

    // 第八优先级：主动放弹（堵路/封路/草丛陷阱）
    bombAttack,

    // 第九优先级：技能目标（加速星/隐身星/盾星/冰星/晕星/毒星）
    skillObjective,

    // 第十优先级：常规目标（非终局时的正常优先级）
    objective,

    // 第十一优先级：移动/兜底
    movement,
  ];

  // 过滤掉 null（如 attackAggression='none' 时 attack 为 null）
  var filtered = [];
  for (var i = 0; i < rootChildren.length; i++) {
    if (rootChildren[i]) filtered.push(rootChildren[i]);
  }

  return Selector('root', filtered);
}
