import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { State } from "./aggregate.ts";
import type { StatusStore } from "./store.ts";

/** Projects this process's shared record into pi-statusline's ext-status map. */
export class StatuslineStatusSink {
	private readonly store: StatusStore;
	private readonly ui: ExtensionContext["ui"];
	private readonly key: string;
	private readonly sessionId: string;
	private readonly pid: number;
	private lastState: State | undefined;

	constructor(
		store: StatusStore,
		ui: ExtensionContext["ui"],
		key: string,
		sessionId: string,
		pid = process.pid,
	) {
		this.store = store;
		this.ui = ui;
		this.key = key;
		this.sessionId = sessionId;
		this.pid = pid;
	}

	sync(): void {
		const state = this.store.get(this.pid, this.sessionId)?.state;
		if (state === this.lastState) return;
		this.lastState = state;
		try {
			this.ui.setStatus(this.key, state);
		} catch {
			// UI teardown may race a final filesystem event.
		}
	}

	stop(): void {
		this.lastState = undefined;
		try {
			this.ui.setStatus(this.key, undefined);
		} catch {
			// Ignore shutdown races.
		}
	}
}
