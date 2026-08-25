/**
 * pi-multi-agent — lightweight multi-agent extension.
 *
 * Registers a single `delegate` tool with four modes:
 *   single | parallel | chain | discuss
 *
 * Each sub-agent runs in an isolated `pi` subprocess. Recursive delegation is
 * controlled by `maxDepth` (default 1): when PI_MULTI_AGENT_DEPTH reaches
 * maxDepth, this extension does not register the `delegate` tool at all.
 */

import type { AgentToolResult, ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { StringEnum } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { discoverAgents, type AgentScope } from "./agents.ts";
import { loadConfig, type MultiAgentConfig } from "./config.ts";
import {
	runChainMode,
	runDiscussMode,
	runParallelMode,
	runSingleMode,
	type ChainItemParams,
	type DelegateDetails,
	type DiscussItemParams,
	type ModeOutcome,
	type ModeUpdateCallback,
	type TaskItemParams,
} from "./modes.ts";

const TaskItem = Type.Object({
	agent: Type.String({ description: "Agent name" }),
	task: Type.String({ description: "Task to delegate" }),
	brief: Type.Optional(Type.String({ description: "Optional background/context brief" })),
	cwd: Type.Optional(Type.String({ description: "Working directory" })),
	tools: Type.Optional(Type.Array(Type.String(), { description: "Override tools for this task" })),
	model: Type.Optional(Type.String({ description: "Override model for this task" })),
});

const ChainItem = Type.Object({
	agent: Type.String({ description: "Agent name" }),
	task: Type.String({ description: "Task; use {previous} to reference previous output" }),
	brief: Type.Optional(Type.String({ description: "Optional background/context brief" })),
	cwd: Type.Optional(Type.String({ description: "Working directory" })),
	tools: Type.Optional(Type.Array(Type.String(), { description: "Override tools for this task" })),
	model: Type.Optional(Type.String({ description: "Override model for this task" })),
});

const DiscussItem = Type.Object({
	agent: Type.String({ description: "Participating agent name" }),
	stance: Type.Optional(Type.String({ description: "Initial stance or role in discussion" })),
	brief: Type.Optional(Type.String({ description: "Optional background/context brief" })),
	tools: Type.Optional(Type.Array(Type.String(), { description: "Override tools for this participant" })),
	model: Type.Optional(Type.String({ description: "Override model for this participant" })),
});

const AgentScopeSchema = StringEnum(["user", "project", "both"] as const, {
	description: 'Agent directories. Default "user".',
	default: "user",
});

const DelegateParams = Type.Object({
	mode: StringEnum(["single", "parallel", "chain", "discuss"] as const, {
		description: "Execution mode: single | parallel | chain | discuss",
	}),
	agent: Type.Optional(Type.String({ description: "Agent name (single mode)" })),
	task: Type.Optional(Type.String({ description: "Task to delegate (single mode)" })),
	brief: Type.Optional(Type.String({ description: "Optional background/context brief (single mode)" })),
	cwd: Type.Optional(Type.String({ description: "Working directory (single mode)" })),
	tools: Type.Optional(
		Type.Array(Type.String(), { description: "Override tools for the single-mode task" }),
	),
	model: Type.Optional(Type.String({ description: "Override model for the single-mode task" })),
	tasks: Type.Optional(
		Type.Array(TaskItem, { description: "Array of {agent, task, brief?, cwd?, tools?, model?} for parallel mode" }),
	),
	chain: Type.Optional(
		Type.Array(ChainItem, { description: "Array of {agent, task, ...} for sequential chain mode" }),
	),
	topic: Type.Optional(Type.String({ description: "Discussion topic (discuss mode)" })),
	agents: Type.Optional(
		Type.Array(DiscussItem, { description: "Participating agents (discuss mode, at least 2)" }),
	),
	termination: Type.Optional(
		Type.String({ description: "Termination condition description (discuss mode)" }),
	),
	moderator: Type.Optional(Type.String({ description: "Moderator agent name (discuss mode)" })),
	agentScope: Type.Optional(AgentScopeSchema),
	confirmProjectAgents: Type.Optional(
		Type.Boolean({
			description: "Prompt before running project-local agents. Default: true.",
			default: true,
		}),
	),
});

interface DelegateParamsShape {
	mode: "single" | "parallel" | "chain" | "discuss";
	agent?: string;
	task?: string;
	brief?: string;
	cwd?: string;
	tools?: string[];
	model?: string;
	tasks?: TaskItemParams[];
	chain?: ChainItemParams[];
	topic?: string;
	agents?: DiscussItemParams[];
	termination?: string;
	moderator?: string;
	agentScope?: AgentScope;
	confirmProjectAgents?: boolean;
}

function getDepth(): number {
	const raw = process.env.PI_MULTI_AGENT_DEPTH;
	if (!raw) return 0;
	const parsed = Number.parseInt(raw, 10);
	return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
}

function requestedAgentNames(params: DelegateParamsShape): string[] {
	const names: string[] = [];
	if (params.agent) names.push(params.agent);
	if (params.moderator) names.push(params.moderator);
	for (const item of params.tasks ?? []) names.push(item.agent);
	for (const item of params.chain ?? []) names.push(item.agent);
	for (const item of params.agents ?? []) names.push(item.agent);
	return names;
}

function wrapOutcome(outcome: ModeOutcome): AgentToolResult<DelegateDetails> {
	return {
		content: [{ type: "text", text: outcome.text }],
		details: outcome.details,
		...(outcome.isError ? { isError: true } : {}),
	} as AgentToolResult<DelegateDetails>;
}

export default function (pi: ExtensionAPI) {
	const config: MultiAgentConfig = loadConfig();
	const depth = getDepth();

	// Recursive delegation guard: when the child process reaches maxDepth, do
	// not expose the delegate tool, so sub-agents cannot delegate further.
	if (depth >= config.maxDepth) {
		return;
	}

	pi.registerTool({
		name: "delegate",
		label: "Delegate",
		description: [
			"Delegate work to isolated sub-agents running in separate pi processes.",
			"Modes:",
			'- single: one agent executes one task (use agent + task).',
			'- parallel: multiple agents execute tasks concurrently (use tasks array).',
			'- chain: agents run sequentially; later tasks can reference {previous} output (use chain array).',
			'- discuss: multiple agents discuss a topic with a centralized moderator (use topic + agents + termination).',
			"Each agent is a markdown file with YAML frontmatter. Agent scope defaults to user (~/.pi/agent/agents).",
			"Extra agents may live in <cwd>/.pi-multi-agent/agents; they are cwd-local and useful for one-off or experimental agents.",
		].join("\n"),
		parameters: DelegateParams,

		async execute(
			_toolCallId: string,
			params: any,
			signal: AbortSignal | undefined,
			onUpdate: ((partial: AgentToolResult<DelegateDetails>) => void) | undefined,
			ctx: ExtensionContext,
		): Promise<AgentToolResult<DelegateDetails>> {
			const agentScope: AgentScope = params.agentScope ?? "user";
			const discovery = discoverAgents(ctx.cwd, agentScope);
			const agents = discovery.agents;
			const confirmProjectAgents = params.confirmProjectAgents ?? true;

			const mode = params.mode;
			const detailsBase: DelegateDetails = {
				mode,
				agentScope,
				projectAgentsDir: discovery.projectAgentsDir,
				results: [],
			};

			const update: ModeUpdateCallback | undefined = onUpdate
				? (u) => {
						onUpdate({
							content: [{ type: "text", text: u.text }],
							details: { ...u.details, agentScope, projectAgentsDir: discovery.projectAgentsDir },
						} as AgentToolResult<DelegateDetails>);
					}
				: undefined;

			// Validate exactly one mode is well-formed before doing anything.
			const hasSingle = mode === "single" && Boolean(params.agent && params.task);
			const hasParallel = mode === "parallel" && Boolean(params.tasks && params.tasks.length > 0);
			const hasChain = mode === "chain" && Boolean(params.chain && params.chain.length > 0);
			const hasDiscuss =
				mode === "discuss" &&
				Boolean(params.topic && params.agents && params.agents.length >= 2);

			if (!hasSingle && !hasParallel && !hasChain && !hasDiscuss) {
				const available = agents.map((a) => `"${a.name}"`).join(", ") || "none";
				const hint =
					mode === "discuss"
						? "Discuss mode requires topic + agents (at least 2)."
						: mode === "single"
							? "Single mode requires agent + task."
							: mode === "parallel"
								? "Parallel mode requires a non-empty tasks array."
								: "Chain mode requires a non-empty chain array.";
				const dirHint =
					agentScope === "project"
						? "Project agents: <cwd>/.pi/agents"
						: agentScope === "both"
							? "Agent dirs: ~/.pi/agent/agents, <cwd>/.pi/agents, <cwd>/.pi-multi-agent/agents"
							: "Agent dirs: ~/.pi/agent/agents and <cwd>/.pi-multi-agent/agents";
				return {
					content: [{ type: "text", text: `Invalid delegate parameters: ${hint}\n${dirHint}\nAvailable agents: ${available}` }],
					details: { ...detailsBase, results: [] },
					isError: true,
				} as AgentToolResult<DelegateDetails>;
			}

			// Project-local agent confirmation.
			if (
				(agentScope === "project" || agentScope === "both") &&
				confirmProjectAgents &&
				ctx.hasUI
			) {
				const requested = new Set(requestedAgentNames(params));
				const projectAgentsRequested = agents.filter(
					(a) => a.source === "project" && requested.has(a.name),
				);
				if (projectAgentsRequested.length > 0) {
					const names = projectAgentsRequested.map((a) => a.name).join(", ");
					const dir = discovery.projectAgentsDir ?? "(unknown)";
					const ok = await ctx.ui.confirm(
						"Run project-local agents?",
						`Agents: ${names}\nSource: ${dir}\n\nProject agents are repo-controlled. Only continue for trusted repositories.`,
					);
					if (!ok) {
						return {
							content: [
								{ type: "text", text: "Canceled: project-local agents not approved." },
							],
							details: detailsBase,
							isError: true,
						} as AgentToolResult<DelegateDetails>;
					}
				}
			}

			let outcome: ModeOutcome;

			if (mode === "single") {
				outcome = await runSingleMode(
					ctx,
					config,
					{
						agent: params.agent!,
						task: params.task!,
						brief: params.brief,
						cwd: params.cwd,
						tools: params.tools,
						model: params.model,
					},
					discovery,
					agentScope,
					signal,
					update,
					depth,
				);
			} else if (mode === "parallel") {
				outcome = await runParallelMode(
					ctx,
					config,
					(params.tasks ?? []) as TaskItemParams[],
					discovery,
					agentScope,
					signal,
					update,
					depth,
				);
			} else if (mode === "chain") {
				outcome = await runChainMode(
					ctx,
					config,
					(params.chain ?? []) as ChainItemParams[],
					discovery,
					agentScope,
					signal,
					update,
					depth,
				);
			} else {
				outcome = await runDiscussMode(
					ctx,
					config,
					{
						topic: params.topic!,
						agents: (params.agents ?? []) as DiscussItemParams[],
						termination: params.termination,
						moderator: params.moderator,
					},
					discovery,
					agentScope,
					signal,
					update,
					depth,
				);
			}

			outcome.details.agentScope = agentScope;
			outcome.details.projectAgentsDir = discovery.projectAgentsDir;
			return wrapOutcome(outcome);
		},
	});
}
