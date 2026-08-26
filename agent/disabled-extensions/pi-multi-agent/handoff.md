# pi-multi-agent 第一版交接文档

## 1. 目标

实现一个轻量的 pi multi-agent 扩展。主代理通过**单一 `delegate` 工具**把任务委派给子代理；每个子代理运行在**独立的 `pi` 子进程**中，拥有隔离的上下文窗口。第一版必须覆盖四种执行形态：

| mode | 行为 |
|------|------|
| `single` | 一个代理执行一个任务 |
| `parallel` | 多个代理并发执行多个任务 |
| `chain` | 代理串行执行，后续任务可引用 `{previous}` 产出 |
| `discuss` | 多个代理围绕一个议题进行协调者居中的多轮讨论，主持人判定结束 |

## 2. 已确认决策记录

这些是已经和需求方确认的决策，实现时不要偏离；如有矛盾以本节为准。

1. **场景范围**：single / parallel / chain / discuss 四类全部在第一版覆盖。
2. **执行模型**：子进程模型。每个代理启动独立 `pi` 进程，崩溃互不影响。
3. **通信模型**：协调者居中。扩展自身充当协调者，代理之间不直接通信。
4. **写权限**：v1 **不在协调者层限制写**，不做“最多一个写代理”串行化。所有代理默认可用 pi 默认内置工具（含 write/edit）；主代理可在每次调用时通过 per-task `tools` 覆盖决定哪些代理有写权限。
5. **Agent 定义格式**：Markdown + YAML frontmatter，正文为 system prompt。
6. **模型解析顺序**：
   1. 调用时显式指定（per-task `model`）
   2. agent frontmatter 的 `model`
   3. 继承主会话当前模型
   4. `config.json` 中的 `fallbackModel`
7. **背景上下文**：任务 + 可选 `brief`（主代理写的简短背景/目标/约束）。chain/discuss 模式再把上一环节产出传入。
8. **讨论终止**：不做固定回合数；由主持人代理根据任务自带的终止条件（如“达成一致”“无新观点”）判定是否结束。
9. **讨论安全上限**：`maxRounds` + `maxTokens` + `maxCostUsd` + `maxDurationMs` 四者都要，**取最先触发者**强制停止并返回摘要；只在失控时触发。
10. **递归委派**：可配置 `maxDepth`，默认 `1`，即主代理可委派、子代理默认不能再委派。
11. **接口形态**：先只做单一 `delegate` 工具，通过 `mode` 参数区分四种形态。**不做**斜杠命令、**不做** workflow prompt 模板。
12. **Agent 发现**：用户级 `~/.pi/agent/agents/*.md` + 项目级 `.pi/agents/*.md`；同名时项目级覆盖用户级；运行项目级代理前弹确认。`agentScope` 参数：`user`（默认）/ `project` / `both`。
13. **默认工具集**：agent 未声明 `tools` 时给 pi 默认内置工具（read/bash/edit/write）；frontmatter `tools` 可裁剪；per-task `tools` 可覆盖。
14. **配置路径**：`~/.pi/agent/extensions/pi-multi-agent/config.json`，仅用户级。
15. **结果返回**：结构化小结（代理名、状态、usage 概览 + 最终输出）；完整 transcript 放 `details` 里供展开。

## 3. 目录结构

```
~/.pi/agent/extensions/pi-multi-agent/
├── handoff.md          # 本文件
├── index.ts            # 扩展入口：注册 delegate 工具，递归深度守卫
├── config.ts           # config.json 读取、默认值合并、配置类型
├── agents.ts           # agent 发现：user/project/both、frontmatter 解析
├── subprocess.ts       # pi 子进程调用、JSONL 事件解析、usage 统计、abort/超时
├── modes.ts            # single / parallel / chain / discuss 四种模式的协调逻辑
└── config.json         # 用户配置（可不存在，代码要有默认值）
```

## 4. 技术要点

### 4.1 依赖与导入

- 扩展用 TypeScript 编写，由 jiti 直接加载，无需编译。
- 可用导入：
  - `@earendil-works/pi-coding-agent`：`ExtensionAPI`、`ExtensionContext`、`getAgentDir`、`CONFIG_DIR_NAME`、`parseFrontmatter`、`truncateHead`、`withFileMutationQueue` 等。
  - `typebox`：`Type`
  - `@earendil-works/pi-ai`：`StringEnum`（字符串枚举必须用 `StringEnum`，不能用 `Type.Union/Type.Literal`）
  - Node 内置模块：`node:child_process`、`node:fs`、`node:os`、`node:path` 等。
- 参考官方示例：`examples/extensions/subagent/index.ts`（已在 pi 安装目录中）。

### 4.2 delegate 工具 schema（typebox）

单一工具名：`delegate`。

参数设计（第一版）：

```ts
const TaskItem = Type.Object({
  agent: Type.String({ description: "Agent name" }),
  task: Type.String({ description: "Task to delegate" }),
  brief: Type.Optional(Type.String({ description: "Optional background/context brief" })),
  cwd: Type.Optional(Type.String({ description: "Working directory" })),
  tools: Type.Optional(Type.Array(Type.String(), { description: "Override tools for this task" })),
  model: Type.Optional(Type.String({ description: "Override model for this task" })),
});

const ChainItem = Type.Object({
  agent: Type.String(),
  task: Type.String({ description: "Task; use {previous} to reference previous output" }),
  brief: Type.Optional(Type.String()),
  cwd: Type.Optional(Type.String()),
  tools: Type.Optional(Type.Array(Type.String())),
  model: Type.Optional(Type.String()),
});

const DiscussItem = Type.Object({
  agent: Type.String({ description: "Participating agent name" }),
  stance: Type.Optional(Type.String({ description: "Initial stance or role in discussion" })),
  brief: Type.Optional(Type.String()),
  tools: Type.Optional(Type.Array(Type.String())),
  model: Type.Optional(Type.String()),
});

const AgentScopeSchema = StringEnum(["user", "project", "both"] as const, {
  description: 'Agent directories. Default "user".',
  default: "user",
});
```

顶层参数：

- `mode`：`StringEnum(["single","parallel","chain","discuss"])`，必填。
- `agent` + `task`：single 模式。
- `tasks`：`Type.Array(TaskItem)`，parallel 模式。
- `chain`：`Type.Array(ChainItem)`，chain 模式。
- `topic`：string，discuss 模式。
- `agents`：`Type.Array(DiscussItem)`，discuss 模式。
- `termination`：string，discuss 模式的终止条件描述（如“直到各方达成一致或出现明确多数意见”）。
- `moderator`：可选 string，discuss 模式的主持人代理名；缺省使用内置主持人提示词 + 当前模型。
- `agentScope`：可选，默认 `"user"`。
- `confirmProjectAgents`：可选 boolean，默认 `true`。

### 4.3 子进程调用

每个任务启动一个 `pi` 子进程：

```ts
const args = ["--mode", "json", "-p", "--no-session"];
if (model) args.push("--model", model);
if (tools && tools.length) args.push("--tools", tools.join(","));
// 如果 agent system prompt 非空：
//   写入临时文件（0600），args.push("--append-system-prompt", tmpFile)
args.push(`Task: ${task}`);
```

- `spawn(command, args, { cwd: taskCwd ?? ctx.cwd, shell: false, stdio: ["ignore","pipe","pipe"], env: {...process.env, PI_MULTI_AGENT_DEPTH: String(depth + 1)} })`
- 解析 `stdout`：按行读取 JSONL。
  - `message_end` 且 `event.message` 存在：收集 assistant 消息；累加 `usage.input/output/cacheRead/cacheWrite/cost.total/totalTokens`；记录 `model`、`stopReason`、`errorMessage`；用 `onUpdate` 推流当前最终文本。
  - `tool_result_end` 且 `event.message` 存在：收集 toolResult 消息。
- `stderr` 持续收集，失败时用于诊断。
- `close` 后 resolve exit code；`error` 事件 resolve 1。
- **Abort**：把工具 `execute` 收到的 `signal` 传入；abort 时 `SIGTERM`，5 秒后 `SIGKILL`。abort 后该任务按失败处理。
- **超时**：`perTaskTimeoutMs`，超时后 kill 并返回失败。
- **输出截断**：每个任务模型可见内容上限 `perTaskOutputCapBytes`（默认 50KB）。用 `truncateHead` 之类的工具；完整内容保留在 `details`。

子进程命令解析参考官方示例 `getPiInvocation()`：

- 若 `process.argv[1]` 存在且不是 bun 虚拟脚本，用 `process.execPath` + 当前脚本路径。
- 否则如果运行时是 node/bun 通用运行时，用 `pi` 命令。
- 否则用 `process.execPath` 直接执行。

### 4.4 递归深度守卫

- 配置 `maxDepth` 默认 `1`。
- 扩展工厂里读 `process.env.PI_MULTI_AGENT_DEPTH`（整数，缺省 `0`）。
- 若 `depth >= maxDepth`，**不注册** `delegate` 工具（可只注册一个轻量说明工具或直接不注册）。
- 子进程 spawn 时传 `PI_MULTI_AGENT_DEPTH = depth + 1`。

### 4.5 Agent 发现

`agents.ts` 实现 `discoverAgents(cwd, scope)`：

- 用户目录：`path.join(getAgentDir(), "agents")`。
- 项目目录：从 `cwd` 向上找最近的 `<dir>/${CONFIG_DIR_NAME}/agents`（即 `.pi/agents`）。
- 只读 `*.md` 文件（支持 symlink）。
- frontmatter 字段：
  - `name`：必填，代理名。
  - `description`：必填，用途描述。
  - `tools`：可选，逗号分隔字符串，如 `"read, grep, find, ls"`。
  - `model`：可选。
- 正文 body = system prompt。
- `agentScope: "both"` 时项目级覆盖同名用户级。
- 缺少 `name` 或 `description` 的文件跳过。

### 4.6 config.json

路径：`~/.pi/agent/extensions/pi-multi-agent/config.json`。文件不存在时使用全部默认值。

```json
{
  "fallbackModel": "anthropic/claude-haiku-4-5",
  "maxDepth": 1,
  "maxParallelTasks": 8,
  "maxConcurrency": 4,
  "perTaskTimeoutMs": 600000,
  "perTaskOutputCapBytes": 51200,
  "discussion": {
    "maxRounds": 30,
    "maxTokens": 200000,
    "maxCostUsd": 5,
    "maxDurationMs": 600000
  }
}
```

说明：

- `maxParallelTasks`：parallel 模式最多任务数，超过直接返回错误。
- `maxConcurrency`：parallel 与 discuss 每轮的并发上限。
- `perTaskTimeoutMs`：单任务超时。
- `perTaskOutputCapBytes`：单任务返回主代理的模型可见输出上限。
- `discussion.*`：讨论模式安全上限，取最先触发。

### 4.7 模型解析

对每个任务：

1. task `model` 显式指定 → 用它。
2. agent frontmatter `model` → 用它。
3. 主会话当前模型：从 `ctx.model` 取 `provider/modelId` 形式传给 `--model`。
4. `config.json` 的 `fallbackModel`。

### 4.8 上下文传递

- single：`Task: ${task}`；有 `brief` 时在 task 前加一段背景。
- parallel：每个任务同上。
- chain：第 i 步把 `step.task` 中的 `{previous}` 替换为第 i-1 步的最终文本；brief 不变。
- discuss：每个 agent 的任务 = 议题 + 该 agent 的初始 stance/brief + 上一轮各位的发言记录（由协调者构造）。

### 4.9 四种模式行为

#### single

1. 校验恰好一个 mode。
2. 发现 agents。
3. 若请求的 agent 来自项目级且 `confirmProjectAgents` 为 true 且 `ctx.hasUI`，弹 `ctx.ui.confirm`。
4. 找不到 agent → 返回错误文本，附可用 agent 列表。
5. 跑一个子进程，onUpdate 推流。
6. 成功：返回「结构化小结 + 最终输出」。
7. 失败（exitCode != 0 或 stopReason 为 error/aborted）：返回 `isError: true` 的错误内容，附 stderr/errorMessage。

#### parallel

1. 任务数超过 `maxParallelTasks` → 返回错误。
2. 用 `mapWithConcurrencyLimit`（并发 `maxConcurrency`）并行跑。
3. v1 **不做写串行化**；所有任务同等对待。
4. 聚合结果：`### [agent] completed/failed` + 每任务截断后的最终输出；失败附诊断。
5. details 保存完整 results。

#### chain

1. 串行执行。
2. `{previous}` 替换为前一步最终文本。
3. 任一步失败立即停止，返回哪一步、哪个代理、错误信息。

#### discuss

1. 参与者至少 2 个。
2. 每轮：并发运行所有参与者，每个代理拿到「议题 + 自己 stance/brief + 上轮讨论记录」。
3. 每轮结束后运行主持人：
   - 若指定了 `moderator` 代理且存在，用该代理。
   - 否则用内置主持人提示词 + 当前模型跑一个短 `pi` 子进程。
   - 主持人输入：议题、终止条件、本轮各位发言。
   - 主持人输出结构化 JSON：`{ "done": boolean, "summary": string, "verdict": string }`。
   - 若主持人未返回合法 JSON，按未结束处理，继续下一轮。
4. 终止：`done === true`，或达到 `discussion.maxRounds` / `maxTokens` / `maxCostUsd` / `maxDurationMs` 任一上限。
5. 返回主持人最后 summary/verdict；details 保存每轮发言和 usage。

### 4.10 结果返回格式

模型可见内容示例（成功）：

```
## delegate/single

agent: worker (user)
status: completed
usage: 3 turns ↑12000 ↓800 $0.1234 ctx:45000 claude-sonnet-4-5

--- final output ---
（子代理最终文本）
```

失败：

```
## delegate/single

agent: worker (user)
status: failed (error)
error: ...

--- stderr/output ---
...
```

parallel/chain/discuss 用类似的紧凑结构，先给总体状态再给各任务输出。完整消息流、逐任务 usage 放 `details`。

### 4.11 工具执行签名

```ts
async execute(_toolCallId, params, signal, onUpdate, ctx) {
  // ctx.cwd, ctx.model, ctx.hasUI, ctx.ui.confirm 可用
  // 返回 { content: [{type:"text", text}], details, isError? }
}
```

- 错误要显式 `return { ..., isError: true }` 或 `throw`；返回普通对象不会标记错误。
- 输出必须截断，防止撑爆主代理上下文。

### 4.12 项目级代理确认

运行前检查被请求的 agent 是否来自项目级（source === "project"）。若来自项目级且未确认：

```ts
const ok = await ctx.ui.confirm(
  "Run project-local agents?",
  `Agents: ...\nSource: ...\n\nProject agents are repo-controlled. Only continue for trusted repositories.`,
);
if (!ok) return { content: [{type:"text", text: "Canceled: project-local agents not approved."}], details: ... };
```

## 5. 非目标（第一版不做）

- 不做斜杠命令和 workflow prompt 模板。
- 不做进程内 `createAgentSession` 会话。
- 不做写串行化/写锁。
- 不做代理间直连通信。
- 不做自定义 TUI 渲染（用默认工具渲染）。
- 不持久化子代理会话文件。
- 不自动执行 git worktree 或文件锁。

## 6. 实现顺序建议

1. `config.ts`：默认配置 + 读取合并。
2. `agents.ts`：agent 发现 + frontmatter 解析。
3. `subprocess.ts`：单任务子进程执行 + JSONL 解析 + usage + abort + 超时 + 截断。
4. `modes.ts`：single → parallel → chain → discuss。
5. `index.ts`：注册 `delegate` 工具，接递归守卫。
6. 手测验收。

## 7. 验收清单

实现完成后，逐项在本地验证：

- [ ] 无 `config.json` 时扩展可加载，使用默认值。
- [ ] `agentScope` 默认 `user`；用户级 agent 可被发现。
- [ ] single：主代理说“Use delegate to have scout find auth code”能正确触发并返回结构化结果。
- [ ] single：未知 agent 返回错误和可用列表。
- [ ] parallel：3 个任务并发执行，`maxConcurrency` 生效，结果聚合正确。
- [ ] parallel：超过 `maxParallelTasks` 返回错误。
- [ ] chain：`{previous}` 被正确替换；中途失败停止并报告步骤号。
- [ ] discuss：两个 agent 讨论，主持人能按终止条件结束；达到任一安全上限时强制停止并返回摘要。
- [ ] 递归：默认 `maxDepth=1` 时，子代理进程不注册 `delegate`。
- [ ] 模型：per-task model 覆盖 frontmatter model；都缺省时继承主会话模型；不可用时 fallback。
- [ ] 项目级代理：`.pi/agents` 中的代理需确认；拒绝后不执行。
- [ ] 写权限：agent 声明 `tools` 可裁剪写工具；per-task `tools` 可覆盖。
- [ ] 超时：`perTaskTimeoutMs` 触发后返回失败。
- [ ] Abort：主会话 Ctrl+C 能终止子进程。
- [ ] 输出截断：单任务模型可见输出不超过 `perTaskOutputCapBytes`。
