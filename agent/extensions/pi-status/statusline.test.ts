import assert from "node:assert/strict";
import test from "node:test";
import type { State } from "./aggregate.ts";
import { StatuslineStatusSink } from "./statusline.ts";

interface FakeStore {
	get(pid: number, sessionId?: string): { state: State } | null;
}

test("pulls this process state into ext-status and deduplicates updates", () => {
	let state: State | undefined = "idle";
	const reads: Array<[number, string | undefined]> = [];
	const store: FakeStore = {
		get(pid, sessionId) {
			reads.push([pid, sessionId]);
			return state ? { state } : null;
		},
	};
	const writes: Array<[string, string | undefined]> = [];
	const ui = {
		setStatus(key: string, value: string | undefined) {
			writes.push([key, value]);
		},
	};
	const sink = new StatuslineStatusSink(
		store as never,
		ui as never,
		"pi-status",
		"session-1",
		123,
	);

	sink.sync();
	sink.sync();
	state = "gen";
	sink.sync();
	state = undefined;
	sink.sync();

	assert.deepEqual(reads, [
		[123, "session-1"],
		[123, "session-1"],
		[123, "session-1"],
		[123, "session-1"],
	]);
	assert.deepEqual(writes, [
		["pi-status", "idle"],
		["pi-status", "gen"],
		["pi-status", undefined],
	]);
});
