/**
 * 统一配置：全部通过环境变量覆盖
 *
 * v2 变化：
 *   1. 新增「数据集规模」概念（100m/10m/100m → 1百万/1千万/1亿）
 *      每个规模对应独立的数据库名，便于三档规模并存、逐层重跑
 *   2. 新增虚拟时钟配置（SIM_EPOCH / SIM_TIME_SCALE）
 *      —— 解决计划 4.0 节的致命 bug：历史数据时间戳不能取机器真实时间
 *   3. 新增批量生成器配置（分片、批大小、时间分布）
 */

function env(key: string, fallback: string): string {
  const v = process.env[key];
  return v === undefined || v === '' ? fallback : v;
}

function int(key: string, fallback: number): number {
  const v = parseInt(env(key, String(fallback)), 10);
  return Number.isFinite(v) ? v : fallback;
}

function num(key: string, fallback: number): number {
  const v = parseFloat(env(key, String(fallback)));
  return Number.isFinite(v) ? v : fallback;
}

function bool(key: string, fallback: boolean): boolean {
  const v = env(key, String(fallback)).toLowerCase();
  return v === 'true' || v === '1' || v === 'yes';
}

// =====================================================================
// 数据集规模定义
// =====================================================================

export type SizeKey = '1m' | '10m' | '100m';

export const SIZE_KEYS: SizeKey[] = ['1m', '10m', '100m'];

export interface SizeProfile {
  key: SizeKey;
  /** 订单数（fact_order 行数） */
  orders: number;
  /** 数据库名 */
  database: string;
  /** 用户数（维表规模随事实表放大，避免单用户热点失真） */
  users: number;
  /** 商品数 */
  products: number;
  /** 默认时间跨度（天） */
  days: number;
  /** 说明 */
  label: string;
}

/**
 * 规模命名约定（★ 2026-09-14 修正）
 *   1m   = 100 万   (1,000,000)      → eshop_1m
 *   10m  = 1000 万  (10,000,000)     → eshop_10m
 *   100m = 1 亿     (100,000,000)    → eshop_100m
 *
 * ⚠️ 历史说明：初版曾把 "100m" 当作 100 万，命名与规模反了（100m/1000m/10000m）。
 *    已统一修正为「数字 + m(百万)」，即 1m/10m/100m 分别对应 1/10/100 个百万。
 */
export const SIZE_PROFILES: Record<SizeKey, SizeProfile> = {
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
    // ★ 2026-09-14 由 90 天改为 31 天：
    //   三档统一为 31 天，使「日均订单密度」可以跨档对比 ——
    //   若各档天数不同（31/90/31），实验 3/6/10 这类跨档对比的结论会被
    //   "单分区数据量不同"污染，无法判断差异来自数据总量还是密度。
    //   统一后：1m=32,258 单/天、10m=322,581 单/天、100m=3,225,806 单/天（严格 10 倍递进）
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

/** 解析规模标识，支持 "1m" / "10m" / "100m" */
export function parseSize(raw: string): SizeProfile {
  const s = raw.trim().toLowerCase().replace(/[_\s]/g, '');
  if (s in SIZE_PROFILES) return SIZE_PROFILES[s as SizeKey];
  throw new Error(
    `未知规模 "${raw}"，可用值：${SIZE_KEYS.join(' | ')} ` +
      `（1m=100万, 10m=1000万, 100m=1亿；注意 "m" 表示百万）`,
  );
}

// =====================================================================
// 主配置
// =====================================================================

export interface GearRange {
  minMs: number;
  maxMs: number;
}

export type GearName = 'low' | 'medium' | 'high';

export const GEARS: Record<GearName, GearRange> = {
  low: { minMs: 600, maxMs: 1200 },
  medium: { minMs: 250, maxMs: 500 },
  high: { minMs: 80, maxMs: 150 },
};

export const GEAR_WEIGHTS: GearName[] = [
  'low',
  'low',
  'medium',
  'medium',
  'medium',
  'high',
  'high',
  'high',
];

export const config = {
  db: {
    host: env('DB_HOST', 'localhost'),
    port: int('DB_PORT', 3307),
    user: env('DB_USER', 'root'),
    password: env('DB_PASSWORD', '123456'),
    /**
     * 库名。默认 eshop（向后兼容）；批量生成时由规模档案覆盖为
     * eshop_100m / eshop_10m / eshop_100m
     */
    database: env('DB_NAME', 'eshop'),
    /** 统一时区：所有 DATETIME 均按该时区落库 */
    timezone: env('DB_TZ', '+08:00'),
    connectionLimit: int('DB_CONN_LIMIT', 10),
    /** 批量导入用的独立连接数（LOAD DATA 并行度） */
    loadConnections: int('DB_LOAD_CONNECTIONS', 4),
  },

  schema: {
    autoCreate: bool('AUTO_SCHEMA', true),
    resetOnStart: bool('RESET_ON_START', false),
  },

  /** 虚拟时钟 —— 所有写入时间必须来自这里，禁止 NOW()/new Date() */
  clock: {
    /**
     * 虚拟时间起点。为空时使用机器真实时间（实时模拟器模式）。
     * 批量生成历史数据时必须设置，例如：
     *   SIM_EPOCH=2025-11-01T00:00:00+08:00
     *     → 历史数据铺在 2025-10-01 ~ 2025-10-31
     *     → replay 模式从 2025-11-01 开始模拟实时
     */
    epoch: env('SIM_EPOCH', ''),
    /** 时间加速倍率：1=实时；3600=1虚拟小时/真实秒 */
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

  /** 批量/回放生成器 */
  gen: {
    /** 每批写入行数（LOAD DATA 的文件分片规模） */
    batchRows: int('GEN_BATCH_ROWS', 20000),
    /** 并行分片数（同时生成+导入的文件数） */
    shards: int('GEN_SHARDS', 4),
    /** 每单明细数分布权重（1/2/3 件） */
    itemCountWeights: [50, 30, 20],
    /** 每明细数量分布权重（1~5 件） */
    qtyWeights: [40, 30, 20, 7, 3],
    /** 时间分布形态 */
    pattern: env('GEN_PATTERN', 'diurnal') as 'uniform' | 'diurnal' | 'flashsale',
    /** 乱序注入比例（实验 9：Watermark / 迟到数据） */
    lateRatio: num('GEN_LATE_RATIO', 0),
    /** 乱序最大延迟秒数 */
    lateMaxSec: int('GEN_LATE_MAX_SEC', 60),
    /**
     * replay 模式下「每个订单的事件时间相对当前虚拟时刻往前抖动的上限」（毫秒）。
     *
     * 语义：事件时间 = 当前虚拟时刻 − random(0, streamJitterMs)
     *   → 0     = 到达顺序严格等于事件时间顺序（**实验 9 的干净基线**）
     *   → 60000 = 默认值，事件时间在最近 60 秒内均匀散开（保留原有行为，不影响已完成的实验）
     *
     * ⚠️ 实验 9（Watermark / 迟到数据）必须显式设置它：
     *    计划里的 watermark 是 5 秒，若抖动仍是 60 秒打底，
     *    几乎所有记录都会被判迟到，0%/2%/5% 三档乱序根本区分不出来。
     *    原来这个值是硬编码在 src/gen/replay.ts 里的，无法做对照实验。
     */
    streamJitterMs: int('GEN_STREAM_JITTER_MS', 60_000),
    /** 随机种子（保证对照组数据可复现） */
    seed: int('GEN_SEED', 20251001),
    /** 临时 TSV 目录 */
    tmpDir: env('GEN_TMP_DIR', '/tmp/eshop-gen'),
    /** 是否在导入后保留 TSV 文件（便于排查 / 重导） */
    keepTsv: bool('GEN_KEEP_TSV', false),
    /** 取消/删除订单的比例（模拟清理器产生 is_deleted=1） */
    cancelRatio: num('GEN_CANCEL_RATIO', 0.08),
    /** 调价次数（每个商品平均调价次数，用于 price_change 流水） */
    priceChangePerProduct: num('GEN_PRICE_CHANGE_PER_PRODUCT', 3),
  },

  /**
   * 变更事件速率（churn）—— replay 模式专用
   *
   * ⚠️ 这些是「每虚拟小时」的产生量，不是每 tick 的批大小。
   *    v2 初版有个 bug：批量大小的计算叠加了 chunk 频率与时间加速倍率，
   *    导致高倍速下变更量暴涨（实测 120x 时 2 秒内就产生 4800 次状态流转，
   *    相当于把整个数据集重写一遍）。改为按虚拟时间的「产量速率」描述。
   */
  churn: {
    /** 每小时调价商品数 */
    priceAdjustPerHour: num('CHURN_PRICE_ADJUST_PER_HOUR', 1200),
    /** 每小时订单状态流转数 */
    statusFlowPerHour: num('CHURN_STATUS_FLOW_PER_HOUR', 6000),
    /** 每小时取消订单数 */
    cancelPerHour: num('CHURN_CANCEL_PER_HOUR', 800),
    /** 每小时逻辑清理订单数（0 = 不清理） */
    cleanPerHour: num('CHURN_CLEAN_PER_HOUR', 400),
    /** 所有变更事件的上限速率（防止高倍速下拖垮源库） */
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
      /** 采样池大小（替代 ORDER BY RAND() 全表扫） */
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
      /** 用户采样池大小（替代全量 ID 缓存，避免 OOM） */
      samplePool: int('USER_UPDATER_SAMPLE_POOL', 50000),
    },
    cleaner: {
      enabled: bool('ENABLE_CLEANER', true),
      intervalMs: int('CLEANER_INTERVAL_MS', 10000),
      maxBatch: int('DELETE_MAX_BATCH', 500),
      /** 逻辑删除（v2 默认）：不物理删，避免历史指标口径漂移 */
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
