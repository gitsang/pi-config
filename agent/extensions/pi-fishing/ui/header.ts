import { truncateToWidth } from "@earendil-works/pi-tui";
import type { FishingGame } from "../core/game.ts";
import { FISHING_FRAMES } from "./frames.ts";
import { fmtCoins, fmtTokens } from "./format.ts";

interface HeaderThemeLike {
	fg?: (name: string, text: string) => string;
	bold?: (text: string) => string;
	dim?: (text: string) => string;
}

export class FishingPanel {
	private frame = 0;
	private timer: ReturnType<typeof setInterval> | undefined;
	private requestRender: (() => void) | undefined;
	private readonly game: FishingGame;
	private readonly theme: HeaderThemeLike | undefined;
	private readonly intervalMs: number;

	constructor(game: FishingGame, theme: HeaderThemeLike | undefined, intervalMs = 200) {
		this.game = game;
		this.theme = theme;
		this.intervalMs = intervalMs;
	}

	setRequestRender(fn: () => void): void {
		this.requestRender = fn;
	}

	start(): void {
		if (this.timer) return;
		this.timer = setInterval(() => {
			this.frame = (this.frame + 1) % FISHING_FRAMES.length;
			this.requestRender?.();
		}, this.intervalMs);
	}

	dispose(): void {
		if (this.timer) {
			clearInterval(this.timer);
			this.timer = undefined;
		}
		this.requestRender = undefined;
	}

	invalidate(): void {
		// 每帧都从 game 快照实时渲染，无需缓存清理。
	}

	render(width: number): string[] {
		const snapshot = this.game.snapshot();
		const state = snapshot.state;
		const rod = snapshot.equippedRod;
		const level = state.ownedRods.find((owned) => owned.rodId === rod.id)?.level ?? 1;

		const line1 = `🎣 鱼饵 ${fmtTokens(state.pendingBaitTokens)}/${fmtTokens(snapshot.baitTokensPerCast)}  金币 ${fmtCoins(state.coins)}  累计 ${fmtTokens(state.totalTokensConsumed)} tok`;
		const line2 = `${rod.emoji} ${rod.name} Lv.${level}  🐟 鱼篓 ${snapshot.inventoryUsed}/${snapshot.inventoryCapacity}  🐠 鱼缸 ${state.aquariums.length}`;
		const frame = FISHING_FRAMES[this.frame] ?? FISHING_FRAMES[0]!;
		const eventLine = state.lastEventText || "…";

		return [line1, line2, ...frame, eventLine].map((line) =>
			truncateToWidth(this.color("accent", line), Math.max(0, width)),
		);
	}

	private color(name: string, text: string): string {
		try {
			const colored = this.theme?.fg?.(name, text);
			if (colored) return colored;
		} catch {
			// 主题色失败时退化为纯文本
		}
		return text;
	}
}

export function createFishingWidget(game: FishingGame, intervalMs = 200): (tui: unknown, theme: unknown) => {
	render(width: number): string[];
	invalidate(): void;
	dispose(): void;
} {
	return (tui, theme) => {
		const header = new FishingPanel(game, theme as HeaderThemeLike | undefined, intervalMs);
		const tuiLike = tui as { requestRender?: () => void };
		header.setRequestRender(() => tuiLike.requestRender?.());
		header.start();
		return {
			render: (width: number) => header.render(width),
			invalidate: () => header.invalidate(),
			dispose: () => header.dispose(),
		};
	};
}
