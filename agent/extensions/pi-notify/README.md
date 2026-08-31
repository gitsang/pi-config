# pi-notify

Pi 扩展：**任务结束时**推送通知到自定义 webhook。URL、headers、body 全部支持模板变量，可自由定制推送格式。

v0.1 只支持 1 个触发时机（task-complete）+ 1 个推送渠道（webhook），但架构已为后续扩展预留：更多时机（任务开始/中断/需要输入/会话退出）和更多渠道（微信、QQ、系统通知、macOS 通知等）。

## 安装

```bash
# 直接放在扩展目录（推荐，自动发现，/reload 即可生效）：
#   ~/.pi/agent/extensions/pi-notify/

# 或作为 pi 包安装：
pi install ./pi-notify        # 本地目录安装
# 或发布后：pi install npm:pi-notify
```

安装后 `/reload` 或重启 pi。

## 配置

配置文件位置（按优先级）：
1. `$PI_NOTIFY_CONFIG` 环境变量指向的文件
2. 扩展目录下的 `config.json`（复制 `config.example.json` 修改）

```jsonc
{
  "enabled": true,
  "modes": ["tui"],              // 允许推送的 pi 模式；子代理(json/print)默认不推
  "timeoutMs": 5000,             // 每个渠道的请求超时
  "dedupeMs": 3000,              // 相同内容在此窗口内去重
  "minDurationSec": 0,           // 运行短于该秒数时跳过 task-complete 通知
  "maxTextChars": 500,           // 正文截断长度
  "titleTemplate": "pi {{status}}",
  "template": "pi {{status}} · {{reason}}",
  "events": { "task-complete": true },
  "channels": [
    {
      "type": "webhook",
      "name": "my-hook",
      "enabled": true,
      "url": "https://example.com/hook?project={{project}}",
      "method": "POST",
      "headers": { "Authorization": "Bearer ${MY_TOKEN}" },
      "body": {
        "event": "{{event}}",
        "status": "{{status}}",
        "reason": "{{reason}}",
        "text": "{{text}}",
        "meta": { "project": "{{project}}", "model": "{{model}}" }
      }
    }
  ]
}
```

> `body` 推荐写成 **JSON 对象**：先替换占位符再整体序列化，错误文本里的引号/换行永远不会破坏 JSON。字符串 body 也支持（按 `contentType` 自动转义）。不写 `body` 则发送默认信封（含全部变量）。

## 模板变量

| 变量 | 含义 |
|------|------|
| `{{event}}` | 事件名：`task-complete`（v0.1） |
| `{{status}}` | 状态：`已完成` / `已中断` / `出错` |
| `{{reason}}` | 原因说明（出错时含摘要） |
| `{{title}}` | 由 `titleTemplate` 渲染 |
| `{{text}}` | 由 `template` 渲染（截断后） |
| `{{cwd}}` / `{{project}}` | 工作目录 / 项目名 |
| `{{model}}` | `provider/model` |
| `{{session}}` | 会话名（或文件名） |
| `{{duration}}` | 耗时，如 `3m12s` |
| `{{host}}` / `{{time}}` / `{{date}}` | 主机名 / HH:MM:SS / YYYY-MM-DD |

URL 中的占位符会做 URL 编码；`headers`/`body` 值里的 `${ENV}` 环境变量引用也会被展开。

## 命令

```
/notify status   查看配置、渠道与上次推送结果
/notify test     向所有启用渠道发送测试消息
/notify on|off   会话级总开关（不持久化）
/notify help     帮助
```

## 通知日志

发送结果（失败/调试信息）追加写入 `notify.log`（与 config.json 同目录），轮转上限 256KB。

## 扩展架构

```
~/.pi/agent/extensions/pi-notify/
├── index.ts          入口：绑定触发器、注册 /notify 命令
├── events/           触发时机注册表（extension point #1）
│   ├── index.ts       Trigger 接口 + ALL_TRIGGERS
│   └── task-complete.ts   agent_settled → 推送
├── channels/         推送渠道注册表（extension point #2）
│   ├── index.ts       Channel 接口 + registerChannel
│   └── webhook.ts     WebhookChannel（自定义 url/body/headers）
├── notify.ts         载荷构建 + 分发 + 去重 + 日志
├── config.ts         配置加载（mtime 缓存、${ENV} 展开）
├── render.ts         {{placeholder}} 模板渲染
├── http.ts           HTTP 传输（自带超时，不依赖 ctx.signal）
├── types.ts          共享类型
└── test/             单元测试（node --test）
```

**新增时机**：在 `events/` 加一个文件（实现 `Trigger` 接口），注册进 `ALL_TRIGGERS`。
**新增渠道**：在 `channels/` 加一个文件（实现 `Channel` 接口），调用 `registerChannel(type, factory)`。

## 安全

扩展以你的完整系统权限运行，仅安装可信来源。
