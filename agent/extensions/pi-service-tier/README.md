# pi-service-tier

Configurable OpenAI `service_tier` injection for pi requests.

Automatically applies to model IDs starting with `gpt-` (case-sensitive), regardless of provider. Other models are left untouched. The endpoint must accept `service_tier`; the prefix rule does not check server support.

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

Only two top-level settings are needed; no `providers` or `models` mapping:

```json
{
  "default": "priority",
  "allowed": ["auto", "default", "flex", "priority"]
}
```

- `default`: tier sent without a session override. Null or omitted means no default injection.
- `allowed`: tiers accepted by `/service-tier <tier>`. Null or omitted allows any tier.

Configuration files merge by field in the order above. Session overrides remain scoped to each `provider/modelId`. Run `/reload` after updating the extension code. See `config.example.json`.
