/**
 * pi-tmux-title — mirror pi's generation state onto the tmux window tab.
 *
 * Adds a state icon *prefix* in front of the tmux window's existing name (#W),
 * without ever renaming the window or touching automatic-rename. The icon
 * (always followed by one space) flips with state:
 *
 *   idle (default):  prefix  (\ue22c by default)
 *   generating:      busy    (\uf110)
 *   done:            done    (\uf00c)  — only shown if pi lost focus mid-turn
 *
 * Mechanism (no rename-window):
 *   - sets a per-window user option @pi_t = "<icon> "
 *   - idempotently patches global window-status-format / -current-format,
 *     replacing #W with #{@pi_t}#W
 *   - tmux keeps managing #W (automatic-rename, manual rename, etc.)
 *   - on exit, unset @pi_t (the format patch is harmless once it's empty)
 *
 * Focus tracking (zero polling):
 *   - enables DEC 1004 (ESC[?1004h); tmux forwards ESC[I/ESC[O when focus-events on
 *   - focus-in while "done" → revert to "idle"; focus-out records blurred state
 *   - listener returns undefined (never consumes) so other extensions
 *     (e.g. pi-statusline's own DEC 1004) keep working alongside
 *
 * No-op outside tmux or outside TUI mode. Active only for pi's own pane
 * ($TMUX_PANE). Requires `set -g focus-events on` for focus-based done-revert.
 *
 * Config (precedence: later overrides earlier):
 *   global     ~/.pi/agent/pi-tmux-title.json
 *   extension  <ext-dir>/config.json        (next to this file)
 *   project    <cwd>/.pi/pi-tmux-title.json  (trusted projects only)
 *
 * Command:
 *   /tmux-title                       reload config
 *   /tmux-title on|off                enable / disable
 *   /tmux-title state idle|gen|done   force a state (manual / testing)
 *   /tmux-title status                show current state
 */

import { spawnSync } from "node:child_process";
import {
  CONFIG_DIR_NAME,
  getAgentDir,
  type ExtensionAPI,
  type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const EXT_DIR = dirname(fileURLToPath(import.meta.url));

// ─── config ─────────────────────────────────────────────────────────────────
interface TmuxTitleConfig {
  prefix?: string; // idle / default icon
  busy?: string; // generating icon
  done?: string; // done badge icon
  enabled?: boolean;
}

const DEFAULTS: Required<TmuxTitleConfig> = {
  prefix: "\ue22c",
  busy: "\uf110",
  done: "\uf00c",
  enabled: true,
};

type ResolvedConfig = Required<TmuxTitleConfig>;

function tryRead(p: string): TmuxTitleConfig | null {
  try {
    const parsed = JSON.parse(readFileSync(p, "utf8"));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as TmuxTitleConfig)
      : null;
  } catch {
    return null;
  }
}

function loadConfig(ctx?: ExtensionContext): ResolvedConfig {
  let raw: TmuxTitleConfig = {};
  raw = {
    ...raw,
    ...(tryRead(join(getAgentDir(), "pi-tmux-title.json")) ?? {}),
  };
  raw = { ...raw, ...(tryRead(join(EXT_DIR, "config.json")) ?? {}) };
  if (ctx?.isProjectTrusted()) {
    raw = {
      ...raw,
      ...(tryRead(join(ctx.cwd, CONFIG_DIR_NAME, "pi-tmux-title.json")) ?? {}),
    };
  }
  return { ...DEFAULTS, ...raw };
}

// ─── state ──────────────────────────────────────────────────────────────────
type State = "idle" | "gen" | "done";

let cfg: ResolvedConfig = { ...DEFAULTS };
let state: State = "idle";
let focused = true;
let active = false; // only true in tui mode inside tmux
let inTmux = !!process.env.TMUX;
let pane = process.env.TMUX_PANE ?? "";
let lastT = ""; // last @pi_t value written (dedupe)
let patched = false; // global formats already have #{@pi_t}#W
let unsubInput: (() => void) | null = null;
let warnedFocusEvents = false;

// ─── tmux helpers (all sync; calls are ~ms and low-frequency) ───────────────
function tmux(args: string[]): string {
  if (!inTmux || !pane) return "";
  try {
    const r = spawnSync("tmux", args, {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 1500,
    });
    return (r.stdout ?? "").trim();
  } catch {
    return "";
  }
}

function iconFor(s: State): string {
  return s === "gen" ? cfg.busy : s === "done" ? cfg.done : cfg.prefix;
}

// Write the per-window user option @pi_t = "<icon> ". Dedupe by value.
function writeMarker(icon: string): void {
  if (!active) return;
  const t = `${icon} `;
  if (t === lastT) return;
  lastT = t;
  tmux(["set-window-option", "-t", pane, "@pi_t", t]);
}

function setState(s: State): void {
  state = s;
  writeMarker(iconFor(s));
}

// ─── format patching (idempotent) ───────────────────────────────────────────
// Replace every bare #W with #{@pi_t}#W, once. Safe to call repeatedly; if the
// format already contains @pi_t it is left untouched. The patch is global
// (window-status-format applies per-window via #{T:...}); @pi_t is set per
// window, so non-pi windows simply see an empty prefix.
function patchFormats(): void {
  if (patched) return;
  for (const opt of [
    "window-status-format",
    "window-status-current-format",
  ] as const) {
    const cur = tmux(["show-options", "-gv", opt]);
    if (!cur.includes("@pi_t") && cur.includes("#W")) {
      tmux(["set-option", "-g", opt, cur.split("#W").join("#{@pi_t}#W")]);
    }
  }
  patched = true;
}

// ─── DEC 1004 focus tracking (zero polling) ────────────────────────────────
function enableFocusReporting(ctx: ExtensionContext): void {
  if (unsubInput) return;
  // Check focus-events; warn once if off (tmux won't forward pane-switch events).
  const fe = tmux(["show-options", "-gv", "focus-events"]);
  if (fe !== "on" && !warnedFocusEvents) {
    warnedFocusEvents = true;
    ctx.ui.notify(
      "pi-tmux-title: set `set -g focus-events on` for done-badge focus revert",
      "warning",
    );
  }
  try {
    process.stdout.write("\x1b[?1004h");
  } catch {
    /* ignore */
  }
  if (ctx.ui.onTerminalInput) {
    unsubInput = ctx.ui.onTerminalInput((data: string) => {
      if (data === "\x1b[I") {
        focused = true;
        if (state === "done") setState("idle"); // focused back → drop badge
      } else if (data === "\x1b[O") {
        focused = false;
      }
      return undefined; // never consume; let pi-statusline etc. also see it
    });
  }
}

function disableFocusReporting(): void {
  if (unsubInput) {
    unsubInput();
    unsubInput = null;
  }
  // Deliberately NOT writing ESC[?1004l on exit — keeps us decoupled from
  // other extensions (e.g. pi-statusline) that may still rely on focus events.
}

// ─── lifecycle ──────────────────────────────────────────────────────────────
function activate(ctx: ExtensionContext): void {
  inTmux = !!process.env.TMUX;
  pane = process.env.TMUX_PANE ?? "";
  active = cfg.enabled && inTmux && !!pane && ctx.mode === "tui";
  if (!active) return;
  patchFormats();
  enableFocusReporting(ctx);
  state = "idle";
  lastT = "";
  writeMarker(cfg.prefix);
}

function shutdown(): void {
  if (!active) return;
  tmux(["set-window-option", "-q", "-t", pane, "-u", "@pi_t"]);
  disableFocusReporting();
  active = false;
}

// ─── setup ──────────────────────────────────────────────────────────────────
export default function (pi: ExtensionAPI): void {
  pi.on("session_start", (_e, ctx) => {
    cfg = loadConfig(ctx);
    activate(ctx);
  });

  // An LLM call is about to start → busy.
  pi.on("before_provider_request", () => {
    if (active) setState("gen");
  });

  // The whole turn is truly finished (no more retries / compaction / follow-ups).
  pi.on("agent_settled", () => {
    if (!active) return;
    // Done badge only if pi was blurred when it finished; if you were
    // watching, go straight back to idle.
    setState(focused ? "idle" : "done");
  });

  process.on("exit", shutdown);

  pi.registerCommand("tmux-title", {
    description: "tmux window tab title: [reload|on|off|state <s>|status]",
    handler: async (args, ctx) => {
      const parts = args.trim().split(/\s+/);
      const sub = (parts[0] ?? "").toLowerCase();

      if (sub === "off") {
        shutdown();
        cfg = { ...cfg, enabled: false };
        if (ctx.hasUI) ctx.ui.notify("pi-tmux-title: disabled", "info");
        return;
      }
      if (sub === "on") {
        cfg = { ...cfg, enabled: true };
        activate(ctx);
        if (ctx.hasUI) ctx.ui.notify("pi-tmux-title: enabled", "info");
        return;
      }
      if (sub === "state") {
        const s = (parts[1] ?? "").toLowerCase();
        if (s !== "idle" && s !== "gen" && s !== "done") {
          if (ctx.hasUI)
            ctx.ui.notify("usage: /tmux-title state idle|gen|done", "warning");
          return;
        }
        if (!active) {
          cfg = { ...cfg, enabled: true };
          activate(ctx);
        }
        setState(s);
        if (ctx.hasUI) ctx.ui.notify(`pi-tmux-title: state → ${s}`, "info");
        return;
      }
      if (sub === "status") {
        if (ctx.hasUI)
          ctx.ui.notify(
            [
              `active: ${active}`,
              `in tmux: ${inTmux} (pane ${pane || "—"})`,
              `mode: ${ctx.mode}`,
              `enabled: ${cfg.enabled}`,
              `state: ${state}`,
              `focused: ${focused}`,
              `patched: ${patched}`,
              `prefix: ${cfg.prefix}`,
              `busy: ${cfg.busy}`,
              `done: ${cfg.done}`,
              `last @pi_t: ${lastT || "(none)"}`,
            ].join("\n"),
            "info",
          );
        return;
      }

      // default / "reload"
      cfg = loadConfig(ctx);
      activate(ctx);
      if (ctx.hasUI) ctx.ui.notify("pi-tmux-title: config reloaded", "info");
    },
  });
}
