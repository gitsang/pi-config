# pi-auto-title

自动为 pi 会话生成简短标题。

- 首次用户输入后自动生成标题（`onFirstTurn`）。
- 压缩后根据摘要重新生成（`onCompact`）。
- 可每 N 轮刷新一次（`refreshEveryTurns`，0 表示关闭）。
- 标题上下文会包含每轮 agent 的最终输出（`includeAssistantOutput`，默认开启）。
- 支持标题语言 `auto` / `zh` / `en`，并可同步到终端标题。

## 使用

- `/auto-title` 或 `/auto-title regen` — 立即生成/刷新标题。
- `/auto-title on` / `off` — 启用/禁用本次会话自动标题。
- `/auto-title status` — 查看当前配置与状态。

## 配置

读取本扩展目录下的 `config.json`；项目级覆盖：`<cwd>/.pi/pi-auto-title.json`（仅受信任项目）。所有字段见 `config.example.json`（`model`、`onFirstTurn`、`onCompact`、`refreshEveryTurns`、`maxTitleLength`、`language`、`setTerminalTitle`、`includeAssistantOutput`）。
