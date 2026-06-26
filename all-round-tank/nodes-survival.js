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

function createHardSurvivalTree(shieldNode, deferredSkillNode) {
  var children = [

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

    // 2.5 boost 穿弹闪避：已加速 + 常规闪避失败 → go 2格跳过中间子弹到安全终点
    Sequence('boost-through-dodge', [
      Guard('is-boosted', function (bb) {
        return !!(bb.me.status && bb.me.status.boosted);
      }),
      Guard('no-normal-dodge', function (bb) { return !senseBulletDodge(bb); }),
      Guard('has-boost-through', function (bb) { return !!senseBoostThroughDodge(bb); }),
      Action('do-boost-through', function (bb) {
        var plan = senseBoostThroughDodge(bb);
        if (plan.turns === 0) {
          bb.me.go();
        } else {
          bbTurnToward(bb, plan.dir);
          bb.me.go();
        }
        // 穿弹甩狙：落点有射线到敌人 → 排队 turn+fire，下帧自动 turnFire
        if (bb.enemyTank && bb.gunIsReady && canShoot(bb.me, bb.enemy)) {
          var shotDir = clearShotDirection(plan.target, bb.enemyPos, bb.game);
          if (shotDir && manhattan(plan.target, bb.enemyPos) >= 3 &&
              manhattan(plan.target, bb.enemyPos) <= 6) {
            var afterDir = plan.turns === 0 ? bb.myDir : plan.dir;
            if (turnDistance(afterDir, shotDir) <= 1) {
              turnToward(bb.me, shotDir);
              bb.me.fire();
              bbSpeak(bb, '穿弹甩狙!');
            }
          }
        }
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
  ];

  // 3.5 护盾挡弹：Shield 能真正挡住来袭子弹，优先于物理挣扎
  if (shieldNode) {
    children.push(shieldNode);
  }

  children.push(
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
    ])
  );

  // 5.5 其他技能逃生：物理逃跑全失败后，用技能阻止敌人继续追杀（不能挡当前子弹）
  if (deferredSkillNode) {
    children.push(deferredSkillNode);
  }

  children.push(
    // 6. 炸弹躲避：在爆炸范围内且即将引爆时逃离
    Sequence('bomb-dodge', [
      Guard('has-bomb-threat', function (bb) { return !!senseBombThreat(bb); }),
      Action('do-bomb-dodge', function (bb) {
        bbMoveToward(bb, senseBombThreat(bb));
      })
    ])
  );

  return Selector('hard-survival', children);
}

// ---- 软生存子树（profile 控制包含哪些节点） ----

function createSoftSurvivalTree(profile) {
  var children = [];

  // overload 特有：双弹覆盖带提前脱离
  if (profile.dodgeBand) {
    children.push(
      Sequence('overload-lane-dodge', [
        Guard('not-boosted-ol', function (bb) {
          return !(bb.me.status && bb.me.status.boosted);
        }),
        Guard('not-hidden-in-bush', function (bb) {
          if (iAmHidden(bb.me, bb.game)) return false;
          return true;
        }),
        Guard('enemy-close-enough', function (bb) {
          // 敌远(>=7)时预测弹道飞行3.5帧+才到，有充足反应时间，不预闪(mat_3hbcDixqC)
          return bb.distToEnemy < 7;
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
        Guard('not-boosted-bc', function (bb) {
          return !(bb.me.status && bb.me.status.boosted);
        }),
        Guard('enemy-hidden', function (bb) { return !bb.enemyTank; }),
        Guard('not-star-stuck-bush', function (bb) {
          if (!bb.star) return true;
          if ((bb.memory.stuckFrames || 0) < 6) return true;
          var myStarDist = pathDistance(bb.myPos, bb.star, bb.game, bb.enemyPos);
          return myStarDist < 0;
        }),
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
      Guard('not-star-stuck', function (bb) {
        if (!bb.star) return true;
        var stuck = bb.memory.stuckFrames || 0;
        if (stuck < 6) return true;
        var myStarDist = pathDistance(bb.myPos, bb.star, bb.game, bb.enemyPos);
        if (myStarDist < 0) return true;
        // 敌可见且近距瞄准 → 威胁真实，不压制 aim-dodge(mat_J8lxX83O)
        if (bb.enemyTank && bb.distToEnemy <= 5) return true;
        // 卡住6帧+ 且星可达 → 压制 aim-dodge，让追星/攻击有机会执行
        return false;
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
      Guard('not-star-stuck-duel', function (bb) {
        // 无星：原地空转(stuck>=3)就让位给 movement 层 line-lock-unstick，别继续霸占。
        // 根因(mat_5Nlz9rSIe728055DD f60-66 无星)：line-duel-dodge 连续胜出，但 moveToward 的
        // predictedOverloadThreatens 危险格随敌每帧转向而翻转，逃逸目标在 [2,6]/[1,7] 间来回跳，
        // 坦克永远停在"转向对准"那帧、go 轮不到 → 钉死在炮线列被下射秒。dodge 占着优先级4，
        // 本为此设计的 line-lock-unstick(优先级11,确定性破循环)被饿死。trackStuck 仅在未移动时累加，
        // 正常"转1帧再走"stuck 最多到 1~2，阈值 3 只命中真空转死循环，不误伤正常侧移。
        if (!bb.star) return (bb.memory.stuckFrames || 0) < 3;
        if ((bb.memory.stuckFrames || 0) < 6) return true;
        var myStarDist = pathDistance(bb.myPos, bb.star, bb.game, bb.enemyPos);
        return myStarDist < 0;
      }),
      Guard('has-line-duel', function (bb) { return !!senseLineDuelDodge(bb); }),
      Action('do-line-duel-dodge', function (bb) {
        bbMoveToward(bb, senseLineDuelDodge(bb));
      })
    ])
  );

  return Selector('soft-survival', children);
}
