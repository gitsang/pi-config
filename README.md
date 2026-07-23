# pi-config

My configuration for the [pi](https://github.com/earendil-works/pi-coding-agent) coding agent.

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](./LICENSE)

This repo tracks everything under `~/.pi/` that is worth versioning: UI/agent
settings, a multi-model provider definition, custom keybindings, a vision
subagent, eight hand-written TypeScript extensions, and the npm packages that
power subagents / workflows / checkpoints. Secrets, sessions, and binaries are
git-ignored.

---

## Repository layout

```
~/.pi/
├── README.md                 ← this file
├── LICENSE
├── .gitignore
├── agent/                    ← pi agent home (this is what `git clone` targets)
│   ├── settings.json         ← UI, default provider/model, packages, subagents
│   ├── models.json           ← custom providers + model catalog (the gateway)
│   ├── keybindings.json      ← custom key bindings
│   ├── auth.json             ← SECRETS (git-ignored)
│   ├── trust.json            ← trusted-project list (git-ignored)
│   ├── agents/
│   │   └── multimodal-looker.md   ← custom vision subagent definition
│   ├── extensions/           ← 8 local TypeScript extensions (see below)
│   ├── npm/                  ← installed pi packages (git-ignored except manifests)
│   ├── bin/                  ← auto-downloaded helpers e.g. fd (git-ignored)
│   ├── checkpoints/          ← file checkpoints (git-ignored)
│   └── sessions/             ← conversation history (git-ignored)
└── workflows/
    ├── settings.json         ← workflow runner settings
    └── projects/             ← workflow run artifacts (git-ignored)
```

### What's tracked vs. ignored

| Tracked | Why |
|---|---|
| `agent/settings.json`, `models.json`, `keybindings.json` | core config |
| `agent/agents/*.md` | custom subagent definitions |
| `agent/extensions/**` (code + `config.json` + `config.example.json`) | local extensions |
| `agent/npm/.gitignore`, `workflows/.gitignore` | keep dirs in git |

| Ignored (see `.gitignore`) | Reason |
|---|---|
| `agent/auth.json` | API keys / credentials |
| `agent/trust.json` | per-machine trusted-project list |
| `agent/sessions/`, `agent/checkpoints/` | history; may leak sensitive data |
| `agent/bin/` | auto-downloaded binaries (`fd`…), re-fetched by pi |
| `agent/npm/node_modules/`, `package-lock.json` | restored via `npm install` |
| `workflows/projects/`, `.omx`, `.worktrees` | runtime state |

---

## `agent/settings.json` — UI, defaults, packages, subagents

Key fields:

| Field | Value | Meaning |
|---|---|---|
| `theme` | `dark` | TUI theme |
| `defaultProvider` | `saigw` | default provider (see `models.json`) |
| `defaultModel` | `glm-5.2` | default model = `saigw/glm-5.2` |
| `defaultThinkingLevel` | `high` | default reasoning effort |
| `hideThinkingBlock` | `false` | render thinking blocks inline |
| `lastChangelogVersion` | `0.81.1` | suppresses changelog since this version |

### `packages` — npm pi packages enabled

```jsonc
"packages": [
  "npm:pi-subagents",
  "npm:pi-btw",
  "npm:@pi-plugins/checkpoint",
  "npm:@quintinshaw/pi-dynamic-workflows"
]
```

See the **npm packages** section below for what each does.

### `subagents` — per-role model routing

All subagents default to `saigw/glm-5.2`. Roles that are cheaper / more
read-heavy (scout, researcher, reviewer, context-builder) are routed to the
fast `deepseek-v4-flash` with `minimax-m3` as fallback; heavier reasoning
roles (planner, worker, oracle, delegate) stay on `glm-5.2` with
`kimi-k2.7-code` / `qwen3.7-max` as fallbacks. `worker` is marked a `writer`
and `reviewer` is `read-only` for acceptance. `multimodal-looker` uses
`kimi-k2.7-code`.

| Role | Model | Fallbacks | Thinking |
|---|---|---|---|
| (default) | `saigw/glm-5.2` | — | — |
| `scout` | `saigw/deepseek-v4-flash` | minimax-m3, deepseek-v4-flash | low |
| `researcher` | `saigw/deepseek-v4-flash` | minimax-m3, deepseek-v4-flash | medium |
| `planner` | `saigw/glm-5.2` | kimi-k2.7-code, qwen3.7-max | high |
| `worker` | `saigw/glm-5.2` | kimi-k2.7-code, qwen3.7-max | medium (`writer`) |
| `reviewer` | `saigw/deepseek-v4-flash` | minimax-m3, deepseek-v4-flash | medium (`read-only`) |
| `context-builder` | `saigw/deepseek-v4-flash` | minimax-m3, deepseek-v4-flash | medium |
| `oracle` | `saigw/glm-5.2` | kimi-k2.7-code, qwen3.7-max | high |
| `delegate` | `saigw/glm-5.2` | kimi-k2.7-code, qwen3.7-max | — |
| `multimodal-looker` | `saigw/kimi-k2.7-code` | minimax-m3 | — |

---

## `agent/models.json` — providers & model catalog

Three providers all point at the same private gateway
(`https://aigw.cn.c8g.top`), differing by **API surface**. The API key is read
at runtime from `auth.json` via a `jq` expression (never committed). Adjust
`baseUrl` and the `apiKey` expression to point at your own gateway/provider
before use.

### `saigw-anthropic` — Anthropic Messages API

| Model | Context | Max out | Input | Notes |
|---|---|---|---|---|
| `claude-sonnet-5` | 1M | 131k | text+image | `forceAdaptiveThinking` |

### `saigw-openai` — OpenAI Responses API

| Model | Context | Max out | Input | Cost in / out (per 1M) |
|---|---|---|---|---|
| `gpt-5.4-mini` | 400k | 128k | text+image | $0.75 / $4.5 |
| `gpt-5.6-sol` | 361k | 128k | text+image | $5 / $30 (tiered above 272k) |
| `gpt-5.6-terra` | 361k | 128k | text+image | $2.5 / $15 (tiered) |
| `gpt-5.6-luna` | 361k | 128k | text+image | $1 / $6 (tiered) |

All are reasoning models with an explicit `thinkingLevelMap`
(low/medium/high/xhigh[/max]). This provider is the one `pi-service-tier`
injects `service_tier` into (see extensions).

### `saigw` — OpenAI Chat Completions API (the default provider)

The default provider (`defaultProvider: saigw`) — a broad catalog of Chinese &
frontier models, all routed through the gateway as OpenAI-completions. Each
model carries `compat` flags (thinking format, store/developer-role support,
etc.) and per-million-token `cost`.

| Model | Context | Reasoning | Cost in / out (per 1M) |
|---|---|---|---|
| `deepseek-v4-pro` | 1M | yes (deepseek fmt) | $0.435 / $0.87 |
| `deepseek-v4-flash` | 1M | yes | $0.14 / $0.28 |
| `glm-5.2` ← **default** | 1M | yes (zai fmt) | $1.4 / $4.4 |
| `grok-4.5` | 500k | yes | $2 / $6 |
| `kimi-k3` | 1M | no | $3 / $15 |
| `kimi-k2.7-code` | 256k | yes | $0.95 / $4 |
| `qwen3.7-max` | 1M | yes | $2.5 / $7.5 |
| `mimo-v2.5-pro` | 1M | yes | $1 / $3 |
| `minimax-m3` | 512k | yes | $0.3 / $1.2 |
| `ratatosk` | 128k | yes | $0 / $0 (free) |

> Pricing follows each provider's convention (USD per million tokens here).
> `cacheRead`/`cacheWrite` rates are set where the gateway reports them.

---

## `agent/keybindings.json` — custom keys

| Binding | Keys | Why |
|---|---|---|
| `tui.input.newLine` | `enter`, `shift+enter`, `ctrl+j` | Enter inserts a newline (multi-line editing) |
| `tui.input.submit` | `ctrl+enter`, `ctrl+s` | submit the prompt |
| `app.model.cycleForward` | `alt+m` | cycle to next model |
| `app.model.cycleBackward` | `alt+shift+m` | cycle to previous model |
| `app.session.togglePath` | `alt+p` | toggle path display |
| `app.models.toggleProvider` | `alt+p` | toggle provider |

> Model cycling is bound to **Alt+M**, not Ctrl+M: Ctrl+M and Enter send the
> same byte (`0x0D`) in most terminals, so Ctrl+M would cycle the model on
> every Enter. This also frees **Ctrl+P** for the `pi-command-panel` extension.

---

## `agent/agents/multimodal-looker.md` — custom vision subagent

A fresh-context, read-only vision specialist. It `read`s images (png/jpg/gif/
webp/bmp) and returns precise descriptions of UI elements, text, layout,
errors, and state — related to the orchestrator's task. It does not edit files.
Registered as a subagent role (see the `multimodal-looker` row in the subagent
table above).

---

## `agent/extensions/` — local TypeScript extensions

Eight hand-written extensions. pi auto-discovers any `index.ts` under
`agent/extensions/*/`. Each is config-driven (global `<ext-dir>/config.json`,
project `<cwd>/.pi/<name>.json` for trusted projects); `config.example.json`
ships the full template.

| Extension | Purpose |
|---|---|
| **pi-statusline** | A dense, config-driven 4-line Tokyo Night footer: title, cwd, git branch, model, thinking level, service tier, token usage (in/out/cache read/write/cache-hit), cost, context bar+%, TTFT, TPS, and today's tokens/cost. Cross-extension via `ext-status` (other extensions publish values it renders). `/statusline` toggles/reloads, `/statusline-reset` clears TTFT/TPS history. |
| **pi-command-panel** | Ctrl+P fuzzy command palette overlay — filter across built-in commands, extension commands, prompt templates, and skills; Enter runs immediately via pi's unified dispatcher (draft text saved/restored). |
| **pi-git** | Fast git ops via a small model. `/pi-git:commit`, `/pi-git:commit-and-push`, `/pi-git <prompt>` agentic loop; also exposes a `pi_git` LLM tool. Hard-blocks destructive commands; write/push need confirm in the command path. Current config uses `saigw/deepseek-v4-flash`, previews off, push/write confirmed, `Co-Authored-By: Pi` trailer. See `extensions/pi-git/README.md`. |
| **pi-metrics** | Persistent local usage metrics (tokens + cost + prompt/session counts per day/month/all-time) in an append-only `events.jsonl`. Publishes `metrics-today-tokens`/`-cost` etc. for the statusline; `/metrics` prints a summary. |
| **pi-auto-title** | Auto-generates short session titles after the first Q&A, regenerates after compaction, and refreshes every 25 turns (current config). `/auto-title` regen/off/on/status. |
| **pi-model-lock** | Prevents in-session model/thinking switches from overwriting the global `defaultModel`/`defaultProvider`/`defaultThinkingLevel` in `settings.json` (restores the snapshot taken at session start). `enable: true`. `/model-lock` status, `/model-save` persists current as new default. |
| **pi-service-tier** | Injects OpenAI `service_tier` into request payloads (models.json has no field for it). Current config marks `saigw-openai` as tier-capable, defaulting to `priority` with `auto/default/flex/priority` allowed. |
| **pi-tmux-title** | Mirrors pi's generation state onto the tmux window tab: idle → prefix glyph, generating → spinner, done → check badge (clears when you refocus). No-op outside tmux / TUI mode. |

### How they fit together

`pi-statusline` is the render surface; `pi-metrics` (today's usage) and
`pi-service-tier` (current tier) publish into it via `ctx.ui.setStatus(...)`
+ the `ext-status` source — no direct imports between extensions. `pi-git`
provides the `pi_git` tool the main agent uses to delegate commits.
`pi-command-panel`, `pi-auto-title`, `pi-model-lock`, and `pi-tmux-title` are
independent UX/behavior tweaks.

---

## npm packages (`agent/npm/`)

Declared in `agent/npm/package.json` and enabled via `settings.json`'s
`packages` array. `node_modules`/lockfile are git-ignored — run
`npm install` inside `agent/npm/` to restore them.

| Package | Version | Purpose |
|---|---|---|
| **pi-subagents** | `^0.35.1` | Delegate tasks to subagents — single/chain/parallel/async, forked-context, intercom-coordinated. Provides the `subagent`/`subagent_wait` tools and the `pi-subagents` skill. |
| **@quintinshaw/pi-dynamic-workflows** | `^3.4.1` | Claude-Code-style dynamic workflows — fan a task across many subagents with real model routing, token/cost accounting, resume, git-worktree isolation, an interactive `/workflows` TUI, and `/deep-research`. Provides the `workflow`/`workflow_control` tools. |
| **@pi-plugins/checkpoint** | `^0.1.0` | File checkpoints — restore working-tree files when navigating `/tree` branches. Backs the `checkpoints/` dir. |
| **pi-btw** | `^0.4.1` | Parallel side conversations with the `/btw` command (spin off a tangent without leaving the main session). |

`package.json` also pins an `overrides` for `effect` to `4.0.0-beta.100` to
keep the extension runtime's effect versions aligned.

---

## `workflows/settings.json`

```jsonc
{ "excludeSubagentTools": ["subagent", "subagent_wait"] }
```

Prevents workflow-spawned children from recursively spawning their own
subagents (child-safe fan-out boundary). Run artifacts land under
`workflows/projects/<agent-id>/runs/` (git-ignored).

---

## Setup on a new machine

```bash
# 1. Clone into the pi agent config directory
git clone git@github.com:gitsang/pi-config.git ~/.pi/agent

# 2. Provide credentials (NEVER commit this file).
#    Either run `pi` and use /login, or create ~/.pi/agent/auth.json manually.
#    models.json expects the saigw key at .saigw.key, e.g.:
#    { "saigw": { "key": "sk-..." } }

# 3. Restore npm packages
cd ~/.pi/agent/npm && npm install

# 4. (Optional) Install helper binaries pi expects
pi update
```

## Notes

- `models.json` references a **private gateway** (`aigw.cn.c8g.top`). Point
  `baseUrl` at your own provider/gateway and fix the `apiKey` `jq` expression
  before use.
- Provider/model pricing in `models.json` is per-million-token; currency
  follows each provider's convention.
- Local extensions are TypeScript source loaded directly by pi — no build step.
  Edit `index.ts` and `/reload`.
