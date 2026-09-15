/**
 * 目标范围过滤器
 *
 * 服务于两类实验需求（见 实验数据观察记录指南.md）：
 *   实验 1（CDC Upsert/Delete）：「任选 5 单，记录其状态变更轨迹」
 *   实验 4（快照 vs 当前维度）：「挑 20 个被调过价的商品」
 *
 * 没有范围限定时，只能"事后大海捞针"（跑完变更再去查哪些订单变了），
 * 实验可控性和可复现性都差。有了范围限定就能**主动指定**。
 *
 * =====================================================================
 * 支持的写法（三种可混用，逗号分隔）
 * =====================================================================
 *   枚举   10001,10002,10003            精确指定若干 ID
 *   闭区间 10001-10005                  指定 ID 区间（含两端）
 *   开区间 10001-                       从 10001 到最大
 *           -10005                       从 1 到 10005
 *   混合   10001,10005-10010,20000-     以上任意组合
 *
 * 例：
 *   --target-order-ids=10001,10002,10003,10004,10005
 *   --order-id-range=1000-2000
 *   --target-product-ids=100,200,300-320
 */

export interface IdRange {
  min: number;
  max: number;
}

export interface RangeFilter {
  /** 区间列表（有序、已合并重叠）；为空表示不过滤 */
  ranges: IdRange[];
  /** 原始输入（用于日志展示） */
  raw: string;
}

/** 空过滤器（不过滤任何 ID） */
export const EMPTY_RANGE: RangeFilter = { ranges: [], raw: '' };

/**
 * 解析范围表达式。
 * @throws 表达式非法时抛错（宁可启动时报错，也不要静默忽略过滤条件）
 */
export function parseRange(expr: string | undefined | null): RangeFilter {
  if (!expr || expr.trim() === '') return EMPTY_RANGE;

  const ranges: IdRange[] = [];
  for (const partRaw of expr.split(',')) {
    const part = partRaw.trim();
    if (part === '') continue;

    if (part.includes('-')) {
      // 区间写法（可能是 "100-200" / "100-" / "-200"）
      // 注意：负数 ID 无意义，所以首个 '-' 就是分隔符
      const dashAt = part.indexOf('-');
      const loStr = part.slice(0, dashAt).trim();
      const hiStr = part.slice(dashAt + 1).trim();
      const lo = loStr === '' ? 1 : Number(loStr);
      const hi = hiStr === '' ? Number.MAX_SAFE_INTEGER : Number(hiStr);
      if (!Number.isFinite(lo) || !Number.isFinite(hi)) {
        throw new Error(`范围表达式非法："${part}"（应为 100-200 / 100- / -200）`);
      }
      if (lo > hi) {
        throw new Error(`范围表达式非法："${part}"（下界 ${lo} 大于上界 ${hi}）`);
      }
      ranges.push({ min: lo, max: hi });
    } else {
      const id = Number(part);
      if (!Number.isInteger(id) || id < 1) {
        throw new Error(`范围表达式非法："${part}"（应为正整数 ID）`);
      }
      ranges.push({ min: id, max: id });
    }
  }

  if (ranges.length === 0) return EMPTY_RANGE;

  // 排序 + 合并重叠区间，便于日志展示与 SQL 生成
  ranges.sort((a, b) => a.min - b.min);
  const merged: IdRange[] = [ranges[0]];
  for (let i = 1; i < ranges.length; i++) {
    const last = merged[merged.length - 1];
    const cur = ranges[i];
    if (cur.min <= last.max + 1) {
      last.max = Math.max(last.max, cur.max);
    } else {
      merged.push({ ...cur });
    }
  }

  return { ranges: merged, raw: expr };
}

/** 过滤器是否为空（不过滤） */
export function isEmpty(f: RangeFilter | undefined | null): boolean {
  return !f || f.ranges.length === 0;
}

/** 判断某个 ID 是否在范围内 */
export function inRange(f: RangeFilter | undefined | null, id: number): boolean {
  if (isEmpty(f)) return true;
  for (const r of f!.ranges) {
    if (id >= r.min && id <= r.max) return true;
  }
  return false;
}

/** 范围总容量（用于日志；开区间会返回一个很大的数） */
export function rangeSize(f: RangeFilter | undefined | null): number {
  if (isEmpty(f)) return 0;
  let n = 0;
  for (const r of f!.ranges) {
    n += r.max - r.min + 1;
    if (n > Number.MAX_SAFE_INTEGER / 2) return Number.MAX_SAFE_INTEGER;
  }
  return n;
}

/**
 * 生成 SQL 片段：`AND <col> BETWEEN ? AND ?` 的 OR 组合。
 * 参数按顺序 push 进 params 数组（与 SQL 里的占位符顺序一致）。
 *
 * 例：ranges = [{1,5},{10,10}]  →  "AND (col BETWEEN ? AND ? OR col = ?)"
 */
export function buildSqlCondition(
  f: RangeFilter | undefined | null,
  column: string,
  params: unknown[],
): string {
  if (isEmpty(f)) return '';

  const parts: string[] = [];
  for (const r of f!.ranges) {
    if (r.min === r.max) {
      parts.push(`${column} = ?`);
      params.push(r.min);
    } else if (r.max === Number.MAX_SAFE_INTEGER) {
      parts.push(`${column} >= ?`);
      params.push(r.min);
    } else {
      parts.push(`${column} BETWEEN ? AND ?`);
      params.push(r.min, r.max);
    }
  }
  // 单区间时也要加括号，保持与多区间一致的优先级语义
  return ` AND (${parts.join(' OR ')})`;
}

/** 人可读的展示串 */
export function describe(f: RangeFilter | undefined | null): string {
  if (isEmpty(f)) return '(未限定)';
  return f!.ranges
    .map((r) =>
      r.max === Number.MAX_SAFE_INTEGER
        ? `${r.min}+`
        : r.min === r.max
          ? `${r.min}`
          : `${r.min}-${r.max}`,
    )
    .join(',');
}

/**
 * 在范围内随机取一个 ID（用于需要随机采样的场景）。
 * 若范围很大（开区间），需要调用方提供上界。
 */
export function randomInRange(
  f: RangeFilter | undefined | null,
  fallbackMax: number,
  rng: { int: (min: number, max: number) => number },
): number {
  if (isEmpty(f)) return rng.int(1, Math.max(1, fallbackMax));

  const rs = f!.ranges;
  const pickIdx = rng.int(0, rs.length - 1);
  const r = rs[pickIdx];
  const hi = Math.min(r.max, Number.MAX_SAFE_INTEGER === r.max ? fallbackMax : r.max);
  const lo = Math.min(r.min, hi);
  return rng.int(lo, hi);
}
