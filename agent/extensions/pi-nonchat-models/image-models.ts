/**
 * Image implementations for the pi-nonchat-models extension.
 *
 * Each entry is a wire protocol selected by the `implementation` key in
 * ~/.pi/agent/nonchat-models.json. Add a new protocol by adding an entry here.
 */

import type { AssistantImages, ImageApi, ImageModel, ImagesContext } from "@earendil-works/pi-ai";
import { isAborted, isRecord, postJson, type RequestOptions } from "./common";

// -----------------------------------------------------------------------------
// "images-generations"
//
// OpenAI Images API: POST <baseUrl>/images/generations { model, prompt, n },
// responses carry data[].b64_json (or data[].url). Prompt-only generation;
// reference/edit images are not supported yet.
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

export const images = {
	"images-generations": { generateImages: generateImagesViaImagesApi },
};
