/**
 * pi-notify — shared types.
 *
 * Kept free of runtime imports so the module can be loaded by jiti (pi) and by
 * plain `node` type-stripping (tests) without any dependency resolution.
 */

/**
 * Notification trigger kinds.
 *
 * v0.1 ships `task-complete` only. The remaining events are declared here so
 * the config schema and template variables stay stable when later versions
 * wire them up (task-start, task-interrupted, need-input, session-exit).
 */
export type NotifyEvent =
	| "task-complete"
	| "task-start"
	| "task-interrupted"
	| "need-input"
	| "session-exit"
	| "test";

/** Per-event on/off switches. Missing keys fall back to the global config. */
export type EventToggles = Partial<Record<NotifyEvent, boolean>>;

/** Common fields every channel config carries. */
export interface BaseChannel {
	/** Channel type id, e.g. "webhook". */
	type: string;
	/** Display name used in logs and `/notify` output. Defaults to `type`. */
	name?: string;
	enabled?: boolean;
	/** Overrides the global `events` switches for this channel only. */
	events?: EventToggles;
	/** Overrides the global `timeoutMs` for this channel only. */
	timeoutMs?: number;
}

/**
 * Generic webhook channel — the only channel in v0.1.
 *
 * `url` is required. `body` supports template placeholders:
 * - object  → each string value is rendered (`{{name}}`), then JSON.stringify
 *             (recommended — quotes/newlines in values can never break JSON)
 * - string  → raw template; values are escaped per `contentType`
 * - omitted → a default JSON envelope with every known variable is sent
 */
export interface WebhookChannel extends BaseChannel {
	type: "webhook";
	url: string;
	/** Defaults to POST. */
	method?: string;
	/** Extra request headers; values may contain `{{name}}` / `${ENV}`. */
	headers?: Record<string, string>;
	/** Request body template. See class doc above. */
	body?: unknown;
	/** Defaults to application/json; charset=utf-8 */
	contentType?: string;
}

/**
 * v0.1 supports only webhook. Future versions add more channel types here
 * (wechat, qq, system-notification, macos-notification, ...). Config files
 * with unknown types produce a warning and are skipped, never a crash.
 */
export type ChannelConfig = WebhookChannel;

/** A channel instance ready to send (registry entry for the config's type). */
export interface Channel {
	/** Matches `ChannelConfig.type`. */
	type: string;
	/**
	 * Send a notification. Must never throw — return a ChannelResult instead.
	 * `timeoutMs` comes from the channel config (or the global default).
	 */
	send(payload: NotifyPayload, timeoutMs: number): Promise<ChannelResult>;
}

export interface NotifyConfig {
	enabled: boolean;
	/** pi run modes that may push. Defaults to ["tui"] — subagents are noise. */
	modes: string[];
	timeoutMs: number;
	/** Identical notifications inside this window are dropped. */
	dedupeMs: number;
	/** `task-complete` pushes are skipped when the run was shorter than this. */
	minDurationSec: number;
	maxTextChars: number;
	titleTemplate: string;
	template: string;
	events: EventToggles;
	/** Whether a `test` payload is allowed to use `modes`. */
	debug: boolean;
	channels: ChannelConfig[];
	/** Populated by the loader; never read from disk. */
	warnings: string[];
	/** Absolute path the config was loaded from (or would be loaded from). */
	path: string;
	/** False when no config file exists yet. */
	exists: boolean;
}

/**
 * What every template sees. `vars` holds the flat string variables;
 * `title` / `text` are rendered from the global templates and re-exposed
 * so a webhook body can reference them without repeating the template.
 */
export interface NotifyPayload {
	event: NotifyEvent;
	status: string;
	reason: string;
	title: string;
	text: string;
	vars: Record<string, string>;
}

export interface ChannelResult {
	channel: string;
	ok: boolean;
	status: number;
	error?: string;
	ms: number;
}

/** Input a trigger hands the notifier. */
export interface PayloadInput {
	event: NotifyEvent;
	status: string;
	reason: string;
	cwd?: string;
	durationMs?: number;
	session?: string;
	model?: string;
}
