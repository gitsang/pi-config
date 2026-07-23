/**
 * pi-tmux-title — mirror pi's generation state onto the tmux window tab.
 *
 * Replaces the tokyo-night theme's terminal icon on pi's tmux window with a
 * state-driven one:
 *
 *   idle (default):  prefix  (\ue22c by default)
 *   generating:      busy    (\uf110)
 *   done:            done    (\uf00c)  — only shown if pi lost focus mid-turn
 *
 * Mechanism (per-window, no global format change):
 *   - reads the *global* window-status-format / window-status-current-format
 *   - replaces the theme's baked-in terminal icon glyph (active \ue795 /
 *     inactive \uf489) with the user option reference #{@pi_t}
 *   - installs the patched formats as WINDOW-LEVEL options on pi's window only
 *     (other windows keep using the global formats with the theme icon)
 *   - sets the per-window user option @pi_t = "<icon> " (icon + trailing space)
 *   - disables per-window monitor-activity / monitor-bell on pi's window so the
 *     theme's icon conditional (#{?window_activity_flag,󰁮,...#{@pi_t}}) always
 *     falls through to #{@pi_t} instead of flipping to the activity glyph when
 *     pi produces output in the background (other windows keep global monitoring)
 *   - tmux keeps managing #W (automatic-rename, manual rename, etc.) — the
 *     real window name is never touched
 *   - on exit, unset @pi_t, the window-level formats, and the monitor overrides
 *     → tab reverts to the global theme format with its original terminal icon
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
	prefix?: string;   // idle / default icon
	busy?: string;     // generating icon
	done?: string;     // done badge icon
	enabled?: boolean;
	/** Theme terminal-icon glyphs to replace with #{@pi_t}, active then inactive. */
	activeGlyph?: string;
	inactiveGlyph?: string;
}

const DEFAULTS: Required<TmuxTitleConfig> = {
	prefix: "\ue22c",
	busy: "\uf110",
	done: "\uf00c",
	enabled: true,
	activeGlyph: "\ue795",    // tokyo-night @powerkit_active_window_icon default
	inactiveGlyph: "\uf489",  // tokyo-night @powerkit_inactive_window_icon default
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
	raw = { ...raw, ...(tryRead(join(getAgentDir(), "pi-tmux-title.json")) ?? {}) };
	raw = { ...raw, ...(tryRead(join(EXT_DIR, "config.json")) ?? {}) };
	if (ctx?.isProjectTrusted()) {
		raw = { ...raw, ...(tryRead(join(ctx.cwd, CONFIG_DIR_NAME, "pi-tmux-title.json")) ?? {}) };
	}
	return { ...DEFAULTS, ...raw };
}

// ─── state ──────────────────────────────────────────────────────────────────
type State = "idle" | "gen" | "done";

let cfg: ResolvedConfig = { ...DEFAULTS };
let state: State = "idle";
let focused = true;
let active = false;            // only true in tui mode inside tmux
let inTmux = !!process.env.TMUX;
let pane = process.env.TMUX_PANE ?? "";
let lastT = "";                // last @pi_t value written (dedupe)
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

// ─── window-level format patching ───────────────────────────────────────────
// Take the *global* format, replace the theme's terminal-icon glyphs with the
// reference #{@pi_t}, and install it as a window-level option on pi's window
// only. Other windows keep the global format with the original theme icon.
function patchFormats(): void {
	if (!active) return;
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
// pi's window drives its own state icon (idle/busy/done), so tmux's automatic
// activity/bell flags are redundant there — and worse, they take precedence in
// the theme's icon conditional (#{?window_activity_flag,󰁮,...#{@pi_t}}). With
// global `monitor-activity on`, switching away from pi makes any output
// (spinner/statusline/generation) set window_activity_flag, flipping the tab
// to the activity glyph 󰁮 and hiding #{@pi_t}. Disable per-window monitoring
// so the conditional always falls through to #{@pi_t}; other windows keep the
// global monitor-activity/monitor-bell behaviour.
function suppressFlags(): void {
	if (!active) return;
	tmux(["set-window-option", "-t", pane, "monitor-activity", "off"]);
	tmux(["set-window-option", "-t", pane, "monitor-bell", "off"]);
}

function restoreFlags(): void {
	if (!pane) return;
	tmux(["set-window-option", "-q", "-t", pane, "-u", "monitor-activity"]);
	tmux(["set-window-option", "-q", "-t", pane, "-u", "monitor-bell"]);
}

// ─── DEC 1004 focus tracking (zero polling) ────────────────────────────────
function enableFocusReporting(ctx: ExtensionContext): void {
	if (unsubInput) return;
	// Check focus-events; warn once if off (tmux won't forward pane-switch events).
	const fe = tmux(["show-options", "-gv", "focus-events"]);
	if (fe !== "on" && !warnedFocusEvents) {
		warnedFocusEvents = true;
		ctx.ui.notify("pi-tmux-title: set `set -g focus-events on` for done-badge focus revert", "warning");
	}
	try {
		process.stdout.write("\x1b[?1004h");
	} catch { /* ignore */ }
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
	suppressFlags();
	enableFocusReporting(ctx);
	state = "idle";
	lastT = "";
	writeMarker(cfg.prefix);
}

function shutdown(): void {
	if (!active) return;
	tmux(["set-window-option", "-q", "-t", pane, "-u", "@pi_t"]);
	unpatchFormats();
	restoreFlags();
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
					if (ctx.hasUI) ctx.ui.notify("usage: /tmux-title state idle|gen|done", "warning");
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
				if (ctx.hasUI) ctx.ui.notify(
					[
						`active: ${active}`,
						`in tmux: ${inTmux} (pane ${pane || "—"})`,
						`mode: ${ctx.mode}`,
						`enabled: ${cfg.enabled}`,
						`state: ${state}`,
						`focused: ${focused}`,
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
			if (ctx.hasUI) ctx.ui.notify("pi-tmux-title: config reloaded", "info");
		},
	});
}
