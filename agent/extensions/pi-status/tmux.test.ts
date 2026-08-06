import assert from "node:assert/strict";
import test from "node:test";
import type { ProcessStatusRecord, TmuxLocation } from "./store.ts";
import { sameTmuxWindow, tmuxServerId } from "./tmux.ts";

const location: TmuxLocation = {
	serverId: "/tmp/tmux-1000/default,42",
	windowId: "@3",
	paneId: "%1",
};

function record(tmux: TmuxLocation): ProcessStatusRecord {
	return {
		version: 1,
		pid: 123,
		sessionId: "session",
		state: "idle",
		updatedAt: 1000,
		tmux,
	};
}

test("normalizes TMUX environment values to a server identity", () => {
	assert.equal(
		tmuxServerId("/tmp/tmux-1000/default,42,7"),
		"/tmp/tmux-1000/default,42",
	);
	assert.equal(tmuxServerId("unexpected"), "unexpected");
});

test("groups records by tmux server and window, not pane", () => {
	assert.equal(sameTmuxWindow(record(location), location), true);
	assert.equal(
		sameTmuxWindow(record({ ...location, paneId: "%9" }), location),
		true,
	);
	assert.equal(
		sameTmuxWindow(record({ ...location, windowId: "@4" }), location),
		false,
	);
	assert.equal(
		sameTmuxWindow(record({ ...location, serverId: "/tmp/other,42" }), location),
		false,
	);
});
