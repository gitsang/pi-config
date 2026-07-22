/**
 * pi-statusline — configurable, information-dense Tokyo Night statusline.
 *
 * Fully config-driven. Zero config = the default 4-line footer (preserved
 * behavior). Data sources are a fixed registry (cwd, model, usage, ctx, ttft,
 * tps, thinking, branch, title, ext-status, literal). New read-only sources
 * can be added to the registry; the TTFT/TPS sources are stateful and built-in.
 *
 * CROSS-EXTENSION (no coupling): an external extension "registers" a statusline
 * source by calling ctx.ui.setStatus(key, value). pi-statusline reads it via
 * the `ext-status` source with a `key` in config. pi-statusline imports NO
 * other extension. Example: openai-service-tier calls setStatus("service-tier",
 * "priority"); config references { source:"ext-status", key:"service-tier" }.
 *
 * CONFIG  (precedence: later overrides earlier)
 *   global     ~/.pi/agent/pi-statusline.json
 *   extension  <ext-dir>/config.json        (next to this file)
 *   project    <cwd>/.pi/pi-statusline.json  (trusted projects only)
 *   A missing layer is skipped; partial configs deep-merge over the default.
 *
 * See config.example.json for a full template.
 *
 * Commands:
 *   /statusline          toggle footer on/off (no arg) | "reload" reloads config
 *   /statusline-reset    reset TTFT/TPS history
 */

import {
	CONFIG_DIR_NAME,
	getAgentDir,
	type ExtensionAPI,
	type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const EXT_DIR = dirname(fileURLToPath(import.meta.url));

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

const RGB_RE = /^\d{1,3};\d{1,3};\d{1,3}$/;
function palette(name: string): string {
	if ((P as Record<string, string>)[name] !== undefined) return (P as Record<string, string>)[name];
	if (RGB_RE.test(name)) return name;
	return P.fg;
}
const c = (rgb: string, s: string): string => (s === "" ? "" : `\x1b[38;2;${rgb}m${s}\x1b[0m`);

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
	const inside = rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
	if (!inside) return cwd;
	return rel === "" ? "~" : `~${sep}${rel}`;
}
const THINK_SHORT: Record<string, string> = {
	off: "off", minimal: "min", low: "low", medium: "med", high: "high", xhigh: "xh", max: "max",
};

function currentThinking(ctx: any): string {
	try {
		const branch: any[] = ctx.sessionManager.getBranch();
		for (let i = branch.length - 1; i >= 0; i--) {
			if (branch[i]!.type === "thinking_level_change") {
				return THINK_SHORT[branch[i]!.thinkingLevel] ?? branch[i]!.thinkingLevel;
			}
		}
	} catch { /* ignore */ }
	return "med";
}

function progressBar(pct: number | null, cells: number, color: string): string {
	const filled = pct == null ? 0 : Math.round((pct / 100) * cells);
	return `[${c(color, "█".repeat(filled))}${c(P.comment, "░".repeat(cells - filled))}]`;
}

// ─── config types ────────────────────────────────────────────────────────────
type ColorSpec =
	| string
	| { map: Record<string, string>; default: string }
	| { thresholds: Array<{ op: "gte" | "gt" | "lte" | "lt"; n: number; color: string }>; default: string };

interface ModuleConfig {
	source: string;
	key?: string;        // ext-status key
	text?: string;       // literal
	glyph?: string;
	format?: string;     // tok|pct|sec1|tps1|dollars3|int|ctxnums|raw
	color?: ColorSpec;
	prefix?: string;
	suffix?: string;
	cells?: number;      // ctx.bar
	nullText?: string;   // shown when value is null/empty ("" => drop)
	group?: number;
}

interface LineConfig {
	left?: string[];
	right?: string[];
	full?: string[];
	sep?: string;        // item spacer for this line (both sides / full)
	sepLeft?: string;
	sepRight?: string;
}

interface RawConfig {
	lines?: LineConfig[];
	modules?: Record<string, ModuleConfig>;
	separator?: { group?: string; item?: string; groupColor?: string };
	priority?: Record<string, number>;
}

interface StatuslineConfig {
	lines: LineConfig[];
	modules: Record<string, ModuleConfig>;
	separator: { group: string; item: string; groupColor: string };
	priority: Record<string, number>;
}

function isObj(v: unknown): v is Record<string, unknown> {
	return !!v && typeof v === "object" && !Array.isArray(v);
}

// ─── DEFAULT config = current 4-line behavior ───────────────────────────────
const DEFAULT_RAW: RawConfig = {
	lines: [
		{ left: ["cwd"], right: ["branch"], sepLeft: " ", sepRight: " " },
		{ left: ["title"], right: ["model", "thinking", "stier"], sepLeft: " ", sepRight: "  " },
		{
			left: ["tokIn", "tokOut", "cacheR", "cacheW", "cacheHit", "cost"],
			right: ["ctxLabel", "ctxBar", "ctxPct", "ctxNums"],
			sepLeft: "  ", sepRight: " ",
		},
		{ full: ["ttft", "ttftAvg", "tps", "tpsAvg"], sep: "  " },
	],
	modules: {
		cwd: { source: "session.cwd", color: "fg" },
		title: { source: "session.name", color: "comment" },
		branch: { source: "footer.branch", color: "green" },
		model: { source: "model.id", color: "blue" },
		thinking: { source: "thinking", color: "magenta" },
		stier: {
			source: "ext-status", key: "service-tier", glyph: "\uf0e7",
			color: { map: { priority: "orange", flex: "blue", scale: "green", off: "comment" }, default: "fgDark" },
		},
		tokIn: { source: "usage.input", glyph: "\uf01b", format: "tok", color: "cyan" },
		tokOut: { source: "usage.output", glyph: "\uf01a", format: "tok", color: "green1" },
		cacheR: { source: "usage.cacheRead", glyph: "\udb84\ude5b", format: "tok", color: "blue5" },
		cacheW: { source: "usage.cacheWrite", glyph: "\udb84\ude59", format: "tok", color: "purple" },
		cacheHit: { source: "usage.ch", glyph: "\uf49b", format: "pct", nullText: "0%", color: "yellow" },
		cost: { source: "usage.cost", glyph: "\uef8d", format: "dollars3", color: "orange" },
		ctxLabel: { source: "literal", text: "ctx", color: "comment" },
		ctxBar: {
			source: "ctx.bar", cells: 8,
			color: { thresholds: [{ op: "gte", n: 80, color: "red" }, { op: "gte", n: 50, color: "yellow" }], default: "green" },
		},
		ctxPct: {
			source: "ctx.percent", format: "pct", nullText: "?",
			color: { thresholds: [{ op: "gte", n: 80, color: "red" }, { op: "gte", n: 50, color: "yellow" }], default: "green" },
		},
		ctxNums: { source: "ctx.nums", color: "fgDark" },
		ttft: {
			source: "ttft", format: "sec1", nullText: "0.0s", prefix: "ttft ",
			color: { thresholds: [{ op: "gte", n: 3000, color: "red" }, { op: "gte", n: 1000, color: "yellow" }], default: "green" },
		},
		ttftAvg: { source: "ttft.avg", format: "sec1", prefix: "(avg ", suffix: ")", color: "comment" },
		tps: { source: "tps", format: "tps1", nullText: "0.0 tok/s", prefix: "speed ", color: "cyan" },
		tpsAvg: { source: "tps.avg", format: "tps1", prefix: "(avg ", suffix: ")", color: "comment" },
	},
	separator: { group: "│", item: " ", groupColor: "dark5" },
	priority: {
		cwd: 100, branch: 60, title: 30, model: 95, thinking: 40, stier: 35,
		tokIn: 100, tokOut: 95, cacheR: 50, cacheW: 40, cacheHit: 45, cost: 70,
		ctxLabel: 100, ctxBar: 60, ctxPct: 95, ctxNums: 40,
		ttft: 100, ttftAvg: 40, tps: 95, tpsAvg: 30,
	},
};

function mergeRaw(a: RawConfig, b: RawConfig): RawConfig {
	return {
		lines: Array.isArray(b.lines) ? b.lines : a.lines,
		modules: { ...(a.modules ?? {}), ...(b.modules ?? {}) },
		separator: { ...(a.separator ?? {}), ...(b.separator ?? {}) },
		priority: { ...(a.priority ?? {}), ...(b.priority ?? {}) },
	};
}

function tryRead(path: string): RawConfig | null {
	try {
		const text = readFileSync(path, "utf8");
		const parsed = JSON.parse(text);
		return isObj(parsed) ? (parsed as RawConfig) : null;
	} catch {
		return null;
	}
}

function loadConfig(ctx: ExtensionContext): StatuslineConfig {
	let raw: RawConfig = DEFAULT_RAW;
	const layers = [
		tryRead(join(getAgentDir(), "pi-statusline.json")),
		tryRead(join(EXT_DIR, "config.json")),
		ctx.isProjectTrusted() ? tryRead(join(ctx.cwd, CONFIG_DIR_NAME, "pi-statusline.json")) : null,
	];
	for (const layer of layers) if (layer) raw = mergeRaw(raw, layer);

	// resolve + light-validate
	const lines: LineConfig[] = Array.isArray(raw.lines) ? raw.lines : DEFAULT_RAW.lines!;
	const modules: Record<string, ModuleConfig> = isObj(raw.modules) ? (raw.modules as any) : {};
	const sepRaw = raw.separator ?? {};
	const separator = {
		group: typeof sepRaw.group === "string" ? sepRaw.group : "│",
		item: typeof sepRaw.item === "string" ? sepRaw.item : " ",
		groupColor: typeof sepRaw.groupColor === "string" ? sepRaw.groupColor : "dark5",
	};
	const priority = isObj(raw.priority) ? (raw.priority as any) : {};
	return { lines, modules, separator, priority };
}

// ─── source registry ────────────────────────────────────────────────────────
interface SourceContext {
	ctx: any;
	footerData: any;
	model: any;
	usage: { input: number; output: number; cacheRead: number; cacheWrite: number; cost: number; ch: number | null };
	ctxUsage: any;
	timing: { ttft: number | null; tps: number | null };
	timingAvg: { ttft: number | null; tps: number | null };
}

function fetchSource(source: string, sc: SourceContext, mc: ModuleConfig): any {
	switch (source) {
		case "session.cwd": return fmtCwd(sc.ctx.sessionManager.getCwd(), process.env.HOME || process.env.USERPROFILE);
		case "session.name": return sc.ctx.sessionManager.getSessionName();
		case "footer.branch": return sc.footerData?.getGitBranch?.() ?? null;
		case "model.id": return sc.model?.id ?? null;
		case "thinking": return currentThinking(sc.ctx);
		case "usage.input": return sc.usage.input;
		case "usage.output": return sc.usage.output;
		case "usage.cacheRead": return sc.usage.cacheRead;
		case "usage.cacheWrite": return sc.usage.cacheWrite;
		case "usage.ch": return sc.usage.ch;
		case "usage.cost": return sc.usage.cost;
		case "ctx.percent": return sc.ctxUsage?.percent ?? null;
		case "ctx.tokens": return sc.ctxUsage?.tokens ?? null;
		case "ctx.window": return sc.ctxUsage?.contextWindow ?? sc.model?.contextWindow ?? 0;
		case "ctx.nums": {
			const t = sc.ctxUsage?.tokens ?? null;
			const w = sc.ctxUsage?.contextWindow ?? sc.model?.contextWindow ?? 0;
			return `${t == null ? "?" : fmtTok(t)}/${fmtTok(w)}`;
		}
		case "ttft": return sc.timing.ttft;
		case "ttft.avg": return sc.timingAvg.ttft;
		case "tps": return sc.timing.tps;
		case "tps.avg": return sc.timingAvg.tps;
		case "ext-status": return sc.footerData?.getExtensionStatuses?.()?.get(mc.key ?? "") ?? null;
		case "literal": return mc.text ?? "";
		default: return null;
	}
}

function resolveColor(spec: ColorSpec | undefined, value: any): string {
	if (spec == null) return P.fg;
	if (typeof spec === "string") return palette(spec);
	if ("map" in spec) {
		const v = spec.map[value == null ? "" : String(value)];
		return palette(v ?? spec.default);
	}
	if ("thresholds" in spec) {
		const n = typeof value === "number" ? value : null;
		for (const t of spec.thresholds) {
			if (n == null) continue;
			if (t.op === "gte" && n >= t.n) return palette(t.color);
			if (t.op === "gt" && n > t.n) return palette(t.color);
			if (t.op === "lte" && n <= t.n) return palette(t.color);
			if (t.op === "lt" && n < t.n) return palette(t.color);
		}
		return palette(spec.default);
	}
	return P.fg;
}

function formatValue(format: string | undefined, raw: any, nullText: string | undefined): string {
	if (raw === null || raw === undefined || raw === "") return nullText ?? "";
	if (!format || format === "raw") return String(raw);
	const n = typeof raw === "number" ? raw : Number(raw);
	const num = Number.isFinite(n) ? n : 0;
	switch (format) {
		case "tok": return fmtTok(num);
		case "pct": return `${Math.round(num)}%`;
		case "sec1": return `${(num / 1000).toFixed(1)}s`;
		case "tps1": return `${num.toFixed(1)} tok/s`;
		case "dollars3": return `$${num.toFixed(3)}`;
		case "int": return `${Math.round(num)}`;
		default: return String(raw);
	}
}

function renderModule(mc: ModuleConfig, sc: SourceContext): string {
	try {
		if (mc.source === "ctx.bar") {
			const pct = sc.ctxUsage?.percent ?? null;
			return progressBar(pct, mc.cells ?? 8, resolveColor(mc.color, pct));
		}
		const raw = fetchSource(mc.source, sc, mc);
		const formatted = formatValue(mc.format, raw, mc.nullText);
		if (formatted === "") return "";
		const body = `${mc.prefix ?? ""}${formatted}${mc.suffix ?? ""}`;
		const color = resolveColor(mc.color, raw);
		const glyph = mc.glyph ? `${c(color, mc.glyph)} ` : "";
		return glyph + (body ? c(color, body) : "");
	} catch {
		return "";
	}
}

// ─── layout items ───────────────────────────────────────────────────────────
interface Item { key: string; pri: number; group: number; text: string }

function buildItems(names: string[] | undefined, sc: SourceContext, cfg: StatuslineConfig): Item[] {
	return (names ?? []).map((name) => {
		const mc = cfg.modules[name];
		const text = mc ? renderModule(mc, sc) : "";
		return { key: name, pri: cfg.priority[name] ?? 50, group: mc?.group ?? 0, text };
	});
}

function renderItems(items: Item[], kept: Set<string>, itemSp: string, groupSp: string): string {
	let out = "";
	let prev: Item | undefined;
	for (const it of items) {
		if (!kept.has(it.key)) continue;
		if (prev) out += prev.group !== it.group ? groupSp : itemSp;
		out += it.text;
		prev = it;
	}
	return out;
}
function itemsWidth(items: Item[], kept: Set<string>, itemSp: string, groupSp: string): number {
	return visibleWidth(renderItems(items, kept, itemSp, groupSp));
}
function fitLine(items: Item[], width: number, itemSp: string, groupSp: string): string {
	const live = items.filter((it) => visibleWidth(it.text) > 0);
	const liveSet = new Set(live.map((it) => it.key));
	if (itemsWidth(live, liveSet, itemSp, groupSp) <= width) return renderItems(live, liveSet, itemSp, groupSp);
	const droppable = live.filter((it) => it.pri < 90).sort((a, b) => a.pri - b.pri);
	const kept = new Set(liveSet);
	for (const it of droppable) {
		kept.delete(it.key);
		if (itemsWidth(live, kept, itemSp, groupSp) <= width) return renderItems(live, kept, itemSp, groupSp);
	}
	return truncateToWidth(renderItems(live, kept, itemSp, groupSp), width);
}
function splitLine(
	leftItems: Item[], rightItems: Item[], width: number,
	leftSp: string, rightSp: string, groupSp: string,
): string {
	const lLive = leftItems.filter((it) => visibleWidth(it.text) > 0);
	const rLive = rightItems.filter((it) => visibleWidth(it.text) > 0);
	const lAll = new Set(lLive.map((it) => it.key));
	const rAll = new Set(rLive.map((it) => it.key));
	const build = (lKept: Set<string>, rKept: Set<string>): { ok: boolean; line: string } => {
		const left = renderItems(lLive, lKept, leftSp, groupSp);
		const right = renderItems(rLive, rKept, rightSp, groupSp);
		const lw = visibleWidth(left);
		const rw = visibleWidth(right);
		const gap = lw > 0 && rw > 0 ? 1 : 0;
		if (lw + gap + rw <= width) return { ok: true, line: left + " ".repeat(width - lw - rw) + right };
		return { ok: false, line: "" };
	};
	const full = build(lAll, rAll);
	if (full.ok) return full.line;
	if (lLive.length === 1 && rLive.length > 0) {
		const right = renderItems(rLive, rAll, rightSp, groupSp);
		const rw = visibleWidth(right);
		const maxLeft = width - rw - 1;
		if (maxLeft >= 4) {
			const leftTrunc = truncateToWidth(renderItems(lLive, lAll, leftSp, groupSp), maxLeft, "…");
			if (visibleWidth(leftTrunc) + 1 + rw <= width) {
				return leftTrunc + " ".repeat(width - visibleWidth(leftTrunc) - rw) + right;
			}
		}
	}
	const droppable = [...lLive.filter((it) => it.pri < 90), ...rLive.filter((it) => it.pri < 90)].sort((a, b) => a.pri - b.pri);
	const lKept = new Set(lAll);
	const rKept = new Set(rAll);
	for (const it of droppable) {
		if (lKept.has(it.key)) lKept.delete(it.key);
		else rKept.delete(it.key);
		const res = build(lKept, rKept);
		if (res.ok) return res.line;
	}
	const left = renderItems(lLive, lKept, leftSp, groupSp);
	const right = renderItems(rLive, rKept, rightSp, groupSp);
	const rw = visibleWidth(right);
	const gap = rw > 0 ? 1 : 0;
	const leftTrunc = truncateToWidth(left, Math.max(0, width - rw - gap), "…");
	return leftTrunc + " ".repeat(Math.max(0, width - visibleWidth(leftTrunc) - rw)) + right;
}

// ─── per-message timing state ────────────────────────────────────────────────
let requestStart: number | null = null;
let msgStart: number | null = null;
let firstToken: number | null = null;
let lastTiming: { ttft: number | null; tps: number | null } = { ttft: null, tps: null };
const tpsHistory: number[] = [];
const ttftHistory: number[] = [];

function computeUsage(ctx: any) {
	let input = 0, output = 0, cacheRead = 0, cacheWrite = 0, cost = 0;
	try {
		const branch: any[] = ctx.sessionManager.getBranch();
		for (const e of branch) {
			if (e.type === "message" && e.message?.role === "assistant") {
				const u = e.message.usage ?? {};
				input += u.input ?? 0; output += u.output ?? 0;
				cacheRead += u.cacheRead ?? 0; cacheWrite += u.cacheWrite ?? 0;
				cost += e.message.cost?.total ?? u.cost?.total ?? 0;
			}
		}
	} catch { /* ignore */ }
	const denom = input + cacheRead + cacheWrite;
	const ch = denom > 0 ? (cacheRead / denom) * 100 : null;
	return { input, output, cacheRead, cacheWrite, cost, ch };
}

function buildSourceContext(ctx: any, footerData: any): SourceContext {
	const usage = computeUsage(ctx);
	const ctxUsage = ctx.getContextUsage();
	const ttftAvg = ttftHistory.length ? ttftHistory.reduce((a, b) => a + b, 0) / ttftHistory.length : null;
	const tpsAvg = tpsHistory.length ? tpsHistory.reduce((a, b) => a + b, 0) / tpsHistory.length : null;
	return { ctx, footerData, model: ctx.model, usage, ctxUsage, timing: lastTiming, timingAvg: { ttft: ttftAvg, tps: tpsAvg } };
}

// ─── render ──────────────────────────────────────────────────────────────────
let activeConfig: StatuslineConfig = {
	lines: DEFAULT_RAW.lines!, modules: DEFAULT_RAW.modules!, separator: { group: "│", item: " ", groupColor: "dark5" }, priority: DEFAULT_RAW.priority!,
};

function renderFooter(ctx: any, footerData: any, width: number): string[] {
	try {
		const sc = buildSourceContext(ctx, footerData);
		const cfg = activeConfig;
		const groupSp = ` ${c(palette(cfg.separator.groupColor), cfg.separator.group)} `;
		return cfg.lines.map((line) => {
			const itemSp = line.sep ?? cfg.separator.item;
			const leftSp = line.sepLeft ?? itemSp;
			const rightSp = line.sepRight ?? itemSp;
			if (line.full) {
				return fitLine(buildItems(line.full, sc, cfg), width, itemSp, groupSp);
			}
			return splitLine(buildItems(line.left, sc, cfg), buildItems(line.right, sc, cfg), width, leftSp, rightSp, groupSp);
		});
	} catch {
		return ["".padEnd(width)];
	}
}

// ─── setup ───────────────────────────────────────────────────────────────────
let enabled = false;
let requestRender: (() => void) | undefined;

function setupFooter(ctx: ExtensionContext): void {
	ctx.ui.setFooter((tui: any, _theme: any, footerData: any) => {
		requestRender = () => tui.requestRender();
		const unsub = footerData.onBranchChange(() => tui.requestRender());
		return {
			dispose: () => { unsub(); requestRender = undefined; },
			invalidate() {},
			render(width: number): string[] { return renderFooter(ctx, footerData, width); },
		};
	});
}

export default function (pi: ExtensionAPI): void {
	pi.on("before_provider_request", () => { requestStart = Date.now(); });
	pi.on("message_start", () => { msgStart = requestStart; firstToken = null; });
	pi.on("message_update", (e: any) => {
		const type: string | undefined = e?.assistantMessageEvent?.type;
		if (type && /_delta$/.test(type) && firstToken === null) firstToken = Date.now();
	});
	pi.on("message_end", (e: any) => {
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
		requestStart = null;
		requestRender?.();
	});
	pi.on("thinking_level_select", () => requestRender?.());
	pi.on("model_select", () => requestRender?.());

	pi.on("session_start", (_e, ctx: ExtensionContext) => {
		activeConfig = loadConfig(ctx);
		if (enabled && ctx.mode === "tui") setupFooter(ctx);
	});

	pi.registerCommand("statusline", {
		description: "Toggle pi-statusline footer (| reload to reload config)",
		handler: async (args, ctx) => {
			if (args.trim().toLowerCase() === "reload") {
				activeConfig = loadConfig(ctx);
				ctx.ui.notify("pi-statusline config reloaded", "info");
				requestRender?.();
				return;
			}
			enabled = !enabled;
			if (enabled && ctx.mode === "tui") {
				activeConfig = loadConfig(ctx);
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

	enabled = true;
}
