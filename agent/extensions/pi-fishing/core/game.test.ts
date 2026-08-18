import assert from "node:assert/strict";
import test from "node:test";
import { systemClock } from "./clock.ts";
import { FishingGame } from "./game.ts";
import { createInitialState, type FishInstance } from "./game-state.ts";
import { SeededRng } from "./rng.ts";

function makeGame(overrides: Parameters<typeof createInitialState>[0] = {}): FishingGame {
	return new FishingGame(createInitialState(overrides), {
		rng: new SeededRng(42),
		clock: { now: () => 1000 },
		baitTokensPerCast: 10,
	});
}

test("TokensConsumed 累积鱼饵并自动抛竿", () => {
	const game = makeGame();
	const effects = game.handleEvent({ type: "TokensConsumed", amount: 25, source: "msg", ts: 1000 });
	const state = game.getState();

	assert.equal(state.totalTokensConsumed, 25);
	assert.equal(state.pendingBaitTokens, 5);
	assert.equal(state.stats.totalBaitTokensUsed, 20);
	assert.equal(state.stats.totalCatches, 2);
	assert.equal(state.inventory.length, 2);
	assert.equal(effects.filter((effect) => effect.type === "FishCaught").length, 2);
});

test("鱼篓满时放生新钓到的鱼", () => {
	const game = makeGame({ inventoryCapacity: 1 });
	game.handleEvent({ type: "TokensConsumed", amount: 25, source: "msg", ts: 1000 });

	const state = game.getState();
	assert.equal(state.stats.totalCatches, 2);
	assert.equal(state.inventory.length, 1);
});

test("出售鱼会增加金币并清空鱼篓", () => {
	const fish: FishInstance = {
		id: "fish-test-1",
		speciesId: "carp",
		weightGrams: 500,
		lengthCm: 22,
		rating: 60,
		caughtAt: 1000,
		sold: false,
		location: "inventory",
	};
	const game = makeGame({ coins: 0, inventory: [fish] });
	const effects = game.dispatch({ type: "SellFish", fishId: fish.id });
	const state = game.getState();

	assert.equal(state.inventory.length, 0);
	assert.ok(state.coins > 0);
	assert.equal(state.stats.totalSales, 1);
	assert.equal(state.stats.totalCoinsEarned, state.coins);
	assert.equal(effects.some((effect) => effect.type === "FishSold"), true);
});

test("购买并装备新鱼竿后使用新鱼竿阈值", () => {
	const game = makeGame({ coins: 1000 });
	game.dispatch({ type: "BuyRod", rodId: "carbon" });
	game.dispatch({ type: "EquipRod", rodId: "carbon" });

	const state = game.getState();
	assert.equal(state.equippedRodId, "carbon");
	assert.ok(state.ownedRods.some((rod) => rod.rodId === "carbon"));

	game.handleEvent({ type: "TokensConsumed", amount: 1500, source: "msg", ts: 1000 });
	assert.equal(game.getState().stats.totalBaitTokensUsed, 1500);
	assert.equal(game.getState().stats.totalCatches, 1);
});

test("鱼竿升级消耗金币并提升等级", () => {
	const game = makeGame({ coins: 500 });
	const effects = game.dispatch({ type: "UpgradeRod", rodId: "bamboo" });
	const bamboo = game.getState().ownedRods.find((rod) => rod.rodId === "bamboo");

	assert.equal(bamboo?.level, 2);
	assert.ok(game.getState().coins < 500);
	assert.equal(effects.some((effect) => effect.type === "Upgrade" && effect.kind === "rod"), true);
});

test("Show/Hide 切换 uiVisible", () => {
	const game = makeGame();
	game.dispatch({ type: "Show" });
	assert.equal(game.getState().uiVisible, true);
	game.dispatch({ type: "Hide" });
	assert.equal(game.getState().uiVisible, false);
});

test("snapshot 提供鱼饵进度和阈值", () => {
	const game = makeGame();
	game.handleEvent({ type: "TokensConsumed", amount: 4, source: "msg", ts: 1000 });
	const snapshot = game.snapshot();

	assert.equal(snapshot.baitTokensPerCast, 10);
	assert.equal(snapshot.baitProgress, 0.4);
});

test("systemClock 使用 Date.now", () => {
	assert.ok(Math.abs(systemClock.now() - Date.now()) < 1000);
});
