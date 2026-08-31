/**
 * pi-notify — `task-complete` trigger.
 *
 * Fires when the agent has finished everything pi is going to do on its own:
 * - normal completion (no more tool calls, no queued follow-ups)
 * - an Esc-abort (stopReason "aborted")
 * - an error after retries are exhausted (stopReason "error")
 *
 * Implemented on top of `agent_settled`, which pi emits from a `finally` block
 * in the agent session — so it fires exactly once per user-visible "pi stopped
 * doing things", after auto-retries and auto-compaction are done.
 *
 * The `status` / `reason` variables let templates distinguish the three cases
 * today; future versions can split them into separate `task-interrupted` /
 * `need-input` events without breaking existing configs.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { PayloadInput } from "../types.ts";
import { summarizeError } from "../render.ts";
import { baseInput, type Trigger, type TriggerContext } from "./index.ts";

const ERROR_REASON_CHARS = 120;

interface RunState {
	startedAt: number;
	stopReason?: string;
	errorMessage?: string;
}

function triggerContext(ctx: ExtensionContext): TriggerContext {
	return {
		cwd: ctx.cwd,
		getSessionName: () => ctx.sessionManager.getSessionName(),
		getSessionFile: () => ctx.sessionManager.getSessionFile(),
		model: ctx.model,
	};
}

export const taskCompleteTrigger: Trigger = {
	event: "task-complete",

	bind(api: ExtensionAPI, dispatch: (input: PayloadInput) => void): void {
		let run: RunState | undefined;

		api.on("session_start", async () => {
			run = undefined;
		});

		api.on("agent_start", async () => {
			run = { startedAt: Date.now() };
		});

		api.on("agent_end", async (event) => {
			if (!run) run = { startedAt: Date.now() };
			for (let i = event.messages.length - 1; i >= 0; i--) {
				const message = event.messages[i];
				if (message.role !== "assistant") continue;
				const assistant = message as { stopReason?: string; errorMessage?: string };
				run.stopReason = assistant.stopReason;
				run.errorMessage = assistant.errorMessage;
				return;
			}
		});

		api.on("agent_settled", async (_event, ctx) => {
			const state = run;
			run = undefined;

			const stopReason = state?.stopReason;
			if (stopReason === "aborted") {
				dispatch(
					baseInput(triggerContext(ctx), {
						event: "task-complete",
						status: "已中断",
						reason: "本轮被取消",
						durationMs: state ? Date.now() - state.startedAt : undefined,
					}),
					ctx.mode,
				);
				return;
			}
			if (stopReason === "error") {
				dispatch(
					baseInput(triggerContext(ctx), {
						event: "task-complete",
						status: "出错",
						reason:
							`运行出错：${summarizeError(state?.errorMessage, ERROR_REASON_CHARS) || "未知错误"}`,
						durationMs: state ? Date.now() - state.startedAt : undefined,
					}),
					ctx.mode,
				);
				return;
			}

			dispatch(
				baseInput(triggerContext(ctx), {
					event: "task-complete",
					status: "已完成",
					reason: "输出结束，等待输入",
					durationMs: state ? Date.now() - state.startedAt : undefined,
				}),
				ctx.mode,
			);
		});
	},
};
