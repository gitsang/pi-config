# pi-service-tier

Configurable OpenAI `service_tier` injection for pi requests.

An entry's presence under `providers` or `models` marks that provider/model as service-tier-capable. Model-level entries override provider-level entries.

## Usage

- `/service-tier` or `/service-tier status` — current model capability, active tier, allowed tiers.
- `/service-tier <tier>` — set session override.
- `/service-tier off` — send no `service_tier` this session.
- `/service-tier on` / `reset` — clear override and fall back to config default.
- `/service-tier list` — list allowed tiers for the current model.

## Configuration

Precedence (later overrides earlier):
1. `~/.pi/agent/pi-service-tier.json`
2. `config.json` next to this extension
3. `<cwd>/.pi/pi-service-tier.json` (trusted projects only)

See `config.example.json`.
