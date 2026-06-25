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
        Guard('close-range', function (bb) { return bb.distToEnemy <= 5; }),
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
        Guard('not-racing-star', function (bb) {
          if (!bb.star) return true;
          var myDist = pathDistance(bb.myPos, bb.star, bb.game, bb.enemyPos);
          if (myDist < 0 || myDist > 3) return true;
          var enmDist = bb.enemyPos ? pathDistance(bb.enemyPos, bb.star, bb.game, null) : 99;
          return myDist > enmDist;
        }),
        Guard('not-intercept-stale', function (bb) {
          return (bb.memory.interceptTurnFrames || 0) < 4;
        }),
        Guard('not-stuck-spinning', function (bb) {
          return (bb.memory.stuckFrames || 0) < 8;
        }),
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
          if (bb.myDir !== dir) return false;
          bb._cache._interceptDir = dir;
          return true;
        }),
        Action('do-intercept', function (bb) {
          var dir = bb._cache._interceptDir;
          bbSpeak(bb, '拦截!'); bbFire(bb);
          bb.memory.interceptTurnFrames = 0;
        })
      ])
    );
  }

  // 甩狙预冲：go一步到甩狙位 + turn+fire 排队秒射
  if (profile.attackAggression !== 'low') {
    children.push(
      Sequence('snap-approach', [
        // 甩狙是 boost 专属杀招：boost 才有同帧 turnGo/turnFire 的额外动作预算。
        // 非 boost 时引擎一帧只认一个命令，go+turn+fire 会丢掉后两个，把自己白送上敌炮线
        // (mat_6DokBQTwU69ApdHHo：非 boost 的 survivor 触发 snap-approach 只走了 go，被 stun 列秒)。
        Guard('boosted-sa', function (bb) { return !!(bb.me.status && bb.me.status.boosted); }),
        Guard('gun-ready-sa', function (bb) { return bb.gunIsReady; }),
        Guard('enemy-visible-sa', function (bb) { return !!bb.enemyTank; }),
        Guard('not-overload-sa', function (bb) { return !enemyDoubleLaneThreat(bb.enemy); }),
        Guard('no-direct-shot-sa', function (bb) { return !bb.shotDir; }),
        Guard('no-bullet-incoming-sa', function (bb) {
          return !anyBulletThreatens(bb.enemyBullets, bb.myPos, bb.game);
        }),
        Guard('has-snap-approach', function (bb) { return !!senseSnapApproach(bb); }),
        Action('do-snap-approach', function (bb) {
          var plan = senseSnapApproach(bb);
          bbSpeak(bb, '甩狙!');
          bb.me.go();
          turnToward(bb.me, plan.dir);
          bb.me.fire();
        })
      ])
    );

    // 甩狙秒射：已在同线 3-6 格 + 转向≤1 → turnFire
    children.push(
      Sequence('snap-fire', [
        // 同 snap-approach：仅 boost 时允许 turn+fire 同帧。非 boost 的"已对准只 fire"
        // 分支与下方 fire-direct 重复，整节点 boost 化不丢能力。
        Guard('boosted-sf', function (bb) { return !!(bb.me.status && bb.me.status.boosted); }),
        Guard('gun-ready-sf', function (bb) { return bb.gunIsReady; }),
        Guard('enemy-visible-sf', function (bb) { return !!bb.enemyTank; }),
        Guard('not-overload-sf', function (bb) { return !enemyDoubleLaneThreat(bb.enemy); }),
        Guard('no-bullet-incoming-sf', function (bb) {
          return !anyBulletThreatens(bb.enemyBullets, bb.myPos, bb.game);
        }),
        Guard('has-snap-fire', function (bb) { return !!senseSnapFireShot(bb); }),
        Action('do-snap-fire', function (bb) {
          var dir = senseSnapFireShot(bb);
          if (bb.myDir === dir) { bbSpeak(bb, '甩狙!'); bbFire(bb); }
          else { bbSpeak(bb, '甩狙!'); bbTurnToward(bb, dir); bbFire(bb); }
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

  // 破墙攻击：打穿土墙直接命中敌人
  if (profile.attackAggression !== 'low' && profile.attackAggression !== 'none') {
    children.push(
      Sequence('attack-dig', [
        Guard('no-direct-shot-ad', function (bb) { return !bb.shotDir; }),
        Guard('gun-ready-ad', function (bb) { return bb.gunIsReady; }),
        Guard('enemy-visible-ad', function (bb) { return !!bb.enemyTank; }),
        Guard('not-in-danger-ad', function (bb) {
          return !anyBulletThreatens(bb.enemyBullets, bb.myPos, bb.game);
        }),
        Guard('has-attack-dig', function (bb) { return !!senseAttackDigShot(bb); }),
        Action('do-attack-dig', function (bb) {
          var dir = senseAttackDigShot(bb);
          if (bb.myDir === dir) { bbSpeak(bb, '破墙!'); bbFire(bb); }
          else bbTurnToward(bb, dir);
        })
      ])
    );
  }

  // 守线预瞄：提前把炮口对准敌/星可能进入的路线
  if (profile.attackAggression === 'medium' || profile.attackAggression === 'high') {
    children.push(
      Sequence('guard-line', [
        Guard('not-racing-star', function (bb) {
          if (!bb.star) return true;
          var myDist = pathDistance(bb.myPos, bb.star, bb.game, bb.enemyPos);
          if (myDist < 0 || myDist > 3) return true;
          var enmDist = bb.enemyPos ? pathDistance(bb.enemyPos, bb.star, bb.game, null) : 99;
          return myDist > enmDist;
        }),
        Guard('not-guard-stale', function (bb) {
          return (bb.memory.guardLineTurnFrames || 0) < 4;
        }),
        Guard('not-stuck-spinning', function (bb) {
          return (bb.memory.stuckFrames || 0) < 8;
        }),
        Guard('has-guard-line', function (bb) {
          var shot = senseGuardLineShot(bb);
          return !!(shot && shot.fire);
        }),
        // 让位后撤的门控：只在敌"真握双弹"(已过载/cd<=1)且近距时才放弃守线。
        // 不能用 distToEnemy>=standoff 当硬闸——overload 流 standoff 恒=5，会把
        // "敌双弹已用掉、冷却中、我同行先手"的干净开火窗口也一刀切否决(mat_GhEi 墙角
        // [1,1] 同行先手却不开火、被普通补射打死)。senseGuardLineShot 内部已正确区分
        // 握弹/空窗，外层只在真握双弹时让位，其余信任内部判断。
        Guard('not-cornered-guard', function (bb) {
          if (!bb.enemyTank) return true;
          if (!enemyDoubleLaneThreat(bb.enemy)) return true; // 敌没握双弹 → 放行开火
          return bb.distToEnemy >= safeStandoffDistance(bb.enemy); // 真握双弹近距才让位后撤
        }),
        Action('do-guard-line', function (bb) {
          var shot = senseGuardLineShot(bb);
          if (shot.fire) {
            bbSpeak(bb, '守线!'); bbFire(bb);
            bb.memory.guardLineTurnFrames = 0;
          }
          // 不再转向预瞄（浪费帧数），只在已面朝时开火
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

  // 卡住盲射升级：反复卡住 + 星存在 + 敌不可见 → 强制朝草丛开火逼现身
  children.push(
    Sequence('stuck-bush-fire', [
      Guard('star-stuck', function (bb) {
        return !!bb.star && (bb.memory.stuckFrames || 0) >= 8;
      }),
      Guard('enemy-hidden', function (bb) { return !bb.enemyTank; }),
      Guard('gun-ready', function (bb) { return bb.gunIsReady; }),
      Guard('has-blind-target', function (bb) { return !!senseBlindBushShot(bb); }),
      Action('do-stuck-fire', function (bb) {
        var shot = senseBlindBushShot(bb);
        if (bb.myDir === shot.dir) { bbSpeak(bb, '逼现!'); bbFire(bb); }
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
      // 领先时别拿推测盲射去锁炮——盲射命中率低却锁炮约15帧，留炮防守更值。
      // 除非目标极近(<=3格)高置信才打(mat_28DHb：1-0领先时朝7格外开阔草丛盲射打空、
      // 锁炮15帧→后续被贴脸下射打死)。打平/落后时保持原激进盲射(需要制造机会)。
      Guard('blind-worth-it', function (bb) {
        if (!bb.isWinning) return true;
        var shot = senseBlindBushShot(bb);
        return !!(shot && shot.target && manhattan(bb.myPos, shot.target) <= 3);
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

  // 1.5 抢星封追：吃星瞬间放弹封住追击者
  children.push(
    Sequence('grab-bomb', [
      Guard('has-grab-bomb', function (bb) { return !!sensePostGrabBomb(bb); }),
      Action('do-grab-bomb', function (bb) {
        bbSpeak(bb, '封追!');
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

  // 3. 窄道预埋：主动封锁敌人必经窄道
  children.push(
    Sequence('choke-bomb', [
      Guard('has-choke-bomb', function (bb) { return !!senseChokeBomb(bb); }),
      Action('do-choke-bomb', function (bb) {
        bbSpeak(bb, '预埋!');
        bbThrowBomb(bb);
      })
    ])
  );

  // 4. 草丛陷阱：蹲草时放弹阴人
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
