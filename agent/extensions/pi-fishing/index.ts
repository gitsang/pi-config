import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { setupPiAdapter } from "./adapters/pi-adapter.ts";
import { loadFishingConfig, type FishingConfig } from "./config.ts";
import { FishingGame, type Command, type GameEffect } from "./core/game.ts";
import { FishingStore } from "./store/store.ts";
import { createFishingWidget } from "./ui/header.ts";
import { fmtCoins, fmtLength, fmtTokens, fmtWeight } from "./ui/format.ts";
import { getAquariumOrThrow } from "./core/aquariums.ts";
import { getSpeciesOrThrow } from "./core/species.ts";

const EXT_DIR = dirname(fileURLToPath(import.meta.url));
const FISHING_WIDGET_KEY = "pi-fishing";
const MIN_TERMINAL_ROWS_FOR_PANEL = 16;

function getTerminalRows(): number | undefined {
	const rows = (process.stdout as unknown as { rows?: number }).rows;
	return typeof rows === "number" && rows > 0 ? rows : undefined;
}

function notifyEffects(ctx: ExtensionContext, effects: GameEffect[]): void {
	const line = [...effects].reverse().find((effect) => effect.type === "EventLine");
	if (!line || line.type !== "EventLine") return;
	ctx.ui.notify(line.text, line.level);
}

function renderStatus(game: FishingGame): string {
	const snapshot = game.snapshot();
	const state = snapshot.state;
	const rod = snapshot.equippedRod;
	const level = state.ownedRods.find((owned) => owned.rodId === rod.id)?.level ?? 1;

	const inventorySummary =
		state.inventory.length === 0
			? "空"
			: state.inventory
					.map((fish) => {
						const species = getSpeciesOrThrow(fish.speciesId);
						return `${species.emoji}${species.name} ${fmtWeight(fish.weightGrams)} ${fmtLength(fish.lengthCm)}`;
					})
					.join(", ");
	const aquariumSummary =
		state.aquariums.length === 0
			? "无"
			: state.aquariums
					.map((aquarium) => {
						const definition = getAquariumOrThrow(aquarium.aquariumId);
						return `${definition.emoji}${definition.name} ${aquarium.fish.length}/${aquarium.capacity}`;
					})
					.join(", ");

	return [
		"🎣 pi-fishing",
		`鱼饵 ${fmtTokens(state.pendingBaitTokens)}/${fmtTokens(snapshot.baitTokensPerCast)}  金币 ${fmtCoins(state.coins)}  累计 ${fmtTokens(state.totalTokensConsumed)} tok`,
		`鱼竿 ${rod.emoji} ${rod.name} Lv.${level}`,
		`鱼篓 ${snapshot.inventoryUsed}/${snapshot.inventoryCapacity}: ${inventorySummary}`,
		`鱼缸: ${aquariumSummary}`,
	].join("\n");
}

function renderStats(game: FishingGame): string {
	const stats = game.getState().stats;
	return [
		"📊 pi-fishing 统计",
		`累计消耗 token: ${fmtTokens(game.getState().totalTokensConsumed)}`,
		`累计抛竿消耗: ${fmtTokens(stats.totalBaitTokensUsed)}`,
		`累计钓鱼: ${stats.totalCatches} 条`,
		`稀有鱼: ${stats.rareCatches} 条`,
		`累计出售: ${stats.totalSales} 条`,
		`累计收入: ${fmtCoins(stats.totalCoinsEarned)} 金币`,
		`累计支出: ${fmtCoins(stats.totalCoinsSpent)} 金币`,
	].join("\n");
}

function renderHelp(): string {
	return [
		"🎣 pi-fishing 命令",
		"/pi-fishing show",
		"/pi-fishing hide",
		"/pi-fishing status",
		"/pi-fishing sell <fishId|all>",
		"/pi-fishing buy rod <rodId>",
		"/pi-fishing upgrade rod <rodId>",
		"/pi-fishing equip <rodId>",
		"/pi-fishing buy aquarium <aquariumId>",
		"/pi-fishing upgrade aquarium <aquariumId>",
		"/pi-fishing assign <fishId> <aquariumId>",
		"/pi-fishing remove <fishId>",
		"/pi-fishing stats",
	].join("\n");
}

export default function (pi: ExtensionAPI): void {
	const config: FishingConfig = loadFishingConfig(EXT_DIR, process.cwd());
	const store = new FishingStore(join(EXT_DIR, "data"), {
		defaults: {
			inventoryCapacity: config.defaultInventoryCapacity,
			uiVisible: config.uiVisible,
		},
	});
	const game = new FishingGame(store.getState(), { baitTokensPerCast: config.baitTokensPerCast });

	setupPiAdapter(pi, game, store);

	const installWidget = (ctx: ExtensionContext): void => {
		if (ctx.mode !== "tui") return;
		ctx.ui.setWidget(FISHING_WIDGET_KEY, createFishingWidget(game, config.animationIntervalMs), {
			placement: "aboveEditor",
		});
	};
	const removeWidget = (ctx: ExtensionContext): void => {
		if (ctx.mode !== "tui") return;
		ctx.ui.setWidget(FISHING_WIDGET_KEY, undefined);
	};

	pi.on("session_start", (_event, ctx) => {
		if (game.getState().uiVisible) installWidget(ctx);
	});

	const tickTimer = setInterval(() => {
		const event = { type: "Tick", now: Date.now() } as const;
		const effects = game.handleEvent(event);
		if (effects.length > 0) store.record(event, effects, game.getState());
	}, config.tickIntervalMs);

	pi.on("session_shutdown", () => {
		clearInterval(tickTimer);
		store.saveNow();
	});

	pi.registerCommand("pi-fishing", {
		description: "pi-fishing 挂机钓鱼游戏",
		handler: async (args, ctx) => {
			const parts = args.trim().split(/\s+/).filter(Boolean);
			const sub = parts[0] ?? "help";

			const applyCommand = (command: Command): void => {
				const effects = game.dispatch(command);
				store.record(command, effects, game.getState());
				notifyEffects(ctx, effects);
			};

			switch (sub) {
				case "show": {
					const rows = getTerminalRows();
					if (rows !== undefined && rows < MIN_TERMINAL_ROWS_FOR_PANEL) {
						ctx.ui.notify(
							`终端高度不足（当前 ${rows} 行，至少需要 ${MIN_TERMINAL_ROWS_FOR_PANEL} 行），无法打开 pi-fishing 面板`,
							"warning",
						);
						return;
					}
					applyCommand({ type: "Show" });
					installWidget(ctx);
					return;
				}
				case "hide": {
					applyCommand({ type: "Hide" });
					removeWidget(ctx);
					return;
				}
				case "status":
					ctx.ui.notify(renderStatus(game), "info");
					return;
				case "stats":
					ctx.ui.notify(renderStats(game), "info");
					return;
				case "help":
					ctx.ui.notify(renderHelp(), "info");
					return;
				case "sell": {
					if (parts[1] === "all") {
						applyCommand({ type: "SellAllFish" });
					} else if (parts[1]) {
						applyCommand({ type: "SellFish", fishId: parts[1] });
					} else {
						ctx.ui.notify("用法: /pi-fishing sell <fishId|all>", "warning");
					}
					return;
				}
				case "buy": {
					if (parts[1] === "rod" && parts[2]) {
						applyCommand({ type: "BuyRod", rodId: parts[2] });
					} else if (parts[1] === "aquarium" && parts[2]) {
						applyCommand({ type: "BuyAquarium", aquariumId: parts[2] });
					} else {
						ctx.ui.notify("用法: /pi-fishing buy rod <rodId> | /pi-fishing buy aquarium <aquariumId>", "warning");
					}
					return;
				}
				case "upgrade": {
					if (parts[1] === "rod" && parts[2]) {
						applyCommand({ type: "UpgradeRod", rodId: parts[2] });
					} else if (parts[1] === "aquarium" && parts[2]) {
						applyCommand({ type: "UpgradeAquarium", aquariumId: parts[2] });
					} else {
						ctx.ui.notify("用法: /pi-fishing upgrade rod <rodId> | /pi-fishing upgrade aquarium <aquariumId>", "warning");
					}
					return;
				}
				case "equip": {
					if (parts[1]) {
						applyCommand({ type: "EquipRod", rodId: parts[1] });
					} else {
						ctx.ui.notify("用法: /pi-fishing equip <rodId>", "warning");
					}
					return;
				}
				case "assign": {
					if (parts[1] && parts[2]) {
						applyCommand({ type: "AssignFishToAquarium", fishId: parts[1], aquariumId: parts[2] });
					} else {
						ctx.ui.notify("用法: /pi-fishing assign <fishId> <aquariumId>", "warning");
					}
					return;
				}
				case "remove": {
					if (parts[1]) {
						applyCommand({ type: "RemoveFishFromAquarium", fishId: parts[1] });
					} else {
						ctx.ui.notify("用法: /pi-fishing remove <fishId>", "warning");
					}
					return;
				}
				default:
					ctx.ui.notify(`未知子命令: ${sub}\n${renderHelp()}`, "warning");
			}
		},
	});
}
