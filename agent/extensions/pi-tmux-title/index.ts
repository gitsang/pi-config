/**
 * pi-tmux-title — mirror pi's generation state onto the tmux window tab.
 *
 * Replaces the tokyo-night theme's terminal icon on pi's tmux window with a
 * state-driven one:
 *
 *   idle (default):  prefix  (\ue22c by default)
 *   generating:      busy    (\uf110)
 *   done:            done    (\uf00c)  — badge if pi's window was inactive when the turn finished
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
 * Focus tracking (tmux-internal — no terminal focus reporting required):
 *   - done badge shown only if pi's window is inactive when the turn settles
 *     (you were on another tmux window); if you were watching, it goes idle.
 *   - while "done", polls #{window_active}; reverts to idle when you switch
 *     back to pi's window.
 *   - uses tmux's own window-active state, so it works over ssh and inside
 *     nvim terminals where DEC 1004 (ESC[I/ESC[O) focus reporting is absent.
 *
 * No-op outside tmux or outside TUI mode. Active only for pi's own pane
 * ($TMUX_PANE).
 *
 * Config (precedence: later overrides earlier):
 *   global     ~/.pi/agent/pi-tmux-title.json
 *   extension  <ext-dir>/config.json        (next to this file)
 *   project    <cwd>/.pi/pi-tmux-title.json  (trusted projects only)
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
let active = false;            // only true in tui mode inside tmux
let inTmux = !!process.env.TMUX;
let pane = process.env.TMUX_PANE ?? "";
let lastT = "";                // last @pi_t value written (dedupe)
let pollTimer: ReturnType<typeof setInterval> | null = null;

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

// Is pi's window currently the active window of its session? tmux-internal,
// so it works regardless of terminal focus reporting (ssh, nvim, etc.).
function windowActive(): boolean {
	return tmux(["display-message", "-p", "-t", pane, "#{window_active}"]) === "1";
}

// Write the per-window user option @pi_t = "<icon> ". Dedupe by value.
function writeMarker(icon: string): void {
	if (!active) return;
	const t = `${icon} `;
	if (t === lastT) return;
	lastT = t;
	tmux(["set-window-option", "-t", pane, "@pi_t", t]);
}

// While showing the done badge, poll window-active so we revert to idle the
// moment the user switches back to pi's window. Stopped otherwise.
function updatePoll(): void {
	if (pollTimer) {
		clearInterval(pollTimer);
		pollTimer = null;
	}
	if (!active || state !== "done") return;
	pollTimer = setInterval(() => {
		if (!active) {
			if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
			return;
		}
		if (windowActive()) setState("idle");
	}, 1000);
}

function setState(s: State): void {
	state = s;
	writeMarker(iconFor(s));
	updatePoll();
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

// ─── lifecycle ──────────────────────────────────────────────────────────────
function activate(ctx: ExtensionContext): void {
	active = cfg.enabled && inTmux && !!pane && ctx.mode === "tui";
	if (!active) return;
	patchFormats();
	suppressFlags();
	state = "idle";
	lastT = "";
	writeMarker(cfg.prefix);
}

function shutdown(): void {
	if (pollTimer) {
		clearInterval(pollTimer);
		pollTimer = null;
	}
	if (!active) return;
	tmux(["set-window-option", "-q", "-t", pane, "-u", "@pi_t"]);
	unpatchFormats();
	restoreFlags();
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
		// Done badge only if pi's window was inactive when the turn finished
		// (you were on another tmux window); if you were watching, go idle.
		setState(windowActive() ? "idle" : "done");
	});

	process.on("exit", shutdown);
}
