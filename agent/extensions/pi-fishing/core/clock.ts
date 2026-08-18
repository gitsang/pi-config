export interface Clock {
	now(): number;
}

export const systemClock: Clock = {
	now(): number {
		return Date.now();
	},
};
