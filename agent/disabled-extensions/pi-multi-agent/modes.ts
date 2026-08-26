/**
 * Coordination logic for single / parallel / chain / discuss modes.
 */

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { AgentConfig, AgentDiscoveryResult, AgentScope } from "./agents.ts";
import type { MultiAgentConfig } from "./config.ts";
import {
	formatUsageStats,
	getFinalOutput,
	getResultOutput,
	isFailedResult,
	mapWithConcurrencyLimit,
	runAgentTask,
	truncateForModel,
	zeroUsage,
	type TaskResult,
	type UsageStats,
} from "./subprocess.ts";
import type { FleetStore } from "./fleet.ts";

export type DelegateMode = "single" | "parallel" | "chain" | "discuss";

export interface DiscussRound {
	round: number;
	participantResults: TaskResult[];
	moderatorResult: TaskResult | null;
	moderatorOutput: string;
	moderatorParsed: boolean;
	done: boolean;
}

export interface DelegateDetails {
	mode: DelegateMode;
	agentScope: AgentScope;
	projectAgentsDir: string | null;
	results: TaskResult[];
	rounds?: DiscussRound[];
	summary?: string;
	verdict?: string;
	stopReason?: string;
}

export interface ModeOutcome {
	text: string;
	details: DelegateDetails;
	isError?: boolean;
}

export interface ModeUpdate {
	text: string;
	details: DelegateDetails;
}

export type ModeUpdateCallback = (update: ModeUpdate) => void;

export interface SingleModeParams {
	agent: string;
	task: string;
	brief?: string;
	cwd?: string;
	tools?: string[];
	model?: string;
}

export interface TaskItemParams {
	agent: string;
	task: string;
	brief?: string;
	cwd?: string;
	tools?: string[];
	model?: string;
}

export interface ChainItemParams {
	agent: string;
	task: string;
	brief?: string;
	cwd?: string;
	tools?: string[];
	model?: string;
}

export interface DiscussItemParams {
	agent: string;
	stance?: string;
	brief?: string;
	tools?: string[];
	model?: string;
}

export interface DiscussModeParams {
	topic: string;
	agents: DiscussItemParams[];
	termination?: string;
	moderator?: string;
}

export function buildTaskPrompt(task: string, brief?: string): string {
	const trimmedBrief = brief?.trim();
	if (trimmedBrief) {
		return `Background brief:\n${trimmedBrief}\n\nTask: ${task}`;
	}
	return `Task: ${task}`;
}

export function resolveModel(
	ctx: ExtensionContext,
	config: MultiAgentConfig,
	taskModel?: string,
	agentModel?: string,
): string | undefined {
	const sessionModel = ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : undefined;
	const candidates = [taskModel, agentModel, sessionModel, config.fallbackModel].filter(
		(c): c is string => Boolean(c && c.includes("/")),
	);

	for (const candidate of candidates) {
		const idx = candidate.indexOf("/");
		const provider = candidate.slice(0, idx);
		const modelId = candidate.slice(idx + 1);
		try {
			const found = ctx.modelRegistry.find(provider, modelId);
			if (found) return candidate;
		} catch {
			// fall through to next candidate
		}
	}

	// Last resort: if nothing validated, prefer the configured fallback (even if
	// the registry can't see it), then the explicit task model, then undefined.
	return config.fallbackModel || candidates[0];
}

interface RunTaskOptions {
	task: string;
	brief?: string;
	cwd?: string;
	tools?: string[];
	model?: string;
	/** Full prompt appended to the child process. Overrides task + brief when provided. */
	taskPrompt?: string;
	signal?: AbortSignal;
	onUpdate?: (result: TaskResult) => void;
	depth: number;
	fleet?: FleetStore;
	mode?: string;
}

async function runTaskWithAgent(
	ctx: ExtensionContext,
	config: MultiAgentConfig,
	agent: AgentConfig,
	opts: RunTaskOptions,
): Promise<TaskResult> {
	const model = resolveModel(ctx, config, opts.model, agent.model);
	const taskPrompt = opts.taskPrompt ?? buildTaskPrompt(opts.task, opts.brief);
	return runAgentTask({
		agent,
		task: opts.task,
		taskPrompt,
		cwd: ctx.cwd,
		taskCwd: opts.cwd,
		tools: opts.tools,
		model,
		signal: opts.signal,
		onUpdate: opts.onUpdate,
		timeoutMs: config.perTaskTimeoutMs,
		depth: opts.depth,
		fleet: opts.fleet,
		mode: opts.mode,
	});
}

function unknownAgentResult(agentName: string, task: string, taskPrompt: string): TaskResult {
	return {
		agent: agentName,
		agentSource: "unknown",
		task,
		prompt: taskPrompt,
		exitCode: 1,
		messages: [],
		stderr: "",
		usage: zeroUsage(),
		errorMessage: "Unknown agent",
	};
}

function aggregateUsage(results: TaskResult[]): UsageStats {
	const total = zeroUsage();
	for (const r of results) {
		total.input += r.usage.input;
		total.output += r.usage.output;
		total.cacheRead += r.usage.cacheRead;
		total.cacheWrite += r.usage.cacheWrite;
		total.cost += r.usage.cost;
		total.totalTokens += r.usage.totalTokens;
		total.turns += r.usage.turns;
	}
	total.contextTokens = total.totalTokens;
	return total;
}

function statusText(result: TaskResult): string {
	if (isFailedResult(result)) {
		const reason =
			result.timedOut === true
				? "timeout"
				: result.aborted === true
					? "aborted"
					: result.stopReason && result.stopReason !== "end"
						? result.stopReason
						: "error";
		return `failed (${reason})`;
	}
	return "completed";
}

function formatSingleSuccess(result: TaskResult, config: MultiAgentConfig): string {
	const output = truncateForModel(getFinalOutput(result.messages), config.perTaskOutputCapBytes);
	return [
		"## delegate/single",
		"",
		`agent: ${result.agent} (${result.agentSource})`,
		"status: completed",
		`usage: ${formatUsageStats(result.usage, result.model)}`,
		"",
		"--- final output ---",
		output,
	].join("\n");
}

function formatSingleFailure(result: TaskResult, config: MultiAgentConfig): string {
	const output = truncateForModel(getResultOutput(result), config.perTaskOutputCapBytes);
	return [
		"## delegate/single",
		"",
		`agent: ${result.agent} (${result.agentSource})`,
		`status: ${statusText(result)}`,
		result.errorMessage ? `error: ${result.errorMessage}` : "",
		"",
		"--- stderr/output ---",
		output,
	]
		.filter(Boolean)
		.join("\n");
}

export async function runSingleMode(
	ctx: ExtensionContext,
	config: MultiAgentConfig,
	params: SingleModeParams,
	discovery: AgentDiscoveryResult,
	agentScope: AgentScope,
	signal: AbortSignal | undefined,
	onUpdate: ModeUpdateCallback | undefined,
	depth: number,
	fleet?: FleetStore,
): Promise<ModeOutcome> {
	const details: DelegateDetails = {
		mode: "single",
		agentScope,
		projectAgentsDir: discovery.projectAgentsDir,
		results: [],
	};
	const agent = discovery.agents.find((a) => a.name === params.agent);
	if (!agent) {
		const text = `Unknown agent: "${params.agent}". Available agents: ${discovery.agents
			.map((a) => `"${a.name}"`)
			.join(", ") || "none"}.`;
		return { text, details, isError: true };
	}

	const result = await runTaskWithAgent(ctx, config, agent, {
		task: params.task,
		brief: params.brief,
		cwd: params.cwd,
		tools: params.tools,
		model: params.model,
		signal,
		depth,
		fleet: fleet,
		mode: "single",
		onUpdate: (r) => {
			if (onUpdate) {
				details.results = [r];
				onUpdate({
					text: isFailedResult(r)
						? formatSingleFailure(r, config)
						: formatSingleSuccess(r, config),
					details: { ...details, results: [r] },
				});
			}
		},
	});

	details.results = [result];
	if (isFailedResult(result)) {
		return { text: formatSingleFailure(result, config), details, isError: true };
	}
	return { text: formatSingleSuccess(result, config), details };
}

export async function runParallelMode(
	ctx: ExtensionContext,
	config: MultiAgentConfig,
	tasks: TaskItemParams[],
	discovery: AgentDiscoveryResult,
	agentScope: AgentScope,
	signal: AbortSignal | undefined,
	onUpdate: ModeUpdateCallback | undefined,
	depth: number,
	fleet?: FleetStore,
): Promise<ModeOutcome> {
	const details: DelegateDetails = {
		mode: "parallel",
		agentScope,
		projectAgentsDir: discovery.projectAgentsDir,
		results: [],
	};

	if (tasks.length > config.maxParallelTasks) {
		return {
			text: `Too many parallel tasks (${tasks.length}). Max is ${config.maxParallelTasks}.`,
			details,
			isError: true,
		};
	}

	const allResults: TaskResult[] = tasks.map((t) => {
		const agent = discovery.agents.find((a) => a.name === t.agent);
		if (!agent) {
			return unknownAgentResult(t.agent, t.task, buildTaskPrompt(t.task, t.brief));
		}
		return {
			agent: t.agent,
			agentSource: agent.source,
			task: t.task,
			prompt: buildTaskPrompt(t.task, t.brief),
			exitCode: -1,
			messages: [],
			stderr: "",
			usage: zeroUsage(),
			model: resolveModel(ctx, config, t.model, agent.model),
		};
	});

	const emitProgress = () => {
		if (!onUpdate) return;
		const running = allResults.filter((r) => r.exitCode === -1).length;
		const done = allResults.length - running;
		const text = `## delegate/parallel\n\nstatus: ${done}/${allResults.length} done, ${running} running...`;
		onUpdate({ text, details: { ...details, results: allResults.map((r) => ({ ...r })) } });
	};
	emitProgress();

	const results = await mapWithConcurrencyLimit(tasks, config.maxConcurrency, async (t, index) => {
		const agent = discovery.agents.find((a) => a.name === t.agent);
		if (!agent) {
			const placeholder = allResults[index];
			if (placeholder) {
				placeholder.exitCode = 1;
				placeholder.errorMessage = `Unknown agent: "${t.agent}". Available agents: ${
						discovery.agents.map((a) => `"${a.name}"`).join(", ") || "none"
					}.`;
			}
			return placeholder!;
		}

		const result = await runTaskWithAgent(ctx, config, agent, {
			task: t.task,
			brief: t.brief,
			cwd: t.cwd,
			tools: t.tools,
			model: t.model,
			signal,
			depth,
			fleet: fleet,
			mode: "parallel",
			onUpdate: (r) => {
				allResults[index] = r;
				emitProgress();
			},
		});
		allResults[index] = result;
		emitProgress();
		return result;
	});

	details.results = results;
	const successCount = results.filter((r) => !isFailedResult(r)).length;
	const failed = results.length - successCount;
	const summaries = results.map((r) => {
		const output = truncateForModel(getResultOutput(r), config.perTaskOutputCapBytes);
		return `### [${r.agent}] ${statusText(r)}\n\n${output}`;
	});

	const totalUsage = aggregateUsage(results);
	const header =
		failed === 0
			? `## delegate/parallel\n\nstatus: ${successCount}/${results.length} completed`
			: `## delegate/parallel\n\nstatus: ${successCount}/${results.length} completed, ${failed} failed`;

	return {
		text: `${header}\n\ntotal usage: ${formatUsageStats(totalUsage)}\n\n${summaries.join("\n\n---\n\n")}`,
		details,
	};
}

export async function runChainMode(
	ctx: ExtensionContext,
	config: MultiAgentConfig,
	chain: ChainItemParams[],
	discovery: AgentDiscoveryResult,
	agentScope: AgentScope,
	signal: AbortSignal | undefined,
	onUpdate: ModeUpdateCallback | undefined,
	depth: number,
	fleet?: FleetStore,
): Promise<ModeOutcome> {
	const details: DelegateDetails = {
		mode: "chain",
		agentScope,
		projectAgentsDir: discovery.projectAgentsDir,
		results: [],
	};

	const results: TaskResult[] = [];
	let previousOutput = "";

	for (let i = 0; i < chain.length; i++) {
		const step = chain[i];
		const task = step.task.replace(/\{previous\}/g, () => previousOutput);
		const agent = discovery.agents.find((a) => a.name === step.agent);

		if (!agent) {
			const text = `Chain stopped at step ${i + 1}: unknown agent "${step.agent}". Available agents: ${discovery.agents
				.map((a) => `"${a.name}"`)
				.join(", ") || "none"}.`;
			return { text, details, isError: true };
		}

		const result = await runTaskWithAgent(ctx, config, agent, {
			task,
			brief: step.brief,
			cwd: step.cwd,
			tools: step.tools,
			model: step.model,
			signal,
			depth,
			fleet: fleet,
			mode: "chain",
			onUpdate: (r) => {
				if (!onUpdate) return;
				const all = [...results, r];
				onUpdate({
					text: `## delegate/chain\n\nstep ${i + 1}/${chain.length}: ${r.agent} ${statusText(r)}`,
					details: { ...details, results: all },
				});
			},
		});
		result.step = i + 1;
		results.push(result);

		if (isFailedResult(result)) {
			const text = `Chain stopped at step ${i + 1} (${step.agent}): ${truncateForModel(
				getResultOutput(result),
				config.perTaskOutputCapBytes,
			)}`;
			return { text, details: { ...details, results }, isError: true };
		}

		previousOutput = getFinalOutput(result.messages) || "";
	}

	details.results = results;
	const totalUsage = aggregateUsage(results);
	const finalOutput = results.length > 0 ? getFinalOutput(results[results.length - 1].messages) : "(no output)";
	const text = [
		"## delegate/chain",
		"",
		`status: ${results.length}/${chain.length} steps completed`,
		`total usage: ${formatUsageStats(totalUsage)}`,
		"",
		"--- final output ---",
		truncateForModel(finalOutput, config.perTaskOutputCapBytes),
	].join("\n");
	return { text, details };
}

function buildDiscussPrompt(
	topic: string,
	termination: string,
	stance: string | undefined,
	brief: string | undefined,
	previousTranscript: string,
): string {
	const parts: string[] = [];
	parts.push("Discussion topic:");
	parts.push(topic);
	parts.push("");
	parts.push("Termination condition:");
	parts.push(termination);
	parts.push("");
	parts.push("Your stance / role:");
	parts.push(stance?.trim() || "(no specific stance provided)");
	if (brief?.trim()) {
		parts.push("");
		parts.push("Brief:");
		parts.push(brief.trim());
	}
	if (previousTranscript) {
		parts.push("");
		parts.push("Discussion so far:");
		parts.push(previousTranscript);
	}
	parts.push("");
	parts.push(
		"Present your current view concisely. If you believe the termination condition has been met, say so explicitly.",
	);
	return parts.join("\n");
}

function buildModeratorPrompt(topic: string, termination: string, roundText: string): string {
	return [
		"You are the moderator of a multi-agent discussion.",
		"",
		"Topic:",
		topic,
		"",
		"Termination condition:",
		termination,
		"",
		"Latest round contributions:",
		roundText,
		"",
		'Decide whether the discussion should end. Output ONLY a single JSON object with exactly these keys:',
		'{"done": boolean, "summary": string, "verdict": string}',
		"",
		"- done: true only when the termination condition is met.",
		"- summary: concise summary of the discussion and its conclusion.",
		"- verdict: short final verdict.",
	].join("\n");
}

interface ModeratorParsed {
	done: boolean;
	summary: string;
	verdict: string;
}

function parseModeratorJson(output: string): ModeratorParsed | null {
	let text = output.trim();
	if (!text) return null;

	const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
	if (fence) text = fence[1].trim();

	const start = text.indexOf("{");
	const end = text.lastIndexOf("}");
	if (start >= 0 && end > start) text = text.slice(start, end + 1);

	try {
		const obj = JSON.parse(text) as Partial<ModeratorParsed>;
		if (typeof obj.done !== "boolean") return null;
		return {
			done: obj.done,
			summary: typeof obj.summary === "string" ? obj.summary : "",
			verdict: typeof obj.verdict === "string" ? obj.verdict : "",
		};
	} catch {
		return null;
	}
}

function buildBuiltinModeratorAgent(): AgentConfig {
	return {
		name: "moderator",
		description: "Built-in discussion moderator",
		systemPrompt:
			"You are a fair and concise moderator. You read the latest round of a multi-agent discussion, compare it to the termination condition, and return only JSON.",
		source: "builtin",
		filePath: "",
	};
}

export async function runDiscussMode(
	ctx: ExtensionContext,
	config: MultiAgentConfig,
	params: DiscussModeParams,
	discovery: AgentDiscoveryResult,
	agentScope: AgentScope,
	signal: AbortSignal | undefined,
	onUpdate: ModeUpdateCallback | undefined,
	depth: number,
	fleet?: FleetStore,
): Promise<ModeOutcome> {
	const details: DelegateDetails = {
		mode: "discuss",
		agentScope,
		projectAgentsDir: discovery.projectAgentsDir,
		results: [],
		rounds: [],
	};

	if (params.agents.length < 2) {
		return {
			text: "Discuss mode requires at least 2 participating agents.",
			details,
			isError: true,
		};
	}

	const termination =
		params.termination?.trim() ||
		"The discussion ends when participants reach a clear consensus or no new viewpoints emerge.";

	const moderatorAgent = params.moderator
		? discovery.agents.find((a) => a.name === params.moderator) ?? buildBuiltinModeratorAgent()
		: buildBuiltinModeratorAgent();

	const startTime = Date.now();
	const rounds: DiscussRound[] = [];
	let transcript = "";
	let totalTokens = 0;
	let totalCost = 0;
	let stopReason: string | undefined;
	let lastParsed: ModeratorParsed | null = null;

	const checkLimits = (): string | undefined => {
		if (Date.now() - startTime >= config.discussion.maxDurationMs) return "maxDurationMs";
		if (totalTokens >= config.discussion.maxTokens) return "maxTokens";
		if (totalCost >= config.discussion.maxCostUsd) return "maxCostUsd";
		return undefined;
	};

	const emitProgress = (round: number, stage: string) => {
		if (!onUpdate) return;
		onUpdate({
			text: `## delegate/discuss\n\nstatus: round ${round} ${stage}...\nrounds completed: ${rounds.length}`,
			details: {
				...details,
				rounds: [...rounds],
				stopReason,
			},
		});
	};

	let round = 1;
	for (; round <= config.discussion.maxRounds; round++) {
		stopReason = checkLimits();
		if (stopReason) break;
		if (signal?.aborted) {
			stopReason = "aborted";
			break;
		}

		emitProgress(round, "participants running");

		const participantResults = await mapWithConcurrencyLimit(
			params.agents,
			config.maxConcurrency,
			async (p) => {
				const agent = discovery.agents.find((a) => a.name === p.agent);
				const taskPrompt = buildDiscussPrompt(params.topic, termination, p.stance, p.brief, transcript);
				if (!agent) {
					return unknownAgentResult(p.agent, `Discuss: ${params.topic}`, taskPrompt);
				}
				return runTaskWithAgent(ctx, config, agent, {
					task: `Discuss: ${params.topic}`,
					brief: p.brief,
					cwd: undefined,
					tools: p.tools,
					model: p.model,
					taskPrompt,
					signal,
					depth,
					fleet: fleet,
					mode: "discuss",
				});
			},
		);

		for (const r of participantResults) {
			totalTokens += r.usage.totalTokens;
			totalCost += r.usage.cost;
		}

		const roundText = participantResults
			.map(
				(r) =>
					`### ${r.agent} (${statusText(r)})\n${truncateForModel(
						getResultOutput(r),
						config.perTaskOutputCapBytes,
					)}`,
			)
			.join("\n\n");

		transcript = transcript
			? `${transcript}\n\n--- Round ${round} ---\n${roundText}`
			: `--- Round ${round} ---\n${roundText}`;

		stopReason = checkLimits();
		if (stopReason) {
			rounds.push({
				round,
				participantResults,
				moderatorResult: null,
				moderatorOutput: "",
				moderatorParsed: false,
				done: false,
			});
			break;
		}
		if (signal?.aborted) {
			rounds.push({
				round,
				participantResults,
				moderatorResult: null,
				moderatorOutput: "",
				moderatorParsed: false,
				done: false,
			});
			stopReason = "aborted";
			break;
		}

		emitProgress(round, "moderator running");

		const moderatorTaskPrompt = buildModeratorPrompt(params.topic, termination, roundText);
		const moderatorResult = await runAgentTask({
			agent: moderatorAgent,
			task: `Moderate discussion round ${round}`,
			taskPrompt: moderatorTaskPrompt,
			cwd: ctx.cwd,
			tools: moderatorAgent.source === "builtin" ? undefined : moderatorAgent.tools,
			model: resolveModel(ctx, config, undefined, moderatorAgent.model),
			signal,
			timeoutMs: config.perTaskTimeoutMs,
			depth,
			fleet: fleet,
			mode: "discuss-moderator",
		});

		totalTokens += moderatorResult.usage.totalTokens;
		totalCost += moderatorResult.usage.cost;

		const moderatorOutput = getFinalOutput(moderatorResult.messages);
		const parsed = parseModeratorJson(moderatorOutput);
		if (parsed) lastParsed = parsed;

		rounds.push({
			round,
			participantResults,
			moderatorResult,
			moderatorOutput,
			moderatorParsed: Boolean(parsed),
			done: parsed?.done ?? false,
		});

		if (parsed?.done) {
			stopReason = "moderator_done";
			break;
		}

		stopReason = checkLimits();
		if (stopReason) break;
	}

	if (!stopReason) stopReason = round > config.discussion.maxRounds ? "maxRounds" : checkLimits() ?? "moderator_done";

	details.rounds = rounds;
	details.results = rounds.flatMap((r) => r.participantResults);
	details.stopReason = stopReason;
	details.summary = lastParsed?.summary;
	details.verdict = lastParsed?.verdict;

	const totalUsage = aggregateUsage(rounds.flatMap((r) => [
		...r.participantResults,
		...(r.moderatorResult ? [r.moderatorResult] : []),
	]));

	const lastRound = rounds[rounds.length - 1];
	const lastRoundText = lastRound
		? lastRound.participantResults
				.map((r) => `${r.agent}: ${getResultOutput(r)}`)
				.join("\n")
		: "";

	const summaryText = lastParsed?.summary?.trim()
		? lastParsed.summary
		: lastParsed?.verdict?.trim()
			? lastParsed.verdict
			: lastRoundText
				? `Discussion stopped before a final moderator summary was produced. Last round contributions:\n${lastRoundText}`
				: "Discussion stopped before a final summary was produced.";

	const text = [
		"## delegate/discuss",
		"",
		`status: ${stopReason === "moderator_done" ? "completed" : `stopped (${stopReason})`} after ${rounds.length} round${rounds.length === 1 ? "" : "s"}`,
		`total usage: ${formatUsageStats(totalUsage)}`,
		"",
		"--- moderator summary ---",
		truncateForModel(summaryText, config.perTaskOutputCapBytes),
		lastParsed?.verdict
			? `\n\n--- verdict ---\n${truncateForModel(lastParsed.verdict, config.perTaskOutputCapBytes)}`
			: "",
	].join("\n");

	return { text, details };
}


