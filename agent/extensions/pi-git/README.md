# pi-git

Fast git operations via a small configured model. Lives in
`~/.pi/agent/extensions/pi-git/`.

## Commands

| Command | What it does |
|---|---|
| `/pi-git:commit [paths...]` | `git add -A` (or only `paths`), generate a commit message with the small model, commit. |
| `/pi-git:commit-and-push` | commit (as above), then `git push` to the current upstream. Never `push -u`. |
| `/pi-git <prompt>` | Agentic loop: the small model runs git through a parameterized `git` tool, bounded by `maxSteps`. |

The slash-command path uses `ui.notify` only — the process and output stay out
of the main session context.

## LLM tool `pi_git`

The main agent can delegate git work via the `pi_git` tool (no confirmation —
trusts the agent):

```
action:  "commit" | "commit-and-push" | "prompt"
prompt?: string   — for action "prompt"
message?: string  — for commit actions; use this exact message (skip generation)
paths?:   string[]— for commit actions; limit staging to these paths
```

The tool returns a short summary as the tool result.

## Model

`config.model = "provider/modelId"` (e.g. `google/gemini-2.5-flash`). If
absent, the current session model is used. The session model is **never**
switched by this extension. If the configured model has no API key, the
operation aborts with a warning (no silent fallback).

## Context

The main conversation (compaction-applied active branch) is fed to the small
model for commit-message generation and the prompt loop, so output reflects the
work's intent. Truncated to `maxContextChars` (recent tail kept).

## Safety

- **Read-only** git commands run freely.
- **Write** commands require confirm in the *command* path (`confirmWrite` /
  `confirmPush`). The *agent* (tool) path never confirms.
- **Destructive** commands are hard-blocked in **both** paths:
  `push --force/-f`, `reset --hard`, `clean -f`, `branch -D`,
  `checkout/restore .` (mass discard), `config --global/--system`, and
  repo-corrupting commands (`update-ref -d`, `reflog expire`, `gc --prune`,
  `filter-branch`, `replace --delete`, `symbolic-ref --delete`, `rm -r .git`).

## Config

Global: `<ext-dir>/config.json`. Project (trusted only): `<cwd>/.pi/pi-git.json`.
Project overrides global. Re-read on every invocation (edits take effect
without `/reload`).

| Field | Default | Description |
|---|---|---|
| `model` | current session model | `provider/modelId` for the small model |
| `preview` | `false` | show the commit message + confirm before committing (command path) |
| `confirmPush` | `true` | confirm before push (command path) |
| `confirmWrite` | `true` | confirm write ops in `/pi-git` loop (command path) |
| `trailer` | none | appended to the commit body, e.g. `Co-Authored-By: …` |
| `maxSteps` | `12` | agentic loop step budget |
| `maxDiffChars` | `8000` | truncate staged diff fed to the model |
| `maxContextChars` | `4000` | truncate session context fed to the model |

## Commit message style

Conventional Commits by default. Language follows the repository's recent 5
commit subjects (CJK → 简体中文, otherwise English).
