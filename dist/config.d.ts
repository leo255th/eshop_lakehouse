export type SizeKey = '1m' | '10m' | '100m';
export declare const SIZE_KEYS: SizeKey[];
export interface SizeProfile {
    key: SizeKey;
    orders: number;
    database: string;
    users: number;
    products: number;
    days: number;
    label: string;
}
export declare const SIZE_PROFILES: Record<SizeKey, SizeProfile>;
export declare function parseSize(raw: string): SizeProfile;
export interface GearRange {
    minMs: number;
    maxMs: number;
}
export type GearName = 'low' | 'medium' | 'high';
export declare const GEARS: Record<GearName, GearRange>;
export declare const GEAR_WEIGHTS: GearName[];
export declare const config: {
    db: {
        host: string;
        port: number;
        user: string;
        password: string;
        database: string;
        timezone: string;
        connectionLimit: number;
        loadConnections: number;
    };
    schema: {
        autoCreate: boolean;
        resetOnStart: boolean;
    };
    clock: {
        epoch: string;
        scale: number;
    };
    seed: {
        enabled: boolean;
        users: number;
        products: number;
        categories: number;
    };
    backfill: {
        enabled: boolean;
        hours: number;
        ratePerSecond: number;
        maxOrders: number;
    };
    gen: {
        batchRows: number;
        shards: number;
        itemCountWeights: number[];
        qtyWeights: number[];
        pattern: "uniform" | "diurnal" | "flashsale";
        lateRatio: number;
        lateMaxSec: number;
        streamJitterMs: number;
        seed: number;
        tmpDir: string;
        keepTsv: boolean;
        cancelRatio: number;
        priceChangePerProduct: number;
    };
    churn: {
        priceAdjustPerHour: number;
        statusFlowPerHour: number;
        cancelPerHour: number;
        cleanPerHour: number;
        maxPerSecond: number;
    };
    tasks: {
        order: {
            enabled: boolean;
            decrementStock: boolean;
        };
        statusFlow: {
            enabled: boolean;
            intervalMs: number;
            batch: number;
            sampleRange: number;
        };
        canceler: {
            enabled: boolean;
            intervalMs: number;
            batch: number;
            cancelProb: number;
            sampleRange: number;
        };
        priceAdjust: {
            enabled: boolean;
            intervalMs: number;
            minBatch: number;
            maxBatch: number;
        };
        userUpdate: {
            enabled: boolean;
            intervalMs: number;
            batch: number;
            samplePool: number;
        };
        cleaner: {
            enabled: boolean;
            intervalMs: number;
            maxBatch: number;
            softDelete: boolean;
            cancelledOrderMinutes: number;
            userMinutes: number;
            productMinutes: number;
        };
    };
    gears: {
        switchMs: number;
    };
    http: {
        port: number;
    };
};
