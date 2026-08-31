/**
 * pi-notify — payload building and dispatch.
 *
 * Rules that matter:
 *  - one attempt per channel, no built-in retry (retry policy stays visible to
 *    the user instead of being buried in the plugin);
 *  - channels are independent (`Promise.all` over per-channel try/catch), one
 *    broken webhook can never block the others;
 *  - nothing here ever throws into pi's event loop;
 *  - "fire" is non-blocking so the TUI never waits on the network, while
 *    `flush()` lets the shutdown path drain in-flight sends before exit.
 */

import { appendFileSync, renameSync, statSync } from "node:fs";
import { hostname } from "node:os";
import { basename } from "node:path";
import { channelName, createChannel } from "./channels/index.ts";
import { logPath } from "./config.ts";
import { formatDuration, render } from "./render.ts";
import type {
	ChannelConfig,
	ChannelResult,
	NotifyConfig,
	NotifyEvent,
	NotifyPayload,
	PayloadInput,
} from "./types.ts";

const LOG_ROTATE_BYTES = 256 * 1024;

export function buildPayload(config: NotifyConfig, input: PayloadInput): NotifyPayload {
	const now = new Date();
	const cwd = input.cwd ?? process.cwd();
	const vars: Record<string, string> = {
		event: input.event,
		status: input.status,
		reason: input.reason,
		cwd,
		project: basename(cwd) || cwd,
		duration: input.durationMs === undefined ? "" : formatDuration(input.durationMs),
		session: input.session ?? "",
		model: input.model ?? "",
		host: hostname(),
		time: now.toTimeString().slice(0, 8),
		date: now.toISOString().slice(0, 10),
	};

	const title = render(config.titleTemplate, vars).trim() || "pi";
	let text = render(config.template, vars).trim() || title;
	if (text.length > config.maxTextChars) text = `${text.slice(0, config.maxTextChars - 1)}…`;

	// Exposed to webhook body templates; defined after rendering to avoid recursion.
	vars.title = title;
	vars.text = text;

	return { event: input.event, status: input.status, reason: input.reason, title, text, vars };
}

interface Target {
	channel: ChannelConfig;
	name: string;
}

export function resolveTargets(config: NotifyConfig, event: NotifyEvent): Target[] {
	const targets: Target[] = [];
	config.channels.forEach((channel, index) => {
		if (channel.enabled === false) return;
		if (event !== "test") {
			const override = channel.events?.[event];
			const allowed = override ?? config.events[event] ?? false;
			if (!allowed) return;
		}
		targets.push({ channel, name: channelName(channel, index) });
	});
	return targets;
}

function writeLog(config: NotifyConfig, line: string): void {
	const path = logPath();
	try {
		const stat = statSync(path, { throwIfNoEntry: false });
		if (stat && stat.size > LOG_ROTATE_BYTES) renameSync(path, `${path}.1`);
	} catch {
		// rotation is best-effort
	}
	try {
		appendFileSync(path, `${new Date().toISOString()} ${line}\n`, "utf-8");
	} catch {
		// never let logging break a notification
	}
	void config;
}

function capPromise<T>(promise: Promise<T>, ms: number, fallback: T): Promise<T> {
	return Promise.race([
		promise,
		new Promise<T>((resolve) => {
			const timer = setTimeout(() => resolve(fallback), ms);
			// Do not hold the event loop open while pi is exiting.
			(timer as { unref?: () => void }).unref?.();
		}),
	]);
}

export interface Notifier {
	/** Non-blocking send; failures are logged, never thrown. */
	fire(config: NotifyConfig, input: PayloadInput): void;
	/** Awaited send with a hard cap — used on the shutdown path. */
	fireBlocking(config: NotifyConfig, input: PayloadInput, capMs: number): Promise<ChannelResult[]>;
	/** Ignores event switches and pushes to every enabled channel. */
	sendTest(config: NotifyConfig, input: PayloadInput): Promise<ChannelResult[]>;
	/** Wait for in-flight sends (bounded). */
	flush(capMs: number): Promise<void>;
	lastResults(): { at: number; event: NotifyEvent; results: ChannelResult[] } | undefined;
}

export function createNotifier(): Notifier {
	const inflight = new Set<Promise<unknown>>();
	let lastKey = "";
	let lastAt = 0;
	let last: { at: number; event: NotifyEvent; results: ChannelResult[] } | undefined;

	async function dispatch(
		config: NotifyConfig,
		payload: NotifyPayload,
		targets: Target[],
	): Promise<ChannelResult[]> {
		const results = await Promise.all(
			targets.map(async ({ channel, name }) => {
				const instance = createChannel(channel);
				if (!instance) {
					return {
						channel: name,
						ok: false,
						status: 0,
						error: `未注册的渠道类型 ${channel.type}`,
						ms: 0,
					} satisfies ChannelResult;
				}
				try {
					const result = await instance.send(
						payload,
						channel.timeoutMs ?? config.timeoutMs,
					);
					return {
						channel: name,
						ok: result.ok,
						status: result.status,
						error: result.error,
						ms: result.ms,
					} satisfies ChannelResult;
				} catch (error) {
					return {
						channel: name,
						ok: false,
						status: 0,
						error: error instanceof Error ? error.message : String(error),
						ms: 0,
					} satisfies ChannelResult;
				}
			}),
		);

		last = { at: Date.now(), event: payload.event, results };
		for (const result of results) {
			if (result.ok && !config.debug) continue;
			const verdict = result.ok ? "ok" : "FAIL";
			const detail = result.ok ? `status=${result.status}` : (result.error ?? "unknown");
			writeLog(config, `[${payload.event}] ${result.channel} ${verdict} ${detail} (${result.ms}ms)`);
		}
		return results;
	}

	function prepare(
		config: NotifyConfig,
		input: PayloadInput,
		ignoreSwitches: boolean,
	): { payload: NotifyPayload; targets: Target[] } | undefined {
		if (!config.enabled) return undefined;
		const targets = resolveTargets(config, ignoreSwitches ? "test" : input.event);
		if (targets.length === 0) return undefined;

		const payload = buildPayload(config, input);
		if (!ignoreSwitches && config.dedupeMs > 0) {
			const key = `${payload.event}|${payload.text}`;
			const now = Date.now();
			if (key === lastKey && now - lastAt < config.dedupeMs) return undefined;
			lastKey = key;
			lastAt = now;
		}
		return { payload, targets };
	}

	function track<T>(promise: Promise<T>): Promise<T> {
		const tracked = promise.finally(() => {
			inflight.delete(tracked);
		});
		inflight.add(tracked);
		return tracked;
	}

	return {
		fire(config, input) {
			const prepared = prepare(config, input, false);
			if (!prepared) return;
			void track(
				dispatch(config, prepared.payload, prepared.targets).catch(() => [] as ChannelResult[]),
			);
		},

		async fireBlocking(config, input, capMs) {
			const prepared = prepare(config, input, false);
			if (!prepared) return [];
			const run = track(
				dispatch(config, prepared.payload, prepared.targets).catch(() => [] as ChannelResult[]),
			);
			return capPromise(run, capMs, []);
		},

		async sendTest(config, input) {
			const prepared = prepare(config, input, true);
			if (!prepared) return [];
			return track(
				dispatch(config, prepared.payload, prepared.targets).catch(() => [] as ChannelResult[]),
			);
		},

		async flush(capMs) {
			if (inflight.size === 0) return;
			await capPromise(Promise.allSettled([...inflight]).then(() => undefined), capMs, undefined);
		},

		lastResults() {
			return last;
		},
	};
}
