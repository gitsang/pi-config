/**
 * pi-multi-agent — configuration loading.
 *
 * Config path (user-level only):
 *   ~/.pi/agent/extensions/pi-multi-agent/config.json
 *
 * The file may not exist; defaults below are used in that case.
 */

import { readFileSync } from "node:fs";
import path from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";

export interface DiscussionConfig {
	maxRounds: number;
	maxTokens: number;
	maxCostUsd: number;
	maxDurationMs: number;
}

export interface MultiAgentConfig {
	fallbackModel: string;
	maxDepth: number;
	maxParallelTasks: number;
	maxConcurrency: number;
	perTaskTimeoutMs: number;
	perTaskOutputCapBytes: number;
	discussion: DiscussionConfig;
}

export const DEFAULT_CONFIG: MultiAgentConfig = {
	fallbackModel: "anthropic/claude-haiku-4-5",
	maxDepth: 1,
	maxParallelTasks: 8,
	maxConcurrency: 4,
	perTaskTimeoutMs: 600000,
	perTaskOutputCapBytes: 51200,
	discussion: {
		maxRounds: 30,
		maxTokens: 200000,
		maxCostUsd: 5,
		maxDurationMs: 600000,
	},
};

export function getConfigPath(): string {
	return path.join(getAgentDir(), "extensions", "pi-multi-agent", "config.json");
}

function toPositiveNumber(value: unknown, fallback: number): number {
	if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) return fallback;
	return value;
}

function toNonNegativeNumber(value: unknown, fallback: number): number {
	if (typeof value !== "number" || !Number.isFinite(value) || value < 0) return fallback;
	return value;
}

/** Read and merge config.json. Invalid or missing files fall back to defaults. */
export function loadConfig(): MultiAgentConfig {
	let raw: Partial<MultiAgentConfig> = {};
	try {
		raw = JSON.parse(readFileSync(getConfigPath(), "utf8")) as Partial<MultiAgentConfig>;
	} catch {
		// missing or invalid config -> defaults
	}

	const discussionRaw = (raw.discussion ?? {}) as Partial<DiscussionConfig>;

	return {
		fallbackModel:
			typeof raw.fallbackModel === "string" && raw.fallbackModel.trim()
				? raw.fallbackModel.trim()
				: DEFAULT_CONFIG.fallbackModel,
		maxDepth: toNonNegativeNumber(raw.maxDepth, DEFAULT_CONFIG.maxDepth),
		maxParallelTasks: toPositiveNumber(raw.maxParallelTasks, DEFAULT_CONFIG.maxParallelTasks),
		maxConcurrency: toPositiveNumber(raw.maxConcurrency, DEFAULT_CONFIG.maxConcurrency),
		perTaskTimeoutMs: toPositiveNumber(raw.perTaskTimeoutMs, DEFAULT_CONFIG.perTaskTimeoutMs),
		perTaskOutputCapBytes: toPositiveNumber(
			raw.perTaskOutputCapBytes,
			DEFAULT_CONFIG.perTaskOutputCapBytes,
		),
		discussion: {
			maxRounds: toPositiveNumber(discussionRaw.maxRounds, DEFAULT_CONFIG.discussion.maxRounds),
			maxTokens: toPositiveNumber(discussionRaw.maxTokens, DEFAULT_CONFIG.discussion.maxTokens),
			maxCostUsd: toNonNegativeNumber(discussionRaw.maxCostUsd, DEFAULT_CONFIG.discussion.maxCostUsd),
			maxDurationMs: toPositiveNumber(
				discussionRaw.maxDurationMs,
				DEFAULT_CONFIG.discussion.maxDurationMs,
			),
		},
	};
}
