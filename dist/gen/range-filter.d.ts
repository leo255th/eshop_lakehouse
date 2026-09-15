export interface IdRange {
    min: number;
    max: number;
}
export interface RangeFilter {
    ranges: IdRange[];
    raw: string;
}
export declare const EMPTY_RANGE: RangeFilter;
export declare function parseRange(expr: string | undefined | null): RangeFilter;
export declare function isEmpty(f: RangeFilter | undefined | null): boolean;
export declare function inRange(f: RangeFilter | undefined | null, id: number): boolean;
export declare function rangeSize(f: RangeFilter | undefined | null): number;
export declare function buildSqlCondition(f: RangeFilter | undefined | null, column: string, params: unknown[]): string;
export declare function describe(f: RangeFilter | undefined | null): string;
export declare function randomInRange(f: RangeFilter | undefined | null, fallbackMax: number, rng: {
    int: (min: number, max: number) => number;
}): number;
