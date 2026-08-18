export function fmtTokens(n: number): string {
	if (n < 1000) return String(n);
	if (n < 10000) return `${(n / 1000).toFixed(1)}k`;
	if (n < 1000000) return `${Math.round(n / 1000)}k`;
	if (n < 10000000) return `${(n / 1000000).toFixed(1)}M`;
	return `${Math.round(n / 1000000)}M`;
}

export function fmtCoins(n: number): string {
	return String(Math.max(0, Math.round(n)));
}

export function fmtWeight(grams: number): string {
	return grams >= 1000 ? `${(grams / 1000).toFixed(grams % 1000 === 0 ? 0 : 1)}kg` : `${grams}g`;
}

export function fmtLength(cm: number): string {
	return `${cm}cm`;
}

export function fmtCount(n: number): string {
	return String(n);
}
