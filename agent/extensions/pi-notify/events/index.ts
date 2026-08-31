/**
 * pi-notify — trigger registry.
 *
 * Extension point #1: notification timings. Each trigger wires pi lifecycle
 * events to a `dispatch` callback with a concrete `PayloadInput`.
 *
 * v0.1 ships `task-complete` (fires on `agent_settled`). Future versions add
 * `task-start`, `task-interrupted`, `need-input`, `session-exit` by dropping a
 * file into `src/events/` and listing it in `ALL_TRIGGERS` below.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { NotifyEvent, PayloadInput } from "../types.ts";

/** What a trigger needs to build a PayloadInput for the notifier. */
export interface TriggerContext {
	cwd: string;
	getSessionName(): string | undefined;
	getSessionFile(): string | undefined;
	model?: { id: string; provider: string };
}

/** Build the base variables shared by every trigger. */
export function baseInput(
	ctx: TriggerContext,
	overrides: Omit<PayloadInput, "cwd" | "session" | "model">,
): PayloadInput {
	const file = ctx.getSessionFile();
	const session =
		ctx.getSessionName() ??
		(file ? file.split("/").pop()?.replace(/\.jsonl?$/, "") : undefined);
	return {
		cwd: ctx.cwd,
		session: session ?? "",
		model: ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : "",
		...overrides,
	};
}

export interface Trigger {
	event: NotifyEvent;
	/**
	 * Subscribe to pi lifecycle events. `dispatch` is fire-and-forget:
	 * it never throws and never blocks the event loop. The second argument
	 * carries the pi run mode ("tui"/"rpc"/"json"/"print") so the dispatcher
	 * can honour the config `modes` filter.
	 */
	bind(api: ExtensionAPI, dispatch: (input: PayloadInput, mode: string) => void): void;
}

import { taskCompleteTrigger } from "./task-complete.ts";

/** All triggers, in registration order. */
export const ALL_TRIGGERS: Trigger[] = [taskCompleteTrigger];
