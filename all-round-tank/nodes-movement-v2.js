// ============================================================
// nodes-movement-v2.js — 移动层 BT 子树（替代评分引擎）
//
// 用 Selector 优先级替代 buildMoveCandidates + scoreMoveCandidate 的统一评分竞争。
// 每个策略是独立的 Sequence 节点：Guard 检查前置条件 → Action 执行移动。
// 优先级从高到低：追星 > 脱离双弹带 > 占射击线 > 保持距离 > 蹲草 > 防隐身 > 巡逻 > 兜底。
//
// 依赖：core-utils.js, tactics.js, movement-engine.js, bt-core.js, blackboard.js
// ============================================================

function createMovementTree(profile, mySkillType) {
  mySkillType = mySkillType || 'teleport';
  var children = [];

  // ---- 行/列锁定解冻（最高优先，杜绝原地空转等CD） ----
  // m5(mat_938IDiIJ1ZIEQUmqV)：我(overload)退到右墙角[17,5]，敌可见同列[17,9]、星夹中间[17,8]，
  // 炮在CD。追星=进敌列、右是墙退不开，下游 moveToward 在目标危险且无脱离时 me.turn("right")
  // (已面右=空操作)消费tick → 连冻7帧直到overload CD好才解冻。breakStuckStep 能确定性转向最近
  // 安全格([16,5])横向脱列。窄门控：仅 stuck>=3 + 敌可见同行/列 + 我不在草丛(不打断蹲草伏击)。
  children.push(
    Sequence('line-lock-unstick', [
      Guard('line-locked-stuck', function (bb) {
        if ((bb.memory.stuckFrames || 0) < 3) return false;
        if (!bb.enemyPos) return false;
        if (iAmHidden(bb.me, bb.game)) return false;
        return bb.myPos[0] === bb.enemyPos[0] || bb.myPos[1] === bb.enemyPos[1];
      }),
      Action('do-line-lock-unstick', function (bb) {
        clearShortIntent(bb.memory);
        breakStuckStep(bb.me, bb.game, bb.enemyPos, bb.enemyTank,
          bb.enemyBullets, bb.memory.lastMyPos2, bb.enemy);
      })
    ])
  );

  // ---- 传送落点偏移：传送后首帧立即移到相邻草丛（仅传送技能） ----
  if (mySkillType === 'teleport') children.push(
    Sequence('ambush-shift', [
      Guard('needs-shift', function (bb) {
        var a = bb.memory.ambushState;
        if (!a) return false;
        if (bb.frame - a.frame > 1) return false;
        if (a.shifted) return false;
        return samePos(bb.myPos, a.pos);
      }),
      Guard('shift-safe', function (bb) {
        return !anyBulletThreatens(bb.enemyBullets, bb.myPos, bb.game);
      }),
      Action('do-ambush-shift', function (bb) {
        var a = bb.memory.ambushState;
        var shiftTarget = findPostTeleportShift(a.pos, a.star, bb.game, bb.enemyBullets);
        if (!shiftTarget) {
          a.shifted = true;
          return;
        }
        bbDirectGo(bb, shiftTarget);
        a.shiftTarget = shiftTarget;
      })
    ])
  );

  // ---- 传送落点偏移完成确认（仅传送技能） ----
  if (mySkillType === 'teleport') children.push(
    Sequence('ambush-shift-confirm', [
      Guard('has-shift-target', function (bb) {
        var a = bb.memory.ambushState;
        if (!a || !a.shiftTarget) return false;
        if (a.shifted) return false;
        return true;
      }),
      Action('confirm-shift', function (bb) {
        var a = bb.memory.ambushState;
        if (samePos(bb.myPos, a.shiftTarget)) {
          a.pos = a.shiftTarget.slice();
          a.shifted = true;
          a.shiftTarget = null;
        } else if (bb.frame - a.frame > 3) {
          a.pos = bb.myPos.slice();
          a.shifted = true;
          a.shiftTarget = null;
        } else {
          bbDirectGo(bb, a.shiftTarget);
        }
      })
    ])
  );

  // ---- 伏击蹲守：传送到伏击位后原地等待射击（仅传送技能） ----
  if (mySkillType === 'teleport') children.push(
    Sequence('ambush-hold', [
      Guard('in-ambush', function (bb) {
        var a = bb.memory.ambushState;
        if (!a) return false;
        if (a.shiftTarget && !a.shifted) return false;
        var timeout = 15;
        if (bb.enemyTank && bb.star && manhattan(bb.enemyPos, bb.star) <= 8) timeout = 30;
        if (bb.enemyTank && bb.memory.lastEnemyPos && manhattan(bb.enemyPos, bb.myPos) < manhattan(bb.memory.lastEnemyPos, bb.myPos)) {
          timeout = Math.max(timeout, 25);
        }
        if (bb.frame - a.frame > timeout) { bb.memory.ambushState = null; bb.memory.ambushCooldown = bb.frame; return false; }
        if (!bb.star || !samePos(bb.star, a.star)) { bb.memory.ambushState = null; return false; }
        // 敌人比我更快到星且我射线不通 → 放弃伏击去追星
        if (bb.enemyTank && bb.star) {
          var myDistToStar = manhattan(bb.myPos, bb.star);
          var enemyDistToStar = manhattan(bb.enemyPos, bb.star);
          // 我对星位有清晰射线 → 敌必须踏上星才能吃,正好撞我炮线,守住别走。
          // 根因 mat_HCYBFZ: 我蹲草[13,2]面右对星[16,2]射线全通,敌从[16,5]来吃星
          // 平局判敌快+我对敌"当前位置"无射线→错误出草送死。实际该留在草里等敌到星位拦截。
          var coversStar = !!clearShotDirection(bb.myPos, bb.star, bb.game);
          if (enemyDistToStar <= myDistToStar &&
              !clearShotDirection(bb.myPos, bb.enemyPos, bb.game) && !coversStar) {
            bb.memory.ambushState = null; return false;
          }
          // 伏击位无法覆盖星+敌人且敌已逼近(≤5) → 守线价值归零，放弃
          if (enemyDistToStar <= 5 &&
              !clearShotDirection(bb.myPos, bb.star, bb.game) &&
              !clearShotDirection(bb.myPos, bb.enemyPos, bb.game)) {
            bb.memory.ambushState = null; return false;
          }
          // 我距星近(≤5)且伏击位无射线覆盖星和敌来路 → 蹲守无价值，不如直接去吃星
          if (myDistToStar <= 5 &&
              !clearShotDirection(bb.myPos, bb.star, bb.game) &&
              !clearShotDirection(bb.myPos, bb.enemyPos, bb.game) &&
              bb.frame - a.frame >= 3) {
            bb.memory.ambushState = null; return false;
          }
        }
        // 敌不可见时：伏击位无射线覆盖星，且等了 5 帧以上 → 伏击无拦截价值，去追星
        if (!bb.enemyTank && bb.star && bb.frame - a.frame >= 5 &&
            !clearShotDirection(bb.myPos, bb.star, bb.game)) {
          bb.memory.ambushState = null; return false;
        }
        // 允许重定位中间帧：在伏击位或正在草丛中移动(距伏击位≤2)都算
        return iAmHidden(bb.me, bb.game) &&
          (samePos(bb.myPos, a.pos) || manhattan(bb.myPos, a.pos) <= 2);
      }),
      Guard('still-safe', function (bb) {
        return !anyBulletThreatens(bb.enemyBullets, bb.myPos, bb.game);
      }),
      Action('do-ambush-hold', function (bb) {
        var a = bb.memory.ambushState;
        // 选择蹲守朝向：对星射线 > 对敌方最后已知位置射线
        var faceDir = clearShotDirection(bb.myPos, a.star, bb.game);
        if (!faceDir && bb.memory.lastEnemyPos) {
          faceDir = clearShotDirection(bb.myPos, bb.memory.lastEnemyPos, bb.game);
        }
        // 敌人进入射线：直接开火
        if (bb.enemyTank && bb.gunIsReady) {
          var shotDir = clearShotDirection(bb.myPos, bb.enemyPos, bb.game);
          if (shotDir) {
            if (bb.myDir === shotDir) { bbSpeak(bb, '伏击!'); bbFire(bb); }
            else { bbTurnToward(bb, shotDir); }
            return;
          }
          // 预射击：伏击模式扩展到4步预判
          var preDir = canPreemptiveShot(bb.myPos, bb.myDir, bb.enemyTank, bb.game, bb.enemy);
          if (!preDir) {
            preDir = canAmbushLeadShot(bb.myPos, bb.myDir, bb.enemyTank, bb.game);
          }
          if (preDir) {
            if (bb.myDir === preDir) { bbSpeak(bb, '伏击!'); bbFire(bb); }
            else { bbTurnToward(bb, preDir); }
            return;
          }
          // 远距预瞄：敌3~6步外将穿线 → 提前转向
          var aimDir = canAmbushPreAim(bb.myPos, bb.myDir, bb.enemyTank, bb.star, bb.game);
          if (aimDir && bb.myDir !== aimDir) {
            bbTurnToward(bb, aimDir);
            return;
          }
        }
        // 障碍清除：星方向有土块挡住射线 → 打碎它
        if (bb.gunIsReady && bb.star) {
          var starLineDir = null;
          if (bb.star[0] === bb.myPos[0]) starLineDir = bb.star[1] < bb.myPos[1] ? 'up' : 'down';
          else if (bb.star[1] === bb.myPos[1]) starLineDir = bb.star[0] < bb.myPos[0] ? 'left' : 'right';
          if (starLineDir && !clearShotDirection(bb.myPos, bb.star, bb.game)) {
            var dd = { up:[0,-1], down:[0,1], left:[-1,0], right:[1,0] }[starLineDir];
            var cx = bb.myPos[0] + dd[0], cy = bb.myPos[1] + dd[1];
            var foundBlock = false;
            while (tileAt(bb.game, [cx, cy]) !== 'x') {
              if (tileAt(bb.game, [cx, cy]) === 'm') { foundBlock = true; break; }
              if (cx === bb.star[0] && cy === bb.star[1]) break;
              cx += dd[0]; cy += dd[1];
            }
            if (foundBlock) {
              if (bb.myDir === starLineDir) { bbSpeak(bb, '清障!'); bbFire(bb); }
              else { bbTurnToward(bb, starLineDir); }
              return;
            }
          }
        }
        // 伏击扫草：敌人不可见 + 伏击刚开始 → 朝草丛开炮扫描
        if (!bb.enemyTank && bb.gunIsReady && (bb.frame - a.frame) <= 8) {
          if (!bb.memory.ambushScannedDirs) bb.memory.ambushScannedDirs = {};
          var scanDir = findAmbushGrassScan(bb.myPos, bb.myDir, a.star, bb.game, bb.memory);
          if (scanDir) {
            if (bb.myDir === scanDir) {
              bbSpeak(bb, '扫草!');
              bbFire(bb);
              bb.memory.ambushScannedDirs[scanDir] = true;
            } else {
              bbTurnToward(bb, scanDir);
            }
            return;
          }
        }
        // 草丛重定位：当前位对星无射线 → 沿连通草丛挚到有射线的位置
        if (!faceDir && bb.star) {
          var better = findBetterAmbushBush(bb.myPos, bb.star, bb.game, bb.enemyBullets);
          if (better) {
            bbDirectGo(bb, better.step);
            a.pos = better.dest.slice();
            return;
          }
        }
        // 面朝最佳射线方向等待
        if (faceDir && bb.myDir !== faceDir) {
          bbTurnToward(bb, faceDir);
        }
      })
    ])
  );

  // ---- 隐身蹲草蹲守：cloak 到达目标草丛后等待射击 ----
  if (mySkillType === 'cloak') children.push(
    Sequence('cloak-bush-hold', [
      Guard('has-cloak-bush-target', function (bb) {
        var t = bb.memory.cloakBushTarget;
        if (!t) return false;
        if (bb.frame - t.frame > 25) { bb.memory.cloakBushTarget = null; return false; }
        // 有星伏击：星消失/移动则蹲守失去意义。无星伏击(t.star=null)：靠 25 帧超时兜底,
        // 但中途若新星生成则放弃无星蹲守(改走有星逻辑)。
        if (t.star) {
          if (!bb.star || !samePos(bb.star, t.star)) { bb.memory.cloakBushTarget = null; return false; }
        } else {
          if (bb.star) { bb.memory.cloakBushTarget = null; return false; }
        }
        return true;
      }),
      Guard('in-bush-or-cloaked', function (bb) {
        if (iAmHidden(bb.me, bb.game)) return true;
        var t = bb.memory.cloakBushTarget;
        if (t && bb.frame - t.frame <= 8 && !samePos(bb.myPos, t.pos)) return true;
        return false;
      }),
      Guard('still-safe-cbh', function (bb) {
        return !anyBulletThreatens(bb.enemyBullets, bb.myPos, bb.game);
      }),
      Action('do-cloak-bush-hold', function (bb) {
        var t = bb.memory.cloakBushTarget;
        if (!samePos(bb.myPos, t.pos) && manhattan(bb.myPos, t.pos) > 0) {
          if (iAmHidden(bb.me, bb.game) && manhattan(bb.myPos, t.pos) <= 2 &&
              ((t.star && clearShotDirection(bb.myPos, t.star, bb.game)) ||
               (bb.enemyPos && clearShotDirection(bb.myPos, bb.enemyPos, bb.game)))) {
            t.pos = bb.myPos.slice();
          } else {
            var step = nextStepToward(bb.myPos, t.pos, bb.game, bb.enemyPos);
            // 目标格安全校验：still-safe-cbh 只保证"当前格"全弹道(8格)安全，
            // 但 bbMoveToward 内部只查 2 格扫掠，4 格外来袭弹不会被拦 → 会主动迈进弹道送死
            // (mat_KzS5aD1AwYcGYrLuB: 从安全[1,8]走进[1,7],子弹沿row7从4格外杀来,撞死)。
            // 这里用 anyBulletThreatens(8格)显式校验下一步格；危险则放弃蹲守、原地(安全)等下帧重规划。
            if (step && anyBulletThreatens(bb.enemyBullets, step, bb.game)) {
              bb.memory.cloakBushTarget = null;
              return;
            }
            if (step) bbMoveToward(bb, step);
            return;
          }
        }
        if (bb.enemyTank && bb.gunIsReady) {
          var shotDir = clearShotDirection(bb.myPos, bb.enemyPos, bb.game);
          if (shotDir && canShoot(bb.me, bb.enemy)) {
            if (bb.myDir === shotDir) { bbSpeak(bb, '伏击!'); bbFire(bb); }
            else { bbTurnToward(bb, shotDir); }
            bb.memory.cloakBushTarget = null;
            return;
          }
        }
        var faceDir = t.star ? clearShotDirection(bb.myPos, t.star, bb.game) : null;
        if (!faceDir && bb.memory.lastEnemyPos) {
          faceDir = clearShotDirection(bb.myPos, bb.memory.lastEnemyPos, bb.game);
        }
        if (faceDir && bb.myDir !== faceDir) {
          bbTurnToward(bb, faceDir);
        }
      })
    ])
  );

  // ---- 蹲草等星（对 overload 双弹流 + 无星/可利用星诱敌 + 我在草丛） ----
  // 注意：不要求传送就绪——无星时原地藏着比暴露在外更安全，传送冷却中也应坚守
  // 有星时：
  //   - 星在我炮线上（与我同行/同列视线清晰）→ 敌人来追星必经我的射程，蹲守价值最高
  //   - 星不在炮线但敌人距星 ≤ 6 → 出草传星会暴露自己，继续蹲守更安全
  //   - 其他情况 → 出草追星
  if (profile.bushCamp) {
    children.push(
      Sequence('bush-hold', [
        Guard('is-overload-enemy', function (bb) { return enemyIsOverloadType(bb.enemy); }),
        Guard('bush-has-purpose', function (bb) {
          var isBoosted = !!(bb.me.status && bb.me.status.boosted);
          if (isBoosted) return false; // boost 期间绝不蹲草，要利用机动性

          // 高价值情况：无限蹲
          // 1. 星在我射线上（伏击价值）
          if (bb.star && clearShotDirection(bb.myPos, bb.star, bb.game)) return true;
          // 2. 敌人可见且近（≤6），有射杀机会
          if (bb.enemyTank && bb.distToEnemy <= 6) return true;
          // 3. CD 冷却中（等 boost CD 恢复后再出击）
          if (bb.me.skill && bb.me.skill.cooldown > 0 && bb.me.skill.cooldown <= 12) return true;

          // 低价值情况：限时蹲（最多 12 帧），超时则出草巡逻
          if (bb.mySkillType === 'boost') {
            var campFrames = bb.memory.bushCampFrames || 0;
            if (campFrames >= 12) return false;
          }
          return true;
        }),
        Guard('no-star-or-star-bait', function (bb) {
          if (!bb.star) return true;
          // 脚边星·敌远必吃（破死蹲）：星在 ≤2 步可达 + 敌离星 ≥8 格(短期不会来抢→伏击必落空)
          //   → 不蹲守，让位 star-chase 直接吃掉锁分。根因 mat_535(0:0 runTime负)：shield 坦克
          //   无传送，星[1,7]就贴我脚边1步(我[2,7]同行射线上)，敌全程在[13-17,13]远端从不靠近，
          //   "星在我射线上→无限蹲等伏击"却等不到敌来吃，整局5步0抢星被判负。伏击前提是敌会来抢
          //   这颗星走进我射线；敌远不来则蹲守纯亏，吃掉它既得分又否定敌人机会。门控窄(仅星贴脸+
          //   敌远)，不动"星在我射线+敌近会来抢"的正常伏击。
          var myStarD = pathDistance(bb.myPos, bb.star, bb.game, bb.enemyPos);
          if (myStarD >= 0 && myStarD <= 2 &&
              bb.enemyPos && manhattan(bb.enemyPos, bb.star) >= 8) {
            return false;
          }
          // 星在我炮线上：敌人追星必经我射程，继续蹲守等伏击
          if (clearShotDirection(bb.myPos, bb.star, bb.game)) return true;
          // 星不在炮线但敌人近星（≤8步可达）：出草传星会暴露自己
          if (bb.enemyPos && manhattan(bb.enemyPos, bb.star) <= 8) return true;
          // cloak 专属：无传送→远星永远够不到。但仅在"已持续蹲守 ≥16 帧仍零收益"时才释放——
          // 短期蹲守有伏击耐心价值(敌可能正走来),不能见远星就冲(随机图多数局星只是短暂远,
          // 无条件释放会让 cloak 过早冲进双弹送死,bench 偏负)。只打破无限死蹲,不动短期伏击。
          // 根因 mat_Inl1: 全场星都在>8格外,cloak f11~127 钉死[4,8]一炮没放,敌白嫖4星→0:4。
          // 窄门控只动 cloak(传送/boost/stun/poison/freeze/shield 走原逻辑,零附带)。
          if (bb.mySkillType === 'cloak' && bb.star &&
              (bb.memory.bushCampFrames || 0) >= 16 &&
              manhattan(bb.myPos, bb.star) > 8 &&
              !(bb.enemyPos && manhattan(bb.enemyPos, bb.star) <= 8)) {
            return false;
          }
          // 非 boost 坦克：星远或传送就绪时留在草丛等
          if (bb.teleportIsReady || (bb.mySkillType !== 'boost' && manhattan(bb.myPos, bb.star) > 8)) return true;
          // boost 坦克：星在≤10 格内就出草追
          if (bb.mySkillType === 'boost' && manhattan(bb.myPos, bb.star) <= 10) return false;
          return true;
        }),
        Guard('i-am-hidden', function (bb) { return iAmHidden(bb.me, bb.game); }),
        Guard('bush-safe', function (bb) {
          if (anyBulletThreatens(bb.enemyBullets, bb.myPos, bb.game)) return false;
          // 敌人近距瞄着我时仍通过——交 action 层反击/逃跑，防止死锁
          return true;
        }),
        Action('do-bush-hold', function (bb) {
          // 近距被瞄应急：反击或传送逃跑，避免死锁
          if (bb.enemyTank && bb.distToEnemy < 3 && enemyAimsAt(bb.myPos, bb.enemyTank, bb.game)) {
            if (bb.gunIsReady && bb.shotDir) {
              if (bb.myDir === bb.shotDir) { bbSpeak(bb, '草伏!'); bbFire(bb); return; }
              bbTurnToward(bb, bb.shotDir); return;
            }
            if (bb.teleportIsReady) {
              var escPos = senseEscapeTeleport(bb);
              if (escPos) { bbSpeak(bb, '逃!'); bbTeleport(bb, escPos); return; }
            }
          }
          // 草丛伏击：不受 attackAggression 限制
          if (bb.gunIsReady && bb.enemyTank) {
            // 敌已在炮线上
            if (bb.shotDir) {
              if (bb.myDir === bb.shotDir) { bbSpeak(bb, '草伏!'); bbFire(bb); return; }
              bbTurnToward(bb, bb.shotDir); return;
            }
            // 预射击：伏击模式扩展到4步预判
            var preDir = canPreemptiveShot(bb.myPos, bb.myDir, bb.enemyTank, bb.game, bb.enemy);
            if (!preDir) {
              preDir = canAmbushLeadShot(bb.myPos, bb.myDir, bb.enemyTank, bb.game);
            }
            if (preDir) {
              if (bb.myDir === preDir) { bbSpeak(bb, '草伏!'); bbFire(bb); return; }
              bbTurnToward(bb, preDir); return;
            }
            // 远距预瞄：敌3~6步外将穿线 → 提前转向
            var aimDir = canAmbushPreAim(bb.myPos, bb.myDir, bb.enemyTank, bb.star, bb.game);
            if (aimDir && bb.myDir !== aimDir) {
              bbTurnToward(bb, aimDir);
              return;
            }
          }
          // 草丛重定位：有星但对星无射线 → 沿连通草丛挪到有射线的位置
          if (bb.star && !clearShotDirection(bb.myPos, bb.star, bb.game)) {
            var betterBush = findBetterAmbushBush(bb.myPos, bb.star, bb.game, bb.enemyBullets);
            if (betterBush) {
              bbDirectGo(bb, betterBush.step);
              bb.memory.bushCampFrames = (bb.memory.bushCampFrames || 0) + 1;
              return;
            }
          }
          bb.memory.bushCampFrames = (bb.memory.bushCampFrames || 0) + 1;
          primeShortIntent(bb.memory, 'hold', bb.myPos, bb.frame, 3);
          bbSpeak(bb, '蹲草');
        })
      ])
    );
  }

  // ---- 隐身贴脸偷袭规避（窄门控·先于一切抢星移动）----
  // 根因 mat_无敌大黑狗(f23) + mat_华强b(f45) 两局同死法：cloak 敌中距(d=2~3)隐身后，隐身期间
  // 摸到我【正下方/正侧同列 d=1】，朝我垂直一炮当帧秒。我要么死站(cloak-defense 三分支被隐身
  // 火线/standoff 全拒→fall through 不动)、要么沿原线 star-chase 直走撞上(star-chase 优先级高于
  // cloak-defense)。共因：cloak 敌从 d<=4 隐身→2~3帧即可摸到 d=1 垂直秒，此窗口我若不主动挪窝
  // 破贴脸轨迹必死。
  //
  // 门控极窄(符合 memory"cloak 窄门控空间防御转正"——避让不丢星权)：
  //   仅 cloak 流 + 当前隐身(enemyTank=null) + 最后可见 ≤5 帧内 + 最后可见距离 d<=4。
  //   敌远(d>4)隐身→摸到 d=1 要 ≥4 帧，我有反应余量，不触发(不丢星权)；窗口仅 5 帧，过后
  //   star-chase 照常恢复。绝不死站：diagonalEvadeStep 之字脱离为先，失败则任意远离 lastEnemyPos
  //   的可走格兜底(站着挨贴脸秒比任何挪窝都差)。
  children.push(
    Sequence('cloak-close-evade', [
      Guard('cloak-invisible-recent-close', function (bb) {
        if (!enemyIsCloakType(bb.enemy)) return false;
        if (bb.enemyTank) return false;                       // 敌可见→交常规对抗
        if (!bb.memory.lastEnemyPos) return false;
        if (bb.frame - bb.memory.lastEnemySeenFrame > 5) return false;
        if (manhattan(bb.myPos, bb.memory.lastEnemyPos) > 4) return false;  // 仅贴脸偷袭前兆
        return true;
      }),
      Action('do-cloak-close-evade', function (bb) {
        var dangerPos = bb.memory.lastEnemyPos;
        bbSpeak(bb, '隐身贴脸!');
        // 1) 之字脱离(破任何同行/同列偷袭直线)，过子弹安全检查
        var zig = diagonalEvadeStep(bb.myPos, dangerPos, bb.game, bb.memory);
        if (zig && !anyBulletThreatens(bb.enemyBullets, zig, bb.game) &&
            !stepIntoBulletPath(bb.enemyBullets, zig, bb.game)) {
          bbMoveToward(bb, zig);
          return;
        }
        // 2) 兜底：任意可走 + 远离 lastEnemyPos + 不撞子弹 的格(绝不死站)
        var best = null, bestScore = -9999;
        for (var i = 0; i < DIRS.length; i++) {
          var p = [bb.myPos[0] + DIRS[i].dx, bb.myPos[1] + DIRS[i].dy];
          if (!isPassable(bb.game, p, null)) continue;
          if (anyBulletThreatens(bb.enemyBullets, p, bb.game)) continue;
          if (stepIntoBulletPath(bb.enemyBullets, p, bb.game)) continue;
          // 远离危险 + 脱离同行/同列(破贴脸垂直射线) + 离边远
          var offLine = (p[0] !== dangerPos[0] ? 1 : 0) + (p[1] !== dangerPos[1] ? 1 : 0);
          var score = manhattan(p, dangerPos) * 2 + offLine * 4 + distanceFromEdges(p, bb.game) * 0.5;
          if (score > bestScore) { bestScore = score; best = p; }
        }
        if (best) { bbMoveToward(bb, best); return; }
        // 3) 全被封：转向 lastEnemyPos 方向准备对射(总比背对挨打强)
        var faceDir = directionBetween(bb.myPos, dangerPos);
        if (faceDir && bb.myDir !== faceDir) bbTurnToward(bb, faceDir);
      })
    ])
  );

  // ---- 吃星后撤退意图：刚吃完星的短窗口内主动远离危险 ----
  children.push(
    Sequence('post-star-retreat', [
      Guard('just-ate-star', function (bb) {
        if (bb.memory.shortIntent) return false; // 已有意图不覆盖
        if (bb.star) return false; // 星还在则没吃到
        if (!bb._lastGrabFrame || bb.frame - bb._lastGrabFrame > 1) return false;
        return true;
      }),
      Action('do-retreat', function (bb) {
        var dangerPos = bb.enemyPos || bb.memory.lastEnemyPos;
        if (!dangerPos) return;
        // 找远离危险且开阔的方向走2步
        var best = null, bestScore = -9999;
        for (var i = 0; i < DIRS.length; i++) {
          var p = [bb.myPos[0] + DIRS[i].dx, bb.myPos[1] + DIRS[i].dy];
          if (!isPassable(bb.game, p, bb.enemyPos)) continue;
          if (anyBulletThreatens(bb.enemyBullets, p, bb.game)) continue;
          var score = manhattan(p, dangerPos) * 3 + openNeighborCount(p, bb.game);
          var dirToP = directionBetween(bb.myPos, p);
          if (dirToP === bb.myDir) score += 50;
          if (score > bestScore) { bestScore = score; best = p; }
        }
        if (best) primeShortIntent(bb.memory, 'retreat', best, bb.frame, 2);
      })
    ])
  );

  // ---- 短期意图续跑（缓存的 2~4 步低风险计划，防横跳） ----
  children.push(
    Sequence('short-intent', [
      Guard('has-short-intent', function (bb) {
        var intent = resolveShortIntentStep(
          bb.me, bb.enemy, bb.enemyTank, bb.enemyBullets, bb.game, bb.memory
        );
        if (!intent) return false;
        bb._cache._shortIntent = intent;
        return true;
      }),
      Action('do-short-intent', function (bb) {
        var intent = bb._cache._shortIntent;
        if (intent.hold) return;
        if (bb.memory.stuckFrames >= 2) {
          clearShortIntent(bb.memory);
          breakStuckStep(bb.me, bb.game, bb.enemyPos, bb.enemyTank,
            bb.enemyBullets, bb.memory.lastMyPos2, bb.enemy);
          return;
        }
        var starLiveBullet = !!(bb.enemy && bb.enemy.bullet && bb.enemy.bullet.position);
        if (intent.kind === 'star' && !starLiveBullet) {
          bbDirectGo(bb, intent.step);
        } else {
          bbMoveToward(bb, intent.step);
        }
      })
    ])
  );

  // ---- 争星空窗推进 ----
  children.push(
    Sequence('star-contest', [
      Guard('star-exists', function (bb) { return !!bb.star; }),
      Guard('enemy-visible', function (bb) { return !!bb.enemyTank; }),
      Guard('both-near-star', function (bb) {
        return bb.distToStar <= 6 && manhattan(bb.enemyPos, bb.star) <= 6;
      }),
      Guard('has-contest-push', function (bb) {
        var push = findStarContestPush(bb.me, bb.enemy, bb.enemyTank, bb.game, bb.enemyBullets);
        if (!push) return false;
        bb._cache._contestPush = push;
        return true;
      }),
      Action('do-contest-push', function (bb) {
        bbDirectGo(bb, bb._cache._contestPush.step);
      })
    ])
  );

  // ---- 追星 ----
  children.push(
    Sequence('star-chase', [
      Guard('star-exists', function (bb) { return !!bb.star; }),
      Guard('should-chase', function (bb) {
        var starPath = shortestPathInfo(bb.myPos, bb.star, bb.game, bb.enemyPos);
        if (!starPath || !starPath.step) return false;
        var fleeMode = !!(bb.memory && bb.memory.enemyFleeFrames >= ENEMY_FLEE_THRESHOLD);
        if (!shouldChaseStar(bb.myPos, bb.enemyPos, bb.game, starPath, bb.enemy, fleeMode, bb.me, bb.enemyTank)) return false;
        // overload 陷阱检查
        if (bb.enemyPos && enemyDoubleLaneThreat(bb.enemy) &&
            starGrabTrapsInOverloadLane(starPath.step, bb.enemyPos, bb.game)) return false;
        // 草丛伏击陷阱：敌人消失 + 星附近有草丛在射击线上
        if (!bb.enemyTank && inBushStarTrap(bb.me, bb.enemy, bb.enemyTank, bb.game, bb.memory)) return false;
        bb._cache._starPath = starPath;
        return true;
      }),
      Guard('star-step-safe', function (bb) {
        var starPath = bb._cache._starPath;
        var standoff = safeStandoffDistance(bb.enemy);
        if (isSafeStep(starPath.step, bb.myPos, bb.enemyPos, bb.game,
          bb.enemy, standoff, samePos(starPath.step, bb.star), bb.enemyBullets, bb.memory)) {
          return true;
        }
        // 追星宽松豁免：敌人不面对我或弹管空时，d=3 也可接受
        if (bb.enemyTank && bb.enemyPos) {
          var dist = manhattan(starPath.step, bb.enemyPos);
          if (dist === 3 && !anyBulletThreatens(bb.enemyBullets, starPath.step, bb.game)) {
            var dirToStep = clearShotDirection(bb.enemyPos, starPath.step, bb.game);
            if (!dirToStep) return true;
            var enemyFacing = (dirToStep === bb.enemyTank.direction);
            if (!enemyFacing) return true;
            if (!enemyCanFireSoon(bb.enemy)) return true;
          }
        }
        // 护盾豁免：开盾中被打也不死，d>=2 都可接受（d=1 贴脸仍危险因为盾只4帧）
        if (bb.me.status && bb.me.status.shielded && bb.enemyPos) {
          var shieldDist = manhattan(starPath.step, bb.enemyPos);
          if (shieldDist >= 2) return true;
        }
        // 原地等空档（用户策略②/mat_Eli9wJG f44）：前向星步暂被"会飞走的弹"挡，但我当前格
        // 安全 + 弹推进1帧后离开该步格(临时弹墙,非持续封锁) → 停一帧等弹过、下帧突破，
        // 而非掉头后退再回头(每周期错过空档,[10,8]↔[10,7]永久振荡)。
        // 门控严格防死等：step 不安全的唯一原因是弹威胁(非墙/敌真炮口) + 我当前格无弹 +
        // 弹1帧内离开 step + 非双弹(覆盖带复杂不投机)。
        if (anyBulletThreatens(bb.enemyBullets, starPath.step, bb.game) &&
            isPassable(bb.game, starPath.step, bb.enemyPos) &&
            !anyBulletThreatens(bb.enemyBullets, bb.myPos, bb.game) &&
            !enemyDoubleLaneThreat(bb.enemy) &&
            !(bb.enemyTank && enemyAimsAt(starPath.step, bb.enemyTank, bb.game) &&
              enemyCanFireSoon(bb.enemy))) {
          var bulletsNext = advanceBullets(bb.enemyBullets, BULLET_SPEED);
          if (!anyBulletThreatens(bulletsNext, starPath.step, bb.game) &&
              !stepIntoBulletPath(bulletsNext, starPath.step, bb.game)) {
            bb._cache._starPath = { step: bb.myPos.slice(), dist: starPath.dist, hold: true };
            return true;
          }
        }
        // 子弹窗口豁免：敌人子弹在途(不能再射) + 我方已卡住 → d>=2 暂时安全，放行冲星
        // 但中途步(非抢星最后一步)排除步入敌炮口正对方向(mat_6OkNLt5u: d=2同行被弹回即射杀)
        // 最后一步(dist≤1=直接吃星)豁免此限制：抢到就跑，1帧暴露可接受
        if ((bb.memory.stuckFrames || 0) >= 6 &&
            bb.enemy && bb.enemy.bullet && bb.enemy.bullet.position && !enemyDoubleLaneThreat(bb.enemy)) {
          if (bb.enemyPos) {
            var bulletWindowDist = manhattan(starPath.step, bb.enemyPos);
            if (bulletWindowDist >= 2 &&
                (starPath.dist <= 1 || !enemyAimsAt(starPath.step, bb.enemyTank, bb.game))) return true;
          }
        }
        // 蹲点封锁突破：敌蹲星旁持续开火封锁(mat_AEYpdxLQVymJqeci2: 敌[3,7]朝up射，
        // 星[3,6]被kill zone+子弹周期封死128帧)。利用射击间隙窗口强冲：
        // 敌弹在途(不能再射) + 当前无弹威胁目标格 + 目标贴近星 → 放行(允许 d=1 kill zone)
        if ((bb.memory.stuckFrames || 0) >= 8 && starPath.dist <= 2 &&
            bb.enemy && bb.enemy.bullet && bb.enemy.bullet.position &&
            !enemyDoubleLaneThreat(bb.enemy) &&
            !anyBulletThreatens(bb.enemyBullets, starPath.step, bb.game)) {
          return true;
        }
        // 蹲草封锁强冲豁免：严重卡住(≥12帧) + 星在2步内 → 无论 kill zone 都冲星
        // (mat_4heiXPL7UUB: 敌蹲[7,11]连射，星[7,10] d=1永远被kill zone封死→超时输)
        // 拿1星vs超时必输，哪怕被击杀也划算；且蹲草敌人射击有间隙可穿插
        if ((bb.memory.stuckFrames || 0) >= 12 && starPath.dist <= 2) {
          if (!anyBulletThreatens(bb.enemyBullets, starPath.step, bb.game)) return true;
        }
        // 更宽松的子弹窗口：严重卡住(≥10帧) + 当前没子弹威胁目标格 + 非双弹 → 放行
        // (解决蹲草敌周期性射击间有3-4帧安全窗口但原有豁免不匹配的情况)
        // 但必须排除隐藏敌火线(mat_5GvDSIdf4q0DW6MzT: 敌蹲草反复开火封行,豁免无视hidden fire line→送死)
        // 以及可见敌同线能开火(mat_Eg32r5kvaqsHAaQhJ: d=2但敌面对且枪就绪→同帧击杀)
        if ((bb.memory.stuckFrames || 0) >= 10 &&
            !anyBulletThreatens(bb.enemyBullets, starPath.step, bb.game) &&
            !enemyDoubleLaneThreat(bb.enemy)) {
          if (!bb.enemyPos) {
            if (!stepIntoHiddenEnemyFireLine(starPath.step, bb.myPos, bb.game, bb.memory,
                samePos(starPath.step, bb.star))) return true;
          } else if (manhattan(starPath.step, bb.enemyPos) >= 2) {
            var dirToStep = clearShotDirection(bb.enemyPos, starPath.step, bb.game);
            if (!dirToStep || !enemyCanFireSoon(bb.enemy)) return true;
          }
        }
        // 最优步不安全 → 探索次优路径：尝试其他方向的邻格作为第一步
        var bestAlt = null, bestAltDist = 9999;
        for (var i = 0; i < DIRS.length; i++) {
          var p = [bb.myPos[0] + DIRS[i].dx, bb.myPos[1] + DIRS[i].dy];
          if (samePos(p, starPath.step)) continue;
          if (!isPassable(bb.game, p, bb.enemyPos)) continue;
          if (!isSafeStep(p, bb.myPos, bb.enemyPos, bb.game,
            bb.enemy, standoff, samePos(p, bb.star), bb.enemyBullets, bb.memory)) continue;
          var altDist = pathDistance(p, bb.star, bb.game, bb.enemyPos);
          if (altDist < 0) continue;
          if (altDist < bestAltDist) { bestAltDist = altDist; bestAlt = p; }
        }
        if (bestAlt && bestAltDist <= starPath.dist + 2) {
          bb._cache._starPath = { step: bestAlt, dist: bestAltDist + 1 };
          return true;
        }
        // 2-step 绕路：卡住6帧+ 且 4邻全不安全时，看 2 步内能否绕过死区
        if ((bb.memory.stuckFrames || 0) >= 6) {
        for (var i2 = 0; i2 < DIRS.length; i2++) {
          var p1 = [bb.myPos[0] + DIRS[i2].dx, bb.myPos[1] + DIRS[i2].dy];
          if (!isPassable(bb.game, p1, bb.enemyPos)) continue;
          if (samePos(p1, starPath.step)) continue;
          if (anyBulletThreatens(bb.enemyBullets, p1, bb.game)) continue;
          for (var j2 = 0; j2 < DIRS.length; j2++) {
            var p2 = [p1[0] + DIRS[j2].dx, p1[1] + DIRS[j2].dy];
            if (!isPassable(bb.game, p2, bb.enemyPos)) continue;
            if (!isSafeStep(p2, p1, bb.enemyPos, bb.game,
              bb.enemy, standoff, samePos(p2, bb.star), bb.enemyBullets, bb.memory)) continue;
            var altDist2 = pathDistance(p2, bb.star, bb.game, bb.enemyPos);
            if (altDist2 < 0) continue;
            var totalDist = altDist2 + 2;
            if (totalDist < bestAltDist && totalDist <= starPath.dist + 4) {
              bestAltDist = totalDist; bestAlt = p1;
            }
          }
        }
        } // end stuckFrames gate
        if (bestAlt) {
          bb._cache._starPath = { step: bestAlt, dist: bestAltDist + 1 };
          return true;
        }
        return false;
      }),
      Action('do-star-chase', function (bb) {
        var starPath = bb._cache._starPath;
        // 原地等空档：不移动，朝星方向转向待命(弹过后下帧直接推进，省掉后退+回头2帧)
        if (starPath.hold) {
          bbSpeak(bb, '等空档');
          var faceDir = directionBetween(bb.myPos, bb.star);
          if (faceDir && bb.myDir !== faceDir) bbTurnToward(bb, faceDir);
          return;
        }
        // 贴脸星短意图
        if (starPath.dist <= 2 && !bb.memory.shortIntent) {
          primeShortIntent(bb.memory, 'star', bb.star, bb.frame, 2);
        }
        var enemyHasLiveBullet = !!(bb.enemy && bb.enemy.bullet && bb.enemy.bullet.position);
        if (!enemyHasLiveBullet && !enemyDoubleLaneThreat(bb.enemy)) {
          bbDirectGo(bb, starPath.step);
        } else {
          bbMoveToward(bb, starPath.step);
        }
      })
    ])
  );

  // ---- 追星破墙：被墙阻隔绕路远时打穿土墙走捷径 ----
  children.push(
    Sequence('star-dig', [
      Guard('star-exists', function (bb) { return !!bb.star; }),
      Guard('gun-ready', function (bb) { return bb.gunIsReady; }),
      Guard('stuck-or-far', function (bb) {
        return (bb.memory.stuckFrames || 0) >= 4 ||
          pathDistance(bb.myPos, bb.star, bb.game, bb.enemyPos) >= 8;
      }),
      Guard('no-bullet-threat', function (bb) {
        return !anyBulletThreatens(bb.enemyBullets, bb.myPos, bb.game);
      }),
      Guard('has-star-dig', function (bb) { return !!senseStarDigShot(bb); }),
      Action('do-star-dig', function (bb) {
        var dir = senseStarDigShot(bb);
        if (bb.myDir === dir) { bbSpeak(bb, '破墙追星'); bbFire(bb); }
        else bbTurnToward(bb, dir);
      })
    ])
  );

  // ---- 脱离双弹覆盖带 ----
  children.push(
    Sequence('band-escape', [
      Guard('overload-threat', function (bb) {
        return !!bb.enemyPos && enemyDoubleLaneThreat(bb.enemy);
      }),
      Guard('in-band', function (bb) {
        var distToEnemy = manhattan(bb.myPos, bb.enemyPos);
        var activeOverload = bb.enemy && bb.enemy.status && bb.enemy.status.overloaded;
        return activeOverload
          ? (distToEnemy <= 6 && inDoubleLaneBand(bb.enemyPos, bb.myPos, 6))
          : (distToEnemy <= 4 && inDoubleLaneBand(bb.enemyPos, bb.myPos, 4));
      }),
      Guard('escape-exists', function (bb) {
        var step = escapeDoubleLaneBand(bb.myPos, bb.enemyPos, bb.game, bb.enemyBullets);
        if (!step) return false;
        bb._cache._bandEscape = step;
        return true;
      }),
      Action('do-band-escape', function (bb) {
        bbMoveToward(bb, bb._cache._bandEscape);
      })
    ])
  );

  // ---- 占据射击线位（非 overload 敌人） ----
  if (!profile.bushCamp) {
    children.push(
      Sequence('occupy-lane', [
        Guard('enemy-visible', function (bb) { return !!bb.enemyPos; }),
        Guard('not-overload', function (bb) { return !enemyIsOverloadType(bb.enemy); }),
        Guard('gun-ready-to-advance', function (bb) { return bb.gunIsReady; }),
        Guard('lane-exists', function (bb) {
          var standoff = safeStandoffDistance(bb.enemy);
          // boost 绕背：加速中+敌人没面对我→偏向敌人背后射击线位
          var preferDir = null;
          if (bb.me.status && bb.me.status.boosted && bb.enemyTank) {
            var dirToMe = clearShotDirection(bb.enemyPos, bb.myPos, bb.game);
            if (!dirToMe || dirToMe !== bb.enemyTank.direction) {
              var opposites = { up: 'down', down: 'up', left: 'right', right: 'left' };
              preferDir = opposites[bb.enemyTank.direction] || null;
            }
          }
          var step = nextStepToFiringLane(bb.myPos, bb.enemyPos, bb.game, standoff, preferDir);
          if (!step) return false;
          bb._cache._laneStep = step;
          return true;
        }),
        Action('do-lane', function (bb) {
          var step = bb._cache._laneStep;
          var goDir = directionBetween(bb.myPos, step);
          // boost 中利用 turnGo：需转90°且路径安全时同帧 turn+go
          if (goDir && bb.me.status && bb.me.status.boosted &&
              bb.myDir !== goDir && turnDistance(bb.myDir, goDir) === 1 &&
              boostPathSafe(bb.myPos, goDir, bb.game, bb.enemyPos, bb.enemyBullets, bb.enemyTank, bb.enemy, bb.memory)) {
            bbTurnToward(bb, goDir);
            bb.me.go();
          } else {
            bbMoveToward(bb, step);
          }
        })
      ])
    );
  }

  // ---- 保持安全交火距离 ----
  children.push(
    Sequence('maintain-standoff', [
      Guard('enemy-visible', function (bb) { return !!bb.enemyPos; }),
      Guard('standoff-step', function (bb) {
        // 取 profile 期望距离与硬安全底线中的较大值
        var profileStandoff = (bb.profile && bb.profile.standoffDistance) || 4;
        var standoff = Math.max(profileStandoff, safeStandoffDistance(bb.enemy));
        var step = nextStepToStandoff(bb.myPos, bb.enemyPos, bb.game, standoff, bb.enemy, bb.enemyBullets);
        if (!step) return false;
        // 不进死胡同
        if (stepIntoSealedDeadEnd(step, bb.enemyPos, bb.game)) {
          step = safestNonDeadEndStep(bb.myPos, bb.game, bb.enemyPos, bb.enemyBullets);
        }
        if (!step) return false;
        bb._cache._standoffStep = step;
        return true;
      }),
      Action('do-standoff', function (bb) {
        bbMoveToward(bb, bb._cache._standoffStep);
      })
    ])
  );

  // ---- 蹲草躲避（overload 敌 + 无星） ----
  if (profile.bushCamp) {
    children.push(
      Sequence('seek-bush', [
        Guard('overload-enemy', function (bb) { return enemyIsOverloadType(bb.enemy); }),
        Guard('no-star', function (bb) { return !bb.star; }),
        Guard('not-hidden', function (bb) { return !iAmHidden(bb.me, bb.game); }),
        // 敌人贴近时（≤ 3 格）不去奔草，移动本身会暴露在炮线上，交 maintain-standoff 处理
        Guard('enemy-not-too-close', function (bb) {
          return !bb.enemyPos || bb.distToEnemy > 3;
        }),
        Guard('bush-step', function (bb) {
          var standoff = safeStandoffDistance(bb.enemy);
          var step = nextStepToSafeBush(bb.me, bb.enemy, bb.game, bb.enemyPos, standoff, bb.enemyBullets);
          if (!step) return false;
          bb._cache._bushStep = step;
          return true;
        }),
        Action('do-seek-bush', function (bb) {
          bbMoveToward(bb, bb._cache._bushStep);
        })
      ])
    );
  }

  // ---- 防隐身：之字形 + 逃脱伏击线 + 保持距离 ----
  children.push(
    Sequence('cloak-defense', [
      Guard('cloak-recently-seen', function (bb) {
        return !!bb.memory.lastEnemyPos &&
          enemyIsCloakType(bb.enemy) &&
          (bb.frame - bb.memory.lastEnemySeenFrame <= 8);
      }),
      // 内嵌 Selector：zigzag 优先，然后 ambush，最后 avoid
      Action('do-cloak-defense', function (bb) {
        var dangerPos = bb.memory.lastEnemyPos;
        // 尝试 zigzag
        var zigStep = diagonalEvadeStep(bb.myPos, dangerPos, bb.game, bb.memory);
        if (zigStep && isSafeStep(zigStep, bb.myPos, bb.enemyPos, bb.game,
            bb.enemy, safeStandoffDistance(bb.enemy), false, bb.enemyBullets, bb.memory)) {
          bbMoveToward(bb, zigStep);
          return;
        }
        // 尝试 ambush escape
        var ambushStep = escapeAmbushLine(bb.myPos, dangerPos, bb.game, bb.enemyBullets);
        if (ambushStep && isSafeStep(ambushStep, bb.myPos, bb.enemyPos, bb.game,
            bb.enemy, safeStandoffDistance(bb.enemy), false, bb.enemyBullets, bb.memory)) {
          bbMoveToward(bb, ambushStep);
          return;
        }
        // 尝试 avoid
        var avoidStep = nextStepAvoiding(bb.myPos, dangerPos, bb.game,
          safeStandoffDistance(bb.enemy) + 1, bb.enemyBullets, bb.enemy);
        if (avoidStep) {
          bbMoveToward(bb, avoidStep);
          return;
        }
      })
    ])
  );

  // ---- 非隐身敌人的伏击线逃离 ----
  children.push(
    Sequence('escape-ambush', [
      Guard('enemy-recently-seen', function (bb) {
        if (!bb.memory.lastEnemyPos || bb.enemyPos) return false;
        if (enemyIsCloakType(bb.enemy)) return false;
        if (bb.frame - bb.memory.lastEnemySeenFrame <= 8) return true;
        // bushHeatmap 高置信条目存在时延长窗口（蹲草敌可能持续数十帧不动）
        var hm = bb.memory.bushHeatmap;
        if (hm) {
          for (var k in hm) {
            if (hm.hasOwnProperty(k) && hm[k].score >= 50) return true;
          }
        }
        return false;
      }),
      Guard('ambush-step', function (bb) {
        // 优先用 lastEnemyPos；过时时改用 bushHeatmap 中最高分位置
        var dangerPos = bb.memory.lastEnemyPos;
        if (bb.frame - bb.memory.lastEnemySeenFrame > 8) {
          var hm = bb.memory.bushHeatmap;
          var bestK = null, bestS = 0;
          if (hm) {
            for (var k in hm) {
              if (hm.hasOwnProperty(k) && hm[k].score > bestS) { bestS = hm[k].score; bestK = k; }
            }
          }
          if (bestK) {
            var parts = bestK.split(',');
            dangerPos = [parseInt(parts[0]), parseInt(parts[1])];
          }
        }
        var step = escapeAmbushLine(bb.myPos, dangerPos, bb.game, bb.enemyBullets);
        if (!step) return false;
        bb._cache._ambushStep = step;
        return true;
      }),
      Action('do-escape-ambush', function (bb) {
        bbMoveToward(bb, bb._cache._ambushStep);
      })
    ])
  );

  // ---- 巡逻 ----
  children.push(
    Sequence('patrol', [
      Guard('patrol-target', function (bb) {
        var vt = virtualPatrolTarget(bb.me, bb.game, bb.memory, bb.enemy);
        if (!vt) return false;
        var step = nextStepToward(bb.myPos, vt, bb.game, null);
        if (!step) return false;
        var standoff = safeStandoffDistance(bb.enemy);
        if (!isSafeStep(step, bb.myPos, bb.enemyPos, bb.game,
            bb.enemy, standoff, false, bb.enemyBullets, bb.memory)) {
          step = safestNonDeadEndStep(bb.myPos, bb.game, bb.enemyPos, bb.enemyBullets);
          if (!step) return false;
          if (!isSafeStep(step, bb.myPos, bb.enemyPos, bb.game,
              bb.enemy, standoff, false, bb.enemyBullets, bb.memory)) return false;
        }
        bb._cache._patrolStep = step;
        return true;
      }),
      Action('do-patrol', function (bb) {
        bbMoveToward(bb, bb._cache._patrolStep);
      })
    ])
  );

  // ---- 破墙开路 ----
  children.push(
    Sequence('dig', [
      Guard('has-dig', function (bb) { return !!senseDigDirection(bb) && bb.gunIsReady; }),
      Action('do-dig', function (bb) {
        var dir = senseDigDirection(bb);
        if (bb.myDir === dir) { bbSpeak(bb, '破墙'); bbFire(bb); }
        else bbTurnToward(bb, dir);
      })
    ])
  );

  // ---- 安全邻格徘徊 ----
  children.push(
    Sequence('safe-neighbor', [
      Guard('has-safe-neighbor', function (bb) { return !!senseSafeNeighbor(bb); }),
      Action('do-safe-neighbor', function (bb) {
        bbMoveToward(bb, senseSafeNeighbor(bb));
      })
    ])
  );

  // ---- 终极兜底：尝试移动到任何可通行格，只避子弹不避射线 ----
  children.push(
    Action('fallback-move', function (bb) {
      var bullets = bb.enemyBullets || [];
      var best = null;
      var bestScore = -9999;
      for (var i = 0; i < DIRS.length; i++) {
        var p = [bb.myPos[0] + DIRS[i].dx, bb.myPos[1] + DIRS[i].dy];
        if (!isPassable(bb.game, p, bb.enemyPos)) continue;
        if (anyBulletThreatens(bullets, p, bb.game)) continue;
        var score = distanceFromEdges(p, bb.game);
        if (bb.enemyPos) score += manhattan(p, bb.enemyPos);
        if (!bb.enemyPos && bb.memory &&
            stepIntoHiddenEnemyFireLine(p, bb.myPos, bb.game, bb.memory, false)) score -= 80;
        if (score > bestScore) { bestScore = score; best = p; }
      }
      if (best) { bbDirectGo(bb, best); return; }
      if (bb.shotDir && bb.myDir !== bb.shotDir) { bbTurnToward(bb, bb.shotDir); return; }
      bb.me.turn('right');
    })
  );

  return Selector('movement', children);
}
