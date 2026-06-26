# myth-survivor — 出击(raid)攻击优先坦克

AgenTank **出击(raid)/多人**模式坦克。入口 `onIdle(me, enemy, game)`，向后兼容 1v1。
发布到 `raid`(出击)分支，坦克 id 3083。

> 设计基线与 1v1 排名坦克的「躲弹优先」**相反**：raid 敌人**不躲子弹**，所以
> 「同轴远距狂射 + 守枪线 + 每条命首帧白嫖 fire + 技能必中击杀」收益最高。
> 目标：冲 100 层。撤离(赚启动资金那步)是网站关卡间**人工操作**，脚本不管。

---

## 目录结构

```
myth-survivor/
├── raid-src/                 ← 源码(手动编辑这里)
│   ├── 01-constants.js       常量 + 跨帧状态 (RAID_STATE / getState)
│   ├── 02-matchup.js         技能对抗矩阵 MATCHUP + 敌方威胁画像 ENEMY_THREAT_PROFILE
│   ├── 03-geometry.js        几何/寻路/地图工具 (BFS/canShoot/delta…)
│   ├── 04-bullets.js         子弹威胁收集/躲弹/多发子弹账本
│   ├── 05-targeting.js       多坦克选靶 + 落点危险惩罚(接入分型)
│   ├── 06-skills.js          进攻/已激活/防御 技能分派(技能无关)
│   ├── 07-positioning.js     对炮脱线/守枪线/虚拟巡逻
│   └── 08-entry.js           onIdle 入口 + 评分决策 + 动作执行
├── build.js                  拼接 raid-src/ → raid-tank-submit.js
├── raid-tank-submit.js       构建产物(自动生成，勿手编)
├── publish.py                出击专用发布器(build + 发 raid)
├── survivor-tank.js          旧版「躲弹优先」坦克，保留作 1v1 兜底基线
└── README.md                 本文件
```

**为什么分包 + build**：引擎要求单文件扁平脚本(无 module 系统)，所以 `build.js`
只是按 01→08 顺序拼接各源文件。手改请改 `raid-src/`，**别改 `raid-tank-submit.js`**(会被覆盖)。

---

## 决策链(攻击优先，评分式)

每帧 `onIdle` 按优先级裁决；除硬拦截外都走评分(每个走/转候选减 `actionDanger`)：

| # | 层 | 说明 |
|---|---|---|
| 1 | frozen 硬拦截 | `me.status.frozen` 时无法行动，直接 return |
| 2 | 首帧白嫖开火 | 每条命第一次决策直接 fire(敌不躲弹，白嫖一发) |
| 3 | 生存硬闸门 | 躲实弹；躲不掉再用防御技能(shield 挡 / cloak·boost 逃) |
| 4 | 进攻技能击杀 | **技能无关分派**：freeze/stun/overload/poison/cloak/shield/teleport/boost |
| 5 | 同轴狂射 | 同线无遮挡+炮管有预算→对准开火，**射程拉满**(高于抢星) |
| 6 | 守枪线 | 无即时目标时走到控星道/走廊咽喉蹲守 |
| 7 | 抢星 | BFS 下一步(farm 星攒撤离资金) |
| 8 | 末位 farm | 只剩我+1 敌且有星→不打死它，优先抢星 |
| 9 | 破墙开路 | 前方土堆射穿 |
| 10 | 巡逻兜底 | 无射线无星不发呆 |

---

## 技能无关 + 按敌技能分型

**我方技能不固定**(可在网站切换)。坦克运行时读 `me.skill.type` 分派，
调 `me[skill](...)`(引擎 proxy 只保留当前技能的方法)。

按「我方技能 × 敌方技能」调阈值(移植自 all-round-tank)：
- `MATCHUP`(02)：`getMatchup(我, 敌)` 给施放距离/是否要射线/是否避盾。
- `ENEMY_THREAT_PROFILE`(02)：每种敌技能的 standoff/威胁权重/双弹覆盖带/冰冻死区，
  驱动**选靶权重**(05 targetScore) 与**落点惩罚**(05 skillZonePenalty)。
- 敌人用 `enemy.index` 做稳定标记，可做跨帧 per-enemy 记忆。

> 注：1v1 实测 freeze/stun/poison 的重型空间防御子树净负，**只 standoff 是正杠杆**；
> 但 raid 敌不躲弹，技能**进攻端**(冻/晕/双弹/毒后必中)收益极高 → 进攻搬足、防御精简。

---

## 多发子弹账本

`game.visibleBullets[]` 无 owner 字段，无法直接认领己方弹。用**双信号取上界**：
- 主信号：己方开火账本 `myShots[]`(每次 fire 记一条，overload 记 2 条，超 `BULLET_LIFETIME` 帧过期)。
- 下界校验：`visibleBullets` 中在我朝向轴、朝我朝向、位于前方的弹。
- `countMyBulletsInFlight()` = `max(账本, 校验)`，`< MULTI_BULLET_CAP` 才允许开火。

**调参**：线上拿到多发等级后，把 `raid-src/01-constants.js` 的 `MULTI_BULLET_CAP`
调到对应弹道数(默认 1 = 单弹在场就不重复开火)。

---

## 构建 & 发布

```bash
# 在 myth-survivor 目录(或用绝对路径，脚本会自动 chdir 到自身目录)

# 构建产物(改完 raid-src/ 后)
node build.js

# 发布(自动先 build，再发 raid 分支)
python publish.py
python publish.py -n "调多发账本上限"     # 附版本说明
python publish.py --no-build              # 跳过构建，直接发现有产物
python publish.py --no-minify             # 不压缩(调试用)
python publish.py --dry-run               # 只预览请求体，不实际发布
python publish.py -b multiplayer          # 同一份代码发到多人分支
python publish.py -s                      # 查坦克状态(各分支版本)
python publish.py -m                      # 查最近战斗记录

# 也可用根目录发布器(等价)：
python ../../publish.py --tank survivor
```

---

## 本地验证(改完务必跑)

本地模拟器只支持 2 player，且**不提供** `game.enemies/alivePlayers/visibleBullets`，
所以多坦克逻辑只能线上验证；本地只能查语法 + 1v1 兜底路径 + self-play 噪声底。

```bash
# 语法
node --check raid-tank-submit.js

# self-play 标零点(换不同 --skill-a/--skill-b 各跑一轮)
cd ../../agentank-simulator
node bench.mjs --bot-a ../my-tank/myth-survivor/raid-tank-submit.js \
               --bot-b ../my-tank/myth-survivor/raid-tank-submit.js \
               --skill-a freeze --skill-b freeze -n 30 --swap
```

**重点看**：零 ERROR / 零 timeout / 零自杀崩溃，胜率 50%±5pp(噪声底)。
这是「技能无关分派」+「一帧一命令铁律」的核心回归检查。

---

## 关键约束(改代码前必读)

- **一帧只能一个引擎命令**(go/turn/fire 之一)。非 boost 发多命令 → 引擎只认第一个、
  后续被丢 = 自杀。**唯一例外**：`me.status.boosted` 为真时允许同帧 `turn+fire`(甩狙)。
  → 新增「同帧多命令」前必须 `me.status.boosted` 门控(见 06-skills 的 `flick`)。
- 引擎机制：子弹 **2 格/帧**、坦克 **1 格/帧**、转向占 **1 帧**。躲避/对射时序按此建模。
- 位置始终是 `[x, y]` 数组，不是 `{x, y}` 对象。地图格 `"x"`墙 `"m"`土堆 `"o"`草 `"."`空地。
- 多人字段全做 null 防御：`(game.enemies || [])` / `(game.visibleBullets || [])`。
- 别直接改 `game.enemies/players/visibleBullets`(只读快照)。

---

## 迭代建议

每次只改一个行为，发布后用 `python publish.py -m` 逐层复盘(首帧 fire 是否生效、
同轴狂射命中、守枪线收割、技能击杀触发)，据此调 `MULTI_BULLET_CAP`、守线锚点、
各技能施放阈值(`raid-src/02-matchup.js` 的 MATCHUP / 06-skills 的分数)。
