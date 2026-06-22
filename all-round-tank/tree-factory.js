// ============================================================
// tree-factory.js — 按 Profile 动态组装行为树
//
// 核心函数 buildBehaviorTree(profile) 根据敌情 Profile 参数
// 决定挂载哪些子树、调整子树顺序，返回一棵完整的行为树根节点。
//
// 树结构总览：
//   Root (Selector)
//   ├── [固定] 硬生存（子弹/传送逃生，永远最高）
//   ├── [固定] 冰冻拦截（被冻时跳过本帧）
//   ├── [Profile] 软生存（防瞄/近距规避，敏感度可调）
//   ├── [动态] 终局抢星提权（落后+终局时目标层插到攻击层前）
//   ├── [Profile] 攻击（空窗/直射/守线/草丛，激进度可调）
//   ├── [Profile] 目标（星星/刺杀，开关可控）
//   └── [Profile] 移动（蹲草/走位/破墙/兜底）
// ============================================================

/**
 * 根据 Profile 组装完整行为树。
 *
 * @param {Object} profile - 由 buildProfile(bb) 生成的策略参数
 * @returns {Object} 行为树根节点，调用 root.tick(bb) 执行决策
 */
function buildBehaviorTree(profile) {

  // ═══════ 子树构建 ═══════
  var hardSurvival = createHardSurvivalTree();
  var starGrab     = createStarGrabNode();
  var softSurvival = createSoftSurvivalTree(profile);
  var bombAttack   = createBombNodes(profile);
  var attack       = createAttackTree(profile);
  var objective    = createObjectiveTree(profile);
  var movement     = createMovementTree(profile);

  // ═══════ 冰冻拦截（被冻时本帧无法操作） ═══════
  var frozenCheck = Sequence('frozen-check', [
    Guard('is-frozen', function (bb) {
      return !!(bb.me.status && bb.me.status.frozen);
    }),
    Action('frozen-wait', function (bb) {
      bbSpeak(bb, '冰冻中');
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
    // 第一优先级：被冻住就直接返回
    frozenCheck,

    // 第二优先级：硬生存（来袭子弹 + 炸弹躲避）
    hardSurvival,

    // 第三优先级：传送补吃星（只有来弹才打断）
    starGrab,

    // 第四优先级：软生存（预防性躲避）
    softSurvival,

    // 第五优先级（动态）：终局/落后/极致模式时目标层提前
    lastChanceStar,
    endgameStarBoost,
    maxStarAggression,

    // 第六优先级：攻击（炮弹）
    attack,

    // 第七优先级：主动放弹（堵路/封路/草丛陷阱）
    bombAttack,

    // 第八优先级：常规目标（非终局时的正常优先级）
    objective,

    // 第九优先级：移动/兜底
    movement,
  ];

  // 过滤掉 null（如 attackAggression='none' 时 attack 为 null）
  var filtered = [];
  for (var i = 0; i < rootChildren.length; i++) {
    if (rootChildren[i]) filtered.push(rootChildren[i]);
  }

  return Selector('root', filtered);
}
