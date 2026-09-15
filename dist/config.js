"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.config = exports.GEAR_WEIGHTS = exports.GEARS = exports.SIZE_PROFILES = exports.SIZE_KEYS = void 0;
exports.parseSize = parseSize;
function env(key, fallback) {
    const v = process.env[key];
    return v === undefined || v === '' ? fallback : v;
}
function int(key, fallback) {
    const v = parseInt(env(key, String(fallback)), 10);
    return Number.isFinite(v) ? v : fallback;
}
function num(key, fallback) {
    const v = parseFloat(env(key, String(fallback)));
    return Number.isFinite(v) ? v : fallback;
}
function bool(key, fallback) {
    const v = env(key, String(fallback)).toLowerCase();
    return v === 'true' || v === '1' || v === 'yes';
}
exports.SIZE_KEYS = ['1m', '10m', '100m'];
exports.SIZE_PROFILES = {
    '1m': {
        key: '1m',
        orders: 1_000_000,
        database: 'eshop_1m',
        users: 100_000,
        products: 5_000,
        days: 31,
        label: '100万订单',
    },
    '10m': {
        key: '10m',
        orders: 10_000_000,
        database: 'eshop_10m',
        users: 1_000_000,
        products: 20_000,
        days: 31,
        label: '1000万订单',
    },
    '100m': {
        key: '100m',
        orders: 100_000_000,
        database: 'eshop_100m',
        users: 5_000_000,
        products: 50_000,
        days: 31,
        label: '1亿订单',
    },
};
function parseSize(raw) {
    const s = raw.trim().toLowerCase().replace(/[_\s]/g, '');
    if (s in exports.SIZE_PROFILES)
        return exports.SIZE_PROFILES[s];
    throw new Error(`未知规模 "${raw}"，可用值：${exports.SIZE_KEYS.join(' | ')} ` +
        `（1m=100万, 10m=1000万, 100m=1亿；注意 "m" 表示百万）`);
}
exports.GEARS = {
    low: { minMs: 600, maxMs: 1200 },
    medium: { minMs: 250, maxMs: 500 },
    high: { minMs: 80, maxMs: 150 },
};
exports.GEAR_WEIGHTS = [
    'low',
    'low',
    'medium',
    'medium',
    'medium',
    'high',
    'high',
    'high',
];
exports.config = {
    db: {
        host: env('DB_HOST', 'localhost'),
        port: int('DB_PORT', 3307),
        user: env('DB_USER', 'root'),
        password: env('DB_PASSWORD', '123456'),
        database: env('DB_NAME', 'eshop'),
        timezone: env('DB_TZ', '+08:00'),
        connectionLimit: int('DB_CONN_LIMIT', 10),
        loadConnections: int('DB_LOAD_CONNECTIONS', 4),
    },
    schema: {
        autoCreate: bool('AUTO_SCHEMA', true),
        resetOnStart: bool('RESET_ON_START', false),
    },
    clock: {
        epoch: env('SIM_EPOCH', ''),
        scale: num('SIM_TIME_SCALE', 1),
    },
    seed: {
        enabled: bool('SEED_ON_START', true),
        users: int('SEED_USERS', 1000),
        products: int('SEED_PRODUCTS', 200),
        categories: 8,
    },
    backfill: {
        enabled: bool('ENABLE_BACKFILL', false),
        hours: int('BACKFILL_HOURS', 12),
        ratePerSecond: num('BACKFILL_RATE', 0.5),
        maxOrders: int('BACKFILL_MAX_ORDERS', 50000),
    },
    gen: {
        batchRows: int('GEN_BATCH_ROWS', 20000),
        shards: int('GEN_SHARDS', 4),
        itemCountWeights: [50, 30, 20],
        qtyWeights: [40, 30, 20, 7, 3],
        pattern: env('GEN_PATTERN', 'diurnal'),
        lateRatio: num('GEN_LATE_RATIO', 0),
        lateMaxSec: int('GEN_LATE_MAX_SEC', 60),
        streamJitterMs: int('GEN_STREAM_JITTER_MS', 60_000),
        seed: int('GEN_SEED', 20251001),
        tmpDir: env('GEN_TMP_DIR', '/tmp/eshop-gen'),
        keepTsv: bool('GEN_KEEP_TSV', false),
        cancelRatio: num('GEN_CANCEL_RATIO', 0.08),
        priceChangePerProduct: num('GEN_PRICE_CHANGE_PER_PRODUCT', 3),
    },
    churn: {
        priceAdjustPerHour: num('CHURN_PRICE_ADJUST_PER_HOUR', 1200),
        statusFlowPerHour: num('CHURN_STATUS_FLOW_PER_HOUR', 6000),
        cancelPerHour: num('CHURN_CANCEL_PER_HOUR', 800),
        cleanPerHour: num('CHURN_CLEAN_PER_HOUR', 400),
        maxPerSecond: num('CHURN_MAX_PER_SECOND', 300),
    },
    tasks: {
        order: {
            enabled: bool('ENABLE_ORDER_GENERATOR', true),
            decrementStock: bool('DECREMENT_STOCK', true),
        },
        statusFlow: {
            enabled: bool('ENABLE_STATUS_FLOW', true),
            intervalMs: int('STATUS_FLOW_INTERVAL_MS', 1000),
            batch: int('STATUS_FLOW_BATCH', 40),
            sampleRange: int('STATUS_FLOW_SAMPLE_RANGE', 200),
        },
        canceler: {
            enabled: bool('ENABLE_CANCELER', true),
            intervalMs: int('CANCELER_INTERVAL_MS', 2000),
            batch: int('CANCELER_BATCH', 50),
            cancelProb: num('CANCELER_PROB', 0.02),
            sampleRange: int('CANCELER_SAMPLE_RANGE', 200),
        },
        priceAdjust: {
            enabled: bool('ENABLE_PRICE_ADJUSTER', true),
            intervalMs: int('PRICE_ADJUSTER_INTERVAL_MS', 5000),
            minBatch: int('PRICE_ADJUST_MIN', 3),
            maxBatch: int('PRICE_ADJUST_MAX', 8),
        },
        userUpdate: {
            enabled: bool('ENABLE_USER_UPDATER', true),
            intervalMs: int('USER_UPDATER_INTERVAL_MS', 8000),
            batch: int('USER_UPDATER_BATCH', 3),
            samplePool: int('USER_UPDATER_SAMPLE_POOL', 50000),
        },
        cleaner: {
            enabled: bool('ENABLE_CLEANER', true),
            intervalMs: int('CLEANER_INTERVAL_MS', 10000),
            maxBatch: int('DELETE_MAX_BATCH', 500),
            softDelete: bool('CLEANER_SOFT_DELETE', true),
            cancelledOrderMinutes: int('DELETE_CANCELLED_ORDER_MIN', 2),
            userMinutes: int('DELETE_USER_MIN', 10),
            productMinutes: int('DELETE_PRODUCT_MIN', 10),
        },
    },
    gears: {
        switchMs: int('GEAR_SWITCH_MS', 120000),
    },
    http: {
        port: int('PORT', 3000),
    },
};
//# sourceMappingURL=config.js.map