/**
 * pi-metrics store — append-only JSONL event log + in-memory aggregate index.
 *
 * Storage: events.jsonl inside the extension directory (path passed in by
 * index.ts), one JSON object per line.
 * On startup the log is replayed to rebuild the in-memory index; afterwards
 * each event is applied incrementally. Corrupted lines are skipped, so a
 * crash mid-write never breaks loading.
 *
 * Event schema (v:1):
 *   {"v":1,"type":"session","ts":...,"sid":"...","cwd":"...","reason":"startup"}
 *   {"v":1,"type":"prompt","ts":...,"sid":"...","cwd":"..."}
 *   {"v":1,"type":"usage","ts":...,"sid":"...","cwd":"...","provider":"...","model":"...",
 *    "src":"msg"|"compact"|"tree","in":0,"out":0,"cr":0,"cw":0,"cost":0.0}
 *
 * Day/month buckets use the local timezone.
 */

import { appendFileSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

export type UsageSource = "msg" | "compact" | "tree";

export type MetricsEvent =
	| { v: 1; type: "session"; ts: number; sid: string; cwd: string; reason: string }
	| { v: 1; type: "prompt"; ts: number; sid: string; cwd: string }
	| {
			v: 1;
			type: "usage";
			ts: number;
			sid: string;
			cwd: string;
			provider: string;
			model: string;
			src: UsageSource;
			in: number;
			out: number;
			cr: number;
			cw: number;
			cost: number;
	  };

export interface Bucket {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	cost: number;
	prompts: number;
	sessions: number;
	messages: number;
}

export function emptyBucket(): Bucket {
	return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, prompts: 0, sessions: 0, messages: 0 };
}

/** Total tokens flowing through the provider (all four usage components). */
export function bucketTokens(b: Bucket): number {
	return b.input + b.output + b.cacheRead + b.cacheWrite;
}

function pad2(n: number): string {
	return n < 10 ? `0${n}` : String(n);
}

/** Local-timezone day key: YYYY-MM-DD */
export function dayKey(ts: number): string {
	const d = new Date(ts);
	return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

/** Local-timezone month key: YYYY-MM */
export function monthKey(ts: number): string {
	const d = new Date(ts);
	return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}`;
}

export class MetricsStore {
	readonly file: string;
	private readonly days = new Map<string, Bucket>();
	private readonly months = new Map<string, Bucket>();
	private readonly totalBucket: Bucket = emptyBucket();
	private readonly knownSids = new Set<string>();

	constructor(dataDir: string) {
		mkdirSync(dataDir, { recursive: true });
		this.file = join(dataDir, "events.jsonl");
		this.load();
	}

	private load(): void {
		let text: string;
		try {
			text = readFileSync(this.file, "utf8");
		} catch {
			return; // no log yet
		}
		for (const line of text.split("\n")) {
			if (!line) continue;
			try {
				const ev = JSON.parse(line) as MetricsEvent;
				if (ev && typeof ev === "object" && typeof ev.ts === "number" && typeof ev.type === "string") {
					this.apply(ev);
				}
			} catch {
				// skip corrupted line
			}
		}
	}

	/** Append to the log (best-effort) and update the in-memory index. */
	record(ev: MetricsEvent): void {
		try {
			appendFileSync(this.file, `${JSON.stringify(ev)}\n`);
		} catch {
			// metrics must never break the session
		}
		this.apply(ev);
	}

	private bucketFor(map: Map<string, Bucket>, key: string): Bucket {
		let b = map.get(key);
		if (!b) {
			b = emptyBucket();
			map.set(key, b);
		}
		return b;
	}

	private apply(ev: MetricsEvent): void {
		const targets = [this.bucketFor(this.days, dayKey(ev.ts)), this.bucketFor(this.months, monthKey(ev.ts)), this.totalBucket];
		switch (ev.type) {
			case "session":
				this.knownSids.add(ev.sid);
				for (const b of targets) b.sessions++;
				break;
			case "prompt":
				for (const b of targets) b.prompts++;
				break;
			case "usage":
				for (const b of targets) {
					b.input += ev.in;
					b.output += ev.out;
					b.cacheRead += ev.cr;
					b.cacheWrite += ev.cw;
					b.cost += ev.cost;
					b.messages++;
				}
				break;
		}
	}

	/** True if this session id was already counted (across processes). */
	hasSession(sid: string): boolean {
		return this.knownSids.has(sid);
	}

	today(): Bucket {
		return this.days.get(dayKey(Date.now())) ?? emptyBucket();
	}

	thisMonth(): Bucket {
		return this.months.get(monthKey(Date.now())) ?? emptyBucket();
	}

	total(): Bucket {
		return this.totalBucket;
	}
}
