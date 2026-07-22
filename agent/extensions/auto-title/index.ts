/**
 * auto-title — automatic session titles for pi.
 *
 * - Generates a short title after the first Q&A exchange (default on).
 * - Regenerates the title after compaction, from the compaction summary (default on).
 * - Optionally refreshes the title every N conversation rounds (default off).
 * - Manual regeneration / control via the `/auto-title` command.
 * - Titles are shown in the TUI via pi.setSessionName() (session selector + header).
 *
 * Config files (JSON, project overrides global):
 *   <ext-dir>/config.json            (global, lives next to this extension)
 *   <cwd>/.pi/auto-title.json        (project, trusted only)
 *   See config.example.json for a filled-in template.
 *
 * Config schema (all optional):
 * {
 *   "model": "saigw/glm-5.2",   // "provider/modelId"; default = current model
 *   "onFirstTurn": true,        // generate after first Q&A (default true)
 *   "onCompact": true,          // regenerate after compaction (default true)
 *   "refreshEveryTurns": 0,     // 0 = off; N = regenerate every N rounds
 *   "maxTitleLength": 60,       // truncate title to this length
 *   "language": "auto",         // "auto" | "zh" | "en" (default "auto")
 *   "setTerminalTitle": false   // also set the terminal/tab title (default false)
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
	convertToLlm,
	serializeConversation,
	type ExtensionAPI,
	type ExtensionContext,
	type SessionMessageEntry,
} from "@earendil-works/pi-coding-agent";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/** Directory this extension lives in — config is read next to it. */
const EXT_DIR = dirname(fileURLToPath(import.meta.url));

type Language = "auto" | "zh" | "en";

interface AutoTitleConfig {
	model?: string;
	onFirstTurn?: boolean;
	onCompact?: boolean;
	refreshEveryTurns?: number;
	maxTitleLength?: number;
	language?: Language;
	setTerminalTitle?: boolean;
}

interface ResolvedConfig {
	model: string | undefined;
	onFirstTurn: boolean;
	onCompact: boolean;
	refreshEveryTurns: number;
	maxTitleLength: number;
	language: Language;
	setTerminalTitle: boolean;
}

const DEFAULTS: ResolvedConfig = {
	model: undefined,
	onFirstTurn: true,
	onCompact: true,
	refreshEveryTurns: 0,
	maxTitleLength: 60,
	language: "auto",
	setTerminalTitle: false,
};

type GenSource = "first" | "compact" | "periodic" | "manual";

interface State {
	config: ResolvedConfig;
	roundCount: number;
	enabled: boolean;
	generating: boolean;
	suppressNextSettled: boolean;
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
		const project = tryRead(join(ctx.cwd, CONFIG_DIR_NAME, "auto-title.json"));
		if (project) merged = { ...merged, ...project };
	}
	return merged;
}

function buildConversationText(ctx: ExtensionContext): string {
	const branch = ctx.sessionManager.getBranch();
	const messages = branch
		.filter((e): e is SessionMessageEntry => e.type === "message")
		.map((e) => e.message);
	if (messages.length === 0) return "";
	return serializeConversation(convertToLlm(messages));
}

function cleanupTitle(raw: string, maxLen: number): string {
	let t = raw.replace(/^["'`“”‘’]+|["'`“”‘’.。]+$/g, "").trim();
	t = t.replace(/\s+/g, " ");
	if (t.length > maxLen) t = `${t.slice(0, Math.max(0, maxLen - 1)).trimEnd()}…`;
	return t;
}

export default function (pi: ExtensionAPI) {
	const state: State = {
		config: DEFAULTS,
		roundCount: 0,
		enabled: true,
		generating: false,
		suppressNextSettled: false,
	};

	const notify = (ctx: ExtensionContext, msg: string, level: "info" | "warning" | "error") => {
		if (ctx.hasUI) ctx.ui.notify(msg, level);
	};

	const reloadConfig = (ctx: ExtensionContext) => {
		state.config = resolveConfig(loadConfig(ctx));
	};

	const resolveModel = (ctx: ExtensionContext, cfg: ResolvedConfig) => {
		if (cfg.model) {
			const idx = cfg.model.indexOf("/");
			if (idx > 0) {
				const m = ctx.modelRegistry.find(cfg.model.slice(0, idx), cfg.model.slice(idx + 1));
				if (m) return m;
				notify(ctx, `auto-title: configured model "${cfg.model}" not found, falling back to current model`, "warning");
			} else {
				notify(ctx, `auto-title: invalid model "${cfg.model}", expected "provider/modelId"`, "warning");
			}
		}
		return ctx.model;
	};

	const generate = async (ctx: ExtensionContext, source: GenSource, conversationText: string) => {
		const cfg = state.config;
		const model = resolveModel(ctx, cfg);
		if (!model) {
			notify(ctx, "auto-title: no model available", "warning");
			return;
		}

		const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
		if (!auth.ok) {
			notify(ctx, `auto-title: auth failed: ${auth.error}`, "warning");
			return;
		}
		if (!auth.apiKey) {
			notify(ctx, `auto-title: no api key for ${model.provider}/${model.id}`, "warning");
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
			`- At most ${cfg.maxTitleLength} characters.`,
			"- No surrounding quotes, no markdown, no trailing punctuation.",
			`- ${langInstr}`,
			"- Output ONLY the title text, nothing else.",
			"",
			"<conversation>",
			conversationText.slice(-3000),
			"</conversation>",
		].join("\n");

		const response = await complete(
			model,
			{ messages: [{ role: "user", content: [{ type: "text" as const, text: prompt }], timestamp: Date.now() }] },
			{ apiKey: auth.apiKey, headers: auth.headers, env: auth.env, maxTokens: 64 },
		);

		const title = cleanupTitle(
			response.content
				.filter((c): c is { type: "text"; text: string } => c.type === "text")
				.map((c) => c.text)
				.join(" "),
			cfg.maxTitleLength,
		);

		if (!title) {
			notify(ctx, "auto-title: model returned an empty title", "warning");
			return;
		}

		pi.setSessionName(title);
		if (cfg.setTerminalTitle && ctx.hasUI) ctx.ui.setTitle(`pi - ${title}`);
		notify(ctx, `auto-title (${source}): ${title}`, "info");
	};

	const runGenerate = async (ctx: ExtensionContext, source: GenSource, text: string) => {
		if (state.generating) return;
		if (!state.enabled && source !== "manual") return;
		state.generating = true;
		try {
			await generate(ctx, source, text);
		} catch (err) {
			notify(ctx, `auto-title: ${err instanceof Error ? err.message : String(err)}`, "error");
		} finally {
			state.generating = false;
		}
	};

	const isAutoMode = (ctx: ExtensionContext) => ctx.mode === "tui" || ctx.mode === "rpc";

	// Reset per-session state and (re)load config on every session start.
	pi.on("session_start", (_event, ctx) => {
		state.roundCount = 0;
		state.enabled = true;
		state.generating = false;
		state.suppressNextSettled = false;
		reloadConfig(ctx);
	});

	// Round counting + first-turn / periodic refresh.
	pi.on("agent_settled", async (_event, ctx) => {
		if (!isAutoMode(ctx)) return;
		if (state.suppressNextSettled) {
			state.suppressNextSettled = false;
			return;
		}
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

		const text = buildConversationText(ctx);
		if (!text.trim()) return;
		await runGenerate(ctx, source, text);
	});

	// Regenerate from the compaction summary after compaction.
	pi.on("session_compact", async (event, ctx) => {
		if (!isAutoMode(ctx)) return;
		if (!state.config.onCompact) return;
		// If the compacted turn will be retried, the following agent_settled should not
		// also trigger a (duplicate) periodic refresh.
		state.suppressNextSettled = true;
		const text = event.compactionEntry.summary;
		if (!text.trim()) return;
		await runGenerate(ctx, "compact", text);
	});

	pi.registerCommand("auto-title", {
		description: "Auto session titles: [regen|on|off|status]",
		handler: async (args, ctx) => {
			const sub = (args.trim().split(/\s+/)[0] ?? "").toLowerCase();

			if (sub === "off") {
				state.enabled = false;
				notify(ctx, "auto-title: disabled for this session", "info");
				return;
			}
			if (sub === "on") {
				state.enabled = true;
				notify(ctx, "auto-title: enabled", "info");
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
						`rounds this session: ${state.roundCount}`,
						`model: ${c.model ?? "(current model)"}`,
						`onFirstTurn: ${c.onFirstTurn}`,
						`onCompact: ${c.onCompact}`,
						`refreshEveryTurns: ${c.refreshEveryTurns}`,
						`maxTitleLength: ${c.maxTitleLength}`,
						`language: ${c.language}`,
						`setTerminalTitle: ${c.setTerminalTitle}`,
					].join("\n"),
					"info",
				);
				return;
			}

			// default / "regen" / "gen" / "now" -> regenerate immediately
			reloadConfig(ctx);
			const text = buildConversationText(ctx);
			if (!text.trim()) {
				notify(ctx, "auto-title: no conversation to title yet", "warning");
				return;
			}
			await runGenerate(ctx, "manual", text);
		},
	});
}
