/**
 * build.js — 将各模块文件按依赖顺序拼接为单一可提交的 myth-tank-submit.js。
 *
 * 用法：
 *   node my-tank/build.js
 *
 * 输出：my-tank/myth-tank-submit.js（提交给 AgenTank 的最终文件）
 *
 * 模块加载顺序（后加载的文件可引用前文件中定义的函数）：
 *   1. state-store.js      — 跨帧状态层
 *   2. scoring.js          — 评分引擎
 *   3. action-proposals.js — 候选提案构建器
 *   4. myth-tank.js        — 所有工具函数（已移除 onIdle/state/proposals）
 *   5. decision-engine.js  — 新 onIdle 入口
 */

const fs   = require('fs');
const path = require('path');
const dir  = __dirname;

const MODULE_ORDER = [
  'state-store.js',
  'scoring.js',
  'action-proposals.js',
  'myth-tank.js',
  'decision-engine.js',
];

const banner = [
  '// ============================================================',
  '// myth-tank.js — 自动生成，请勿手动编辑',
  '// 源文件: ' + MODULE_ORDER.join(', '),
  '// 构建时间: ' + new Date().toISOString(),
  '// ============================================================',
  '',
].join('\n');

const body = MODULE_ORDER.map(function (file) {
  const filePath = path.join(dir, file);
  if (!fs.existsSync(filePath)) {
    throw new Error('缺少模块文件: ' + filePath);
  }
  const src = fs.readFileSync(filePath, 'utf8');
  return '// ===== ' + file + ' =====\n' + src;
}).join('\n\n');

const output = banner + body;
const outPath = path.join(dir, 'myth-tank-submit.js');
fs.writeFileSync(outPath, output, 'utf8');
console.log('✓ 构建完成 → ' + outPath + ' (' + output.length + ' 字节)');
