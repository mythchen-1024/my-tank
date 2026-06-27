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

// 蹲草伏击记忆：敌进草丛(o)对我隐身→tank=null。按 tank.id 记最后位置/朝向，
// 在记忆窗内把它的火线当危险区避开。窄门控（只罚踩进确认蹲草敌火线，不全图躲草）。
var CAMPER_MEMORY_FRAMES = 10; // 隐身后仍信任其旧位置的帧数
var CAMPER_FIRELINE_RANGE = 8; // 蹲草敌火线威胁的最大曼哈顿距离

// 子弹威胁记忆：敌弹全通道(visibleBullets/enemy.bullet/enemies[].bullet)都经前向视野锥过滤，
// 我一转身躲避，迎面横向来弹就移出视野锥→从输入消失→威胁丢失→掉头追星送死(第三关开局秒杀)。
// 解法：见过的敌弹缓存数帧、按速度外推预测，即使移出视野锥仍当威胁，让躲避能稳定提交不来回抽搐。
var BULLET_MEMORY_FRAMES = 4;  // 子弹移出视野后仍按外推位置当威胁的帧数（6格危险区≈3帧到，留 1 帧余量）

// 无杀窗口抢星：本帧无「已对准可开火」的敌(只能转身瞄准空转，对手会躲)，且星在近处时，
// 给抢星加成压过瞄准(≈682)、仍低于狂射(850)，落实「占位优先于投机射击」攒星赢平局。
var IDLE_FARM_RANGE = 6;       // 星距我 ≤ 此曼哈顿才触发无杀抢星
var IDLE_FARM_BONUS = 150;     // 抢星加成幅度（560+150≈710 > 瞄准682 < 狂射850）

// 跨帧持久状态（新对局/新生命自动重置）。
var RAID_STATE = {
  lastFrame: -1, firedThisLife: false, myShots: [],
  patrol: null, gunLine: null, speakCount: 0, lastSpeak: "", enemyMem: {}, bulletMem: []
};

// 新对局（帧号回退）或新生命（帧号大跳变）自动重置。
function getState(game) {
  var f = game.frames || 0;
  if (f < RAID_STATE.lastFrame || f - RAID_STATE.lastFrame > 4) {
    RAID_STATE = { lastFrame: f, firedThisLife: false, myShots: [], patrol: null, gunLine: null, speakCount: 0, lastSpeak: "", enemyMem: {}, bulletMem: [] };
  }
  RAID_STATE.lastFrame = f;
  return RAID_STATE;
}
