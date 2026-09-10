import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import * as path from "node:path";
import test from "node:test";
import * as url from "node:url";
import { SourceTextModule, SyntheticModule } from "node:vm";

// Run with: node --experimental-vm-modules --test index.test.ts
const source = stripTypeScriptTypes(readFileSync(new URL("./index.ts", import.meta.url), "utf8"));
const defaults = { default: "priority", allowed: ["auto", "default", "flex", "priority"] };

async function harness({ id = "gpt-5.4", provider = "custom-gateway", trusted = false,
	global = {}, local = defaults, project = {} } = {}) {
	const files = new Map([
		["/agent/pi-service-tier.json", JSON.stringify(global)],
		["/extension/config.json", JSON.stringify(local)],
		["/project/.pi/pi-service-tier.json", JSON.stringify(project)],
	]);
	const dependencies = {
		"@earendil-works/pi-coding-agent": { CONFIG_DIR_NAME: ".pi", getAgentDir: () => "/agent" },
		"node:fs": { readFileSync: (filename) => {
			if (!files.has(filename)) throw new Error("ENOENT");
			return files.get(filename);
		} },
		"node:path": path,
		"node:url": url,
	};
	const module = new SourceTextModule(source, {
		initializeImportMeta: (meta) => { meta.url = "file:///extension/index.ts"; },
	});
	await module.link((specifier) => {
		const exports = dependencies[specifier];
		assert.ok(exports, `Unexpected dependency: ${specifier}`);
		return new SyntheticModule(Object.keys(exports), function () {
			for (const [key, value] of Object.entries(exports)) this.setExport(key, value);
		});
	});
	await module.evaluate();
	const events = new Map();
	const commands = new Map();
	const statuses = new Map();
	const notices = [];
	const ctx = {
		model: { provider, id }, cwd: "/project", hasUI: true,
		isProjectTrusted: () => trusted,
		ui: { setStatus: (key, value) => statuses.set(key, value),
			notify: (text, level) => notices.push({ text, level }) },
	};
	module.namespace.default({ on: (name, handler) => events.set(name, handler),
		registerCommand: (name, command) => commands.set(name, command) });
	events.get("session_start")({}, ctx);
	return { ctx, events, statuses, notices,
		command: (args) => commands.get("service-tier").handler(args, ctx),
		request: (payload = {}) => {
			events.get("before_provider_request")({ payload }, ctx);
			return payload;
		} };
}

test("injects for GPT IDs regardless of provider", async () => {
	for (const provider of ["openai", "saigw-openai", "custom-gateway", "anthropic"]) {
		const h = await harness({ provider });
		assert.deepEqual(h.request({ model: "gpt-5.4" }), { model: "gpt-5.4", service_tier: "priority" });
		assert.equal(h.statuses.get("service-tier"), "priority");
	}
});

test("leaves nonmatching IDs untouched and rejects tier commands", async () => {
	for (const id of ["claude-sonnet-4-5", "o3", "openai/gpt-5.4", "GPT-5.4", "gpt"]) {
		const h = await harness({ id, provider: "openai" });
		assert.deepEqual(h.request({ service_tier: "existing" }), { service_tier: "existing" });
		assert.equal(h.statuses.get("service-tier"), undefined);
		for (const arg of ["flex", "off", "reset"]) {
			await h.command(arg);
			assert.equal(h.notices.at(-1).level, "warning");
			assert.match(h.notices.at(-1).text, /starting with "gpt-"/);
		}
	}
});

test("validates allowed tiers and preserves off/reset behavior", async () => {
	const h = await harness();
	await h.command("flex");
	assert.equal(h.request().service_tier, "flex");
	await h.command("scale");
	assert.equal(h.notices.at(-1).level, "warning");
	assert.equal(h.request().service_tier, "flex");
	await h.command("off");
	assert.deepEqual(h.request({ service_tier: "priority", other: true }), { other: true });
	assert.equal(h.statuses.get("service-tier"), "off");
	await h.command("reset");
	assert.equal(h.request().service_tier, "priority");
});

test("keeps session overrides scoped per provider/model and clears non-GPT status", async () => {
	const h = await harness();
	await h.command("flex");
	h.ctx.model = { provider: "other", id: "gpt-5.4" };
	assert.equal(h.request().service_tier, "priority");
	h.ctx.model = { provider: "custom-gateway", id: "claude-sonnet-4-5" };
	h.events.get("model_select")({ model: h.ctx.model }, h.ctx);
	assert.equal(h.statuses.get("service-tier"), undefined);
	h.ctx.model.id = "gpt-5.4";
	assert.equal(h.request().service_tier, "flex");
});

test("merges flat config by field and respects project trust", async () => {
	const options = { global: { default: "auto", allowed: ["auto"] },
		local: { default: "priority" }, project: { default: "flex", allowed: ["flex"] } };
	const untrusted = await harness(options);
	assert.equal(untrusted.request().service_tier, "priority");
	await untrusted.command("flex");
	assert.equal(untrusted.notices.at(-1).level, "warning");
	const trusted = await harness({ ...options, trusted: true });
	assert.equal(trusted.request().service_tier, "flex");
	await trusted.command("priority");
	assert.equal(trusted.notices.at(-1).level, "warning");
});

test("handles null and malformed settings without injecting invalid values", async () => {
	const h = await harness({ local: { default: null, allowed: null } });
	assert.deepEqual(h.request({ service_tier: "existing" }), { service_tier: "existing" });
	await h.command("custom-tier");
	assert.equal(h.request().service_tier, "custom-tier");
	const invalid = await harness({ local: { default: 42, allowed: "priority" } });
	assert.deepEqual(invalid.request(), {});
	await invalid.command("status");
	assert.match(invalid.notices.at(-1).text, /"default" must be a string/);
	assert.match(invalid.notices.at(-1).text, /"allowed" must be a string array/);
});
