# pi-status

Publishes each pi process's `idle` / `gen` / `done` state to a shared runtime store, then projects it to tmux and pi-statusline.

- tmux sink aggregates all live records for the same tmux server + window and writes `@pi_t`.
- statusline sink publishes this process's state via `ctx.ui.setStatus("pi-status", state)`.

## Usage

- `/pi-status` or `/pi-status reload` — reload config.
- `/pi-status status` — show store, tmux, state, and focus info.
- `/pi-status on` / `off` — enable/disable.
- `/pi-status state idle|gen|done` — force this process's state.

Inside tmux, use `set -g focus-events on` if you rely on pi-focus state.

## Configuration

Precedence (later overrides earlier):
1. `~/.pi/agent/pi-status.json` (legacy `~/.pi/agent/pi-tmux-status.json` is also readable)
2. `config.json` next to this extension
3. `<cwd>/.pi/pi-status.json` (trusted projects only; legacy `pi-tmux-status.json` is also readable)

See `config.example.json`.
