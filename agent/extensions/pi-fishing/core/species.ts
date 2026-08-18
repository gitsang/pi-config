import type { Rarity, SpeciesId } from "./game-state.ts";

export interface Species {
	id: SpeciesId;
	name: string;
	emoji: string;
	rarity: Rarity;
	minWeightGrams: number;
	maxWeightGrams: number;
	minLengthCm: number;
	maxLengthCm: number;
	baseValue: number;
	requiredRodId: string;
	aquariumCompatible: boolean;
}

export const SPECIES: Species[] = [
	{
		id: "carp",
		name: "鲫鱼",
		emoji: "🐟",
		rarity: "common",
		minWeightGrams: 200,
		maxWeightGrams: 800,
		minLengthCm: 15,
		maxLengthCm: 30,
		baseValue: 12,
		requiredRodId: "bamboo",
		aquariumCompatible: true,
	},
	{
		id: "crucian",
		name: "鲤鱼",
		emoji: "🐠",
		rarity: "common",
		minWeightGrams: 500,
		maxWeightGrams: 1500,
		minLengthCm: 20,
		maxLengthCm: 40,
		baseValue: 20,
		requiredRodId: "bamboo",
		aquariumCompatible: true,
	},
	{
		id: "bass",
		name: "鲈鱼",
		emoji: "🐟",
		rarity: "uncommon",
		minWeightGrams: 800,
		maxWeightGrams: 2500,
		minLengthCm: 30,
		maxLengthCm: 55,
		baseValue: 45,
		requiredRodId: "carbon",
		aquariumCompatible: true,
	},
	{
		id: "trout",
		name: "鳟鱼",
		emoji: "🐠",
		rarity: "uncommon",
		minWeightGrams: 600,
		maxWeightGrams: 1800,
		minLengthCm: 25,
		maxLengthCm: 45,
		baseValue: 50,
		requiredRodId: "carbon",
		aquariumCompatible: true,
	},
	{
		id: "catfish",
		name: "鲶鱼",
		emoji: "🐡",
		rarity: "rare",
		minWeightGrams: 2000,
		maxWeightGrams: 6000,
		minLengthCm: 40,
		maxLengthCm: 80,
		baseValue: 120,
		requiredRodId: "long_cast",
		aquariumCompatible: true,
	},
	{
		id: "mandarin",
		name: "鳜鱼",
		emoji: "🐟",
		rarity: "rare",
		minWeightGrams: 1000,
		maxWeightGrams: 3500,
		minLengthCm: 30,
		maxLengthCm: 60,
		baseValue: 150,
		requiredRodId: "long_cast",
		aquariumCompatible: true,
	},
	{
		id: "koi",
		name: "锦鲤",
		emoji: "🐠",
		rarity: "epic",
		minWeightGrams: 1500,
		maxWeightGrams: 5000,
		minLengthCm: 35,
		maxLengthCm: 70,
		baseValue: 400,
		requiredRodId: "golden",
		aquariumCompatible: true,
	},
	{
		id: "arowana",
		name: "龙鱼",
		emoji: "🐉",
		rarity: "legendary",
		minWeightGrams: 3000,
		maxWeightGrams: 9000,
		minLengthCm: 50,
		maxLengthCm: 90,
		baseValue: 1200,
		requiredRodId: "golden",
		aquariumCompatible: true,
	},
];

const SPECIES_BY_ID = new Map<string, Species>(SPECIES.map((species) => [species.id, species]));

export function getSpecies(id: SpeciesId): Species | undefined {
	return SPECIES_BY_ID.get(id);
}

export function getSpeciesOrThrow(id: SpeciesId): Species {
	const species = getSpecies(id);
	if (!species) throw new Error(`Unknown species: ${id}`);
	return species;
}
