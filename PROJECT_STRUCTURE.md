# AgenTank 项目文件结构说明

> 最后更新：2026-06-03

---

## 目录结构

```
agentTank/
├── my-tank/
│   ├── state-store.js             # 跨帧状态层
│   ├── scoring.js                 # 评分引擎
│   ├── action-proposals.js        # 候选提案构建器
│   ├── myth-tank.js               # 工具函数库（核心）
│   ├── decision-engine.js         # 决策入口（新 onIdle）
│   ├── build.js                   # 构建脚本
│   ├── myth-tank-submit.js        # 构建产物（提交用，勿手动编辑）
│   ├── _scenario_test.js          # 场景单元测试
│   ├── agent-types.js             # 类型定义（IDE 提示用）
│   ├── agile-splashing-willow.md  # 重构设计文档
│   ├── myth-tank-old.js           # 重构前旧版存档（只读参考）
│   └── tank_agent.js              # 官方模板示例（只读参考）
├── publish.py                     # 发布工具
├── battle_bots.py                 # 机器人对战测试
└── README.md                      # 项目概览
```

---

## 模块依赖顺序

```
state-store.js
    ↓
scoring.js
    ↓
action-proposals.js
    ↓
myth-tank.js        ← 工具函数，被上方三个模块调用
    ↓
decision-engine.js  ← 入口 onIdle，依赖所有上层
```

`build.js` 按此顺序将五个文件拼接为单一提交文件。

---

## 核心模块（my-tank/）

### `state-store.js` — 跨帧状态层

管理 `MATCH_STATE` 的生命周期，提供帧间持久化的状态读写接口。

| 函数 | 说明 |
|------|------|
| `getMatchState(game)` | 获取/初始化本局状态，帧数回退时自动重置（新对局检测） |
| `trackStuck(state, myPos)` | 统计连续未移动帧数，识别卡墙/震荡死循环 |
| `trackEnemy(state, ...)` | 记录敌方最后可见坐标、逃跑帧计数 |
| `recordAssassinOutcome(state, ...)` | 追踪刺杀结局，敌方躲过则本局禁用刺杀 |
| `primeShortIntent(state, ...)` | 写入 2~4 步短期行动计划 |
| `resolveShortIntentStep(...)` | 每帧检查并续跑短期意图 |
| `clearShortIntent(state)` | 清除短期意图缓存 |

**MATCH_STATE 主要字段**：`assassinBanned`、`pendingAssassin`、`lastEnemyPos`、`stuckFrames`、`patrolTarget`、`shortIntent`、`enemyFleeFrames`

---

### `scoring.js` — 评分引擎

统一的提案打分公式与硬约束校验。**所有权重集中在此文件，校准时只改这里。**

| 函数 / 变量 | 说明 |
|------------|------|
| `SCORE_WEIGHTS` | 权重配置：`{ reward:1.0, risk:1.2, stability:0.3 }` |
| `buildProposal(type, exec, opts)` | 构造候选提案对象（统一数据结构） |
| `buildScoringContext(...)` | 构建含 `isLosing / isWinning / isEndgame / framesLeft` 的评分上下文 |
| `braveBonus(proposal, ctx)` | 勇敢基线：落后/终局时提升抢星动力，领先时提升生存权重 |
| `isDeadlyProposal(proposal, ctx)` | 硬约束：步入子弹弹道或封闭死胡同则丢弃（不参与打分） |
| `scoreProposal(proposal, ctx)` | 单提案打分：`reward×1.0 - risk×1.2 + stability×0.3 + braveBonus` |
| `selectBestProposal(proposals, ctx)` | 从候选列表裁决得分最高的合法提案 |

**Phase 5 校准后评分基准**：

| 动作 | 近似分 | 说明 |
|------|--------|------|
| `aim-dodge` | ~70 | 软生存最高优先 |
| `open-shot` | ~55 | 敌炮管空窗期进攻 |
| `star-teleport` | ~50 | 星星 = 唯一得分，高于直接开火 |
| `fire-direct` | ~45 | 有战略价值但不直接得分 |
| `guard-line` | ~41 | 守线预瞄 |
| `scored-move` | ~14 | 评分走位 |
| `turn-right` | ~-8 | 兜底最低分 |

**勇敢基线规则**：
- 落后时：抢星 +20，攻击 +6
- 终局（≤20帧）且落后：抢星额外 +25
- 最后 10 帧（无论输赢）：抢星 +20
- 领先时：生存 +5（守住优势）

---

### `action-proposals.js` — 候选提案构建器

将原 `onIdle` 中散落的 `if/return` 规则重组为"提案生成函数"，只负责**提名**，不做执行决定。

| 函数 | 层级 | 说明 |
|------|------|------|
| `collectHardSurvivalAction(...)` | 硬闸门 | 子弹躲避 / 传送逃生 / 两步脱困 / 绝境横移，命中即直接执行 |
| `collectSoftSurvivalProposals(...)` | 软生存 | 防瞄移动、近距对射规避（高分参与竞争） |
| `collectAttackProposals(...)` | 攻击层 | 空窗期反击、同线开火、守线预瞄、草丛伏击 |
| `collectTargetProposals(...)` | 目标层 | 传送抢星、争夺守点、刺杀计划、隐身守星防陷阱 |
| `collectMoveProposals(...)` | 移动层 | 草丛蹲守、短期意图、评分走位、破墙、安全邻格、兜底右转 |

---

### `myth-tank.js` — 工具函数库

被所有其他模块依赖的底层函数集合。**不含任何决策逻辑或状态管理。**

顶部约 120 行为完整的**游戏 API 参考文档**（`me` / `enemy` / `game` 字段说明、8 种技能详解、地图规则）。

| 功能族 | 代表函数 |
|--------|---------|
| 射击判断 | `canShoot`, `gunReady`, `clearShotDirection` |
| 子弹预测 | `findBulletDodge`, `stepIntoBulletPath`, `collectEnemyBullets` |
| 传送逃生 | `findEscapeTeleport`, `isTeleportSafe` |
| 走位评分 | `chooseStepScored`, `moveToward`, `bestSafeNeighbor` |
| 刺杀系统 | `findAssassinationPlan`, `assassinIsSafe`, `isAssassinTile` |
| 草丛 / 隐身 | `iAmHidden`, `findBushLineShot`, `inCloakStarTrap`, `cloakStarGuardStep` |
| 地图工具 | `manhattan`, `isDeadEnd`, `stepIntoSealedDeadEnd`, `isWall` |
| 敌方感知 | `enemyIsOverloadType`, `enemyAimsAt`, `safeStandoffDistance` |
| 传送决策 | `findStarTeleport`, `teleportPreTurnDir`, `findEscapeTeleport` |

---

### `decision-engine.js` — 决策入口

新版 `onIdle`，实现六层决策管线，协调所有模块。

```
onIdle(me, enemy, game)
  │
  ├─ [1] 状态采集       myPos / enemyTank / enemyBullets
  ├─ [2] 跨帧记忆更新   recordAssassinOutcome / trackEnemy / trackStuck
  ├─ [3] 硬状态拦截     frozen → 直接返回
  ├─ [4] 生存硬闸门     collectHardSurvivalAction → 有则立即执行
  ├─ [5] 采集全部提案   soft survival + attack + target + move
  └─ [6] 打分裁决执行   selectBestProposal → best.exec()
```

#### 优先级链路与梯队评分

根据 `action-proposals.js` 和 `decision-engine.js`，AI 的执行优先级及基础评分梯队如下：

1. **第一梯队：生存硬闸门 (Hard Gate)**  
   *强制执行，不评分。* 面临致命威胁时立刻响应。
   - `bullet-dodge` (含 `counter-shoot-then-dodge`)
   - `escape-teleport`
   - `two-step-escape`
   - `desperate-dodge`

2. **第二梯队：软生存层**  
   *基准分最高 (~65-70分)，为了安全具有极高权重。*
   - `aim-dodge` (~70)
   - `line-duel-dodge` (~65)

3. **第三梯队：主动攻击层**  
   *基准分中高 (~41-55分)，负责火炮交锋。*
   - `open-shot` (~55)
   - `fire-direct` (~45)
   - `bush-shot` (~42)
   - `guard-line` (~41)

4. **第四梯队：目标任务层 (星星与刺杀)**  
   *基准分适中 (~28-50分)，依赖 `braveBonus` 动态提权。*
   - `cloak-guard / hold` (~56 / 58，遇到陷阱时独占该层逻辑)
   - `star-teleport` (~50)
   - `star-guard` (~32)
   - `assassination` (~28)

5. **第五梯队：计划与移动层 (兜底走位)**  
   *基准分低 (~-8-26分)，无仗可打时的行为排期。*
   - `bush-hold` (~26)
   - `short-intent` (~20)
   - `scored-move` (~14)
   - `dig-wall` (~8)
   - `safe-neighbor` (~4)
   - `turn-right` (~-8，防挂机)

#### 软硬红线与调参安全阈值（防送死机制）

在修改 `braveBonus`（勇敢基线）等加分项时，需参考以下“红线”约束：

1. **绝对红线（无论怎么加分都绝对安全）**：
   - **不参与打分**：子弹躲避、紧急传送等属于第一梯队（Hard Gate），在打分前已直接执行。
   - **强制丢弃 (-9999分)**：`isDeadlyProposal` 会过滤掉所有落入弹道或死胡同的移动提案。
2. **软性红线（加分超过会导致坦克改变行为流派）**：
   - 🔴 **防瞄准红线 (~70分)**：`aim-dodge`。如果其他提案总分 > 70，坦克会无视敌人炮口的瞄准，顶着枪口硬冲。
   - 🟠 **近战规避红线 (~65分)**：`line-duel-dodge`。如果总分 > 65，坦克在近距离对峙时会放弃走位躲避，站桩硬拼。
   - 🟡 **进攻红线 (~55分)**：`open-shot`。如果总分 > 55，坦克会放弃趁敌方炮管冷却时反击的绝佳机会。
3. **调参安全阈值指南 (总分 = 基础分 + braveBonus)**：
   - **安全抢星**：`scored-move` 基础 ~14 分。若不想让坦克顶着枪口送死，抢星加分最多 **+50**（14 + 50 = 64 < 65）。
   - **安全对狙**：`fire-direct` 基础 ~45 分。若不想让坦克站桩致死，对射激进加分最多 **+19**（45 + 19 = 64 < 65）。
   - **绝命冲星（破红线特例）**：当前代码在最后10帧落后时叠加加分达 **+65**，使走位总分达 79 分 (> 70分)，主动突破红线，强行用命换星。

---

### `build.js` — 构建脚本

将 5 个模块文件按依赖顺序拼接为单一 JS 文件。

```bash
node my-tank/build.js
# → 输出 my-tank/myth-tank-submit.js
```

---

### `myth-tank-submit.js` — 构建产物

> ⚠️ 自动生成，**不要手动编辑**。

由 `build.js` 拼接生成，是实际提交给 AgenTank 平台的最终单文件。每次修改源码后重新运行 `build.js`。

---

### `_scenario_test.js` — 场景单元测试

```bash
node my-tank/_scenario_test.js
# 当前状态：235 passed / 11 failed（11 个为 chooseStepScored 预存 bug）
```

按模块加载顺序依次 `eval` 所有文件，可直接测试工具函数和完整 `onIdle` 管线。

---

### `agent-types.js` — 类型定义

**仅供 IDE 智能提示（VSCode / WebStorm），不参与构建和运行。**  
定义了 `Position`、`MeTank`、`GameState` 等 JSDoc `@typedef`，编写代码时有自动补全。

---

## 工具脚本（根目录）

### `publish.py` — 发布工具

```bash
python publish.py                   # 自动构建 → 压缩 → 发布到 main 分支
python publish.py --no-build        # 跳过构建，直接发布现有 submit.js
python publish.py --notes "v2.1"    # 附带版本说明
python publish.py --branch raid     # 发布到 raid 分支
python publish.py --no-minify       # 关闭代码压缩，原样发布
python publish.py --dry-run         # 预览请求体，不实际发布
python publish.py --status          # 查看坦克排名 / 状态
python publish.py --matches         # 查看最近战斗记录（默认 5 条）
python publish.py --matches --limit 10  # 查看最近 10 条
```

**默认发布文件**：`my-tank/myth-tank-submit.js`（构建产物）。发布成功后自动保存带版本号和时间戳的 `.bak.js` 备份。

---

### `battle_bots.py` — 机器人对战测试

```bash
python battle_bots.py
```

自动构建最新代码，依次向 6 个官方机器人发起模拟对战，终端打印每场胜负及汇总，replay JSON 保存至 `replays/` 目录（文件名带时间戳，不覆盖历史记录）。

| 机器人 | 类型 |
|--------|------|
| `nova-scout` | 入门 |
| `azure-hunter` | 初级 |
| `crimson-bastion` | 防守型 |
| `emerald-striker` | 进攻型 |
| `obsidian-phantom` | 隐身流 |
| `golden-overlord` | 过载流 |

---

## 参考文档

| 文件 | 说明 |
|------|------|
| `agile-splashing-willow.md` | 评分制重构设计方案（Phase 1~5 规划） |
| `README.md` | 项目演进历史与战术思路概览 |
| `AGENTANK_DEVELOPMENT_GUIDE.md` | 平台 API 与开发规范 |
| `myth-tank-old.js` | 重构前完整旧代码（只读存档） |
| `tank_agent.js` | 官方初始模板（只读参考） |
