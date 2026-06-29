// ============================================================
// 06-skills.js — 进攻技能分派(技能无关) + 已激活技能后续 + 防御技能
// raid 敌不躲弹 → 冻/晕/双弹/毒/偷袭命中率极高，给高分(>狂射850)。
// 施放阈值走 getMatchup(mySkill, 该敌skill)。每个动作单命令（boost 甩狙除外）。
// ============================================================

// 多目标进攻技能：对每个可见敌算 skillOffense，取最高分候选。
// 敌不躲弹 → 任一敌可击杀就放技能，不固执打主目标。
function skillOffenseBest(me, enemy, game, threats, mySkill, hasBudget) {
  var list = enemyCandidates(enemy, game);
  if (!list.length) return null;
  var best = null;
  for (var i = 0; i < list.length; i++) {
    var c = skillOffense(me, list[i], game, threats, mySkill, hasBudget);
    if (c && (!best || c.score > best.score)) best = c;
  }
  return best;
}

function skillOffense(me, foe, game, threats, mySkill, hasBudget) {
  if (!foe || !foe.tank || !foe.tank.position) return null;
  if (!skillReady(me)) {
    // 技能没好：处理「已激活技能」的后续开火（过载/护盾/隐身中对准就射）。
    return activeSkillFollowup(me, foe, game, hasBudget);
  }
  var pos = me.tank.position, dir = me.tank.direction;
  var fp = foe.tank.position;
  var d = manhattan(pos, fp);
  var es = (foe.skill && foe.skill.type) || null;
  var mp = getMatchup(mySkill, es);
  var hasShot = canShoot(pos, fp, game.map);
  var selfDanger = posHitWithin(threats, pos, game, 1);
  if (selfDanger) return null; // 技能激活占1帧，受威胁时别站着放
  var enemyShielded = foe.status && foe.status.shielded;

  // freeze：可见+同线+近距+冷却好 → 冻（下帧补刀）
  if (mySkill === "freeze") {
    if (mp.freezeAvoidShielded && enemyShielded) return null;
    if (hasShot && d <= 4 && hasBudget) return { type: "useskill", skill: "freeze", score: 970, tag: "冰杀" };
    if (!hasShot && d <= mp.freezeKillRange && !mp.freezeKillRequireShot && nearFiringLane(pos, fp, game.map, 2))
      return { type: "useskill", skill: "freeze", score: 940, tag: "冰冻" };
    return null;
  }
  // stun：有射线任意距离 → 晕（6帧窗口宽）
  if (mySkill === "stun") {
    if (hasShot) return { type: "useskill", skill: "stun", score: 965, tag: "眩晕" };
    if (d <= mp.stunKillRange && nearFiringLane(pos, fp, game.map, 3))
      return { type: "useskill", skill: "stun", score: 935, tag: "眩晕" };
    return null;
  }
  // overload：同线/偏移线近距 → 过载（双弹覆盖）。等盾碎。
  if (mySkill === "overload") {
    if (mp.overloadWaitShield && enemyShielded) return null;
    var offset = overloadOffsetDir(pos, fp, game.map);
    if (d <= mp.overloadRange && (hasShot || offset || (!mp.overloadRequireShot && nearFiringLane(pos, fp, game.map, 2))))
      return { type: "useskill", skill: "overload", score: 960, tag: "过载" };
    return null;
  }
  // poison：近距 → 下毒（无视盾）
  if (mySkill === "poison") {
    var dx = Math.abs(pos[0] - fp[0]), dy = Math.abs(pos[1] - fp[1]);
    if (d <= mp.poisonRange && (hasShot || dx <= 2 || dy <= 2))
      return { type: "useskill", skill: "poison", score: 955, tag: "下毒" };
    return null;
  }
  // cloak：中距未对准未被发现 → 隐身潜行偷袭
  if (mySkill === "cloak") {
    if (mp.cloakSneakEnabled && !hasShot && d <= mp.cloakSneakRange)
      return { type: "useskill", skill: "cloak", score: 930, tag: "潜行" };
    return null;
  }
  // shield：敌瞄我同线近距 → 开盾安全对射
  if (mySkill === "shield") {
    if (hasShot && hasBudget && d <= mp.shieldCounterRange && pointsAt(foe.tank.direction, fp, pos))
      return { type: "useskill", skill: "shield", score: 945, tag: "盾击" };
    return null;
  }
  // boost：中距未对准 → 加速逼近到射线位
  if (mySkill === "boost") {
    if (!hasShot && d >= 3 && d <= mp.boostChaseRange)
      return { type: "useskill", skill: "boost", score: 600, tag: "加速攻" };
    return null;
  }
  return null;
}

// 已激活技能（过载/护盾/隐身/加速）的后续开火：对准就射，未对准转向。
function activeSkillFollowup(me, foe, game, hasBudget) {
  if (!foe || !foe.tank) return null;
  var pos = me.tank.position, dir = me.tank.direction, fp = foe.tank.position;
  var st = me.status || {};
  var hasShot = canShoot(pos, fp, game.map);

  // boost 甩狙：加速中 + 同线无遮挡 + 差 90° → turn+fire 同帧（唯一同帧多命令）。
  if (st.boosted && hasBudget && hasShot && !pointsAt(dir, pos, fp)) {
    var fd = directionTo(pos, fp);
    if (turnCountTo(dir, fd) === 1)
      return { type: "flick", side: turnDirection(dir, fd), fire: true, score: 980, tag: "甩狙" };
  }
  // 过载/护盾/隐身激活中：对准就射，未对准转向。
  if (st.overloaded || st.shielded || st.cloaked) {
    if (hasShot && hasBudget) {
      if (pointsAt(dir, pos, fp)) return { type: "fire", fire: true, score: 975, tag: "技射" };
      return { type: "turn", side: turnDirection(dir, directionTo(pos, fp)), score: 760, tag: "技瞄" };
    }
    if (st.overloaded && hasBudget) {
      var off = overloadOffsetDir(pos, fp, game.map);
      if (off) {
        if (dir === off) return { type: "fire", fire: true, score: 940, tag: "错位弹" };
        return { type: "turn", side: turnDirection(dir, off), score: 740, tag: "错位瞄" };
      }
    }
  }
  return null;
}

// 守线预开炮：对每个可见敌，按其当前朝向匀速外推未来帧位置，找「开火后第 j 帧子弹时空交点
// 恰好落在敌身上」的提前量。命中=敌沿我炮线前方距离 s∈{2j-1,2j} 且路径无遮挡 + 我已对准该方向。
// 敌不躲弹 → 命中率极高。匹配判据本身是强门控，不会乱开火。返回 fire 候选或 null。
function leadFireNow(me, enemy, game, hasBudget) {
  if (!hasBudget) return null;
  var pos = me.tank.position, dir = me.tank.direction;
  var fdelta = delta(dir);
  var list = enemyCandidates(enemy, game);
  for (var i = 0; i < list.length; i++) {
    var e = list[i];
    var ep = e.tank.position;
    var edir = e.tank.direction;
    if (!edir) continue;
    var ed = delta(edir);
    // 外推敌未来 j 帧位置，检查是否落在我炮线(沿 dir 的射线)上、且 s∈{2j-1,2j}。
    for (var j = 1; j <= LEAD_MAX_FRAMES; j++) {
      var fx = pos[0] + fdelta[0] * (2 * j), fy = pos[1] + fdelta[1] * (2 * j); // 第 j 帧子弹末位(标量2j)
      var ex = ep[0] + ed[0] * j, ey = ep[1] + ed[1] * j;                       // 第 j 帧敌位
      // 敌须落在我炮线方向的前方（同轴且 pointsAt）
      if (!pointsAt(dir, pos, [ex, ey])) continue;
      var s = Math.abs(ex - pos[0]) + Math.abs(ey - pos[1]); // 沿炮线前方距离
      if (s !== 2 * j && s !== 2 * j - 1) continue;          // 时空交点匹配(子弹第j帧覆盖2j-1与2j)
      if (!isOpen([ex, ey], game.map)) continue;             // 敌预测格须可达(没撞墙)
      if (!clearBetween(pos, [ex, ey], game)) continue;      // 我到交点路径无遮挡
      return { type: "fire", fire: true, score: 858, tag: "预瞄", lead: j };
    }
  }
  return null;
}

// 防御技能（仅躲不掉实弹时）：shield 挡 / cloak·boost 逃。debuff 技能不做防御。
function defensiveSkill(me, mySkill, threats, game) {
  if (!skillReady(me)) return null;
  if (mySkill === "shield") return { type: "useskill", skill: "shield", tag: "挡弹" };
  if (mySkill === "cloak") return { type: "useskill", skill: "cloak", tag: "隐遁" };
  if (mySkill === "boost") return { type: "useskill", skill: "boost", tag: "加速逃" };
  return null;
}

function skillReady(me) {
  return !!(me.skill && me.skill.remainingCooldownFrames === 0);
}
