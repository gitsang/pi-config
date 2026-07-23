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
 * other extension. Example: pi-service-tier calls setStatus("service-tier",
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
let forceColor: string | null = null;
const c = (rgb: string, s: string): string => (s === "" ? "" : `\x1b[38;2;${forceColor ?? rgb}m${s}\x1b[0m`);

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

// Shared grapheme segmenter for from-start truncation (paths are short; few calls).
const graphemeSegmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });

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
	truncate?: "start" | "end";  // which side to ellipsis when truncated (default "end")
}

interface LineConfig {
	left?: string[];
	right?: string[];
	full?: string[];
	sep?: string;        // item spacer for this line (both sides / full)
	sepLeft?: string;
	sepRight?: string;
}

interface FocusConfig {
	enabled: boolean;
	dimUnfocused: boolean;
	unfocusedColor: string;
}

interface RawConfig {
	lines?: LineConfig[];
	modules?: Record<string, ModuleConfig>;
	separator?: { group?: string; item?: string; groupColor?: string };
	priority?: Record<string, number>;
	focus?: Partial<FocusConfig>;
}

interface StatuslineConfig {
	lines: LineConfig[];
	modules: Record<string, ModuleConfig>;
	separator: { group: string; item: string; groupColor: string };
	priority: Record<string, number>;
	focus: FocusConfig;
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
		cwd: { source: "session.cwd", color: "fg", truncate: "start" },
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
		focus: { ...(a.focus ?? {}), ...(b.focus ?? {}) },
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
	const fr = isObj(raw.focus) ? (raw.focus as Partial<FocusConfig>) : {};
	const focus: FocusConfig = {
		enabled: fr.enabled === true,
		dimUnfocused: !!fr.dimUnfocused,
		unfocusedColor: typeof fr.unfocusedColor === "string" ? fr.unfocusedColor : "comment",
	};
	return { lines, modules, separator, priority, focus };
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
		case "focus": return focused ? "focused" : "unfocused";
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

function renderModule(mc: ModuleConfig, sc: SourceContext): { text: string; parts?: { glyphPart: string; plainBody: string; color: string } } {
	try {
		if (mc.source === "ctx.bar") {
			const pct = sc.ctxUsage?.percent ?? null;
			return { text: progressBar(pct, mc.cells ?? 8, resolveColor(mc.color, pct)) };
		}
		if (mc.source === "focus" && mc.glyph) {
			return { text: c(resolveColor(mc.color, focused ? "focused" : "unfocused"), mc.glyph) };
		}
		const raw = fetchSource(mc.source, sc, mc);
		const formatted = formatValue(mc.format, raw, mc.nullText);
		if (formatted === "") return { text: "" };
		const body = `${mc.prefix ?? ""}${formatted}${mc.suffix ?? ""}`;
		const color = resolveColor(mc.color, raw);
		const glyphPart = mc.glyph ? `${c(color, mc.glyph)} ` : "";
		const text = glyphPart + (body ? c(color, body) : "");
		// Expose plain parts so the layout can ellipsis the *front* (keep the tail)
		// when truncate === "start" — e.g. a long cwd shows "…/pi-statusline".
		const parts = mc.truncate === "start" ? { glyphPart, plainBody: body, color } : undefined;
		return { text, parts };
	} catch {
		return { text: "" };
	}
}

// ─── layout items ───────────────────────────────────────────────────────────
interface Item {
	key: string;
	pri: number;
	group: number;
	text: string;
	// present when the module opts into truncate: "start"
	truncateFromStart?: boolean;
	plainBody?: string;
	color?: string;
	glyphPart?: string;
}

function buildItems(names: string[] | undefined, sc: SourceContext, cfg: StatuslineConfig): Item[] {
	return (names ?? []).map((name) => {
		const mc = cfg.modules[name];
		const r = mc ? renderModule(mc, sc) : { text: "" };
		const item: Item = {
			key: name,
			pri: cfg.priority[name] ?? 50,
			group: mc?.group ?? 0,
			text: r.text,
		};
		if (r.parts) {
			item.truncateFromStart = true;
			item.plainBody = r.parts.plainBody;
			item.color = r.parts.color;
			item.glyphPart = r.parts.glyphPart;
		}
		return item;
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
// Keep the visible tail of `plain` (≤ keepWidth columns), dropping leading graphemes.
function takeTrailingByWidth(plain: string, keepWidth: number): string {
	if (keepWidth <= 0 || !plain) return "";
	let w = 0;
	let out = "";
	const graphs = [...graphemeSegmenter.segment(plain)].map((s) => s.segment);
	for (let i = graphs.length - 1; i >= 0; i--) {
		const g = graphs[i]!;
		const gw = visibleWidth(g);
		if (w + gw > keepWidth) break;
		out = g + out;
		w += gw;
	}
	return out;
}

// Truncate a single rendered item from the front: keep the glyph (if any) and a
// tail of the body, prefixed by an ellipsis. A space follows the ellipsis so
// the wide "…" glyph doesn't crowd the kept tail ("… /pi-statusline").
// Preserves the module color (incl. focus-dim forceColor).
function renderTruncatedFromStart(it: Item, maxWidth: number, ellipsis: string): string {
	if (maxWidth <= 0) return "";
	const glyphPart = it.glyphPart ?? "";
	const glyphW = visibleWidth(glyphPart);
	const avail = maxWidth - glyphW;
	if (avail <= 0) return truncateToWidth(glyphPart, maxWidth, ellipsis);
	const body = it.plainBody ?? "";
	const color = it.color ?? P.fg;
	if (visibleWidth(body) <= avail) return glyphPart + (body ? c(color, body) : "");
	const prefix = `${ellipsis} `;
	const pW = visibleWidth(prefix);
	// Not enough room for the spaced ellipsis plus at least one tail char:
	// fall back to a bare (clipped) ellipsis, matching the end-truncation path.
	if (avail < pW + 1) return truncateToWidth(c(color, ellipsis), maxWidth, "");
	return glyphPart + c(color, prefix + takeTrailingByWidth(body, avail - pW));
}

// Truncate a single item's text, honoring per-module truncate direction.
function truncItemText(it: Item, maxWidth: number, ellipsis: string): string {
	if (it.truncateFromStart && maxWidth > 0) return renderTruncatedFromStart(it, maxWidth, ellipsis);
	return truncateToWidth(it.text, maxWidth, ellipsis);
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
	if (live.length === 1 && kept.has(live[0]!.key) && live[0]!.truncateFromStart) {
		return renderTruncatedFromStart(live[0]!, width, "…");
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
			const leftTrunc = truncItemText(lLive[0]!, maxLeft, "…");
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
	const right = renderItems(rLive, rKept, rightSp, groupSp);
	const rw = visibleWidth(right);
	const gap = rw > 0 ? 1 : 0;
	const maxLeft = Math.max(0, width - rw - gap);
	const leftSingle = lLive.length === 1 && lKept.has(lLive[0]!.key) ? lLive[0]! : null;
	const leftTrunc = leftSingle
		? truncItemText(leftSingle, maxLeft, "…")
		: truncateToWidth(renderItems(lLive, lKept, leftSp, groupSp), maxLeft, "…");
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
	focus: { enabled: false, dimUnfocused: false, unfocusedColor: "comment" },
};

function renderFooter(ctx: any, footerData: any, width: number): string[] {
	try {
		const sc = buildSourceContext(ctx, footerData);
		const cfg = activeConfig;
		forceColor = !focused && cfg.focus.dimUnfocused ? palette(cfg.focus.unfocusedColor) : null;
		try {
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
		} finally {
			forceColor = null;
		}
	} catch {
		return ["".padEnd(width)];
	}
}

// ─── setup ───────────────────────────────────────────────────────────────────
let enabled = false;
let requestRender: (() => void) | undefined;

// ─── focus tracking (DEC 1004 focus-in/out) ──────────────────────────────────
// When enabled, writes ESC[?1004h so the terminal reports focus changes as
// ESC[I (focused) / ESC[O (blurred). Lets the footer dim/recolor when its pane
// loses focus — handy when several pi panes share one window.
// NOTE: inside tmux, also set `set -g focus-events on` so pane switches report.
let focused = true;

function setupFocus(tui: any): (() => void) | null {
	if (!activeConfig.focus.enabled || !tui?.addInputListener) return null;
	const term = tui.terminal ?? process.stdout;
	const write = (s: string) => { try { term.write(s); } catch { /* ignore */ } };
	write("\x1b[?1004h");
	const unsub = tui.addInputListener((data: string) => {
		if (data === "\x1b[I" || data === "\x1b[O") {
			const next = data === "\x1b[I";
			if (next !== focused) { focused = next; requestRender?.(); }
			return { consume: true };
		}
		return undefined;
	});
	const restore = () => { try { write("\x1b[?1004l"); } catch { /* ignore */ } unsub(); };
	process.on("exit", restore);
	return () => { process.off("exit", restore); restore(); };
}

function setupFooter(ctx: ExtensionContext): void {
	ctx.ui.setFooter((tui: any, _theme: any, footerData: any) => {
		requestRender = () => tui.requestRender();
		const unsub = footerData.onBranchChange(() => tui.requestRender());
		const teardownFocus = setupFocus(tui);
		return {
			dispose: () => { unsub(); teardownFocus?.(); requestRender = undefined; },
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
		description: "Toggle pi-statusline footer (| reload | focus)",
		handler: async (args, ctx) => {
			const sub = args.trim().toLowerCase();
			if (sub === "reload") {
				activeConfig = loadConfig(ctx);
				if (enabled && ctx.mode === "tui") setupFooter(ctx);
				ctx.ui.notify("pi-statusline config reloaded", "info");
				requestRender?.();
				return;
			}
			if (sub === "focus") {
				const tmux = process.env.TMUX ? " | tmux: needs 'set -g focus-events on'" : "";
				ctx.ui.notify(`statusline focus: ${focused ? "focused" : "unfocused"} | tracking ${activeConfig.focus.enabled ? "on" : "off"}${tmux}`, "info");
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
