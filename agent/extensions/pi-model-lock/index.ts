/**
 * pi-model-lock — prevent in-session model/thinking changes from overwriting
 * the global `defaultModel`/`defaultProvider`/`defaultThinkingLevel` in
 * `~/.pi/agent/settings.json`.
 *
 * pi persists in-session changes to the global default unconditionally, with
 * no upstream opt-out:
 *   - `setModel()` (used by `/model`, `Ctrl+P` cycling, `Ctrl+L` selector)
 *     writes the switched-to model via `setDefaultModelAndProvider()`.
 *   - `setThinkingLevel()` (used by model switches, thinking-level cycling,
 *     and `/thinking`) writes the new level via `setDefaultThinkingLevel()`
 *     whenever the level actually changes.
 *
 * This extension restores the previous default right after each write lands,
 * so the in-session model/thinking level still changes but the persisted
 * defaults are preserved.
 *
 * Behavior is driven entirely by the sibling `config.json`:
 *
 *   { "enable": true }   — restore the defaults after every change (default)
 *   { "enable": false }  — do nothing; pi's built-in behavior applies
 *
 * `enable` is re-read on every switch, so editing config.json takes effect on
 * the next model switch without a reload.
 *
 * Commands (for convenience; not part of config.json):
 *   /model-lock   — show status (enable state, protected defaults, current
 *                   model + thinking level)
 *   /model-save   — persist the CURRENT session model AND thinking level as
 *                   the new global defaults (one-time write; the protected
 *                   defaults are updated to match, so later changes in this
 *                   session preserve the new values)
 *
 * Why snapshot at session_start instead of at event time: pi enqueues each
 * settings write as a microtask (`enqueueWrite` → `.then(...)`) on a shared
 * `writeQueue` right before emitting the corresponding event
 * (`model_select` / `thinking_level_select`). By the time a handler runs,
 * pi's write may already have landed — so reading the "old" value at event
 * time can capture the *new* value and lose the real default. Snapshotting
 * once at session start (before any change) avoids that race.
 *
 * Thinking level is protected via the `thinking_level_select` event, which pi
 * fires (inside `setThinkingLevel`) exactly when it writes
 * `defaultThinkingLevel`. That single hook covers both standalone
 * thinking-level changes and the level change that accompanies a model
 * switch (a model switch calls `setThinkingLevel`, which fires the event when
 * the level actually changes). Session restore sets the level directly in
 * agent state without calling `setThinkingLevel`, so it does not trigger the
 * event and is correctly left alone.
 *
 * Known limitation: the protected defaults are the values in settings.json at
 * session start. If you hand-edit settings.json (or change it via `/settings`)
 * mid-session and then switch models/thinking, this extension restores the
 * session-start values, not your mid-session edits. Use `/model-save` to bake
 * in new intended defaults.
 */

import { getAgentDir, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const SETTINGS_PATH = join(getAgentDir(), "settings.json");
const CONFIG_PATH = join(dirname(fileURLToPath(import.meta.url)), "config.json");

interface Settings {
  defaultProvider?: string;
  defaultModel?: string;
  defaultThinkingLevel?: string;
  [key: string]: unknown;
}

interface ProtectedDefault {
  provider: string;
  model: string;
  thinkingLevel?: string;
}

interface Config {
  enable?: boolean;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function readConfig(): Config {
  try {
    if (!existsSync(CONFIG_PATH)) return {};
    return JSON.parse(readFileSync(CONFIG_PATH, "utf-8")) as Config;
  } catch {
    return {};
  }
}

/** Whether the lock is active. Defaults to ON when `enable` is not explicitly false. */
function isEnabled(): boolean {
  return readConfig().enable !== false;
}

function readSettings(): Settings | null {
  try {
    if (!existsSync(SETTINGS_PATH)) return {};
    return JSON.parse(readFileSync(SETTINGS_PATH, "utf-8")) as Settings;
  } catch {
    return null;
  }
}

function writeSettings(s: Settings): void {
  // Match pi's own format: 2-space indent, no trailing newline.
  writeFileSync(SETTINGS_PATH, JSON.stringify(s, null, 2), "utf-8");
}

function protectedDefaultFromSettings(s: Settings | null): ProtectedDefault | null {
  if (!s) return null;
  if (!s.defaultProvider || !s.defaultModel) return null;
  return {
    provider: s.defaultProvider,
    model: s.defaultModel,
    thinkingLevel: typeof s.defaultThinkingLevel === "string" ? s.defaultThinkingLevel : undefined,
  };
}

export default function (pi: ExtensionAPI) {
  // The global default captured at session start. This is the value we
  // restore to after pi overwrites it on a model switch.
  let protectedDefault: ProtectedDefault | null = null;

  pi.on("session_start", () => {
    protectedDefault = protectedDefaultFromSettings(readSettings());
  });

  pi.on("model_select", async (event, ctx) => {
    // session restore is legitimate (not a user switch) — leave it alone.
    if (event.source === "restore") return;

    const next = event.model;
    if (!next?.provider || !next?.id) return;

    if (!isEnabled()) return;

    // Snapshot the value to restore to, fresh per switch. Prefer the
    // session-start protected default (robust against pi's write having
    // already landed); fall back to the current file value if we somehow
    // have no session-start snapshot yet.
    const target =
      protectedDefault ?? protectedDefaultFromSettings(readSettings());
    if (!target) return;

    // Nothing to do if the switch target IS the protected default.
    if (target.provider === next.provider && target.model === next.id) return;

    // Wait for pi's settings write to land (file reflects the switched-to
    // model). pi enqueues the write as a microtask before emitting this
    // event, so it may already be done or may take a tick or two.
    const deadline = 100;
    let landed = false;
    for (let i = 0; i < deadline; i++) {
      const s = readSettings();
      if (s && s.defaultProvider === next.provider && s.defaultModel === next.id) {
        landed = true;
        break;
      }
      await sleep(10);
    }
    if (!landed) {
      // pi's write never landed — file still holds the protected default,
      // so there is nothing to restore. Leave it untouched.
      return;
    }

    // Restore the protected default, preserving every other field.
    const s = readSettings();
    if (!s) return;
    if (s.defaultProvider === target.provider && s.defaultModel === target.model) {
      return; // already correct (e.g. another handler restored first)
    }
    s.defaultProvider = target.provider;
    s.defaultModel = target.model;
    writeSettings(s);

    if (ctx.hasUI) {
      ctx.ui.notify(
        `model-lock: switched to ${next.provider}/${next.id} for this session; ` +
          `global default preserved (${target.provider}/${target.model}).`,
        "info",
      );
    }
  });

  // Protect defaultThinkingLevel. pi's setThinkingLevel() writes the new
  // level to settings.json (via setDefaultThinkingLevel) whenever the level
  // actually changes, then fires `thinking_level_select`. This covers both
  // standalone thinking changes and the level change that accompanies a model
  // switch (setModel calls setThinkingLevel). Restore the protected level
  // after pi's write lands.
  pi.on("thinking_level_select", async (event, ctx) => {
    if (!isEnabled()) return;

    const target = protectedDefault ?? protectedDefaultFromSettings(readSettings());
    if (!target?.thinkingLevel) return; // nothing to protect

    const next = event.level;
    // Nothing to do if the new level IS the protected level.
    if (target.thinkingLevel === next) return;

    // Wait for pi's settings write to land (file reflects the new level).
    // pi enqueues the write as a microtask on the same writeQueue as the
    // model write, so it may already be done or take a tick or two. If pi
    // didn't write (e.g. the model doesn't support thinking and the level is
    // "off"), the file keeps the protected value and the poll never matches —
    // we then leave it untouched.
    const deadline = 100;
    let landed = false;
    for (let i = 0; i < deadline; i++) {
      const s = readSettings();
      if (s && s.defaultThinkingLevel === next) {
        landed = true;
        break;
      }
      await sleep(10);
    }
    if (!landed) return;

    const s = readSettings();
    if (!s) return;
    if (s.defaultThinkingLevel === target.thinkingLevel) return; // already correct
    s.defaultThinkingLevel = target.thinkingLevel;
    writeSettings(s);

    if (ctx.hasUI) {
      ctx.ui.notify(
        `model-lock: thinking set to ${next} for this session; ` +
          `global defaultThinkingLevel preserved (${target.thinkingLevel}).`,
        "info",
      );
    }
  });

  // /model-lock — show status.
  pi.registerCommand("model-lock", {
    description: "Show pi-model-lock status (config.json enable state + protected defaults)",
    handler: async (_args, ctx) => {
      const enabled = isEnabled();
      const cur = ctx.model;
      const curModelStr = cur?.provider && cur?.id ? `${cur.provider}/${cur.id}` : "none";
      const curThink = pi.getThinkingLevel() ?? "none";
      const protModelStr = protectedDefault
        ? `${protectedDefault.provider}/${protectedDefault.model}`
        : "none";
      const protThink = protectedDefault?.thinkingLevel ?? "none";
      ctx.ui.notify(
        `model-lock: ${enabled ? "ON" : "OFF"} (config.json) · ` +
          `protected: ${protModelStr} / thinking ${protThink} · ` +
          `current: ${curModelStr} / thinking ${curThink}`,
        "info",
      );
    },
  });

  // /model-save — persist the current session model as the new global default.
  // One-time write; updates the in-memory protected default so later switches
  // in this session preserve the newly saved value.
  pi.registerCommand("model-save", {
    description: "Persist the current session model + thinking level as the new global default (one-time write)",
    handler: async (_args, ctx) => {
      const cur = ctx.model;
      if (!cur?.provider || !cur?.id) {
        ctx.ui.notify("model-save: no current model to save.", "warning");
        return;
      }
      const thinking = pi.getThinkingLevel();
      const s = readSettings() ?? {};
      const prevModel = s.defaultProvider && s.defaultModel ? `${s.defaultProvider}/${s.defaultModel}` : "none";
      const prevThink = s.defaultThinkingLevel ?? "none";
      s.defaultProvider = cur.provider;
      s.defaultModel = cur.id;
      if (thinking) s.defaultThinkingLevel = thinking;
      writeSettings(s);
      // Keep this session's protected defaults in sync so subsequent changes
      // preserve the values we just intentionally saved.
      protectedDefault = { provider: cur.provider, model: cur.id, thinkingLevel: thinking };
      ctx.ui.notify(
        `model-save: default now ${cur.provider}/${cur.id} / thinking ${thinking ?? "none"} ` +
          `(was ${prevModel} / thinking ${prevThink}).`,
        "info",
      );
    },
  });
}
