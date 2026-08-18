import { readFileSync } from "node:fs";
import { join } from "node:path";

export interface FishingConfig {
	uiVisible: boolean;
	animationIntervalMs: number;
	tickIntervalMs: number;
	defaultInventoryCapacity: number;
	baitTokensPerCast: number;
}

export const DEFAULT_FISHING_CONFIG: FishingConfig = {
	uiVisible: false,
	animationIntervalMs: 200,
	tickIntervalMs: 500,
	defaultInventoryCapacity: 10,
	baitTokensPerCast: 2000,
};

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

function readJson(file: string): Record<string, unknown> | undefined {
	try {
		const parsed = JSON.parse(readFileSync(file, "utf8")) as unknown;
		return isRecord(parsed) ? parsed : undefined;
	} catch {
		return undefined;
	}
}

function mergeConfig(base: FishingConfig, override: Record<string, unknown> | undefined): FishingConfig {
	if (!override) return base;
	const next = { ...base };
	for (const key of Object.keys(base) as Array<keyof FishingConfig>) {
		const value = override[key];
		if (typeof value === "boolean" && key === "uiVisible") next.uiVisible = value;
		if (typeof value === "number" && Number.isFinite(value)) {
			(next as unknown as Record<string, unknown>)[key] = value;
		}
	}
	return next;
}

export function loadFishingConfig(extDir: string, cwd?: string): FishingConfig {
	let config = { ...DEFAULT_FISHING_CONFIG };
	config = mergeConfig(config, readJson(join(extDir, "config.json")));
	if (cwd) {
		config = mergeConfig(config, readJson(join(cwd, ".pi", "pi-fishing.json")));
	}
	return config;
}
