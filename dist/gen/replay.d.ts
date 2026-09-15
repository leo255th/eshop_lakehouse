import { SizeProfile } from '../config';
import { RangeFilter } from './range-filter';
export interface ReplayOptions {
    profile: SizeProfile;
    startMs: number;
    ordersPerDay: number;
    timeScale: number;
    withChurn: boolean;
    batchRows: number;
    logEverySec: number;
    maxRuntimeSec: number;
    seed: number;
    burstEverySec: number;
    burstMultiplier: number;
    burstDurationSec: number;
    orderIdFilter?: RangeFilter;
    churnOrderFilter?: RangeFilter;
    churnProductFilter?: RangeFilter;
}
export declare function runReplay(opts: ReplayOptions): Promise<void>;
