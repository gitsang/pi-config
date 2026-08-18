# pi-metrics

pi 的本地持久化用量统计。

按今日 / 本月 / 累计记录：
- token（input/output/cacheRead/cacheWrite）与费用
- 提示次数与会话数

数据以追加方式存储在本扩展旁的 `events.jsonl`，并通过 `ext-status` 发布给 pi-statusline（如 `metrics-today-tokens`、`metrics-month-cost`、`metrics-total-tokens`）。

## 使用

- `/metrics` — 查看今日 / 本月 / 累计汇总。

无需配置。
