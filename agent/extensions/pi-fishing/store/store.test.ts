import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { FishingStore } from "./store.ts";

test("store 使用默认值创建初始状态", () => {
	const dir = mkdtempSync(join(tmpdir(), "pi-fishing-store-"));
	try {
		const store = new FishingStore(dir, { defaults: { inventoryCapacity: 5, uiVisible: true } });
		assert.equal(store.getState().inventoryCapacity, 5);
		assert.equal(store.getState().uiVisible, true);
		store.saveNow();
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("store 持久化状态并在重启后恢复", () => {
	const dir = mkdtempSync(join(tmpdir(), "pi-fishing-store-"));
	try {
		const store = new FishingStore(dir);
		const state = store.getState();
		state.coins = 888;
		state.lastEventText = "test event";
		store.record({ type: "Test" }, [], state);
		store.saveNow();

		const reloaded = new FishingStore(dir);
		assert.equal(reloaded.getState().coins, 888);
		assert.equal(reloaded.getState().lastEventText, "test event");
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("state.json 损坏时从事件日志恢复", () => {
	const dir = mkdtempSync(join(tmpdir(), "pi-fishing-store-"));
	try {
		const store = new FishingStore(dir);
		const state = store.getState();
		state.coins = 321;
		store.record({ type: "Test" }, [], state);
		store.saveNow();

		writeFileSync(join(dir, "state.json"), "{bad json", "utf8");

		const reloaded = new FishingStore(dir);
		assert.equal(reloaded.getState().coins, 321);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});
