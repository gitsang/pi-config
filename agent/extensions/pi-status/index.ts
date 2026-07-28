/**
 * pi-status — mirror pi's generation state onto the tmux window tab and this
 * pi instance's pi-statusline footer.
 *
 * tmux surface (TUI inside tmux): every Pi process publishes its state to a
 * process-keyed window option. The window-level @pi_t marker aggregates all Pi
 * processes in that window, including several terminals inside one tmux pane.
 *
 * statusline surface (all TUI modes): pushes this pi's independent state via
 * ctx.ui.setStatus("pi-status", "idle"|"gen"|"done").
 *
 * Focus is supplied by the standalone pi-focus extension over the
 * "pi-focus:change" event bus channel. pi-status never enables or consumes DEC
 * 1004 itself. When a turn settles while unfocused it enters done; the next
 * focus-in event reverts it to idle.
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
import {
	countStates,
	formatAggregateMarker,
	parseInstanceRecord,
	serializeInstanceRecord,
	type InstanceRecord,
	type State,
} from "./aggregate.ts";

const EXT_DIR = dirname(fileURLToPath(import.meta.url));

/** Event bus channel emitted by the standalone pi-focus extension. */
const FOCUS_CHANNEL = "pi-focus:change";
/** Fixed ext-status key exposed to pi-statusline. */
const STATUS_KEY = "pi-status";

/** One window option per Pi process; values also carry the current session ID. */
const INSTANCE_OPTION_PREFIX = "@pi_status_instance_";
const INSTANCE_OPTION = `${INSTANCE_OPTION_PREFIX}${process.pid}`;

// ─── config ─────────────────────────────────────────────────────────────────
interface TmuxGlyphConfig {
	/** Theme terminal-icon glyphs to replace with #{@pi_t}. */
	activeGlyph?: string;
	inactiveGlyph?: string;
}

interface PiStatusConfig {
	idle?: string;     // idle / default icon
	busy?: string;     // generating icon
	done?: string;     // done badge icon
	enabled?: boolean;
	tmuxGlyph?: TmuxGlyphConfig;
}

interface ResolvedConfig {
	idle: string;
	busy: string;
	done: string;
	enabled: boolean;
	tmuxGlyph: Required<TmuxGlyphConfig>;
}

const DEFAULTS: ResolvedConfig = {
	idle: "\ue22c",
	busy: "\uf110",
	done: "\uf00c",
	enabled: true,
	tmuxGlyph: {
		activeGlyph: "\ue795",    // tokyo-night @powerkit_active_window_icon default
		inactiveGlyph: "\uf489",  // tokyo-night @powerkit_inactive_window_icon default
	},
};

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

function mergeConfig(base: PiStatusConfig, override: PiStatusConfig | null): PiStatusConfig {
	if (!override) return base;
	return {
		...base,
		...override,
		tmuxGlyph: { ...base.tmuxGlyph, ...override.tmuxGlyph },
	};
}

function loadConfig(ctx?: ExtensionContext): ResolvedConfig {
	let raw: PiStatusConfig = {};
	raw = mergeConfig(raw, tryRead(join(getAgentDir(), "pi-status.json")));
	raw = mergeConfig(raw, tryRead(join(EXT_DIR, "config.json")));
	if (ctx?.isProjectTrusted()) {
		raw = mergeConfig(raw, tryRead(join(ctx.cwd, CONFIG_DIR_NAME, "pi-status.json")));
	}
	return {
		idle: raw.idle ?? DEFAULTS.idle,
		busy: raw.busy ?? DEFAULTS.busy,
		done: raw.done ?? DEFAULTS.done,
		enabled: raw.enabled ?? DEFAULTS.enabled,
		tmuxGlyph: {
			activeGlyph: raw.tmuxGlyph?.activeGlyph ?? DEFAULTS.tmuxGlyph.activeGlyph,
			inactiveGlyph: raw.tmuxGlyph?.inactiveGlyph ?? DEFAULTS.tmuxGlyph.inactiveGlyph,
		},
	};
}

// ─── state ──────────────────────────────────────────────────────────────────
let cfg: ResolvedConfig = { ...DEFAULTS };
let ui: ExtensionContext["ui"] | null = null;
let state: State = "idle";
let sessionId = "";
let focused = true;          // supplied by pi-focus; assume focused until first event
let focusSeen = false;
let statusActive = false;    // pi-statusline registration (TUI mode)
let tmuxActive = false;      // tmux window-tab patching (TUI + inside tmux)
let inTmux = !!process.env.TMUX;
let pane = process.env.TMUX_PANE ?? "";
let lastT = "";              // last @pi_t value written by this process

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

function isProcessAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		return (error as NodeJS.ErrnoException).code === "EPERM";
	}
}

function unsetWindowOption(option: string): void {
	tmux(["set-window-option", "-q", "-t", pane, "-u", option]);
}

function writeInstanceState(): void {
	if (!tmuxActive || !sessionId) return;
	tmux([
		"set-window-option",
		"-t",
		pane,
		INSTANCE_OPTION,
		serializeInstanceRecord({ pid: process.pid, sessionId, state }),
	]);
}

function readWindowInstances(): InstanceRecord[] {
	if (!tmuxActive) return [];
	const records: InstanceRecord[] = [];
	const options = tmux(["show-options", "-w", "-t", pane]);
	for (const line of options.split("\n")) {
		const separator = line.indexOf(" ");
		if (separator < 0) continue;
		const option = line.slice(0, separator);
		if (!option.startsWith(INSTANCE_OPTION_PREFIX)) continue;

		const record = parseInstanceRecord(line.slice(separator + 1));
		const optionPid = Number(option.slice(INSTANCE_OPTION_PREFIX.length));
		if (!record || record.pid !== optionPid || !isProcessAlive(record.pid)) {
			unsetWindowOption(option);
			continue;
		}
		records.push(record);
	}
	return records.sort((a, b) => a.pid - b.pid);
}

function recordFingerprint(records: readonly InstanceRecord[]): string {
	return records.map((record) => `${record.pid}:${record.sessionId}:${record.state}`).join("|");
}

// Write the aggregate per-window user option @pi_t with a trailing separator.
function writeMarker(marker: string | null): void {
	if (!tmuxActive) return;
	if (marker === null) {
		lastT = "";
		unsetWindowOption("@pi_t");
		return;
	}
	const t = `${marker} `;
	lastT = t;
	tmux(["set-window-option", "-t", pane, "@pi_t", t]);
}

function syncWindowMarker(): InstanceRecord[] {
	let records = readWindowInstances();
	// A second pass converges if two Pi processes change state at the same time.
	for (let attempt = 0; attempt < 2; attempt += 1) {
		writeMarker(formatAggregateMarker(records.map((record) => record.state), cfg));
		const next = readWindowInstances();
		if (recordFingerprint(next) === recordFingerprint(records)) return next;
		records = next;
	}
	writeMarker(formatAggregateMarker(records.map((record) => record.state), cfg));
	return records;
}

// ─── window-level format patching ───────────────────────────────────────────
function patchFormats(): void {
	if (!tmuxActive) return;
	for (const opt of ["window-status-format", "window-status-current-format"] as const) {
		const g = tmux(["show-options", "-gv", opt]);
		if (!g) continue;
		let patchedFmt = g;
		let changed = false;
		for (const glyph of [cfg.tmuxGlyph.activeGlyph, cfg.tmuxGlyph.inactiveGlyph]) {
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
	try { ui.setStatus(STATUS_KEY, state); } catch { /* ignore */ }
}

function setState(s: State): void {
	if (state === s) return;
	state = s;
	if (tmuxActive) {
		writeInstanceState();
		syncWindowMarker();
	}
	if (statusActive) pushStatus();
}

// ─── lifecycle ──────────────────────────────────────────────────────────────
function activate(ctx: ExtensionContext): void {
	ui = ctx.ui;
	inTmux = !!process.env.TMUX;
	pane = process.env.TMUX_PANE ?? "";
	sessionId = ctx.sessionManager.getSessionId();
	statusActive = cfg.enabled && ctx.mode === "tui";
	tmuxActive = statusActive && inTmux && !!pane;
	if (!statusActive) return;

	state = "idle";
	lastT = "";
	if (tmuxActive) {
		// Register first so a concurrently exiting Pi sees this process as active.
		writeInstanceState();
		syncWindowMarker();
		patchFormats();
		suppressFlags();
	}
	pushStatus();
}

function shutdown(): void {
	if (tmuxActive) {
		unsetWindowOption(INSTANCE_OPTION);
		const remaining = syncWindowMarker();
		if (remaining.length === 0) {
			unpatchFormats();
			restoreFlags();
		}
	}
	if (statusActive && ui) {
		try { ui.setStatus(STATUS_KEY, undefined); } catch { /* ignore */ }
	}
	statusActive = false;
	tmuxActive = false;
	sessionId = "";
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
				if (statusActive || tmuxActive) shutdown();
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
				const instances = tmuxActive ? syncWindowMarker() : [];
				const counts = countStates(instances.map((instance) => instance.state));
				if (ctx.hasUI) ctx.ui.notify(
					[
						`statusActive: ${statusActive}`,
						`tmuxActive: ${tmuxActive}`,
						`in tmux: ${inTmux} (pane ${pane || "—"})`,
						`mode: ${ctx.mode}`,
						`enabled: ${cfg.enabled}`,
						`process: ${process.pid}`,
						`session: ${sessionId || "—"}`,
						`state: ${state}`,
						`window states: idle=${counts.idle}, gen=${counts.gen}, done=${counts.done}`,
						`window instances: ${instances.map((instance) => `${instance.pid}/${instance.sessionId}/${instance.state}`).join(", ") || "(none)"}`,
						`focused (via pi-focus): ${focused}`,
						`focus event seen: ${focusSeen}`,
						`status key: ${STATUS_KEY} (fixed)`,
						`idle: ${cfg.idle}`,
						`busy: ${cfg.busy}`,
						`done: ${cfg.done}`,
						`active glyph: ${cfg.tmuxGlyph.activeGlyph}`,
						`inactive glyph: ${cfg.tmuxGlyph.inactiveGlyph}`,
						`last @pi_t written here: ${lastT || "(none)"}`,
					].join("\n"),
					"info",
				);
				return;
			}

			// default / "reload"
			if (statusActive || tmuxActive) shutdown();
			cfg = loadConfig(ctx);
			activate(ctx);
			if (ctx.hasUI) ctx.ui.notify("pi-status: config reloaded", "info");
		},
	});
}
