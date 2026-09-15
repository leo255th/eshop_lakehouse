export declare function randInt(min: number, max: number): number;
export declare function weightedIndex(weights: number[]): number;
export declare function pick<T>(arr: readonly T[]): T;
export declare function pickN<T>(arr: readonly T[], n: number): T[];
export declare function chance(p: number): boolean;
export declare const toCents: (s: string | number) => number;
export declare const fromCents: (cents: number) => string;
export declare function randomPhone(): string;
