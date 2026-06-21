// ============================================================
// nodes-attack.js — 攻击行为节点
//
// 由 profile.attackAggression 控制挂载哪些攻击子节点：
//   'none'     → 不挂载任何攻击节点（终局纯抢星）
//   'low'      → 只挂空窗反击
//   'cautious' → 空窗反击 + 安全直射（骗盾流专用）
//   'medium'   → 空窗反击 + 直射 + 守线
//   'high'     → 全挂载（空窗 + 隐身预射 + 直射 + 守线 + 草丛）
// ============================================================

function createAttackTree(profile) {
  if (profile.attackAggression === 'none') return null;

  var children = [];

  // 空窗期反击：敌方子弹刚射出（炮管空），我与敌同线时抢射
  children.push(
    Sequence('open-shot', [
      Guard('has-open-shot', function (bb) { return !!senseOpenShot(bb); }),
      Action('do-open-shot', function (bb) {
        var dir = senseOpenShot(bb);
        if (bb.myDir === dir) { bbSpeak(bb, '空窗!'); bbFire(bb); }
        else bbTurnToward(bb, dir);
      })
    ])
  );

  // cloak 敌刚隐身时预射（仅对隐身流启用）
  if (profile.prefireOnDisappear) {
    children.push(
      Sequence('cloak-prefire', [
        Guard('has-cloak-prefire', function (bb) { return !!senseCloakPreFire(bb); }),
        Action('do-cloak-prefire', function (bb) {
          var shot = senseCloakPreFire(bb);
          if (shot.fire) { bbSpeak(bb, '预射!'); bbFire(bb); }
          else bbTurnToward(bb, shot.dir);
        })
      ])
    );
  }

  // 骗盾预瞄：敌盾激活 + 有射线 + 近距 → 不开火但转向对准（盾落即射）
  if (profile.shieldBait) {
    children.push(
      Sequence('shield-preaim', [
        Guard('enemy-shielded', function (bb) {
          return !!(bb.enemyTank && bb.enemy && bb.enemy.status && bb.enemy.status.shielded);
        }),
        Guard('has-clear-shot', function (bb) { return !!bb.shotDir; }),
        Guard('close-range', function (bb) { return bb.distToEnemy <= 3; }),
        Action('do-shield-preaim', function (bb) {
          if (bb.myDir !== bb.shotDir) bbTurnToward(bb, bb.shotDir);
        })
      ])
    );
  }

  // 拦截射击：敌人正移动且将穿过我的射线，提前开炮拦截（优先于直射，抓穿线窗口）
  if (profile.attackAggression !== 'low') {
    children.push(
      Sequence('intercept-shot', [
        Guard('gun-ready', function (bb) { return bb.gunIsReady; }),
        Guard('enemy-visible', function (bb) { return !!bb.enemyTank; }),
        Guard('can-shoot', function (bb) { return canShoot(bb.me, bb.enemy); }),
        Guard('not-already-on-line', function (bb) { return !bb.shotDir; }),
        Guard('no-bullet-incoming', function (bb) {
          return !anyBulletThreatens(bb.enemyBullets, bb.myPos, bb.game);
        }),
        Guard('not-double-threat', function (bb) {
          return !enemyDoubleLaneThreat(bb.enemy);
        }),
        Guard('has-intercept', function (bb) {
          var dir = canPreemptiveShot(bb.myPos, bb.myDir, bb.enemyTank, bb.game);
          if (!dir) dir = canAmbushLeadShot(bb.myPos, bb.myDir, bb.enemyTank, bb.game);
          if (!dir) return false;
          bb._cache._interceptDir = dir;
          return true;
        }),
        Action('do-intercept', function (bb) {
          var dir = bb._cache._interceptDir;
          if (bb.myDir === dir) { bbSpeak(bb, '拦截!'); bbFire(bb); }
          else bbTurnToward(bb, dir);
        })
      ])
    );
  }

  // 直射：同线无障碍 + 可开火
  if (profile.attackAggression !== 'low') {
    children.push(
      Sequence('fire-direct', [
        Guard('has-clear-shot', function (bb) { return !!bb.shotDir && bb.gunIsReady; }),
        Guard('can-shoot-enemy', function (bb) { return canShoot(bb.me, bb.enemy); }),
        // 近距被逼且需多帧转向 → 放弃攻击让 movement 后撤(mat_4FgtrkWtGANKtI2mX)
        Guard('not-cornered-turning', function (bb) {
          if (bb.distToEnemy >= safeStandoffDistance(bb.enemy)) return true;
          return turnDistance(bb.myDir, bb.shotDir) < 2;
        }),
        // shield 流特殊处理：需要确认打完能侧移躲开回敬
        Guard('shield-safe', function (bb) {
          if (!enemyHasShieldSkill(bb.enemy)) return true;
          if (profile.shieldBait) {
            return canShootThenEvadeShieldCounter(
              bb.me, bb.enemy, bb.enemyTank, bb.enemyBullets, bb.game, bb.enemyPos
            );
          }
          return true;
        }),
        // 双弹近距不对枪（除非严格先手击杀）
        Guard('not-double-lane-close', function (bb) {
          if (!enemyDoubleLaneThreat(bb.enemy)) return true;
          if (bb.distToEnemy >= safeStandoffDistance(bb.enemy)) return true;
          // 检查严格先手击杀
          if (turnDistance(bb.myDir, bb.shotDir) !== 0) return false;
          if (!enemyCanFireSoon(bb.enemy)) return true;
          var myHit = Math.ceil(bb.distToEnemy / BULLET_SPEED);
          var dirToMe = clearShotDirection(bb.enemyPos, bb.myPos, bb.game);
          var enemyHit = (dirToMe ? turnDistance(bb.enemyTank.direction, dirToMe) : 1)
            + Math.ceil(bb.distToEnemy / BULLET_SPEED);
          return myHit < enemyHit;
        }),
        // 安全直射判定：不会必死才提到高优先级
        Guard('safe-to-fire', function (bb) {
          return directShotNotSuicidal(
            bb.me, bb.enemy, bb.enemyTank, bb.enemyBullets, bb.game, bb.enemyPos, bb.shotDir
          );
        }),
        Action('do-fire-direct', function (bb) {
          if (bb.myDir === bb.shotDir) { bbSpeak(bb, '直射!'); bbFire(bb); }
          else bbTurnToward(bb, bb.shotDir);
        })
      ])
    );

    // 非安全直射（能打但有风险，优先级低于安全直射，高于守线）
    children.push(
      Sequence('fire-risky', [
        // 无星窗口 + 被动跑分传送敌：投机射击打不死(敌会传送遁走)，反而把自己拉离星点。
        // 让位给 movement→patrol 回中心预走位，抢下一颗星(mat_7kEU8 F108 打墙丢位复盘)。
        Guard('not-idle-vs-rusher', function (bb) {
          return bb.star || !enemyIsPassiveRusher(bb.enemy, bb.enemyTank, bb.game, bb.myPos);
        }),
        Guard('has-clear-shot', function (bb) { return !!bb.shotDir && bb.gunIsReady; }),
        Guard('can-shoot-enemy', function (bb) { return canShoot(bb.me, bb.enemy); }),
        // 近距被逼且需多帧转向 → 放弃攻击让 movement 后撤
        Guard('not-cornered-turning', function (bb) {
          if (bb.distToEnemy >= safeStandoffDistance(bb.enemy)) return true;
          return turnDistance(bb.myDir, bb.shotDir) < 2;
        }),
        Guard('shield-ok', function (bb) {
          return !enemyHasShieldSkill(bb.enemy) ||
            canShootThenEvadeShieldCounter(bb.me, bb.enemy, bb.enemyTank, bb.enemyBullets, bb.game, bb.enemyPos);
        }),
        Guard('not-double-threat', function (bb) {
          return !enemyDoubleLaneThreat(bb.enemy) ||
            bb.distToEnemy >= safeStandoffDistance(bb.enemy);
        }),
        Action('do-fire-risky', function (bb) {
          if (bb.myDir === bb.shotDir) { bbSpeak(bb, '开炮!'); bbFire(bb); }
          else bbTurnToward(bb, bb.shotDir);
        })
      ])
    );
  }

  // 守线预瞄：提前把炮口对准敌/星可能进入的路线
  if (profile.attackAggression === 'medium' || profile.attackAggression === 'high') {
    children.push(
      Sequence('guard-line', [
        // 无星窗口 + 被动跑分传送敌：守线预瞄=原地等敌进线，但敌只会传送抢星不来送线。
        // 同样让位给回中心预走位(mat_7kEU8 F101 守线丢位复盘)。
        Guard('not-idle-vs-rusher', function (bb) {
          return bb.star || !enemyIsPassiveRusher(bb.enemy, bb.enemyTank, bb.game, bb.myPos);
        }),
        Guard('has-guard-line', function (bb) { return !!senseGuardLineShot(bb); }),
        Guard('not-cornered-guard', function (bb) {
          if (!bb.enemyTank) return true;
          return bb.distToEnemy >= safeStandoffDistance(bb.enemy);
        }),
        Action('do-guard-line', function (bb) {
          var shot = senseGuardLineShot(bb);
          if (shot.fire) { bbSpeak(bb, '守线!'); bbFire(bb); }
          else bbTurnToward(bb, shot.dir);
        })
      ])
    );
  }

  // 远距清草预射：检测到草丛陷阱时朝可疑草丛开枪
  children.push(
    Sequence('bush-prefire', [
      Guard('bush-trap-detected', function (bb) {
        return !bb.enemyTank && inBushStarTrap(bb.me, bb.enemy, bb.enemyTank, bb.game, bb.memory);
      }),
      Guard('has-prefire-target', function (bb) { return !!senseBushPreFire(bb); }),
      Action('do-bush-prefire', function (bb) {
        var shot = senseBushPreFire(bb);
        if (bb.myDir === shot.dir) { bbSpeak(bb, '清草!'); bbFire(bb); }
        else bbTurnToward(bb, shot.dir);
      })
    ])
  );

  // 通用草丛盲射：敌人消失后朝其最后位置附近的草丛开枪
  children.push(
    Sequence('blind-bush-shot', [
      Guard('enemy-gone', function (bb) { return !bb.enemyTank; }),
      Guard('has-blind-target', function (bb) { return !!senseBlindBushShot(bb); }),
      Guard('i-am-safe', function (bb) {
        return !anyBulletThreatens(bb.enemyBullets, bb.myPos, bb.game);
      }),
      Action('do-blind-bush', function (bb) {
        var shot = senseBlindBushShot(bb);
        if (bb.myDir === shot.dir) { bbSpeak(bb, '盲射!'); bbFire(bb); }
        else bbTurnToward(bb, shot.dir);
      })
    ])
  );

  // 草丛攻防：预射打草惊蛇 / 草丛伏击
  if (profile.attackAggression === 'high') {
    children.push(
      Sequence('bush-shot', [
        Guard('has-bush-shot', function (bb) { return !!senseBushLineShot(bb); }),
        Action('do-bush-shot', function (bb) {
          var shot = senseBushLineShot(bb);
          if (shot.fire) { bbSpeak(bb, '草枪!'); bbFire(bb); }
          else bbTurnToward(bb, shot.dir);
        })
      ])
    );
  }

  return Selector('attack', children);
}

// ============================================================
// 主动放弹行为节点
// ============================================================

function createBombNodes(profile) {
  var children = [];

  // 1. 堵路炸弹：敌在身后追来，放弹堵路后跑
  children.push(
    Sequence('retreat-bomb', [
      Guard('has-retreat-bomb', function (bb) { return !!senseRetreatBomb(bb); }),
      Action('do-retreat-bomb', function (bb) {
        bbSpeak(bb, '堵路!');
        bbThrowBomb(bb);
      })
    ])
  );

  // 2. 抢星封路：星附近放弹封锁敌人来路
  children.push(
    Sequence('star-bomb', [
      Guard('has-star-bomb', function (bb) { return !!senseStarBomb(bb); }),
      Action('do-star-bomb', function (bb) {
        bbSpeak(bb, '封路!');
        bbThrowBomb(bb);
      })
    ])
  );

  // 3. 草丛陷阱：蹲草时放弹阴人
  children.push(
    Sequence('bush-bomb', [
      Guard('has-bush-bomb', function (bb) { return !!senseBushBomb(bb); }),
      Action('do-bush-bomb', function (bb) {
        bbSpeak(bb, '陷阱!');
        bbThrowBomb(bb);
      })
    ])
  );

  return Selector('bomb-attack', children);
}
