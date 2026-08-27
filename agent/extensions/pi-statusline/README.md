# pi-statusline

Config-driven status line / footer for pi.

Renders dense session info (title, cwd, git branch, model, thinking, service tier, token/cost usage, context bar, task elapsed time, TTFT, TPS, focus, and other extensions' `ext-status` values) into a multi-line footer.

## Usage

- `/statusline` — toggle footer on/off.
- `/statusline reload` — reload config after edits.
- `/statusline focus` — show focus state and pi-focus event status.
- `/statusline-reset` — clear TTFT/TPS/task-elapsed history.

## Configuration

Precedence (later overrides earlier):
1. `~/.pi/agent/pi-statusline.json`
2. `config.json` next to this extension
3. `<cwd>/.pi/pi-statusline.json` (trusted projects only)

Configs deep-merge over built-in defaults. Define `lines` and `modules`; modules use sources such as `session.cwd`, `model`, `thinking`, `usage.*`, `ctx.*`, `task.elapsed`, `task.elapsedTotal`, `ttft`, `tps`, `focus`, `ext-status`, and `literal`. See `config.example.json` for the full template.

All spacing and grouping lives in `lines` — there is no global separator config. Each line accepts `sep` (spacer between same-group items), `sepLeft` / `sepRight` (per-side overrides), and `groupSep` (spacer between module groups, default `" │ "`).

Each module optionally carries a `priority` number (default 50): when a line overflows, modules with priority < 90 are dropped lowest-first. Modules with `truncate: "end"` are ellipsized instead of dropped.

tmux users: add `set -g focus-events on` for focus module updates.
