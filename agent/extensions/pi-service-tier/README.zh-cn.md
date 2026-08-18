# pi-service-tier

为 pi 请求注入可配置的 OpenAI `service_tier`。

在 `providers` 或 `models` 下配置某个条目，即表示该 provider/model 支持 service-tier。model 级配置优先于 provider 级。

## 使用

- `/service-tier` 或 `/service-tier status` — 查看当前模型能力、生效 tier 与允许列表。
- `/service-tier <tier>` — 设置本次会话覆盖值。
- `/service-tier off` — 本次会话不发送 `service_tier`。
- `/service-tier on` / `reset` — 清除覆盖，回落到配置默认值。
- `/service-tier list` — 列出当前模型允许的 tier。

## 配置

优先级（后者覆盖前者）：
1. `~/.pi/agent/pi-service-tier.json`
2. 本扩展目录下的 `config.json`
3. `<cwd>/.pi/pi-service-tier.json`（仅受信任项目）

示例见 `config.example.json`。
