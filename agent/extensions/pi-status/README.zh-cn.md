# pi-status

将每个 pi 进程的 `idle` / `gen` / `done` 状态发布到共享运行时存储，并投射到 tmux 与 pi-statusline。

- tmux 汇聚同一 tmux server + window 的所有活跃记录，写入 `@pi_t`。
- statusline 通过 `ctx.ui.setStatus("pi-status", state)` 发布当前进程状态。

## 使用

- `/pi-status` 或 `/pi-status reload` — 重载配置。
- `/pi-status status` — 查看 store、tmux、状态与焦点信息。
- `/pi-status on` / `off` — 启用/禁用。
- `/pi-status state idle|gen|done` — 强制设置当前进程状态。

在 tmux 中如依赖 pi-focus 状态，请设置 `set -g focus-events on`。

## 配置

优先级（后者覆盖前者）：
1. `~/.pi/agent/pi-status.json`（也兼容旧版 `~/.pi/agent/pi-tmux-status.json`）
2. 本扩展目录下的 `config.json`
3. `<cwd>/.pi/pi-status.json`（仅受信任项目；兼容旧版 `pi-tmux-status.json`）

示例见 `config.example.json`。
