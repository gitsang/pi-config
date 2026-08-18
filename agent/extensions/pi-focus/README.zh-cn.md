# pi-focus

pi 扩展中唯一的 DEC 1004 焦点上报者。

- 在 TUI 模式下启用终端焦点上报（`ESC[?1004h`）。
- 消费 `ESC[I` / `ESC[O` 并通过 `pi-focus:change` 广播 `{ focused: boolean }`。
- 其他扩展（如 pi-statusline、pi-status）订阅该事件；请勿自行启用或消费 DEC 1004。

## 使用

- `/pi-focus` — 查看监听器状态。

在 tmux 中，需要 `set -g focus-events on`，焦点切换才会被转发。

无需配置。
