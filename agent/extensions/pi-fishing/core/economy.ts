import type { FishInstance, Rarity } from "./game-state.ts";
import type { Rod } from "./rods.ts";
import type { Species } from "./species.ts";

export function clamp(value: number, min: number, max: number): number {
	return Math.min(max, Math.max(min, value));
}

export function roundCoins(value: number): number {
	return Math.round(value);
}

const RARITY_PRICE_FACTOR: Record<Rarity, number> = {
	common: 1.0,
	uncommon: 1.5,
	rare: 2.5,
	epic: 5.0,
	legendary: 10.0,
};

const RARITY_RATING_SCORE: Record<Rarity, number> = {
	common: 0,
	uncommon: 1,
	rare: 2,
	epic: 3,
	legendary: 4,
};

export function weightFactor(species: Species, weightGrams: number): number {
	const span = species.maxWeightGrams - species.minWeightGrams;
	const ratio = span <= 0 ? 0.5 : (weightGrams - species.minWeightGrams) / span;
	return 0.6 + 0.8 * ratio;
}

export function lengthFactor(species: Species, lengthCm: number): number {
	const span = species.maxLengthCm - species.minLengthCm;
	const ratio = span <= 0 ? 0.5 : (lengthCm - species.minLengthCm) / span;
	return 0.7 + 0.6 * ratio;
}

export function rarityPriceFactor(rarity: Rarity): number {
	return RARITY_PRICE_FACTOR[rarity];
}

export function salePrice(species: Species, fish: FishInstance): number {
	const raw =
		species.baseValue *
		weightFactor(species, fish.weightGrams) *
		lengthFactor(species, fish.lengthCm) *
		rarityPriceFactor(species.rarity);
	return roundCoins(raw);
}

export function computeRating(species: Species, fish: Pick<FishInstance, "weightGrams" | "lengthCm">, rod: Rod): number {
	const weightSpan = species.maxWeightGrams - species.minWeightGrams;
	const lengthSpan = species.maxLengthCm - species.minLengthCm;
	const weightScore = weightSpan <= 0 ? 0.5 : (fish.weightGrams - species.minWeightGrams) / weightSpan;
	const lengthScore = lengthSpan <= 0 ? 0.5 : (fish.lengthCm - species.minLengthCm) / lengthSpan;
	const rarityScore = RARITY_RATING_SCORE[species.rarity];

	return Math.round(
		clamp(50 + weightScore * 20 + lengthScore * 15 + rarityScore * 10 + rod.weightMultiplier * 5, 0, 100),
	);
}

export function gradeFromRating(rating: number): string {
	if (rating >= 90) return "S";
	if (rating >= 80) return "A";
	if (rating >= 65) return "B";
	if (rating >= 50) return "C";
	return "D";
}

export function upgradeRodCost(rod: Rod, currentLevel: number): number {
	return roundCoins(rod.upgradeBasePrice * Math.pow(1.8, currentLevel - 1));
}

export function upgradeAquariumCost(aquarium: { upgradeBasePrice: number }, currentCapacity: number, baseCapacity: number): number {
	return roundCoins(aquarium.upgradeBasePrice * Math.pow(1.7, currentCapacity - baseCapacity));
}

export function rarityScoreValue(rarity: Rarity): number {
	return RARITY_RATING_SCORE[rarity];
}
