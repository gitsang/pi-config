import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { StatusStore, parseStatusRecord } from "./store.ts";

const tmux = {
	serverId: "/tmp/tmux-1000/default,42",
	windowId: "@7",
	paneId: "%3",
};

function temporaryStore(): string {
	return mkdtempSync(join(tmpdir(), "pi-status-test-"));
}

test("validates shared status records", () => {
	const record = {
		version: 1,
		pid: 123,
		sessionId: "session-1",
		state: "gen",
		updatedAt: 1000,
		tmux,
	} as const;
	assert.deepEqual(parseStatusRecord(record), record);
	assert.equal(parseStatusRecord({ ...record, state: "unknown" }), null);
	assert.equal(parseStatusRecord({ ...record, pid: 0 }), null);
	assert.equal(parseStatusRecord({ ...record, tmux: { ...tmux, windowId: "" } }), null);
});

test("publishes, reads, sorts, and removes per-process snapshots", () => {
	const directory = temporaryStore();
	const alive = new Set([101, 202]);
	const probe = (pid: number) => alive.has(pid);
	const first = new StatusStore(directory, 202, probe);
	const second = new StatusStore(directory, 101, probe);
	try {
		first.publish({ sessionId: "s-202", state: "idle", tmux });
		second.publish({ sessionId: "s-101", state: "done" });

		assert.deepEqual(first.list().map((record) => record.pid), [101, 202]);
		assert.equal(first.get(202, "s-202")?.state, "idle");
		assert.equal(first.get(202, "wrong-session"), null);

		first.remove();
		assert.deepEqual(second.list().map((record) => record.pid), [101]);
	} finally {
		first.close();
		second.close();
		rmSync(directory, { recursive: true, force: true });
	}
});

test("prunes malformed and dead-process records", () => {
	const directory = temporaryStore();
	const store = new StatusStore(directory, 303, (pid) => pid === 303);
	try {
		store.publish({ sessionId: "live", state: "idle" });
		writeFileSync(join(directory, "404.json"), JSON.stringify({
			version: 1,
			pid: 404,
			sessionId: "dead",
			state: "gen",
			updatedAt: Date.now(),
		}));
		writeFileSync(join(directory, "505.json"), "not json");

		assert.deepEqual(store.list().map((record) => record.pid), [303]);
		assert.equal(store.get(404), null);
		assert.equal(store.get(505), null);
	} finally {
		store.close();
		rmSync(directory, { recursive: true, force: true });
	}
});

test("notifies another store instance when a process snapshot changes", async () => {
	const directory = temporaryStore();
	const probe = () => true;
	const publisher = new StatusStore(directory, 606, probe);
	const subscriber = new StatusStore(directory, 707, probe);
	let unsubscribe = () => {};
	try {
		const event = new Promise<number | undefined>((resolve, reject) => {
			const timeout = setTimeout(() => reject(new Error("status update was not observed")), 1500);
			unsubscribe = subscriber.subscribe((update) => {
				if (update.pid !== 606) return;
				clearTimeout(timeout);
				resolve(update.pid);
			});
		});
		publisher.publish({ sessionId: "cross-process", state: "gen", tmux });
		assert.equal(await event, 606);
		assert.equal(subscriber.get(606)?.state, "gen");
	} finally {
		unsubscribe();
		publisher.close();
		subscriber.close();
		rmSync(directory, { recursive: true, force: true });
	}
});
