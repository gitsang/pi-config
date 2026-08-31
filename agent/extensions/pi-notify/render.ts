/**
 * pi-notify — `{{placeholder}}` substitution.
 *
 * Escaping matters: a raw string template that lands inside JSON must have its
 * values JSON-escaped, otherwise a quote or newline in an error message
 * produces an invalid request body. Object templates avoid the problem
 * entirely (substitute first, stringify after) and are the recommended form.
 */

const PLACEHOLDER = /\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g;

export type EscapeMode = "none" | "json" | "url";

function escapeValue(value: string, mode: EscapeMode): string {
	if (mode === "json") {
		const encoded = JSON.stringify(value);
		return encoded.slice(1, -1);
	}
	if (mode === "url") return encodeURIComponent(value);
	return value;
}

/** Replace `{{name}}` in `template`. Unknown names collapse to "". */
export function render(
	template: string,
	vars: Record<string, string>,
	mode: EscapeMode = "none",
): string {
	return template.replace(PLACEHOLDER, (_match, name: string) =>
		escapeValue(vars[name] ?? "", mode),
	);
}

/** Recursively render every string inside an object/array template. */
export function renderDeep(value: unknown, vars: Record<string, string>): unknown {
	if (typeof value === "string") return render(value, vars);
	if (Array.isArray(value)) return value.map((item) => renderDeep(item, vars));
	if (value && typeof value === "object") {
		const out: Record<string, unknown> = {};
		for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
			out[render(key, vars)] = renderDeep(item, vars);
		}
		return out;
	}
	return value;
}

/** Format a millisecond duration as `1h2m`, `3m12s` or `12s`. */
export function formatDuration(ms: number): string {
	const totalSeconds = Math.max(0, Math.round(ms / 1000));
	if (totalSeconds < 60) return `${totalSeconds}s`;
	const minutes = Math.floor(totalSeconds / 60);
	const seconds = totalSeconds % 60;
	if (minutes < 60) return seconds === 0 ? `${minutes}m` : `${minutes}m${seconds}s`;
	const hours = Math.floor(minutes / 60);
	const restMinutes = minutes % 60;
	return restMinutes === 0 ? `${hours}h` : `${hours}h${restMinutes}m`;
}

/** First non-empty line, trimmed and capped — used for error messages. */
export function firstLine(text: string | undefined, max: number): string {
	if (!text) return "";
	const line = text.split("\n").map((l) => l.trim()).find((l) => l.length > 0) ?? "";
	return line.length > max ? `${line.slice(0, max - 1)}…` : line;
}

function pickString(source: unknown, key: string): string {
	if (!source || typeof source !== "object") return "";
	const value = (source as Record<string, unknown>)[key];
	return typeof value === "string" ? value : "";
}

/**
 * Turn a provider error into something worth reading on a phone.
 *
 * pi surfaces raw upstream bodies, e.g.
 *   `401 {"type":"error","error":{"type":"authentication_error","message":"invalid x-api-key"}}`
 * which becomes `401 authentication_error: invalid x-api-key`.
 */
export function summarizeError(raw: string | undefined, max: number): string {
	if (!raw) return "";
	const text = raw.trim();
	const braceIndex = text.indexOf("{");
	if (braceIndex >= 0) {
		try {
			const parsed = JSON.parse(text.slice(braceIndex)) as Record<string, unknown>;
			const nested = (parsed.error ?? parsed) as Record<string, unknown>;
			const message = pickString(nested, "message") || pickString(parsed, "message");
			const type = pickString(nested, "type") || pickString(nested, "code");
			const detail = [type, message].filter((part) => part.length > 0).join(": ");
			if (detail) {
				const prefix = text.slice(0, braceIndex).trim();
				const combined = prefix ? `${prefix} ${detail}` : detail;
				return combined.length > max ? `${combined.slice(0, max - 1)}…` : combined;
			}
		} catch {
			// not JSON after all — fall through to the plain first line
		}
	}
	return firstLine(text, max);
}
