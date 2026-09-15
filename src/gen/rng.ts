/**
 * 生成器工具：确定性随机、金额（分）运算、时间分布
 *
 * 关键设计：使用「确定性伪随机」（mulberry32），而非 Math.random()。
 * 原因（对应计划 5.2 节验收清单）：
 *   实验的对照组必须共用同一份数据快照，否则 A/B 对比不成立。
 *   固定 seed 让"生成 100 万订单"这件事可完全复现。
 */

/** 确定性 PRNG（mulberry32）。同一 seed 必然产生同一序列 */
export function createRng(seed: number): () => number {
  let a = seed >>> 0;
  return function next(): number {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export class Rng {
  private readonly next: () => number;

  constructor(seed: number) {
    this.next = createRng(seed);
  }

  /** [0,1) */
  float(): number {
    return this.next();
  }

  /** [min, max] 闭区间整数 */
  int(min: number, max: number): number {
    return Math.floor(this.next() * (max - min + 1)) + min;
  }

  /** [min, max) 浮点 */
  range(min: number, max: number): number {
    return min + this.next() * (max - min);
  }

  bool(p = 0.5): boolean {
    return this.next() < p;
  }

  /** 按权重选索引 */
  weightedIndex(weights: number[]): number {
    const total = weights.reduce((a, b) => a + b, 0);
    let r = this.next() * total;
    for (let i = 0; i < weights.length; i++) {
      r -= weights[i];
      if (r < 0) return i;
    }
    return weights.length - 1;
  }

  pick<T>(arr: readonly T[]): T {
    return arr[Math.floor(this.next() * arr.length)];
  }

  /**
   * 对数正态分布（用于价格）：让"低价商品多、高价商品少"更真实。
   * 返回 [0,1) 的偏斜值，mean 附近密集。
   */
  logNormal(sigma = 0.8): number {
    // Box-Muller
    const u1 = Math.max(this.next(), 1e-12);
    const u2 = this.next();
    const z = Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
    return Math.exp(z * sigma);
  }

  /** 洗牌（原地） */
  shuffle<T>(arr: T[]): T[] {
    for (let i = arr.length - 1; i > 0; i--) {
      const j = Math.floor(this.next() * (i + 1));
      [arr[i], arr[j]] = [arr[j], arr[i]];
    }
    return arr;
  }
}

// ---------------------------------------------------------------------
// 金额：一律以「分」为整数运算，避免浮点误差
// ---------------------------------------------------------------------

export const toCents = (v: string | number): number => Math.round(Number(v) * 100);

/** 分 → '1234.56' 字符串（LOAD DATA / SQL 均用此格式） */
export const fromCents = (cents: number): string => (cents / 100).toFixed(2);

// ---------------------------------------------------------------------
// 时间分布
// ---------------------------------------------------------------------

export type TimePattern = 'uniform' | 'diurnal' | 'flashsale';

/**
 * 电商作息曲线（24 小时相对权重，下标 = 小时）。
 * 双峰：午间 11-13、晚间 19-22，凌晨极低。
 * 依据：计划 4.2 节 —— order_time 必须模拟真实作息，
 *       否则窗口函数与分区裁剪实验的数据过于理想化，结论没有说服力。
 */
const DIURNAL_WEIGHTS = [
  2, 1, 1, 1, 1, 2, 5, 10, 20, 35, 55, 80, // 00-11
  75, 60, 55, 60, 70, 85, 100, 110, 95, 70, 35, 12, // 12-23
];

const DIURNAL_TOTAL = DIURNAL_WEIGHTS.reduce((a, b) => a + b, 0);
const DIURNAL_CDF: number[] = (() => {
  const cdf: number[] = [];
  let acc = 0;
  for (const w of DIURNAL_WEIGHTS) {
    acc += w / DIURNAL_TOTAL;
    cdf.push(acc);
  }
  return cdf;
})();

/** 按作息曲线采样"当天内的小时+分钟+秒"（返回毫秒偏移，范围 [0, 86400000)） */
export function sampleDiurnalOffset(rng: Rng, pattern: TimePattern): number {
  let hourFloat: number;

  if (pattern === 'uniform') {
    hourFloat = rng.float() * 24;
  } else {
    // 反变换采样：先按权重选小时，再在该小时内均匀取分秒
    const r = rng.float();
    let hour = 23;
    for (let i = 0; i < DIURNAL_CDF.length; i++) {
      if (r < DIURNAL_CDF[i]) {
        hour = i;
        break;
      }
    }
    hourFloat = hour + rng.float();
  }

  if (pattern === 'flashsale' && rng.bool(0.12)) {
    // 促销尖峰：12% 的订单集中在 20:00-21:00（大促时段）
    hourFloat = 20 + rng.float();
  }

  return Math.floor(hourFloat * 3_600_000);
}

/**
 * 生成一个"落在 [startMs, endMs) 区间内、遵循作息曲线"的虚拟时间戳。
 *
 * 做法：先按天随机选一天（可加新近度偏置），再在当天按作息曲线取时刻。
 * 这样既保证时间分布真实，又保证整体均匀覆盖整个区间。
 */
export function sampleEventTime(
  rng: Rng,
  startMs: number,
  endMs: number,
  pattern: TimePattern,
  recencyBias = 0,
): number {
  const span = endMs - startMs;
  if (span <= 0) return startMs;

  // 选天：recencyBias > 0 时偏向区间末尾（越靠近今天越密）
  let dayFrac: number;
  if (recencyBias > 0) {
    dayFrac = Math.pow(rng.float(), 1 + recencyBias);
  } else {
    dayFrac = rng.float();
  }

  const base = startMs + dayFrac * span;
  const dayStart = Math.floor(base / 86_400_000) * 86_400_000;
  const offset = sampleDiurnalOffset(rng, pattern);
  const t = dayStart + offset;

  // 严格收敛到区间内，避免跨天溢出
  if (t < startMs) return startMs + Math.floor(rng.float() * Math.min(span, 86_400_000));
  if (t >= endMs) return endMs - 1;
  return t;
}

// ---------------------------------------------------------------------
// 手机号 / 用户名
// ---------------------------------------------------------------------

const PHONE_HEADS = ['13', '15', '17', '18', '19'];

export function randomPhone(rng: Rng): string {
  let tail = '';
  for (let i = 0; i < 9; i++) tail += rng.int(0, 9);
  return rng.pick(PHONE_HEADS) + tail;
}

// ---------------------------------------------------------------------
// 并发分片工具
// ---------------------------------------------------------------------

/**
 * 把 [0, total) 均分成 shards 份，返回每份的 [start, end)。
 * 用于批量生成器的多分片并行。
 */
export function splitRanges(total: number, shards: number): [number, number][] {
  const out: [number, number][] = [];
  const per = Math.ceil(total / shards);
  for (let s = 0; s < shards; s++) {
    const start = s * per;
    if (start >= total) break;
    out.push([start, Math.min(start + per, total)]);
  }
  return out;
}

/** 简单的并发限流执行器 */
export async function mapLimit<T, R>(
  items: T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let cursor = 0;

  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (;;) {
      const i = cursor++;
      if (i >= items.length) return;
      results[i] = await fn(items[i], i);
    }
  });

  await Promise.all(workers);
  return results;
}

/** 格式化字节数 */
export function humanBytes(n: number): string {
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let v = n;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v.toFixed(1)}${units[i]}`;
}

/** 格式化耗时 */
export function humanDuration(ms: number): string {
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m${s % 60}s`;
  return `${Math.floor(m / 60)}h${m % 60}m`;
}
