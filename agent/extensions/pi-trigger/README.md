# pi-trigger

把**事件驱动**的守护进程交给 systemd user 托管，并让它们能触发 pi-scheduler 的 job。

```
[外部事件源]                      ~/.pi/trigger/<name>/trigger.yaml  ← 你只写这个
      │                                          │
      │ 事件到达                                  │ pi-trigger sync 生成并 enable
      ▼                                          ▼
[守护进程(任意语言)] ──$PI_TRIGGER_EMIT──▶ [pi-trigger-bin emit] ──▶ [pi-scheduler run-job] ──▶ pi -p
```

## 职责边界

pi-scheduler 和 pi-trigger 是**两个独立的扩展**，各管一段，唯一接触面是两条 CLI：

| | pi-scheduler | pi-trigger |
|---|---|---|
| 关心 | 时间 / 外部调用 → job | 事件 → 调用 |
| 不知道 | 「谁在监听」「事件是什么」 | job 的 prompt / model / 超时怎么写 |
| 数据 | `~/.pi/scheduler/jobs/*.md` | `~/.pi/trigger/<name>/trigger.yaml` |
| 单元前缀 | `pi-scheduler-` | `pi-trigger-` |

硬规则：

1. pi-trigger 不读 job 定义、不写 `runs.jsonl`；
2. pi-scheduler 不认识 trigger / event / context 这些词；
3. 接口只有 `bin/emit`（trigger 侧调用）和 `bin/run-job`（scheduler 侧提供）。

所以你可以**只用其中一个**：job 的 `schedule:` 留空就是一个纯「被外部触发」的 job；
trigger 也可以不配 pi-trigger、自己 exec `run-job`（见文末）。

## 目录布局

```
~/.pi/trigger/
├── <name>/
│   ├── trigger.yaml        # 声明文件（唯一真源，必需）
│   ├── watcher.py          # 你的实现，任意语言
│   ├── env                 # 可选：EnvironmentFile（KEY=value，每行一条）
│   └── state/              # 你的运行时数据（cookie / 日志，随意）
└── ... 
```

生成产物（**不要手改**，sync 会覆盖）：

```
~/.config/systemd/user/pi-trigger-<name>.service
```

## trigger.yaml

```yaml
description: 监听 runwu 论坛新回复/@/私信，事件到达即触发回复   # 可选

service:
  exec: /usr/bin/python3 /home/sang/.pi/trigger/runwu-watcher/watcher.py  # 必需，原样作为 ExecStart
  cwd: .                  # 可选，相对 trigger 目录；默认 = trigger 目录
  restart: on-failure     # 可选，no | on-failure | always；默认 on-failure
  restartSec: 5           # 可选，默认 5
  stopTimeoutSec: 30      # 可选，默认 30
  killMode: control-group # 可选，control-group | process | mixed | none；默认 control-group
  memoryMax: 2G           # 可选，如 512M / 2G
  after: [network-online.target]   # 可选，追加 After=

emit:
  job: runwu-reply        # 必需：事件触发的目标 pi-scheduler job 名
  context: [topic_id, post_number, user, topic_title, topic_url, notification_id]  # 可选，仅作文档/校验

env:                      # 可选：额外注入守护进程的环境变量
  RW_LOG_LEVEL: info
```

**一个 trigger 只 emit 一个 job。** 要触发多个，就写多个 trigger（或让 job 自己决定做什么）。

声明有误时 sync 会报错并跳过该 trigger（不会生成半成品 unit）；`/pi-trigger:list` 会列出错在哪。

## 守护进程契约

pi-trigger 在 unit 里注入这些变量，你的进程直接读：

| 变量 | 含义 |
|---|---|
| `PI_TRIGGER_EMIT` | **emit 入口的绝对路径**。收到事件就调它。 |
| `PI_TRIGGER_JOB` | 本次要触发的 job 名（= `emit.job`，方便不写死） |
| `PI_TRIGGER_NAME` | trigger 名 |
| `PI_TRIGGER_DIR` | trigger 目录 |
| `PI_SCHEDULER_DIR` | pi-scheduler 数据目录（一般不用碰） |
| `PATH` | 已含 emit 目录 + node/pi 的 bin 目录 + 系统目录 |

触发一次事件：

```bash
"$PI_TRIGGER_EMIT" --context-json '{"topic_id":123,"user":"alice","topic_url":"..."}'
# 或落盘再传（大 payload / 避免超长 argv）：
"$PI_TRIGGER_EMIT" --context-file /tmp/event.json
# 或从 stdin（注意：pi 的 stdin 在执行时会被占用，emit 这里没有这个问题）：
echo '{"topic_id":123}' | "$PI_TRIGGER_EMIT" --context-file -
```

### emit 的退出码

| 码 | 含义 | 你该怎么做 |
|---|---|---|
| 0 | 事件已交给 job（job 跑完了） | 正常 |
| **75** | **job 正在跑，本次事件被跳过**（EX_TEMPFAIL） | 可选：稍后重试，或什么都不做（定时保底会兜住） |
| 2 | 参数 / context JSON 非法 | 你的 bug，修 |
| 其他 | run-job 的退出码（job 失败 / 超时） | 记日志；重试由你自己决定 |

> **并发语义**：同一个 job 不允许重叠。run-job 拿不到锁就**跳过**并返回 75。
> 这是有意的 —— 事件和定时扫描共用同一个 job，谁先跑谁干活，后来者不排队。
> 想做防抖（比如「同话题 10 分钟内不重复触发」），在**你的守护进程里**实现
> （runwu-watcher 就是这么做的，见 `watcher.py` 的 `Emitter`）。

## 上下文怎么进 prompt

`--context-json` 的对象会渲染进 job 的 prompt 正文，规则（`bin/render-prompt.py`）：

1. 正文含 `{{context}}` → 整块替换成 `- key: value` 多行；
2. 否则含 `{{key}}` → 逐个替换该 key 的值；
3. 两个都没有 → 在正文最前插入「## 本次触发上下文」小节；
4. **context 为空 `{}` 时不注入任何东西**，正文原样执行。

第 4 条是关键：同一个 job 文件既能被**事件触发**（带上下文，精准处理那一条），
又能被**定时器触发**（无上下文，全量扫描），不用维护两份 prompt。

## 命令

| 命令 | 作用 |
|---|---|
| `/pi-trigger:sync` | 重新生成并 enable 所有 unit（改了 trigger.yaml 后跑） |
| `/pi-trigger:list` | 列出所有 trigger + systemd 状态 + emit 目标 |
| `/pi-trigger:start <name>` | enable --now |
| `/pi-trigger:stop <name>` | stop（保留 enable） |
| `/pi-trigger:restart <name>` | 先 sync 再 restart |
| `/pi-trigger:status <name>` | systemctl status |
| `/pi-trigger:logs <name>` | journalctl 最近 80 行 |
| `/pi-trigger:emit <name>` | **调试**：伪造一次事件，看 job 是否被正确触发（会真跑 pi，消耗 token） |
| `/pi-trigger:panel-close` | 关闭所有 pi-trigger 输出面板 |

agent 可调用 `pi_trigger_list`（只读）。

### 输出面板怎么关

`sync` / `list` / `status` / `logs` / `emit` 的输出都开在一个临时浮层面板里，
不写进对话记录、关掉就没了：

- `Esc`（或 `q` / `Enter`）关闭，`↑↓` / `PgUp` / `PgDn` / `Home` / `End` 滚动
- `emit` 运行中按 `x` 可以直接终止它
- `alt+w` 一键关掉 pi-scheduler + pi-trigger 的所有面板（`/pi-trigger:panel-close` 同效）

RPC 模式没有 overlay，会退回旧的 `setWidget` 显示，同样可以关掉。

## 不用 pi-trigger 也行

`bin/emit` 只是一层转发，自己 exec 同样有效：

```bash
~/.pi/agent/extensions/pi-scheduler/bin/run-job <job> \
  --trigger external --source my-thing \
  --context-file /tmp/event.json
```

`run-job` 的完整参数：

```
run-job <job> [--trigger timer|manual|external] [--source <text>]
              [--context-json <json> | --context-file <path>]
              [--wait]           # 忙时等待锁（默认：跳过 + 退出码 75）
```

`--trigger` / `--source` 只影响 `~/.pi/scheduler/state/runs.jsonl` 里的记录，便于事后分清
「这次是谁触发的」。

## 与 pi-scheduler 的配合：空 schedule

job 的 `schedule:` 留空 = **不装 timer**，但 job 依然有效：

```
jobs/runwu-reply.md
---
schedule:            # ← 留空：只由 pi-trigger / 手动触发
cwd: ...
---
...prompt...
```

定时器和事件触发可以并存（`schedule: "*:05"` + 一个 emit 它的 trigger），
这样事件负责实时、定时负责保底，共用同一份 prompt。
