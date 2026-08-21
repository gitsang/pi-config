/**
 * Subprocess execution for pi-multi-agent.
 *
 * Each agent task runs in an isolated `pi` child process:
 *   pi --mode json -p --no-session [--model ...] [--tools ...]
 *       [--append-system-prompt <tmpfile>] <task prompt>
 *
 * We parse stdout as JSONL to collect messages and usage, stream partial
 * updates via `onUpdate`, and support timeout + AbortSignal.
 */

import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { Message } from "@earendil-works/pi-ai";
import { truncateHead, withFileMutationQueue } from "@earendil-works/pi-coding-agent";
import type { AgentConfig } from "./agents.ts";

export interface UsageStats {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	cost: number;
	totalTokens: number;
	/** Context tokens from the most recent assistant message. */
	contextTokens: number;
	turns: number;
}

export interface TaskResult {
	agent: string;
	agentSource: AgentConfig["source"] | "unknown";
	task: string;
	prompt: string;
	exitCode: number;
	messages: Message[];
	stderr: string;
	usage: UsageStats;
	model?: string;
	stopReason?: string;
	errorMessage?: string;
	step?: number;
	timedOut?: boolean;
	aborted?: boolean;
}

export interface RunAgentTaskOptions {
	agent: AgentConfig;
	/** Original task text (without the "Task:" wrapper), for display/details. */
	task: string;
	/** Full prompt appended to the child process. */
	taskPrompt: string;
	cwd: string;
	taskCwd?: string;
	/** Per-task tool override. When undefined, `agent.tools` is used. */
	tools?: string[];
	model?: string;
	signal?: AbortSignal;
	onUpdate?: (result: TaskResult) => void;
	timeoutMs: number;
	depth: number;
}

export function zeroUsage(): UsageStats {
	return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, totalTokens: 0, contextTokens: 0, turns: 0 };
}

export function formatTokens(count: number): string {
	if (count < 1000) return String(Math.round(count));
	if (count < 10000) return `${(count / 1000).toFixed(1)}k`;
	if (count < 1000000) return `${Math.round(count / 1000)}k`;
	return `${(count / 1000000).toFixed(1)}M`;
}

export function formatUsageStats(usage: UsageStats, model?: string): string {
	const parts: string[] = [];
	if (usage.turns > 0) parts.push(`${usage.turns} turn${usage.turns > 1 ? "s" : ""}`);
	if (usage.input > 0) parts.push(`↑${formatTokens(usage.input)}`);
	if (usage.output > 0) parts.push(`↓${formatTokens(usage.output)}`);
	if (usage.cacheRead > 0) parts.push(`R${formatTokens(usage.cacheRead)}`);
	if (usage.cacheWrite > 0) parts.push(`W${formatTokens(usage.cacheWrite)}`);
	if (usage.cost > 0) parts.push(`$${usage.cost.toFixed(4)}`);
	const ctxTokens = usage.contextTokens || usage.totalTokens;
	if (ctxTokens > 0) parts.push(`ctx:${formatTokens(ctxTokens)}`);
	if (model) parts.push(model);
	return parts.join(" ");
}

export function getFinalOutput(messages: Message[]): string {
	for (let i = messages.length - 1; i >= 0; i--) {
		const msg = messages[i];
		if (msg.role === "assistant") {
			for (const part of msg.content) {
				if (part.type === "text") return part.text;
			}
		}
	}
	return "";
}

export function isFailedResult(result: TaskResult): boolean {
	return (
		result.exitCode !== 0 ||
		result.stopReason === "error" ||
		result.stopReason === "aborted" ||
		result.timedOut === true ||
		result.aborted === true
	);
}

export function getResultOutput(result: TaskResult): string {
	if (isFailedResult(result)) {
		return result.errorMessage || result.stderr || getFinalOutput(result.messages) || "(no output)";
	}
	return getFinalOutput(result.messages) || "(no output)";
}

export function truncateForModel(text: string, maxBytes: number): string {
	if (maxBytes <= 0) return "";
	const originalBytes = Buffer.byteLength(text, "utf8");
	if (originalBytes <= maxBytes) return text;

	const truncated = truncateHead(text, { maxBytes });
	const keptBytes = Buffer.byteLength(truncated.content, "utf8");
	const omitted = originalBytes - keptBytes;
	const suffix = `\n\n[Output truncated: ${omitted} bytes omitted. Full output preserved in tool details.]`;
	return truncated.content ? `${truncated.content}${suffix}` : suffix.trim();
}

function getPiInvocation(args: string[]): { command: string; args: string[] } {
	const currentScript = process.argv[1];
	const isBunVirtualScript = currentScript?.startsWith("/$bunfs/root/");
	if (currentScript && !isBunVirtualScript && fs.existsSync(currentScript)) {
		return { command: process.execPath, args: [currentScript, ...args] };
	}

	const execName = path.basename(process.execPath).toLowerCase();
	const isGenericRuntime = /^(node|bun)(\.exe)?$/.test(execName);
	if (!isGenericRuntime) {
		return { command: process.execPath, args };
	}

	return { command: "pi", args };
}

async function writePromptToTempFile(agentName: string, prompt: string): Promise<{ dir: string; filePath: string }> {
	const tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "pi-multi-agent-"));
	const safeName = agentName.replace(/[^\w.-]+/g, "_");
	const filePath = path.join(tmpDir, `prompt-${safeName}.md`);
	await withFileMutationQueue(filePath, async () => {
		await fs.promises.writeFile(filePath, prompt, { encoding: "utf-8", mode: 0o600 });
	});
	return { dir: tmpDir, filePath };
}

export async function runAgentTask(opts: RunAgentTaskOptions): Promise<TaskResult> {
	const agent = opts.agent;

	const currentResult: TaskResult = {
		agent: agent.name,
		agentSource: agent.source,
		task: opts.task,
		prompt: opts.taskPrompt,
		exitCode: 0,
		messages: [],
		stderr: "",
		usage: zeroUsage(),
		model: opts.model,
	};

	const emitUpdate = () => {
		if (opts.onUpdate) {
			opts.onUpdate({ ...currentResult, messages: [...currentResult.messages] });
		}
	};

	const args: string[] = ["--mode", "json", "-p", "--no-session"];
	if (opts.model) args.push("--model", opts.model);

	const toolList = opts.tools !== undefined ? opts.tools : agent.tools;
	if (toolList && toolList.length > 0) args.push("--tools", toolList.join(","));

	let tmpPromptDir: string | null = null;
	let tmpPromptPath: string | null = null;

	try {
		if (agent.systemPrompt.trim()) {
			const tmp = await writePromptToTempFile(agent.name, agent.systemPrompt);
			tmpPromptDir = tmp.dir;
			tmpPromptPath = tmp.filePath;
			args.push("--append-system-prompt", tmpPromptPath);
		}

		args.push(opts.taskPrompt);

		await new Promise<void>((resolve) => {
			const invocation = getPiInvocation(args);
			let settled = false;
			let timedOut = false;
			let aborted = false;
			let killTimer: ReturnType<typeof setTimeout> | undefined;
			let timeoutTimer: ReturnType<typeof setTimeout> | undefined;

			const finish = () => {
				if (settled) return;
				settled = true;
				if (timeoutTimer) clearTimeout(timeoutTimer);
				if (killTimer) clearTimeout(killTimer);
				resolve();
			};

			const killProc = (sig: NodeJS.Signals) => {
				try {
					if (proc.exitCode === null) proc.kill(sig);
				} catch {
					// process already exited
				}
			};

			const proc = spawn(invocation.command, invocation.args, {
				cwd: opts.taskCwd ?? opts.cwd,
				shell: false,
				stdio: ["ignore", "pipe", "pipe"],
				env: {
					...process.env,
					PI_MULTI_AGENT_DEPTH: String(opts.depth + 1),
				},
			});

			let buffer = "";

			const processLine = (line: string) => {
				if (!line.trim()) return;
				let event: any;
				try {
					event = JSON.parse(line);
				} catch {
					return;
				}

				if (event.type === "message_end" && event.message) {
					const msg = event.message as Message;
					currentResult.messages.push(msg);

					if (msg.role === "assistant") {
						currentResult.usage.turns += 1;
						const usage = msg.usage;
						if (usage) {
							currentResult.usage.input += usage.input || 0;
							currentResult.usage.output += usage.output || 0;
							currentResult.usage.cacheRead += usage.cacheRead || 0;
							currentResult.usage.cacheWrite += usage.cacheWrite || 0;
							currentResult.usage.cost += usage.cost?.total || 0;
							currentResult.usage.totalTokens += usage.totalTokens || 0;
							if (usage.totalTokens) currentResult.usage.contextTokens = usage.totalTokens;
						}
						if (!currentResult.model && msg.model) currentResult.model = msg.model;
						if (msg.stopReason) currentResult.stopReason = msg.stopReason;
						if (msg.errorMessage) currentResult.errorMessage = msg.errorMessage;
					}
					emitUpdate();
				}

				if (event.type === "tool_result_end" && event.message) {
					currentResult.messages.push(event.message as Message);
					emitUpdate();
				}
			};

			proc.stdout.on("data", (data: Buffer | string) => {
				buffer += data.toString();
				const lines = buffer.split("\n");
				buffer = lines.pop() || "";
				for (const line of lines) processLine(line);
			});

			proc.stderr.on("data", (data: Buffer | string) => {
				currentResult.stderr += data.toString();
			});

			const abortNow = () => {
				if (settled) return;
				aborted = true;
				currentResult.aborted = true;
				currentResult.stopReason = "aborted";
				currentResult.errorMessage = "Subagent was aborted";
				if (timeoutTimer) {
					clearTimeout(timeoutTimer);
					timeoutTimer = undefined;
				}
				killProc("SIGTERM");
				if (!killTimer) {
					killTimer = setTimeout(() => killProc("SIGKILL"), 5000);
				}
			};

			if (opts.signal) {
				if (opts.signal.aborted) {
					abortNow();
				} else {
					opts.signal.addEventListener("abort", abortNow, { once: true });
				}
			}

			timeoutTimer = setTimeout(() => {
				if (settled) return;
				timedOut = true;
				currentResult.timedOut = true;
				currentResult.stopReason = "timeout";
				currentResult.errorMessage = `Task timed out after ${opts.timeoutMs}ms`;
				killProc("SIGTERM");
				if (!killTimer) {
					killTimer = setTimeout(() => killProc("SIGKILL"), 5000);
				}
			}, opts.timeoutMs);

			proc.on("close", (code) => {
				if (buffer.trim()) processLine(buffer);
				currentResult.exitCode = code ?? 1;
				if (timedOut) {
					currentResult.timedOut = true;
					currentResult.stopReason = "timeout";
					if (!currentResult.errorMessage) currentResult.errorMessage = "Task timed out";
				}
				if (aborted) {
					currentResult.aborted = true;
					currentResult.stopReason = "aborted";
				}
				emitUpdate();
				finish();
			});

			proc.on("error", (err) => {
				currentResult.exitCode = 1;
				currentResult.errorMessage = err.message;
				currentResult.stderr += `${err.message}\n`;
				emitUpdate();
				finish();
			});
		});

		return currentResult;
	} finally {
		if (tmpPromptPath) {
			try {
				fs.unlinkSync(tmpPromptPath);
			} catch {
				// ignore cleanup errors
			}
		}
		if (tmpPromptDir) {
			try {
				fs.rmdirSync(tmpPromptDir);
			} catch {
				// ignore cleanup errors
			}
		}
	}
}

export async function mapWithConcurrencyLimit<TIn, TOut>(
	items: TIn[],
	concurrency: number,
	fn: (item: TIn, index: number) => Promise<TOut>,
): Promise<TOut[]> {
	if (items.length === 0) return [];
	const limit = Math.max(1, Math.min(concurrency, items.length));
	const results: TOut[] = new Array(items.length);
	let nextIndex = 0;
	const workers = new Array(limit).fill(null).map(async () => {
		while (true) {
			const current = nextIndex++;
			if (current >= items.length) return;
			results[current] = await fn(items[current], current);
		}
	});
	await Promise.all(workers);
	return results;
}
