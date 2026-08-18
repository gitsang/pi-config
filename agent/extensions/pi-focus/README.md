# pi-focus

Single DEC 1004 focus-reporting owner for pi extensions.

- Enables terminal focus reporting (`ESC[?1004h`) in TUI mode.
- Consumes `ESC[I` / `ESC[O` and broadcasts `pi-focus:change` with `{ focused: boolean }`.
- Other extensions (e.g. pi-statusline, pi-status) subscribe to this event; do not enable or consume DEC 1004 yourself.

## Usage

- `/pi-focus` — show listener state.

Inside tmux, add `set -g focus-events on` so pane/window focus changes are forwarded.

No configuration.
