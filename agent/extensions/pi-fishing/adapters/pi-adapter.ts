import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { TokenSource } from "../core/game.ts";
import type { FishingGame } from "../core/game.ts";
import type { FishingStore } from "../store/store.ts";

interface UsageLike {
	input?: number;
	output?: number;
	cacheRead?: number;
	cacheWrite?: number;
}

function usageToBaitTokens(usage: UsageLike | undefined): number {
	if (!usage) return 0;
	return (usage.input ?? 0) + (usage.output ?? 0) + (usage.cacheRead ?? 0) + (usage.cacheWrite ?? 0);
}

export function setupPiAdapter(pi: ExtensionAPI, game: FishingGame, store: FishingStore): void {
	const recordTokens = (usage: UsageLike | undefined, source: TokenSource): void => {
		const amount = usageToBaitTokens(usage);
		if (amount <= 0) return;
		const event = { type: "TokensConsumed", amount, source, ts: Date.now() } as const;
		const effects = game.handleEvent(event);
		store.record(event, effects, game.getState());
	};

	pi.on("message_end", (event) => {
		if (event.message?.role !== "assistant") return;
		recordTokens(event.message.usage, "msg");
	});

	pi.on("session_compact", (event) => {
		recordTokens(event.compactionEntry?.usage, "compact");
	});

	pi.on("session_tree", (event) => {
		recordTokens(event.summaryEntry?.usage, "tree");
	});

	pi.on("session_shutdown", () => {
		store.saveNow();
	});
}
