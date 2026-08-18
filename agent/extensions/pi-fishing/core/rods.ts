import type { RodId } from "./game-state.ts";

export interface Rod {
	id: RodId;
	name: string;
	emoji: string;
	rank: number;
	basePrice: number;
	upgradeBasePrice: number;
	maxLevel: number;
	rarityMultiplier: number;
	weightMultiplier: number;
	baitTokensPerCast: number;
}

export const RODS: Rod[] = [
	{
		id: "bamboo",
		name: "竹竿",
		emoji: "🎋",
		rank: 1,
		basePrice: 0,
		upgradeBasePrice: 60,
		maxLevel: 5,
		rarityMultiplier: 1.0,
		weightMultiplier: 1.0,
		baitTokensPerCast: 2000,
	},
	{
		id: "carbon",
		name: "碳素竿",
		emoji: "🎣",
		rank: 2,
		basePrice: 300,
		upgradeBasePrice: 180,
		maxLevel: 5,
		rarityMultiplier: 1.5,
		weightMultiplier: 1.1,
		baitTokensPerCast: 1500,
	},
	{
		id: "long_cast",
		name: "远投竿",
		emoji: "🎣",
		rank: 3,
		basePrice: 900,
		upgradeBasePrice: 500,
		maxLevel: 5,
		rarityMultiplier: 2.5,
		weightMultiplier: 1.2,
		baitTokensPerCast: 1200,
	},
	{
		id: "golden",
		name: "黄金竿",
		emoji: "✨",
		rank: 4,
		basePrice: 3000,
		upgradeBasePrice: 1500,
		maxLevel: 5,
		rarityMultiplier: 5.0,
		weightMultiplier: 1.4,
		baitTokensPerCast: 1000,
	},
];

const RODS_BY_ID = new Map<string, Rod>(RODS.map((rod) => [rod.id, rod]));

export function getRod(id: RodId): Rod | undefined {
	return RODS_BY_ID.get(id);
}

export function getRodOrThrow(id: RodId): Rod {
	const rod = getRod(id);
	if (!rod) throw new Error(`Unknown rod: ${id}`);
	return rod;
}

export function getRodRank(id: RodId): number {
	return getRod(id)?.rank ?? Number.POSITIVE_INFINITY;
}
