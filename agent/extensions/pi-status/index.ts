/**
 * pi-status - publish each Pi process state to a shared store, then project it
 * onto environment-specific surfaces.
 *
 * Flow:
 *   Pi lifecycle -> shared per-process status store -> pi-status:update
 *     -> tmux sink: aggregate records for this tmux window and update @pi_t
 *     -> statusline sink: read this process record and update ext-status
 *
 * Focus is supplied by the standalone pi-focus extension. When a turn settles
 * while unfocused it enters done; the next focus-in event returns it to idle.
 *
 * Config precedence (later layers override earlier ones):
 *   ~/.pi/agent/pi-tmux-status.json (legacy)
 *   ~/.pi/agent/pi-status.json
 *   ./config.json
 *   <cwd>/.pi/pi-tmux-status.json (legacy, trusted projects only)
 *   <cwd>/.pi/pi-status.json (trusted projects only)
 *
 * Command: /pi-status [reload|on|off|state idle|gen|done|status]
 */

import {
	CONFIG_DIR_NAME,
	getAgentDir,
	type ExtensionAPI,
	type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { countStates, type State } from "./aggregate.ts";
import {
	STATUS_UPDATE_CHANNEL,
	StatusStore,
	defaultStatusStoreDirectory,
	type StatusUpdateEvent,
} from "./store.ts";
import { StatuslineStatusSink } from "./statusline.ts";
import { TmuxStatusSink, type TmuxSinkConfig } from "./tmux.ts";

const EXT_DIR = dirname(fileURLToPath(import.meta.url));
const FOCUS_CHANNEL = "pi-focus:change";

interface RawStoreConfig {
	directory?: string;
}

interface RawStatuslineConfig {
	enabled?: boolean;
	key?: string;
}

interface RawTmuxConfig {
	enabled?: boolean;
	idle?: string;
	busy?: string;
	done?: string;
	activeGlyph?: string;
	inactiveGlyph?: string;
}

interface LegacyTmuxGlyphConfig {
	activeGlyph?: string;
	inactiveGlyph?: string;
}

interface PiStatusConfig {
	enabled?: boolean;
	store?: RawStoreConfig;
	statusline?: RawStatuslineConfig;
	tmux?: RawTmuxConfig;

	// Legacy flat pi-status/pi-tmux-status fields.
	idle?: string;
	busy?: string;
	done?: string;
	statusKey?: string;
	tmuxGlyph?: LegacyTmuxGlyphConfig;
}

interface ResolvedConfig {
	enabled: boolean;
	store: { directory: string };
	statusline: Required<RawStatuslineConfig>;
	tmux: TmuxSinkConfig;
}

const DEFAULTS: ResolvedConfig = {
	enabled: true,
	store: { directory: defaultStatusStoreDirectory() },
	statusline: {
		enabled: true,
		key: "pi-status",
	},
	tmux: {
		enabled: true,
		idle: "\ue22c",
		busy: "\uf110",
		done: "\uf00c",
		activeGlyph: "\ue795",
		inactiveGlyph: "\uf489",
	},
};

function tryRead(path: string): PiStatusConfig | null {
	try {
		const parsed = JSON.parse(readFileSync(path, "utf8"));
		return parsed && typeof parsed === "object" && !Array.isArray(parsed)
			? (parsed as PiStatusConfig)
			: null;
	} catch {
		return null;
	}
}

function normalizeConfigLayer(raw: PiStatusConfig): PiStatusConfig {
	return {
		...raw,
		statusline: {
			...(raw.statusKey !== undefined ? { key: raw.statusKey } : {}),
			...raw.statusline,
		},
		tmux: {
			...(raw.idle !== undefined ? { idle: raw.idle } : {}),
			...(raw.busy !== undefined ? { busy: raw.busy } : {}),
			...(raw.done !== undefined ? { done: raw.done } : {}),
			...raw.tmuxGlyph,
			...raw.tmux,
		},
	};
}

function mergeConfig(base: PiStatusConfig, override: PiStatusConfig | null): PiStatusConfig {
	if (!override) return base;
	const normalized = normalizeConfigLayer(override);
	return {
		...base,
		...normalized,
		store: { ...base.store, ...normalized.store },
		statusline: { ...base.statusline, ...normalized.statusline },
		tmux: { ...base.tmux, ...normalized.tmux },
	};
}

function loadConfig(ctx: ExtensionContext): ResolvedConfig {
	let raw: PiStatusConfig = {};
	for (const path of [
		join(getAgentDir(), "pi-tmux-status.json"),
		join(getAgentDir(), "pi-status.json"),
		join(EXT_DIR, "config.json"),
	]) {
		raw = mergeConfig(raw, tryRead(path));
	}
	if (ctx.isProjectTrusted()) {
		for (const path of [
			join(ctx.cwd, CONFIG_DIR_NAME, "pi-tmux-status.json"),
			join(ctx.cwd, CONFIG_DIR_NAME, "pi-status.json"),
		]) {
			raw = mergeConfig(raw, tryRead(path));
		}
	}

	return {
		enabled: raw.enabled ?? DEFAULTS.enabled,
		store: {
			directory: raw.store?.directory || DEFAULTS.store.directory,
		},
		statusline: {
			enabled: raw.statusline?.enabled ?? DEFAULTS.statusline.enabled,
			key: raw.statusline?.key ?? raw.statusKey ?? DEFAULTS.statusline.key,
		},
		tmux: {
			enabled: raw.tmux?.enabled ?? DEFAULTS.tmux.enabled,
			idle: raw.tmux?.idle ?? raw.idle ?? DEFAULTS.tmux.idle,
			busy: raw.tmux?.busy ?? raw.busy ?? DEFAULTS.tmux.busy,
			done: raw.tmux?.done ?? raw.done ?? DEFAULTS.tmux.done,
			activeGlyph:
				raw.tmux?.activeGlyph ?? raw.tmuxGlyph?.activeGlyph ?? DEFAULTS.tmux.activeGlyph,
			inactiveGlyph:
				raw.tmux?.inactiveGlyph ?? raw.tmuxGlyph?.inactiveGlyph ?? DEFAULTS.tmux.inactiveGlyph,
		},
	};
}

let cfg: ResolvedConfig = DEFAULTS;
let state: State = "idle";
let sessionId = "";
let focused = true;
let focusSeen = false;
let active = false;
let store: StatusStore | null = null;
let tmuxSink: TmuxStatusSink | null = null;
let statuslineSink: StatuslineStatusSink | null = null;
let unsubscribeStore: (() => void) | null = null;
let exitCleanupRegistered = false;

function publishState(): void {
	if (!active || !store || !sessionId) return;
	store.publish({
		sessionId,
		state,
		tmux: tmuxSink?.location,
	});
}

function setState(next: State): void {
	state = next;
	publishState();
}

function handleStatusUpdate(event: unknown): void {
	if (!active || !store) return;
	if (
		event &&
		typeof event === "object" &&
		"directory" in event &&
		(event as StatusUpdateEvent).directory !== store.directory
	) {
		return;
	}
	tmuxSink?.sync();
	statuslineSink?.sync();
}

function handleFocusEvent(data: unknown): void {
	if (!data || typeof data !== "object") return;
	const next = (data as { focused?: unknown }).focused;
	if (typeof next !== "boolean") return;
	focusSeen = true;
	focused = next;
	if (focused && state === "done") setState("idle");
}

function activate(pi: ExtensionAPI, ctx: ExtensionContext): void {
	if (!cfg.enabled) return;
	state = "idle";
	sessionId = ctx.sessionManager.getSessionId();
	store = new StatusStore(cfg.store.directory);
	tmuxSink = cfg.tmux.enabled ? TmuxStatusSink.create(store, cfg.tmux) : null;
	statuslineSink = ctx.mode === "tui" && cfg.statusline.enabled
		? new StatuslineStatusSink(store, ctx.ui, cfg.statusline.key, sessionId)
		: null;

	tmuxSink?.start();
	unsubscribeStore = store.subscribe((event) => {
		pi.events.emit(STATUS_UPDATE_CHANNEL, event);
	});
	active = true;
	registerExitCleanup();
	publishState();
}

function deactivate(): void {
	if (!active && !store) return;
	active = false;
	store?.remove();
	// remove() emits synchronously, but active is already false. Pull once more so
	// the surfaces observe the deletion before their resources are torn down.
	tmuxSink?.sync();
	statuslineSink?.sync();
	statuslineSink?.stop();
	tmuxSink?.stop();
	unsubscribeStore?.();
	store?.close();
	unsubscribeStore = null;
	statuslineSink = null;
	tmuxSink = null;
	store = null;
	sessionId = "";
}

function handleProcessExit(): void {
	exitCleanupRegistered = false;
	deactivate();
}

function registerExitCleanup(): void {
	if (exitCleanupRegistered) return;
	process.once("exit", handleProcessExit);
	exitCleanupRegistered = true;
}

function unregisterExitCleanup(): void {
	if (!exitCleanupRegistered) return;
	process.off("exit", handleProcessExit);
	exitCleanupRegistered = false;
}

export default function (pi: ExtensionAPI): void {
	pi.events.on(FOCUS_CHANNEL, handleFocusEvent);
	pi.events.on(STATUS_UPDATE_CHANNEL, handleStatusUpdate);

	pi.on("session_start", (_event, ctx) => {
		cfg = loadConfig(ctx);
		activate(pi, ctx);
	});

	pi.on("before_provider_request", () => {
		if (active) setState("gen");
	});

	pi.on("agent_settled", () => {
		if (active) setState(focused ? "idle" : "done");
	});

	pi.on("session_shutdown", () => {
		deactivate();
		unregisterExitCleanup();
	});

	pi.registerCommand("pi-status", {
		description: "Pi process status: [reload|on|off|state <s>|status]",
		handler: async (args, ctx) => {
			const parts = args.trim().split(/\s+/);
			const sub = (parts[0] ?? "").toLowerCase();

			if (sub === "off") {
				deactivate();
				unregisterExitCleanup();
				cfg = { ...cfg, enabled: false };
				if (ctx.hasUI) ctx.ui.notify("pi-status: disabled", "info");
				return;
			}
			if (sub === "on") {
				deactivate();
				cfg = { ...cfg, enabled: true };
				activate(pi, ctx);
				if (ctx.hasUI) ctx.ui.notify("pi-status: enabled", "info");
				return;
			}
			if (sub === "state") {
				const next = (parts[1] ?? "").toLowerCase();
				if (next !== "idle" && next !== "gen" && next !== "done") {
					if (ctx.hasUI) ctx.ui.notify("usage: /pi-status state idle|gen|done", "warning");
					return;
				}
				if (!active) {
					cfg = { ...cfg, enabled: true };
					activate(pi, ctx);
				}
				setState(next);
				if (ctx.hasUI) ctx.ui.notify(`pi-status: state -> ${next}`, "info");
				return;
			}
			if (sub === "status") {
				const records = store?.list() ?? [];
				const windowRecords = tmuxSink?.windowRecords() ?? [];
				const counts = countStates(windowRecords.map((record) => record.state));
				if (ctx.hasUI) {
					ctx.ui.notify(
						[
							`active: ${active}`,
							`mode: ${ctx.mode}`,
							`process: ${process.pid}`,
							`session: ${sessionId || "(none)"}`,
							`state: ${state}`,
							`store: ${store?.directory ?? cfg.store.directory}`,
							`store records: ${records.length}`,
							`tmux: ${tmuxSink?.description() ?? "inactive"}`,
							`window states: idle=${counts.idle}, gen=${counts.gen}, done=${counts.done}`,
							`statusline key: ${cfg.statusline.enabled ? cfg.statusline.key : "disabled"}`,
							`focused (via pi-focus): ${focused}`,
							`focus event seen: ${focusSeen}`,
						].join("\n"),
						"info",
					);
				}
				return;
			}

			deactivate();
			unregisterExitCleanup();
			cfg = loadConfig(ctx);
			activate(pi, ctx);
			if (ctx.hasUI) ctx.ui.notify("pi-status: config reloaded", "info");
		},
	});
}
