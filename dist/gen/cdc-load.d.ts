import { Clock } from '../clock/clock.service';
export interface CdcLoadOptions {
    database: string;
    ratePerSecond: number;
    durationSec: number;
    batchSize?: number;
    logEverySec?: number;
    clock: Clock;
}
export interface CdcLoadResult {
    database: string;
    rowsInserted: number;
    firstId: number;
    lastId: number;
    targetRate: number;
    actualRate: number;
    wallSec: number;
    batchSize: number;
    startedAt: string;
    endedAt: string;
    maxBehindMs: number;
}
export declare function runCdcReset(opts: {
    database: string;
}): Promise<void>;
export declare function runCdcLoad(opts: CdcLoadOptions): Promise<CdcLoadResult>;
