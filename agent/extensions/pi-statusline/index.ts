/**
 * pi-statusline — configurable, information-dense Tokyo Night statusline.
 *
 * Fully config-driven. Zero config = the default 4-line footer (preserved
 * behavior). Data sources are a fixed registry (cwd, model, usage, ctx, ttft,
 * tps, task.elapsed, task.elapsedTotal, thinking, branch, title, ext-status, literal). New read-only
 * sources can be added to the registry; the TTFT/TPS/task-elapsed sources are stateful and built-in.
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
 *   /statusline-reset    reset TTFT/TPS/task-elapsed history
 */

import {
	buildSessionContext,
	CONFIG_DIR_NAME,
	estimateTokens,
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
function fmtHms(ms: number): string {
	const totalSec = Math.max(0, Math.round(ms / 1000));
	const h = Math.floor(totalSec / 3600);
	const m = Math.floor((totalSec % 3600) / 60);
	const s = totalSec % 60;
	if (h > 0) return `${h}h${m}m${s}s`;
	if (m > 0) return `${m}m${s}s`;
	return `${s}s`;
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
	format?: string;     // tok|pct|sec1|hms|tps1|dollars3|int|ctxnums|raw
	valueMap?: Record<string, string>;  // raw value -> display text/icon
	color?: ColorSpec;
	estimateColor?: ColorSpec;  // color used instead of color when the value is an estimate (post-compaction)
	prefix?: string;
	suffix?: string;
	cells?: number;      // ctx.bar
	nullText?: string;   // shown when value is null/empty ("" => drop)
	estimateMarker?: string;  // prefix shown when value is an estimate (default "≈", "" disables)
	group?: number;
	priority?: number;   // drop priority when the line overflows (lower drops first; <90 can be dropped)
	truncate?: "start" | "end";  // which side to ellipsis when truncated (default "end")
}

interface LineConfig {
	left?: string[];
	right?: string[];
	full?: string[];
	sep?: string;        // item spacer for this line (both sides / full)
	sepLeft?: string;
	sepRight?: string;
	groupSep?: string;   // spacer between module groups on this line (default " │ ")
}

interface FocusConfig {
	enabled: boolean;
	dimUnfocused: boolean;
	unfocusedColor: string;
}

interface RawConfig {
	lines?: LineConfig[];
	modules?: Record<string, ModuleConfig>;
	focus?: Partial<FocusConfig>;
}

interface StatuslineConfig {
	lines: LineConfig[];
	modules: Record<string, ModuleConfig>;
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
			sepLeft: "  ", sepRight: " ", groupSep: " │ ",
		},
		{ full: ["elapsed", "ttft", "ttftAvg", "tps", "tpsAvg"], sep: "  " },
	],
	modules: {
		cwd: { source: "session.cwd", color: "fg", truncate: "start", priority: 100 },
		title: { source: "session.name", color: "comment", priority: 30 },
		branch: { source: "footer.branch", color: "green", priority: 60 },
		model: { source: "model.id", color: "blue", priority: 95 },
		thinking: { source: "thinking", color: "magenta", priority: 40 },
		stier: {
			source: "ext-status", key: "service-tier", glyph: "\uf0e7",
			color: { map: { priority: "orange", flex: "blue", scale: "green", off: "comment" }, default: "fgDark" },
			priority: 35,
		},
		tokIn: { source: "usage.input", glyph: "\uf01b", format: "tok", color: "cyan", priority: 100 },
		tokOut: { source: "usage.output", glyph: "\uf01a", format: "tok", color: "green1", priority: 95 },
		cacheR: { source: "usage.cacheRead", glyph: "\udb84\ude5b", format: "tok", color: "blue5", priority: 50 },
		cacheW: { source: "usage.cacheWrite", glyph: "\udb84\ude59", format: "tok", color: "purple", priority: 40 },
		cacheHit: { source: "usage.ch", glyph: "\uf49b", format: "pct", nullText: "0%", color: "yellow", priority: 45 },
		cost: { source: "usage.cost", glyph: "\uef8d", format: "dollars3", color: "orange", priority: 70 },
		elapsed: {
			source: "task.elapsedTotal",
			glyph: "\uf2f2",
			format: "hms",
			nullText: "0s",
			color: "yellow",
			priority: 95,
		},
		ctxLabel: { source: "literal", text: "ctx", color: "comment", priority: 100 },
		ctxBar: {
			source: "ctx.bar", cells: 8,
			color: { thresholds: [{ op: "gte", n: 80, color: "red" }, { op: "gte", n: 50, color: "yellow" }], default: "green" },
			priority: 60,
		},
		ctxPct: {
			source: "ctx.percent", format: "pct", nullText: "?",
			color: { thresholds: [{ op: "gte", n: 80, color: "red" }, { op: "gte", n: 50, color: "yellow" }], default: "green" },
			priority: 95,
		},
		ctxNums: { source: "ctx.nums", color: "fgDark", priority: 40 },
		ttft: {
			source: "ttft", glyph: "\uf252", format: "sec1", nullText: "0.0s",
			color: { thresholds: [{ op: "gte", n: 3000, color: "red" }, { op: "gte", n: 1000, color: "yellow" }], default: "green" },
			priority: 100,
		},
		ttftAvg: { source: "ttft.avg", format: "sec1", prefix: "(avg ", suffix: ")", color: "comment", priority: 40 },
		tps: { source: "tps", glyph: "\uf0e4", format: "tps1", nullText: "0.0tok/s", color: "cyan", priority: 95 },
		tpsAvg: { source: "tps.avg", format: "tps1", prefix: "(avg ", suffix: ")", color: "comment", priority: 30 },
	},
};

function mergeRaw(a: RawConfig, b: RawConfig): RawConfig {
	return {
		lines: Array.isArray(b.lines) ? b.lines : a.lines,
		modules: { ...(a.modules ?? {}), ...(b.modules ?? {}) },
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
	const fr = isObj(raw.focus) ? (raw.focus as Partial<FocusConfig>) : {};
	const focus: FocusConfig = {
		enabled: fr.enabled === true,
		dimUnfocused: !!fr.dimUnfocused,
		unfocusedColor: typeof fr.unfocusedColor === "string" ? fr.unfocusedColor : "comment",
	};
	return { lines, modules, focus };
}

// ─── source registry ────────────────────────────────────────────────────────
interface SourceContext {
	ctx: any;
	footerData: any;
	model: any;
	usage: { input: number; output: number; cacheRead: number; cacheWrite: number; cost: number; ch: number | null };
	ctxUsage: any;
	ctxEstimated: boolean;  // true when ctxUsage was estimated (post-compaction), not from a real response
	timing: { ttft: number | null; tps: number | null };
	timingAvg: { ttft: number | null; tps: number | null };
	task: { elapsed: number | null; elapsedTotal: number };
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
		case "task.elapsed": return sc.task.elapsed;
		case "task.elapsedTotal": return sc.task.elapsedTotal;
		case "ext-status": return sc.footerData?.getExtensionStatuses?.()?.get(mc.key ?? "") ?? null;
		case "literal": return mc.text ?? "";
		case "focus": return focusState();
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
		case "sec0": return `${Math.round(num / 1000)}s`;
		case "sec1": return `${(num / 1000).toFixed(1)}s`;
		case "hms": return fmtHms(num);
		case "tps1": return `${num.toFixed(1)}tok/s`;
		case "dollars3": return `$${num.toFixed(3)}`;
		case "int": return `${Math.round(num)}`;
		default: return String(raw);
	}
}

// Sources whose value can be an estimate (vs. exact window / real usage).
const ESTIMATED_CTX_SOURCES = new Set(["ctx.percent", "ctx.tokens", "ctx.nums", "ctx.bar"]);
function estimatePrefix(mc: ModuleConfig, sc: SourceContext): string {
	if (!sc.ctxEstimated || !ESTIMATED_CTX_SOURCES.has(mc.source)) return "";
	return mc.estimateMarker ?? "≈";
}
// When a value is estimated, swap in estimateColor so estimates read differently
// from real usage even without a text marker.
function moduleColor(mc: ModuleConfig, sc: SourceContext, raw: any): string {
	return resolveColor(sc.ctxEstimated && mc.estimateColor ? mc.estimateColor : mc.color, raw);
}

function renderModule(mc: ModuleConfig, sc: SourceContext): { text: string; parts?: { glyphPart: string; plainBody: string; color: string } } {
	try {
		if (mc.source === "ctx.bar") {
			const pct = sc.ctxUsage?.percent ?? null;
			const color = moduleColor(mc, sc, pct);
			return { text: `${c(color, estimatePrefix(mc, sc))}${progressBar(pct, mc.cells ?? 8, color)}` };
		}
		if (mc.source === "focus" && mc.glyph) {
			return { text: c(resolveColor(mc.color, focusState()), mc.glyph) };
		}
		const raw = fetchSource(mc.source, sc, mc);
		const displayValue = raw === null || raw === undefined
			? raw
			: (mc.valueMap?.[String(raw)] ?? raw);
		const formatted = formatValue(mc.format, displayValue, mc.nullText);
		if (formatted === "") return { text: "" };
		const body = `${estimatePrefix(mc, sc)}${mc.prefix ?? ""}${formatted}${mc.suffix ?? ""}`;
		const color = moduleColor(mc, sc, raw);
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
	// present when the module explicitly opts into truncate: "end"
	truncateFromEnd?: boolean;
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
			pri: mc?.priority ?? 50,
			group: mc?.group ?? 0,
			text: r.text,
		};
		if (r.parts) {
			item.truncateFromStart = true;
			item.plainBody = r.parts.plainBody;
			item.color = r.parts.color;
			item.glyphPart = r.parts.glyphPart;
		}
		if (mc?.truncate === "end") item.truncateFromEnd = true;
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
	// Items that opt into end-truncation are kept and ellipsized instead of
	// being dropped when the line overflows.
	const droppable = live.filter((it) => it.pri < 90 && !it.truncateFromEnd).sort((a, b) => a.pri - b.pri);
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
	// Items that opt into end-truncation are kept and ellipsized instead of
	// being dropped when the line overflows.
	const droppable = [
		...lLive.filter((it) => it.pri < 90 && !it.truncateFromEnd),
		...rLive.filter((it) => it.pri < 90 && !it.truncateFromEnd),
	].sort((a, b) => a.pri - b.pri);
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
// Aggregate (weighted) TPS: Σ output tokens / Σ generation ms — robust against
// burst-delivered responses, unlike a mean of per-message rates.
let tpsOutSum = 0;
let tpsMsSum = 0;
const ttftHistory: number[] = [];
// No real model sustains this; above it the "first token → end" window must be
// an artifact of a buffering gateway that flushes the whole response at once.
const MAX_PLAUSIBLE_TPS = 1000;

// ─── task elapsed timing state ───────────────────────────────────────────────
let taskStartedAt: number | null = null;
let lastTaskElapsedMs: number | null = null;
let sessionTaskTotalMs = 0;
let elapsedTicker: ReturnType<typeof setInterval> | null = null;

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
	const coreUsage = ctx.getContextUsage();
	// After compaction, the core deliberately reports tokens: null ("unknown")
	// until the next real LLM response, because the last assistant usage is
	// pre-compaction and can't anchor an estimate. Fall back to a per-message
	// char/4 estimate (compaction summary + kept tail) so the statusline can
	// still show a number, flagged as an estimate.
	let ctxUsage = coreUsage;
	let ctxEstimated = false;
	if (coreUsage && coreUsage.tokens == null) {
		try {
			const messages = buildSessionContext(ctx.sessionManager.getBranch()).messages;
			let tokens = 0;
			for (const m of messages) tokens += estimateTokens(m);
			const window = coreUsage.contextWindow ?? ctx.model?.contextWindow ?? 0;
			if (tokens > 0 && window > 0) {
				ctxUsage = { tokens, contextWindow: window, percent: (tokens / window) * 100 };
				ctxEstimated = true;
			}
		} catch { /* ignore */ }
	}
	const ttftAvg = ttftHistory.length ? ttftHistory.reduce((a, b) => a + b, 0) / ttftHistory.length : null;
	const tpsAvg = tpsMsSum > 0 ? tpsOutSum / (tpsMsSum / 1000) : null;
	const taskElapsed = taskStartedAt !== null ? Date.now() - taskStartedAt : lastTaskElapsedMs;
	const taskElapsedTotal = sessionTaskTotalMs + (taskStartedAt !== null ? Date.now() - taskStartedAt : 0);
	return { ctx, footerData, model: ctx.model, usage, ctxUsage, ctxEstimated, timing: lastTiming, timingAvg: { ttft: ttftAvg, tps: tpsAvg }, task: { elapsed: taskElapsed, elapsedTotal: taskElapsedTotal } };
}

// ─── render ──────────────────────────────────────────────────────────────────
let activeConfig: StatuslineConfig = {
	lines: DEFAULT_RAW.lines!, modules: DEFAULT_RAW.modules!,
	focus: { enabled: false, dimUnfocused: false, unfocusedColor: "comment" },
};

function renderFooter(ctx: any, footerData: any, width: number): string[] {
	try {
		const sc = buildSourceContext(ctx, footerData);
		const cfg = activeConfig;
		forceColor = focusState() === "unfocused" && cfg.focus.dimUnfocused
			? palette(cfg.focus.unfocusedColor)
			: null;
		try {
			return cfg.lines.map((line) => {
				const groupSp = line.groupSep ?? " │ ";
				const itemSp = line.sep ?? " ";
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

function startElapsedTicker(): void {
	if (elapsedTicker) return;
	elapsedTicker = setInterval(() => requestRender?.(), 1000);
	if (typeof elapsedTicker.unref === "function") elapsedTicker.unref();
}

function stopElapsedTicker(): void {
	if (!elapsedTicker) return;
	clearInterval(elapsedTicker);
	elapsedTicker = null;
}

function beginTaskTiming(): void {
	if (taskStartedAt === null) taskStartedAt = Date.now();
	startElapsedTicker();
	requestRender?.();
}

function finishTaskTiming(): void {
	if (taskStartedAt !== null) {
		lastTaskElapsedMs = Date.now() - taskStartedAt;
		sessionTaskTotalMs += lastTaskElapsedMs;
	}
	taskStartedAt = null;
	stopElapsedTicker();
	requestRender?.();
}

// ─── focus subscription ─────────────────────────────────────────────────────
// The standalone pi-focus extension is the sole DEC 1004 owner. This extension
// only subscribes to its event bus channel, avoiding terminal-input races.
const FOCUS_CHANNEL = "pi-focus:change";
let focused = true;
let focusSeen = false;

function focusState(): "focused" | "unfocused" {
	return !activeConfig.focus.enabled || focused ? "focused" : "unfocused";
}

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
	pi.events.on(FOCUS_CHANNEL, (data: unknown) => {
		if (!data || typeof data !== "object") return;
		const next = (data as { focused?: unknown }).focused;
		if (typeof next !== "boolean") return;
		focusSeen = true;
		if (next !== focused) { focused = next; requestRender?.(); }
	});

	pi.on("agent_start", beginTaskTiming);
	pi.on("agent_settled", finishTaskTiming);

	pi.on("before_provider_request", () => { requestStart = Date.now(); });
	pi.on("message_start", () => { msgStart = requestStart; firstToken = null; });
	pi.on("message_update", (e: any) => {
		const type: string | undefined = e?.assistantMessageEvent?.type;
		if (type && /_delta$/.test(type) && firstToken === null) firstToken = Date.now();
	});
	pi.on("message_end", (e: any) => {
		const msg = e?.message;
		if (msg?.role === "assistant") {
			const output: number = msg?.usage?.output ?? 0;
			if (firstToken !== null && msgStart !== null) {
				const now = Date.now();
				const ttft = firstToken - msgStart;
				const genMs = Math.max(0, now - firstToken);
				let tps = genMs > 0 ? output / (genMs / 1000) : null;
				let msCounted = genMs;
				// Buffering gateway: the entire response arrived in one burst, so
				// "first token → end" is ~0. Fall back to end-to-end request
				// throughput (output / time since request start) instead.
				if (tps !== null && tps > MAX_PLAUSIBLE_TPS && now > msgStart) {
					msCounted = now - msgStart;
					tps = msCounted > 0 ? output / (msCounted / 1000) : null;
				}
				lastTiming = { ttft: ttft >= 0 ? ttft : null, tps };
				if (ttft >= 0) ttftHistory.push(ttft);
				if (tps !== null && output > 0 && msCounted > 0) {
					tpsOutSum += output;
					tpsMsSum += msCounted;
				}
				firstToken = null;
			}
		}
		requestStart = null;
		requestRender?.();
	});
	pi.on("thinking_level_select", () => requestRender?.());
	pi.on("model_select", () => requestRender?.());

	pi.on("session_start", (_e, ctx: ExtensionContext) => {
		stopElapsedTicker();
		taskStartedAt = null;
		lastTaskElapsedMs = null;
		sessionTaskTotalMs = 0;
		activeConfig = loadConfig(ctx);
		if (enabled && ctx.mode === "tui") setupFooter(ctx);
	});

	pi.on("session_shutdown", () => {
		stopElapsedTicker();
		taskStartedAt = null;
		lastTaskElapsedMs = null;
		sessionTaskTotalMs = 0;
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
				const tracking = activeConfig.focus.enabled
					? (focusSeen ? "event seen" : "waiting for event")
					: "disabled";
				ctx.ui.notify(`statusline focus: ${focusState()} | via pi-focus (${tracking})${tmux}`, "info");
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
		description: "Reset TTFT/TPS/task-elapsed history",
		handler: async (_args, ctx) => {
			lastTiming = { ttft: null, tps: null };
			tpsOutSum = 0;
			tpsMsSum = 0;
			ttftHistory.length = 0;
			lastTaskElapsedMs = null;
			sessionTaskTotalMs = 0;
			ctx.ui.notify("statusline timing history reset", "info");
			requestRender?.();
		},
	});

	enabled = true;
}
