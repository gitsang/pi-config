/**
 * pi-git — fast git operations via a small configured model.
 *
 * Commands:
 *   /pi-git:commit [paths...]   stage all (or given paths) + generate a commit
 *                               message with the small model + commit
 *   /pi-git:commit-and-push     commit (as above), then push to the current
 *                               upstream (never `push -u`)
 *   /pi-git <prompt>            agentic loop: the small model runs git through
 *                               a parameterized `git` tool, bounded by maxSteps
 *
 * LLM tool `pi_git` (so the main agent can delegate):
 *   action:  "commit" | "commit-and-push" | "prompt"
 *   prompt?: string   — for action "prompt"
 *   message?: string  — for "commit"/"commit-and-push"; skip model generation
 *
 * Model: config "model" = "provider/modelId". If absent, the current session
 * model is used. The session model is never switched.
 *
 * Context: the main conversation (compaction-applied active branch) is fed to
 * the small model for commit-message generation and the prompt loop, so output
 * reflects the work's intent. Truncated to maxContextChars (tail kept).
 *
 * Safety:
 *   - Read-only git commands run freely.
 *   - Write commands require confirm in the COMMAND path (config: confirmWrite /
 *     confirmPush). The AGENT (tool) path never confirms (trust the agent).
 *   - Destructive commands are hard-blocked in BOTH paths:
 *       push --force/-f, reset --hard, clean -f, branch -D,
 *       checkout/restore .  (mass discard), config --global/--system,
 *       and repo-corrupting commands (update-ref -d, reflog expire, gc --prune,
 *       filter-branch, replace --delete, symbolic-ref --delete, rm -r .git).
 *
 * Feedback: the command path uses ui.notify only (process stays out of the
 * session context); the tool path returns a short summary as the tool result.
 *
 * Config (global <ext-dir>/config.json; project <cwd>/.pi/pi-git.json, trusted):
 *   {
 *     "model": "google/gemini-2.5-flash",
 *     "preview": false,        // show commit msg + confirm before committing (command path)
 *     "confirmPush": true,     // confirm before push (command path)
 *     "confirmWrite": true,    // confirm write ops in /pi-git loop (command path)
 *     "trailer": null,         // e.g. "Co-Authored-By: Pi <pi@local>"; appended to body
 *     "maxSteps": 12,          // agentic loop budget
 *     "maxDiffChars": 8000,
 *     "maxContextChars": 4000
 *   }
 *
 * Config is re-read on every invocation, so edits take effect without /reload.
 */

import { complete, type Context, type Message, type Tool, type AssistantMessage } from "@earendil-works/pi-ai/compat";
import { StringEnum } from "@earendil-works/pi-ai";
import {
	CONFIG_DIR_NAME,
	type ExtensionAPI,
	type ExtensionContext,
	convertToLlm,
	serializeConversation,
	type SessionMessageEntry,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const EXT_DIR = dirname(fileURLToPath(import.meta.url));

// ---------------------------------------------------------------- config

interface RawConfig {
	model?: string;
	preview?: boolean;
	confirmPush?: boolean;
	confirmWrite?: boolean;
	trailer?: string | null;
	maxSteps?: number;
	maxDiffChars?: number;
	maxContextChars?: number;
}

interface ResolvedConfig {
	model: string | undefined;
	preview: boolean;
	confirmPush: boolean;
	confirmWrite: boolean;
	trailer: string | undefined;
	maxSteps: number;
	maxDiffChars: number;
	maxContextChars: number;
}

const DEFAULTS: ResolvedConfig = {
	model: undefined,
	preview: false,
	confirmPush: true,
	confirmWrite: true,
	trailer: undefined,
	maxSteps: 12,
	maxDiffChars: 8000,
	maxContextChars: 4000,
};

function resolveConfig(raw: RawConfig): ResolvedConfig {
	return {
		model: raw.model?.trim() || DEFAULTS.model,
		preview: raw.preview ?? DEFAULTS.preview,
		confirmPush: raw.confirmPush ?? DEFAULTS.confirmPush,
		confirmWrite: raw.confirmWrite ?? DEFAULTS.confirmWrite,
		trailer: raw.trailer?.trim() || undefined,
		maxSteps: clampInt(raw.maxSteps, DEFAULTS.maxSteps, 1, 100),
		maxDiffChars: clampInt(raw.maxDiffChars, DEFAULTS.maxDiffChars, 500, 200000),
		maxContextChars: clampInt(raw.maxContextChars, DEFAULTS.maxContextChars, 500, 200000),
	};
}

function clampInt(v: unknown, dft: number, lo: number, hi: number): number {
	const n = typeof v === "number" ? v : typeof v === "string" ? Number(v) : NaN;
	if (!Number.isFinite(n)) return dft;
	return Math.max(lo, Math.min(hi, Math.trunc(n)));
}

function loadConfig(ctx: ExtensionContext): ResolvedConfig {
	const tryRead = (p: string): RawConfig | null => {
		try {
			if (!existsSync(p)) return null;
			return JSON.parse(readFileSync(p, "utf-8")) as RawConfig;
		} catch {
			return null;
		}
	};
	let raw: RawConfig = {};
	const g = tryRead(join(EXT_DIR, "config.json"));
	if (g) raw = { ...raw, ...g };
	if (ctx.isProjectTrusted()) {
		const p = tryRead(join(ctx.cwd, CONFIG_DIR_NAME, "pi-git.json"));
		if (p) raw = { ...raw, ...p };
	}
	return resolveConfig(raw);
}

// ---------------------------------------------------------------- git exec

interface GitOut {
	stdout: string;
	stderr: string;
	code: number;
}

async function git(pi: ExtensionAPI, ctx: ExtensionContext, args: string[], opts?: { signal?: AbortSignal }): Promise<GitOut> {
	const r = await pi.exec("git", args, { cwd: ctx.cwd, signal: opts?.signal });
	return { stdout: r.stdout, stderr: r.stderr, code: r.code };
}

async function isGitRepo(pi: ExtensionAPI, ctx: ExtensionContext): Promise<boolean> {
	const { code } = await git(pi, ctx, ["rev-parse", "--git-dir"]);
	return code === 0;
}

async function currentBranch(pi: ExtensionAPI, ctx: ExtensionContext): Promise<string | undefined> {
	const { stdout, code } = await git(pi, ctx, ["rev-parse", "--abbrev-ref", "HEAD"]);
	if (code !== 0) return undefined;
	const b = stdout.trim();
	return b === "HEAD" ? undefined : b;
}

// ---------------------------------------------------------------- safety

type GitKind = "read" | "write" | "blocked";

interface Classify {
	kind: GitKind;
	reason?: string; // for blocked
	label: string; // short human label for confirm dialog
}

/** Classify a git argv into read / write / blocked. Defense-in-depth for the loop. */
function classifyGit(args: string[]): Classify {
	const clean = args.filter((a) => typeof a === "string" && a.length > 0);
	if (clean.length === 0) return { kind: "read", label: "git" };
	const sub = clean[0];
	const rest = clean.slice(1);
	const label = `git ${clean.join(" ")}`;
	const has = (f: string) => rest.includes(f);
	const hasAny = (fs: string[]) => fs.some(has);
	const dd = rest.indexOf("--");
	const afterDD = dd >= 0 ? rest.slice(dd + 1) : [];
	const nonFlags = rest.filter((a) => !a.startsWith("-") && a !== "--");
	const block = (reason: string): Classify => ({ kind: "blocked", reason, label });

	// --- destructive / repo-corrupting: hard block ---
	if (sub === "push" && hasAny(["--force", "--force-with-lease", "-f", "--force-if-includes"]))
		return block("force push is blacklisted");
	if (sub === "reset" && hasAny(["--hard"])) return block("git reset --hard is blacklisted");
	if (sub === "clean" && hasAny(["-f", "--force", "-fd", "-fdx", "-df", "-x"]))
		return block("git clean -f is blacklisted");
	if ((sub === "checkout" || sub === "restore") && (nonFlags.includes(".") || afterDD.includes(".")))
		return block(`git ${sub} . discards working changes (blacklisted)`);
	if (sub === "branch" && (has("-D") || (hasAny(["--delete"]) && hasAny(["--force"]))))
		return block("git branch -D (force delete) is blacklisted");
	if (sub === "config" && hasAny(["--global", "--system"]))
		return block("git config --global/--system is blacklisted");
	if (["update-ref", "reflog", "gc", "filter-branch", "replace", "symbolic-ref"].includes(sub)) {
		// --expire / --prune may appear as --expire=all / --prune=now
		const hasPrefix = (p: string) => rest.some((a) => a === p || a.startsWith(`${p}=`));
		if (hasAny(["--delete", "-d", "--all", "--force"]) || hasPrefix("--expire") || hasPrefix("--prune"))
			return block(`git ${sub} with destructive flags is blacklisted`);
	}
	if (sub === "rm" && hasAny(["-r", "-rf", "--recursive"]) && (nonFlags.includes(".git") || rest.some((a) => a.startsWith(".git/"))))
		return block("git rm on .git is blacklisted");

	// --- read-only ---
	const READ_SUBS = new Set([
		"status", "log", "diff", "show", "blame", "ls-files", "ls-tree", "rev-parse",
		"rev-list", "describe", "shortlog", "cat-file", "name-rev", "grep", "fetch",
		"for-each-ref", "annotate", "format-patch", "diff-tree", "log", "rev-parse",
	]);
	if (READ_SUBS.has(sub)) return { kind: "read", label };
	if (sub === "config") {
		if (
			hasAny(["--get", "--list", "-l", "--get-all", "--get-regexp"]) &&
			!hasAny(["--unset", "--unset-all", "--add", "--replace-all", "--remove-section"])
		)
			return { kind: "read", label };
		return { kind: "write", label }; // local config write
	}
	if (sub === "branch") {
		if (hasAny(["--list", "-l", "-a", "-r", "-v", "-vv", "--all", "--remotes", "--verbose"]) && !hasAny(["-d", "-D", "-m", "-c", "--delete", "--move", "--copy"]))
			return { kind: "read", label };
		if (nonFlags.length === 0 && !hasAny(["-d", "-D", "-m", "-c", "--delete", "--move", "--copy"]))
			return { kind: "read", label };
		return { kind: "write", label };
	}
	if (sub === "tag") {
		if (nonFlags.length === 0 || hasAny(["--list", "-l"])) return { kind: "read", label };
		return { kind: "write", label };
	}
	if (sub === "stash") {
		if (nonFlags.length === 0 || nonFlags[0] === "list" || hasAny(["list", "show"])) return { kind: "read", label };
		return { kind: "write", label };
	}
	if (sub === "remote") {
		if (nonFlags.length === 0 || hasAny(["-v"]) || nonFlags[0] === "show") return { kind: "read", label };
		return { kind: "write", label };
	}
	if (sub === "reflog") return { kind: "read", label };

	// --- write by default ---
	const WRITE_SUBS = new Set([
		"add", "commit", "push", "pull", "merge", "rebase", "cherry-pick", "revert",
		"checkout", "switch", "restore", "reset", "mv", "rm", "apply", "am", "init",
		"clone", "worktree", "bisect", "notes",
	]);
	if (WRITE_SUBS.has(sub)) return { kind: "write", label };

	// unknown subcommand: treat conservatively as write
	return { kind: "write", label };
}

// ---------------------------------------------------------------- model + auth

interface ResolvedModel {
	model: ReturnType<ExtensionContext["modelRegistry"]["getAll"]>[number] | undefined;
	error?: string;
}

function resolveModel(ctx: ExtensionContext, cfg: ResolvedConfig): ResolvedModel {
	if (cfg.model) {
		const idx = cfg.model.indexOf("/");
		if (idx > 0) {
			const m = ctx.modelRegistry.find(cfg.model.slice(0, idx), cfg.model.slice(idx + 1));
			if (m) return { model: m };
			return { model: undefined, error: `configured model "${cfg.model}" not found` };
		}
		return { model: undefined, error: `invalid model "${cfg.model}", expected "provider/modelId"` };
	}
	return { model: ctx.model, error: ctx.model ? undefined : "no model available" };
}

interface Auth {
	ok: boolean;
	apiKey?: string;
	headers?: Record<string, string>;
	env?: Record<string, string>;
	error?: string;
}

async function resolveAuth(ctx: ExtensionContext, model: NonNullable<ResolvedModel["model"]>): Promise<Auth> {
	const a = await ctx.modelRegistry.getApiKeyAndHeaders(model);
	if (!a.ok) return { ok: false, error: a.error };
	return { ok: true, apiKey: a.apiKey, headers: a.headers, env: a.env };
}

// ---------------------------------------------------------------- session context

function buildSessionContext(ctx: ExtensionContext, maxChars: number): string {
	const branch = ctx.sessionManager.getBranch();
	const messages = branch
		.filter((e): e is SessionMessageEntry => e.type === "message")
		.map((e) => e.message);
	if (messages.length === 0) return "";
	let text = serializeConversation(convertToLlm(messages));
	if (text.length > maxChars) {
		// Keep the recent tail; the compaction summary (if any) sits at the front
		// of `text` and is dropped on truncation — acceptable for a git prompt.
		text = `[earlier conversation truncated]\n${text.slice(-maxChars)}`;
	}
	return text;
}

// ---------------------------------------------------------------- commit message

function detectLang(subjects: string[]): "zh" | "en" {
	const s = subjects.filter((x) => x.trim().length > 0);
	if (s.length === 0) return "en";
	const zh = s.filter((x) => /[\u4e00-\u9fff]/.test(x)).length;
	return zh >= s.length / 2 ? "zh" : "en";
}

function cleanupCommitMessage(raw: string): string {
	let t = raw.trim();
	// strip surrounding code fences
	t = t.replace(/^```[a-zA-Z]*\n?/, "").replace(/\n?```$/, "").trim();
	return t;
}

async function generateCommitMessage(
	pi: ExtensionAPI,
	ctx: ExtensionContext,
	cfg: ResolvedConfig,
	model: NonNullable<ResolvedModel["model"]>,
	auth: Auth,
	diffStat: string,
	diff: string,
	sessionContext: string,
	signal?: AbortSignal,
): Promise<string> {
	const { stdout: logOut } = await git(pi, ctx, ["log", "-5", "--pretty=format:%s"]);
	const subjects = logOut.split("\n").filter(Boolean);
	const lang = detectLang(subjects);
	const langInstr = lang === "zh" ? "Use Chinese (简体中文)." : "Use English.";

	const prompt = [
		"You are generating a git commit message for the staged changes below.",
		"Rules:",
		"- Use Conventional Commits format: `type(scope): summary`.",
		"- Subject line <= 72 chars. Optionally a blank line then a body explaining why.",
		"- Match the style of the repository's recent commits shown below.",
		`- ${langInstr}`,
		"- Output ONLY the commit message. No code fences, no preface, no explanation.",
		"",
		"Recent commit subjects (match their style):",
		subjects.length ? subjects.map((s) => `- ${s}`).join("\n") : "- (none)",
		"",
		"Conversation context (for intent — may be truncated):",
		sessionContext || "(none)",
		"",
		"Staged changes — diffstat:",
		diffStat || "(none)",
		"",
		"Staged diff:",
		diff || "(none)",
	].join("\n");

	const response = await complete(
		model,
		{
			messages: [{ role: "user", content: [{ type: "text", text: prompt }], timestamp: Date.now() }],
		},
		{ apiKey: auth.apiKey, headers: auth.headers, env: auth.env, maxTokens: 256, signal },
	);

	return cleanupCommitMessage(
		response.content
			.filter((c): c is { type: "text"; text: string } => c.type === "text")
			.map((c) => c.text)
			.join("")
			.trim(),
	);
}

// ---------------------------------------------------------------- commit + push

interface CommitResult {
	ok: boolean;
	message: string;
	summary: string;
}

async function doCommit(
	pi: ExtensionAPI,
	ctx: ExtensionContext,
	cfg: ResolvedConfig,
	opts: { paths?: string[]; message?: string; confirm: boolean; signal?: AbortSignal },
): Promise<CommitResult> {
	const paths = opts.paths?.filter((p) => p.length > 0) ?? [];
	const addArgs = paths.length ? ["add", "--", ...paths] : ["add", "-A"];
	await git(pi, ctx, addArgs);

	const { stdout: status } = await git(pi, ctx, ["status", "--porcelain"]);
	if (status.trim().length === 0) {
		return { ok: false, message: "", summary: "nothing to commit (working tree clean)" };
	}

	const { stdout: diffStat } = await git(pi, ctx, ["diff", "--cached", "--stat"]);
	let { stdout: diff } = await git(pi, ctx, ["diff", "--cached"]);
	if (diff.length > cfg.maxDiffChars) diff = `${diff.slice(0, cfg.maxDiffChars)}\n...[diff truncated]...`;

	let message = opts.message?.trim() ?? "";
	if (!message) {
		const rm = resolveModel(ctx, cfg);
		if (rm.error || !rm.model) return { ok: false, message, summary: `commit aborted: ${rm.error ?? "no model"}` };
		const auth = await resolveAuth(ctx, rm.model);
		if (!auth.ok) return { ok: false, message, summary: `commit aborted: ${auth.error ?? "auth failed"}` };

		const sessionContext = buildSessionContext(ctx, cfg.maxContextChars);
		try {
			message = await generateCommitMessage(pi, ctx, cfg, rm.model, auth, diffStat, diff, sessionContext, opts.signal);
		} catch (e) {
			return { ok: false, message, summary: `commit aborted: message generation failed: ${errStr(e)}` };
		}
		if (!message) return { ok: false, message, summary: "commit aborted: empty message generated" };
	}

	if (cfg.trailer) message = `${message}\n\n${cfg.trailer}`;

	// preview / confirm (command path only, when requested)
	if (opts.confirm && cfg.preview && ctx.hasUI) {
		const preview = [
			`Commit message:`,
			message,
			"",
			`Staged (${diffStat.trim().split("\n").length} stat line(s)):`,
			diffStat.trim() || "(none)",
		].join("\n");
		const ok = await ctx.ui.confirm("Commit?", preview);
		if (!ok) return { ok: false, message, summary: "commit cancelled by user" };
	}

	const { code, stderr } = await git(pi, ctx, ["commit", "-m", message]);
	if (code !== 0) {
		return { ok: false, message, summary: `commit failed (exit ${code}): ${stderr.trim() || "(no stderr)"}` };
	}
	const { stdout: short } = await git(pi, ctx, ["rev-parse", "--short", "HEAD"]);
	return { ok: true, message, summary: `committed ${short.trim()}: ${message.split("\n")[0]}` };
}

async function doPush(
	pi: ExtensionAPI,
	ctx: ExtensionContext,
	cfg: ResolvedConfig,
	opts: { confirm: boolean; signal?: AbortSignal },
): Promise<string> {
	// Only push if an upstream is configured. Never `push -u`.
	const { code: upCode, stdout: up, stderr: upErr } = await git(pi, ctx, ["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"]);
	if (upCode !== 0) {
		return `push skipped: no upstream configured (${upErr.trim() || "@{u} not found"}); not using -u`;
	}
	const upstream = up.trim();

	if (opts.confirm && cfg.confirmPush && ctx.hasUI) {
		const ok = await ctx.ui.confirm("Push?", `git push (to ${upstream})`);
		if (!ok) return "push cancelled by user";
	}

	const { code, stderr, stdout } = await git(pi, ctx, ["push"]);
	if (code !== 0) {
		return `push failed (exit ${code}): ${stderr.trim() || stdout.trim() || "(no output)"}`;
	}
	return `pushed to ${upstream}`;
}

// ---------------------------------------------------------------- agentic loop

const GIT_TOOL: Tool = {
	name: "git",
	description:
		"Run a git command in the repository. Pass args as an array, e.g. [\"status\",\"--porcelain\"] or [\"commit\",\"-m\",\"fix typo\"]. Read-only commands run freely; write commands may require confirmation; destructive commands (force push, reset --hard, clean -f, branch -D, checkout ., config --global, etc.) are blocked.",
	parameters: Type.Object({
		args: Type.Array(Type.String(), { description: "git arguments, e.g. [\"status\"] or [\"add\",\"-A\"]" }),
		reason: Type.Optional(Type.String({ description: "one short sentence on why you are running this" })),
	}),
};

interface LoopResult {
	summary: string;
	steps: number;
	error?: string;
}

async function runAgentLoop(
	pi: ExtensionAPI,
	ctx: ExtensionContext,
	cfg: ResolvedConfig,
	model: NonNullable<ResolvedModel["model"]>,
	auth: Auth,
	userPrompt: string,
	opts: { confirmWrites: boolean; signal?: AbortSignal },
): Promise<LoopResult> {
	const branch = (await currentBranch(pi, ctx)) ?? "(detached)";
	const sessionContext = buildSessionContext(ctx, cfg.maxContextChars);

	const systemPrompt = [
		"You are a git assistant operating in a repository. You fulfill the user's request by running git commands via the `git` tool.",
		"Rules:",
		"- Run read-only commands first (status, diff, log, branch) to understand state before changing anything.",
		"- Run the minimum commands needed; stop as soon as the request is done.",
		"- Never attempt destructive operations (force push, reset --hard, clean -f, branch -D, checkout ., config --global) — they are blocked.",
		"- When done, reply with a short summary (1-3 sentences) of what you did. No code fences.",
		"",
		`Working directory: ${ctx.cwd}`,
		`Current branch: ${branch}`,
	].join("\n");

	const userText = [
		userPrompt,
		"",
		"Conversation context (for intent — may be truncated):",
		sessionContext || "(none)",
	].join("\n");

	const messages: Message[] = [
		{ role: "user", content: [{ type: "text", text: userText }], timestamp: Date.now() },
	];

	let steps = 0;
	for (;;) {
		if (opts.signal?.aborted) return { summary: "aborted", steps, error: "aborted" };
		if (steps >= cfg.maxSteps) {
			return { summary: `reached maxSteps (${cfg.maxSteps}); stopping. ${steps} tool call(s) made.`, steps };
		}

		let resp: AssistantMessage;
		try {
			resp = await complete(
				model,
				{ systemPrompt, messages, tools: [GIT_TOOL] },
				{ apiKey: auth.apiKey, headers: auth.headers, env: auth.env, maxTokens: 2048, signal: opts.signal },
			);
		} catch (e) {
			return { summary: `model call failed: ${errStr(e)}`, steps, error: errStr(e) };
		}

		messages.push(resp);

		const toolCalls = resp.content.filter((c): c is { type: "toolCall"; id: string; name: string; arguments: Record<string, unknown> } => c.type === "toolCall");
		const textParts = resp.content.filter((c): c is { type: "text"; text: string } => c.type === "text").map((c) => c.text);

		if (toolCalls.length === 0) {
			// done — model returned a final answer
			const summary = textParts.join("").trim() || "(no summary)";
			return { summary, steps };
		}

		for (const tc of toolCalls) {
			steps++;
			const args = Array.isArray(tc.arguments.args) ? tc.arguments.args.map(String) : [];
			const cls = classifyGit(args);

			if (cls.kind === "blocked") {
				messages.push({
					role: "toolResult",
					toolCallId: tc.id,
					toolName: "git",
					content: [{ type: "text", text: `BLOCKED: ${cls.reason}` }],
					isError: true,
					timestamp: Date.now(),
				});
				continue;
			}

			if (cls.kind === "write" && opts.confirmWrites && ctx.hasUI) {
				const ok = await ctx.ui.confirm("Allow git command?", `${cls.label}${tc.arguments.reason ? `\n\nreason: ${String(tc.arguments.reason)}` : ""}`);
				if (!ok) {
					messages.push({
						role: "toolResult",
						toolCallId: tc.id,
						toolName: "git",
						content: [{ type: "text", text: "DENIED by user" }],
						isError: true,
						timestamp: Date.now(),
					});
					continue;
				}
			}

			const r = await git(pi, ctx, args, { signal: opts.signal });
			const out = [r.stdout, r.stderr].map((s) => s.trim()).filter(Boolean).join("\n");
			const text = `${out}${r.code !== 0 ? `\n[exit ${r.code}]` : ""}` || "(no output)";
			messages.push({
				role: "toolResult",
				toolCallId: tc.id,
				toolName: "git",
				content: [{ type: "text", text }],
				isError: r.code !== 0,
				timestamp: Date.now(),
			});
		}
	}
}

// ---------------------------------------------------------------- helpers

function errStr(e: unknown): string {
	return e instanceof Error ? e.message : String(e);
}

function parsePaths(args: string): string[] {
	return args.trim().split(/\s+/).filter(Boolean);
}

// ---------------------------------------------------------------- factory

export default function (pi: ExtensionAPI) {
	const notify = (ctx: ExtensionContext, msg: string, level: "info" | "warning" | "error") => {
		if (ctx.hasUI) ctx.ui.notify(msg, level);
	};

	// -- /pi-git:commit [paths...]
	pi.registerCommand("pi-git:commit", {
		description: "Stage all (or given paths) and commit with a small-model-generated message",
		handler: async (args, ctx) => {
			const cfg = loadConfig(ctx);
			if (!(await isGitRepo(pi, ctx))) return notify(ctx, "pi-git: not a git repo", "warning");
			const paths = parsePaths(args);
			const res = await doCommit(pi, ctx, cfg, {
				paths: paths.length ? paths : undefined,
				confirm: true,
			});
			notify(ctx, `pi-git: ${res.summary}`, res.ok ? "info" : "warning");
		},
	});

	// -- /pi-git:commit-and-push
	pi.registerCommand("pi-git:commit-and-push", {
		description: "Commit (small-model message), then push to the current upstream (no -u)",
		handler: async (_args, ctx) => {
			const cfg = loadConfig(ctx);
			if (!(await isGitRepo(pi, ctx))) return notify(ctx, "pi-git: not a git repo", "warning");
			const cres = await doCommit(pi, ctx, cfg, { confirm: true });
			notify(ctx, `pi-git: ${cres.summary}`, cres.ok ? "info" : "warning");
			if (!cres.ok) return;
			const psum = await doPush(pi, ctx, cfg, { confirm: true });
			notify(ctx, `pi-git: ${psum}`, psum.startsWith("pushed") ? "info" : "warning");
		},
	});

	// -- /pi-git <prompt>
	pi.registerCommand("pi-git", {
		description: "Delegate an arbitrary git task to a small model (agentic loop)",
		handler: async (args, ctx) => {
			const cfg = loadConfig(ctx);
			const prompt = args.trim();
			if (!prompt) return notify(ctx, "pi-git: usage: /pi-git <prompt>", "warning");
			if (!(await isGitRepo(pi, ctx))) return notify(ctx, "pi-git: not a git repo", "warning");

			const rm = resolveModel(ctx, cfg);
			if (rm.error || !rm.model) return notify(ctx, `pi-git: ${rm.error ?? "no model"}`, "warning");
			const auth = await resolveAuth(ctx, rm.model);
			if (!auth.ok) return notify(ctx, `pi-git: ${auth.error ?? "auth failed"}`, "warning");

			notify(ctx, `pi-git: running "${prompt}"…`, "info");
			const res = await runAgentLoop(pi, ctx, cfg, rm.model, auth, prompt, { confirmWrites: cfg.confirmWrite });
			notify(ctx, `pi-git: ${res.summary}${res.error ? ` (${res.error})` : ""}`, res.error ? "warning" : "info");
		},
	});

	// -- LLM tool `pi_git` (main agent can delegate; never confirms)
	pi.registerTool({
		name: "pi_git",
		label: "pi-git",
		description:
			"Delegate git work to a fast small model. action 'commit' / 'commit-and-push' stages and commits (message auto-generated from the diff unless `message` is given); action 'prompt' runs an agentic git loop. Results are returned as a short summary.",
		promptSnippet: "Run git commit / commit-and-push, or delegate an arbitrary git task to a small model",
		parameters: Type.Object({
			action: StringEnum(["commit", "commit-and-push", "prompt"]),
			prompt: Type.Optional(Type.String({ description: "for action 'prompt': the git task in natural language" })),
			message: Type.Optional(Type.String({ description: "for commit actions: use this exact commit message instead of generating one" })),
			paths: Type.Optional(Type.Array(Type.String(), { description: "for commit actions: limit staging to these paths; default = all" })),
		}),
		async execute(_toolCallId, params, signal, _onUpdate, ctx) {
			const cfg = loadConfig(ctx);
			if (!(await isGitRepo(pi, ctx))) {
				return { content: [{ type: "text", text: "pi-git: not a git repo" }], details: { ok: false } };
			}
			const action = String(params.action ?? "");
			const paths = Array.isArray(params.paths) ? params.paths.map(String) : undefined;

			if (action === "commit" || action === "commit-and-push") {
				const cres = await doCommit(pi, ctx, cfg, {
					paths,
					message: typeof params.message === "string" ? params.message : undefined,
					confirm: false, // agent path: no confirm
					signal,
				});
				if (!cres.ok) {
					return { content: [{ type: "text", text: `pi-git: ${cres.summary}` }], details: { ok: false, action } };
				}
				if (action === "commit") {
					return { content: [{ type: "text", text: `pi-git: ${cres.summary}` }], details: { ok: true, action, message: cres.message } };
				}
				const psum = await doPush(pi, ctx, cfg, { confirm: false, signal });
				return {
					content: [{ type: "text", text: `pi-git: ${cres.summary}; ${psum}` }],
					details: { ok: psum.startsWith("pushed"), action, message: cres.message, push: psum },
				};
			}

			if (action === "prompt") {
				const prompt = typeof params.prompt === "string" ? params.prompt.trim() : "";
				if (!prompt) {
					return { content: [{ type: "text", text: "pi-git: action 'prompt' requires a `prompt` argument" }], details: { ok: false, action } };
				}
				const rm = resolveModel(ctx, cfg);
				if (rm.error || !rm.model) {
					return { content: [{ type: "text", text: `pi-git: ${rm.error ?? "no model"}` }], details: { ok: false, action } };
				}
				const auth = await resolveAuth(ctx, rm.model);
				if (!auth.ok) {
					return { content: [{ type: "text", text: `pi-git: ${auth.error ?? "auth failed"}` }], details: { ok: false, action } };
				}
				const res = await runAgentLoop(pi, ctx, cfg, rm.model, auth, prompt, { confirmWrites: false, signal });
				return {
					content: [{ type: "text", text: `pi-git: ${res.summary}${res.error ? ` (${res.error})` : ""}` }],
					details: { ok: !res.error, action, steps: res.steps },
				};
			}

			return { content: [{ type: "text", text: `pi-git: unknown action "${action}"` }], details: { ok: false } };
		},
	});
}
