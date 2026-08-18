# pi-fishing

一个 pi 挂机钓鱼小游戏。把已经消耗的 token 记录为鱼饵，鱼饵达到当前鱼竿阈值后自动抛竿，随机钓到不同种类的鱼。钓到的鱼可以出售换取金币，金币用于购买和升级鱼竿、购买和扩容鱼缸。

## 使用

- `/pi-fishing show` — 在编辑器上方显示固定钓鱼面板（终端高度至少 16 行）
- `/pi-fishing hide` — 隐藏钓鱼面板
- `/pi-fishing status` — 查看当前状态
- `/pi-fishing sell <fishId|all>` — 出售鱼
- `/pi-fishing buy rod <rodId>` — 购买鱼竿
- `/pi-fishing upgrade rod <rodId>` — 升级鱼竿
- `/pi-fishing equip <rodId>` — 装备鱼竿
- `/pi-fishing buy aquarium <aquariumId>` — 购买鱼缸
- `/pi-fishing upgrade aquarium <aquariumId>` — 扩容鱼缸
- `/pi-fishing assign <fishId> <aquariumId>` — 把鱼放入鱼缸
- `/pi-fishing remove <fishId>` — 从鱼缸取出鱼
- `/pi-fishing stats` — 查看累计统计

## 配置

复制 `config.example.json` 为 `config.json` 可修改：

- `uiVisible`：初始是否显示 header，默认 `false`
- `animationIntervalMs`：动画帧间隔，默认 `200`
- `tickIntervalMs`：游戏结算 tick 间隔，默认 `500`
- `defaultInventoryCapacity`：鱼篓初始容量，默认 `10`
- `baitTokensPerCast`：竹竿的抛竿 token 阈值，默认 `2000`

## 数据

数据保存在 `data/state.json` 和 `data/events.jsonl`。
