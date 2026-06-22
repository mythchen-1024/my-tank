# 行为树坦克 AI 框架

## 设计思路

### 核心问题

旧评分机制（scoring.js）的根本问题：**20+ 种行为共享一个线性打分公式，分数叠加后不可控**。

- 调一个提案的 reward，可能让它压过生存提案 → "牵一发动全身"
- braveBonus 动态叠加后实际分数范围极大（50~133），安全逻辑被数值淹没
- hardGate 和软竞争的边界模糊，有时安全有时不安全

### 解决方案：行为树（Behavior Tree）

用游戏 AI 标准架构替代评分竞争：

```
Root (Selector - 从上往下尝试，第一个成功就执行)
├── 🔴 硬生存（子弹躲避/传送逃生，永远最高优先级）
├── 🟡 软生存（防瞄/近距规避，Profile 控制敏感度）
├── 🟢 攻击（空窗/直射/守线/草丛，激进度可调）
├── ⭐ 目标（传星/刺杀，开关可控）
└── 🔵 移动（蹲草/走位/破墙/兜底）
```

**核心优势**：
- 安全检查是 Guard 节点，条件不满足 = FAILURE，不会被"高分"碾压
- 改一个子树不影响其他子树
- 可按对手技能+打法动态组装不同的树

### 三层架构

```
┌─────────────────────────────────────────┐
│         onIdle(me, enemy, game)         │
├─────────────────────────────────────────┤
│  [1] Blackboard 感知刷新                │  ← 每帧执行
│  [2] EnemyProfiler 敌情识别             │  ← 每 16 帧重评
│  [3] TreeFactory 按 Profile 组装行为树  │  ← Profile 变化时重建
│  [4] tree.tick(bb) → 执行唯一动作       │  ← 每帧执行
└─────────────────────────────────────────┘
```

---

## 技术设计

### 行为树节点类型（bt-core.js）

| 节点 | 语义 | 坦克场景 |
|------|------|----------|
| **Selector** | 依次试，第一个成功就停 | "躲弹 OR 开火 OR 走位"互斥选一 |
| **Sequence** | 全部成功才成功 | "有子弹威胁 AND 能躲 → 躲" |
| **Guard** | 纯条件判断 | `hasBulletThreat()`, `canShoot()` |
| **Action** | 执行具体动作 | `me.fire()`, `moveToward(dodge)` |
| **When** | 条件装饰器 | 终局提权、比分动态调整 |
| **Inverter** | 反转结果 | 逻辑取反 |

### 黑板系统（blackboard.js）

- **每帧刷新**：原始数据 + 廉价派生感知（gunReady、距离、比分）
- **惰性传感器**：昂贵计算（findBulletDodge、BFS走位）首次访问时才执行，帧内缓存
- **跨帧记忆**：包装 state-store 的 MATCH_STATE，函数直接复用
- **动作包装器**：bbFire / bbMoveToward / bbTeleport 统一入口

### 敌情 Profile 系统（enemy-profiler.js）

**两层识别**：
1. **静态 Profile**（开局即知）：8 种技能 → 8 套策略参数
2. **动态适应**（前 15 帧）：识别打法风格 → 修正策略参数

```
enemy.skill.type → SKILL_PROFILES[type] → 基础参数
                                            ↓
观察 15 帧 → detectPlaystyle() → 打法修正 → 最终 Profile
                                            ↓
buildBehaviorTree(profile) → 动态组装行为树
```

**Profile 参数驱动的行为差异**：

| 参数 | 作用 | 示例 |
|------|------|------|
| `attackAggression` | 攻击子树挂载哪些节点 | overload='low' 只挂空窗反击 |
| `enableAssassination` | 刺杀节点开关 | overload/shield=false |
| `dodgeBand` | 双弹覆盖带躲避节点 | 仅 overload=true |
| `freezeZoneAvoid` | 冰冻致死区回避节点 | 仅 freeze=true |
| `shieldBait` | 骗盾安全检查 | 仅 shield=true |
| `prefireOnDisappear` | 隐身预射节点 | 仅 cloak=true |
| `bushCamp` | 蹲草等星节点 | 仅 overload=true |
| `starAggression` | 目标层优先级提权 | defensive/终局='max' |

### 动态树切换

- 每 16 帧重新评估 profile（打法可能变化）
- 终局修正：最后 20 帧落后 → `starAggression='max'`
- 极端模式：最后 10 帧 → 跳过攻击层全力冲星

---

## 文件结构

```
new-tank/
├── bt-core.js          # BT 核心节点类型（~100 行）
├── blackboard.js       # 黑板 + 惰性传感器 + 动作包装器（~200 行）
├── enemy-profiler.js   # 8 种技能 Profile + 打法识别（~190 行）
├── nodes-survival.js   # 硬/软生存行为节点（~110 行）
├── nodes-attack.js     # 攻击行为节点（~120 行）
├── nodes-objective.js  # 星星/刺杀目标节点（~100 行）
├── nodes-movement.js   # 蹲草/走位/破墙/兜底节点（~110 行）
├── tree-factory.js     # 按 Profile 动态组装树（~100 行）
├── entry.js            # onIdle 入口 + 调试追踪（~75 行）
├── build.js            # 构建脚本（~70 行）
└── bt-tank-submit.js   # [产物] 可提交的合并文件
```

**依赖关系**：
- `../myth-tank.js`（3550 行工具函数，原样复用）
- `../state-store.js`（跨帧状态管理，原样复用）

---

## 当前进度

### ✅ 已完成

| # | 内容 | 状态 |
|---|------|------|
| 1 | bt-core.js — 6 种 BT 节点 | ✅ 完成 |
| 2 | blackboard.js — 黑板 + 16 个惰性传感器 + 动作包装 | ✅ 完成 |
| 3 | enemy-profiler.js — 8 技能 Profile + 打法检测 + 终局修正 | ✅ 完成 |
| 4 | nodes-survival.js — 硬闸门 5 节点 + 软生存 4 节点 | ✅ 完成 |
| 5 | nodes-attack.js — 5 档激进度控制的攻击节点 | ✅ 完成 |
| 6 | nodes-objective.js — 隐身防陷阱 + 传星 + 守星 + 刺杀 | ✅ 完成 |
| 7 | nodes-movement.js — 蹲草/短意图/BFS走位/破墙/邻格/兜底 | ✅ 完成 |
| 8 | tree-factory.js — 动态组装 + 终局提权装饰器 | ✅ 完成 |
| 9 | entry.js — onIdle 入口 + 调试追踪 | ✅ 完成 |
| 10 | build.js — 构建脚本（含语法检查通过） | ✅ 完成 |

**构建验证**：`node build.js` ✅ 成功输出 `bt-tank-submit.js`（180KB），`node --check` 语法通过。

### 🔲 待做（下一步）

| # | 内容 | 优先级 |
|---|------|--------|
| 1 | 实际对局测试（提交 bt-tank-submit.js 到平台） | 🔴 高 |
| 2 | 根据 replay 调试：确认 Guard 条件覆盖是否充分 | 🔴 高 |
| 3 | 补充缺失的 utility 函数兼容（如 `safeStandoffDistance`、`turnDistance` 等是否在 myth-tank.js 中） | 🟡 中 |
| 4 | Profile 参数调优：按对局数据微调 standoffDistance 等阈值 | 🟡 中 |
| 5 | 增加更多行为节点（如：毒雾规避、眩晕区回避、加速追击） | 🟡 中 |
| 6 | 增加 Replay 分析工具：自动从 print 日志生成决策热力图 | 🔵 低 |
| 7 | 增加"对手模型库"：按 player_id 记录历史对局打法 | 🔵 低 |

---

## 使用方法

### 构建

```bash
node my-tank/new-tank/build.js
# → 生成 bt-tank-submit.js
```

### 提交

将 `bt-tank-submit.js` 的内容提交到比赛平台。

### 调试

在 replay 中观察 `print()` 输出格式：
```
f12 hard-survival>bullet-dodge:do-bullet-dodge
f13 attack>fire-direct:do-fire-direct
f25 objective>star-teleport:do-star-tp
```

格式：`f{帧号} {BT路径}:{动作名}`，可直接定位每帧走了哪条分支。

---

## 设计对比

| 维度 | 旧评分机制 | 新行为树 |
|------|-----------|---------|
| 行为选择 | 20+ 提案统一打分竞争 | Selector 按优先级依次尝试 |
| 可预测性 | 分数叠加后难预判 | 每个 Guard 条件明确，路径确定 |
| 修改安全 | 改一个分数影响全局 | 改一个子树不影响其他子树 |
| 动态适配 | braveBonus 硬编码加分 | When 装饰器动态启用/禁用子树 |
| 对手适应 | 无（固定逻辑） | Profile 系统按技能+打法组装不同树 |
| 调试 | 看所有提案最终分数 | 直接看走了哪条 Selector 分支 |
| 终局处理 | braveBonus 叠加到爆 | 装饰器精确提权目标层 |
