/**
 * pi-model-lock — prevent in-session model switches from overwriting the
 * global `defaultModel`/`defaultProvider` in `~/.pi/agent/settings.json`.
 *
 * pi's `setModel()` (used by `/model`, `Ctrl+P` cycling, and `Ctrl+L` model
 * selector) unconditionally writes the switched-to model to settings.json as
 * the new global default. There is no upstream opt-out. This extension
 * restores the previous default right after pi's write lands, so the
 * in-session model still changes but the persisted default is preserved.
 *
 * Behavior is driven entirely by the sibling `config.json`:
 *
 *   { "enable": true }   — restore the default after every switch (default)
 *   { "enable": false }  — do nothing; pi's built-in behavior applies
 *
 * `enable` is re-read on every switch, so editing config.json takes effect on
 * the next model switch without a reload.
 *
 * Commands (for convenience; not part of config.json):
 *   /model-lock   — show status (enable state, protected default, current model)
 *   /model-save   — persist the CURRENT session model as the new global default
 *                   (one-time write; the protected default is updated to match,
 *                    so later switches in this session preserve the new value)
 *
 * Why snapshot at session_start instead of at event time: pi enqueues the
 * settings write as a microtask (`enqueueWrite` → `.then(...)`) right before
 * awaiting `_emitModelSelect`. By the time the `model_select` handler runs,
 * pi's write may already have landed — so reading "old" value at event time
 * can capture the *new* model and lose the real default. Snapshotting once at
 * session start (before any switch) avoids that race.
 *
 * Known limitation: the protected default is the value in settings.json at
 * session start. If you hand-edit settings.json (or change it via `/settings`)
 * mid-session and then switch models, this extension restores the
 * session-start value, not your mid-session edit. Use `/model-save` to bake
 * in a new intended default.
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
  [key: string]: unknown;
}

interface ProtectedDefault {
  provider: string;
  model: string;
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
  return { provider: s.defaultProvider, model: s.defaultModel };
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

  // /model-lock — show status.
  pi.registerCommand("model-lock", {
    description: "Show pi-model-lock status (config.json enable state + protected default)",
    handler: async (_args, ctx) => {
      const enabled = isEnabled();
      const cur = ctx.model;
      const curStr = cur?.provider && cur?.id ? `${cur.provider}/${cur.id}` : "none";
      const protStr = protectedDefault
        ? `${protectedDefault.provider}/${protectedDefault.model}`
        : "none";
      ctx.ui.notify(
        `model-lock: ${enabled ? "ON" : "OFF"} (config.json) · ` +
          `protected default: ${protStr} · current: ${curStr}`,
        "info",
      );
    },
  });

  // /model-save — persist the current session model as the new global default.
  // One-time write; updates the in-memory protected default so later switches
  // in this session preserve the newly saved value.
  pi.registerCommand("model-save", {
    description: "Persist the current session model as the new global default (one-time write)",
    handler: async (_args, ctx) => {
      const cur = ctx.model;
      if (!cur?.provider || !cur?.id) {
        ctx.ui.notify("model-save: no current model to save.", "warning");
        return;
      }
      const s = readSettings() ?? {};
      const prev = s.defaultProvider && s.defaultModel ? `${s.defaultProvider}/${s.defaultModel}` : "none";
      s.defaultProvider = cur.provider;
      s.defaultModel = cur.id;
      writeSettings(s);
      // Keep this session's protected default in sync so subsequent switches
      // preserve the value we just intentionally saved.
      protectedDefault = { provider: cur.provider, model: cur.id };
      ctx.ui.notify(
        `model-save: default now ${cur.provider}/${cur.id} (was ${prev}).`,
        "info",
      );
    },
  });
}
