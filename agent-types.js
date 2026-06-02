/**
 * ==========================================
 * AgenTank 基础类型定义 (仅供 IDE 提示使用)
 * ==========================================
 */

/**
 * 坐标点定义，格式严格为 [x, y] 的数组，绝不是 {x, y} 对象
 * @typedef {[number, number]} Position
 */

/**
 * 坦克或子弹的朝向
 * @typedef {"up" | "down" | "left" | "right"} Direction
 */

/**
 * 技能类型枚举
 * @typedef {"shield" | "freeze" | "stun" | "overload" | "cloak" | "poison" | "teleport" | "boost"} SkillType
 */


/**
 * ==========================================
 * 核心实体类定义
 * ==========================================
 */

class Bullet {
  /**
   * 子弹当前坐标
   * @type {Position}
   */
  position;

  /**
   * 子弹飞行方向
   * @type {Direction}
   */
  direction;
}

class TankState {
  /**
   * 坦克唯一 ID
   * @type {number}
   */
  id;

  /**
   * 坦克当前坐标 [x, y]
   * @type {Position}
   */
  position;

  /**
   * 坦克车头当前朝向
   * @type {Direction}
   */
  direction;

  /**
   * 是否处于撞击状态（例如撞墙）
   * @type {boolean}
   */
  crashed;
}

class SkillInfo {
  /**
   * 拥有的技能类型
   * @type {SkillType}
   */
  type;

  /**
   * 技能基础冷却帧数
   * @type {number}
   */
  cooldownFrames;

  /**
   * 距离下次可用的剩余冷却帧数（0 表示当前可用）
   * @type {number}
   */
  remainingCooldownFrames;

  /**
   * 技能正在生效中的剩余帧数
   * @type {number}
   */
  activeRemainingFrames;

  /**
   * 正在生效中的技能类型
   * @type {SkillType | null}
   */
  activeType;
}

class EffectsInfo {
  /**
   * 自身增益效果对象，如 { type: "shield", remainingFrames: 2 } 或 null
   * @type {{ type: string, remainingFrames: number } | null}
   */
  self;

  /**
   * 负面状态效果对象，如 { type: "stun", remainingFrames: 1 } 或 null
   * @type {{ type: string, remainingFrames: number } | null}
   */
  debuff;
}

class StatusInfo {
  /** 是否处于护盾保护中 @type {boolean} */
  shielded;
  /** 是否处于隐身状态（敌方不可见） @type {boolean} */
  cloaked;
  /** 是否处于加速状态 @type {boolean} */
  boosted;
  /** 是否处于过载状态（下次射击发射双弹） @type {boolean} */
  overloaded;
  /** 是否被冰冻（无法移动和转向） @type {boolean} */
  frozen;
  /** 是否被眩晕（控制随机化） @type {boolean} */
  stunned;
  /** 是否中毒（动作频率减慢） @type {boolean} */
  poisoned;
  /** 传送后是否被开火锁定（无法射击） @type {boolean} */
  fireLocked;
  /** 当前动作速度（默认每帧 1 个指令） @type {number} */
  actionSpeed;
  /** 本帧是否可以执行行动 @type {boolean} */
  canActThisFrame;
}


/**
 * ==========================================
 * onIdle 的三个主参数对象：Me, Enemy, Game
 * ==========================================
 */

/**
 * 代表你自己的状态与动作执行接口
 */
class Me {
  /**
   * 你自己的坦克基础状态
   * @type {TankState}
   */
  tank;

  /**
   * 你发射且正存活在场上的子弹（场上无你的子弹时为 null）
   * @type {Bullet | null}
   */
  bullet;

  /**
   * 当前收集到的星星数量
   * @type {number}
   */
  stars;

  /**
   * 你的技能冷却与配置信息
   * @type {SkillInfo}
   */
  skill;

  /**
   * 正在影响你的 Buff/Debuff 对象信息
   * @type {EffectsInfo}
   */
  effects;

  /**
   * 你的各种状态标志位集合
   * @type {StatusInfo}
   */
  status;

  // —————————— 动作指令接口 ——————————

  /** 队列指令：前进一步。传参 2 代表队列压入两次前进。 */
  go(times = 1) {}
  /** 队列指令：转向。可选 "left" 或 "right"。 */
  turn(dir) {}
  /** 队列指令：开火。 */
  fire() {}
  /** 视觉效果：头顶气泡发言（不超过40字符，不耗费动作）。 */
  speak(text) {}

  // —————————— 技能调用接口（调用前需检查 skill.type 和冷却） ——————————

  shield() {}
  freeze() {}
  stun() {}
  overload() {}
  cloak() {}
  poison() {}
  boost() {}
  /**
   * 传送技能
   * @param {number} x 目标 X 坐标
   * @param {number} y 目标 Y 坐标
   */
  teleport(x, y) {}
}


/**
 * 代表敌方的状态信息（用于公开博弈）
 */
class Enemy {
  /**
   * 敌方坦克基础状态。
   * 注意：当敌人使用 cloak 隐身，或站在草丛 "o" 中时，此字段为 null！
   * @type {TankState | null}
   */
  tank;

  /**
   * 敌方发射的子弹。
   * 注意：只有在你的视野范围内且无土块/墙壁遮挡时才可见，否则为 null。
   * @type {Bullet | null}
   */
  bullet;
  
  /**
   * 过载时发射的双弹数组（部分情况下使用）
   * @type {Bullet[] | null}
   */
  bullets;

  /**
   * 敌方的技能冷却与配置信息（完全公开，借此预判敌方大招）
   * @type {SkillInfo}
   */
  skill;

  /**
   * 正在影响敌方的 Buff/Debuff（判断敌方是否吃控）
   * @type {EffectsInfo}
   */
  effects;

  /**
   * 敌方的状态标志位集合（判断敌方是否开盾、过载等）
   * @type {StatusInfo}
   */
  status;
}


/**
 * 代表全局游戏与地图状态
 */
class Game {
  /**
   * 二维地图数组，通过 game.map[x][y] 访问。
   * - "x" = 墙壁 (不可击破)
   * - "m" = 土块 (阻挡视野与移动，可被子弹击破)
   * - "o" = 草丛 (隐蔽身形)
   * - "." = 空地
   * @type {string[][]}
   */
  map;

  /**
   * 当前场上星星的坐标 [x, y]。若场上暂无星星则为 null。
   * @type {Position | null}
   */
  star;

  /**
   * 比赛当前进行到的帧数
   * @type {number}
   */
  frames;
}

// 导出为模块，供 JSDoc 引用以实现 IDE 智能提示和跳转
module.exports = {
  Bullet,
  TankState,
  SkillInfo,
  EffectsInfo,
  StatusInfo,
  Me,
  Enemy,
  Game
};
