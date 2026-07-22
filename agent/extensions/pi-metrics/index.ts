/**
 * pi-metrics — persistent local usage metrics for pi.
 *
 * Collects, per local day / month / all-time:
 *   - token usage (input/output/cacheRead/cacheWrite) and cost
 *   - prompt count (interactive user input only)
 *   - session count (one per session file; ephemeral print-mode sessions excluded)
 *
 * Data source: append-only JSONL log at events.jsonl next to this file
 * (git-ignored via .gitignore; see store.ts for the schema). All LLM usage is recorded as actually
 * produced, including aborted/retried messages, compaction summaries
 * (session_compact) and tree branch summaries (session_tree) — the latter
 * two never fire message_end, so they are recorded from their session
 * events. Nested tool-result usage (subagent summaries reported on
 * toolResult messages) is intentionally NOT recorded (pi excludes it from
 * main context accounting too) — possible future addition.
 *
 * Statusline integration (decoupled, via ctx.ui.setStatus + pi-statusline's
 * ext-status source). Raw numeric strings are published so pi-statusline's
 * `format` field controls display:
 *   metrics-today-tokens / metrics-today-cost
 *   metrics-month-tokens / metrics-month-cost
 *   metrics-total-tokens / metrics-total-cost
 * Example pi-statusline module:
 *   "todayTok": { "source":"ext-status", "key":"metrics-today-tokens",
 *                 "format":"tok", "color":"cyan", "nullText":"" }
 *
 * Commands:
 *   /metrics    show today / month / total summary (notify)
 */

import { type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { MetricsStore, bucketTokens, type Bucket, type UsageSource } from "./store.ts";

const EXT_DIR = dirname(fileURLToPath(import.meta.url));

const STATUS_KEYS = {
	todayTokens: "metrics-today-tokens",
	todayCost: "metrics-today-cost",
	monthTokens: "metrics-month-tokens",
	monthCost: "metrics-month-cost",
	totalTokens: "metrics-total-tokens",
	totalCost: "metrics-total-cost",
} as const;

let store: MetricsStore | undefined;

// ─── formatters (for /metrics output) ───────────────────────────────────────
function fmtTok(n: number): string {
	if (n < 1000) return String(n);
	if (n < 10000) return `${(n / 1000).toFixed(1)}k`;
	if (n < 1000000) return `${Math.round(n / 1000)}k`;
	if (n < 10000000) return `${(n / 1000000).toFixed(1)}M`;
	return `${Math.round(n / 1000000)}M`;
}
const fmtCost = (n: number): string => `$${n.toFixed(3)}`;

// ─── statusline push ─────────────────────────────────────────────────────────
function pushStatus(ctx: ExtensionContext): void {
	if (!store || !ctx.hasUI) return;
	try {
		const today = store.today();
		const month = store.thisMonth();
		const total = store.total();
		const round6 = (n: number): string => String(Math.round(n * 1e6) / 1e6);
		ctx.ui.setStatus(STATUS_KEYS.todayTokens, String(bucketTokens(today)));
		ctx.ui.setStatus(STATUS_KEYS.todayCost, round6(today.cost));
		ctx.ui.setStatus(STATUS_KEYS.monthTokens, String(bucketTokens(month)));
		ctx.ui.setStatus(STATUS_KEYS.monthCost, round6(month.cost));
		ctx.ui.setStatus(STATUS_KEYS.totalTokens, String(bucketTokens(total)));
		ctx.ui.setStatus(STATUS_KEYS.totalCost, round6(total.cost));
	} catch {
		// ignore — metrics must never break the session
	}
}

// ─── usage recording ─────────────────────────────────────────────────────────
interface UsageLike {
	input?: number;
	output?: number;
	cacheRead?: number;
	cacheWrite?: number;
	cost?: { total?: number };
}

function recordUsage(ctx: ExtensionContext, usage: UsageLike | undefined, src: UsageSource, provider: string, model: string): void {
	if (!store || !usage) return;
	try {
		store.record({
			v: 1,
			type: "usage",
			ts: Date.now(),
			sid: ctx.sessionManager.getSessionId(),
			cwd: ctx.cwd,
			provider,
			model,
			src,
			in: usage.input ?? 0,
			out: usage.output ?? 0,
			cr: usage.cacheRead ?? 0,
			cw: usage.cacheWrite ?? 0,
			cost: usage.cost?.total ?? 0,
		});
	} catch {
		// ignore
	}
}

const currentProviderModel = (ctx: ExtensionContext): { provider: string; model: string } => ({
	provider: ctx.model?.provider ?? "unknown",
	model: ctx.model?.id ?? "unknown",
});

// ─── extension entry ─────────────────────────────────────────────────────────
export default function (pi: ExtensionAPI): void {
	pi.on("session_start", (event, ctx) => {
		try {
			store ??= new MetricsStore(EXT_DIR);
			const sid = ctx.sessionManager.getSessionId();
			// Count one session per session file; ephemeral sessions (no file,
			// e.g. print mode) are excluded from the session count.
			if (ctx.sessionManager.getSessionFile() && !store.hasSession(sid)) {
				store.record({ v: 1, type: "session", ts: Date.now(), sid, cwd: ctx.cwd, reason: event.reason });
			}
		} catch {
			// ignore
		}
		pushStatus(ctx);
	});

	pi.on("input", (event, ctx) => {
		// Interactive user prompts only. Built-in slash commands are handled by
		// the TUI before prompt() and extension commands before the input event,
		// so neither reaches here; skill/template expansions do and count as prompts.
		if (event.source !== "interactive") return;
		try {
			store?.record({ v: 1, type: "prompt", ts: Date.now(), sid: ctx.sessionManager.getSessionId(), cwd: ctx.cwd });
		} catch {
			// ignore
		}
	});

	pi.on("message_end", (event, ctx) => {
		const msg = event.message;
		if (msg?.role !== "assistant") return;
		// AssistantMessage carries its own provider/model (accurate across /model switches).
		recordUsage(
			ctx,
			msg.usage,
			"msg",
			String((msg as { provider?: string }).provider ?? ctx.model?.provider ?? "unknown"),
			String((msg as { model?: string }).model ?? ctx.model?.id ?? "unknown"),
		);
		pushStatus(ctx);
	});

	// Compaction's LLM call bypasses the message flow (no message_end).
	pi.on("session_compact", (event, ctx) => {
		const { provider, model } = currentProviderModel(ctx);
		recordUsage(ctx, event.compactionEntry?.usage, "compact", provider, model);
		pushStatus(ctx);
	});

	// Tree branch summarization's LLM call likewise bypasses message_end.
	pi.on("session_tree", (event, ctx) => {
		if (!event.summaryEntry?.usage) return;
		const { provider, model } = currentProviderModel(ctx);
		recordUsage(ctx, event.summaryEntry.usage, "tree", provider, model);
		pushStatus(ctx);
	});

	pi.registerCommand("metrics", {
		description: "Show pi-metrics usage statistics (today / month / total)",
		handler: async (_args, ctx) => {
			if (!store) {
				ctx.ui.notify("pi-metrics: no data yet", "info");
				return;
			}
			const line = (label: string, b: Bucket): string =>
				`${label}  ${fmtTok(bucketTokens(b))} tok · ${fmtCost(b.cost)} · ${b.prompts} prompts · ${b.sessions} sessions`;
			ctx.ui.notify(
				["📊 pi-metrics", line("今日", store.today()), line("本月", store.thisMonth()), line("累计", store.total())].join("\n"),
				"info",
			);
		},
	});
}
