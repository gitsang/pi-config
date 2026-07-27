/**
 * pi-status — mirror pi's generation state onto the tmux window tab AND the
 * pi-statusline footer, with DEC 1004 focus tracking driving the done→idle
 * revert.
 *
 * Two independent surfaces, two activation scopes:
 *
 * 1. tmux window tab  (active only inside tmux + TUI):
 *      Replaces the tokyo-night theme's terminal icon on pi's tmux window with
 *      a state-driven one via a WINDOW-LEVEL window-status-format patch (other
 *      windows keep the global theme format). @pi_t = "<icon> ".
 *        idle (default): prefix   generating: busy   done: done badge
 *      Multi-pane caveat: @pi_t is window-level, so several pi panes in one
 *      window overwrite each other (last writer wins). This is accepted by
 *      design — the per-pane disambiguation lives in surface #2.
 *
 * 2. pi-statusline registration  (active in ALL TUI mode, tmux or not):
 *      - Pushes THIS pi's gen state to its own footer via
 *        ctx.ui.setStatus(statusKey, "idle"|"gen"|"done"). Each pi process
 *        feeds its own footer, so every pane shows its own state (no sharing,
 *        no overwrite) — this is what disambiguates multi-pi setups.
 *      - Owns DEC 1004 focus tracking (ESC[?1004h → ESC[I focused / ESC[O
 *        blurred) for this terminal. On focus-in while in the "done" state,
 *        reverts to idle (done→prefix). Also broadcasts focus on the
 *        "pi-status:focus" event bus channel so pi-statusline's dimUnfocused /
 *        focusDot keep working without enabling 1004 itself (only one
 *        extension per terminal should own DEC 1004 — otherwise the shared
 *        input-listener consume-order races).
 *
 * Focus tracking uses DEC 1004 (terminal focus reporting), NOT tmux's
 * #{window_active}. This is per-pane precise, but requires the terminal to
 * support it. Inside tmux, enable `set -g focus-events on` or pane switches
 * won't report. (Same requirement the old pi-statusline focus feature had.)
 *
 * No-op outside TUI mode. The tmux surface is additionally no-op outside tmux.
 *
 * Config (precedence: later overrides earlier):
 *   global     ~/.pi/agent/pi-status.json
 *   extension  <ext-dir>/config.json        (next to this file)
 *   project    <cwd>/.pi/pi-status.json      (trusted projects only)
 *
 * Command:
 *   /pi-status                       reload config
 *   /pi-status on|off                enable / disable
 *   /pi-status state idle|gen|done   force a state (manual / testing)
 *   /pi-status status                show current state
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

/** Event bus channel pi-status broadcasts focus on (true=focused). */
const FOCUS_CHANNEL = "pi-status:focus";

// ─── config ─────────────────────────────────────────────────────────────────
interface PiStatusConfig {
	prefix?: string;   // idle / default icon
	busy?: string;     // generating icon
	done?: string;     // done badge icon
	enabled?: boolean;
	/** Theme terminal-icon glyphs to replace with #{@pi_t}, active then inactive. */
	activeGlyph?: string;
	inactiveGlyph?: string;
	/** ext-status key pushed to pi-statusline for this pi's gen state. */
	statusKey?: string;
}

const DEFAULTS: Required<PiStatusConfig> = {
	prefix: "\ue22c",
	busy: "\uf110",
	done: "\uf00c",
	enabled: true,
	activeGlyph: "\ue795",    // tokyo-night @powerkit_active_window_icon default
	inactiveGlyph: "\uf489",  // tokyo-night @powerkit_inactive_window_icon default
	statusKey: "pi-status",
};

type ResolvedConfig = Required<PiStatusConfig>;

function tryRead(p: string): PiStatusConfig | null {
	try {
		const parsed = JSON.parse(readFileSync(p, "utf8"));
		return parsed && typeof parsed === "object" && !Array.isArray(parsed)
			? (parsed as PiStatusConfig)
			: null;
	} catch {
		return null;
	}
}

function loadConfig(ctx?: ExtensionContext): ResolvedConfig {
	let raw: PiStatusConfig = {};
	raw = { ...raw, ...(tryRead(join(getAgentDir(), "pi-status.json")) ?? {}) };
	raw = { ...raw, ...(tryRead(join(EXT_DIR, "config.json")) ?? {}) };
	if (ctx?.isProjectTrusted()) {
		raw = { ...raw, ...(tryRead(join(ctx.cwd, CONFIG_DIR_NAME, "pi-status.json")) ?? {}) };
	}
	return { ...DEFAULTS, ...raw };
}

// ─── state ──────────────────────────────────────────────────────────────────
type State = "idle" | "gen" | "done";

let cfg: ResolvedConfig = { ...DEFAULTS };
let api: ExtensionAPI | null = null;
let ui: ExtensionContext["ui"] | null = null;
let state: State = "idle";
let focused = true;          // DEC 1004 focus (default: assume focused at startup)
let statusActive = false;    // pi-statusline registration + DEC 1004 (TUI mode)
let tmuxActive = false;      // tmux window-tab patching (TUI + inside tmux)
let inTmux = !!process.env.TMUX;
let pane = process.env.TMUX_PANE ?? "";
let lastT = "";              // last @pi_t value written (dedupe)
let inputUnsub: (() => void) | null = null;

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
	if (!tmuxActive) return;
	const t = `${icon} `;
	if (t === lastT) return;
	lastT = t;
	tmux(["set-window-option", "-t", pane, "@pi_t", t]);
}

// ─── window-level format patching ───────────────────────────────────────────
function patchFormats(): void {
	if (!tmuxActive) return;
	for (const opt of ["window-status-format", "window-status-current-format"] as const) {
		const g = tmux(["show-options", "-gv", opt]);
		if (!g) continue;
		let patchedFmt = g;
		let changed = false;
		for (const glyph of [cfg.activeGlyph, cfg.inactiveGlyph]) {
			if (glyph && patchedFmt.includes(glyph)) {
				patchedFmt = patchedFmt.split(glyph).join("#{@pi_t}");
				changed = true;
			}
		}
		if (changed) {
			tmux(["set-window-option", "-t", pane, opt, patchedFmt]);
		}
	}
}

function unpatchFormats(): void {
	if (!pane) return;
	tmux(["set-window-option", "-q", "-t", pane, "-u", "window-status-format"]);
	tmux(["set-window-option", "-q", "-t", pane, "-u", "window-status-current-format"]);
}

// ─── activity/bell flag suppression ─────────────────────────────────────────
function suppressFlags(): void {
	if (!tmuxActive) return;
	tmux(["set-window-option", "-t", pane, "monitor-activity", "off"]);
	tmux(["set-window-option", "-t", pane, "monitor-bell", "off"]);
}

function restoreFlags(): void {
	if (!pane) return;
	tmux(["set-window-option", "-q", "-t", pane, "-u", "monitor-activity"]);
	tmux(["set-window-option", "-q", "-t", pane, "-u", "monitor-bell"]);
}

// ─── DEC 1004 focus tracking ────────────────────────────────────────────────
function write1004(enable: boolean): void {
	try { process.stdout.write(enable ? "\x1b[?1004h" : "\x1b[?1004l"); } catch { /* ignore */ }
}

function emitFocus(): void {
	api?.events.emit(FOCUS_CHANNEL, focused);
}

// Raw terminal input: consume ESC[I / ESC[O, update focus, revert done→idle.
function handleFocusInput(data: string): { consume: true } | undefined {
	if (data === "\x1b[I") {
		if (!focused) { focused = true; emitFocus(); if (state === "done") setState("idle"); }
		return { consume: true };
	}
	if (data === "\x1b[O") {
		if (focused) { focused = false; emitFocus(); }
		return { consume: true };
	}
	return undefined;
}

// ─── state transition ───────────────────────────────────────────────────────
function pushStatus(): void {
	if (!statusActive || !ui) return;
	try { ui.setStatus(cfg.statusKey, state); } catch { /* ignore */ }
}

function setState(s: State): void {
	state = s;
	if (tmuxActive) writeMarker(iconFor(s));
	if (statusActive) pushStatus();
}

// ─── lifecycle ──────────────────────────────────────────────────────────────
function activate(ctx: ExtensionContext): void {
	ui = ctx.ui;
	inTmux = !!process.env.TMUX;
	pane = process.env.TMUX_PANE ?? "";
	statusActive = cfg.enabled && ctx.mode === "tui";
	tmuxActive = statusActive && inTmux && !!pane;
	if (!statusActive) return;

	// DEC 1004 focus tracking (owned here; re-broadcast via event bus).
	if (inputUnsub) { inputUnsub(); inputUnsub = null; }
	write1004(true);
	inputUnsub = ctx.ui.onTerminalInput(handleFocusInput);
	emitFocus();  // broadcast initial assumed-focused state

	// tmux window-tab patching.
	if (tmuxActive) {
		patchFormats();
		suppressFlags();
	}

	state = "idle";
	lastT = "";
	if (tmuxActive) writeMarker(cfg.prefix);
	pushStatus();
}

function shutdown(): void {
	if (inputUnsub) { inputUnsub(); inputUnsub = null; }
	write1004(false);
	if (tmuxActive) {
		tmux(["set-window-option", "-q", "-t", pane, "-u", "@pi_t"]);
		unpatchFormats();
		restoreFlags();
	}
	if (statusActive && ui) {
		try { ui.setStatus(cfg.statusKey, undefined); } catch { /* ignore */ }
	}
	statusActive = false;
	tmuxActive = false;
}

// ─── setup ──────────────────────────────────────────────────────────────────
export default function (pi: ExtensionAPI): void {
	api = pi;

	pi.on("session_start", (_e, ctx) => {
		cfg = loadConfig(ctx);
		activate(ctx);
	});

	// An LLM call is about to start → busy.
	pi.on("before_provider_request", () => {
		if (statusActive) setState("gen");
	});

	// The whole turn is truly finished (no more retries / compaction / follow-ups).
	pi.on("agent_settled", () => {
		if (!statusActive) return;
		// Done badge only if pi's terminal was unfocused when the turn finished
		// (you were looking elsewhere); if you were watching, go straight to idle.
		// done→idle reverts on the next DEC 1004 focus-in (handleFocusInput).
		setState(focused ? "idle" : "done");
	});

	process.on("exit", shutdown);

	pi.registerCommand("pi-status", {
		description: "pi status (tmux tab + statusline): [reload|on|off|state <s>|status]",
		handler: async (args, ctx) => {
			const parts = args.trim().split(/\s+/);
			const sub = (parts[0] ?? "").toLowerCase();

			if (sub === "off") {
				shutdown();
				cfg = { ...cfg, enabled: false };
				if (ctx.hasUI) ctx.ui.notify("pi-status: disabled", "info");
				return;
			}
			if (sub === "on") {
				cfg = { ...cfg, enabled: true };
				activate(ctx);
				if (ctx.hasUI) ctx.ui.notify("pi-status: enabled", "info");
				return;
			}
			if (sub === "state") {
				const s = (parts[1] ?? "").toLowerCase();
				if (s !== "idle" && s !== "gen" && s !== "done") {
					if (ctx.hasUI) ctx.ui.notify("usage: /pi-status state idle|gen|done", "warning");
					return;
				}
				if (!statusActive) {
					cfg = { ...cfg, enabled: true };
					activate(ctx);
				}
				setState(s);
				if (ctx.hasUI) ctx.ui.notify(`pi-status: state → ${s}`, "info");
				return;
			}
			if (sub === "status") {
				if (ctx.hasUI) ctx.ui.notify(
					[
						`statusActive: ${statusActive}`,
						`tmuxActive: ${tmuxActive}`,
						`in tmux: ${inTmux} (pane ${pane || "—"})`,
						`mode: ${ctx.mode}`,
						`enabled: ${cfg.enabled}`,
						`state: ${state}`,
						`focused (DEC 1004): ${focused}`,
						`statusKey: ${cfg.statusKey}`,
						`prefix: ${cfg.prefix}`,
						`busy: ${cfg.busy}`,
						`done: ${cfg.done}`,
						`active glyph: ${cfg.activeGlyph}`,
						`inactive glyph: ${cfg.inactiveGlyph}`,
						`last @pi_t: ${lastT || "(none)"}`,
					].join("\n"),
					"info",
				);
				return;
			}

			// default / "reload"
			cfg = loadConfig(ctx);
			activate(ctx);
			if (ctx.hasUI) ctx.ui.notify("pi-status: config reloaded", "info");
		},
	});
}
