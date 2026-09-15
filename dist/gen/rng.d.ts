export declare function createRng(seed: number): () => number;
export declare class Rng {
    private readonly next;
    constructor(seed: number);
    float(): number;
    int(min: number, max: number): number;
    range(min: number, max: number): number;
    bool(p?: number): boolean;
    weightedIndex(weights: number[]): number;
    pick<T>(arr: readonly T[]): T;
    logNormal(sigma?: number): number;
    shuffle<T>(arr: T[]): T[];
}
export declare const toCents: (v: string | number) => number;
export declare const fromCents: (cents: number) => string;
export type TimePattern = 'uniform' | 'diurnal' | 'flashsale';
export declare function sampleDiurnalOffset(rng: Rng, pattern: TimePattern): number;
export declare function sampleEventTime(rng: Rng, startMs: number, endMs: number, pattern: TimePattern, recencyBias?: number): number;
export declare function randomPhone(rng: Rng): string;
export declare function splitRanges(total: number, shards: number): [number, number][];
export declare function mapLimit<T, R>(items: T[], limit: number, fn: (item: T, index: number) => Promise<R>): Promise<R[]>;
export declare function humanBytes(n: number): string;
export declare function humanDuration(ms: number): string;
