# pi-session-sync

外部进程（例如 paseo 拉起的另一个 `pi`）继续当前会话、向同一个会话文件追加写入时，让本 TUI 自动跟随刷新，无需手动敲 `/sync`。

## 启用（一次即可，之后全程自动）

任选其一：

```bash
# 方式 A：启动时带上初始命令（推荐，可写进 shell alias）
pi -c "/sync-arm"

# 方式 B：会话里输入一次
/sync-arm
```

建议 alias（写进 `~/.zshrc` / `~/.bashrc`）：

```bash
alias pi='pi -c "/sync-arm"'
```

启用后，footer 状态栏会显示 `🔁 会话自动同步已就绪`。之后每当检测到外部写入，会自动：

1. 状态变为 `⏳ 外部正在写入会话…`（可配置此时禁用输入框）；
2. 等当前 pi 空闲、编辑框无草稿后，自动 `🔄 正在同步会话…` 并从磁盘重载；
3. 重载后回到就绪态，接着外部进程的最新进度继续。

## 可选配置

复制 `config.example.json` 为 `config.json`（与本文件同级）：

```json
{
  "lockInputDuringExternalWrite": false,
  "debounceMs": 600
}
```

- `lockInputDuringExternalWrite: true` —— 检测到外部写入期间吞掉键盘输入（避免刷新时丢失你正在打的字）。
- `debounceMs` —— 文件事件防抖；外部一次回合会追加多行，适当防抖可减少刷新次数。

## 注意

- **交替写**：本扩展只做"跟随刷新"，无法合并两个进程的并发写入。请保持"外部写完 → 这边刷新 → 你再输入"的节奏，不要两边同时写（否则会话树会分叉）。
- **手动切换会话会解除自动同步**：如果你自己执行 `/resume`、`/new`、`/fork`，旧命令上下文会失效，需要在新会话里再执行一次 `/sync-arm`（或重启时用 alias）。
- 该扩展只在 TUI 模式生效（RPC/print 模式忽略）。
