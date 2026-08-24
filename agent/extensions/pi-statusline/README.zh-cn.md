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

配置会与内置默认值深度合并。通过 `lines` 和 `modules` 定义布局；模块数据源包括 `session.cwd`、`model`、`thinking`、`usage.*`、`ctx.*`、`task.elapsed`、`ttft`、`tps`、`focus`、`ext-status`、`literal` 等。完整模板见 `config.example.json`。

tmux 用户：如需焦点模块更新，请设置 `set -g focus-events on`。
