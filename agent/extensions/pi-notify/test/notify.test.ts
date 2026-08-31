/**
 * pi-notify — unit tests.
 *
 * Run with: node --test test/
 * Node >= 22.6 with --experimental-strip-types, or >= 23.6 by default.
 */

import { strict as assert } from "node:assert";
import { after, before, test } from "node:test";

import { formatDuration, render, renderDeep, summarizeError } from "../render.ts";
import { createWebhookChannel } from "../channels/webhook.ts";
import { buildPayload, resolveTargets } from "../notify.ts";
import { defaultConfig, loadConfig } from "../config.ts";
import type { NotifyConfig, PayloadInput } from "../types.ts";

// ---- render --------------------------------------------------------------

test("render: replaces known placeholders", () => {
	assert.equal(render("hello {{name}}", { name: "world" }), "hello world");
});

test("render: unknown placeholders collapse to empty string", () => {
	assert.equal(render("a{{missing}}b", { name: "world" }), "ab");
});

test("render: whitespace inside braces is tolerated", () => {
	assert.equal(render("{{ name }}", { name: "x" }), "x");
});

test("render: url mode percent-encodes values", () => {
	const out = render("https://h/p?q={{q}}", { q: "a b&c" }, "url");
	assert.equal(out, "https://h/p?q=a%20b%26c");
});

test("render: json mode escapes quotes and newlines", () => {
	const out = render('{"t":"{{t}}"}', { t: 'say "hi"\nbye' }, "json");
	assert.equal(JSON.parse(out).t, 'say "hi"\nbye');
});

test("renderDeep: recurses through objects and arrays", () => {
	const out = renderDeep(
		{ a: "{{x}}", nested: { b: ["{{y}}", 1, null] } },
		{ x: "X", y: "Y" },
	);
	assert.deepEqual(out, { a: "X", nested: { b: ["Y", 1, null] } });
});

test("formatDuration", () => {
	assert.equal(formatDuration(0), "0s");
	assert.equal(formatDuration(12_000), "12s");
	assert.equal(formatDuration(192_000), "3m12s");
	assert.equal(formatDuration(3_600_000), "1h");
	assert.equal(formatDuration(3_672_000), "1h1m");
});

test("summarizeError: extracts provider error detail", () => {
	const raw =
		'401 {"type":"error","error":{"type":"authentication_error","message":"invalid x-api-key"}}';
	assert.equal(summarizeError(raw, 200), "401 authentication_error: invalid x-api-key");
});

test("summarizeError: plain text falls back to first line", () => {
	assert.equal(summarizeError("boom\nsecond line", 200), "boom");
});

// ---- payload -------------------------------------------------------------

const baseInput: PayloadInput = {
	event: "task-complete",
	status: "已完成",
	reason: "输出结束，等待输入",
	cwd: "/tmp/my-project",
	durationMs: 192_000,
	session: "fix-bug",
	model: "anthropic/claude-sonnet-4-5",
};

test("buildPayload: exposes all template variables", () => {
	const config = defaultConfig("/tmp/none.json");
	const payload = buildPayload(config, baseInput);
	assert.equal(payload.event, "task-complete");
	assert.equal(payload.vars.event, "task-complete");
	assert.equal(payload.vars.status, "已完成");
	assert.equal(payload.vars.project, "my-project");
	assert.equal(payload.vars.duration, "3m12s");
	assert.equal(payload.vars.session, "fix-bug");
	assert.equal(payload.vars.model, "anthropic/claude-sonnet-4-5");
	assert.ok(payload.vars.host.length > 0);
	assert.ok(payload.vars.time.length > 0);
	assert.ok(payload.vars.date.length > 0);
	assert.equal(payload.title, "pi 已完成");
	assert.equal(payload.text, "pi 已完成 · 输出结束，等待输入");
});

test("buildPayload: truncates text to maxTextChars", () => {
	const config = defaultConfig("/tmp/none.json");
	config.maxTextChars = 20;
	const payload = buildPayload(config, { ...baseInput, reason: "很长的原因".repeat(20) });
	assert.ok(payload.text.length <= 20);
	assert.ok(payload.text.endsWith("…"));
});

// ---- target resolution ---------------------------------------------------

function configWith(channels: NotifyConfig["channels"]): NotifyConfig {
	const config = defaultConfig("/tmp/none.json");
	config.channels = channels;
	return config;
}

test("resolveTargets: honours global event toggle", () => {
	const config = configWith([{ type: "webhook", url: "https://h" }]);
	config.events = { "task-complete": true };
	assert.equal(resolveTargets(config, "task-complete").length, 1);
	assert.equal(resolveTargets(config, "task-start").length, 0); // future event, off by default
});

test("resolveTargets: channel-level override wins", () => {
	const config = configWith([
		{ type: "webhook", url: "https://h", events: { "task-complete": false } },
	]);
	config.events = { "task-complete": true };
	assert.equal(resolveTargets(config, "task-complete").length, 0);
});

test("resolveTargets: disabled channel is skipped", () => {
	const config = configWith([
		{ type: "webhook", url: "https://h", enabled: false },
	]);
	config.events = { "task-complete": true };
	assert.equal(resolveTargets(config, "task-complete").length, 0);
});

test("resolveTargets: test event bypasses event toggles", () => {
	const config = configWith([{ type: "webhook", url: "https://h" }]);
	config.events = { "task-complete": false };
	assert.equal(resolveTargets(config, "test").length, 1);
	assert.equal(resolveTargets(config, "task-complete").length, 0);
});

// ---- webhook end-to-end --------------------------------------------------

import { createServer, type Server } from "node:http";
import { once } from "node:events";

let server: Server;
let received: Array<{
	method: string;
	url: string;
	headers: Record<string, string | string[] | undefined>;
	body: string;
}> = [];

before(async () => {
	server = createServer((req, res) => {
		let body = "";
		req.on("data", (chunk) => {
			body += chunk;
		});
		req.on("end", () => {
			received.push({ method: req.method ?? "", url: req.url ?? "", headers: req.headers, body });
			res.writeHead(200, { "Content-Type": "text/plain" });
			res.end("ok");
		});
	});
	server.listen(0, "127.0.0.1");
	await once(server, "listening");
});

after(() => {
	server.close();
});

function endpoint(): string {
	const address = server.address();
	assert.ok(address && typeof address !== "string");
	return `http://127.0.0.1:${address.port}`;
}

test("webhook: object body template renders and arrives", async () => {
	const url = `${endpoint()}/hook?project={{project}}`;
	const channel = createWebhookChannel({
		type: "webhook",
		url,
		// ${ENV} expansion is the config layer's job (see loadConfig test);
		// the channel itself renders {{placeholders}} only.
		headers: { Authorization: "Bearer sekrit" },
		body: {
			event: "{{event}}",
			text: "{{text}}",
			meta: { project: "{{project}}" },
		},
	});
	const config = defaultConfig("/tmp/none.json");
	const payload = buildPayload(config, baseInput);
	const result = await channel.send(payload, 5000);

	assert.equal(result.ok, true);
	assert.equal(result.status, 200);

	const req = received.at(-1);
	assert.ok(req);
	assert.equal(req.method, "POST");
	assert.equal(req.url, `/hook?project=my-project`);
	assert.equal(req.headers.authorization, "Bearer sekrit");
	assert.match(req.headers["content-type"] ?? "", /application\/json/);
	const body = JSON.parse(req.body);
	assert.equal(body.event, "task-complete");
	assert.equal(body.text, "pi 已完成 · 输出结束，等待输入");
	assert.deepEqual(body.meta, { project: "my-project" });
});

test("webhook: default body envelope contains every variable", async () => {
	const channel = createWebhookChannel({ type: "webhook", url: `${endpoint()}/envelope` });
	const config = defaultConfig("/tmp/none.json");
	const result = await channel.send(buildPayload(config, baseInput), 5000);
	assert.equal(result.ok, true);
	const body = JSON.parse(received.at(-1)!.body);
	assert.equal(body.event, "task-complete");
	assert.equal(body.project, "my-project");
	assert.equal(body.duration, "3m12s");
});

test("webhook: string body is json-escaped per contentType", async () => {
	const channel = createWebhookChannel({
		type: "webhook",
		url: `${endpoint()}/string`,
		body: '{"msg":"{{text}}"}',
	});
	const config = defaultConfig("/tmp/none.json");
	const payload = buildPayload(config, {
		...baseInput,
		status: '含"引号"',
		reason: "第一行\n第二行",
	});
	const result = await channel.send(payload, 5000);
	assert.equal(result.ok, true);
	const body = JSON.parse(received.at(-1)!.body);
	assert.equal(body.msg, 'pi 含"引号" · 第一行\n第二行');
});

test("webhook: GET sends no body but encodes url", async () => {
	const channel = createWebhookChannel({
		type: "webhook",
		url: `${endpoint()}/get?q={{project}}`,
		method: "GET",
	});
	const config = defaultConfig("/tmp/none.json");
	const result = await channel.send(buildPayload(config, baseInput), 5000);
	assert.equal(result.ok, true);
	const req = received.at(-1)!;
	assert.equal(req.method, "GET");
	assert.equal(req.body, "");
	assert.equal(req.url, "/get?q=my-project");
});

test("webhook: missing url is a local failure, not a crash", async () => {
	const channel = createWebhookChannel({ type: "webhook", url: "  " });
	const config = defaultConfig("/tmp/none.json");
	const result = await channel.send(buildPayload(config, baseInput), 5000);
	assert.equal(result.ok, false);
	assert.match(result.error ?? "", /url/);
});

test("webhook: connection failure returns error result", async () => {
	const channel = createWebhookChannel({
		type: "webhook",
		url: "http://127.0.0.1:1/nope", // nothing listens on port 1
	});
	const config = defaultConfig("/tmp/none.json");
	const result = await channel.send(buildPayload(config, baseInput), 1000);
	assert.equal(result.ok, false);
	assert.ok(result.error && result.error.length > 0);
});

// ---- config --------------------------------------------------------------

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { invalidateConfigCache } from "../config.ts";

test("loadConfig: parses file and expands env refs", () => {
	const dir = mkdtempSync(join(tmpdir(), "pi-notify-"));
	const oldEnv = process.env.PI_NOTIFY_CONFIG;
	process.env.NOTIFY_TOKEN = "tok123";
	process.env.PI_NOTIFY_CONFIG = join(dir, "config.json");
	writeFileSync(
		process.env.PI_NOTIFY_CONFIG,
		JSON.stringify({
			enabled: true,
			channels: [
				{ type: "webhook", url: "https://h", headers: { Authorization: "Bearer ${NOTIFY_TOKEN}" } },
			],
		}),
	);

	try {
		const config = loadConfig();
		assert.equal(config.exists, true);
		assert.equal(config.channels.length, 1);
		const webhook = config.channels[0];
		assert.equal(webhook.headers?.Authorization, "Bearer tok123");
	} finally {
		process.env.PI_NOTIFY_CONFIG = oldEnv;
		delete process.env.NOTIFY_TOKEN;
		invalidateConfigCache();
		rmSync(dir, { recursive: true, force: true });
	}
});

test("loadConfig: env.json (next to config) wins over process env", () => {
	const dir = mkdtempSync(join(tmpdir(), "pi-notify-"));
	const oldEnv = process.env.PI_NOTIFY_CONFIG;
	process.env.NOTIFY_TOKEN = "from-process-env";
	process.env.PI_NOTIFY_CONFIG = join(dir, "config.json");
	writeFileSync(
		process.env.PI_NOTIFY_CONFIG,
		JSON.stringify({
			channels: [{ type: "webhook", url: "https://h/t/${NOTIFY_TOKEN}" }],
		}),
	);
	writeFileSync(
		join(dir, "env.json"),
		JSON.stringify({ NOTIFY_TOKEN: "from-env-json", EXTRA: 42 }),
	);

	try {
		const config = loadConfig();
		assert.equal(config.channels[0].url, "https://h/t/from-env-json");
	} finally {
		process.env.PI_NOTIFY_CONFIG = oldEnv;
		delete process.env.NOTIFY_TOKEN;
		invalidateConfigCache();
		rmSync(dir, { recursive: true, force: true });
	}
});

test("loadConfig: missing env.json falls back to process env", () => {
	const dir = mkdtempSync(join(tmpdir(), "pi-notify-"));
	const oldEnv = process.env.PI_NOTIFY_CONFIG;
	process.env.NOTIFY_TOKEN = "from-process-env";
	process.env.PI_NOTIFY_CONFIG = join(dir, "config.json");
	writeFileSync(
		process.env.PI_NOTIFY_CONFIG,
		JSON.stringify({
			channels: [{ type: "webhook", url: "https://h/t/${NOTIFY_TOKEN}" }],
		}),
	);

	try {
		const config = loadConfig();
		assert.equal(config.channels[0].url, "https://h/t/from-process-env");
	} finally {
		process.env.PI_NOTIFY_CONFIG = oldEnv;
		delete process.env.NOTIFY_TOKEN;
		invalidateConfigCache();
		rmSync(dir, { recursive: true, force: true });
	}
});

test("loadConfig: broken env.json does not break config loading", () => {
	const dir = mkdtempSync(join(tmpdir(), "pi-notify-"));
	const oldEnv = process.env.PI_NOTIFY_CONFIG;
	process.env.NOTIFY_TOKEN = "from-process-env";
	process.env.PI_NOTIFY_CONFIG = join(dir, "config.json");
	writeFileSync(
		process.env.PI_NOTIFY_CONFIG,
		JSON.stringify({
			channels: [{ type: "webhook", url: "https://h/t/${NOTIFY_TOKEN}" }],
		}),
	);
	writeFileSync(join(dir, "env.json"), "{not-valid-json");

	try {
		const config = loadConfig();
		assert.equal(config.channels[0].url, "https://h/t/from-process-env");
	} finally {
		process.env.PI_NOTIFY_CONFIG = oldEnv;
		delete process.env.NOTIFY_TOKEN;
		invalidateConfigCache();
		rmSync(dir, { recursive: true, force: true });
	}
});

test("loadConfig: unknown channel type produces warning, not crash", () => {
	const dir = mkdtempSync(join(tmpdir(), "pi-notify-"));
	const oldEnv = process.env.PI_NOTIFY_CONFIG;
	process.env.PI_NOTIFY_CONFIG = join(dir, "config.json");
	writeFileSync(
		process.env.PI_NOTIFY_CONFIG,
		JSON.stringify({
			channels: [
				{ type: "wechat", url: "https://h" }, // not implemented yet
				{ type: "webhook", url: "https://h" },
			],
		}),
	);

	try {
		const config = loadConfig();
		assert.equal(config.channels.length, 1);
		assert.equal(config.channels[0].type, "webhook");
		assert.ok(config.warnings.some((w) => w.includes("wechat")));
	} finally {
		process.env.PI_NOTIFY_CONFIG = oldEnv;
		invalidateConfigCache();
		rmSync(dir, { recursive: true, force: true });
	}
});

test("loadConfig: missing file is quiet (not an error)", () => {
	const oldEnv = process.env.PI_NOTIFY_CONFIG;
	process.env.PI_NOTIFY_CONFIG = "/nonexistent/pi-notify/config.json";
	try {
		const config = loadConfig();
		assert.equal(config.exists, false);
		assert.equal(config.enabled, true);
		assert.equal(config.channels.length, 0);
	} finally {
		process.env.PI_NOTIFY_CONFIG = oldEnv;
		invalidateConfigCache();
	}
});
