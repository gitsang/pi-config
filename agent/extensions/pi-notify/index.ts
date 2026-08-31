/**
 * pi-notify — entry point.
 *
 * A pi extension that pushes a notification when the agent finishes a task.
 * v0.1 scope: one trigger (`task-complete`), one channel (custom webhook with
 * url/body templates). The trigger and channel registries make it trivial to
 * add more timings and push targets in later versions.
 *
 *   /notify status | test | on | off | help
 *
 * Config: `$PI_NOTIFY_CONFIG`, else `config.json` next to this extension.
 * See config.example.json.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { invalidateConfigCache, loadConfig } from "./config.ts";
import { ALL_TRIGGERS } from "./events/index.ts";
import { createNotifier, type Notifier } from "./notify.ts";
import type { ChannelResult, NotifyConfig, PayloadInput } from "./types.ts";

function describeResults(results: ChannelResult[]): string {
	if (results.length === 0) return "没有匹配的渠道";
	return results
		.map((r) =>
			r.ok
				? `${r.channel} ok(${r.status}, ${r.ms}ms)`
				: `${r.channel} 失败(${r.error ?? "unknown"})`,
		)
		.join("; ");
}

export default function piNotify(pi: ExtensionAPI) {
	const notifier: Notifier = createNotifier();
	let runtimeEnabled = true;

	/** Config for the current context, or undefined when this run must stay quiet. */
	function activeConfig(mode: string): NotifyConfig | undefined {
		if (!runtimeEnabled) return undefined;
		const config = loadConfig();
		if (!config.enabled || !config.exists) return undefined;
		// Subagents run `pi --mode json -p`; pushing for each of those is noise.
		if (!config.modes.includes(mode)) return undefined;
		return config;
	}

	/** Fire-and-forget dispatch used by every trigger. */
	function dispatch(input: PayloadInput, mode: string): void {
		const config = activeConfig(mode);
		if (!config) return;

		// Short runs are usually the user still sitting at the keyboard.
		if (input.durationMs !== undefined && input.durationMs < config.minDurationSec * 1000) {
			return;
		}

		notifier.fire(config, input);
	}

	// ---- wire up triggers --------------------------------------------------

	for (const trigger of ALL_TRIGGERS) {
		trigger.bind(pi, dispatch);
	}

	// ---- lifecycle -----------------------------------------------------------

	pi.on("session_start", async () => {
		invalidateConfigCache();
	});

	pi.on("session_shutdown", async () => {
		// Drain in-flight sends before pi exits. Critical in print/rpc mode where
		// the process tears down right after the last agent_settled; without this
		// the fire-and-forget webhook request may never leave the process.
		await notifier.flush(2000);
	});

	// ---- commands ------------------------------------------------------------

	pi.registerCommand("notify", {
		description: "pi-notify: status|test|on|off|help",
		handler: async (args, ctx) => {
			const command = (args ?? "").trim().split(/\s+/)[0] ?? "";

			switch (command) {
				case "test": {
					invalidateConfigCache();
					const config = loadConfig();
					if (!config.exists && config.channels.length === 0) {
						ctx.ui.notify(`未找到配置文件：${config.path}`, "error");
						return;
					}
					const results = await notifier.sendTest(
						{ ...config, enabled: true },
						{
							event: "test",
							status: "测试",
							reason: "pi-notify 渠道测试",
							cwd: ctx.cwd,
							session: ctx.sessionManager.getSessionName() ?? undefined,
							model: ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : undefined,
						},
					);
					const ok = results.length > 0 && results.every((r) => r.ok);
					ctx.ui.notify(`pi-notify 测试：${describeResults(results)}`, ok ? "info" : "error");
					return;
				}

				case "on":
					runtimeEnabled = true;
					ctx.ui.notify("pi-notify 会话开关：开", "info");
					return;

				case "off":
					runtimeEnabled = false;
					ctx.ui.notify("pi-notify 会话开关：关（仅当前会话，不持久化）", "info");
					return;

				case "help":
					ctx.ui.notify(
						"pi-notify: /notify status | test | on | off | help",
						"info",
					);
					return;

				case "status":
				case "":
				default: {
					invalidateConfigCache();
					const config = loadConfig();
					const last = notifier.lastResults();

					const lines: string[] = [];
					lines.push(`开关: ${runtimeEnabled ? "on" : "off(会话级)"} · 配置: ${config.path}`);
					if (!config.exists) lines.push("配置不存在：请复制 config.example.json 到该路径");
					if (config.warnings.length > 0) {
						for (const warning of config.warnings) lines.push(`警告: ${warning}`);
					}
					lines.push(
						`渠道: ${config.channels.length > 0
							? config.channels
								.map(
									(c, i) =>
										`${c.type}#${i + 1}${c.name ? `(${c.name})` : ""}${
											c.enabled === false ? "[off]" : ""
										}`,
								)
								.join(", ")
							: "无"}`,
					);
					if (last) {
						lines.push(
							`上次推送: ${new Date(last.at).toLocaleTimeString()} [${last.event}] ${describeResults(last.results)}`,
						);
					} else {
						lines.push("上次推送: 无");
					}
					ctx.ui.notify(lines.join("\n"), "info");
					return;
				}
			}
		},
	});
}
