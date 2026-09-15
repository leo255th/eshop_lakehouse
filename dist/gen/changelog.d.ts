import { SizeProfile } from '../config';
import { RangeFilter } from './range-filter';
export type ReplayMode = 'stream' | 'batch';
export interface ChangelogOptions {
    profile: SizeProfile;
    replayMode?: ReplayMode;
    batchChunk?: number;
    dropFinalRecords?: boolean;
    startMs: number;
    priceChangesPerProduct: number;
    categoryChangeProb: number;
    brandChangeProb: number;
    offShelfProb: number;
    maxTotalChanges: number;
    maxRuntimeSec: number;
    ratePerSecond: number;
    logEverySec: number;
    seed: number;
    productFilter?: RangeFilter;
}
export declare function runChangelog(opts: ChangelogOptions): Promise<void>;
