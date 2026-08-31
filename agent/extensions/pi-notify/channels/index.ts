/**
 * pi-notify — channel registry.
 *
 * Extension point #2 (after triggers): push channels. Every channel type
 * registers a factory here; `createChannel` maps a config entry to a live
 * `Channel` instance. v0.1 registers only `webhook`; future versions add
 * `wechat`, `qq`, `system-notification`, `macos-notification`, ... by
 * dropping a file into `src/channels/` and calling `registerChannel` here.
 *
 * Unknown types in config.json are reported as warnings, never a crash.
 */

import type { Channel, ChannelConfig } from "../types.ts";
import { createWebhookChannel } from "./webhook.ts";

export type ChannelFactory = (config: ChannelConfig) => Channel;

const registry = new Map<string, ChannelFactory>();

export function registerChannel(type: string, factory: ChannelFactory): void {
	registry.set(type, factory);
}

export function knownChannelTypes(): string[] {
	return [...registry.keys()];
}

/** Build a channel instance for a config entry, or undefined if unsupported. */
export function createChannel(config: ChannelConfig): Channel | undefined {
	const factory = registry.get(config.type);
	return factory ? factory(config) : undefined;
}

/** Human-readable label for logs and `/notify status`. */
export function channelName(config: ChannelConfig, index: number): string {
	const name = typeof config.name === "string" && config.name.trim()
		? config.name.trim()
		: "";
	const base = name ? `${name} (${config.type}#${index + 1})` : `${config.type}#${index + 1}`;
	const enabled = config.enabled === false ? "off" : "on";
	return `${base} [${enabled}]`;
}

// ---- built-in channels -------------------------------------------------

registerChannel("webhook", (config) => createWebhookChannel(config));
