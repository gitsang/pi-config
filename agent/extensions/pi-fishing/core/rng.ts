export interface Rng {
	/** Return a floating-point number in [0, 1). */
	next(): number;
}

export class MathRng implements Rng {
	next(): number {
		return Math.random();
	}
}

/** Deterministic RNG for tests. */
export class SeededRng implements Rng {
	private state: number;

	constructor(seed: number) {
		this.state = seed >>> 0;
	}

	next(): number {
		let t = (this.state += 0x6d2b79f5);
		t = Math.imul(t ^ (t >>> 15), t | 1);
		t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	}
}
