import assert from "node:assert/strict";
import test from "node:test";
import { createPixelFishingFrames, PIXEL_FISHING_FRAME_COUNT, PIXEL_FISHING_ROWS } from "./pixel-fishing.ts";

test("像素钓鱼动画正好 8 帧", () => {
	const frames = createPixelFishingFrames();
	assert.equal(frames.length, PIXEL_FISHING_FRAME_COUNT);
});

test("每帧正好 7 行，且每行以 ANSI reset 结束", () => {
	const frames = createPixelFishingFrames();
	for (const [index, frame] of frames.entries()) {
		assert.equal(frame.length, PIXEL_FISHING_ROWS, `frame ${index} should have ${PIXEL_FISHING_ROWS} lines`);
		for (const row of frame) {
			assert.match(row, /\x1b\[0m$/);
		}
	}
});
