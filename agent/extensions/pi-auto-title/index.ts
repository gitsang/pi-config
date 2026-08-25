/**
 * pi-auto-title — automatic session titles for pi.
 *
 * - Generates a short title as soon as the first user input is submitted (default on).
 * - Regenerates the title after compaction, from the compaction summary (default on).
 * - Optionally refreshes the title every N user inputs (default off).
 * - Manual regeneration / control via the `/auto-title` command.
 * - Titles are shown in the TUI via pi.setSessionName() (session selector + header).
 *
 * Config files (JSON, project overrides global):
 *   <ext-dir>/config.json            (global, lives next to this extension)
 *   <cwd>/.pi/pi-auto-title.json        (project, trusted only)
 *   See config.example.json for a filled-in template.
 *
 * Config schema (all optional):
 * {
 *   "model": "saigw/glm-5.2",   // "provider/modelId"; default = current model
 *   "onFirstTurn": true,        // generate after first user input (default true)
 *   "onCompact": true,          // regenerate after compaction (default true)
 *   "refreshEveryTurns": 0,     // 0 = off; N = regenerate every N user inputs
 *   "maxTitleLength": 35,       // truncate title to this terminal display width
 *   "language": "auto",         // "auto" | "zh" | "en" (default "auto")
 *   "setTerminalTitle": false,  // also set the terminal/tab title (default false)
 *   "includeAssistantOutput": true // include each turn's final assistant output in title context (default true)
 * }
 *
 * Command:
 *   /auto-title            regenerate now
 *   /auto-title regen      (same)
 *   /auto-title off        disable auto-generation for this session
 *   /auto-title on         re-enable auto-generation
 *   /auto-title status     show current config + state
 */

import { complete } from "@earendil-works/pi-ai/compat";
import {
	CONFIG_DIR_NAME,
	type ExtensionAPI,
	type ExtensionContext,
	type SessionMessageEntry,
} from "@earendil-works/pi-coding-agent";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/** Directory this extension lives in — config is read next to it. */
const EXT_DIR = dirname(fileURLToPath(import.meta.url));
const STATUS_KEY = "pi-auto-title";
const SPINNER_FRAMES = ["⠦", "⠧", "⠇", "⠏", "⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠤"];

type Language = "auto" | "zh" | "en";

interface AutoTitleConfig {
	model?: string;
	onFirstTurn?: boolean;
	onCompact?: boolean;
	refreshEveryTurns?: number;
	maxTitleLength?: number;
	language?: Language;
	setTerminalTitle?: boolean;
	includeAssistantOutput?: boolean;
}

interface ResolvedConfig {
	model: string | undefined;
	onFirstTurn: boolean;
	onCompact: boolean;
	refreshEveryTurns: number;
	maxTitleLength: number;
	language: Language;
	setTerminalTitle: boolean;
	includeAssistantOutput: boolean;
}

const DEFAULTS: ResolvedConfig = {
	model: undefined,
	onFirstTurn: true,
	onCompact: true,
	refreshEveryTurns: 0,
	maxTitleLength: 35,
	language: "auto",
	setTerminalTitle: false,
	includeAssistantOutput: true,
};

type GenSource = "first" | "compact" | "periodic" | "manual";

interface State {
	config: ResolvedConfig;
	roundCount: number;
	enabled: boolean;
	generating: boolean;
	generationEpoch: number;
}

function resolveConfig(raw: AutoTitleConfig): ResolvedConfig {
	return { ...DEFAULTS, ...raw };
}

function loadConfig(ctx: ExtensionContext): AutoTitleConfig {
	const tryRead = (p: string): AutoTitleConfig | null => {
		try {
			return JSON.parse(readFileSync(p, "utf8")) as AutoTitleConfig;
		} catch {
			return null;
		}
	};

	let merged: AutoTitleConfig = tryRead(join(EXT_DIR, "config.json")) ?? {};
	if (ctx.isProjectTrusted()) {
		const project = tryRead(join(ctx.cwd, CONFIG_DIR_NAME, "pi-auto-title.json"));
		if (project) merged = { ...merged, ...project };
	}
	return merged;
}

/** Extract the text content from a user or assistant message. */
function extractMessageText(message: SessionMessageEntry["message"]): string {
	if (!("role" in message) || !("content" in message)) return "";
	const content = message.content;
	if (typeof content === "string") return content;
	return content
		.filter((block): block is { type: "text"; text: string } => block.type === "text")
		.map((block) => block.text)
		.join("\n");
}

/**
 * Collect the conversation for title generation.
 *
 * Walks the current branch in order and builds user/assistant turn pairs. When
 * `includeAssistantOutput` is true, each turn also includes the final assistant
 * text of that turn (tool calls and thinking are ignored).
 */
function buildConversationText(
	ctx: ExtensionContext,
	includeAssistantOutput: boolean,
	extraText?: string,
): string {
	const branch = ctx.sessionManager.getBranch();
	const parts: string[] = [];
	let currentUser: string | null = null;
	let currentAssistant: string | null = null;
	let lastUser: string | null = null;

	const flushTurn = () => {
		if (currentUser === null) return;
		parts.push(`User: ${currentUser}`);
		if (includeAssistantOutput && currentAssistant) parts.push(`Assistant: ${currentAssistant}`);
		currentUser = null;
		currentAssistant = null;
	};

	for (const entry of branch) {
		if (entry.type !== "message") continue;
		const message: SessionMessageEntry["message"] = entry.message;
		if (!("role" in message)) continue;

		if (message.role === "user") {
			const text = extractMessageText(message).trim();
			if (!text) continue;
			flushTurn();
			currentUser = text;
			lastUser = text;
		} else if (message.role === "assistant") {
			if (!includeAssistantOutput) continue;
			currentAssistant = extractMessageText(message).trim();
		}
	}
	flushTurn();

	const extra = extraText?.trim();
	if (extra && lastUser !== extra) parts.push(`User: ${extra}`);
	return parts.join("\n\n");
}

/** True for inputs pi handles as commands rather than conversation (/, !, $). */
function isCommandInput(text: string): boolean {
	const t = text.trimStart();
	if (t.startsWith("/") || t.startsWith("!")) return true;
	if (t.charCodeAt(0) !== 36) return false; // '$'
	if (t.charCodeAt(1) === 123) return false; // '${...}'
	const offset = t.charCodeAt(1) === 36 ? 2 : 1; // '$$'
	const c = t.charCodeAt(offset);
	if (Number.isNaN(c)) return false;
	return (c === 32 || c === 9 || c === 10 || c === 13) && t.slice(offset).trim().length > 0;
}

const ELLIPSIS = "…";

/**
 * Remove <thinking>/<reasoning> sections from a text block.
 *
 * Some endpoints (notably certain vLLM builds for Qwen3 models) inline the
 * model's chain of thought into the regular content text. Closed pairs are
 * removed; an opening tag without a closing one (happens when generation is
 * truncated mid-thought) is stripped through the end of the block.
 */
function stripThinkingTags(text: string): string {
	return text
		.replace(/<\s*(?:thinking|reasoning)\b[^>]*>[\s\S]*?<\s*\/\s*(?:thinking|reasoning)\s*>/gi, " ")
		.replace(/<\s*(?:thinking|reasoning)\b[\s\S]*$/gi, " ")
		.trim();
}

/**
 * Terminal display-width helpers.
 *
 * We approximate the width a modern terminal gives a Unicode code point:
 * East Asian Wide / Fullwidth glyphs count as 2, combining marks and
 * zero-width/control/format characters count as 0, everything else counts as 1.
 * Widths are summed per code point so truncation never splits a surrogate pair
 * or a double-width glyph in half.
 */
const ZERO_WIDTH_RE = /^[\p{M}\p{Cc}\p{Cf}]$/u;

const WIDE_RANGES: ReadonlyArray<readonly [number, number]> = [
	[0x1100, 0x115f], // Hangul Jamo consonants
	[0x2e80, 0x303e], // CJK Radicals, Kangxi, CJK punctuation/symbols
	[0x3040, 0x30ff], // Hiragana, Katakana
	[0x3100, 0x312f], // Bopomofo
	[0x3130, 0x318f], // Hangul Compatibility Jamo
	[0x3190, 0x319f], // Kanbun
	[0x31a0, 0x31bf], // Bopomofo Extended
	[0x31f0, 0x31ff], // Katakana Phonetic Extensions
	[0x3200, 0x32ff], // Enclosed CJK Letters and Months
	[0x3300, 0x33ff], // CJK Compatibility
	[0x3400, 0x4dbf], // CJK Unified Ideographs Extension A
	[0x4dc0, 0x4dff], // Yijing Hexagram Symbols
	[0x4e00, 0x9fff], // CJK Unified Ideographs
	[0xa000, 0xa48f], // Yi Syllables
	[0xa490, 0xa4cf], // Yi Radicals
	[0xa960, 0xa97f], // Hangul Jamo Extended-A
	[0xac00, 0xd7a3], // Hangul Syllables
	[0xd7b0, 0xd7ff], // Hangul Jamo Extended-B
	[0xf900, 0xfaff], // CJK Compatibility Ideographs
	[0xfe10, 0xfe19], // Vertical Forms
	[0xfe30, 0xfe52], // CJK Compatibility Forms
	[0xfe54, 0xfe66], // Small Form Variants
	[0xfe68, 0xfe6b], // Small Form Variants
	[0xff00, 0xff60], // Fullwidth Forms
	[0xffe0, 0xffe6], // Fullwidth Signs
	[0x1b000, 0x1b2ff], // Kana Supplement / Small Kana Extended
	[0x1f200, 0x1f2ff], // Enclosed Ideographic Supplement
	[0x1f300, 0x1f64f], // Emoticons
	[0x1f680, 0x1f6ff], // Transport and Map Symbols
	[0x1f900, 0x1f9ff], // Supplemental Symbols and Pictographs
	[0x1fa70, 0x1faff], // Symbols and Pictographs Extended-A
	[0x20000, 0x2fffd], // CJK Unified Ideographs Extension B+
	[0x30000, 0x3fffd], // CJK Unified Ideographs Extension G+
];

function isWideCodePoint(cp: number): boolean {
	for (const [start, end] of WIDE_RANGES) {
		if (cp >= start && cp <= end) return true;
	}
	return false;
}

function codePointDisplayWidth(cp: number): number {
	if (ZERO_WIDTH_RE.test(String.fromCodePoint(cp))) return 0;
	if (isWideCodePoint(cp)) return 2;
	return 1;
}

function terminalDisplayWidth(text: string): number {
	let width = 0;
	for (const ch of text) width += codePointDisplayWidth(ch.codePointAt(0)!);
	return width;
}

function truncateToDisplayWidth(text: string, maxWidth: number): string {
	if (maxWidth <= 0) return "";
	if (terminalDisplayWidth(text) <= maxWidth) return text;

	const target = Math.max(0, maxWidth - terminalDisplayWidth(ELLIPSIS));
	let out = "";
	let width = 0;
	for (const ch of text) {
		const w = codePointDisplayWidth(ch.codePointAt(0)!);
		if (width + w > target) break;
		out += ch;
		width += w;
	}
	return `${out.trimEnd()}${ELLIPSIS}`;
}

function cleanupTitle(raw: string, maxLen: number): string {
	let t = raw.replace(/^["'`“”‘’]+|["'`“”‘’.。]+$/g, "").trim();
	t = t.replace(/\s+/g, " ");
	return truncateToDisplayWidth(t, maxLen);
}

export default function (pi: ExtensionAPI) {
	const state: State = {
		config: DEFAULTS,
		roundCount: 0,
		enabled: true,
		generating: false,
		generationEpoch: 0,
	};

	const notify = (ctx: ExtensionContext, msg: string, level: "info" | "warning" | "error") => {
		if (ctx.hasUI) ctx.ui.notify(msg, level);
	};

	let statusTimer: ReturnType<typeof setInterval> | undefined;

	const reloadConfig = (ctx: ExtensionContext) => {
		state.config = resolveConfig(loadConfig(ctx));
	};

	const setGeneratingStatus = (ctx: ExtensionContext, generating: boolean) => {
		if (statusTimer) {
			clearInterval(statusTimer);
			statusTimer = undefined;
		}
		if (!ctx.hasUI) return;
		if (!generating) {
			ctx.ui.setStatus(STATUS_KEY, undefined);
			return;
		}
		if (ctx.mode !== "tui") {
			ctx.ui.setStatus(STATUS_KEY, `${SPINNER_FRAMES[0]!}`);
			return;
		}

		let frame = 0;
		const render = () => {
			ctx.ui.setStatus(STATUS_KEY, `${SPINNER_FRAMES[frame]!}`);
			frame = (frame + 1) % SPINNER_FRAMES.length;
		};
		render();
		statusTimer = setInterval(render, 120);
	};

	const resolveModel = (ctx: ExtensionContext, cfg: ResolvedConfig) => {
		if (cfg.model) {
			const idx = cfg.model.indexOf("/");
			if (idx > 0) {
				const m = ctx.modelRegistry.find(cfg.model.slice(0, idx), cfg.model.slice(idx + 1));
				if (m) return m;
				notify(ctx, `pi-auto-title: configured model "${cfg.model}" not found, falling back to current model`, "warning");
			} else {
				notify(ctx, `pi-auto-title: invalid model "${cfg.model}", expected "provider/modelId"`, "warning");
			}
		}
		return ctx.model;
	};

	const generate = async (
		ctx: ExtensionContext,
		source: GenSource,
		conversationText: string,
		epoch: number,
	) => {
		const isCurrent = () => epoch === state.generationEpoch;
		const cfg = state.config;
		const model = resolveModel(ctx, cfg);
		if (!model) {
			if (isCurrent()) notify(ctx, "pi-auto-title: no model available", "warning");
			return;
		}

		const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
		if (!isCurrent()) return;
		if (!auth.ok) {
			notify(ctx, `pi-auto-title: auth failed: ${auth.error}`, "warning");
			return;
		}
		if (!auth.apiKey) {
			notify(ctx, `pi-auto-title: no api key for ${model.provider}/${model.id}`, "warning");
			return;
		}

		const langInstr =
			cfg.language === "zh"
				? "Use Chinese (简体中文)."
				: cfg.language === "en"
					? "Use English."
					: "Use the same language as the conversation.";

		const prompt = [
			"Generate a concise title for this conversation.",
			"Rules:",
			`- At most ${cfg.maxTitleLength} columns of terminal display width (wide CJK/emoji glyphs count as 2, combining marks count as 0).`,
			"- No surrounding quotes, no markdown, no trailing punctuation.",
			`- ${langInstr}`,
			"- Output ONLY the title text, nothing else.",
			"",
			"<conversation>",
			conversationText,
			"</conversation>",
		].join("\n");

		// Two thinking-model defenses:
		// - reasoning: "off" tells providers that model it (e.g. vLLM + Qwen via
		//   compat.thinkingFormat) to skip the thinking phase entirely.
		// - maxTokens must leave room for thinking on servers that ignore the
		//   "off" request: at 64 tokens the thought consumes the whole budget
		//   and the response is truncated mid-thought, leaving no title at all.
		const response = await complete(
			model,
			{ messages: [{ role: "user", content: [{ type: "text" as const, text: prompt }], timestamp: Date.now() }] },
			{ apiKey: auth.apiKey, headers: auth.headers, env: auth.env, maxTokens: 512, reasoning: "off" as const },
		);
		if (!isCurrent()) return;

		// Thinking blocks are excluded; text blocks get inline thinking stripped
		// (see stripThinkingTags) in case the server put it into content.
		const title = cleanupTitle(
			response.content
				.filter((c): c is { type: "text"; text: string } => c.type === "text")
				.map((c) => stripThinkingTags(c.text))
				.filter((text) => text.length > 0)
				.join(" "),
			cfg.maxTitleLength,
		);

		if (!title) {
			if (isCurrent()) notify(ctx, "pi-auto-title: model returned an empty title", "warning");
			return;
		}

		if (!isCurrent()) return;
		pi.setSessionName(title);
		if (cfg.setTerminalTitle && ctx.hasUI) ctx.ui.setTitle(`pi - ${title}`);
		notify(ctx, `pi-auto-title (${source}): ${title}`, "info");
	};

	const runGenerate = async (ctx: ExtensionContext, source: GenSource, text: string) => {
		if (state.generating) return;
		if (!state.enabled && source !== "manual") return;
		const epoch = state.generationEpoch;
		state.generating = true;
		try {
			setGeneratingStatus(ctx, true);
			await generate(ctx, source, text, epoch);
		} catch (err) {
			if (epoch === state.generationEpoch) {
				notify(ctx, `pi-auto-title: ${err instanceof Error ? err.message : String(err)}`, "error");
			}
		} finally {
			if (epoch === state.generationEpoch) {
				state.generating = false;
				setGeneratingStatus(ctx, false);
			}
		}
	};

	const isAutoMode = (ctx: ExtensionContext) => ctx.mode === "tui" || ctx.mode === "rpc";

	// Reset per-session state and (re)load config on every session start.
	pi.on("session_start", (_event, ctx) => {
		state.generationEpoch += 1;
		state.roundCount = 0;
		state.enabled = true;
		state.generating = false;
		setGeneratingStatus(ctx, false);
		reloadConfig(ctx);
	});

	pi.on("session_shutdown", (_event, ctx) => {
		state.generationEpoch += 1;
		setGeneratingStatus(ctx, false);
	});

	// First-turn / periodic refresh. This fires as soon as the user submits an
	// input, before the agent response starts, and generation runs in the background.
	pi.on("input", (event, ctx) => {
		if (!isAutoMode(ctx)) return;
		if (event.source !== "interactive" && event.source !== "rpc") return;
		if (!state.enabled) return;
		if (!event.text.trim() || isCommandInput(event.text)) return;

		state.roundCount += 1;
		const round = state.roundCount;
		const cfg = state.config;

		let source: GenSource | null = null;
		if (round === 1 && cfg.onFirstTurn && !pi.getSessionName()) {
			source = "first";
		} else if (cfg.refreshEveryTurns > 0 && round % cfg.refreshEveryTurns === 0) {
			source = "periodic";
		}
		if (!source) return;

		const text = buildConversationText(ctx, cfg.includeAssistantOutput, event.text);
		if (!text.trim()) return;
		void runGenerate(ctx, source, text);
	});

	// Regenerate from the compaction summary after compaction.
	// Also backgrounded so compaction isn't blocked on title generation.
	pi.on("session_compact", (event, ctx) => {
		if (!isAutoMode(ctx)) return;
		if (!state.config.onCompact) return;
		const text = event.compactionEntry.summary;
		if (!text.trim()) return;
		void runGenerate(ctx, "compact", text);
	});

	pi.registerCommand("auto-title", {
		description: "Auto session titles: [regen|on|off|status]",
		handler: async (args, ctx) => {
			const sub = (args.trim().split(/\s+/)[0] ?? "").toLowerCase();

			if (sub === "off") {
				state.enabled = false;
				notify(ctx, "pi-auto-title: disabled for this session", "info");
				return;
			}
			if (sub === "on") {
				state.enabled = true;
				notify(ctx, "pi-auto-title: enabled", "info");
				return;
			}
			if (sub === "status" || sub === "config") {
				reloadConfig(ctx);
				const c = state.config;
				notify(
					ctx,
					[
						`session enabled: ${state.enabled}`,
						`current title: ${pi.getSessionName() ?? "(none)"}`,
						`user inputs this session: ${state.roundCount}`,
						`model: ${c.model ?? "(current model)"}`,
						`onFirstTurn: ${c.onFirstTurn}`,
						`onCompact: ${c.onCompact}`,
						`refreshEveryTurns: ${c.refreshEveryTurns}`,
						`maxTitleLength: ${c.maxTitleLength}`,
						`language: ${c.language}`,
						`setTerminalTitle: ${c.setTerminalTitle}`,
						`includeAssistantOutput: ${c.includeAssistantOutput}`,
					].join("\n"),
					"info",
				);
				return;
			}

			// default / "regen" / "gen" / "now" -> regenerate immediately
			reloadConfig(ctx);
			const text = buildConversationText(ctx, state.config.includeAssistantOutput);
			if (!text.trim()) {
				notify(ctx, "pi-auto-title: no conversation to title yet", "warning");
				return;
			}
			await runGenerate(ctx, "manual", text);
		},
	});
}
