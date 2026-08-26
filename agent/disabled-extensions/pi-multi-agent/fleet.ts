/**
 * Lightweight in-process fleet panel for pi-multi-agent.
 *
 * Tracks every sub-agent run started by this pi process. Records are kept in
 * memory only; they reset when the main session process exits. This is
 * deliberately simple — use `/delegate-fleet` to inspect the current state.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { UsageStats } from "./subprocess.ts";

export type RunStatus = "queued" | "running" | "completed" | "failed";

export interface FleetRecord {
	id: string;
	/** delegate mode that spawned this run. */
	mode: string;
	agent: string;
	status: RunStatus;
	model?: string;
	startedAt: number;
	finishedAt?: number;
	pid?: number;
	cwd: string;
	task: string;
	usage: UsageStats;
	errorMessage?: string;
}

export class FleetStore {
	private runs = new Map<string, FleetRecord>();
	private order: string[] = [];
	private listener: ((records: FleetRecord[]) => void) | null = null;

	setListener(listener: (records: FleetRecord[]) => void): void {
		this.listener = listener;
	}

	private emit(): void {
		if (this.listener) {
			try {
				this.listener(this.list());
			} catch {
				// listener must never break delegation
			}
		}
	}

	start(record: Omit<FleetRecord, "id" | "status" | "startedAt" | "usage"> & { id?: string }): FleetRecord {
		const id = record.id ?? `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
		const full: FleetRecord = {
			id,
			mode: record.mode,
			agent: record.agent,
			status: "running",
			model: record.model,
			startedAt: Date.now(),
			pid: record.pid,
			cwd: record.cwd,
			task: record.task,
			usage: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				cost: 0,
				totalTokens: 0,
				contextTokens: 0,
				turns: 0,
			},
			errorMessage: record.errorMessage,
		};
		this.runs.set(id, full);
		this.order.push(id);
		this.emit();
		return full;
	}

	update(id: string, patch: Partial<FleetRecord>): void {
		const rec = this.runs.get(id);
		if (!rec) return;
		Object.assign(rec, patch);
		this.emit();
	}

	finish(id: string, status: "completed" | "failed", patch?: Partial<FleetRecord>): void {
		const rec = this.runs.get(id);
		if (!rec) return;
		rec.status = status;
		rec.finishedAt = Date.now();
		if (patch) Object.assign(rec, patch);
		this.emit();
	}

	list(): FleetRecord[] {
		return this.order.map((id) => this.runs.get(id)).filter((r): r is FleetRecord => Boolean(r));
	}

	clear(): void {
		this.runs.clear();
		this.order = [];
		this.emit();
	}
}

export function formatDuration(ms: number): string {
	if (ms < 1000) return `${ms}ms`;
	const seconds = ms / 1000;
	if (seconds < 60) return `${seconds.toFixed(1)}s`;
	const minutes = Math.floor(seconds / 60);
	const rest = Math.round(seconds % 60);
	return `${minutes}m${rest}s`;
}

export function formatFleetSummary(records: FleetRecord[]): string {
	const running = records.filter((r) => r.status === "running");
	const completed = records.filter((r) => r.status === "completed");
	const failed = records.filter((r) => r.status === "failed");

	const lines: string[] = [
		"## delegate-fleet",
		"",
		`status: ${completed.length} done, ${running.length} running, ${failed.length} failed, ${records.length} total`,
	];

	if (records.length === 0) {
		lines.push("", "(no sub-agent runs in this process)");
		return lines.join("\n");
	}

	lines.push("");
	for (const rec of records) {
		lines.push(formatFleetRecord(rec));
	}

	return lines.join("\n");
}

export function formatFleetRecord(rec: FleetRecord): string {
	const elapsed = rec.finishedAt ? rec.finishedAt - rec.startedAt : Date.now() - rec.startedAt;
	const icon = rec.status === "running" ? "🟢" : rec.status === "completed" ? "✅" : "❌";
	const status = rec.status === "running" ? `running · elapsed ${formatDuration(elapsed)}` : `${rec.status} · ${formatDuration(elapsed)}`;
	const model = rec.model ?? "?";
	const ctx = rec.usage.contextTokens || rec.usage.totalTokens;

	const tokens: string[] = [];
	if (rec.usage.turns > 0) tokens.push(`${rec.usage.turns}t`);
	if (rec.usage.input > 0) tokens.push(`↑${fmtNum(rec.usage.input)}`);
	if (rec.usage.output > 0) tokens.push(`↓${fmtNum(rec.usage.output)}`);
	if (ctx > 0) tokens.push(`ctx ${fmtNum(ctx)}`);
	if (rec.usage.cost > 0) tokens.push(`$${rec.usage.cost.toFixed(4)}`);
	const usageText = tokens.length > 0 ? tokens.join(" ") : "usage n/a";

	const parts = [
		`${icon} ${rec.agent}`,
		`  ${status}`,
		`  mode=${rec.mode}`,
		`  model=${model}`,
		`  ${usageText}`,
		`  cwd=${rec.cwd}`,
		`  task=${rec.task.length > 120 ? `${rec.task.slice(0, 120)}…` : rec.task}`,
	];

	if (rec.errorMessage) parts.push(`  error=${rec.errorMessage}`);
	return parts.join("\n");
}

function fmtNum(n: number): string {
	if (n < 1000) return String(Math.round(n));
	if (n < 10000) return `${(n / 1000).toFixed(1)}k`;
	return `${Math.round(n / 1000)}k`;
}

export function registerFleetCommand(pi: ExtensionAPI, store: FleetStore): void {
	pi.registerCommand("delegate-fleet", {
		description: "Show current pi-multi-agent sub-agent fleet (running/done/failed, usage, elapsed)",
		handler: async (args, ctx) => {
			const arg = args.trim();
			if (arg === "clear" || arg === "reset") {
				store.clear();
				ctx.ui.notify("delegate-fleet: cleared", "info");
				return;
			}
			const records = store.list();
			const filtered = records.filter((r) => {
				if (!arg) return true;
				return r.agent.includes(arg) || r.status.includes(arg) || r.mode.includes(arg);
			});
			ctx.ui.notify(formatFleetSummary(filtered), "info");
		},
	});
}
