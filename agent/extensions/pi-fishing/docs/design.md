# pi-fishing 设计方案

## 1. 项目目标

pi-fishing 是一个 pi 扩展，在 TUI header 中展示一个挂机钓鱼小游戏。它把用户正常使用 agent 时已经消耗的 token 记录为“鱼饵”，鱼饵累积到阈值后自动抛竿，随机钓到不同种类的鱼。每条鱼拥有种类、重量、长度和评分，可以出售换取金币。金币用于购买和升级鱼竿、购买和扩容鱼缸。鱼竿等级和类型影响可钓到的鱼种和稀有鱼概率，鱼缸用于养殖和展示鱼。

第一阶段先落地 pi 扩展；后续扩展到 deepseek-harness 等其他 agent 平台，并支持 web 前端展示。

核心体验原则：token 消耗是正常使用 agent 的副产品，pi-fishing 只读取已经发生的 token 用量，不要求用户额外消耗 token 来玩游戏。

---

## 2. 调研结论：pi 扩展接入点

### 2.1 扩展形态

pi 扩展位于 `~/.pi/agent/extensions/<name>/index.ts`，使用 TypeScript，入口文件默认导出一个工厂函数：

```ts
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function (pi: ExtensionAPI): void {
  // ...
}
```

扩展通过 `pi.on(event, handler)` 订阅生命周期事件，通过 `pi.registerCommand(name, options)` 注册 slash command。

### 2.2 token 用量事件

pi 提供以下事件可以采集 token 用量：

| 事件              | 用途                      | 取值位置                                             |
| ----------------- | ------------------------- | ---------------------------------------------------- |
| `message_end`     | 正常 assistant 消息结束   | `event.message.usage`，仅处理 `role === "assistant"` |
| `session_compact` | 上下文压缩产生的 LLM 调用 | `event.compactionEntry?.usage`                       |
| `session_tree`    | 分支总结产生的 LLM 调用   | `event.summaryEntry?.usage`                          |

`Usage` 对象包含：

```ts
interface Usage {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  totalTokens: number;
  cost: {
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
    total: number;
  };
}
```

pi-fishing 的鱼饵 token 统计公式：

```ts
baitTokens = input + output + cacheRead + cacheWrite;
```

该公式与 pi-metrics 的 `bucketTokens` 口径一致，但 pi-fishing 自行采集和存储，不 import 或依赖 pi-metrics 等其他扩展。

### 2.3 header 渲染 API

`ctx.ui.setHeader(factory)` 可以替换 TUI 内置 header：

```ts
ctx.ui.setHeader((tui, theme) => ({
  render(width: number): string[] {
    return ["line1", "line2"];
  },
  invalidate(): void {
    // 主题或状态变化时清理缓存
  },
  dispose?(): void {
    // 移除 header 时清理定时器/订阅
  },
}));
```

- `render(width)` 必须返回字符串数组，每行一个字符串。
- 传入 `undefined` 会恢复内置 header。
- 仅在 `ctx.mode === "tui"` 时调用 header API。
- 可用 `ctx.ui.notify(message, type)` 输出游戏通知。
- 参考 pi-statusline 的 footer 工厂模式：在 `session_start` 时安装 UI，在 `session_shutdown` 时保存状态。

### 2.4 持久化参考

pi-metrics 使用扩展目录下的 append-only JSONL 日志（`events.jsonl`）存储事件，启动时重放日志重建内存索引。pi-fishing 采用相同的稳健性思路：

- 游戏事件写入 `extensions/pi-fishing/data/events.jsonl`。
- 派生状态保存到 `extensions/pi-fishing/data/state.json`。
- 启动时读取 `state.json`；当 `state.json` 缺失或版本不匹配时，从 `events.jsonl` 重放重建。
- 每次写入采用“写入临时文件 + rename”的原子替换策略。

---

## 3. 总体架构

### 3.1 分层

```text
┌────────────────────────────────────────────────────┐
│ 平台适配层 adapters/                                 │
│  pi-adapter.ts      把 pi 事件转成游戏事件           │
│  deepseek-adapter.ts 未来扩展                        │
└───────────────────────┬────────────────────────────┘
                        │ GameEvent
┌───────────────────────▼────────────────────────────┐
│ 游戏内核 core/                                       │
│  game.ts             纯状态机，不依赖 pi/TUI/web     │
│  species.ts          鱼种数据                        │
│  rods.ts             鱼竿数据                        │
│  aquariums.ts        鱼缸数据                        │
│  economy.ts          价格/评分/售价公式              │
│  rng.ts              可注入随机数                    │
│  clock.ts            可注入时钟                      │
└───────────────────────┬────────────────────────────┘
                        │ GameSnapshot / UIEvent
┌───────────────────────▼────────────────────────────┐
│ 持久化层 store/                                      │
│  store.ts            state.json 读写与事件日志       │
│  migrate.ts          schema 版本迁移                 │
└───────────────────────┬────────────────────────────┘
                        │
┌───────────────────────▼────────────────────────────┐
│ 渲染层 ui/                                           │
│  header.ts           pi TUI header 组件             │
│  frames.ts           8 帧 ASCII 钓鱼动画            │
│  format.ts           数量/价格/长度格式化            │
│  web/                未来 web 渲染                   │
└────────────────────────────────────────────────────┘
```

### 3.2 核心模块职责

- `core/game.ts`：持有 `GameState`，接收 `GameEvent` 和 `Command`，返回新的 `GameSnapshot` 和待展示事件文本。全部为同步纯函数，随机数和时间通过参数注入。
- `adapters/pi-adapter.ts`：订阅 `message_end`、`session_compact`、`session_tree`，把 usage 转成 `GameEvent.TokensConsumed`；订阅 `session_start`、`session_shutdown` 做初始化和持久化。
- `ui/header.ts`：从 `GameSnapshot` 和动画状态渲染 8 行 header；持有定时器驱动 8 帧动画和节流刷新。
- `store/store.ts`：负责状态加载、保存、追加事件日志、防抖写盘。

### 3.3 面向未来平台的接口

游戏内核只依赖以下抽象，pi、deepseek-harness、web 都通过适配器接入：

```ts
interface GameLike {
  handleEvent(event: GameEvent): void;
  dispatch(command: Command): CommandResult;
  snapshot(): GameSnapshot;
}

interface TokenSourceAdapter {
  start(onTokensConsumed: (amount: number, source: string) => void): void;
  stop(): void;
}
```

web 前端通过 HTTP/WS 暴露同一份 `GameSnapshot`，并发送同样的 `Command`。

---

## 4. 目录结构

```text
extensions/pi-fishing/
├── index.ts                  # 扩展入口：注册命令、装配 adapter/store/ui
├── config.example.json       # 配置示例
├── README.md                 # 用户文档
├── docs/
│   └── design.md             # 本文件
├── core/
│   ├── game.ts               # 游戏状态机
│   ├── game-state.ts         # GameState 类型与初始状态
│   ├── species.ts            # 鱼种表
│   ├── rods.ts               # 鱼竿表
│   ├── aquariums.ts          # 鱼缸表
│   ├── economy.ts            # 价格、评分、售价公式
│   ├── rng.ts                # RNG 接口与默认实现
│   └── clock.ts              # Clock 接口与默认实现
├── adapters/
│   └── pi-adapter.ts         # pi 事件 -> 游戏事件
├── store/
│   ├── store.ts              # JSON state 读写 + JSONL 事件日志
│   └── migrate.ts            # schema 迁移
├── ui/
│   ├── header.ts             # TUI header 组件
│   ├── frames.ts             # 8 帧 ASCII 动画
│   └── format.ts             # 格式化工具
└── data/                     # 运行时数据，由程序自动创建
    ├── state.json
    └── events.jsonl
```

---

## 5. 游戏核心模型

### 5.1 GameState

```ts
interface GameState {
  version: number; // 存档 schema 版本，从 1 开始
  coins: number; // 金币
  totalTokensConsumed: number; // 累计 token 消耗
  pendingBaitTokens: number; // 已累积但尚未触发抛竿的鱼饵 token
  equippedRodId: RodId; // 当前装备的鱼竿
  ownedRods: Record<RodId, RodState>;
  aquariums: AquariumState[];
  inventory: FishInstance[]; // 鱼篓中的鱼
  collection: CollectionEntry[]; // 图鉴：每个鱼种的捕获次数/最大重量/最大长度
  stats: GameStats;
}

interface RodState {
  rodId: RodId;
  level: number; // 等级，从 1 开始
}

interface AquariumState {
  aquariumId: AquariumId;
  capacity: number; // 当前容量
  fish: FishInstance[]; // 养殖中的鱼
}

interface FishInstance {
  id: string; // 唯一 id
  speciesId: SpeciesId;
  weightGrams: number;
  lengthCm: number;
  rating: number; // 0-100，由重量/长度/稀有度计算
  caughtAt: number; // epoch ms
  sold: boolean;
  location: "inventory" | "aquarium";
}

interface GameStats {
  totalCatches: number;
  totalSales: number;
  totalCoinsEarned: number;
  totalCoinsSpent: number;
  totalBaitTokensUsed: number; // 实际用于抛竿的 token
  rareCatches: number;
}
```

### 5.2 鱼种

```ts
interface Species {
  id: SpeciesId;
  name: string;
  emoji: string; // 用于列表展示
  rarity: "common" | "uncommon" | "rare" | "epic" | "legendary";
  minWeightGrams: number;
  maxWeightGrams: number;
  minLengthCm: number;
  maxLengthCm: number;
  baseValue: number; // 基础售价金币
  requiredRodId: RodId; // 解锁该鱼种所需的鱼竿
  aquariumCompatible: boolean; // 是否可放入鱼缸养殖
  scoreWeight: number; // 评分权重，默认 1
}
```

第一阶段鱼种表：

| id       | 名称 | emoji | 稀有度    | 重量范围   | 长度范围 | 基础价 | 解锁鱼竿 |
| -------- | ---- | ----- | --------- | ---------- | -------- | ------ | -------- |
| carp     | 鲫鱼 | 🐟    | common    | 200-800g   | 15-30cm  | 12     | 竹竿     |
| crucian  | 鲤鱼 | 🐠    | common    | 500-1500g  | 20-40cm  | 20     | 竹竿     |
| bass     | 鲈鱼 | 🐟    | uncommon  | 800-2500g  | 30-55cm  | 45     | 碳素竿   |
| trout    | 鳟鱼 | 🐠    | uncommon  | 600-1800g  | 25-45cm  | 50     | 碳素竿   |
| catfish  | 鲶鱼 | 🐡    | rare      | 2000-6000g | 40-80cm  | 120    | 远投竿   |
| mandarin | 鳜鱼 | 🐟    | rare      | 1000-3500g | 30-60cm  | 150    | 远投竿   |
| koi      | 锦鲤 | 🐠    | epic      | 1500-5000g | 35-70cm  | 400    | 黄金竿   |
| arowana  | 龙鱼 | 🐉    | legendary | 3000-9000g | 50-90cm  | 1200   | 黄金竿   |

### 5.3 鱼竿

```ts
interface Rod {
  id: RodId;
  name: string;
  emoji: string;
  basePrice: number;
  upgradeBasePrice: number; // 升级价格基数
  maxLevel: number;
  rarityMultiplier: number; // 稀有鱼概率乘数
  weightMultiplier: number; // 重量乘数
  baitTokensPerCast: number; // 使用该鱼竿抛竿一次需要的鱼饵 token 数
}
```

第一阶段鱼竿表：

| id        | 名称   | emoji | 基础价        | 抛竿阈值 | 稀有概率乘数 | 重量乘数 | 最大等级 |
| --------- | ------ | ----- | ------------- | -------- | ------------ | -------- | -------- |
| bamboo    | 竹竿   | 🎋    | 0（初始拥有） | 2000     | 1.0          | 1.0      | 5        |
| carbon    | 碳素竿 | 🎣    | 300           | 1500     | 1.5          | 1.1      | 5        |
| long_cast | 远投竿 | 🎣    | 900           | 1200     | 2.5          | 1.2      | 5        |
| golden    | 黄金竿 | ✨    | 3000          | 1000     | 5.0          | 1.4      | 5        |

### 5.4 鱼缸

```ts
interface Aquarium {
  id: AquariumId;
  name: string;
  emoji: string;
  basePrice: number;
  baseCapacity: number;
  maxCapacity: number;
  upgradeBasePrice: number; // 扩容升级价格基数
  allowedSpecies: SpeciesId[]; // 可养殖鱼种
  breedingIntervalMs: number; // 养殖产出周期
}
```

第一阶段鱼缸表：

| id     | 名称     | emoji | 基础价 | 基础容量 | 最大容量 | 可养殖鱼种             |
| ------ | -------- | ----- | ------ | -------- | -------- | ---------------------- |
| small  | 小型鱼缸 | 🐠    | 200    | 3        | 6        | 鲫鱼、鲤鱼             |
| medium | 中型鱼缸 | 🐟    | 600    | 5        | 10       | 鲫鱼、鲤鱼、鲈鱼、鳟鱼 |
| large  | 大型鱼缸 | 🐡    | 1500   | 8        | 16       | 所有可入缸鱼种         |

### 5.5 游戏事件

```ts
type GameEvent =
  | {
      type: "TokensConsumed";
      amount: number;
      source: "msg" | "compact" | "tree";
      ts: number;
    }
  | { type: "Tick"; now: number }; // 由定时器驱动，用于动画和养殖结算

type Command =
  | { type: "Show" }
  | { type: "Hide" }
  | { type: "SellFish"; fishId: string }
  | { type: "SellAllFish" }
  | { type: "BuyRod"; rodId: RodId }
  | { type: "UpgradeRod"; rodId: RodId }
  | { type: "EquipRod"; rodId: RodId }
  | { type: "BuyAquarium"; aquariumId: AquariumId }
  | { type: "UpgradeAquarium"; aquariumId: AquariumId }
  | { type: "AssignFishToAquarium"; fishId: string; aquariumId: AquariumId }
  | { type: "RemoveFishFromAquarium"; fishId: string };

type GameEffect =
  | { type: "FishCaught"; fish: FishInstance }
  | { type: "FishSold"; fishId: string; coins: number }
  | { type: "Purchase"; kind: "rod" | "aquarium"; id: string; cost: number }
  | { type: "EventLine"; text: string };
```

---

## 6. Token 统计与钓鱼循环

### 6.1 采集

pi-adapter 订阅以下事件并自行计算鱼饵 token：

- `message_end`：读取 assistant message 的 `usage`。
- `session_compact`：读取 `event.compactionEntry?.usage`。
- `session_tree`：读取 `event.summaryEntry?.usage`。

对每个 usage，计算：

```ts
const amount = usage.input + usage.output + usage.cacheRead + usage.cacheWrite;
game.handleEvent({ type: "TokensConsumed", amount, source, ts: Date.now() });
```

同时累加 `totalTokensConsumed` 和 `pendingBaitTokens`。

### 6.2 抛竿结算

`pendingBaitTokens` 达到当前装备鱼竿的 `baitTokensPerCast` 时，触发一次抛竿结算：

1. 从 `pendingBaitTokens` 中扣除 `baitTokensPerCast`。
2. 依据当前鱼竿解锁范围、鱼种稀有度和鱼竿 `rarityMultiplier` 进行加权随机，选定鱼种。
3. 在鱼种的重量/长度区间内随机生成 `weightGrams` 和 `lengthCm`。
4. 计算评分：

```ts
rating = clamp(
  50 +
    weightScore * 20 +
    lengthScore * 15 +
    rarityScore * 10 +
    rod.weightMultiplier * 5,
  0,
  100,
);
```

其中 `weightScore`、`lengthScore` 是当前鱼在鱼种区间内的相对位置，`rarityScore` 是稀有度档位分。5. 生成 `FishInstance`，放入 `inventory`，更新图鉴和 `totalCatches`。6. 输出事件行：`钓到了 [鲈鱼] 1.2kg / 38cm / 评分 B`。

### 6.3 节流与批量结算

在单次会话中，token 事件可能在短时间内大量到达。游戏内核使用 `TokensConsumed` 事件累加 `pendingBaitTokens`，由 UI 定时器每 500ms 调用一次 `Tick`，在 `Tick` 中批量结算超过阈值的抛竿次数。这样可以：

- 合并连续 token 流，避免每 1 token 就触发渲染。
- 保持单次抛竿事件文本在 1 行事件区中可读。
- 避免在 pi 的 `message_end` 回调里执行过多计算。

---

## 7. Header UI

### 7.1 展示状态

展示状态默认关闭。用户执行 `/pi-fishing show` 后，pi-fishing 通过 `ctx.ui.setHeader(factory)` 安装自定义 header；执行 `/pi-fishing hide` 后调用 `ctx.ui.setHeader(undefined)` 恢复内置 header。展示状态持久化在 `state.json` 的 `uiVisible` 字段中，在后续会话 `session_start` 时自动恢复。

### 7.2 行布局

header 固定输出 8 行：

| 行号 | 区域     | 内容                                           |
| ---- | -------- | ---------------------------------------------- |
| 1    | 状态行 1 | 鱼饵进度、金币、累计 token                     |
| 2    | 状态行 2 | 当前鱼竿、鱼篓占用、鱼缸数量                   |
| 3-7  | 动画区   | 5 行 ASCII 钓鱼动画                            |
| 8    | 事件行   | 最近一次游戏事件，如钓到鱼、出售成功、购买成功 |

示例：

```text
🎣 鱼饵 1.2k/2.0k  金币 320  累计 12.4k tok
🎋 竹竿 Lv.2  🐟 鱼篓 3/10  🐠 鱼缸 1
    🎣
     |
  ~~~~~
  ><> 鲈鱼
钓到了 [鲈鱼] 1.2kg / 38cm / 评分 B
```

### 7.3 8 帧动画

动画区每 200ms 切换一帧，8 帧循环。帧定义在 `ui/frames.ts` 中，每帧为 5 个字符串。帧序列描述：

| 帧  | 画面                   |
| --- | ---------------------- |
| 0   | 鱼竿静止，水面平静     |
| 1   | 浮漂轻微下沉           |
| 2   | 浮漂明显下沉，出现鱼影 |
| 3   | 鱼影靠近，鱼线拉紧     |
| 4   | 鱼跃出水面             |
| 5   | 鱼在空中，水花溅起     |
| 6   | 收竿，鱼落入鱼篓       |
| 7   | 鱼竿复位，水面恢复     |

默认帧使用 ASCII 字符，示例帧（帧 4）：

```text
    🎣
     \
  ~~~~~
   ><>
  💦
```

鱼种 emoji 和颜色由 `theme.fg`/`theme.bold` 应用，所有帧在 `render(width)` 内按终端宽度截断到 `width`。

### 7.4 渲染刷新

- 动画由 `setInterval` 驱动，间隔 200ms。
- 每次 tick 调用 `tui.requestRender()` 触发 `render(width)`。
- `dispose()` 中清理定时器。
- token 事件只更新状态并累积，渲染节奏由动画定时器统一控制。

---

## 8. 命令

pi-fishing 注册 `/pi-fishing` 主命令，通过子命令分发：

| 命令                                        | 说明                                |
| ------------------------------------------- | ----------------------------------- |
| `/pi-fishing show`                          | 显示游戏 header                     |
| `/pi-fishing hide`                          | 隐藏游戏 header                     |
| `/pi-fishing status`                        | 用 `ctx.ui.notify` 显示完整状态摘要 |
| `/pi-fishing sell <fishId>`                 | 出售指定鱼                          |
| `/pi-fishing sell all`                      | 出售鱼篓中全部鱼                    |
| `/pi-fishing buy rod <rodId>`               | 购买鱼竿                            |
| `/pi-fishing upgrade rod <rodId>`           | 升级鱼竿                            |
| `/pi-fishing equip <rodId>`                 | 装备鱼竿                            |
| `/pi-fishing buy aquarium <aquariumId>`     | 购买鱼缸                            |
| `/pi-fishing upgrade aquarium <aquariumId>` | 扩容鱼缸                            |
| `/pi-fishing assign <fishId> <aquariumId>`  | 把鱼放入鱼缸                        |
| `/pi-fishing remove <fishId>`               | 把鱼从鱼缸取出                      |
| `/pi-fishing stats`                         | 显示累计统计                        |
| `/pi-fishing help`                          | 显示帮助                            |

命令返回统一通过 `ctx.ui.notify(message, "info")` 或 `"warning"` / `"error"` 展示。

---

## 9. 经济数值

### 9.1 售价公式

```ts
salePrice = round(
  species.baseValue * weightFactor * lengthFactor * rarityFactor,
);
```

- `weightFactor = 0.6 + 0.8 * (weightGrams - minWeightGrams) / (maxWeightGrams - minWeightGrams)`
- `lengthFactor = 0.7 + 0.6 * (lengthCm - minLengthCm) / (maxLengthCm - minLengthCm)`
- `rarityFactor`：common 1.0，uncommon 1.5，rare 2.5，epic 5.0，legendary 10.0

### 9.2 鱼竿升级

升级价格：

```ts
upgradeCost = rod.upgradeBasePrice * pow(1.8, currentLevel - 1);
```

升级效果：

- 每升 1 级，稀有鱼概率乘数增加 0.15。
- 每升 1 级，重量乘数增加 0.05。
- 每升 1 级，抛竿阈值降低 5%。

### 9.3 鱼缸扩容

扩容价格：

```ts
upgradeCost = aquarium.upgradeBasePrice * pow(1.7, capacity - baseCapacity);
```

每次扩容增加 1 容量，达到 `maxCapacity` 后停止。

### 9.4 初始状态

- 金币：50
- 拥有鱼竿：竹竿 Lv.1
- 装备鱼竿：竹竿
- 鱼缸：无
- 鱼篓容量：10
- 图鉴：空
- `pendingBaitTokens`：0

---

## 10. 配置

`config.example.json` 提供以下可配置项：

```json
{
  "uiVisible": false,
  "animationIntervalMs": 200,
  "tickIntervalMs": 500,
  "defaultInventoryCapacity": 10,
  "baitTokensPerCast": 2000
}
```

配置读取优先级：

1. 项目级 `<cwd>/.pi/pi-fishing.json`
2. 扩展级 `extensions/pi-fishing/config.json`
3. 内置默认值

配置中 `uiVisible` 的初始值用于第一次启动；后续由存档 `state.json` 中的值覆盖。

---

## 11. 持久化

### 11.1 文件位置

- 状态文件：`extensions/pi-fishing/data/state.json`
- 事件日志：`extensions/pi-fishing/data/events.jsonl`

### 11.2 state.json 结构

```ts
interface PersistedState extends GameState {
  savedAt: number;
}
```

### 11.3 写入策略

- 每次 `GameEffect` 产生后，将事件追加到 `events.jsonl`。
- `state.json` 在事件发生后 1 秒防抖写入。
- `session_shutdown` 时立即写盘。
- 写盘流程：写 `state.json.tmp`，然后 `rename` 覆盖 `state.json`。

### 11.4 加载与迁移

- 启动时读取 `state.json`。
- 若 `state.json` 不存在，从 `events.jsonl` 重放事件生成状态。
- 若 `state.json.version` 低于当前版本，调用 `store/migrate.ts` 中的迁移链逐级升级。
- 迁移函数以纯函数形式实现：`migrate(state: GameStateV1): GameStateV2`。

---

## 12. 测试策略

### 12.1 单元测试

- `core/game.ts`：给定固定 RNG 和时间序列，断言抛竿结算、出售、购买、升级的结果。
- `core/economy.ts`：售价、升级价格、评分计算的边界值测试。
- `core/species.ts`：所有鱼种的区间、解锁鱼竿、价格配置完整性校验。
- `store/migrate.ts`：每个版本迁移的前后状态断言。
- `ui/frames.ts`：每帧正好 5 行，行宽可截断到任意 `width`。

### 12.2 集成测试

- 模拟 pi 事件流：连续 `message_end` / `session_compact` / `session_tree` 事件后，`pendingBaitTokens` 和抛竿次数符合预期。
- 模拟崩溃恢复：写入部分 `state.json.tmp` 后加载，仍能从旧 `state.json` 或 `events.jsonl` 恢复。

---

## 13. 第一阶段实施计划

### 阶段 1：核心内核

1. 创建 `core/` 目录和类型定义。
2. 实现 `species.ts`、`rods.ts`、`aquariums.ts` 数据表。
3. 实现 `rng.ts`、`clock.ts` 可注入接口。
4. 实现 `game.ts`：`TokensConsumed`、`Tick`、全部 `Command`。
5. 实现 `economy.ts` 公式和单元测试。

### 阶段 2：持久化

1. 实现 `store/store.ts` 的状态加载、防抖保存、原子写入。
2. 实现 `store/migrate.ts` 的版本迁移框架。
3. 实现 `events.jsonl` 追加日志。

### 阶段 3：pi 适配与 UI

1. 实现 `adapters/pi-adapter.ts` 的 token 事件采集。
2. 实现 `ui/frames.ts` 的 8 帧动画。
3. 实现 `ui/header.ts` 的 8 行 header 渲染。
4. 实现 `index.ts` 的命令注册、show/hide 逻辑、生命周期装配。
5. 实现 `config.example.json` 和 `README.md`。

### 阶段 4：测试与打磨

1. 补齐单元测试和集成测试。
2. 在真实 pi 会话中验证动画帧率、header 布局和存档恢复。
3. 根据实际 token 事件频率调整节流参数。

---

## 14. 后续平台扩展

### 14.1 deepseek-harness

新增 `adapters/deepseek-adapter.ts`，实现与 `adapters/pi-adapter.ts` 相同的 `TokenSourceAdapter` 接口，从 deepseek-harness 的 token 统计接口采集用量并转为 `GameEvent.TokensConsumed`。游戏内核、持久化和 UI 代码复用。

### 14.2 web 前端

新增 `ui/web/`，提供 HTTP 服务和 WebSocket：

- `GET /snapshot` 返回当前 `GameSnapshot` JSON。
- `WS /events` 推送 `GameEffect` 和新的 `GameSnapshot`。
- `POST /command` 接收 `Command` JSON。
- web 前端独立渲染动画和界面，与 TUI 共享同一份内核和存档。
