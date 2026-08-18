# pi-settings-lock

Prevents in-session model/thinking switches from overwriting the global `defaultModel` / `defaultProvider` / `defaultThinkingLevel` in `settings.json`.

It snapshots the global defaults at session start and restores them after each model/thinking switch, so the session changes but the persisted defaults stay unchanged.

## Usage

- `/settings-lock` or `/settings-lock status` — show lock state, protected defaults, current model/thinking.
- `/settings-lock model save` — persist the current session model as the new global default.
- `/settings-lock thinking save` — persist the current thinking level as the new global default.

## Configuration

`config.json` next to this extension:
- `{ "enable": true }` — restore defaults after each switch (default)
- `{ "enable": false }` — do nothing; pi's built-in behavior applies
