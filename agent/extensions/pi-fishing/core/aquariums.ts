import type { AquariumId, SpeciesId } from "./game-state.ts";

export interface Aquarium {
	id: AquariumId;
	name: string;
	emoji: string;
	basePrice: number;
	baseCapacity: number;
	maxCapacity: number;
	upgradeBasePrice: number;
	allowedSpecies: SpeciesId[];
	breedingIntervalMs: number;
}

export const AQUARIUMS: Aquarium[] = [
	{
		id: "small",
		name: "小型鱼缸",
		emoji: "🐠",
		basePrice: 200,
		baseCapacity: 3,
		maxCapacity: 6,
		upgradeBasePrice: 100,
		allowedSpecies: ["carp", "crucian"],
		breedingIntervalMs: 60 * 60 * 1000,
	},
	{
		id: "medium",
		name: "中型鱼缸",
		emoji: "🐟",
		basePrice: 600,
		baseCapacity: 5,
		maxCapacity: 10,
		upgradeBasePrice: 260,
		allowedSpecies: ["carp", "crucian", "bass", "trout"],
		breedingIntervalMs: 45 * 60 * 1000,
	},
	{
		id: "large",
		name: "大型鱼缸",
		emoji: "🐡",
		basePrice: 1500,
		baseCapacity: 8,
		maxCapacity: 16,
		upgradeBasePrice: 600,
		allowedSpecies: ["carp", "crucian", "bass", "trout", "catfish", "mandarin", "koi", "arowana"],
		breedingIntervalMs: 30 * 60 * 1000,
	},
];

const AQUARIUMS_BY_ID = new Map<string, Aquarium>(AQUARIUMS.map((aquarium) => [aquarium.id, aquarium]));

export function getAquarium(id: AquariumId): Aquarium | undefined {
	return AQUARIUMS_BY_ID.get(id);
}

export function getAquariumOrThrow(id: AquariumId): Aquarium {
	const aquarium = getAquarium(id);
	if (!aquarium) throw new Error(`Unknown aquarium: ${id}`);
	return aquarium;
}
