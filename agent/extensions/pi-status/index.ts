/**
 * pi-status — mirror pi's generation state onto the tmux window tab and this
 * pi instance's pi-statusline footer.
 *
 * tmux surface (TUI inside tmux): keeps the existing WINDOW-LEVEL @pi_t
 * mechanism. Several pi panes in one tmux window intentionally overwrite each
 * other (last writer wins).
 *
 * statusline surface (all TUI modes): pushes this pi's independent state via
 * ctx.ui.setStatus(statusKey, "idle"|"gen"|"done").
 *
 * Focus is supplied by the standalone pi-focus extension over the
 * "pi-focus:change" event bus channel. pi-status never enables or consumes DEC
 * 1004 itself. When a turn settles while unfocused it enters done; the next
 * focus-in event reverts it to idle/prefix.
 *
 * Config precedence:
 *   ~/.pi/agent/pi-status.json < ./config.json < <cwd>/.pi/pi-status.json
 *
 * Command: /pi-status [reload|on|off|state idle|gen|done|status]
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

/** Event bus channel emitted by the standalone pi-focus extension. */
const FOCUS_CHANNEL = "pi-focus:change";

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
let ui: ExtensionContext["ui"] | null = null;
let state: State = "idle";
let focused = true;          // supplied by pi-focus; assume focused until first event
let focusSeen = false;
let statusActive = false;    // pi-statusline registration (TUI mode)
let tmuxActive = false;      // tmux window-tab patching (TUI + inside tmux)
let inTmux = !!process.env.TMUX;
let pane = process.env.TMUX_PANE ?? "";
let lastT = "";              // last @pi_t value written (dedupe)

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

// ─── focus subscription ─────────────────────────────────────────────────────
function handleFocusEvent(data: unknown): void {
	if (!data || typeof data !== "object") return;
	const next = (data as { focused?: unknown }).focused;
	if (typeof next !== "boolean") return;
	focusSeen = true;
	focused = next;
	if (focused && state === "done") setState("idle");
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
	pi.events.on(FOCUS_CHANNEL, handleFocusEvent);

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
		// pi-focus supplies pane/terminal focus; focus-in later reverts done→idle.
		setState(focused ? "idle" : "done");
	});

	pi.on("session_shutdown", () => shutdown());

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
						`focused (via pi-focus): ${focused}`,
						`focus event seen: ${focusSeen}`,
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
