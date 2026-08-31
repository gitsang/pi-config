/**
 * pi-notify — configuration loading.
 *
 * The config is re-read whenever `config.json` changes on disk (mtime + size
 * check), so editing it takes effect on the next notification without
 * `/reload`. A missing file is not an error: the extension simply stays quiet.
 *
 * Location: `$PI_NOTIFY_CONFIG`, else `config.json` next to this extension.
 */

import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { knownChannelTypes } from "./channels/index.ts";
import type { ChannelConfig, EventToggles, NotifyConfig } from "./types.ts";

function resolveExtensionDir(): string {
	try {
		return dirname(fileURLToPath(import.meta.url));
	} catch {
		return join(homedir(), ".pi", "agent", "extensions", "pi-notify");
	}
}

export const EXTENSION_DIR = resolveExtensionDir();

export function configPath(): string {
	const override = process.env.PI_NOTIFY_CONFIG?.trim();
	return override ? override : join(EXTENSION_DIR, "config.json");
}

export function logPath(): string {
	// Next to the config file, so PI_NOTIFY_CONFIG keeps everything together.
	return join(dirname(configPath()), "notify.log");
}

/** Whole-value reference: "$TOKEN" */
const ENV_REF = /^\$([A-Za-z_][A-Za-z0-9_]*)$/;
/** Embedded reference: "Bearer ${MY_TOKEN}" */
const ENV_INTERPOLATION = /\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g;

/** Resolve environment references in string values, recursively. */
function resolveEnv(value: unknown): unknown {
	if (typeof value === "string") {
		const match = ENV_REF.exec(value);
		if (match) return process.env[match[1]] ?? "";
		return value.replace(ENV_INTERPOLATION, (_full, name: string) => process.env[name] ?? "");
	}
	if (Array.isArray(value)) return value.map(resolveEnv);
	if (value && typeof value === "object") {
		const out: Record<string, unknown> = {};
		for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
			out[key] = resolveEnv(item);
		}
		return out;
	}
	return value;
}

function bool(value: unknown, fallback: boolean): boolean {
	return typeof value === "boolean" ? value : fallback;
}

function num(value: unknown, fallback: number, min: number, max: number): number {
	if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
	return Math.min(max, Math.max(min, value));
}

function str(value: unknown, fallback: string): string {
	return typeof value === "string" && value.length > 0 ? value : fallback;
}

function strArray(value: unknown, fallback: string[]): string[] {
	if (!Array.isArray(value)) return fallback;
	const items = value.filter((v): v is string => typeof v === "string" && v.length > 0);
	return items.length > 0 ? items : fallback;
}

export function defaultConfig(path: string): NotifyConfig {
	return {
		enabled: true,
		// Only the interactive TUI by default: pi subagents run `pi --mode json -p`,
		// and pushing for every one of those would be pure noise.
		modes: ["tui"],
		timeoutMs: 5000,
		dedupeMs: 3000,
		minDurationSec: 0,
		maxTextChars: 500,
		titleTemplate: "pi {{status}}",
		template: "pi {{status}} · {{reason}}",
		events: { "task-complete": true },
		debug: false,
		channels: [],
		warnings: [],
		path,
		exists: false,
	};
}

function normalizeChannels(raw: unknown, warnings: string[]): ChannelConfig[] {
	if (raw === undefined) return [];
	if (!Array.isArray(raw)) {
		warnings.push('"channels" 必须是数组，已忽略');
		return [];
	}
	const known = knownChannelTypes();
	const channels: ChannelConfig[] = [];
	raw.forEach((item, index) => {
		if (!item || typeof item !== "object") {
			warnings.push(`channels[${index}] 不是对象，已忽略`);
			return;
		}
		const channel = resolveEnv(item) as ChannelConfig;
		if (typeof channel.type !== "string" || !known.includes(channel.type)) {
			warnings.push(
				`channels[${index}] 未知渠道类型 "${String(channel.type)}"，当前支持：${known.join(", ")}`,
			);
			return;
		}
		channels.push(channel);
	});
	return channels;
}

let cache: { key: string; config: NotifyConfig } | undefined;

/** Load the config, reusing the previous parse while the file is unchanged. */
export function loadConfig(): NotifyConfig {
	const path = configPath();
	if (!existsSync(path)) {
		cache = undefined;
		return defaultConfig(path);
	}

	let key: string;
	try {
		const stat = statSync(path);
		key = `${path}:${stat.mtimeMs}:${stat.size}`;
	} catch {
		key = `${path}:unstatable`;
	}
	if (cache && cache.key === key) return cache.config;

	const config = defaultConfig(path);
	config.exists = true;

	let parsed: Record<string, unknown>;
	try {
		parsed = JSON.parse(readFileSync(path, "utf-8")) as Record<string, unknown>;
	} catch (error) {
		config.enabled = false;
		config.warnings.push(
			`config.json 解析失败：${error instanceof Error ? error.message : String(error)}`,
		);
		cache = { key, config };
		return config;
	}

	config.enabled = bool(parsed.enabled, config.enabled);
	config.modes = strArray(parsed.modes, config.modes);
	config.timeoutMs = num(parsed.timeoutMs, config.timeoutMs, 200, 60_000);
	config.dedupeMs = num(parsed.dedupeMs, config.dedupeMs, 0, 600_000);
	config.minDurationSec = num(parsed.minDurationSec, config.minDurationSec, 0, 86_400);
	config.maxTextChars = num(parsed.maxTextChars, config.maxTextChars, 20, 4000);
	config.titleTemplate = str(parsed.titleTemplate, config.titleTemplate);
	config.template = str(parsed.template, config.template);
	config.debug = bool(parsed.debug, config.debug);

	if (parsed.events && typeof parsed.events === "object") {
		const events = parsed.events as Record<string, unknown>;
		const merged: EventToggles = { ...config.events };
		for (const [event, value] of Object.entries(events)) {
			merged[event as keyof EventToggles] = typeof value === "boolean" ? value : undefined;
		}
		config.events = merged;
	}

	config.channels = normalizeChannels(parsed.channels, config.warnings);
	if (config.enabled && config.channels.length === 0) {
		config.warnings.push("没有配置任何推送渠道（channels 为空）");
	} else if (config.enabled && config.channels.every((c) => c.enabled === false)) {
		config.warnings.push("所有渠道都是 enabled:false，填好配置后记得打开");
	}

	cache = { key, config };
	return config;
}

/** Drop the mtime cache — used by `/notify` so status output is always fresh. */
export function invalidateConfigCache(): void {
	cache = undefined;
}

/** Sensitive keys — masked in `/notify status` output. */
export const SECRET_KEYS = new Set(["url", "token", "secret", "Authorization", "authorization"]);

export function maskSecret(key: string, value: unknown): string {
	if (value == null) return "";
	const text = String(value);
	if (!SECRET_KEYS.has(key) && !/token|secret|key|password|authorization/i.test(key)) {
		return text;
	}
	if (text.length === 0) return "(空)";
	if (text.startsWith("$") || text.includes("${")) return text; // env ref — safe to show
	if (text.length <= 4) return "****";
	return `${"*".repeat(Math.min(8, text.length - 4))}${text.slice(-4)}`;
}

export interface RawConfigFile {
	enabled?: boolean;
	modes?: string[];
	timeoutMs?: number;
	dedupeMs?: number;
	minDurationSec?: number;
	maxTextChars?: number;
	debug?: boolean;
	titleTemplate?: string;
	template?: string;
	events?: Record<string, boolean>;
	channels?: Array<Record<string, unknown>>;
	[key: string]: unknown;
}

/** Read config.json without env expansion — for in-place edits. */
export function loadRawConfig(): { path: string; exists: boolean; data: RawConfigFile } {
	const path = configPath();
	if (!existsSync(path)) {
		return {
			path,
			exists: false,
			data: {
				enabled: true,
				modes: ["tui"],
				events: { "task-complete": true },
				channels: [],
			},
		};
	}
	try {
		const data = JSON.parse(readFileSync(path, "utf-8")) as RawConfigFile;
		if (!Array.isArray(data.channels)) data.channels = [];
		return { path, exists: true, data };
	} catch (error) {
		throw new Error(
			`config.json 解析失败：${error instanceof Error ? error.message : String(error)}`,
		);
	}
}

/** Atomically-ish write config.json and drop the mtime cache. */
export function saveRawConfig(data: RawConfigFile): string {
	const path = configPath();
	const dir = dirname(path);
	if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
	const body = `${JSON.stringify(data, null, "\t")}\n`;
	writeFileSync(path, body, "utf-8");
	invalidateConfigCache();
	return path;
}
