import assert from "node:assert/strict";
import test from "node:test";
import {
	formatAggregateMarker,
	superscriptCount,
	type MarkerGlyphs,
} from "./aggregate.ts";

const glyphs: MarkerGlyphs = { idle: "I", busy: "B", done: "D" };

test("shows one idle glyph when every Pi process is idle", () => {
	assert.equal(formatAggregateMarker(["idle"], glyphs), "I");
	assert.equal(formatAggregateMarker(["idle", "idle", "idle"], glyphs), "I");
});

test("shows only non-zero active state counts", () => {
	assert.equal(formatAggregateMarker(["idle", "gen"], glyphs), "B ¹");
	assert.equal(formatAggregateMarker(["done", "idle", "done"], glyphs), "D ²");
	assert.equal(
		formatAggregateMarker(["idle", "gen", "done", "gen", "done"], glyphs),
		"B ²D ²",
	);
});

test("supports multi-digit superscript counts and no registered processes", () => {
	assert.equal(superscriptCount(10), "¹⁰");
	assert.equal(formatAggregateMarker([], glyphs), null);
});
