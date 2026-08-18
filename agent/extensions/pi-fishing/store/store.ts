import { appendFileSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createInitialState, type GameState } from "../core/game-state.ts";
import { migrateState } from "./migrate.ts";

export interface FishingStoreOptions {
	defaults?: Partial<GameState>;
	saveDebounceMs?: number;
}

interface LogLine {
	v: 1;
	ts: number;
	event: unknown;
	effects: unknown[];
	state: GameState;
}

export class FishingStore {
	readonly dataDir: string;
	readonly stateFile: string;
	readonly eventLogFile: string;

	private state: GameState;
	private readonly defaults: Partial<GameState>;
	private readonly saveDebounceMs: number;
	private saveTimer: ReturnType<typeof setTimeout> | undefined;

	constructor(dataDir: string, options: FishingStoreOptions = {}) {
		this.dataDir = dataDir;
		this.defaults = options.defaults ?? {};
		this.saveDebounceMs = options.saveDebounceMs ?? 1000;
		mkdirSync(this.dataDir, { recursive: true });
		this.stateFile = join(this.dataDir, "state.json");
		this.eventLogFile = join(this.dataDir, "events.jsonl");
		this.state = this.load();
	}

	getState(): GameState {
		return this.state;
	}

	record(event: unknown, effects: unknown[], state: GameState): void {
		this.state = state;
		try {
			const line: LogLine = { v: 1, ts: Date.now(), event, effects, state };
			appendFileSync(this.eventLogFile, `${JSON.stringify(line)}\n`);
		} catch {
			// 游戏日志失败不能影响主流程
		}
		this.scheduleSave();
	}

	scheduleSave(): void {
		if (this.saveTimer) return;
		this.saveTimer = setTimeout(() => {
			this.saveTimer = undefined;
			this.saveNow();
		}, this.saveDebounceMs);
	}

	saveNow(): void {
		if (this.saveTimer) {
			clearTimeout(this.saveTimer);
			this.saveTimer = undefined;
		}
		try {
			const tmp = `${this.stateFile}.tmp`;
			writeFileSync(tmp, JSON.stringify({ ...this.state, savedAt: Date.now() }, null, 2));
			renameSync(tmp, this.stateFile);
		} catch {
			// 存档失败不能影响主流程
		}
	}

	private load(): GameState {
		try {
			const text = readFileSync(this.stateFile, "utf8");
			const parsed = JSON.parse(text) as unknown;
			return migrateState(parsed);
		} catch {
			return this.loadFromLog();
		}
	}

	private loadFromLog(): GameState {
		try {
			const text = readFileSync(this.eventLogFile, "utf8");
			const lines = text.split("\n").filter((line) => line.trim().length > 0);
			for (let i = lines.length - 1; i >= 0; i -= 1) {
				try {
					const line = JSON.parse(lines[i]!) as Partial<LogLine>;
					if (line && typeof line === "object" && line.state) {
						return migrateState(line.state);
					}
				} catch {
					// 跳过损坏的日志行
				}
			}
		} catch {
			// 没有日志文件，使用初始状态
		}
		return createInitialState(this.defaults);
	}
}
