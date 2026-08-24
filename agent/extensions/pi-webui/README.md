# pi-webui

基于 pi RPC 模式的浏览器 Web UI。一个浏览器会话对应一个 `pi --mode rpc` 子进程。

## 目录结构

```
extensions/pi-webui/
├── index.ts          # pi 扩展：/pi-webui install|update|version|start...
├── cmd/pi-webui/     # Go 二进制入口
├── internal/         # config/auth/rpc/sessionmgr/api/logging
├── web/              # React + TypeScript 前端（Vite + Ant Design，支持明暗主题）
├── Makefile
├── version.txt
└── README.md
```

> 本目录同时是 pi 扩展目录和 Go 项目根目录。与 handoff.md 中 GitHub 源码仓库
> 结构（`extensions/index.ts`）略有差异，此处把扩展入口 `index.ts` 放在扩展目录
> 根，便于 pi 直接加载。

## 开发构建

```bash
make build
# 等于：
cd web && npm install && npm run build
go build -o pi-webui ./cmd/pi-webui
```

产物：

- `pi-webui` — Go 二进制
- `dist/` — 前端构建产物（运行时放在二进制旁 `dist/`）

## 安装

```bash
pi install git:github.com/<you>/pi-webui
# 在 pi 里执行：
/pi-webui install
```

`/pi-webui install` 会从 GitHub Releases 下载 `pi-webui-<os>-<arch>.tar.gz`，
解压到 `~/.pi/agent/extensions/pi-webui/`，生成含随机登录密码的
`config.yaml`，并尝试 symlink 到 `~/.local/bin/pi-webui`。

## 命令

二进制命令：

| 命令 | 行为 |
|------|------|
| `pi-webui start` | 前台运行 web 服务 |
| `pi-webui stop` | 按 pid 文件停止运行实例 |
| `pi-webui status` | 查看运行状态（pid + 端口健康检查） |
| `pi-webui daemon install/uninstall/start/stop/status` | systemd user service |
| `pi-webui set-password [--generate] [密码]` | 设置/重置登录密码 |
| `pi-webui config` | 打印配置路径与当前生效配置 |

## 配置

配置文件：`~/.pi/agent/extensions/pi-webui/config.yaml`（默认）。

```yaml
listen: "0.0.0.0:8080"
sessionDir: ""          # 空 = pi 默认会话目录
distDir: ""             # 空 = 二进制旁 dist/
piPath: ""              # 空 = exec.LookPath("pi")
logsDir: ""             # 空 = <install>/logs
logLevel: "info"

auth:
  passwordHash: ""      # argon2id；首次运行自动生成并打印随机密码
  cookie:
    httpOnly: true
    sameSite: "lax"
    secure: "auto"
    maxAgeSeconds: 86400
    sliding: true
```

## 反向代理

webui 自身不终结 TLS，请由 nginx/caddy 等反代处理。

### nginx

```nginx
server {
    listen 443 ssl;
    server_name pi-webui.example.com;
    ssl_certificate     /etc/ssl/certs/example.crt;
    ssl_certificate_key /etc/ssl/private/example.key;

    location / {
        proxy_pass http://127.0.0.1:8080;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-Proto https;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_buffering off;
        proxy_read_timeout 3600s;
    }
}
```

### caddy

```caddy
pi-webui.example.com {
    reverse_proxy 127.0.0.1:8080 {
        header_up X-Forwarded-Proto https
    }
}
```

`auth.cookie.secure: auto` 依赖反代传递 `X-Forwarded-Proto: https` 来给
Cookie 加 Secure 标记。

## 实现备注

- 导入会话时，`pi --session` 使用会话文件的**绝对路径**恢复；只传 session id
  在部分 session-dir 布局下无法解析（实测 pi 对 bare id 支持不稳定）。
- 流式 `message_update` 实际事件为 `{usage, assistantMessageEvent:{type,
  contentIndex, delta, content}}`；前端兼容 handoff 中描述的简化
  `{contentIndex, delta, kind}` 形态。
