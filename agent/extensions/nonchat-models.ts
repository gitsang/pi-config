/**
 * nonchat-models.ts — expose non-chat models to codemode (`models.classify()` /
 * `models.generateImages()`).
 *
 * Why an extension? `models.json` entries are always chat models: its schema has
 * no `type`/`output` fields, and classifier/image models additionally need an
 * implementation keyed by their `api` value (`classifiers` / `images`). Only a
 * provider extension can register those (see docs/custom-provider.md).
 *
 * Registered here:
 *   - provider `saigw-classifier`: classifier `deepseek-flash`
 *     (mirrors the chat model at models.json providers.saigw.models[deepseek-flash]).
 *     Classification is implemented by prompting the chat model for calibrated
 *     structured answers — probabilities are the model's own estimates, not the
 *     calibrated output of a dedicated classifier API (Jev / Decisions / ...).
 *   - provider `yealink-images`: image model `azure/gpt-image-2.5-flare`
 *     via the gateway's OpenAI Images endpoint (POST /images/generations).
 *
 * Credentials: env vars SAIGW_API_KEY / YEALINK_API_KEY first, then the stored
 * keys of the twin providers (`saigw`, `yealink`) in ~/.pi/agent/auth.json.
 * Re-run `/reload` (or restart pi) after re-running `/login` for those providers.
 *
 * Usage from a codemode script:
 *
 *   const j = await models.getModelOfType("classifier", "saigw-classifier", "deepseek-flash");
 *   const r = await models.classify(j, { state: {...}, questions: {...} });
 *
 *   const m = await models.getModelOfType("image", "yealink-images", "azure/gpt-image-2.5-flare");
 *   const g = await models.generateImages(m, { input: [{ type: "text", text: "..." }] });
 */

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type {
	AssistantImages,
	ClassifierContext,
	ClassifierModel,
	ClassifierResult,
	ClassifierApi,
	ImagesContext,
	ImageModel,
	ImageApi,
	Usage,
} from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

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
		// No auth.json yet; fall through to the env interpolation below.
	}
	return undefined;
}

function authKey(envVar: string, twinProvider: string): string {
	return process.env[envVar] ?? storedKey(twinProvider) ?? `$${envVar}`;
}

// -----------------------------------------------------------------------------
// Shared request plumbing
// -----------------------------------------------------------------------------

/** Loose structural view of ClassifierOptions / ImagesOptions; fields vary per pi-ai version. */
interface RequestOptions {
	apiKey?: string;
	headers?: Record<string, string>;
	fetch?: typeof fetch;
	signal?: AbortSignal;
	timeoutMs?: number;
	onPayload?: (payload: unknown, model: unknown) => Promise<unknown> | unknown;
	onResponse?: (response: { status: number; headers: Record<string, string> }, model: unknown) => Promise<void> | void;
}

function isAborted(error: unknown, options?: RequestOptions): boolean {
	return options?.signal?.aborted === true || (error instanceof Error && error.name === "AbortError");
}

function headersToRecord(headers: Headers): Record<string, string> {
	const record: Record<string, string> = {};
	headers.forEach((value, key) => (record[key] = value));
	return record;
}

async function postJson(
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

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

function clamp01(value: unknown, fallback = 0): number {
	const n = typeof value === "number" ? value : Number(value);
	if (!Number.isFinite(n)) return fallback;
	return Math.min(1, Math.max(0, n));
}

function usageFromOpenAI(
	raw: unknown,
	cost: { input: number; output: number; cacheRead: number; cacheWrite: number },
): Usage | undefined {
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

// -----------------------------------------------------------------------------
// Classifier bridge: chat model answering structured questions
// -----------------------------------------------------------------------------

const CLASSIFY_SYSTEM_PROMPT = [
	"You are a precise classification engine. You answer structured questions about a JSON state",
	"(and optionally attached images) with calibrated numeric estimates.",
	"For each question you must answer exactly as specified, with no prose outside the JSON object.",
	"Rules:",
	'- "choice": `choice` must be one of the criteria keys. `probabilities` must contain',
	"  every criteria key with a probability in [0, 1]; the values must sum to 1.",
	'- "score": `score` is the expected level index (a number in [0, criteria.length - 1], decimals allowed).',
	'- "bool": `probability` is the probability that the answer is true, in [0, 1].',
	'  `confidence` (when asked) is your confidence in the answer itself, in [0, 1].',
	'Return a single JSON object of the form {"answers": {"<question id>": {...}, ...}} and nothing else.',
].join("\n");

function renderQuestion(id: string, question: ClassifierContext["questions"][string]): string {
	if (question.type === "choice") {
		return [
			`Question "${id}" (choice): ${question.instructions}`,
			`criteria: ${JSON.stringify(question.criteria)}`,
			'answer shape: {"type":"choice","choice":"<key>","probabilities":{"<key>":number,...},"confidence":number}',
		].join("\n");
	}
	if (question.type === "score") {
		return [
			`Question "${id}" (score): ${question.instructions}`,
			`levels (lowest first): ${JSON.stringify(question.criteria)}`,
			'answer shape: {"type":"score","score":number,"confidence":number}',
		].join("\n");
	}
	return [
		`Question "${id}" (bool): ${question.instructions}`,
		`true means: ${question.criteria.true} | false means: ${question.criteria.false}`,
		'answer shape: {"type":"bool","probability":number}',
	].join("\n");
}

function extractJson(text: string): unknown {
	const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
	const candidate = fenced ? fenced[1] : text;
	const start = candidate.indexOf("{");
	const end = candidate.lastIndexOf("}");
	if (start < 0 || end <= start) throw new Error(`Model did not return JSON: ${text.slice(0, 300)}`);
	return JSON.parse(candidate.slice(start, end + 1)) as unknown;
}

function parseAnswers(raw: unknown, context: ClassifierContext): ClassifierResult["answers"] {
	if (!isRecord(raw) || !isRecord(raw.answers)) throw new Error('Model response must look like {"answers": {...}}');
	const answers: ClassifierResult["answers"] = {};
	for (const [id, question] of Object.entries(context.questions)) {
		const answer = raw.answers[id];
		if (!isRecord(answer)) throw new Error(`Model returned no answer for question "${id}"`);
		if (question.type === "choice") {
			const choice = String(answer.choice ?? "");
			if (!(choice in question.criteria)) throw new Error(`Question "${id}": "${choice}" is not one of the criteria keys`);
			const probabilities: Record<string, number> = {};
			const rawProbabilities = isRecord(answer.probabilities) ? answer.probabilities : {};
			let sum = 0;
			for (const key of Object.keys(question.criteria)) {
				const p = clamp01(rawProbabilities[key], key === choice ? 1 : 0);
				probabilities[key] = p;
				sum += p;
			}
			if (sum > 0) for (const key of Object.keys(probabilities)) probabilities[key] /= sum;
			answers[id] = {
				type: "choice",
				choice,
				probabilities,
				confidence: clamp01(answer.confidence, probabilities[choice] ?? 0),
			};
		} else if (question.type === "score") {
			const score = Number(answer.score);
			if (!Number.isFinite(score)) throw new Error(`Question "${id}": score must be a number`);
			answers[id] = {
				type: "score",
				score: Math.min(question.criteria.length - 1, Math.max(0, score)),
				confidence: clamp01(answer.confidence, 0.5),
			};
		} else {
			answers[id] = { type: "bool", probability: clamp01(answer.probability, 0.5) };
		}
	}
	return answers;
}

async function classifyViaChat(
	model: ClassifierModel<ClassifierApi>,
	context: ClassifierContext,
	options?: RequestOptions,
): Promise<ClassifierResult> {
	const output: ClassifierResult = {
		api: model.api,
		provider: model.provider,
		model: model.id,
		answers: {},
		stopReason: "stop",
		timestamp: Date.now(),
	};
	try {
		if (context.images?.length && !model.input.includes("image")) {
			throw new Error(`${model.provider}/${model.id} does not accept image input`);
		}
		const userParts: unknown[] = [
			{
				type: "text",
				text: `State:\n${JSON.stringify(context.state)}\n\nQuestions:\n\n${Object.entries(context.questions)
					.map(([id, question], index) => `${index + 1}. ${renderQuestion(id, question)}`)
					.join("\n\n")}`,
			},
		];
		for (const image of context.images ?? []) {
			userParts.push({ type: "image_url", image_url: { url: `data:${image.mimeType};base64,${image.data}` } });
		}
		const body = await postJson(
			model,
			"/chat/completions",
			{
				model: model.id,
				messages: [
					{ role: "system", content: CLASSIFY_SYSTEM_PROMPT },
					{ role: "user", content: userParts },
				],
				temperature: 0,
				max_tokens: 2000,
			},
			options,
		);
		if (!isRecord(body) || !Array.isArray(body.choices) || !isRecord(body.choices[0])) {
			throw new Error("Chat endpoint returned an unexpected response");
		}
		const message = isRecord(body.choices[0].message) ? body.choices[0].message : {};
		const text = typeof message.content === "string" ? message.content : "";
		if (!text.trim()) throw new Error("Chat endpoint returned an empty answer");
		output.answers = parseAnswers(extractJson(text), context);
		const usage = usageFromOpenAI(body.usage, model.cost);
		if (usage) output.usage = usage;
	} catch (error) {
		output.answers = {};
		output.stopReason = isAborted(error, options) ? "aborted" : "error";
		output.errorMessage = error instanceof Error ? error.message : String(error);
	}
	return output;
}

// -----------------------------------------------------------------------------
// Image bridge: OpenAI Images API (POST /images/generations)
// -----------------------------------------------------------------------------

function sniffMime(base64: string): string {
	if (base64.startsWith("iVBOR")) return "image/png";
	if (base64.startsWith("/9j/")) return "image/jpeg";
	if (base64.startsWith("UklGR")) return "image/webp";
	if (base64.startsWith("R0lGOD")) return "image/gif";
	return "image/png";
}

async function generateImagesViaImagesApi(
	model: ImageModel<ImageApi>,
	context: ImagesContext,
	options?: RequestOptions,
): Promise<AssistantImages> {
	const output: AssistantImages = {
		api: model.api,
		provider: model.provider,
		model: model.id,
		output: [],
		stopReason: "stop",
		timestamp: Date.now(),
	};
	try {
		const prompt = context.input
			.filter((item): item is { type: "text"; text: string } => item.type === "text")
			.map((item) => item.text.trim())
			.filter(Boolean)
			.join("\n");
		if (!prompt) throw new Error("A text prompt is required");
		if (context.input.some((item) => item.type === "image")) {
			throw new Error("This bridge does not support reference/edit images yet (prompt-only generation)");
		}
		const body = await postJson(model, "/images/generations", { model: model.id, prompt, n: 1 }, options);
		const data = isRecord(body) && Array.isArray(body.data) ? body.data : [];
		for (const item of data) {
			if (!isRecord(item)) continue;
			if (typeof item.b64_json === "string" && item.b64_json) {
				output.output.push({ type: "image", mimeType: sniffMime(item.b64_json), data: item.b64_json });
			} else if (typeof item.url === "string" && item.url) {
				const fetchImpl = options?.fetch ?? fetch;
				const response = await fetchImpl(item.url, { signal: options?.signal });
				if (!response.ok) throw new Error(`Fetching generated image failed: ${response.status}`);
				const base64 = Buffer.from(await response.arrayBuffer()).toString("base64");
				output.output.push({ type: "image", mimeType: sniffMime(base64), data: base64 });
			}
		}
		if (output.output.length === 0) throw new Error("Image endpoint returned no images");
	} catch (error) {
		output.output = [];
		output.stopReason = isAborted(error, options) ? "aborted" : "error";
		output.errorMessage = error instanceof Error ? error.message : String(error);
	}
	return output;
}

// -----------------------------------------------------------------------------
// Registration
// -----------------------------------------------------------------------------

export default function (pi: ExtensionAPI) {
	// Classifier over the saigw gateway's deepseek-flash chat model.
	// Model metadata mirrors models.json → providers.saigw.models[deepseek-flash].
	pi.registerProvider("saigw-classifier", {
		name: "SAIGW Classifier",
		baseUrl: "https://aigw.cn.c8g.top/v1",
		apiKey: authKey("SAIGW_API_KEY", "saigw"),
		models: [
			{
				type: "classifier",
				id: "deepseek-flash",
				name: "DeepSeek Flash (classifier)",
				api: "deepseek-chat-classify",
				input: ["text", "image"],
				contextWindow: 1000000,
				cost: { input: 0.14, output: 0.28, cacheRead: 0.0028, cacheWrite: 0 },
			},
		],
		classifiers: {
			"deepseek-chat-classify": { classify: classifyViaChat },
		},
	});

	// Image generation through the yealink gateway's OpenAI Images endpoint.
	pi.registerProvider("yealink-images", {
		name: "Yealink Images",
		baseUrl: "https://yllm.worklink.work/yllm/v1",
		apiKey: authKey("YEALINK_API_KEY", "yealink"),
		models: [
			{
				type: "image",
				id: "azure/gpt-image-2.5-flare",
				name: "GPT Image 2.5 Flare",
				api: "openai-images-generations",
				input: ["text"],
				output: ["image"],
				// Pricing not published by the gateway; set real rates here to get cost accounting.
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			},
		],
		images: {
			"openai-images-generations": { generateImages: generateImagesViaImagesApi },
		},
	});
}
