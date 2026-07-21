/**
 * pi-statusline — minimal, information-dense Tokyo Night statusline.
 *
 * Default 4-line footer (left/right aligned per line):
 *   line 1: cwd (left) · branch (right)
 *   line 2: session title (left) · model thinking (right)
 *   line 3: ↑in ↓out R W CH% $ (left) · ctx [bar] pct used/window (right)
 *   line 4: ttft <cur> (avg <avg>)  speed <cur> (avg <avg>)  — spaces, color-coded
 *
 * Narrow screens drop low-priority fields (never grows beyond 4 lines).
 * TTFT = time to first token of any kind (thinking/text/tool-call delta).
 * TPS  = generation rate = output tokens / (message_end − first_token), excludes TTFT.
 * Average TPS = arithmetic mean across all completed assistant responses in the session.
 * CH   = cumulative cache-hit rate over the current branch.
 *
 * Nerd Font glyphs (\uf01b/\uf01a) render as 2 columns but pi-tui's visibleWidth
 * counts them as 1, so we correct with trueWidth = visibleWidth + nerdGlyphCount.
 */

import { isAbsolute, relative, resolve, sep } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";

// ─── Tokyo Night palette (truecolor R;G;B) ───────────────────────────────────
const P = {
	fg: "194;202;245",
	fgDark: "169;177;214",
	comment: "86;95;137",
	dark5: "115;122;162",
	blue: "122;162;247",
	cyan: "125;207;255",
	blue5: "137;221;255",
	magenta: "187;154;247",
	purple: "157;124;216",
	orange: "255;158;100",
	yellow: "224;175;104",
	green: "158;206;106",
	green1: "115;218;202",
	red: "247;118;142",
} as const;

const c = (rgb: string, s: string): string =>
	s === "" ? "" : `\x1b[38;2;${rgb}m${s}\x1b[0m`;

// ─── width helpers ─────────────────────────────────────────────────────────────
// Nerd Font PUA: BMP U+E000–U+F8FF and supplementary plane U+F0000–U+FFFFD.
function isNerdCp(cp: number): boolean {
	return (cp >= 0xe000 && cp <= 0xf8ff) || (cp >= 0xf0000 && cp <= 0xffffd);
}
function nerdCount(s: string): number {
	let n = 0;
	for (const ch of s.replace(/\x1b\[[0-9;]*m/g, "")) {
		const cp = ch.codePointAt(0)!;
		if (isNerdCp(cp)) n++;
	}
	return n;
}
/** True display width, correcting Nerd Font PUA glyphs that visibleWidth undercounts. */
function trueWidth(s: string): number {
	return visibleWidth(s) + nerdCount(s);
}

/** Truncate to a true-width budget, accounting for Nerd Font glyphs that visibleWidth undercounts. */
function truncTrue(s: string, maxTrue: number): string {
	if (maxTrue <= 0) return "";
	if (trueWidth(s) <= maxTrue) return s;
	return truncateToWidth(s, Math.max(1, maxTrue - nerdCount(s)), "…");
}

// ─── formatters ──────────────────────────────────────────────────────────────
function fmtTok(n: number): string {
	if (n < 1000) return String(n);
	if (n < 10000) return `${(n / 1000).toFixed(1)}k`;
	if (n < 1000000) return `${Math.round(n / 1000)}k`;
	if (n < 10000000) return `${(n / 1000000).toFixed(1)}M`;
	return `${Math.round(n / 1000000)}M`;
}

function fmtCwd(cwd: string, home: string | undefined): string {
	if (!home) return cwd;
	const resolvedCwd = resolve(cwd);
	const resolvedHome = resolve(home);
	const rel = relative(resolvedHome, resolvedCwd);
	const inside =
		rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
	if (!inside) return cwd;
	return rel === "" ? "~" : `~${sep}${rel}`;
}

const THINK_SHORT: Record<string, string> = {
	off: "off",
	minimal: "min",
	low: "low",
	medium: "med",
	high: "high",
	xhigh: "xh",
	max: "max",
};

// threshold color helpers
function ctxColor(pct: number | null): string {
	if (pct == null) return P.comment;
	if (pct >= 80) return P.red;
	if (pct >= 50) return P.yellow;
	return P.green;
}
function ttftColor(sec: number | null): string {
	if (sec == null) return P.comment;
	if (sec >= 3) return P.red;
	if (sec >= 1) return P.yellow;
	return P.green;
}

function progressBar(pct: number | null, color: string): string {
	const cells = 8;
	const filled = pct == null ? 0 : Math.round((pct / 100) * cells);
	return `[${c(color, "█".repeat(filled))}${c(P.comment, "░".repeat(cells - filled))}]`;
}

// ─── layout items ───────────────────────────────────────────────────────────
interface Item {
	key: string;
	pri: number; // higher = more important (kept first when narrowing); >=90 mandatory
	group: number;
	text: string; // pre-rendered (with ANSI); empty-text items are dropped
}

const GSEP = ` ${c(P.dark5, "│")} `; // inter-group separator (3 cols)

/** Render kept items in order; gap is GSEP between groups, else `sp`. */
function renderItems(items: Item[], kept: Set<string>, sp: string): string {
	let out = "";
	let prev: Item | undefined;
	for (const it of items) {
		if (!kept.has(it.key)) continue;
		if (prev) out += prev.group !== it.group ? GSEP : sp;
		out += it.text;
		prev = it;
	}
	return out;
}

function itemsWidth(items: Item[], kept: Set<string>, sp: string): number {
	return trueWidth(renderItems(items, kept, sp));
}

/** Fit a line into `width` by dropping lowest-priority non-mandatory items first. */
function fitLine(items: Item[], width: number, sp: string): string {
	const live = items.filter((it) => visibleWidth(it.text) > 0);
	const liveSet = new Set(live.map((it) => it.key));
	if (itemsWidth(live, liveSet, sp) <= width) return renderItems(live, liveSet, sp);
	const droppable = live.filter((it) => it.pri < 90).sort((a, b) => a.pri - b.pri);
	const kept = new Set(liveSet);
	for (const it of droppable) {
		kept.delete(it.key);
		if (itemsWidth(live, kept, sp) <= width) return renderItems(live, kept, sp);
	}
	return truncTrue(renderItems(live, kept, sp), width); // only mandatory remain, truncate to fit
}

/** Render a split line: left items left-aligned, right items right-aligned. */
function splitLine(
	leftItems: Item[],
	rightItems: Item[],
	width: number,
	leftSp: string,
	rightSp: string,
): string {
	const lLive = leftItems.filter((it) => visibleWidth(it.text) > 0);
	const rLive = rightItems.filter((it) => visibleWidth(it.text) > 0);
	const lAll = new Set(lLive.map((it) => it.key));
	const rAll = new Set(rLive.map((it) => it.key));

	const build = (lKept: Set<string>, rKept: Set<string>): { ok: boolean; line: string } => {
		const left = renderItems(lLive, lKept, leftSp);
		const right = renderItems(rLive, rKept, rightSp);
		const lw = trueWidth(left);
		const rw = trueWidth(right);
		const gap = lw > 0 && rw > 0 ? 1 : 0;
		if (lw + gap + rw <= width) {
			return { ok: true, line: left + " ".repeat(width - lw - rw) + right };
		}
		return { ok: false, line: "" };
	};

	// 1. full fit
	const full = build(lAll, rAll);
	if (full.ok) return full.line;

	// 2. single left item: truncate it to keep the full right side intact
	if (lLive.length === 1 && rLive.length > 0) {
		const right = renderItems(rLive, rAll, rightSp);
		const rw = trueWidth(right);
		const maxLeft = width - rw - 1;
		if (maxLeft >= 4) {
			const leftTrunc = truncTrue(renderItems(lLive, lAll, leftSp), maxLeft);
			if (trueWidth(leftTrunc) + 1 + rw <= width) {
				return leftTrunc + " ".repeat(width - trueWidth(leftTrunc) - rw) + right;
			}
		}
	}

	// 3. drop low-priority items from either side until it fits
	const droppable = [
		...lLive.filter((it) => it.pri < 90),
		...rLive.filter((it) => it.pri < 90),
	].sort((a, b) => a.pri - b.pri);
	const lKept = new Set(lAll);
	const rKept = new Set(rAll);
	for (const it of droppable) {
		if (lKept.has(it.key)) lKept.delete(it.key);
		else rKept.delete(it.key);
		const res = build(lKept, rKept);
		if (res.ok) return res.line;
	}

	// 4. only mandatory remain; truncate left to fit
	const left = renderItems(lLive, lKept, leftSp);
	const right = renderItems(rLive, rKept, rightSp);
	const rw = trueWidth(right);
	const gap = rw > 0 ? 1 : 0;
	const leftTrunc = truncTrue(left, Math.max(0, width - rw - gap));
	return leftTrunc + " ".repeat(Math.max(0, width - trueWidth(leftTrunc) - rw)) + right;
}

// ─── per-message timing state ────────────────────────────────────────────────
interface Timing {
	ttft: number | null; // ms
	tps: number | null; // tok/s
}

let requestStart: number | null = null;
let msgStart: number | null = null;
let firstToken: number | null = null;
let lastTiming: Timing = { ttft: null, tps: null };
const tpsHistory: number[] = [];
const ttftHistory: number[] = [];


// ─── footer state ────────────────────────────────────────────────────────────
let enabled = false;
let requestRender: (() => void) | undefined;

function currentThinking(ctx: any): string {
	try {
		const branch: any[] = ctx.sessionManager.getBranch();
		for (let i = branch.length - 1; i >= 0; i--) {
			if (branch[i]!.type === "thinking_level_change") {
				return THINK_SHORT[branch[i]!.thinkingLevel] ?? branch[i]!.thinkingLevel;
			}
		}
	} catch {
		/* ignore */
	}
	return "med";
}

function computeUsage(ctx: any) {
	let input = 0,
		output = 0,
		cacheRead = 0,
		cacheWrite = 0,
		cost = 0;
	try {
		const branch: any[] = ctx.sessionManager.getBranch();
		for (const e of branch) {
			if (e.type === "message" && e.message?.role === "assistant") {
				const u = e.message.usage ?? {};
				input += u.input ?? 0;
				output += u.output ?? 0;
				cacheRead += u.cacheRead ?? 0;
				cacheWrite += u.cacheWrite ?? 0;
				cost += u.cost?.total ?? 0;
			}
		}
	} catch {
		/* ignore */
	}
	const denom = input + cacheRead + cacheWrite;
	const ch = denom > 0 ? (cacheRead / denom) * 100 : null;
	return { input, output, cacheRead, cacheWrite, cost, ch };
}

// ─── render ──────────────────────────────────────────────────────────────────
function renderFooter(ctx: any, footerData: any, width: number): string[] {
	const home = process.env.HOME || process.env.USERPROFILE;
	const cwdRaw = fmtCwd(ctx.sessionManager.getCwd(), home);
	const branch = footerData.getGitBranch();
	const sessionName: string | undefined = ctx.sessionManager.getSessionName();
	const model = ctx.model;
	const modelId: string = model?.id ?? "no-model";
	const thinking = currentThinking(ctx);
	const u = computeUsage(ctx);
	const ctxUsage = ctx.getContextUsage();
	const ctxPct: number | null = ctxUsage?.percent ?? null;
	const ctxWindow: number = ctxUsage?.contextWindow ?? model?.contextWindow ?? 0;
	const ctxTokens: number | null = ctxUsage?.tokens ?? null;

	const avgTps =
		tpsHistory.length > 0 ? tpsHistory.reduce((a, b) => a + b, 0) / tpsHistory.length : null;
	const ttftAvgMs =
		ttftHistory.length > 0 ? ttftHistory.reduce((a, b) => a + b, 0) / ttftHistory.length : null;

	const up = "\uf01b"; // folder-download
	const down = "\uf01a"; // folder-upload
	const cacheHitG = "\uf49b"; // nf-md-database_check
	const cacheReadG = "\udb84\ude5b"; // nf-cod-database (read)
	const cacheWriteG = "\udb84\ude59"; // nf-cod-database (write)
	const priceG = "\uf155"; // nf-fa-dollar

	const SP2 = "  "; // intra-group spacer (usage, model+thinking)
	const SP1 = " "; // intra-group spacer (context, line 4)

	// ── line 1: cwd (left) · branch (right) ──
	const l1L: Item[] = [{ key: "cwd", pri: 100, group: 0, text: c(P.fg, cwdRaw) }];
	const l1R: Item[] = [{ key: "branch", pri: 60, group: 0, text: c(P.green, branch ?? "") }];

	// ── line 2: session title (left) · model + thinking (right) ──
	const l2L: Item[] = [
		{ key: "title", pri: 30, group: 0, text: c(P.comment, sessionName ?? "") },
	];
	const l2R: Item[] = [
		{ key: "model", pri: 95, group: 0, text: c(P.blue, modelId) },
		{ key: "thinking", pri: 40, group: 0, text: c(P.magenta, thinking) },
	];

	// ── line 3: usage (left) · context (right) ──
	const l3L: Item[] = [
		{ key: "in", pri: 100, group: 0, text: `${c(P.cyan, up)} ${c(P.cyan, fmtTok(u.input))}` },
		{ key: "out", pri: 95, group: 0, text: `${c(P.green1, down)} ${c(P.green1, fmtTok(u.output))}` },
		{ key: "cr", pri: 50, group: 0, text: `${c(P.blue5, cacheReadG)} ${c(P.blue5, fmtTok(u.cacheRead))}` },
		{ key: "cw", pri: 40, group: 0, text: `${c(P.purple, cacheWriteG)} ${c(P.purple, fmtTok(u.cacheWrite))}` },
		{ key: "ch", pri: 45, group: 0, text: `${c(P.yellow, cacheHitG)} ${c(P.yellow, u.ch == null ? "0%" : `${Math.round(u.ch)}%`)}` },
		{ key: "cost", pri: 70, group: 0, text: `${c(P.orange, priceG)} ${c(P.orange, `$${u.cost.toFixed(3)}`)}` },
	];
	const cc = ctxColor(ctxPct);
	const l3R: Item[] = [
		{ key: "ctxlabel", pri: 100, group: 0, text: c(P.comment, "ctx") },
		{ key: "bar", pri: 60, group: 0, text: progressBar(ctxPct, cc) },
		{ key: "pct", pri: 95, group: 0, text: c(cc, ctxPct == null ? "?" : `${Math.round(ctxPct)}%`) },
		{
			key: "nums",
			pri: 40,
			group: 0,
			text: c(P.fgDark, `${ctxTokens == null ? "?" : fmtTok(ctxTokens)}/${fmtTok(ctxWindow)}`),
		},
	];

	// ── line 4: ttft (cur+avg) · speed (cur+avg), single group, color-coded ──
	const ttftSec = lastTiming.ttft == null ? null : lastTiming.ttft / 1000;
	const ttftAvgSec = ttftAvgMs == null ? null : ttftAvgMs / 1000;
	const l4: Item[] = [
		{
			key: "ttft",
			pri: 100,
			group: 0,
			text: c(ttftColor(ttftSec), `ttft ${ttftSec == null ? "0.0s" : `${ttftSec.toFixed(1)}s`}`),
		},
		{
			key: "ttftAvg",
			pri: 40,
			group: 0,
			text: ttftAvgSec == null ? "" : c(P.comment, `(avg ${ttftAvgSec.toFixed(1)}s)`),
		},
		{
			key: "speed",
			pri: 95,
			group: 0,
			text: c(P.cyan, `speed ${lastTiming.tps == null ? "0.0 tok/s" : `${lastTiming.tps.toFixed(1)} tok/s`}`),
		},
		{
			key: "speedAvg",
			pri: 30,
			group: 0,
			text: avgTps == null ? "" : c(P.comment, `(avg ${avgTps.toFixed(1)} tok/s)`),
		},
	];

	return [
		splitLine(l1L, l1R, width, SP1, SP1),
		splitLine(l2L, l2R, width, SP1, SP2),
		splitLine(l3L, l3R, width, SP2, SP1),
		fitLine(l4, width, SP2),
	];
}

// ─── setup ───────────────────────────────────────────────────────────────────
function setupFooter(ctx: any): void {
	ctx.ui.setFooter((tui: any, _theme: any, footerData: any) => {
		requestRender = () => tui.requestRender();
		const unsub = footerData.onBranchChange(() => tui.requestRender());
		return {
			dispose: () => {
				unsub();
				requestRender = undefined;
			},
			invalidate() {},
			render(width: number): string[] {
				return renderFooter(ctx, footerData, width);
			},
		};
	});
}

export default function (pi: ExtensionAPI): void {
	// timing events (registered once)
	pi.on("before_provider_request", () => {
		requestStart = Date.now();
	});
	pi.on("message_start", () => {
		// Record request start for this message's TTFT, but do NOT clear lastTiming —
		// keep showing the previous response's values until the new one completes.
		msgStart = requestStart;
		firstToken = null;
	});
	pi.on("message_update", (e: any) => {
		const type: string | undefined = e?.assistantMessageEvent?.type;
		if (type && /_delta$/.test(type) && firstToken === null) {
			firstToken = Date.now();
		}
	});
	pi.on("message_end", (e: any, _ctx) => {
		const msg = e?.message;
		const output: number = msg?.usage?.output ?? 0;
		if (firstToken !== null && msgStart !== null) {
			const genMs = Date.now() - firstToken;
			const ttft = firstToken - (msgStart ?? firstToken);
			const tps = genMs > 0 ? output / (genMs / 1000) : null;
			lastTiming = { ttft, tps };
			if (ttft !== null && ttft >= 0) ttftHistory.push(ttft);
			if (tps !== null && output > 0) tpsHistory.push(tps);
		}
		// If we never saw a delta (no TTFT/TPS), leave lastTiming as-is — don't blank it.
		requestStart = null;
		requestRender?.();
	});
	pi.on("thinking_level_select", () => requestRender?.());
	pi.on("model_select", () => requestRender?.());

	pi.on("session_start", (_e, ctx: any) => {
		if (enabled && ctx.mode === "tui") setupFooter(ctx);
	});

	pi.registerCommand("statusline", {
		description: "Toggle the pi-statusline footer on/off",
		handler: async (_args, ctx) => {
			enabled = !enabled;
			if (enabled && ctx.mode === "tui") {
				setupFooter(ctx);
				ctx.ui.notify("statusline enabled", "info");
			} else {
				ctx.ui.setFooter(undefined);
				ctx.ui.notify("statusline disabled (default footer restored)", "info");
			}
		},
	});

	pi.registerCommand("statusline-reset", {
		description: "Reset TTFT/TPS history",
		handler: async (_args, ctx) => {
			lastTiming = { ttft: null, tps: null };
			tpsHistory.length = 0;
			ttftHistory.length = 0;
			ctx.ui.notify("statusline timing history reset", "info");
			requestRender?.();
		},
	});

	// auto-enable on first load
	enabled = true;
}
