export type SpeciesId = string;
export type RodId = string;
export type AquariumId = string;
export type Rarity = "common" | "uncommon" | "rare" | "epic" | "legendary";
export type FishLocation = "inventory" | "aquarium";

export interface FishInstance {
	id: string;
	speciesId: SpeciesId;
	weightGrams: number;
	lengthCm: number;
	rating: number;
	caughtAt: number;
	sold: boolean;
	location: FishLocation;
}

export interface RodState {
	rodId: RodId;
	level: number;
}

export interface AquariumState {
	aquariumId: AquariumId;
	capacity: number;
	fish: FishInstance[];
}

export interface CollectionEntry {
	speciesId: SpeciesId;
	catches: number;
	maxWeightGrams: number;
	maxLengthCm: number;
}

export interface GameStats {
	totalCatches: number;
	totalSales: number;
	totalCoinsEarned: number;
	totalCoinsSpent: number;
	totalBaitTokensUsed: number;
	rareCatches: number;
}

export interface GameState {
	version: number;
	uiVisible: boolean;
	coins: number;
	totalTokensConsumed: number;
	pendingBaitTokens: number;
	equippedRodId: RodId;
	ownedRods: RodState[];
	aquariums: AquariumState[];
	inventory: FishInstance[];
	collection: CollectionEntry[];
	stats: GameStats;
	inventoryCapacity: number;
	lastEventText: string;
}

export const CURRENT_STATE_VERSION = 1;
export const DEFAULT_INVENTORY_CAPACITY = 10;

export function createInitialState(overrides: Partial<GameState> = {}): GameState {
	const state: GameState = {
		version: CURRENT_STATE_VERSION,
		uiVisible: false,
		coins: 50,
		totalTokensConsumed: 0,
		pendingBaitTokens: 0,
		equippedRodId: "bamboo",
		ownedRods: [{ rodId: "bamboo", level: 1 }],
		aquariums: [],
		inventory: [],
		collection: [],
		stats: {
			totalCatches: 0,
			totalSales: 0,
			totalCoinsEarned: 0,
			totalCoinsSpent: 0,
			totalBaitTokensUsed: 0,
			rareCatches: 0,
		},
		inventoryCapacity: DEFAULT_INVENTORY_CAPACITY,
		lastEventText: "欢迎来到 pi-fishing！消耗 token 自动钓鱼。",
	};

	for (const [key, value] of Object.entries(overrides)) {
		if (value !== undefined) {
			(state as unknown as Record<string, unknown>)[key] = value;
		}
	}

	return state;
}
