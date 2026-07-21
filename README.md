# pi-config

My configuration for the [pi](https://github.com/earendil-works/pi-coding-agent) coding agent.

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](./LICENSE)

## What's tracked

| File | Description |
|------|-------------|
| `settings.json` | UI theme, default provider & model |
| `models.json` | Custom provider/model definitions (endpoints, context windows, pricing) |

## What's NOT tracked (see `.gitignore`)

| Path | Reason |
|------|--------|
| `auth.json` | Contains API keys / credentials |
| `sessions/` | Conversation history; may leak sensitive data |
| `bin/` | Auto-downloaded helper binaries (e.g. `fd`), re-fetched by pi |

## Setup on a new machine

```bash
# 1. Clone into the pi agent config directory
git clone git@github.com:gitsang/pi-config.git ~/.pi/agent

# 2. Provide credentials separately (NEVER commit this file)
#    Either run `pi` and use /login, or create auth.json manually:
#    {
#      "<provider>": { "type": "api_key", "key": "sk-..." }
#    }

# 3. (Optional) Install helper binaries pi expects, e.g.:
#    pi update
```

## Notes

- `models.json` references a private gateway endpoint. Adjust `baseUrl` to point at your own provider/gateway before use.
- Provider/model pricing in `models.json` is per-million-token; currency follows each provider's convention.
