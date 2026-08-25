# pi-auto-title

Automatically generates short session titles for pi.

- Generates a title after the first user input (`onFirstTurn`).
- Regenerates after compaction (`onCompact`).
- Can refresh every N user turns (`refreshEveryTurns`, 0 = off).
- Includes each turn's final assistant output in the title context (`includeAssistantOutput`, on by default).
- Supports `auto` / `zh` / `en` title language and optional terminal-title sync.

## Usage

- `/auto-title` or `/auto-title regen` — generate/refresh the title now.
- `/auto-title on` / `off` — enable/disable for the current session.
- `/auto-title status` — show current config and state.

## Configuration

Reads `config.json` next to this extension; project override: `<cwd>/.pi/pi-auto-title.json` (trusted projects only). See `config.example.json` for all fields (`model`, `onFirstTurn`, `onCompact`, `refreshEveryTurns`, `maxTitleLength`, `language`, `setTerminalTitle`, `includeAssistantOutput`).

`maxTitleLength` is measured in terminal display columns: CJK/wide/fullwidth glyphs count as 2, combining marks count as 0, and regular characters count as 1.

Thinking models (Qwen3, DeepSeek, …) are handled: title requests ask the provider to turn thinking off (only effective if the model entry in `models.json` sets the right `compat.thinkingFormat`, e.g. `"qwen-chat-template"` for vLLM + Qwen), use a 512-token budget so a stray thinking phase can't truncate the response, and strip inline `<thinking>`/`<reasoning>` text from the answer.
