/**
 * pi-nonchat-models — expose non-chat models (classifiers, image models) to
 * codemode (`models.classify()` / `models.generateImages()`) via a provider
 * extension. models.json cannot declare these: its schema has no `type` /
 * `output` fields and cannot carry call implementations (see the module
 * comments in common.ts for the config shape).
 *
 *   ~/.pi/agent/nonchat-models.json        declarative provider/model metadata
 *   classifier-models.ts                   classifier wire protocols
 *   image-models.ts                        image wire protocols
 *
 * Reload after editing the config (`/reload` or restart pi).
 *
 * Usage from a codemode script:
 *   const j = await models.getModelOfType("classifier", "saigw-classifier", "deepseek-flash");
 *   const r = await models.classify(j, { state: {...}, questions: {...} });
 *
 *   const m = await models.getModelOfType("image", "yealink-images", "azure/gpt-image-2.5-flare");
 *   const g = await models.generateImages(m, { input: [{ type: "text", text: "..." }] });
 */

import type { ExtensionAPI, ProviderModelConfig } from "@earendil-works/pi-coding-agent";
import { authKey, readProviders, type ProviderEntry } from "./common";
import { classifiers } from "./classifier-models";
import { images } from "./image-models";

export default function (pi: ExtensionAPI) {
	for (const entry of readProviders()) {
		pi.registerProvider(entry.id, buildProviderConfig(entry));
	}
}

function buildProviderConfig(entry: ProviderEntry) {
	const models: ProviderModelConfig[] = [];
	const classifierImpls: Record<string, { classify: unknown }> = {};
	const imageImpls: Record<string, { generateImages: unknown }> = {};

	for (const model of entry.models) {
		if (model.type === "classifier") {
			const implementation = classifiers[model.implementation as keyof typeof classifiers];
			if (!implementation) {
				throw new Error(
					`nonchat-models.json: provider "${entry.id}" model "${model.id}" uses unknown classifier implementation "${model.implementation}" (available: ${Object.keys(classifiers).join(", ")})`,
				);
			}
			models.push({
				type: "classifier",
				id: model.id,
				name: model.name ?? model.id,
				api: model.implementation,
				baseUrl: entry.baseUrl,
				input: model.input ?? ["text"],
				cost: model.cost ?? { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
				contextWindow: model.contextWindow ?? 128000,
			});
			classifierImpls[model.implementation] = implementation;
		} else {
			const implementation = images[model.implementation as keyof typeof images];
			if (!implementation) {
				throw new Error(
					`nonchat-models.json: provider "${entry.id}" model "${model.id}" uses unknown image implementation "${model.implementation}" (available: ${Object.keys(images).join(", ")})`,
				);
			}
			models.push({
				type: "image",
				id: model.id,
				name: model.name ?? model.id,
				api: model.implementation,
				baseUrl: entry.baseUrl,
				input: model.input ?? ["text"],
				output: model.output ?? ["image"],
				cost: model.cost ?? { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			});
			imageImpls[model.implementation] = implementation;
		}
	}

	return {
		name: entry.name,
		baseUrl: entry.baseUrl,
		apiKey: authKey(entry.auth, entry.id),
		models,
		...(Object.keys(classifierImpls).length > 0 ? { classifiers: classifierImpls } : {}),
		...(Object.keys(imageImpls).length > 0 ? { images: imageImpls } : {}),
	};
}
