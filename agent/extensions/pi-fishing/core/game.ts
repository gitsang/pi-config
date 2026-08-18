import { getAquariumOrThrow } from "./aquariums.ts";
import { systemClock, type Clock } from "./clock.ts";
import { computeRating, gradeFromRating, salePrice, upgradeAquariumCost, upgradeRodCost } from "./economy.ts";
import {
	createInitialState,
	type AquariumState,
	type FishInstance,
	type GameState,
	type Rarity,
	type RodId,
	type SpeciesId,
} from "./game-state.ts";
import { MathRng, type Rng } from "./rng.ts";
import { getRodOrThrow, getRodRank, type Rod } from "./rods.ts";
import { getSpeciesOrThrow, SPECIES, type Species } from "./species.ts";

export type TokenSource = "msg" | "compact" | "tree";

export type GameEvent =
	| { type: "TokensConsumed"; amount: number; source: TokenSource; ts: number }
	| { type: "Tick"; now: number };

export type Command =
	| { type: "Show" }
	| { type: "Hide" }
	| { type: "SellFish"; fishId: string }
	| { type: "SellAllFish" }
	| { type: "BuyRod"; rodId: RodId }
	| { type: "UpgradeRod"; rodId: RodId }
	| { type: "EquipRod"; rodId: RodId }
	| { type: "BuyAquarium"; aquariumId: string }
	| { type: "UpgradeAquarium"; aquariumId: string }
	| { type: "AssignFishToAquarium"; fishId: string; aquariumId: string }
	| { type: "RemoveFishFromAquarium"; fishId: string };

export type GameEffect =
	| { type: "FishCaught"; fish: FishInstance; released: boolean; baitCost: number }
	| { type: "FishSold"; fishId: string; speciesId: SpeciesId; coins: number }
	| { type: "Purchase"; kind: "rod" | "aquarium"; id: string; cost: number; name: string }
	| {
			type: "Upgrade";
			kind: "rod" | "aquarium";
			id: string;
			cost: number;
			name: string;
			afterLevel?: number;
			afterCapacity?: number;
	  }
	| { type: "AssignFish"; fishId: string; aquariumId: string; fish: FishInstance }
	| { type: "RemoveFish"; fishId: string; aquariumId: string; fish: FishInstance }
	| { type: "EventLine"; text: string; level: "info" | "warning" | "error" };

export interface GameSnapshot {
	state: GameState;
	equippedRod: Rod;
	inventoryUsed: number;
	inventoryCapacity: number;
	baitProgress: number;
	lastEventText: string;
}

export interface FishingGameOptions {
	rng?: Rng;
	clock?: Clock;
	baitTokensPerCast?: number;
}

const RARITY_WEIGHT: Record<Rarity, number> = {
	common: 100,
	uncommon: 60,
	rare: 25,
	epic: 8,
	legendary: 2,
};

const MAX_CASTS_PER_SETTLE = 20;

export class FishingGame {
	private state: GameState;
	private readonly rng: Rng;
	private readonly clock: Clock;
	private readonly baitTokensPerCastOverride: number | undefined;
	private fishSeq = 0;

	constructor(state: GameState = createInitialState(), options: FishingGameOptions = {}) {
		this.state = state;
		this.rng = options.rng ?? new MathRng();
		this.clock = options.clock ?? systemClock;
		this.baitTokensPerCastOverride = options.baitTokensPerCast;
	}

	getState(): GameState {
		return this.state;
	}

	snapshot(): GameSnapshot {
		const equippedRod = getRodOrThrow(this.state.equippedRodId);
		return {
			state: this.state,
			equippedRod,
			inventoryUsed: this.state.inventory.length,
			inventoryCapacity: this.state.inventoryCapacity,
			baitProgress: Math.min(1, this.state.pendingBaitTokens / this.baitThreshold(equippedRod)),
			lastEventText: this.state.lastEventText,
		};
	}

	handleEvent(event: GameEvent): GameEffect[] {
		switch (event.type) {
			case "TokensConsumed":
				if (event.amount <= 0) return [];
				this.state.totalTokensConsumed += event.amount;
				this.state.pendingBaitTokens += event.amount;
				return this.settleCasts();
			case "Tick":
				return this.settleCasts();
			default:
				return [];
		}
	}

	dispatch(command: Command): GameEffect[] {
		switch (command.type) {
			case "Show":
				return this.setVisible(true);
			case "Hide":
				return this.setVisible(false);
			case "SellFish":
				return this.sellFish(command.fishId);
			case "SellAllFish":
				return this.sellAllFish();
			case "BuyRod":
				return this.buyRod(command.rodId);
			case "UpgradeRod":
				return this.upgradeRod(command.rodId);
			case "EquipRod":
				return this.equipRod(command.rodId);
			case "BuyAquarium":
				return this.buyAquarium(command.aquariumId);
			case "UpgradeAquarium":
				return this.upgradeAquarium(command.aquariumId);
			case "AssignFishToAquarium":
				return this.assignFishToAquarium(command.fishId, command.aquariumId);
			case "RemoveFishFromAquarium":
				return this.removeFishFromAquarium(command.fishId);
			default:
				return [];
		}
	}

	private setVisible(visible: boolean): GameEffect[] {
		this.state.uiVisible = visible;
		const effects: GameEffect[] = [];
		this.emit(effects, visible ? "pi-fishing 面板已开启" : "pi-fishing 面板已关闭", "info");
		return effects;
	}

	private sellFish(fishId: string): GameEffect[] {
		const effects: GameEffect[] = [];
		const index = this.state.inventory.findIndex((fish) => fish.id === fishId && fish.location === "inventory");
		if (index === -1) {
			this.emit(effects, `鱼篓中没有找到鱼 ${fishId}`, "error");
			return effects;
		}

		const fish = this.state.inventory[index]!;
		const species = getSpeciesOrThrow(fish.speciesId);
		const coins = salePrice(species, fish);
		this.state.inventory.splice(index, 1);
		this.state.coins += coins;
		this.state.stats.totalSales += 1;
		this.state.stats.totalCoinsEarned += coins;
		effects.push({ type: "FishSold", fishId: fish.id, speciesId: fish.speciesId, coins });
		this.emit(effects, `出售了 ${species.emoji} ${species.name}，获得 ${coins} 金币`, "info");
		return effects;
	}

	private sellAllFish(): GameEffect[] {
		const effects: GameEffect[] = [];
		if (this.state.inventory.length === 0) {
			this.emit(effects, "鱼篓是空的", "warning");
			return effects;
		}

		const fishList = [...this.state.inventory];
		let totalCoins = 0;
		for (const fish of fishList) {
			const species = getSpeciesOrThrow(fish.speciesId);
			const coins = salePrice(species, fish);
			const index = this.state.inventory.findIndex((candidate) => candidate.id === fish.id);
			if (index !== -1) this.state.inventory.splice(index, 1);
			totalCoins += coins;
			this.state.stats.totalSales += 1;
			this.state.stats.totalCoinsEarned += coins;
			effects.push({ type: "FishSold", fishId: fish.id, speciesId: fish.speciesId, coins });
		}
		this.state.coins += totalCoins;
		this.emit(effects, `出售了 ${fishList.length} 条鱼，共获得 ${totalCoins} 金币`, "info");
		return effects;
	}

	private buyRod(rodId: RodId): GameEffect[] {
		const effects: GameEffect[] = [];
		const rod = getRodOrThrow(rodId);
		if (this.state.ownedRods.some((owned) => owned.rodId === rodId)) {
			this.emit(effects, `你已经拥有 ${rod.name}`, "warning");
			return effects;
		}
		if (this.state.coins < rod.basePrice) {
			this.emit(effects, `金币不足，${rod.name} 需要 ${rod.basePrice} 金币`, "error");
			return effects;
		}

		this.state.coins -= rod.basePrice;
		this.state.stats.totalCoinsSpent += rod.basePrice;
		this.state.ownedRods.push({ rodId, level: 1 });
		effects.push({ type: "Purchase", kind: "rod", id: rod.id, cost: rod.basePrice, name: rod.name });
		this.emit(effects, `购买了 ${rod.emoji} ${rod.name}`, "info");
		return effects;
	}

	private upgradeRod(rodId: RodId): GameEffect[] {
		const effects: GameEffect[] = [];
		const rod = getRodOrThrow(rodId);
		const owned = this.state.ownedRods.find((candidate) => candidate.rodId === rodId);
		if (!owned) {
			this.emit(effects, `你还没有 ${rod.name}`, "error");
			return effects;
		}
		if (owned.level >= rod.maxLevel) {
			this.emit(effects, `${rod.name} 已经满级`, "warning");
			return effects;
		}

		const cost = upgradeRodCost(rod, owned.level);
		if (this.state.coins < cost) {
			this.emit(effects, `金币不足，升级 ${rod.name} 需要 ${cost} 金币`, "error");
			return effects;
		}

		this.state.coins -= cost;
		this.state.stats.totalCoinsSpent += cost;
		owned.level += 1;
		effects.push({ type: "Upgrade", kind: "rod", id: rod.id, cost, name: rod.name, afterLevel: owned.level });
		this.emit(effects, `${rod.emoji} ${rod.name} 升级到 Lv.${owned.level}`, "info");
		return effects;
	}

	private equipRod(rodId: RodId): GameEffect[] {
		const effects: GameEffect[] = [];
		const rod = getRodOrThrow(rodId);
		if (!this.state.ownedRods.some((owned) => owned.rodId === rodId)) {
			this.emit(effects, `你还没有 ${rod.name}`, "error");
			return effects;
		}

		this.state.equippedRodId = rodId;
		this.emit(effects, `已装备 ${rod.emoji} ${rod.name}`, "info");
		return effects;
	}

	private buyAquarium(aquariumId: string): GameEffect[] {
		const effects: GameEffect[] = [];
		const aquarium = getAquariumOrThrow(aquariumId);
		if (this.state.aquariums.some((owned) => owned.aquariumId === aquariumId)) {
			this.emit(effects, `你已经拥有 ${aquarium.name}`, "warning");
			return effects;
		}
		if (this.state.coins < aquarium.basePrice) {
			this.emit(effects, `金币不足，${aquarium.name} 需要 ${aquarium.basePrice} 金币`, "error");
			return effects;
		}

		this.state.coins -= aquarium.basePrice;
		this.state.stats.totalCoinsSpent += aquarium.basePrice;
		this.state.aquariums.push({ aquariumId, capacity: aquarium.baseCapacity, fish: [] });
		effects.push({ type: "Purchase", kind: "aquarium", id: aquarium.id, cost: aquarium.basePrice, name: aquarium.name });
		this.emit(effects, `购买了 ${aquarium.emoji} ${aquarium.name}`, "info");
		return effects;
	}

	private upgradeAquarium(aquariumId: string): GameEffect[] {
		const effects: GameEffect[] = [];
		const aquarium = getAquariumOrThrow(aquariumId);
		const owned = this.state.aquariums.find((candidate) => candidate.aquariumId === aquariumId);
		if (!owned) {
			this.emit(effects, `你还没有 ${aquarium.name}`, "error");
			return effects;
		}
		if (owned.capacity >= aquarium.maxCapacity) {
			this.emit(effects, `${aquarium.name} 已经达到最大容量`, "warning");
			return effects;
		}

		const cost = upgradeAquariumCost(aquarium, owned.capacity, aquarium.baseCapacity);
		if (this.state.coins < cost) {
			this.emit(effects, `金币不足，扩容 ${aquarium.name} 需要 ${cost} 金币`, "error");
			return effects;
		}

		this.state.coins -= cost;
		this.state.stats.totalCoinsSpent += cost;
		owned.capacity += 1;
		effects.push({ type: "Upgrade", kind: "aquarium", id: aquarium.id, cost, name: aquarium.name, afterCapacity: owned.capacity });
		this.emit(effects, `${aquarium.emoji} ${aquarium.name} 扩容到 ${owned.capacity} 格`, "info");
		return effects;
	}

	private assignFishToAquarium(fishId: string, aquariumId: string): GameEffect[] {
		const effects: GameEffect[] = [];
		const fishIndex = this.state.inventory.findIndex((fish) => fish.id === fishId && fish.location === "inventory");
		if (fishIndex === -1) {
			this.emit(effects, `鱼篓中没有找到鱼 ${fishId}`, "error");
			return effects;
		}

		const aquarium = getAquariumOrThrow(aquariumId);
		const owned = this.state.aquariums.find((candidate) => candidate.aquariumId === aquariumId);
		if (!owned) {
			this.emit(effects, `你还没有 ${aquarium.name}`, "error");
			return effects;
		}

		const fish = this.state.inventory[fishIndex]!;
		const species = getSpeciesOrThrow(fish.speciesId);
		if (!species.aquariumCompatible || !aquarium.allowedSpecies.includes(species.id)) {
			this.emit(effects, `${species.name} 不能放入 ${aquarium.name}`, "error");
			return effects;
		}
		if (owned.fish.length >= owned.capacity) {
			this.emit(effects, `${aquarium.name} 已满`, "error");
			return effects;
		}

		this.state.inventory.splice(fishIndex, 1);
		fish.location = "aquarium";
		owned.fish.push(fish);
		effects.push({ type: "AssignFish", fishId: fish.id, aquariumId, fish });
		this.emit(effects, `把 ${species.emoji} ${species.name} 放入了 ${aquarium.name}`, "info");
		return effects;
	}

	private removeFishFromAquarium(fishId: string): GameEffect[] {
		const effects: GameEffect[] = [];
		let foundAquarium: AquariumState | undefined;
		let foundFish: FishInstance | undefined;
		for (const aquarium of this.state.aquariums) {
			const fish = aquarium.fish.find((candidate) => candidate.id === fishId);
			if (fish) {
				foundAquarium = aquarium;
				foundFish = fish;
				break;
			}
		}
		if (!foundAquarium || !foundFish) {
			this.emit(effects, `鱼缸中没有找到鱼 ${fishId}`, "error");
			return effects;
		}
		if (this.state.inventory.length >= this.state.inventoryCapacity) {
			this.emit(effects, "鱼篓已满，无法从鱼缸取出鱼", "error");
			return effects;
		}

		foundAquarium.fish = foundAquarium.fish.filter((candidate) => candidate.id !== fishId);
		foundFish.location = "inventory";
		this.state.inventory.push(foundFish);
		const aquariumDef = getAquariumOrThrow(foundAquarium.aquariumId);
		const species = getSpeciesOrThrow(foundFish.speciesId);
		effects.push({ type: "RemoveFish", fishId: foundFish.id, aquariumId: foundAquarium.aquariumId, fish: foundFish });
		this.emit(effects, `把 ${species.emoji} ${species.name} 从 ${aquariumDef.name} 取出`, "info");
		return effects;
	}

	private settleCasts(): GameEffect[] {
		const effects: GameEffect[] = [];
		const rod = getRodOrThrow(this.state.equippedRodId);
		const threshold = this.baitThreshold(rod);
		let casts = 0;
		while (this.state.pendingBaitTokens >= threshold && casts < MAX_CASTS_PER_SETTLE) {
			this.state.pendingBaitTokens -= threshold;
			this.state.stats.totalBaitTokensUsed += threshold;
			effects.push(...this.castOnce(rod, threshold));
			casts += 1;
		}
		return effects;
	}

	private castOnce(rod: Rod, baitCost: number): GameEffect[] {
		const effects: GameEffect[] = [];
		const fish = this.rollFish(rod);
		const species = getSpeciesOrThrow(fish.speciesId);
		this.updateCollection(fish, species);
		this.state.stats.totalCatches += 1;

		let released = false;
		if (this.state.inventory.length < this.state.inventoryCapacity) {
			this.state.inventory.push(fish);
		} else {
			released = true;
		}

		effects.push({ type: "FishCaught", fish, released, baitCost });
		if (released) {
			this.emit(effects, `鱼篓已满，${species.emoji} ${species.name} 被放生了`, "warning");
		} else {
			const grade = gradeFromRating(fish.rating);
			this.emit(
				effects,
				`钓到了 ${species.emoji} ${species.name} ${formatWeight(fish.weightGrams)} / ${formatLength(fish.lengthCm)} / 评分 ${grade}`,
				"info",
			);
		}
		return effects;
	}

	private rollFish(rod: Rod): FishInstance {
		const eligible = SPECIES.filter((species) => getRodRank(species.requiredRodId) <= rod.rank);
		const pool = eligible.length > 0 ? eligible : [SPECIES[0]!];
		const weights = pool.map((species) => RARITY_WEIGHT[species.rarity] * rod.rarityMultiplier);
		const totalWeight = weights.reduce((sum, weight) => sum + weight, 0);
		const chosen = this.pickWeighted(pool, weights, totalWeight);

		const weightSpan = chosen.maxWeightGrams - chosen.minWeightGrams;
		const lengthSpan = chosen.maxLengthCm - chosen.minLengthCm;
		const weightGrams = Math.round(chosen.minWeightGrams + this.rng.next() * weightSpan);
		const lengthCm = Math.round((chosen.minLengthCm + this.rng.next() * lengthSpan) * 10) / 10;
		const rating = computeRating(chosen, { weightGrams, lengthCm }, rod);

		return {
			id: `fish-${this.clock.now()}-${++this.fishSeq}-${Math.floor(this.rng.next() * 1_000_000)}`,
			speciesId: chosen.id,
			weightGrams,
			lengthCm,
			rating,
			caughtAt: this.clock.now(),
			sold: false,
			location: "inventory",
		};
	}

	private pickWeighted(pool: Species[], weights: number[], totalWeight: number): Species {
		let roll = this.rng.next() * totalWeight;
		for (let i = 0; i < pool.length; i += 1) {
			roll -= weights[i]!;
			if (roll <= 0) return pool[i]!;
		}
		return pool[pool.length - 1]!;
	}

	private updateCollection(fish: FishInstance, species: Species): void {
		const entry = this.state.collection.find((candidate) => candidate.speciesId === species.id);
		if (!entry) {
			this.state.collection.push({
				speciesId: species.id,
				catches: 1,
				maxWeightGrams: fish.weightGrams,
				maxLengthCm: fish.lengthCm,
			});
			return;
		}
		entry.catches += 1;
		entry.maxWeightGrams = Math.max(entry.maxWeightGrams, fish.weightGrams);
		entry.maxLengthCm = Math.max(entry.maxLengthCm, fish.lengthCm);
	}

	private baitThreshold(rod: Rod): number {
		if (rod.id === "bamboo" && this.baitTokensPerCastOverride !== undefined) {
			return this.baitTokensPerCastOverride;
		}
		return rod.baitTokensPerCast;
	}

	private emit(effects: GameEffect[], text: string, level: "info" | "warning" | "error"): void {
		effects.push({ type: "EventLine", text, level });
		this.state.lastEventText = text;
	}
}

function formatWeight(grams: number): string {
	return grams >= 1000 ? `${(grams / 1000).toFixed(grams % 1000 === 0 ? 0 : 1)}kg` : `${grams}g`;
}

function formatLength(cm: number): string {
	return `${cm}cm`;
}
