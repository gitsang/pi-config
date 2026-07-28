import assert from "node:assert/strict";
import test from "node:test";
import {
	formatAggregateMarker,
	parseInstanceRecord,
	serializeInstanceRecord,
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

test("round-trips process records", () => {
	const record = { pid: 1234, sessionId: "session/with spaces", state: "gen" } as const;
	assert.deepEqual(parseInstanceRecord(serializeInstanceRecord(record)), record);
});

test("rejects malformed process records", () => {
	assert.equal(parseInstanceRecord("v1|0|idle|session"), null);
	assert.equal(parseInstanceRecord("v1|123|unknown|session"), null);
	assert.equal(parseInstanceRecord("v2|123|idle|session"), null);
	assert.equal(parseInstanceRecord("v1|123|idle|"), null);
});
