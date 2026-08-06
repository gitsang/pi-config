import { spawnSync } from "node:child_process";
import { formatAggregateMarker } from "./aggregate.ts";
import type { ProcessStatusRecord, StatusStore, TmuxLocation } from "./store.ts";

export interface TmuxSinkConfig {
	enabled: boolean;
	idle: string;
	busy: string;
	done: string;
	activeGlyph: string;
	inactiveGlyph: string;
}

type TmuxRunner = (args: string[]) => string;

export function tmuxServerId(tmuxEnvironment: string): string {
	const match = /^(.*,[1-9]\d*),\d+$/.exec(tmuxEnvironment);
	return match?.[1] ?? tmuxEnvironment;
}

export function sameTmuxWindow(
	record: ProcessStatusRecord,
	location: TmuxLocation,
): boolean {
	return record.tmux?.serverId === location.serverId
		&& record.tmux.windowId === location.windowId;
}

export class TmuxStatusSink {
	readonly location: TmuxLocation;
	private readonly store: StatusStore;
	private readonly config: TmuxSinkConfig;
	private readonly run: TmuxRunner;
	private active = false;
	private lastFingerprint = "";
	private lastMarker = "";

	private constructor(
		store: StatusStore,
		config: TmuxSinkConfig,
		run: TmuxRunner,
		location: TmuxLocation,
	) {
		this.store = store;
		this.config = config;
		this.run = run;
		this.location = location;
	}

	static create(
		store: StatusStore,
		config: TmuxSinkConfig,
		environment: NodeJS.ProcessEnv = process.env,
	): TmuxStatusSink | null {
		const tmuxEnvironment = environment.TMUX;
		const paneId = environment.TMUX_PANE;
		if (!tmuxEnvironment || !paneId) return null;
		const run: TmuxRunner = (args) => {
			try {
				const result = spawnSync("tmux", args, {
					encoding: "utf8",
					stdio: ["ignore", "pipe", "ignore"],
					timeout: 1500,
				});
				return result.status === 0 ? (result.stdout ?? "").trim() : "";
			} catch {
				return "";
			}
		};
		const windowId = run(["display-message", "-p", "-t", paneId, "#{window_id}"]);
		if (!windowId) return null;
		return new TmuxStatusSink(store, config, run, {
			serverId: tmuxServerId(tmuxEnvironment),
			windowId,
			paneId,
		});
	}

	start(): void {
		if (this.active) return;
		this.active = true;
		this.patchFormats();
		this.suppressFlags();
		this.sync();
	}

	sync(): void {
		if (!this.active) return;
		const records = this.windowRecords();
		const fingerprint = records
			.map((record) => `${record.pid}:${record.sessionId}:${record.state}`)
			.join("|");
		if (fingerprint === this.lastFingerprint) return;
		this.lastFingerprint = fingerprint;
		this.writeMarker(formatAggregateMarker(
			records.map((record) => record.state),
			this.config,
		));
	}

	windowRecords(): ProcessStatusRecord[] {
		return this.store.list().filter((record) => sameTmuxWindow(record, this.location));
	}

	stop(): void {
		if (!this.active) return;
		const remaining = this.windowRecords();
		if (remaining.length === 0) {
			this.writeMarker(null);
			this.unpatchFormats();
			this.restoreFlags();
		}
		this.active = false;
	}

	description(): string {
		return `${this.location.serverId} window ${this.location.windowId} pane ${this.location.paneId}`;
	}

	private writeMarker(marker: string | null): void {
		const value = marker === null ? "" : `${marker} `;
		if (value === this.lastMarker) return;
		this.lastMarker = value;
		if (marker === null) {
			this.run(["set-window-option", "-q", "-t", this.location.paneId, "-u", "@pi_t"]);
			return;
		}
		this.run(["set-window-option", "-t", this.location.paneId, "@pi_t", value]);
	}

	private patchFormats(): void {
		for (const option of ["window-status-format", "window-status-current-format"] as const) {
			const globalFormat = this.run(["show-options", "-gv", option]);
			if (!globalFormat) continue;
			let patched = globalFormat;
			for (const glyph of [this.config.activeGlyph, this.config.inactiveGlyph]) {
				if (glyph) patched = patched.split(glyph).join("#{@pi_t}");
			}
			if (patched !== globalFormat) {
				this.run(["set-window-option", "-t", this.location.paneId, option, patched]);
			}
		}
	}

	private unpatchFormats(): void {
		for (const option of ["window-status-format", "window-status-current-format"] as const) {
			this.run(["set-window-option", "-q", "-t", this.location.paneId, "-u", option]);
		}
	}

	private suppressFlags(): void {
		this.run(["set-window-option", "-t", this.location.paneId, "monitor-activity", "off"]);
		this.run(["set-window-option", "-t", this.location.paneId, "monitor-bell", "off"]);
	}

	private restoreFlags(): void {
		this.run(["set-window-option", "-q", "-t", this.location.paneId, "-u", "monitor-activity"]);
		this.run(["set-window-option", "-q", "-t", this.location.paneId, "-u", "monitor-bell"]);
	}
}
