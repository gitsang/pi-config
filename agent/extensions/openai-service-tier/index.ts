/**
 * openai-service-tier — configurable `service_tier` injection for pi providers.
 *
 * WHY THIS EXISTS
 *   models.json has no `serviceTier` / `compat` option. pi's openai-responses
 *   implementation does have full `service_tier` plumbing (and even a `priority`
 *   → 2× cost multiplier), but it is driven by a runtime `options.serviceTier`
 *   that pi's engine never populates from static config — `streamSimple` /
 *   `buildBaseOptions` don't forward it, and there is no `PI_SERVICE_TIER` env
 *   var. So we inject `service_tier` at the payload level, right before the
 *   request is sent, via the `before_provider_request` hook.
 *
 *   Works for any provider whose request body accepts a `service_tier` field
 *   (OpenAI Responses, OpenAI Chat Completions, and compatible gateways). It is
 *   strictly opt-in: only providers/models listed in the config get injection.
 *
 * CONFIG
 *   Global:  <agent-home>/openai-service-tier.json   (e.g. ~/.pi/agent/)
 *   Project: <cwd>/.pi/openai-service-tier.json       (trusted projects only)
 *   Project config deep-merges over global config.
 *
 *   {
 *     "providers": {
 *       "saigw-openai": {
 *         "default": "priority",                       // sent when no session override
 *         "allowed": ["auto", "default", "flex", "priority"]
 *       }
 *     },
 *     "models": {
 *       "saigw-openai/gpt-5.6-sol": {
 *         "default": "priority",
 *         "allowed": ["priority", "flex"]
 *       }
 *     }
 *   }
 *
 *   - An entry's *presence* marks that provider/model as service-tier-capable.
 *     Model-level entries win over provider-level entries.
 *   - `default`: string sent when no session override is active. null/omitted =
 *     send nothing by default.
 *   - `allowed`: tiers accepted by `/service-tier <value>`. null/omitted = any
 *     tier accepted (soft warning if not a known OpenAI tier).
 *
 * COMMAND  /service-tier
 *   /service-tier              status (current model, capable?, active tier, allowed)
 *   /service-tier <tier>       set session override (validated against `allowed`)
 *   /service-tier off          explicitly send NO service_tier this session
 *   /service-tier on | reset   clear override, fall back to config default
 *   /service-tier list         list allowed tiers for the current model
 *
 *   Switching is refused when the current model is not configured as
 *   service-tier-capable (i.e. neither its provider nor itself is in the config).
 *
 * CAVEAT — cost tracking
 *   Because injection happens at the payload level (not via `options.serviceTier`),
 *   pi's internal `applyServiceTierPricing` (e.g. priority 2× surcharge) does NOT
 *   run. The request is correct; only the displayed token cost stays at base
 *   price. Adjust `cost` in models.json if you need accurate accounting.
 */

import {
	CONFIG_DIR_NAME,
	getAgentDir,
	type ExtensionAPI,
	type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import type { AutocompleteItem } from "@earendil-works/pi-tui";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/** Directory this extension lives in (used for the extension-local config fallback). */
const EXT_DIR = dirname(fileURLToPath(import.meta.url));

/** Known OpenAI `service_tier` values, for suggestions / soft validation. */
const KNOWN_TIERS = ["auto", "default", "flex", "priority", "scale"] as const;

/** Reserved subcommand words (cannot be used as tier names). */
const RESERVED = new Set(["off", "on", "reset", "list", "status"]);

interface TierEntry {
	default?: string | null;
	allowed?: string[] | null;
}

interface ServiceTierConfig {
	providers?: Record<string, TierEntry>;
	models?: Record<string, TierEntry>;
}

interface ResolvedEntry {
	default: string | null;
	allowed: string[] | null;
}

interface ResolvedConfig {
	providers: Map<string, ResolvedEntry>;
	models: Map<string, ResolvedEntry>;
}

interface LoadResult {
	config: ResolvedConfig;
	warnings: string[];
}

const EMPTY_CONFIG: ResolvedConfig = {
	providers: new Map(),
	models: new Map(),
};

function isStringArray(v: unknown): v is string[] {
	return Array.isArray(v) && v.every((x) => typeof x === "string");
}

/**
 * Validate + coerce a raw entry into a safe ResolvedEntry, collecting warnings
 * for malformed shapes instead of trusting unchecked casts. (A string
 * "allowed" would later crash `join()`; a non-string "default" would inject
 * garbage into the request body.)
 */
function normalizeEntry(
	raw: unknown,
	label: string,
	warnings: string[],
): ResolvedEntry | null {
	if (raw == null) return null;
	if (typeof raw !== "object" || Array.isArray(raw)) {
		warnings.push(`${label}: entry must be an object, ignored.`);
		return null;
	}
	const obj = raw as Record<string, unknown>;

	let def: string | null = null;
	const d = obj.default;
	if (d === undefined || d === null) {
		def = null;
	} else if (typeof d === "string") {
		def = d;
	} else {
		warnings.push(`${label}: "default" must be a string or null (got ${typeof d}), default ignored.`);
	}

	let allowed: string[] | null = null;
	const a = obj.allowed;
	if (a === undefined || a === null) {
		allowed = null;
	} else if (isStringArray(a)) {
		allowed = a;
	} else if (Array.isArray(a)) {
		warnings.push(`${label}: "allowed" must be an array of strings (contains non-strings), allowed ignored.`);
	} else {
		warnings.push(`${label}: "allowed" must be a string array or null (got ${typeof a}), allowed ignored.`);
	}

	return { default: def, allowed };
}

function normalizeConfig(raw: ServiceTierConfig, warnings: string[]): ResolvedConfig {
	const providers = new Map<string, ResolvedEntry>();
	const models = new Map<string, ResolvedEntry>();

	const pv = raw.providers;
	if (pv !== undefined) {
		if (pv && typeof pv === "object" && !Array.isArray(pv)) {
			for (const [k, v] of Object.entries(pv)) {
				const e = normalizeEntry(v, `providers["${k}"]`, warnings);
				if (e) providers.set(k, e);
			}
		} else {
			warnings.push(`"providers" must be an object, ignored.`);
		}
	}
	const mv = raw.models;
	if (mv !== undefined) {
		if (mv && typeof mv === "object" && !Array.isArray(mv)) {
			for (const [k, v] of Object.entries(mv)) {
				const e = normalizeEntry(v, `models["${k}"]`, warnings);
				if (e) models.set(k, e);
			}
		} else {
			warnings.push(`"models" must be an object, ignored.`);
		}
	}
	return { providers, models };
}

function deepMergeConfig(base: ServiceTierConfig, override: ServiceTierConfig): ServiceTierConfig {
	const mergeEntries = (
		a: Record<string, TierEntry> | undefined,
		b: Record<string, TierEntry> | undefined,
	): Record<string, TierEntry> | undefined => {
		if (!a) return b;
		if (!b) return a;
		const out: Record<string, TierEntry> = { ...a };
		for (const [k, v] of Object.entries(b)) {
			out[k] = { ...out[k], ...v };
		}
		return out;
	};
	return {
		providers: mergeEntries(base.providers, override.providers),
		models: mergeEntries(base.models, override.models),
	};
}

/**
 * Read a config file. Returns { value } on success, { error } on a parse/shape
 * failure, or null when the file is missing. Distinguishing missing-vs-invalid
 * lets loadConfig surface malformed-config errors through the UI.
 */
function tryReadConfig(
	path: string,
): { value: ServiceTierConfig } | { error: string } | null {
	let text: string;
	try {
		text = readFileSync(path, "utf8");
	} catch {
		return null; // missing file — not an error
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(text);
	} catch (e) {
		return { error: `${path}: invalid JSON (${e instanceof Error ? e.message : String(e)})` };
	}
	if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
		return { error: `${path}: top-level value must be a JSON object` };
	}
	return { value: parsed as ServiceTierConfig };
}

function loadConfig(ctx: ExtensionContext): LoadResult {
	const warnings: string[] = [];

	// readOne: returns the parsed config, or {} (after recording a warning) on
	// a parse/shape error, or {} when the file is simply missing.
	const readOne = (path: string): ServiceTierConfig => {
		const r = tryReadConfig(path);
		if (r === null) return {};
		if ("error" in r) {
			warnings.push(r.error);
			return {};
		}
		return r.value;
	};

	// Global: agent-home (next to models.json), via the official getAgentDir().
	// Extension-dir is a fallback for the "config lives with the extension"
	// convention. Project (trusted only) overrides global.
	let raw: ServiceTierConfig = readOne(join(getAgentDir(), "openai-service-tier.json"));
	raw = deepMergeConfig(raw, readOne(join(EXT_DIR, "openai-service-tier.json")));
	if (ctx.isProjectTrusted()) {
		raw = deepMergeConfig(raw, readOne(join(ctx.cwd, CONFIG_DIR_NAME, "openai-service-tier.json")));
	}

	return { config: normalizeConfig(raw, warnings), warnings };
}

/** Key for per-model session state: `provider/modelId`. */
function modelKey(provider: string, id: string): string {
	return `${provider}/${id}`;
}

/**
 * Resolve the configured entry for a model. Model-level wins over provider-level.
 * Returns null if the model is not service-tier-capable.
 */
function resolveModelEntry(
	config: ResolvedConfig,
	provider: string,
	id: string,
): ResolvedEntry | null {
	const mKey = modelKey(provider, id);
	const modelEntry = config.models.get(mKey);
	if (modelEntry) return modelEntry;
	const providerEntry = config.providers.get(provider);
	if (providerEntry) return providerEntry;
	return null;
}

interface ActiveResolution {
	/** The tier to actually send. null = send nothing. undefined = no opinion (leave payload untouched). */
	tier: string | null | undefined;
	/** Why — for status display. */
	source: "override" | "default" | "none";
}

/**
 * Resolve the active tier for a model given the config and session overrides.
 *  - explicit session override (string) → send it
 *  - explicit session override null ("off") → send nothing
 *  - config default → send it
 *  - otherwise → no opinion
 */
function resolveActive(
	config: ResolvedConfig,
	overrides: Map<string, string | null>,
	provider: string,
	id: string,
): ActiveResolution {
	const entry = resolveModelEntry(config, provider, id);
	if (!entry) return { tier: undefined, source: "none" };
	const key = modelKey(provider, id);
	if (overrides.has(key)) {
		return { tier: overrides.get(key)!, source: "override" };
	}
	if (entry.default) {
		return { tier: entry.default, source: "default" };
	}
	return { tier: undefined, source: "none" };
}

function isKnownTier(t: string): boolean {
	return (KNOWN_TIERS as readonly string[]).includes(t);
}

interface State {
	config: ResolvedConfig;
	warnings: string[];
	loaded: boolean;
	/** Per-modelKey session override. string = tier; null = explicit "off". */
	overrides: Map<string, string | null>;
}

export default function (pi: ExtensionAPI) {
	const state: State = {
		config: EMPTY_CONFIG,
		warnings: [],
		loaded: false,
		overrides: new Map(),
	};

	const notify = (ctx: ExtensionContext, msg: string, level: "info" | "warning" | "error") => {
		if (ctx.hasUI) ctx.ui.notify(msg, level);
	};

	const reloadConfig = (ctx: ExtensionContext) => {
		const result = loadConfig(ctx);
		state.config = result.config;
		state.warnings = result.warnings;
		state.loaded = true;
	};

	const currentEntry = (ctx: ExtensionContext): { entry: ResolvedEntry | null; provider: string; id: string } | null => {
		const m = ctx.model;
		if (!m) return null;
		return { entry: resolveModelEntry(state.config, m.provider, m.id), provider: m.provider, id: m.id };
	};

	// Reset per-session state and (re)load config on every session start.
	pi.on("session_start", (_event, ctx) => {
		state.overrides = new Map();
		reloadConfig(ctx);
		// Surface malformed-config errors so they aren't silently ignored.
		if (state.warnings.length > 0 && ctx.hasUI) {
			ctx.ui.notify(
				`openai-service-tier: ${state.warnings.length} config warning(s) — run /service-tier status to view.`,
				"warning",
			);
		}
	});

	pi.on("before_provider_request", (event, ctx) => {
		const model = ctx.model;
		if (!model) return;

		// Defensive lazy-load in case session_start hasn't run yet.
		if (!state.loaded) reloadConfig(ctx);

		const { tier } = resolveActive(state.config, state.overrides, model.provider, model.id);
		if (tier === undefined) return; // no opinion → leave payload untouched

		const payload = event.payload;
		if (!payload || typeof payload !== "object") return;

		if (tier === null) {
			// Explicit "off": ensure no service_tier is sent.
			if ("service_tier" in payload) {
				delete (payload as Record<string, unknown>).service_tier;
			}
			return;
		}

		// Set / override the tier.
		(payload as Record<string, unknown>).service_tier = tier;
	});

	const formatStatus = (ctx: ExtensionContext): string => {
		const cur = currentEntry(ctx);
		if (!cur) return "openai-service-tier: no current model.";
		const { entry, provider, id } = cur;
		const key = modelKey(provider, id);
		const active = resolveActive(state.config, state.overrides, provider, id);

		const lines: string[] = [];
		lines.push(`model: ${key}`);
		if (!entry) {
			lines.push("service-tier: NOT configured for this model.");
			lines.push("  (add an entry under providers or models in openai-service-tier.json)");
			if (state.warnings.length > 0) {
				lines.push("", "config warnings:");
				for (const w of state.warnings) lines.push(`  - ${w}`);
			}
			return lines.join("\n");
		}
		lines.push(`capable: yes`);
		lines.push(`default: ${entry.default ?? "(none)"}`);
		lines.push(`allowed: ${entry.allowed ? entry.allowed.join(", ") : "(any)"}`);
		const activeLabel =
			active.source === "override"
				? active.tier === null
					? "off (explicitly disabled)"
					: `${active.tier} (session override)`
				: active.source === "default"
					? `${active.tier} (config default)`
					: "(none — no service_tier sent)";
		lines.push(`active: ${activeLabel}`);
		const ov = state.overrides.has(key) ? state.overrides.get(key) : undefined;
		lines.push(`override: ${ov === undefined ? "(none — using default)" : ov === null ? "off" : ov}`);
		if (state.warnings.length > 0) {
			lines.push("", "config warnings:");
			for (const w of state.warnings) lines.push(`  - ${w}`);
		}
		return lines.join("\n");
	};

	const setOverride = (
		ctx: ExtensionContext,
		provider: string,
		id: string,
		tier: string | null,
	) => {
		state.overrides.set(modelKey(provider, id), tier);
	};

	pi.registerCommand("service-tier", {
		description: "OpenAI service_tier: [<tier>|off|on|reset|list|status]",
		getArgumentCompletions: (prefix: string): AutocompleteItem[] | null => {
			const items: AutocompleteItem[] = [];
			// Reserved subcommands first.
			for (const w of ["status", "list", "off", "on", "reset"]) {
				items.push({ value: w, label: w });
			}
			// Allowed tiers for the current model (if capable) — but note
			// getArgumentCompletions has no ctx, so we can only offer known tiers.
			for (const t of KNOWN_TIERS) {
				items.push({ value: t, label: t });
			}
			const filtered = items.filter((i) => i.value.startsWith(prefix));
			return filtered.length > 0 ? filtered : null;
		},
		handler: async (args, ctx) => {
			reloadConfig(ctx);

			const arg = args.trim();
			const cur = currentEntry(ctx);

			// No-arg / status
			if (arg === "" || arg === "status") {
				notify(ctx, formatStatus(ctx), "info");
				return;
			}

			const sub = arg.toLowerCase();

			// list
			if (sub === "list") {
				if (!cur?.entry) {
					notify(ctx, formatStatus(ctx), "warning");
					return;
				}
				const allowed = cur.entry.allowed ?? [...KNOWN_TIERS];
				notify(ctx, `Allowed tiers for ${modelKey(cur.provider, cur.id)}: ${allowed.join(", ")}`, "info");
				return;
			}

			// off / on / reset
			if (sub === "off" || sub === "on" || sub === "reset") {
				if (!cur?.entry) {
					notify(
						ctx,
						`openai-service-tier: ${modelKey(cur?.provider ?? "?", cur?.id ?? "?")} is not configured as service-tier-capable. Switching is not supported.\n${formatStatus(ctx)}`,
						"warning",
					);
					return;
				}
				if (sub === "off") {
					setOverride(ctx, cur.provider, cur.id, null);
					notify(ctx, `service-tier: OFF for ${modelKey(cur.provider, cur.id)} (no service_tier sent)`, "info");
				} else {
					// on / reset → clear override, fall back to config default
					state.overrides.delete(modelKey(cur.provider, cur.id));
					const active = resolveActive(state.config, state.overrides, cur.provider, cur.id);
					const label =
						active.source === "default"
							? `${active.tier} (default)`
							: "(no default — no service_tier sent)";
					notify(ctx, `service-tier: reset for ${modelKey(cur.provider, cur.id)} → ${label}`, "info");
				}
				return;
			}

			// Otherwise: treat arg as a tier value to set.
			if (!cur?.entry) {
				notify(
					ctx,
					`openai-service-tier: ${modelKey(cur?.provider ?? "?", cur?.id ?? "?")} is not configured as service-tier-capable. Switching is not supported.\n${formatStatus(ctx)}`,
					"warning",
				);
				return;
			}

			const tier = arg; // preserve original casing for the value
			if (RESERVED.has(tier.toLowerCase())) {
				notify(ctx, `service-tier: "${tier}" is a reserved word; use a real tier name.`, "warning");
				return;
			}
			if (cur.entry.allowed && !cur.entry.allowed.includes(tier)) {
				notify(
					ctx,
					`service-tier: "${tier}" is not in the allowed list for ${modelKey(cur.provider, cur.id)}.\nAllowed: ${cur.entry.allowed.join(", ")}\n(Adjust "allowed" in openai-service-tier.json to permit it.)`,
					"warning",
				);
				return;
			}
			if (!cur.entry.allowed && !isKnownTier(tier)) {
				notify(
					ctx,
					`service-tier: warning — "${tier}" is not a known OpenAI tier (${KNOWN_TIERS.join(", ")}). Sending anyway (no "allowed" restriction configured).`,
					"warning",
				);
			}
			setOverride(ctx, cur.provider, cur.id, tier);
			notify(ctx, `service-tier: set to "${tier}" for ${modelKey(cur.provider, cur.id)} (session override)`, "info");
		},
	});
}
