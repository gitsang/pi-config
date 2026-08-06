import {
	mkdirSync,
	readFileSync,
	readdirSync,
	renameSync,
	rmSync,
	watch,
	writeFileSync,
	type FSWatcher,
} from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import type { State } from "./aggregate.ts";

export const STATUS_UPDATE_CHANNEL = "pi-status:update";
const RECORD_VERSION = 1;
const RECORD_FILE_RE = /^(\d+)\.json$/;

export interface TmuxLocation {
	serverId: string;
	windowId: string;
	paneId: string;
}

export interface ProcessStatusRecord {
	version: typeof RECORD_VERSION;
	pid: number;
	sessionId: string;
	state: State;
	updatedAt: number;
	tmux?: TmuxLocation;
}

export interface PublishedStatus {
	sessionId: string;
	state: State;
	tmux?: TmuxLocation;
}

export interface StatusUpdateEvent {
	directory: string;
	pid?: number;
}

type StatusListener = (event: StatusUpdateEvent) => void;
type ProcessProbe = (pid: number) => boolean;

export function defaultStatusStoreDirectory(): string {
	const runtimeDir = process.env.XDG_RUNTIME_DIR;
	if (runtimeDir && isAbsolute(runtimeDir)) return join(runtimeDir, "pi-status");
	const uid = typeof process.getuid === "function" ? process.getuid() : "user";
	return join(tmpdir(), `pi-status-${uid}`);
}

export function isProcessAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		return (error as NodeJS.ErrnoException).code === "EPERM";
	}
}

function isState(value: unknown): value is State {
	return value === "idle" || value === "gen" || value === "done";
}

function isTmuxLocation(value: unknown): value is TmuxLocation {
	if (!value || typeof value !== "object" || Array.isArray(value)) return false;
	const tmux = value as Partial<TmuxLocation>;
	return typeof tmux.serverId === "string" && tmux.serverId.length > 0
		&& typeof tmux.windowId === "string" && tmux.windowId.length > 0
		&& typeof tmux.paneId === "string";
}

export function parseStatusRecord(value: unknown): ProcessStatusRecord | null {
	if (!value || typeof value !== "object" || Array.isArray(value)) return null;
	const record = value as Partial<ProcessStatusRecord>;
	if (
		record.version !== RECORD_VERSION ||
		typeof record.pid !== "number" ||
		!Number.isSafeInteger(record.pid) ||
		record.pid <= 0 ||
		typeof record.sessionId !== "string" ||
		record.sessionId.length === 0 ||
		!isState(record.state) ||
		typeof record.updatedAt !== "number" ||
		!Number.isFinite(record.updatedAt) ||
		(record.tmux !== undefined && !isTmuxLocation(record.tmux))
	) {
		return null;
	}
	return record as ProcessStatusRecord;
}

export class StatusStore {
	readonly directory: string;
	private readonly pid: number;
	private readonly probe: ProcessProbe;
	private readonly listeners = new Set<StatusListener>();
	private watcher: FSWatcher | null = null;

	constructor(
		directory = defaultStatusStoreDirectory(),
		pid = process.pid,
		probe: ProcessProbe = isProcessAlive,
	) {
		this.directory = resolve(directory);
		this.pid = pid;
		this.probe = probe;
		this.ensureDirectory();
	}

	publish(status: PublishedStatus): ProcessStatusRecord {
		this.ensureDirectory();
		const record: ProcessStatusRecord = {
			version: RECORD_VERSION,
			pid: this.pid,
			sessionId: status.sessionId,
			state: status.state,
			updatedAt: Date.now(),
			...(status.tmux ? { tmux: status.tmux } : {}),
		};
		const destination = this.recordPath(this.pid);
		const temporary = join(
			this.directory,
			`.${this.pid}.${process.hrtime.bigint()}.tmp`,
		);
		try {
			writeFileSync(temporary, `${JSON.stringify(record)}\n`, {
				encoding: "utf8",
				flag: "wx",
				mode: 0o600,
			});
			renameSync(temporary, destination);
		} catch (error) {
			rmSync(temporary, { force: true });
			throw error;
		}
		this.emit({ directory: this.directory, pid: this.pid });
		return record;
	}

	remove(): void {
		rmSync(this.recordPath(this.pid), { force: true });
		this.emit({ directory: this.directory, pid: this.pid });
	}

	get(pid: number, sessionId?: string): ProcessStatusRecord | null {
		const record = this.readRecord(this.recordPath(pid), pid);
		if (!record || (sessionId !== undefined && record.sessionId !== sessionId)) return null;
		return record;
	}

	list(): ProcessStatusRecord[] {
		this.ensureDirectory();
		const records: ProcessStatusRecord[] = [];
		for (const entry of readdirSync(this.directory, { withFileTypes: true })) {
			if (!entry.isFile()) continue;
			const match = RECORD_FILE_RE.exec(entry.name);
			if (!match) continue;
			const pid = Number(match[1]);
			const record = this.readRecord(join(this.directory, entry.name), pid);
			if (record) records.push(record);
		}
		return records.sort((a, b) => a.pid - b.pid);
	}

	subscribe(listener: StatusListener): () => void {
		this.listeners.add(listener);
		this.startWatcher();
		return () => {
			this.listeners.delete(listener);
			if (this.listeners.size === 0) this.stopWatcher();
		};
	}

	close(): void {
		this.stopWatcher();
		this.listeners.clear();
	}

	private ensureDirectory(): void {
		mkdirSync(this.directory, { recursive: true, mode: 0o700 });
	}

	private recordPath(pid: number): string {
		return join(this.directory, `${pid}.json`);
	}

	private readRecord(path: string, expectedPid: number): ProcessStatusRecord | null {
		let parsed: unknown;
		try {
			parsed = JSON.parse(readFileSync(path, "utf8"));
		} catch {
			rmSync(path, { force: true });
			return null;
		}
		const record = parseStatusRecord(parsed);
		if (!record || record.pid !== expectedPid || !this.probe(record.pid)) {
			rmSync(path, { force: true });
			return null;
		}
		return record;
	}

	private startWatcher(): void {
		if (this.watcher) return;
		this.ensureDirectory();
		this.watcher = watch(
			this.directory,
			{ persistent: false },
			(_eventType, filename) => {
				const match = filename ? RECORD_FILE_RE.exec(String(filename)) : null;
				if (filename && !match) return;
				this.emit({
					directory: this.directory,
					...(match ? { pid: Number(match[1]) } : {}),
				});
			},
		);
		this.watcher.on("error", () => {
			this.stopWatcher();
		});
	}

	private stopWatcher(): void {
		this.watcher?.close();
		this.watcher = null;
	}

	private emit(event: StatusUpdateEvent): void {
		for (const listener of this.listeners) {
			try {
				listener(event);
			} catch {
				// One projection must not prevent other projections from updating.
			}
		}
	}
}
