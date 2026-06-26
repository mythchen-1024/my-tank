// ============================================================
// 01-constants.js — 常量 + 跨帧状态
// ============================================================

var BULLET_SPEED = 2;          // 子弹每帧移动格数
var DODGE_LOOKAHEAD = 3;       // 躲弹预判帧数
var DANGER_RADIUS = 4;         // 威胁子弹危险半径（曼哈顿）
var DIRS = ["up", "right", "down", "left"];

// 多发子弹账本：相信在场的己方弹数 < 此值才允许开火。
// 默认 1 = 单弹在场就不重复开火。线上拿到多发等级后调高（overload 一发记 2 弹）。
var MULTI_BULLET_CAP = 1;
var BULLET_LIFETIME = 14;      // 一发弹在场的最长追踪帧数（地图最长边/2 + 余量）

// 跨帧持久状态（新对局/新生命自动重置）。
var RAID_STATE = {
  lastFrame: -1, firedThisLife: false, myShots: [],
  patrol: null, gunLine: null, speakCount: 0, lastSpeak: ""
};

// 新对局（帧号回退）或新生命（帧号大跳变）自动重置。
function getState(game) {
  var f = game.frames || 0;
  if (f < RAID_STATE.lastFrame || f - RAID_STATE.lastFrame > 4) {
    RAID_STATE = { lastFrame: f, firedThisLife: false, myShots: [], patrol: null, gunLine: null, speakCount: 0, lastSpeak: "" };
  }
  RAID_STATE.lastFrame = f;
  return RAID_STATE;
}
