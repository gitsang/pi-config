/**
 * Classifier implementations for the pi-nonchat-models extension.
 *
 * Each entry is a wire protocol selected by the `implementation` key in
 * ~/.pi/agent/nonchat-models.json. Add a new protocol by adding an entry here.
 */

import type {
	ClassifierApi,
	ClassifierContext,
	ClassifierModel,
	ClassifierResult,
} from "@earendil-works/pi-ai";
import { clamp01, isAborted, isRecord, postJson, usageFromOpenAI, type RequestOptions } from "./common";

// -----------------------------------------------------------------------------
// "chat-classify"
//
// Turns a chat model into a classifier by prompting it for calibrated structured
// answers. Probabilities are the model's own estimates, not the calibrated
// output of a dedicated classifier API (Jev / Decisions / ...).
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

export const classifiers = {
	"chat-classify": { classify: classifyViaChat },
};
