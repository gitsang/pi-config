import {
	createInitialState,
	CURRENT_STATE_VERSION,
	type AquariumState,
	type CollectionEntry,
	type FishInstance,
	type GameState,
	type RodState,
} from "../core/game-state.ts";

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

function toFiniteNumber(value: unknown, fallback: number): number {
	return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function toStringValue(value: unknown, fallback: string): string {
	return typeof value === "string" ? value : fallback;
}

function toBooleanValue(value: unknown, fallback: boolean): boolean {
	return typeof value === "boolean" ? value : fallback;
}

function normalizeFish(value: unknown): FishInstance | undefined {
	if (!isRecord(value)) return undefined;
	if (typeof value.id !== "string") return undefined;
	return {
		id: value.id,
		speciesId: toStringValue(value.speciesId, "carp"),
		weightGrams: toFiniteNumber(value.weightGrams, 0),
		lengthCm: toFiniteNumber(value.lengthCm, 0),
		rating: toFiniteNumber(value.rating, 0),
		caughtAt: toFiniteNumber(value.caughtAt, 0),
		sold: toBooleanValue(value.sold, false),
		location: value.location === "aquarium" ? "aquarium" : "inventory",
	};
}

function normalizeRodState(value: unknown): RodState | undefined {
	if (!isRecord(value)) return undefined;
	if (typeof value.rodId !== "string") return undefined;
	return {
		rodId: value.rodId,
		level: Math.max(1, Math.round(toFiniteNumber(value.level, 1))),
	};
}

function normalizeAquariumState(value: unknown): AquariumState | undefined {
	if (!isRecord(value)) return undefined;
	if (typeof value.aquariumId !== "string") return undefined;
	return {
		aquariumId: value.aquariumId,
		capacity: Math.max(1, Math.round(toFiniteNumber(value.capacity, 1))),
		fish: Array.isArray(value.fish)
			? value.fish.map(normalizeFish).filter((fish): fish is FishInstance => fish !== undefined)
			: [],
	};
}

function normalizeCollectionEntry(value: unknown): CollectionEntry | undefined {
	if (!isRecord(value)) return undefined;
	if (typeof value.speciesId !== "string") return undefined;
	return {
		speciesId: value.speciesId,
		catches: Math.max(0, Math.round(toFiniteNumber(value.catches, 0))),
		maxWeightGrams: toFiniteNumber(value.maxWeightGrams, 0),
		maxLengthCm: toFiniteNumber(value.maxLengthCm, 0),
	};
}

function normalizeState(raw: Record<string, unknown>): GameState {
	const base = createInitialState();
	const rawStats = isRecord(raw.stats) ? raw.stats : {};
	const stats = {
		totalCatches: Math.max(0, Math.round(toFiniteNumber(rawStats.totalCatches, base.stats.totalCatches))),
		totalSales: Math.max(0, Math.round(toFiniteNumber(rawStats.totalSales, base.stats.totalSales))),
		totalCoinsEarned: Math.max(0, toFiniteNumber(rawStats.totalCoinsEarned, base.stats.totalCoinsEarned)),
		totalCoinsSpent: Math.max(0, toFiniteNumber(rawStats.totalCoinsSpent, base.stats.totalCoinsSpent)),
		totalBaitTokensUsed: Math.max(0, toFiniteNumber(rawStats.totalBaitTokensUsed, base.stats.totalBaitTokensUsed)),
		rareCatches: Math.max(0, Math.round(toFiniteNumber(rawStats.rareCatches, base.stats.rareCatches))),
	};

	const ownedRods = Array.isArray(raw.ownedRods)
		? raw.ownedRods.map(normalizeRodState).filter((rod): rod is RodState => rod !== undefined)
		: base.ownedRods;

	const aquariums = Array.isArray(raw.aquariums)
		? raw.aquariums.map(normalizeAquariumState).filter((aquarium): aquarium is AquariumState => aquarium !== undefined)
		: [];

	const inventory = Array.isArray(raw.inventory)
		? raw.inventory.map(normalizeFish).filter((fish): fish is FishInstance => fish !== undefined)
		: [];

	const collection = Array.isArray(raw.collection)
		? raw.collection.map(normalizeCollectionEntry).filter((entry): entry is CollectionEntry => entry !== undefined)
		: [];

	return {
		version: CURRENT_STATE_VERSION,
		uiVisible: toBooleanValue(raw.uiVisible, base.uiVisible),
		coins: Math.max(0, Math.round(toFiniteNumber(raw.coins, base.coins))),
		totalTokensConsumed: Math.max(0, toFiniteNumber(raw.totalTokensConsumed, base.totalTokensConsumed)),
		pendingBaitTokens: Math.max(0, toFiniteNumber(raw.pendingBaitTokens, base.pendingBaitTokens)),
		equippedRodId: toStringValue(raw.equippedRodId, base.equippedRodId),
		ownedRods: ownedRods.length > 0 ? ownedRods : base.ownedRods,
		aquariums,
		inventory,
		collection,
		stats,
		inventoryCapacity: Math.max(1, Math.round(toFiniteNumber(raw.inventoryCapacity, base.inventoryCapacity))),
		lastEventText: toStringValue(raw.lastEventText, base.lastEventText),
	};
}

export function migrateState(raw: unknown): GameState {
	if (!isRecord(raw)) return createInitialState();

	const version = typeof raw.version === "number" && Number.isFinite(raw.version) ? Math.floor(raw.version) : 1;
	if (version >= CURRENT_STATE_VERSION) {
		return normalizeState(raw);
	}

	// 未来版本迁移链从这里开始：
	// if (version === 1) raw = migrateV1ToV2(raw);
	return normalizeState(raw);
}
