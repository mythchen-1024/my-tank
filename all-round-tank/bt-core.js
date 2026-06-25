// ============================================================
// bt-core.js — 行为树核心引擎
//
// 6 种基础节点类型，覆盖坦克 AI 全部决策需求。
// 每帧调用 root.tick(bb) → 执行唯一动作。
//
// 节点 tick 返回值：
//   BT_SUCCESS (1) — 条件满足 / 动作已执行
//   BT_FAILURE (0) — 条件不满足 / 无法执行
//   BT_RUNNING (2) — 跨帧继续（保留，暂未使用）
// ============================================================

var BT_SUCCESS = 1;
var BT_FAILURE = 0;
var BT_RUNNING = 2;

/**
 * Selector（选择器）：依次尝试子节点，第一个非 FAILURE 即为结果。
 * 语义："做第一件能做的事"——互斥行为选一个。
 */
function Selector(name, children) {
  var filtered = [];
  for (var i = 0; i < children.length; i++) {
    if (children[i]) filtered.push(children[i]);
  }
  return {
    type: 'selector', name: name, children: filtered,
    tick: function (bb) {
      for (var i = 0; i < this.children.length; i++) {
        var s = this.children[i].tick(bb);
        if (s !== BT_FAILURE) {
          if (BT_DEBUG) bb._trace.push(this.children[i].name);
          return s;
        }
      }
      return BT_FAILURE;
    }
  };
}

/**
 * Sequence（序列）：依次 tick 子节点，全部 SUCCESS 才返回 SUCCESS。
 * 语义："前置条件全满足 → 执行动作"——Guard + Action 组合。
 */
function Sequence(name, children) {
  var filtered = [];
  for (var i = 0; i < children.length; i++) {
    if (children[i]) filtered.push(children[i]);
  }
  return {
    type: 'sequence', name: name, children: filtered,
    tick: function (bb) {
      for (var i = 0; i < this.children.length; i++) {
        var s = this.children[i].tick(bb);
        if (s !== BT_SUCCESS) return s;
      }
      return BT_SUCCESS;
    }
  };
}

/**
 * Guard（守卫）：纯条件判断，无副作用。
 * condFn(bb) → true = SUCCESS, false = FAILURE。
 */
function Guard(name, condFn) {
  return {
    type: 'guard', name: name,
    tick: function (bb) {
      return condFn(bb) ? BT_SUCCESS : BT_FAILURE;
    }
  };
}

/**
 * Action（动作）：叶子节点，执行一个具体坦克指令。
 * execFn(bb) 执行后返回 SUCCESS。
 */
function Action(name, execFn) {
  return {
    type: 'action', name: name,
    tick: function (bb) {
      execFn(bb);
      bb._lastAction = name;
      return BT_SUCCESS;
    }
  };
}

/**
 * When（条件装饰器）：condFn 为 true 时 tick 子节点，否则 FAILURE。
 * 用于按 Profile / 比分 / 终局 动态启用/禁用整棵子树。
 */
function When(name, condFn, child) {
  return {
    type: 'when', name: name,
    tick: function (bb) {
      return condFn(bb) ? child.tick(bb) : BT_FAILURE;
    }
  };
}

/**
 * Inverter（反转）：SUCCESS↔FAILURE，RUNNING 不变。
 */
function Inverter(name, child) {
  return {
    type: 'inverter', name: name,
    tick: function (bb) {
      var s = child.tick(bb);
      if (s === BT_SUCCESS) return BT_FAILURE;
      if (s === BT_FAILURE) return BT_SUCCESS;
      return s;
    }
  };
}
