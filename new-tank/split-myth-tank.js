/**
 * split-myth-tank.js — 将 myth-tank.js 按函数归属拆分为三个模块文件。
 *
 * 用法：node my-tank/new-tank/split-myth-tank.js
 * 输出：
 *   - core-utils.js
 *   - tactics.js
 *   - movement-engine.js
 *
 * 原理：读取 myth-tank.js 全文，按"function funcName("正则定位每个函数的起止行，
 *       根据预设分配表将函数归入对应模块。未被任何模块认领的函数归入 tactics.js（保守策略）。
 */

const fs = require('fs');
const path = require('path');

const srcPath = path.resolve(__dirname, '..', 'myth-tank.js');
const src = fs.readFileSync(srcPath, 'utf8');
const lines = src.split('\n');

// ===== 模块分配表 =====

const CORE_UTILS = new Set([
  // 常量区会单独处理（前 142 行）
  // 纯工具
  'manhattan', 'samePos', 'key', 'sign', 'dirIndex', 'tileAt', 'isPassable',
  'distanceFromEdges', 'clearBetween', 'directionBetween', 'nextInDirection',
  'openNeighborCount', 'isDeadEnd', 'stepIntoSealedDeadEnd', 'estimateEnemyHome',
  'turnDistance',
  // 寻路
  'shortestPathInfo', '_computeShortestPathInfo', 'firstStep', 'pathDistance',
  'nextStepToward', 'nextStepToGoal',
  // 子弹/威胁
  'bulletReachTiles', 'bulletFramesTo', 'bulletThreatens', 'stepIntoBulletPath',
  'anyBulletThreatens', 'minBulletFramesTo', 'collectEnemyBullets',
  'inferOverloadPairedBullet',
  // 敌情感知
  'gunReady', 'teleportReady', 'bombReady', 'canShoot', 'enemyAimsAt',
  'enemyCanFireSoon', 'enemyHasShieldSkill', 'enemyHasTeleport',
  'enemyTeleportReady', 'enemyDoubleLaneThreat', 'enemyIsOverloadType',
  'enemyIsFreezeType', 'enemyIsCloakType', 'enemyIsPassiveRusher',
  'iAmHidden', 'clearShotDirection',
  // 过载预测
  'advanceBullets', 'predictedOverloadBullets', 'predictedOverloadBulletsAll',
  'predictedOverloadThreatens',
  // 幽灵弹
  'advanceBulletPos', 'inBounds', 'isWallTile', 'updatePhantomBullets',
  // 炸弹工具
  'inBombBlast', 'bombTimeLeft', 'inMyBombBlast', 'cleanExpiredBombs',
  'canEscapeAfterBomb',
  // 移动执行
  'moveToward', 'turnToward', 'breakStuckStep', 'fastestEscapeNeighbor',
  'bestSafeNeighbor',
]);

const MOVEMENT_ENGINE = new Set([
  // 走位策略（被 nodes-movement-v2.js 的 BT 节点直接调用）
  'shouldChaseStar', 'virtualPatrolTarget', 'nextStepToSafeBush',
  'nextStepToStandoff', 'nextStepToFiringLane', 'stepAwayFromEnemy',
  'escapeDoubleLaneBand', 'escapeAmbushLine', 'diagonalEvadeStep',
  'nextStepAvoiding', 'safestNonDeadEndStep', 'isSafeStep',
  'nearestOpenTo', 'isStarGuardTrap', 'starGrabTrapsInOverloadLane',
  // 评分引擎（删除，不归入任何模块）
  // 'buildMoveCandidates', 'scoreMoveCandidate', 'chooseMoveCandidateScored',
  // 'chooseStepScored', 'chooseStep',
]);

// 要完全删除的函数（评分引擎，新版 BT 不再需要）
const DELETE = new Set([
  'buildMoveCandidates', 'scoreMoveCandidate', 'chooseMoveCandidateScored',
  'chooseStepScored', 'chooseStep',
]);

// ===== 解析函数边界 =====

function parseFunctions(lines) {
  const funcs = [];
  const funcRegex = /^function\s+(\w+)\s*\(/;

  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(funcRegex);
    if (m) {
      funcs.push({ name: m[1], startLine: i });
    }
  }

  // 确定每个函数的结束行（下一个函数的开始前，或文件末尾）
  for (let i = 0; i < funcs.length; i++) {
    const nextStart = (i + 1 < funcs.length) ? funcs[i + 1].startLine : lines.length;
    // 向前找函数前的注释块起始
    let commentStart = funcs[i].startLine;
    while (commentStart > 0 && (
      lines[commentStart - 1].trim().startsWith('*') ||
      lines[commentStart - 1].trim().startsWith('/**') ||
      lines[commentStart - 1].trim().startsWith('//') ||
      lines[commentStart - 1].trim() === ''
    )) {
      commentStart--;
    }
    // 找函数体结束（匹配花括号）
    let braceCount = 0;
    let endLine = funcs[i].startLine;
    for (let j = funcs[i].startLine; j < nextStart; j++) {
      for (let c = 0; c < lines[j].length; c++) {
        if (lines[j][c] === '{') braceCount++;
        if (lines[j][c] === '}') braceCount--;
      }
      if (braceCount === 0 && j > funcs[i].startLine) {
        endLine = j;
        break;
      }
    }
    if (endLine === funcs[i].startLine) endLine = nextStart - 1;

    funcs[i].commentStart = commentStart;
    funcs[i].endLine = endLine;
  }

  return funcs;
}

// ===== 提取常量区（文件开头到第一个 function 之前） =====

const funcs = parseFunctions(lines);
const firstFuncLine = funcs.length > 0 ? funcs[0].commentStart : lines.length;

// 常量区 = 行 0 到 firstFuncLine-1（含注释头和所有 const/var 定义）
const constantsBlock = lines.slice(0, firstFuncLine).join('\n');

// 额外的常量区（文件末尾的 DIR_DELTAS 等，在函数之间定义的）
// 找 "const DIR_DELTAS", "const BOMB_*" 等行
const lateConstants = [];
for (let i = firstFuncLine; i < lines.length; i++) {
  if (/^const\s+(DIR_DELTAS|BOMB_FUSE_FRAMES|BOMB_BLAST_RANGE|BOMB_COOLDOWN_FRAMES)\s*=/.test(lines[i])) {
    lateConstants.push(lines[i]);
  }
}

// BFS 缓存变量
const bfsCacheLines = [];
for (let i = 0; i < lines.length; i++) {
  if (/^var\s+_bfsCache/.test(lines[i]) || /^var\s+_bfsCacheFrame/.test(lines[i]) || /^var\s+_bfsCacheGame/.test(lines[i])) {
    bfsCacheLines.push(lines[i]);
  }
}

// ===== 分配函数到模块 =====

const coreBlocks = [];
const tacticsBlocks = [];
const movementBlocks = [];

for (const func of funcs) {
  const block = lines.slice(func.commentStart, func.endLine + 1).join('\n');

  if (DELETE.has(func.name)) {
    continue; // 跳过，不输出
  } else if (CORE_UTILS.has(func.name)) {
    coreBlocks.push(block);
  } else if (MOVEMENT_ENGINE.has(func.name)) {
    movementBlocks.push(block);
  } else {
    // 默认归入 tactics（保守：宁可多保留不漏）
    tacticsBlocks.push(block);
  }
}

// ===== 写出文件 =====

const coreHeader = `// ============================================================
// core-utils.js — 纯工具函数层
//
// 几何/寻路/子弹计算/敌情感知/移动执行等无策略逻辑的基础函数。
// 所有上层模块（tactics.js / movement-engine.js / BT nodes）共同依赖此文件。
// ============================================================

`;

const tacticsHeader = `// ============================================================
// tactics.js — 战术决策层
//
// find*/传送/刺杀/攻击安全判定/射击窗口等战术函数。
// 依赖 core-utils.js 的工具函数。被 blackboard.js 的传感器调用。
// ============================================================

`;

const movementHeader = `// ============================================================
// movement-engine.js — 走位策略层
//
// 走位单步策略函数：追星/巡逻/standoff/蹲草/逃离覆盖带等。
// 被 nodes-movement-v2.js 的 BT 节点直接调用。
// 依赖 core-utils.js + tactics.js。
// ============================================================

`;

const coreContent = coreHeader + constantsBlock + '\n\n' +
  lateConstants.join('\n') + '\n\n' +
  bfsCacheLines.join('\n') + '\n\n' +
  coreBlocks.join('\n\n') + '\n';

const tacticsContent = tacticsHeader + tacticsBlocks.join('\n\n') + '\n';

const movementContent = movementHeader + movementBlocks.join('\n\n') + '\n';

const outDir = __dirname;
fs.writeFileSync(path.join(outDir, 'core-utils.js'), coreContent, 'utf8');
fs.writeFileSync(path.join(outDir, 'tactics.js'), tacticsContent, 'utf8');
fs.writeFileSync(path.join(outDir, 'movement-engine.js'), movementContent, 'utf8');

console.log('✓ core-utils.js      — ' + coreBlocks.length + ' 个函数');
console.log('✓ tactics.js         — ' + tacticsBlocks.length + ' 个函数');
console.log('✓ movement-engine.js — ' + movementBlocks.length + ' 个函数');
console.log('✗ 已删除评分引擎    — ' + DELETE.size + ' 个函数');
console.log('');
console.log('总计保留: ' + (coreBlocks.length + tacticsBlocks.length + movementBlocks.length));
console.log('已删除:   ' + DELETE.size);
