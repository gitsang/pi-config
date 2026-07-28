export type State = "idle" | "gen" | "done";

export interface InstanceRecord {
	pid: number;
	sessionId: string;
	state: State;
}

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
const RECORD_VERSION = "v1";

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

export function serializeInstanceRecord(record: InstanceRecord): string {
	return [
		RECORD_VERSION,
		String(record.pid),
		record.state,
		encodeURIComponent(record.sessionId),
	].join("|");
}

export function parseInstanceRecord(value: string): InstanceRecord | null {
	const [version, rawPid, state, encodedSessionId, ...extra] = value.split("|");
	if (version !== RECORD_VERSION || extra.length > 0 || !/^[1-9]\d*$/.test(rawPid ?? "")) {
		return null;
	}
	if (state !== "idle" && state !== "gen" && state !== "done") return null;

	const pid = Number(rawPid);
	if (!Number.isSafeInteger(pid)) return null;
	try {
		const sessionId = decodeURIComponent(encodedSessionId ?? "");
		return sessionId ? { pid, sessionId, state } : null;
	} catch {
		return null;
	}
}
