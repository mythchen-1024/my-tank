// ============================================================
// 坦克 AI 决策系统 — 逐行注释版
// 游戏规则：坦克每帧可执行 go(前进)/fire(开火)/turn(转向)/freeze(冻结技能)
// 地图坐标：[x, y]，x 向右增大，y 向下增大
// ============================================================

/**
 * 【主入口函数】每帧引擎调用此函数，决定坦克当前动作
 * @param {object} me    - 我方信息（含 tank 位置/方向、skill 技能冷却等）
 * @param {object} enemy - 敌方信息（含 tank 位置/方向）
 * @param {object} game  - 全局信息（frames 帧数、star 星星坐标、map 地图）
 */
function onIdle(me, enemy, game) {
  // 调用评分决策函数，获取最优候选动作
  var decision = chooseScoredDecision(me, enemy, game);
  // 如果决策类型是 "freeze"，执行冻结技能
  if (decision.type === "freeze") me.freeze();
  // 否则如果类型是 "fire"，朝当前方向开火
  else if (decision.type === "fire") me.fire();
  // 否则如果类型是 "go"，向前移动一格
  else if (decision.type === "go") me.go();
  // 否则就是转向动作，按决策指定的方向（left/right）转向
  else me.turn(decision.side);
}

/**
 * 【核心评分函数】生成所有候选动作，打分并选出最优
 * 策略优先级：冻结 > 射击敌人 > 去吃星星 > 追击敌人 > 挖土堆 > 巡逻
 * @returns {object} 得分最高的候选动作 { type, side?, score }
 */
function chooseScoredDecision(me, enemy, game) {
  // 获取我方坦克当前坐标 [x, y]
  var pos = me.tank.position;
  // 获取我方坦克当前朝向（"up"/"right"/"down"/"left"）
  var dir = me.tank.direction;
  // 获取敌方坦克对象（可能为 null，表示敌人已死）
  var foe = enemy.tank;
  // 候选动作列表，每个元素 { type, side?, score }
  var candidates = [];

  // --- 候选1：冻结技能（最高优先级）---
  // 如果敌人存活 且 满足冻结条件（冷却完毕、在射程内、敌人正对着我）
  if (foe && canFreeze(me, enemy, game)) {
    // 将冻结动作加入候选，基础分 1000
    candidates.push({ type: "freeze", score: 1000 });
  }

  // 判断是否进入后期（80帧之后），后期策略会更激进
  var late = game.frames > 80;

  // --- 候选2：直接射击敌人 ---
  // 如果敌人存活 且 我方与敌人之间有畅通的弹道（无遮挡）
  if (foe && canShoot(pos, foe.position, game.map)) {
    // 构建射击动作：先判断是否需要转向对准敌人，再附上综合评分
    // 评分 = 850基础 + 近距离奖励 + 星星弹道奖励 + 后期额外80分
    candidates.push(withScore(
      actionForDirection(pos, dir, directionTo(pos, foe.position), "fire"),
      850 + closeBonus(pos, foe.position) + starLineScore(pos, game.star, game.map, late) + (late ? 80 : 0)
    ));
  }

  // --- 候选3：朝星星移动 ---
  // 如果星星存在，用 BFS 寻路找到去星星的下一步坐标
  var starStep = game.star && nextStep(pos, game.star, game.map);
  // 如果能找到通往星星的路径
  if (starStep) {
    // 构建移动动作，评分 = 700基础 + 星星紧迫度 + 弹道奖励
    candidates.push(withScore(
      actionForDirection(pos, dir, directionTo(pos, starStep), "go"),
      700 + starUrgency(pos, starStep, game.star) + starLineScore(starStep, game.star, game.map, late)
    ));
  }

  // --- 候选4：追击敌人 ---
  // 条件：(没找到星星路径 或 已到后期) 且 敌人存活
  // 满足条件则 BFS 寻路到敌人，否则为 null
  var enemyStep = ((!starStep || late) && foe) ? nextStep(pos, foe.position, game.map) : null;
  // 如果能找到通往敌人的路径
  if (enemyStep) {
    // 构建移动动作，评分 = 500基础 + 弹道奖励 + 后期额外220分
    candidates.push(withScore(
      actionForDirection(pos, dir, directionTo(pos, enemyStep), "go"),
      500 + starLineScore(enemyStep, game.star, game.map, late) + (late ? 220 : 0)
    ));
  }

  // --- 候选5：挖土堆（开火摧毁障碍物）---
  // 查找周围是否有土堆需要清除
  var dig = digDirection(pos, dir, game.map);
  // 如果找到可挖的方向
  if (dig) {
    // 构建开火动作，评分 = 360基础 + (无星星路径时+120) + (后期+130)
    candidates.push(withScore(
      actionForDirection(pos, dir, dig, "fire"),
      360 + (starStep ? 0 : 120) + (late ? 130 : 0)
    ));
  }

  // --- 候选6：巡逻（默认兜底行为）---
  // 前方通畅就前进，否则右转
  candidates.push(withScore(
    patrolAction(pos, dir, game.map),
    100 + starLineScore(add(pos, delta(dir)), game.star, game.map, late)
  ));

  // --- 危险惩罚：每个候选动作减去危险分 ---
  // 遍历所有候选，扣除执行该动作后所处位置的危险值
  for (var j = 0; j < candidates.length; j++) {
    // 分数减去该动作的危险评估值（越危险扣越多）
    candidates[j].score -= actionDanger(candidates[j], me, enemy, game);
  }

  // --- 选出最高分候选 ---
  // 先假设第一个候选是最优
  var best = candidates[0];
  // 从第二个开始遍历比较
  for (var i = 1; i < candidates.length; i++) {
    // 如果当前候选分数更高，替换最优
    if (candidates[i].score > best.score) best = candidates[i];
  }
  // 返回最优候选动作
  return best;
}

/**
 * 【工具函数】给动作对象附加分数属性
 * @param   {object} action - 动作对象 { type, side? }
 * @param   {number} score  - 要附加的分数
 * @returns {object} 附加了 score 属性的动作对象
 */
function withScore(action, score) {
  // 直接在动作对象上添加 score 属性（JS 对象是引用类型，会修改原对象）
  action.score = score;
  // 返回该对象，方便链式调用
  return action;
}

/**
 * 【方向判断】根据当前朝向和目标朝向，决定是直接行动还是先转向
 * @param   {array}  pos          - 当前位置 [x, y]
 * @param   {string} currentDir   - 当前朝向
 * @param   {string} targetDir    - 目标朝向
 * @param   {string} alignedAction - 方向一致时要执行的动作类型
 * @returns {object} 动作对象
 */
function actionForDirection(pos, currentDir, targetDir, alignedAction) {
  // 如果当前朝向已经对准目标方向，直接返回目标动作
  if (currentDir === targetDir) return { type: alignedAction };
  // 否则需要转向，计算最短转向方向（left/right）
  return { type: "turn", side: turnDirection(currentDir, targetDir) };
}

/**
 * 【巡逻逻辑】前方通畅就前进，否则右转绕行
 * @param   {array}  position   - 当前位置
 * @param   {string} currentDir - 当前朝向
 * @param   {array}  map        - 地图二维数组
 * @returns {object} 巡逻动作
 */
function patrolAction(position, currentDir, map) {
  // 计算前方一格坐标 = 当前位置 + 方向偏移量
  var forward = add(position, delta(currentDir));
  // 如果前方是空地（不是墙"x"也不是土堆"m"），前进
  if (isOpen(forward, map)) return { type: "go" };
  // 否则右转（简单绕墙策略）
  return { type: "turn", side: "right" };
}

/**
 * 【冻结条件判断】检查是否可以使用冻结技能
 * 条件：敌人存活、我有冻结技能、技能冷却完毕、弹道通畅、敌人正对着我、距离≤4
 * @returns {boolean} 是否可以冻结
 */
function canFreeze(me, enemy, game) {
  // 获取敌方坦克
  var foe = enemy.tank;
  // 获取我方位置
  var pos = me.tank.position;
  // !! 是双重取反技巧，将任意值强制转为布尔值 true/false
  // 所有条件必须同时满足：
  // 1. foe 存在（敌人存活）
  // 2. me.freeze 存在（我有冻结技能）
  // 3. me.skill 存在（技能对象有效）
  // 4. remainingCooldownFrames === 0（冷却完毕）
  // 5. 敌人能射到我（弹道通畅）
  // 6. 敌人正面对着我（pointsAt 判断方向）
  // 7. 曼哈顿距离 ≤ 4（在冻结射程内）
  return !!(foe && me.freeze && me.skill && me.skill.remainingCooldownFrames === 0 && canShoot(foe.position, pos, game.map) && pointsAt(foe.direction, foe.position, pos) && manhattan(pos, foe.position) <= 4);
}

/**
 * 【近距离奖励】距离越近奖励越高
 * @param   {array} a - 坐标A
 * @param   {array} b - 坐标B
 * @returns {number} 奖励分数 (0~80)
 */
function closeBonus(a, b) {
  // Math.max(0, x) 确保结果不为负数
  // 距离越近，(8 - 距离) 越大，奖励越高
  return Math.max(0, 8 - manhattan(a, b)) * 10;
}

/**
 * 【星星紧迫度】离星星越近或下一步就到星星，分数越高
 * @param   {array} pos  - 当前位置
 * @param   {array} step - 下一步坐标
 * @param   {array} star - 星星坐标
 * @returns {number} 紧迫度分数
 */
function starUrgency(pos, step, star) {
  // 如果下一步就能吃到星星，给高分 180
  if (samePos(step, star)) return 180;
  // 否则根据当前位置到星星的距离给分（越近越高）
  return Math.max(0, 8 - manhattan(pos, star)) * 10;
}

/**
 * 【星星弹道奖励】如果当前位置与星星在同一行/列且弹道通畅，给予奖励
 * 这鼓励坦克移动到能射击星星的位置
 * @param   {array}   pos   - 评估位置
 * @param   {array}   star  - 星星坐标
 * @param   {array}   map   - 地图
 * @param   {boolean} late  - 是否后期
 * @returns {number} 奖励分数
 */
function starLineScore(pos, star, map, late) {
  // 如果没有星星，返回 0
  if (!star) return 0;
  // 如果已经在星星位置，给 160 分
  if (samePos(pos, star)) return 160;
  // 如果与星星在同一行（x相同）或同一列（y相同）且弹道通畅
  if ((pos[0] === star[0] || pos[1] === star[1]) && canShoot(pos, star, map))
    // 后期给 30 分（更倾向战斗），前期给 85 分
    return late ? 30 : 85;
  // 不满足条件，0 分
  return 0;
}

/**
 * 【动作危险性评估】计算执行某动作后所处位置的危险值
 * 开火/冻结不改变位置，危险为 0
 * @param   {object} action - 候选动作
 * @param   {object} me     - 我方信息
 * @param   {object} enemy  - 敌方信息
 * @param   {object} game   - 全局信息
 * @returns {number} 危险值（越大越危险，会从总分中扣除）
 */
function actionDanger(action, me, enemy, game) {
  // 获取当前位置
  var pos = me.tank.position;
  // 获取当前朝向
  var dir = me.tank.direction;
  // 默认下一步位置 = 当前位置（不动）
  var nextPos = pos;
  // 默认下一步朝向 = 当前朝向
  var nextDir = dir;
  // 如果是前进动作，计算前进后的新位置
  if (action.type === "go") nextPos = add(pos, delta(dir));
  // 如果是转向动作，计算转向后的新朝向
  if (action.type === "turn") nextDir = turnAfter(dir, action.side);
  // 开火或冻结不改变位置，危险为 0
  if (action.type === "fire" || action.type === "freeze") return 0;
  // 评估新位置/新朝向的危险值
  return dangerAt(nextPos, nextDir, enemy, game.map);
}

/**
 * 【位置危险性评估】判断某个位置对敌人的暴露程度
 * @param   {array}  pos   - 评估位置
 * @param   {string} dir   - 评估朝向（暂未使用，预留）
 * @param   {object} enemy - 敌方信息
 * @param   {array}  map   - 地图
 * @returns {number} 危险值
 */
function dangerAt(pos, dir, enemy, map) {
  // 获取敌方坦克
  var foe = enemy.tank;
  // 如果敌人已死，无危险
  if (!foe) return 0;
  // 计算与敌人的曼哈顿距离
  var d = manhattan(pos, foe.position);
  // 紧贴敌人（距离≤1），极度危险 1500 分
  if (d <= 1) return 1500;
  // 距离≤4 且 敌人能射到我 且 敌人正对着我 → 高危 1200
  if (d <= 4 && canShoot(foe.position, pos, map) && pointsAt(foe.direction, foe.position, pos)) return 1200;
  // 距离≤6 且 同样条件 → 中等危险 180
  if (d <= 6 && canShoot(foe.position, pos, map) && pointsAt(foe.direction, foe.position, pos)) return 180;
  // 安全
  return 0;
}

/**
 * 【BFS 寻路】广度优先搜索，找到从 start 到 goal 的"第一步"坐标
 * 这是经典的最短路径算法，保证找到的路径步数最少
 * @param   {array} start - 起点坐标
 * @param   {array} goal  - 终点坐标
 * @param   {array} map   - 地图
 * @returns {array|null} 到达终点的第一步坐标，无法到达返回 null
 */
function nextStep(start, goal, map) {
  // BFS 队列，每个元素 { pos: 当前坐标, first: 从起点出发的第一步坐标 }
  // 初始只有起点，first 为 null（起点不需要"第一步"）
  var queue = [{ pos: start, first: null }];
  // 已访问集合，用对象模拟 Set（键为坐标字符串）
  var seen = {};
  // 标记起点已访问
  seen[key(start)] = true;

  // BFS 主循环：用数组+头指针模拟队列出队（比 shift() 更高效）
  for (var head = 0; head < queue.length; head++) {
    // 取出队首元素
    var item = queue[head];
    // 如果当前坐标就是目标，返回从起点到目标的"第一步"
    if (samePos(item.pos, goal)) return item.first;

    // 四个方向：上、右、下、左
    var dirs = ["up", "right", "down", "left"];
    // 遍历四个方向
    for (var i = 0; i < dirs.length; i++) {
      // 计算相邻格坐标 = 当前位置 + 方向偏移
      var next = add(item.pos, delta(dirs[i]));
      // 生成坐标的唯一键（如 "3,5"）
      var k = key(next);
      // 如果已访问过 或 该格不可通行，跳过
      if (seen[k] || !isOpen(next, map)) continue;
      // 标记为已访问
      seen[k] = true;
      // 入队：first 继承父节点的 first，如果父节点是起点则 first = next
      queue.push({ pos: next, first: item.first || next });
    }
  }
  // 队列遍历完仍未找到目标，返回 null（无法到达）
  return null;
}

/**
 * 【挖土堆方向】查找周围可挖的土堆方向
 * 优先挖正前方的，其次检查四个方向
 * @param   {array}  pos        - 当前位置
 * @param   {string} currentDir - 当前朝向
 * @param   {array}  map        - 地图
 * @returns {string|null} 可挖土堆的方向，没有返回 null
 */
function digDirection(pos, currentDir, map) {
  // 计算正前方一格坐标
  var forward = add(pos, delta(currentDir));
  // 如果正前方就是土堆，直接返回当前朝向（优先挖前方）
  if (isMound(forward, map)) return currentDir;
  // 四个方向列表
  var dirs = ["up", "right", "down", "left"];
  // 遍历四个方向
  for (var i = 0; i < dirs.length; i++) {
    // 如果该方向相邻格是土堆，返回该方向
    if (isMound(add(pos, delta(dirs[i])), map)) return dirs[i];
  }
  // 周围没有土堆
  return null;
}

/**
 * 【弹道检测】判断从 a 到 b 是否有畅通的直线弹道（无墙无土堆遮挡）
 * 前提：a 和 b 必须在同一行或同一列
 * @param   {array}   a   - 起点坐标
 * @param   {array}   b   - 终点坐标
 * @param   {array}   map - 地图
 * @returns {boolean} 弹道是否畅通
 */
function canShoot(a, b, map) {
  // 参数校验：任一为空 或 同位置，无法射击
  if (!a || !b || samePos(a, b)) return false;
  // 不在同一行也不在同一列，子弹无法斜向飞行
  if (a[0] !== b[0] && a[1] !== b[1]) return false;
  // 获取从 a 指向 b 的方向
  var dir = directionTo(a, b);
  // 获取该方向的一步偏移量 [dx, dy]
  var step = delta(dir);
  // 从 a 的下一格开始检查
  var pos = add(a, step);
  // 逐格检查直到到达 b
  while (!samePos(pos, b)) {
    // 如果中间有任何一格不可通行（墙或土堆），弹道被阻断
    if (!isOpen(pos, map)) return false;
    // 移动到下一格
    pos = add(pos, step);
  }
  // 所有中间格都通畅
  return true;
}

/**
 * 【朝向判断】检查某个方向是否"指向"目标
 * 例如：dir="up" 表示从 from 向上看，target 必须在 from 正上方
 * @param   {string} dir    - 朝向
 * @param   {array}  from   - 观察者坐标
 * @param   {array}  target - 目标坐标
 * @returns {boolean} 是否正对着目标
 */
function pointsAt(dir, from, target) {
  // 朝上：x坐标相同 且 目标的y小于观察者（在上方）
  if (dir === "up") return from[0] === target[0] && target[1] < from[1];
  // 朝右：y坐标相同 且 目标的x大于观察者（在右侧）
  if (dir === "right") return from[1] === target[1] && target[0] > from[0];
  // 朝下：x坐标相同 且 目标的y大于观察者（在下方）
  if (dir === "down") return from[0] === target[0] && target[1] > from[1];
  // 朝左：y坐标相同 且 目标的x小于观察者（在左侧）
  if (dir === "left") return from[1] === target[1] && target[0] < from[0];
  // 未知方向
  return false;
}

/**
 * 【方向计算】返回从 a 指向 b 的方向字符串
 * 优先判断水平方向，再判断垂直方向
 * @param   {array}  a - 起点
 * @param   {array}  b - 终点
 * @returns {string} 方向（"up"/"right"/"down"/"left"）
 */
function directionTo(a, b) {
  // b 在 a 右边
  if (b[0] > a[0]) return "right";
  // b 在 a 左边
  if (b[0] < a[0]) return "left";
  // b 在 a 下边
  if (b[1] > a[1]) return "down";
  // 默认：b 在 a 上边（或同一位置）
  return "up";
}

/**
 * 【最短转向】计算从当前方向转到目标方向的最短转向（left/right）
 * 使用环形数组技巧：["up","right","down","left"] 索引 0~3
 * @param   {string} currentDir - 当前朝向
 * @param   {string} targetDir  - 目标朝向
 * @returns {string} 转向方向（"left"/"right"）
 */
function turnDirection(currentDir, targetDir) {
  // 方向环形数组（顺时针：上→右→下→左）
  var dirs = ["up", "right", "down", "left"];
  // 获取当前方向在数组中的索引
  var current = dirs.indexOf(currentDir);
  // 获取目标方向在数组中的索引
  var target = dirs.indexOf(targetDir);
  // 防御：如果找不到方向，默认右转
  if (current < 0 || target < 0) return "right";
  // 计算环形差值：(target - current + 4) % 4
  // +4 确保为正，%4 取模得到 0~3
  // diff=1 顺时针1步→右转, diff=2 对面→右转, diff=3 逆时针1步→左转
  var diff = (target - current + 4) % 4;
  // diff=3 表示逆时针1步就到，左转更短；其他情况右转
  return diff === 3 ? "left" : "right";
}

/**
 * 【转向后方向】计算按指定方向转向后的新朝向
 * @param   {string} currentDir - 当前朝向
 * @param   {string} side       - 转向方向（"left"/"right"）
 * @returns {string} 转向后的新朝向
 */
function turnAfter(currentDir, side) {
  // 方向环形数组
  var dirs = ["up", "right", "down", "left"];
  // 获取当前方向索引
  var current = dirs.indexOf(currentDir);
  // 防御：找不到则默认返回 "up"
  if (current < 0) return "up";
  // 左转 = 逆时针1步 = +3（等价于 -1），右转 = 顺时针1步 = +1
  // (side === "left" ? 3 : 1) 即左转加3右转加1，%4 保证环形
  return dirs[(current + (side === "left" ? 3 : 1)) % 4];
}

/**
 * 【方向→坐标偏移】将方向字符串转为坐标偏移量 [dx, dy]
 * 坐标系：x 向右增大，y 向下增大
 * @param   {string} dir - 方向
 * @returns {array} 偏移量 [dx, dy]
 */
function delta(dir) {
  // 上：x不变，y-1（屏幕上方）
  if (dir === "up") return [0, -1];
  // 右：x+1，y不变
  if (dir === "right") return [1, 0];
  // 下：x不变，y+1
  if (dir === "down") return [0, 1];
  // 左（默认）：x-1，y不变
  return [-1, 0];
}

/**
 * 【向量加法】两个坐标数组对应分量相加
 * @param   {array} pos - 坐标 [x, y]
 * @param   {array} d   - 偏移 [dx, dy]
 * @returns {array} 新坐标 [x+dx, y+dy]
 */
function add(pos, d) {
  // 返回新数组：[x+dx, y+dy]
  return [pos[0] + d[0], pos[1] + d[1]];
}

/**
 * 【空地判断】检查某坐标是否为可通行空地（非墙"x"、非土堆"m"）
 * @param   {array} pos - 坐标
 * @param   {array} map - 地图二维数组
 * @returns {boolean} 是否可通行
 */
function isOpen(pos, map) {
  // 三步安全检查（利用 && 短路特性）：
  // 1. map[pos[0]] 存在（x坐标不越界）
  // 2. map[pos[0]][pos[1]] 存在（y坐标不越界）
  // 3. 该格不是墙 "x" 也不是土堆 "m"
  return map[pos[0]] && map[pos[0]][pos[1]] && map[pos[0]][pos[1]] !== "x" && map[pos[0]][pos[1]] !== "m";
}

/**
 * 【土堆判断】检查某坐标是否为土堆（可被子弹摧毁的障碍物）
 * @param   {array} pos - 坐标
 * @param   {array} map - 地图
 * @returns {boolean} 是否为土堆
 */
function isMound(pos, map) {
  // 先检查坐标不越界，再判断该格字符是否为 "m"（mound）
  return map[pos[0]] && map[pos[0]][pos[1]] === "m";
}

/**
 * 【坐标相等判断】检查两个坐标是否相同
 * @param   {array} a - 坐标A
 * @param   {array} b - 坐标B
 * @returns {boolean} 是否相同
 */
function samePos(a, b) {
  // 先确保两者都存在（非 null/undefined），再比较 x 和 y
  return a && b && a[0] === b[0] && a[1] === b[1];
}

/**
 * 【曼哈顿距离】计算两点间的网格距离（只能横竖走，不能斜走）
 * 公式：|x1-x2| + |y1-y2|
 * @param   {array}  a - 坐标A
 * @param   {array}  b - 坐标B
 * @returns {number} 曼哈顿距离
 */
function manhattan(a, b) {
  // Math.abs() 取绝对值，确保距离为正
  return Math.abs(a[0] - b[0]) + Math.abs(a[1] - b[1]);
}

/**
 * 【坐标序列化】将坐标转为唯一字符串键，用于 Set/Map
 * @param   {array}  pos - 坐标 [x, y]
 * @returns {string} 键字符串，如 "3,5"
 */
function key(pos) {
  // 用逗号连接 x 和 y，生成唯一标识
  return pos[0] + "," + pos[1];
}