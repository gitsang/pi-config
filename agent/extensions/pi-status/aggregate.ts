export type State = "idle" | "gen" | "done";

export interface MarkerGlyphs {
	idle: string;
	busy: string;
	done: string;
}

export interface StateCounts {
	idle: number;
	gen: number;
	done: number;
}

const SUPERSCRIPT_DIGITS = ["⁰", "¹", "²", "³", "⁴", "⁵", "⁶", "⁷", "⁸", "⁹"] as const;

export function countStates(states: readonly State[]): StateCounts {
	const counts: StateCounts = { idle: 0, gen: 0, done: 0 };
	for (const state of states) counts[state] += 1;
	return counts;
}

export function superscriptCount(count: number): string {
	return String(Math.max(0, Math.trunc(count)))
		.replace(/\d/g, (digit) => SUPERSCRIPT_DIGITS[Number(digit)]);
}

/** Idle is implicit unless every registered Pi process is idle. */
export function formatAggregateMarker(
	states: readonly State[],
	glyphs: MarkerGlyphs,
): string | null {
	if (states.length === 0) return null;
	const counts = countStates(states);
	if (counts.gen === 0 && counts.done === 0) return glyphs.idle;

	let marker = "";
	if (counts.gen > 0) marker += `${glyphs.busy} ${superscriptCount(counts.gen)}`;
	if (counts.done > 0) marker += `${glyphs.done} ${superscriptCount(counts.done)}`;
	return marker;
}
