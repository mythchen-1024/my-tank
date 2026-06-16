/**
 * build.js — 将行为树坦克各模块拼接为单一可提交的 js 文件。
 *
 * 用法：
 *   node my-tank/new-tank/build.js
 *
 * 输出：my-tank/new-tank/bt-tank-submit.js
 *
 * 模块加载顺序（后加载的文件可引用前文件中定义的函数）：
 *   ┌─ 底层工具 ──────────────────────────────────┐
 *   │  1. ../myth-tank.js     — 全部工具函数       │
 *   │  2. ../state-store.js   — 跨帧状态管理       │
 *   ├─ 行为树框架 ────────────────────────────────┤
 *   │  3. bt-core.js          — BT 核心节点类型    │
 *   │  4. blackboard.js       — 黑板 + 传感器      │
 *   │  5. enemy-profiler.js   — 敌情 Profile       │
 *   ├─ 行为节点 ──────────────────────────────────┤
 *   │  6. nodes-survival.js   — 生存节点           │
 *   │  7. nodes-attack.js     — 攻击节点           │
 *   │  8. nodes-objective.js  — 目标节点           │
 *   │  9. nodes-movement.js   — 移动/兜底节点      │
 *   ├─ 编排 & 入口 ───────────────────────────────┤
 *   │ 10. tree-factory.js     — 树组装工厂         │
 *   │ 11. entry.js            — onIdle 入口        │
 *   └────────────────────────────────────────────┘
 */

const fs   = require('fs');
const path = require('path');
const dir  = __dirname;
const parentDir = path.resolve(dir, '..');

const MODULE_ORDER = [
  // 底层工具（从父目录引用）
  { file: 'myth-tank.js',       base: parentDir },
  { file: 'state-store.js',     base: parentDir },
  // 行为树框架
  { file: 'bt-core.js',         base: dir },
  { file: 'blackboard.js',      base: dir },
  { file: 'enemy-profiler.js',  base: dir },
  // 行为节点
  { file: 'nodes-survival.js',  base: dir },
  { file: 'nodes-attack.js',    base: dir },
  { file: 'nodes-objective.js', base: dir },
  { file: 'nodes-movement.js',  base: dir },
  // 编排 & 入口
  { file: 'tree-factory.js',    base: dir },
  { file: 'entry.js',           base: dir },
];

const banner = [
  '// ============================================================',
  '// bt-tank-submit.js — 行为树坦克 AI（自动生成，请勿手动编辑）',
  '// 源文件: ' + MODULE_ORDER.map(function (m) { return m.file; }).join(', '),
  '// 构建时间: ' + new Date().toISOString(),
  '// ============================================================',
  '',
].join('\n');

const body = MODULE_ORDER.map(function (mod) {
  const filePath = path.join(mod.base, mod.file);
  if (!fs.existsSync(filePath)) {
    throw new Error('缺少模块文件: ' + filePath);
  }
  const src = fs.readFileSync(filePath, 'utf8');
  return '// ===== ' + mod.file + ' =====\n' + src;
}).join('\n\n');

const output = banner + body;
const outPath = path.join(dir, 'bt-tank-submit.js');
fs.writeFileSync(outPath, output, 'utf8');
console.log('✓ 构建完成 → ' + outPath + ' (' + output.length + ' 字节)');
