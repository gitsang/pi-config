import assert from "node:assert/strict";
import test from "node:test";
import { FISHING_FRAMES } from "./frames.ts";

test("钓鱼动画正好 8 帧", () => {
	assert.equal(FISHING_FRAMES.length, 8);
});

test("每帧正好 5 行", () => {
	for (const [index, frame] of FISHING_FRAMES.entries()) {
		assert.equal(frame.length, 5, `frame ${index} should have 5 lines`);
	}
});
