/**
 * pi-notify — generic webhook channel.
 *
 * The only channel in v0.1. Everything about the request is configurable:
 * url, method, headers and body. Both url and body are templates that receive
 * the notification variables, e.g.:
 *
 *   url:   "https://example.com/hook?project={{project}}"
 *   body:  { "text": "{{text}}", "meta": { "event": "{{event}}" } }
 *
 * `body` as an object is the recommended form: placeholders are substituted
 * into the parsed structure and the result is serialised afterwards, so a
 * quote or newline inside an error message can never break the JSON. A string
 * `body` is still supported and gets escaped according to `contentType`.
 */

import { httpRequest, localFailure, type HttpResult } from "../http.ts";
import { render, renderDeep } from "../render.ts";
import type { Channel, NotifyPayload, WebhookChannel } from "../types.ts";

const DEFAULT_CONTENT_TYPE = "application/json; charset=utf-8";

function defaultBody(payload: NotifyPayload): unknown {
	return {
		event: payload.event,
		status: payload.status,
		reason: payload.reason,
		title: payload.title,
		text: payload.text,
		...payload.vars,
	};
}

export function sendWebhook(
	channel: WebhookChannel,
	payload: NotifyPayload,
	timeoutMs: number,
): Promise<HttpResult> {
	const rawUrl = (channel.url ?? "").trim();
	if (!rawUrl) return Promise.resolve(localFailure("webhook: url 为空"));

	const vars = payload.vars;
	// URL placeholders are percent-encoded so values survive query strings.
	const url = render(rawUrl, vars, "url");
	const method = (channel.method ?? "POST").toUpperCase();
	const contentType = channel.contentType ?? DEFAULT_CONTENT_TYPE;
	const isJson = contentType.toLowerCase().includes("json");

	const headers: Record<string, string> = {};
	for (const [key, value] of Object.entries(channel.headers ?? {})) {
		if (typeof value === "string") headers[key] = render(value, vars);
	}

	let body: string | undefined;
	if (method !== "GET" && method !== "HEAD") {
		if (channel.body === undefined) {
			body = JSON.stringify(defaultBody(payload));
		} else if (typeof channel.body === "string") {
			body = render(channel.body, vars, isJson ? "json" : "none");
		} else {
			body = JSON.stringify(renderDeep(channel.body, vars));
		}
		if (!headers["Content-Type"] && !headers["content-type"]) {
			headers["Content-Type"] = contentType;
		}
	}

	return httpRequest(url, { method, headers, body }, timeoutMs);
}

export function createWebhookChannel(config: WebhookChannel): Channel {
	return {
		type: "webhook",
		send(payload, timeoutMs) {
			return sendWebhook(config, payload, timeoutMs);
		},
	};
}
