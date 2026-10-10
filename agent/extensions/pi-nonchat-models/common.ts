/**
 * Shared plumbing for the pi-nonchat-models extension.
 *
 * Config: ~/.pi/agent/nonchat-models.json
 * {
 *   "providers": {
 *     "<provider id>": {
 *       "name": "…",                          // optional display name
 *       "baseUrl": "https://…/v1",
 *       "auth": { "env": "MY_API_KEY", "storedProvider": "twin" },   // env first, then auth.json
 *       "models": [
 *         { "type": "classifier", "implementation": "chat-classify",
 *           "id": "…", "name": "…", "input": ["text","image"],
 *           "contextWindow": 1000000,
 *           "cost": { "input": 0, "output": 0, "cacheRead": 0, "cacheWrite": 0 } },
 *         { "type": "image", "implementation": "images-generations",
 *           "id": "…", "name": "…", "input": ["text"], "output": ["image"], "cost": { … } }
 *       ]
 *     }
 *   }
 * }
 */

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { Usage } from "@earendil-works/pi-ai";

export const CONFIG_PATH = join(homedir(), ".pi", "agent", "nonchat-models.json");

export interface RequestOptions {
	apiKey?: string;
	headers?: Record<string, string>;
	fetch?: typeof fetch;
	signal?: AbortSignal;
	timeoutMs?: number;
	onPayload?: (payload: unknown, model: unknown) => Promise<unknown> | unknown;
	onResponse?: (response: { status: number; headers: Record<string, string> }, model: unknown) => Promise<void> | void;
}

export interface ProviderAuthConfig {
	/** Environment variable holding the API key. */
	env?: string;
	/** Twin provider whose stored key in ~/.pi/agent/auth.json is reused. */
	storedProvider?: string;
}

export interface CostRates {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
}

export interface ModelEntry {
	type: "classifier" | "image";
	/** Key into the classifier/image implementation registries. */
	implementation: string;
	id: string;
	name?: string;
	input?: ("text" | "image")[];
	output?: ("text" | "image")[];
	contextWindow?: number;
	cost?: CostRates;
}

export interface ProviderEntry {
	id: string;
	name?: string;
	baseUrl: string;
	auth?: ProviderAuthConfig;
	models: ModelEntry[];
}

// -----------------------------------------------------------------------------
// Credentials
// -----------------------------------------------------------------------------

function storedKey(providerId: string): string | undefined {
	try {
		const path = join(homedir(), ".pi", "agent", "auth.json");
		const entry = (JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>)[providerId];
		if (typeof entry === "string") return entry;
		if (entry && typeof entry === "object" && typeof (entry as { key?: unknown }).key === "string") {
			return (entry as { key: string }).key;
		}
	} catch {
		// No auth.json yet; fall through.
	}
	return undefined;
}

/** Resolve an API key: env var first, then the twin provider's stored credential. */
export function authKey(auth: ProviderAuthConfig | undefined, providerId: string): string {
	const envVar = auth?.env;
	const fromEnv = envVar ? process.env[envVar] : undefined;
	if (fromEnv) return fromEnv;
	const twin = auth?.storedProvider ?? providerId;
	const fromStore = storedKey(twin);
	if (fromStore) return fromStore;
	if (envVar) return `$${envVar}`;
	throw new Error(
		`No API key for provider "${providerId}": set ${envVar ?? "<auth.env>"} or store a credential for "${twin}" via /login`,
	);
}

// -----------------------------------------------------------------------------
// Config file
// -----------------------------------------------------------------------------

export function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

export function readProviders(configPath: string = CONFIG_PATH): ProviderEntry[] {
	let raw: string;
	try {
		raw = readFileSync(configPath, "utf8");
	} catch {
		throw new Error(`Missing config file: ${configPath}`);
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch (error) {
		throw new Error(`Invalid JSON in ${configPath}: ${error instanceof Error ? error.message : String(error)}`);
	}
	const providers = isRecord(parsed) ? parsed.providers : undefined;
	if (!isRecord(providers)) throw new Error(`${configPath} must contain a "providers" object`);
	const entries: ProviderEntry[] = [];
	for (const [id, rawEntry] of Object.entries(providers)) {
		if (!isRecord(rawEntry) || typeof rawEntry.baseUrl !== "string" || !Array.isArray(rawEntry.models)) {
			throw new Error(`${configPath}: provider "${id}" needs baseUrl and a models array`);
		}
		const models: ModelEntry[] = [];
		for (const rawModel of rawEntry.models) {
			if (!isRecord(rawModel) || typeof rawModel.id !== "string") {
				throw new Error(`${configPath}: provider "${id}" has a model without an "id"`);
			}
			if (rawModel.type !== "classifier" && rawModel.type !== "image") {
				throw new Error(`${configPath}: provider "${id}" model "${rawModel.id}" needs type "classifier" or "image"`);
			}
			if (typeof rawModel.implementation !== "string" || !rawModel.implementation) {
				throw new Error(`${configPath}: provider "${id}" model "${rawModel.id}" needs an "implementation"`);
			}
			models.push(rawModel as unknown as ModelEntry);
		}
		entries.push({
			id,
			name: typeof rawEntry.name === "string" ? rawEntry.name : undefined,
			baseUrl: rawEntry.baseUrl,
			auth: isRecord(rawEntry.auth) ? (rawEntry.auth as unknown as ProviderAuthConfig) : undefined,
			models,
		});
	}
	return entries;
}

// -----------------------------------------------------------------------------
// HTTP
// -----------------------------------------------------------------------------

export function isAborted(error: unknown, options?: RequestOptions): boolean {
	return options?.signal?.aborted === true || (error instanceof Error && error.name === "AbortError");
}

function headersToRecord(headers: Headers): Record<string, string> {
	const record: Record<string, string> = {};
	headers.forEach((value, key) => (record[key] = value));
	return record;
}

export async function postJson(
	model: { provider: string; baseUrl: string },
	path: string,
	payload: Record<string, unknown>,
	options?: RequestOptions,
): Promise<unknown> {
	const apiKey = options?.apiKey;
	if (!apiKey) throw new Error(`No API key for provider: ${model.provider}`);
	let body = payload;
	const replaced = await options?.onPayload?.(body, model);
	if (replaced !== undefined) body = replaced as Record<string, unknown>;
	const fetchImpl = options?.fetch ?? fetch;
	const response = await fetchImpl(`${model.baseUrl.replace(/\/+$/u, "")}${path}`, {
		method: "POST",
		headers: {
			"Content-Type": "application/json",
			Authorization: `Bearer ${apiKey}`,
			...options?.headers,
		},
		body: JSON.stringify(body),
		signal: options?.signal,
	});
	await options?.onResponse?.({ status: response.status, headers: headersToRecord(response.headers) }, model);
	const text = await response.text();
	if (!response.ok) throw new Error(`${response.status} ${response.statusText}: ${text.slice(0, 2000)}`);
	try {
		return JSON.parse(text) as unknown;
	} catch {
		throw new Error(`Unexpected non-JSON response: ${text.slice(0, 500)}`);
	}
}

// -----------------------------------------------------------------------------
// Small helpers
// -----------------------------------------------------------------------------

export function clamp01(value: unknown, fallback = 0): number {
	const n = typeof value === "number" ? value : Number(value);
	if (!Number.isFinite(n)) return fallback;
	return Math.min(1, Math.max(0, n));
}

export function usageFromOpenAI(raw: unknown, cost: CostRates): Usage | undefined {
	if (!isRecord(raw)) return undefined;
	const promptTokens = typeof raw.prompt_tokens === "number" ? raw.prompt_tokens : 0;
	const completionTokens = typeof raw.completion_tokens === "number" ? raw.completion_tokens : 0;
	const details = isRecord(raw.prompt_tokens_details) ? raw.prompt_tokens_details : {};
	const cacheWrite = typeof details.cache_write_tokens === "number" ? details.cache_write_tokens : 0;
	const reportedCached = typeof details.cached_tokens === "number" ? details.cached_tokens : 0;
	const cacheRead = cacheWrite > 0 ? Math.max(0, reportedCached - cacheWrite) : reportedCached;
	const input = Math.max(0, promptTokens - cacheRead - cacheWrite);
	const perMillion = (rate: number, tokens: number) => (rate / 1_000_000) * tokens;
	const costTotal = {
		input: perMillion(cost.input, input),
		output: perMillion(cost.output, completionTokens),
		cacheRead: perMillion(cost.cacheRead, cacheRead),
		cacheWrite: perMillion(cost.cacheWrite, cacheWrite),
		total: 0,
	};
	costTotal.total = costTotal.input + costTotal.output + costTotal.cacheRead + costTotal.cacheWrite;
	return {
		input,
		output: completionTokens,
		cacheRead,
		cacheWrite,
		totalTokens: input + completionTokens + cacheRead + cacheWrite,
		cost: costTotal,
	};
}
