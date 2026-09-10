# pi-service-tier

为 pi 请求注入可配置的 OpenAI `service_tier`。

自动对模型 ID 以 `gpt-` 开头的模型生效（区分大小写），与 provider 无关。其他模型的请求保持不变。接口本身需要支持 `service_tier`，前缀判断不会检测服务端是否支持。

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

只需两个顶层配置项，无需配置 `providers` 或 `models`：

```json
{
  "default": "priority",
  "allowed": ["auto", "default", "flex", "priority"]
}
```

- `default`：没有会话覆盖时发送的 tier。设为 null 或省略表示默认不注入。
- `allowed`：`/service-tier <tier>` 可设置的值。设为 null 或省略表示不限制。

配置文件按上述顺序逐字段覆盖。会话覆盖值仍按 `provider/modelId` 分别保存。更新扩展代码后运行 `/reload` 生效。示例见 `config.example.json`。
