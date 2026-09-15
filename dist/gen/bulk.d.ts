import { SizeProfile } from '../config';
import { RangeFilter } from './range-filter';
export interface BulkOptions {
    profile: SizeProfile;
    startMs: number;
    endMs: number;
    pattern: 'uniform' | 'diurnal' | 'flashsale';
    shards: number;
    seed: number;
    tmpDir: string;
    keepTsv: boolean;
    recreate: boolean;
    priceChangePerProduct: number;
    priceChangeProductFilter?: RangeFilter;
    withStockChange: boolean;
    logIntervalMs: number;
}
export interface BulkResult {
    database: string;
    sizeKey: string;
    rows: Record<string, number>;
    elapsedMs: number;
    tsvBytes: number;
}
export declare function runBulk(opts: BulkOptions): Promise<BulkResult>;
