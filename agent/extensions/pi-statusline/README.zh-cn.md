# pi-statusline

pi 的配置驱动状态栏 / footer。

将会话信息（标题、cwd、git 分支、模型、思考等级、service tier、token/费用、上下文条、任务总耗时、TTFT、TPS、焦点，以及其他扩展的 `ext-status` 值）渲染为多行 footer。

## 使用

- `/statusline` — 开关 footer。
- `/statusline reload` — 修改配置后重载。
- `/statusline focus` — 查看焦点状态与 pi-focus 事件状态。
- `/statusline-reset` — 清空 TTFT/TPS/任务总耗时历史。

## 配置

优先级（后者覆盖前者）：
1. `~/.pi/agent/pi-statusline.json`
2. 本扩展目录下的 `config.json`
3. `<cwd>/.pi/pi-statusline.json`（仅受信任项目）

配置会与内置默认值深度合并。通过 `lines` 和 `modules` 定义布局；模块数据源包括 `session.cwd`、`model`、`thinking`、`usage.*`、`ctx.*`、`task.elapsed`、`task.elapsedTotal`、`ttft`、`tps`、`focus`、`ext-status`、`literal` 等。完整模板见 `config.example.json`。

所有间距与分组都在 `lines` 中配置，没有全局 separator 配置。每行支持 `sep`（同组模块间的分隔符）、`sepLeft` / `sepRight`（左右侧单独覆盖）以及 `groupSep`（组间分隔符，默认 `" │ "`）。

每个模块可携带 `priority` 数字（默认 50）：当行溢出时，priority < 90 的模块按优先级从低到高依次丢弃；`truncate: "end"` 的模块会被省略号截断而不是丢弃。

tmux 用户：如需焦点模块更新，请设置 `set -g focus-events on`。
