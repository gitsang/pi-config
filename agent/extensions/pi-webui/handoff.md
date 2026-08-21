# pi-webui 第一版实现交接文档

> 本文档是经过多轮决策确认后的完整共识，作为第一版实现的唯一需求来源。
> 实现时如遇本文档未覆盖的细节，请优先选择「最简单、最贴近 pi 原生行为」的方案，并记录在文档末尾的「实现备注」中。

---

## 1. 项目概述

pi-webui 是一个基于 pi 的 Web UI，让用户通过浏览器使用 pi 编程助手。

核心架构：

```
浏览器 (React + TS)
   │  SSE 事件流 + POST 命令
   ▼
Go 后端 (单二进制)
   │  spawn pi --mode rpc
   ▼
pi 子进程 (一个浏览器会话 = 一个 pi 进程)
```

- **接入方式**：RPC 模式（`pi --mode rpc`，stdin/stdout JSONL 协议），不是 SDK 进程内嵌入。
- **后端语言**：Golang。
- **进程模型**：一对一——每个浏览器会话 spawn 一个独立 pi 子进程，会话关闭后 kill。
- **会话持久化**：使用 pi 默认会话目录（JSONL 文件），支持「新建会话」与「导入会话」，支持查询全局/指定目录的最近会话。
- **部署场景**：单用户，但有登录认证，监听 `0.0.0.0`（内网暴露）。
- **TLS**：webui 自身不做 TLS，由用户自配反向代理终结 TLS。

---

## 2. 架构决策清单（已确认）

| # | 决策点 | 结论 |
|---|--------|------|
| 1 | 接入方式 | RPC 子进程模式 |
| 2 | 后端 | Go |
| 3 | 进程生命周期 | 一个浏览器会话 = 一个 pi 子进程 |
| 4 | 持久化 | pi 默认会话目录（JSONL 文件） |
| 5 | 会话目录 | 默认 `~/.pi/agent/sessions/`（尊重 `PI_CODING_AGENT_SESSION_DIR`，config 可覆盖） |
| 6 | 用户模型 | 单用户 + 登录认证，监听 `0.0.0.0` |
| 7 | 认证 | 密码登录 + 会话 Cookie |
| 8 | TLS | webui 不做，用户自配反代 |
| 9 | 前后端通信 | SSE（服务端推流）+ POST（客户端发命令） |
| 10 | 前端 | React + TypeScript |
| 11 | 新建会话 cwd | 每个会话可选 cwd（spawn 时 `cmd.Dir`） |
| 12 | 后端重启恢复 | 惰性恢复：用户从最近会话列表点开，spawn 时 `--session <id>` |
| 13 | MVP 范围 | 见 §7 |
| 14 | 密码存储 | argon2id 哈希存 config，首次运行生成随机密码并打印，`set-password` 修改 |
| 15 | Cookie | HttpOnly + SameSite=Lax + Secure=auto + 24h 滑动过期，全部可配置 |
| 16 | 配置文件 | `~/.pi/agent/extensions/pi-webui/config.yaml`（YAML） |
| 17 | 会话列表标题 | `session_info` 名 → 首条 user 消息（截断 ~40 字）→ 时间戳 |
| 18 | 安装/分发 | 走 `pi install git:github.com/<you>/pi-webui`，由仓库内 pi 扩展负责 bootstrap |
| 19 | 下载时机 | 显式命令 `/pi-webui install` / `/pi-webui update`（扩展实现），pi 启动时不联网 |
| 20 | 裸命令 `pi-webui` | install 时 symlink 到 `~/.local/bin/pi-webui` |
| 21 | 命令面划分 | 见 §4 |
| 22 | pi spawn 参数 | 见 §5.6 |
| 23 | 日志方案 | 见 §5.7 |

---

## 3. 安装与分发

### 3.1 源码仓库结构（GitHub）

```
pi-webui/
├── extensions/
│   └── index.ts          # pi 扩展：bootstrap / launcher（见 §6）
├── web/                  # React + TS 前端源码（Vite）
├── cmd/pi-webui/         # Go 入口
├── internal/             # Go 逻辑（config/auth/rpc/sessionmgr/api/logging）
├── version.txt           # 版本号，如 "0.1.0"（扩展据此判断是否更新）
├── go.mod
├── Makefile              # make build: 前端 build → dist/ + go build
├── README.md
└── handoff.md            # 本文件（实现时作为需求文档）
```

### 3.2 用户安装流程

```bash
pi install git:github.com/<you>/pi-webui
# 进入 pi 交互模式，执行：
/pi-webui install
# 完成后：
pi-webui start          # 或 /pi-webui start
```

`/pi-webui install` 做的事（全部由扩展 TS 完成）：

1. 从 GitHub Releases 下载最新 `pi-webui-<version>-<os>-<arch>.tar.gz`
2. 解压到 `~/.pi/agent/extensions/pi-webui/`
3. 首次安装时生成 `config.yaml`（含随机登录密码）并在 pi 里打印密码
4. symlink `~/.local/bin/pi-webui` → 二进制（若 `~/.local/bin` 存在且在 PATH；否则提示用户）
5. 写 `version` 文件记录已装版本

**注意**：`pi install git:...` 本身只 clone 仓库到 `~/.pi/agent/git/github.com/<you>/pi-webui` 并登记，不会执行 index.ts。真正的下载发生在用户执行 `/pi-webui install` 时。

### 3.3 运行时安装目录

```
~/.pi/agent/extensions/pi-webui/
├── pi-webui              # Go 二进制
├── dist/                 # React 前端构建产物（独立存在，不 embed）
├── config.yaml           # 首次 install 时生成
├── version               # 已装版本号
└── logs/
    ├── webui.log
    └── sessions/
        └── <browserSessionId>.log   # 对应 pi 子进程 stderr
```

### 3.4 更新流程

用户执行 `/pi-webui update`：扩展对比仓库 `version.txt` 与已装 `version`，版本不同则重新下载解压覆盖。

---

## 4. 命令面划分

### 4.1 pi 扩展负责（`/pi-webui <cmd>` 直接处理，二进制不存在时也能跑）

| 命令 | 行为 |
|------|------|
| `install` | 下载二进制+dist → 生成 config → symlink → 打印随机密码 |
| `update` | 对比 `version.txt` 与已装版本，更新则重新下载 |
| `version` | 显示仓库版本 / 已装版本 / 安装路径 |
| 其他命令 | 若二进制未安装，提示「先 /pi-webui install」；已安装则透传给二进制 |

### 4.2 二进制负责（`pi-webui <cmd>` 与 `/pi-webui <cmd>` 等价）

| 命令 | 行为 |
|------|------|
| `start` | 前台运行 web 服务 |
| `stop` | 按 pid 文件停止运行实例 |
| `status` | 查看运行状态（pid 文件 + 端口健康检查） |
| `daemon install` | 安装 systemd **user** service |
| `daemon uninstall` | 卸载 systemd user service |
| `daemon start` | systemd 启动 |
| `daemon stop` | systemd 停止 |
| `daemon status` | systemd 状态 |
| `set-password` | 交互/参数方式设置或重置登录密码（argon2id） |
| `config` | 打印配置路径与当前生效配置 |

---

## 5. Go 后端设计

### 5.1 内部包结构建议

```
internal/
├── config/       # YAML 配置加载、默认值、首次生成（含随机密码）
├── auth/         # argon2id 密码校验、Cookie 签发/校验、中间件
├── rpc/          # pi --mode rpc 子进程管理、JSONL 分帧、命令/响应/事件
├── sessionmgr/   # 浏览器会话 → pi 进程映射、spawn、会话文件扫描与标题提取
├── api/          # HTTP handlers：POST 命令 + SSE 事件流 + 静态文件服务
└── logging/      # 文件日志（webui 自身 + pi stderr）
```

### 5.2 配置文件 `config.yaml`

```yaml
listen: "0.0.0.0:8080"      # 监听地址
sessionDir: ""               # 空 = 跟随 pi 默认（~/.pi/agent/sessions 或 PI_CODING_AGENT_SESSION_DIR）
distDir: ""                  # 空 = 二进制旁 dist/
piPath: ""                   # 空 = exec.LookPath("pi")
logsDir: ""                  # 空 = <install>/logs
logLevel: "info"             # debug|info|warn|error

auth:
  passwordHash: ""           # argon2id 编码串；首次运行自动生成随机密码并打印
  cookie:
    httpOnly: true
    sameSite: "lax"          # lax|strict|none
    secure: "auto"           # auto|true|false。auto = 请求带 X-Forwarded-Proto: https 时加 Secure
    maxAgeSeconds: 86400     # 24h
    sliding: true            # 滑动过期（每次请求续期）
```

生成顺序：config 不存在 → 生成上述默认值 + 随机密码（12 位左右，argon2id 哈希）→ 打印到 stdout。

### 5.3 HTTP API

所有 `/api/*` 除 `/api/login` 外都要求登录 Cookie。

**认证**

| 方法 | 路径 | 说明 |
|------|------|------|
| POST | `/api/login` | body `{password}`；成功签发 HttpOnly Cookie |
| POST | `/api/logout` | 清除 Cookie |
| GET | `/api/me` | 返回 `{authenticated: true}` |

**会话列表与创建/导入**

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/api/sessions?cwd=<dir>&limit=50` | 列出最近会话；`cwd` 为空=全局，否则只列该目录。返回 `[{sessionFile, sessionId, cwd, title, timestamp}]` |
| POST | `/api/sessions` | body `{cwd}`；新建浏览器会话：spawn `pi --mode rpc`（无 `--session`）。返回 `{browserSessionId, state}` |
| POST | `/api/sessions/import` | body `{sessionFile}`；导入/恢复：spawn `pi --mode rpc --session <piSessionId>`。返回 `{browserSessionId, state}` |
| POST | `/api/sessions/:bsid/close` | abort + kill pi 进程 + 清理映射 |

**会话内操作（转发给 pi RPC）**

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/api/sessions/:bsid/events` | SSE 事件流（见 §5.5） |
| POST | `/api/sessions/:bsid/command` | body 为任意 pi RPC 命令 JSON（如 `{type:"prompt",message:"hi"}`）；Go 转发给对应 pi 进程 stdin，并把该命令的 response 返回。若流式中发 prompt 且未带 `streamingBehavior`，由 pi 返回错误，前端展示 |
| GET | `/api/sessions/:bsid/messages` | 转发 `get_messages` 并返回 |
| GET | `/api/sessions/:bsid/state` | 转发 `get_state` + `get_session_stats` 合并返回 |

**静态文件**

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/` 及 `/assets/*` | 服务 `distDir` 下的前端构建产物；SPA fallback 到 `index.html` |

### 5.4 RPC 客户端要点

- spawn：`pi --mode rpc [--session <piSessionId>] --session-dir <resolvedSessionDir>`
  - `cmd.Dir` = 用户选择的 cwd
  - 环境变量完整继承父进程
  - pi 二进制路径：config `piPath`，为空则 `exec.LookPath("pi")`
- **JSONL 分帧**：只按 `\n` 切分，行尾可选 `\r` 要去掉。**不要用 `bufio.Scanner` 默认 token 上限**——工具输出可能很长，用 `bufio.Reader.ReadBytes('\n')` 或加大 buffer（建议 10MB+）。
- **stdout 是协议**，只能被 rpc 客户端消费，绝不写日志。
- 命令 JSON 带可选 `id`，response 带相同 `id` 做关联。
- 事件 JSON（stdout 中 `type` 不是 `"response"` 的行）原样转发给对应浏览器会话的 SSE 通道。
- 浏览器会话级别对 pi stdin 的写入要**串行化**（一个 goroutine 顺序写，避免并发写 stdin 交错）。

### 5.5 SSE 事件流

- `GET /api/sessions/:bsid/events`，`Content-Type: text/event-stream`
- 事件格式建议：`event: <pi事件type>` + `data: <原始JSON>`，前端按 `event` 字段分派。
- 额外发送自定义事件：
  - `event: hello, data: {browserSessionId, piState}`（连接建立时补发当前状态）
  - `event: process_exit, data: {code}`（pi 子进程退出时）
  - `event: error, data: {message}`（后端内部错误）
- 心跳：每 15s 发 `: ping` 注释行，防反代断连。

### 5.6 pi spawn 参数汇总

| 场景 | 参数 |
|------|------|
| 新建会话 | `pi --mode rpc --session-dir <dir>` + `cmd.Dir=<cwd>` |
| 恢复/导入 | `pi --mode rpc --session <piSessionId> --session-dir <dir>` + `cmd.Dir=<会话 header 中的 cwd>` |
| 通用 | 环境变量完整继承；二进制路径 `config.piPath` 或 `exec.LookPath("pi")` |

> 说明：1:1 进程模型下，**不使用** RPC 的 `new_session` / `switch_session` 命令。新会话与恢复会话都在 spawn 时用参数区分，避免 session 替换后要重新订阅事件的复杂问题。

### 5.7 会话文件扫描与标题提取

- session 文件路径格式：`<sessionDir>/--<cwd路径，/换成->--/<时间戳>_<uuid>.jsonl`
- 全局列出：遍历 `<sessionDir>/--*--/*.jsonl`
- 指定目录：只扫 `<sessionDir>/--<该cwd路径>--/*.jsonl`
- 读每个文件：
  - 第一行 header：`{"type":"session","id":...,"timestamp":...,"cwd":...}`
  - 标题提取顺序：最新 `session_info` 条目的 `name` → 首条 `type:"message"` 且 `message.role:"user"` 的文本（截断 ~40 字）→ 文件时间戳
- 按 header timestamp 倒序，限制返回条数（默认 50）

### 5.8 日志方案

- webui 自身日志：`<logsDir>/webui.log`（按大小轮转，10MB × 3 个文件；`start` 前台时可加 flag 同步打到终端）
- pi 子进程 stderr：`<logsDir>/sessions/<browserSessionId>.log`
- pi 子进程 stdout：**只进 RPC 协议处理，不落日志**
- 日志级别 config 可配

---

## 6. pi 扩展 `extensions/index.ts` 设计

### 6.1 基本原则

- factory **只注册命令，绝不联网、绝不起后台进程、绝不下载**（保证每次 pi 启动不被拖慢）。
- 下载/更新只发生在用户显式执行 `/pi-webui install` / `/pi-webui update` 时。

### 6.2 命令处理逻辑

```
/pi-webui <args...>
```

解析第一个参数：

- `install` / `update` / `version`：扩展内部处理（见 6.3）
- 其他命令：检查 `~/.pi/agent/extensions/pi-webui/pi-webui` 是否存在
  - 不存在：输出「请先执行 /pi-webui install」
  - 存在：`spawn` 该二进制并把剩余 args 透传
    - 对于 `start`、`daemon start` 等长时间运行的：用 `detached: true` + `stdio: "ignore"`（或继承终端输出）+ `unref()`，命令立即返回
    - 对于 `stop`、`status`、`set-password`、`config`、`daemon install` 等短命令：`stdio: "inherit"`，等待退出码

### 6.3 install/update 实现要点（TS）

- 使用 Node 内置：`node:child_process`、`node:fs`、`node:path`、`node:os`、`fetch`（Node 18+）。
- 平台识别：`os.platform()` + `os.arch()` → 选择对应 release 资产名。
- 下载 `https://github.com/<owner>/<repo>/releases/latest/download/pi-webui-<version>-<os>-<arch>.tar.gz`
  - 注意：`releases/latest/download/` 需要资产名不含版本号；否则用 `releases/tags/v<version>/download/...`。实现时选一种并固定，建议资产名**不带版本号**（`pi-webui-linux-amd64.tar.gz`）。
- 解压：优先调用系统 `tar -xzf`（Linux/macOS 都有）；Windows 不做第一版重点。
- 安装目录固定：`~/.pi/agent/extensions/pi-webui/`（用 `os.homedir()`；若 `PI_CODING_AGENT_DIR` 存在则其下 `extensions/pi-webui/`）。
- 生成 config：若 `config.yaml` 不存在，写入默认配置 + 随机密码哈希（argon2id 可用 Node 的 `crypto.scrypt` 简化实现，或调用已下载的二进制 `pi-webui set-password --generate` 来生成；**推荐后者**，保证哈希算法与 Go 侧一致）。
- symlink：`~/.local/bin/pi-webui` → 二进制；若 `~/.local/bin` 不存在或不在 PATH，打印提示。
- 写 `version` 文件。
- `update`：读取仓库内 `version.txt`（`path.join(__dirname, "..", "version.txt")` 即 clone 目录），与安装目录 `version` 对比。

### 6.4 扩展注册示例骨架

```typescript
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function (pi: ExtensionAPI) {
  pi.registerCommand("pi-webui", {
    description: "Install, update, start and manage the pi-webui service",
    handler: async (args, ctx) => {
      // 解析 args，按 §6.2 分发
    },
  });
}
```

---

## 7. 前端设计（React + TS）

### 7.1 页面

- `/login`：密码登录表单
- `/`：主界面
  - 左侧：会话列表（最近会话、新建、导入）
  - 中间：对话流（消息、thinking、工具调用卡片）
  - 底部：输入框（支持 Enter 发送、Shift+Enter 换行）
  - 顶部/侧边：模型切换、thinking level 切换、会话重命名

### 7.2 MVP 功能清单（已确认）

**必做：**

1. 登录页（密码 + cookie）
2. 新建会话（选 cwd）+ 导入会话（最近会话列表，全局/按目录）
3. 流式对话 + Markdown 渲染
4. 工具调用卡片 + bash 输出流式滚动
5. thinking 折叠块
6. 流式中可 abort、可输入 steering 消息
7. 模型切换 + thinking level 切换
8. 会话重命名

**v1 之后再做：**

- diff 视图（v1 先用 `<pre>` 文本展示 diff）
- 会话树 / 分支导航（`get_tree` / `navigateTree`）
- 图片粘贴上传
- token/cost 用量面板

### 7.3 事件处理（前端）

- SSE `message_update` 是**纯增量**（无累积快照），前端用 `contentIndex` + `delta` 组装流式消息；以 `message_end.message` 为权威结果。
- 工具卡：`tool_execution_start`（建卡）→ `tool_execution_update`（`partialResult` 是累积输出，直接替换展示）→ `tool_execution_end`（收尾）。
- 空闲状态：用 `agent_settled` 事件把 UI 切回「可输入」；`agent_end` 只表示底层一轮结束，后面可能还有重试/压缩/排队消息。
- 流式中发送 prompt：前端检测到正在流式，给 command 自动带 `streamingBehavior: "steer"`（用户普通输入）或 `"followUp"`（排队消息）。
- SSE 断开自动重连；重连后调用 `GET /api/sessions/:bsid/messages` 重建历史，避免丢事件。

### 7.4 技术选型

- Vite + React + TypeScript
- Markdown：`react-markdown` + `remark-gfm`
- 代码高亮：`shiki` 或 `prism`
- 状态管理：第一版用 React hooks + context，不引入重型库
- 样式：自选（CSS Modules / Tailwind 均可）

---

## 8. 实现顺序建议

1. **仓库骨架**：go.mod、web/ Vite 初始化、Makefile（`make build` = 前端 build 出 dist/ + go build）
2. **Go config + logging**：配置加载/默认值/首次生成、日志轮转
3. **Go auth**：argon2id、cookie 签发/校验、登录/登出/me 接口
4. **Go rpc 客户端**：spawn pi、JSONL 分帧、命令/响应关联、事件转发通道
5. **Go sessionmgr**：浏览器会话→进程映射、会话文件扫描与标题提取、close 清理
6. **Go api + SSE**：按 §5.3 实现全部 HTTP 接口
7. **前端 MVP**：登录 → 会话列表 → 聊天流（Markdown/thinking/工具卡）→ 模型与 thinking 切换 → steering/abort
8. **pi 扩展**：`extensions/index.ts` 的 install/update/version + 透传
9. **二进制命令面**：start/stop/status/daemon/set-password/config
10. **打包发布**：GitHub Actions 打 release 资产（`pi-webui-linux-amd64.tar.gz` 等，内含 `pi-webui` + `dist/`），写 README

---

## 9. 关键陷阱（实现时务必注意）

1. **pi stdout = RPC 协议**，绝不能当日志写文件或打印混入其他输出。
2. **JSONL 分帧只认 `\n`**，行尾 `\r` 去掉；不用 Node `readline` 那种会切 Unicode 行分隔符的读法；Go 注意 token 上限（工具输出可能几 MB）。
3. **`message_update` 是增量**，没有 `partial` 和累积 `message`；前端组装时以 `contentIndex` 区分多段文本/thinking/toolcall。
4. **`agent_end` ≠ 完全结束**，用 `agent_settled` 判断空闲。
5. **流式中发 prompt** 必须带 `streamingBehavior`，否则 pi 返回错误；前端封装层要自动处理。
6. **1:1 进程模型下不用 RPC 的 `new_session`/`switch_session`**；新建/恢复都通过 spawn 参数决定，避免 session 替换后重新订阅的问题。
7. **pi 子进程退出/崩溃**：Go 要清理映射、SSE 发 `process_exit`，前端提示「会话已断开，可重新导入恢复」（session 文件仍在磁盘）。
8. **Cookie `secure: auto`**：依赖反代传 `X-Forwarded-Proto`；README 要写明反代配置要求。
9. **扩展 factory 不得联网**：`/pi-webui install` 才下载，否则每次 pi 启动都会卡。
10. **`pi install git:...` 只 clone + 登记**，不执行 index.ts；README 要写清楚「install 完还需在 pi 里执行 `/pi-webui install`」。
11. **版本资产命名**：release 资产名不带版本号（`pi-webui-linux-amd64.tar.gz`），便于用 `releases/latest/download/` 拉取。
12. **密码生成**：config 首次生成的随机密码必须打印给用户（且只打印这一次）；`set-password` 可随时重置。

---

## 10. 未决小事（实现者可用默认值，需记录）

- 默认端口：`8080`
- 会话列表默认条数：50
- 随机密码长度：16 位
- 日志轮转：10MB × 3
- SSE 心跳：15s
- 浏览器会话 id：UUID v4（Go 生成）
- 反代配置示例：README 提供 nginx/caddy 两段配置

---

## 11. 实现备注

（实现者在开发过程中发现的偏差、补充决策记录在此。）

### 第一版实现备注（基于本 handoff 实现）

- 仓库结构适配：当前目录同时作为 pi 扩展目录和 Go 项目根；扩展入口为 `index.ts`（handoff 中为仓库根 `extensions/index.ts`）。
- 导入会话时，pi 对 bare session id 的 `--session <id>` 解析不稳定，改为传会话文件绝对路径（`--session <sessionFile>`）。
- 实际 pi RPC 的 `message_update` 事件形态为 `{usage, assistantMessageEvent:{type, contentIndex, delta, content}}`，前端同时兼容 handoff 中描述的简化形态 `{contentIndex, delta, kind}`。
- 新会话创建后，pi 在首条消息落盘前不会生成 session JSONL 文件；因此「最近会话」列表只包含磁盘上已有文件的会话。
- Cookie 签名密钥由 passwordHash 派生，修改密码会使已登录 Cookie 失效。
