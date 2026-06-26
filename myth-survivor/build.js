/**
 * build.js — 将 raid 坦克各模块拼接为单一可提交的 js 文件。
 *
 * 用法：
 *   node my-tank/myth-survivor/build.js
 *
 * 输出：my-tank/myth-survivor/raid-tank-submit.js（自动生成，请勿手动编辑）
 *
 * 引擎要求单文件扁平脚本（无 module 系统），所以这里只是按顺序拼接。
 * 函数声明会提升，模块顺序主要为可读性；常量(var)需在 onIdle 调用前完成初始化，
 * 故 01-constants 最先。
 *
 * 模块加载顺序：
 *   01-constants.js    常量 + 跨帧状态
 *   02-matchup.js      技能对抗矩阵 + 敌方威胁画像
 *   03-geometry.js     几何/寻路/地图工具（底层）
 *   04-bullets.js      子弹威胁/躲弹/多发账本
 *   05-targeting.js    选靶 + 落点危险惩罚
 *   06-skills.js       进攻/已激活/防御技能分派
 *   07-positioning.js  对炮脱线/守枪线/巡逻
 *   08-entry.js        onIdle 入口 + 评分决策 + 执行
 */

const fs = require('fs');
const path = require('path');
const dir = __dirname;
const srcDir = path.join(dir, 'raid-src');

const MODULE_ORDER = [
  '01-constants.js',
  '02-matchup.js',
  '03-geometry.js',
  '04-bullets.js',
  '05-targeting.js',
  '06-skills.js',
  '07-positioning.js',
  '08-entry.js',
];

const banner = [
  '// ============================================================',
  '// raid-tank-submit.js — 出击(raid)攻击优先坦克 AI（自动生成，请勿手动编辑）',
  '// 源目录: raid-src/  顺序: ' + MODULE_ORDER.join(', '),
  '// 构建时间: ' + new Date().toISOString(),
  '// ============================================================',
  '',
].join('\n');

const body = MODULE_ORDER.map(function (file) {
  const filePath = path.join(srcDir, file);
  if (!fs.existsSync(filePath)) {
    throw new Error('缺少模块文件: ' + filePath);
  }
  const src = fs.readFileSync(filePath, 'utf8');
  return '// ===== ' + file + ' =====\n' + src;
}).join('\n\n');

const output = banner + body;
const outPath = path.join(dir, 'raid-tank-submit.js');
fs.writeFileSync(outPath, output, 'utf8');
console.log('✓ 构建完成 → ' + outPath + ' (' + output.length + ' 字节)');
