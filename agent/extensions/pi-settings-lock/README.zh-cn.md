# pi-settings-lock

防止会话内的模型/思考等级切换覆盖 `settings.json` 中的全局 `defaultModel` / `defaultProvider` / `defaultThinkingLevel`。

扩展在会话开始时快照全局默认值，并在每次模型/思考切换后恢复它们：会话内可以切换，但持久化的默认值保持不变。

## 使用

- `/settings-lock` 或 `/settings-lock status` — 查看锁定状态、受保护默认值、当前模型/思考等级。
- `/settings-lock model save` — 将当前会话模型保存为新的全局默认模型。
- `/settings-lock thinking save` — 将当前思考等级保存为新的全局默认思考等级。

## 配置

本扩展目录下的 `config.json`：
- `{ "enable": true }` — 每次切换后恢复默认值（默认行为）
- `{ "enable": false }` — 不干预，使用 pi 内置行为

## 关于模型选择器的竞态

模型选择器（`Ctrl+L` / `/model` 列表）会在调用 `session.setModel()` **之前**先直接往
`settings.json` 写一次新默认值，随后 `setModel()` 还会再排队写一次同样的值。如果扩展在
看到文件出现新模型后立即恢复，恢复会落在这两个排队写入之前，随后被覆盖——这就是
之前只有选择器路径锁不住、而循环切换（`Ctrl+P` / 自定义按键，如 alt+m）正常的原因。
修复方式：检测到写入落盘后，先等待 pi 的写入队列排空再恢复，并再做一次校验重写。
