// ============================================================
// nodes-survival.js — 生存行为节点
//
// 两类：
//   硬生存（hardSurvival）：子弹来袭等致命威胁，必须立即响应
//   软生存（softSurvival）：预防性躲避，由 profile 控制敏感度
//
// 所有节点复用 myth-tank.js 的 find* 函数，通过 blackboard 惰性传感器访问。
// ============================================================

// ---- 硬生存子树（永远最高优先级，不受 profile 影响） ----

function createHardSurvivalTree() {
  return Selector('hard-survival', [

    // 1. 对射先射后走：来袭子弹 + 能反击 + 开火后仍来得及躲
    Sequence('counter-shoot', [
      Guard('has-bullet-dodge', function (bb) { return !!senseBulletDodge(bb); }),
      Guard('can-counter', function (bb) { return !!senseCounterShoot(bb); }),
      Action('do-counter-fire', function (bb) {
        bbSpeak(bb, '反击!');
        bbFire(bb);
      })
    ]),

    // 2. 常规子弹躲避：预判弹道，移动到相邻安全格
    Sequence('bullet-dodge', [
      Guard('has-bullet-dodge', function (bb) { return !!senseBulletDodge(bb); }),
      Action('do-bullet-dodge', function (bb) {
        bbMoveToward(bb, senseBulletDodge(bb));
      })
    ]),

    // 3. 紧急传送逃生：常规移动躲不开时传送到安全落点
    Sequence('escape-teleport', [
      Guard('no-dodge-available', function (bb) { return !senseBulletDodge(bb); }),
      Guard('has-escape-tp', function (bb) { return !!senseEscapeTeleport(bb); }),
      Action('do-escape-tp', function (bb) {
        bbTeleport(bb, senseEscapeTeleport(bb));
      })
    ]),

    // 4. 两步脱困：双弹夹击导致单步无安全格，走"下一帧还能继续脱离"的格
    Sequence('two-step-escape', [
      Guard('has-two-step', function (bb) { return !!senseTwoStepEscape(bb); }),
      Action('do-two-step', function (bb) {
        bbDirectGo(bb, senseTwoStepEscape(bb));
      })
    ]),

    // 5. 绝境横移：躲不掉也传不了，至少垂直弹道挣一步
    Sequence('desperate-dodge', [
      Guard('has-desperate', function (bb) { return !!senseDesperateDodge(bb); }),
      Action('do-desperate', function (bb) {
        bbMoveToward(bb, senseDesperateDodge(bb));
      })
    ]),

    // 6. 炸弹躲避：在爆炸范围内且即将引爆时逃离
    Sequence('bomb-dodge', [
      Guard('has-bomb-threat', function (bb) { return !!senseBombThreat(bb); }),
      Action('do-bomb-dodge', function (bb) {
        bbMoveToward(bb, senseBombThreat(bb));
      })
    ]),
  ]);
}

// ---- 软生存子树（profile 控制包含哪些节点） ----

function createSoftSurvivalTree(profile) {
  var children = [];

  // overload 激活瞬间预防性逃离：敌 overload 刚激活(尚未开火)，立即脱离其行/列覆盖带
  if (profile.dodgeBand) {
    children.push(
      Sequence('overload-preempt', [
        Guard('overload-active-no-fire', function (bb) {
          if (!bb.enemyPos || !bb.enemyTank) return false;
          var overloaded = bb.enemy && bb.enemy.status && bb.enemy.status.overloaded;
          if (!overloaded) return false;
          // 已有实弹在飞 → 交 hardSurvival 处理
          if (bb.enemy.bullet && bb.enemy.bullet.position) return false;
          // 距离太远(>8)无需紧急逃离
          if (bb.distToEnemy > 8) return false;
          return true;
        }),
        Guard('in-danger-zone', function (bb) {
          // 当前在敌人任意方向覆盖带内(行±1 或 列±1)
          var dx = Math.abs(bb.myPos[0] - bb.enemyPos[0]);
          var dy = Math.abs(bb.myPos[1] - bb.enemyPos[1]);
          return dx <= 1 || dy <= 1;
        }),
        Guard('preempt-step', function (bb) {
          var step = findOverloadPreemptStep(bb.myPos, bb.enemyPos, bb.game, bb.enemyBullets);
          if (!step) return false;
          bb._cache._preemptStep = step;
          return true;
        }),
        Action('do-preempt', function (bb) {
          bbMoveToward(bb, bb._cache._preemptStep);
        })
      ])
    );
  }

  // overload 特有：双弹覆盖带提前脱离
  if (profile.dodgeBand) {
    children.push(
      Sequence('overload-lane-dodge', [
        // 非传送敌 + 我藏在草丛 + 无实弹来袭 + 敌未激活过载 → 纯预测威胁，蹲草别动。
        // 让位给 bush-hold 保持隐蔽 + 炮口追敌。真实威胁(敌已过载→overload-preempt；
        // 实弹来袭→hardSurvival)仍正常处理。
        // mat_1l2 复盘：f42 我藏草[12,3]、敌[2,2]距10格未开火，却因"预测副弹扫 y=3"被本节点
        // 拉出草丛到开阔地，f50 敌真过载时我已暴露，双弹 y=3 把我秒在 [15,3]。
        Guard('not-speculative-bush-exit', function (bb) {
          if (!iAmHidden(bb.me, bb.game)) return true;            // 没藏草，正常躲
          if (enemyHasTeleport(bb.enemy)) return true;            // 传送敌能瞬移贴脸，蹲草无用
          var overloaded = bb.enemy && bb.enemy.status && bb.enemy.status.overloaded;
          if (overloaded) return true;                            // 敌已激活过载=真实威胁
          if (anyBulletThreatens(bb.enemyBullets, bb.myPos, bb.game)) return true; // 有实弹
          return false;                                           // 隐蔽+非传送+未过载+无实弹 → 别动
        }),
        Guard('in-overload-band', function (bb) { return !!senseOverloadLaneDodge(bb); }),
        Action('dodge-overload-band', function (bb) {
          bbMoveToward(bb, senseOverloadLaneDodge(bb));
        })
      ])
    );
  }

  // freeze 特有：冰冻致死区回避
  if (profile.freezeZoneAvoid) {
    children.push(
      Sequence('freeze-zone-avoid', [
        Guard('in-freeze-zone', function (bb) {
          return bb.enemyPos && freezeKillsAt(bb.myPos, bb.enemyPos, bb.game);
        }),
        Guard('has-aim-dodge', function (bb) { return !!senseAimDodge(bb); }),
        Action('escape-freeze-zone', function (bb) {
          bbMoveToward(bb, senseAimDodge(bb));
        })
      ])
    );
  }

  // 蹲草流防御：回避高概率草丛射击线
  if (profile.bushCamperDefense) {
    children.push(
      Sequence('bush-camper-dodge', [
        Guard('enemy-hidden', function (bb) { return !bb.enemyTank; }),
        Guard('has-bush-dodge', function (bb) { return !!senseBushCamperDodge(bb); }),
        Action('do-bush-camper-dodge', function (bb) {
          bbMoveToward(bb, senseBushCamperDodge(bb));
        })
      ])
    );
  }

  // 通用：防范敌方瞄准（敌炮口正对我，提前移动离线）
  children.push(
    Sequence('aim-dodge', [
      Guard('not-bush-holding', function (bb) {
        if (bb.memory.ambushState && iAmHidden(bb.me, bb.game)) return false;
        if (iAmHidden(bb.me, bb.game) && enemyIsOverloadType(bb.enemy)) return false;
        return true;
      }),
      Guard('has-aim-dodge', function (bb) { return !!senseAimDodge(bb); }),
      Action('do-aim-dodge', function (bb) {
        bbMoveToward(bb, senseAimDodge(bb));
      })
    ])
  );

  // 通用：近距对射规避（近距同线且我不占先手，侧移离线）
  children.push(
    Sequence('line-duel-dodge', [
      Guard('not-bush-holding', function (bb) {
        if (bb.memory.ambushState && iAmHidden(bb.me, bb.game)) return false;
        if (iAmHidden(bb.me, bb.game) && enemyIsOverloadType(bb.enemy)) return false;
        return true;
      }),
      Guard('has-line-duel', function (bb) { return !!senseLineDuelDodge(bb); }),
      Action('do-line-duel-dodge', function (bb) {
        bbMoveToward(bb, senseLineDuelDodge(bb));
      })
    ])
  );

  return Selector('soft-survival', children);
}
