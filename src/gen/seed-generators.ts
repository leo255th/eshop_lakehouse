/**
 * 确定性数据生成器（流式按 ID 生成，不缓存全量数组）
 *
 * 设计要点：
 *  1. 全部 generateXxxByIndex(i) 形式 —— 按行号即时生成，**不把数据堆在内存**
 *     这是修复 v1 的 OOM 隐患（SeedService.refreshCache 把全量活跃用户/商品 ID
 *     读进 JS 数组，百万级用户会直接崩）
 *  2. 完全确定性：同一 seed + 同一 index 必然产生同一行
 *     让三档规模的数据集可以"嵌套"（100m 的前 100 万行 与 10m 的前 100 万行一致）
 *  3. 面向电商真实分布：价格用对数正态（低价商品多、高价少）、
 *     订单状态按"新近度"分布（越久远的订单越可能已完成）
 */

import {
  CATEGORIES,
  PROVINCES,
  CHANNELS,
  type ProvinceSeed,
} from '../sim/seed-data';
import {
  Rng,
  fromCents,
  randomPhone,
  sampleEventTime,
  TimePattern,
} from './rng';
import { Clock } from '../clock/clock.service';

// =====================================================================
// 时间格式化
// =====================================================================

const TZ = '+08:00';

export function ts(ms: number): string {
  return Clock.formatMs(ms, TZ);
}

const DAY_MS = 86_400_000;

// =====================================================================
// 用户维度
// =====================================================================

export interface UserRow {
  user_id: number;
  username: string;
  phone: string;
  email: string;
  province: string;
  city: string;
  user_level: number;
  status: number;
  register_channel: string;
  first_order_time: string | null; // SQL NULL → TSV 用 \N
  is_deleted: number;
  deleted_time: string | null;
  create_time: string;
  update_time: string;
}

/**
 * 生成第 i 个用户（i 从 0 开始，user_id = i + 1）
 *
 * @param regSpreadDays 注册时间铺开的天数（默认注册时间早于数据集起点）
 */
export function generateUser(
  i: number,
  seed: number,
  dataStartMs: number,
  regSpreadDays = 180,
): UserRow {
  const rng = new Rng(seed + i * 7919);
  const user_id = i + 1;

  const region = rng.pick(PROVINCES as readonly ProvinceSeed[]);
  const username = `user_${100000 + i}`;

  // 注册时间：铺在数据集起点之前的 regSpreadDays 天内
  const regMs = dataStartMs - Math.floor(rng.float() * regSpreadDays * DAY_MS);

  // 用户等级：普通 60% / 银牌 30% / 金牌 10%
  const user_level = rng.weightedIndex([60, 30, 10]) + 1;

  // 渠道分布：App 45% / 小程序 25% / H5 15% / 线下 8% / 广告 7%
  const register_channel = CHANNELS[rng.weightedIndex([45, 25, 15, 8, 7])];

  // 注销比例 3%（v2 用软删标记，不再物理删除）
  const deactivated = rng.bool(0.03);
  const deactMs = deactivated
    ? dataStartMs + Math.floor(rng.float() * 30 * DAY_MS)
    : null;

  const updMs = deactMs ?? regMs + Math.floor(rng.float() * 30 * DAY_MS);

  return {
    user_id,
    username,
    phone: randomPhone(rng),
    email: `${username}@example.com`,
    province: region.province,
    city: rng.pick(region.cities),
    user_level,
    status: deactivated ? 0 : 1,
    register_channel,
    first_order_time: null, // 由订单回填（post-process）
    is_deleted: 0,
    deleted_time: null,
    create_time: ts(regMs),
    update_time: ts(Math.max(updMs, regMs)),
  };
}

// =====================================================================
// 商品维度
// =====================================================================

export interface ProductRow {
  product_id: number;
  product_name: string;
  category: string;
  brand: string;
  price: string;
  cost_price: string;
  stock: number;
  status: number;
  is_deleted: number;
  deleted_time: string | null;
  create_time: string;
  update_time: string;
}

/**
 * 生成第 i 个商品（product_id = i + 1）
 *
 * 价格用对数正态分布而非均匀分布：真实电商里低价商品占多数。
 * 价格带划分（供 price_band 派生维度使用）：
 *   低价 0-100 / 中价 100-1000 / 高价 1000-5000 / 超高价 5000+
 */
export function generateProduct(
  i: number,
  seed: number,
  dataStartMs: number,
  totalProducts: number,
): ProductRow {
  const rng = new Rng(seed + 104729 + i * 6151);
  const product_id = i + 1;

  // 按索引均匀分配到 8 个品类，保证每类商品数可控
  const cat = CATEGORIES[i % CATEGORIES.length];
  const brand = rng.pick(cat.brands);

  // 价格：对数正态收敛到品类价格区间（偏向低位）
  const [minP, maxP] = cat.priceRange;
  // logNormal 均值≈1，做归一化让它落在 [min, max] 内并偏向低位
  const raw = rng.logNormal(0.9);
  const norm = Math.min(raw / 1.8, 1); // 截断到 [0,1]
  const priceCents = Math.max(100, Math.round((minP + norm * (maxP - minP)) * 100));

  // 成本价 = 售价 × (55% ~ 85%)，保证毛利率合理
  const costCents = Math.round(priceCents * (0.55 + rng.float() * 0.3));

  // 下架比例 5%（v2 软删标记）
  const offShelf = rng.bool(0.05);
  const offMs = offShelf ? dataStartMs + Math.floor(rng.float() * 30 * DAY_MS) : null;

  const createMs = dataStartMs - Math.floor(rng.float() * 90 * DAY_MS);

  return {
    product_id,
    product_name: `${brand} ${cat.name} ${String(i).padStart(5, '0')}`,
    category: cat.name,
    brand,
    price: fromCents(priceCents),
    cost_price: fromCents(costCents),
    stock: rng.int(0, 2000),
    status: offShelf ? 0 : 1,
    is_deleted: 0,
    deleted_time: null,
    create_time: ts(createMs),
    update_time: ts(Math.max(offMs ?? createMs, createMs)),
  };
}

// =====================================================================
// 订单状态分布（按"新近度"分档）
// =====================================================================

/** 状态顺序固定，供 weightedIndex 使用 */
const STATUS_NAMES = ['CREATED', 'PAID', 'SHIPPED', 'COMPLETED', 'CANCELLED'] as const;
export type OrderStatus = (typeof STATUS_NAMES)[number];

/**
 * 按订单距"数据终点"的天数决定状态分布。
 *
 * 真实电商：越久远的订单越可能已完成，最近的订单还在流转中。
 * 这让窗口函数、漏斗、状态流转实验都有真实的数据形态。
 *
 * 权重顺序对应 [CREATED, PAID, SHIPPED, COMPLETED, CANCELLED]
 */
function statusWeights(ageDays: number): number[] {
  if (ageDays > 14) return [1, 2, 3, 90, 4]; //  极老：基本已完成
  if (ageDays > 7) return [2, 4, 6, 82, 6]; //  较老
  if (ageDays > 3) return [5, 10, 12, 65, 8]; //  中
  if (ageDays > 1) return [12, 22, 18, 38, 10]; //  近
  return [30, 30, 15, 10, 15]; //  当天：多在进行中
}

// =====================================================================
// 订单主表
// =====================================================================

export interface OrderRow {
  order_id: number;
  user_id: number;
  order_status: OrderStatus;
  item_count: number;
  total_amount: string;
  discount_amount: string;
  pay_time: string | null;
  shipping_time: string | null;
  complete_time: string | null;
  cancel_time: string | null;
  order_time: string;
  update_time: string;
  is_deleted: number;
  deleted_time: string | null;
}

export interface OrderGenContext {
  seed: number;
  dataStartMs: number;
  dataEndMs: number;
  pattern: TimePattern;
  userCount: number;
  productCount: number;
  /** 每组明细数权重 */
  itemCountWeights: number[];
  /** 每明细数量权重 */
  qtyWeights: number[];
  /** 取消比例（生成 CANCELLED 状态） */
  cancelRatio: number;
  /** 乱序注入比例 */
  lateRatio: number;
  /** 乱序最大延迟（毫秒） */
  lateMaxMs: number;
  /** 商品价格表（分），索引 = product_id - 1。用于"无价格历史"时的兜底 */
  productPriceCents: Int32Array;
  /** 商品状态表，索引 = product_id - 1 */
  productStatus: Uint8Array;
  /**
   * 商品价格历史（可选）。
   * 传入后，明细的 unit_price 会取「下单那一刻的真实售价」，
   * 从而与 dim_product.price（数据区间终点的当前价）产生真实分叉。
   */
  priceHistory?: PriceHistory;
  /** 价格历史使用的「初始价」表（priceHistory 的二分基准） */
  basePriceCents?: Int32Array;
  /**
   * 实时回放模式专用：本批订单的「当前虚拟时刻」（毫秒）。
   * 指定后，事件时间 = eventTimeMs - random(0, streamJitterMs)，
   * 即订单集中产生在当下，符合真实流式语义。
   */
  eventTimeMs?: number;
  /** 实时回放的抖动窗口（毫秒），默认 60 秒 */
  streamJitterMs?: number;
}

export interface OrderWithItems {
  order: OrderRow;
  items: ItemRow[];
}

export interface ItemRow {
  item_id: number;
  order_id: number;
  product_id: number;
  quantity: number;
  unit_price: string;
  subtotal: string;
  discount_amount: string;
  create_time: string;
}

/**
 * 生成一个订单及其明细。
 *
 * item_id 由调用方按累计偏移计算（保证全局唯一且连续）。
 * order_id = orderIndex + 1。
 */
export function generateOrder(
  orderIndex: number,
  ctx: OrderGenContext,
  itemIdStart: number,
): OrderWithItems {
  // 每个订单独立的确定性 RNG（与 orderIndex 绑定 → 分片无关 → 可复现）
  const rng = new Rng(ctx.seed + 999983 + orderIndex * 31337);
  const order_id = orderIndex + 1;

  // ---- 1. 事件时间 ----
  // 两种模式：
  //   a) 批量生成：按作息曲线在 [dataStartMs, dataEndMs] 上采样（铺满整个区间）
  //   b) 实时回放（replay）：由调用方通过 ctx.eventTimeMs 指定"当前时刻"，
  //      再在其之前几十秒内抖动 —— 这才是真实的流式语义
  //      （若沿用 a) 的区间采样，replay 生成的订单会散落到一年之后）
  let orderMs: number;
  if (ctx.eventTimeMs !== undefined) {
    const jitterMs = ctx.streamJitterMs ?? 60_000;
    orderMs = ctx.eventTimeMs - Math.floor(rng.float() * jitterMs);
  } else {
    orderMs = sampleEventTime(
      rng,
      ctx.dataStartMs,
      ctx.dataEndMs,
      ctx.pattern,
      0.6, // 新近度偏置：模拟业务增长
    );
  }

  // 乱序注入：让 order_time 早于"实际到达顺序"（实验 9：Watermark/迟到数据）
  if (ctx.lateRatio > 0 && rng.float() < ctx.lateRatio) {
    orderMs -= rng.int(1000, ctx.lateMaxMs);
    if (orderMs < ctx.dataStartMs) orderMs = ctx.dataStartMs;
  }

  const ageDays = (ctx.dataEndMs - orderMs) / DAY_MS;

  // ---- 2. 用户 ----
  const user_id = rng.int(1, ctx.userCount);

  // ---- 3. 明细 ----
  const itemCount = rng.weightedIndex(ctx.itemCountWeights) + 1;

  // 选商品（无放回，避免同一订单出现重复商品行）
  const chosen = new Set<number>();
  let guard = 0;
  while (chosen.size < itemCount && guard++ < itemCount * 10) {
    const pid = rng.int(1, ctx.productCount);
    if (ctx.productStatus[pid - 1] === 1) chosen.add(pid);
  }
  if (chosen.size === 0) chosen.add(1); // 兜底

  let totalCents = 0;
  let totalQty = 0;
  let totalDiscountCents = 0;
  const items: ItemRow[] = [];
  let itemId = itemIdStart;

  for (const pid of chosen) {
    const qty = rng.weightedIndex(ctx.qtyWeights) + 1;
    // 取下单「那一刻」的真实售价（有价格历史时二分查找，否则用当前价）
    const unitPriceCents =
      ctx.priceHistory && ctx.basePriceCents
        ? priceAt(ctx.priceHistory, pid - 1, orderMs, ctx.basePriceCents)
        : ctx.productPriceCents[pid - 1];
    const subtotalCents = unitPriceCents * qty;

    // 明细级优惠：30% 的行有优惠，幅度 0~15%
    let discountCents = 0;
    if (rng.bool(0.3)) {
      discountCents = Math.round(subtotalCents * rng.range(0, 0.15));
    }

    totalCents += subtotalCents - discountCents;
    totalQty += qty;
    totalDiscountCents += discountCents;

    items.push({
      item_id: itemId++,
      order_id,
      product_id: pid,
      quantity: qty,
      unit_price: fromCents(unitPriceCents),
      subtotal: fromCents(subtotalCents),
      discount_amount: fromCents(discountCents),
      create_time: ts(orderMs),
    });
  }

  // ---- 4. 状态与里程碑时间戳 ----
  const weights = statusWeights(ageDays);
  let status = STATUS_NAMES[rng.weightedIndex(weights)];

  // 额外取消：小概率把非终态订单改成 CANCELLED，让取消率可控
  if (status !== 'COMPLETED' && status !== 'CANCELLED' && rng.float() < ctx.cancelRatio) {
    status = 'CANCELLED';
  }

  // 里程碑时间戳按状态机语义推进，且不超过数据区间终点
  const cap = ctx.dataEndMs;
  const at = (base: number, loMin: number, hiMin: number): number =>
    Math.min(base + rng.int(loMin * 60_000, hiMin * 60_000), cap);

  let payMs: number | null = null;
  let shipMs: number | null = null;
  let completeMs: number | null = null;
  let cancelMs: number | null = null;

  switch (status) {
    case 'PAID':
      payMs = at(orderMs, 1, 30);
      break;
    case 'SHIPPED':
      payMs = at(orderMs, 1, 30);
      shipMs = at(payMs, 30, 240);
      break;
    case 'COMPLETED':
      payMs = at(orderMs, 1, 30);
      shipMs = at(payMs, 30, 240);
      completeMs = at(shipMs, 120, 2880);
      break;
    case 'CANCELLED':
      // 一半是"未付款取消"，一半是"付款后取消"
      if (rng.bool(0.5)) {
        payMs = at(orderMs, 1, 30);
        cancelMs = at(payMs, 5, 180);
      } else {
        cancelMs = at(orderMs, 1, 120);
      }
      break;
    default: // CREATED
      break;
  }

  const updateMs = Math.max(
    orderMs,
    ...[payMs, shipMs, completeMs, cancelMs].filter((v): v is number => v !== null),
  );

  return {
    order: {
      order_id,
      user_id,
      order_status: status,
      item_count: totalQty,
      total_amount: fromCents(totalCents),
      discount_amount: fromCents(totalDiscountCents),
      pay_time: payMs === null ? null : ts(payMs),
      shipping_time: shipMs === null ? null : ts(shipMs),
      complete_time: completeMs === null ? null : ts(completeMs),
      cancel_time: cancelMs === null ? null : ts(cancelMs),
      order_time: ts(orderMs),
      update_time: ts(updateMs),
      is_deleted: 0,
      deleted_time: null,
    },
    items,
  };
}

// =====================================================================
// 价格历史（"事实快照 vs 当前维度"实验的数据基础）
// =====================================================================

/**
 * 商品价格历史：每个商品在数据区间内的价格变动序列。
 *
 * 用「并行 Int32Array」而非对象数组，控制内存：
 *   50,000 商品 × 4 次调价 × 2 个数组 × 4 字节 ≈ 1.6 MB（可忽略）
 *   对比：若用 object[] 存 20 万条记录，约需 30~50 MB
 *
 * 为什么需要它：
 *   只把调价写进流水表、却不作用到 dim_product.price 的话，
 *   fact_order_item.unit_price 与 dim_product.price 永远相等，
 *   实验 4（事实快照 vs 当前维度）就测不出任何分叉。
 *   有了价格历史，下单时能取到「当时真实售价」，
 *   而 dim_product.price 是「区间终点的当前价」→ 产生真实分叉。
 */
export interface PriceHistory {
  /** times[i] = 第 i 个商品各次调价的时间偏移（相对 epochBaseMs 的秒数） */
  times: Int32Array[];
  /** prices[i] = 第 i 个商品各次调价后的价格（分） */
  prices: Int32Array[];
  /** 每个商品的调价次数 */
  counts: Int32Array;
  /** 时间基准（毫秒），与 Int32 秒偏移配合覆盖 ±68 年 */
  epochBaseMs: number;
}

/**
 * 构建全部商品的价格历史。
 *
 * ⚠️ 取数顺序必须与 generatePriceChanges 完全一致，
 *    否则流水表与 dim_product.price 会对不上。
 */
export function buildPriceHistoryPerProduct(
  productCount: number,
  seed: number,
  dataStartMs: number,
  dataEndMs: number,
  /**
   * 每个商品各自的调价次数。
   * ★ 传 0 表示该商品**不调价** —— 用于「只给指定商品构建价格历史」（实验 4）。
   *   传 0 的商品 finalPrice == basePrice，全生命周期只有一个价格版本（INIT），天然正确。
   */
  changesPerProduct: Int32Array,
  basePrices: Int32Array,
): PriceHistory {
  const counts = new Int32Array(productCount);
  const times: Int32Array[] = [];
  const prices: Int32Array[] = [];
  const epochBaseMs = dataStartMs;

  for (let i = 0; i < productCount; i++) {
    const n = Math.max(0, Math.round(changesPerProduct[i] ?? 0));
    counts[i] = n;
    if (n === 0) {
      times.push(new Int32Array(0));
      prices.push(new Int32Array(0));
      continue;
    }
    const rng = new Rng(seed + 15485863 + i * 24593);
    const rawTimes: number[] = [];
    for (let k = 0; k < n; k++) {
      rawTimes.push(rng.int(dataStartMs, dataEndMs - 1));
    }
    rawTimes.sort((a, b) => a - b);

    const tArr = new Int32Array(n);
    const pArr = new Int32Array(n);
    let prev = basePrices[i];
    for (let k = 0; k < n; k++) {
      tArr[k] = Math.round((rawTimes[k] - epochBaseMs) / 1000);
      const delta = Math.round(prev * rng.range(-0.1, 0.1));
      const next = Math.max(100, prev + delta);
      pArr[k] = next;
      prev = next;
    }
    times.push(tArr);
    prices.push(pArr);
  }

  return { times, prices, counts, epochBaseMs };
}

/**
 * 兼容包装：全部商品用同一个调价次数。
 * 新代码建议直接用 buildPriceHistoryPerProduct（支持按商品指定）。
 */
export function buildPriceHistory(
  productCount: number,
  seed: number,
  dataStartMs: number,
  dataEndMs: number,
  changesPerProduct: number,
  basePrices: Int32Array,
): PriceHistory {
  const arr = new Int32Array(productCount).fill(Math.max(0, Math.round(changesPerProduct)));
  return buildPriceHistoryPerProduct(
    productCount, seed, dataStartMs, dataEndMs, arr, basePrices,
  );
}

/**
 * 查询某商品在某时刻的价格（分）。
 * 二分查找最后一条 change_time <= atMs 的记录；找不到则返回初始价。
 */
export function priceAt(
  h: PriceHistory,
  productIndex: number,
  atMs: number,
  basePrices: Int32Array,
): number {
  const n = h.counts[productIndex];
  if (n === 0) return basePrices[productIndex];

  const tArr = h.times[productIndex];
  const target = Math.round((atMs - h.epochBaseMs) / 1000);

  let lo = 0;
  let hi = n - 1;
  let found = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (tArr[mid] <= target) {
      found = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return found >= 0 ? h.prices[productIndex][found] : basePrices[productIndex];
}

/** 商品在区间终点的最终价 = dim_product.price 的当前值 */
export function finalPrice(
  h: PriceHistory,
  productIndex: number,
  basePrices: Int32Array,
): number {
  const n = h.counts[productIndex];
  return n === 0 ? basePrices[productIndex] : h.prices[productIndex][n - 1];
}

// =====================================================================
// 价格变更流水（无事实事实表）
// =====================================================================

export interface PriceChangeRow {
  product_id: number;
  old_price: string | null;
  new_price: string;
  change_type: string;
  change_time: string;
}

/**
 * 为第 i 个商品生成其价格变更流水。
 * 变更时间铺在数据集区间内，价格围绕初始价 ±10% 波动。
 * 最后一次变更的 new_price 即 dim_product.price 的当前值。
 */
export function generatePriceChanges(
  i: number,
  ctx: OrderGenContext,
  changesPerProduct: number,
): PriceChangeRow[] {
  if (changesPerProduct <= 0) return [];
  const rng = new Rng(ctx.seed + 15485863 + i * 24593);
  const product_id = i + 1;
  const baseCents = ctx.productPriceCents[i];

  const n = Math.max(1, Math.round(changesPerProduct));
  const out: PriceChangeRow[] = [];

  // 每个商品的调价时间在区间内排序
  const times: number[] = [];
  for (let k = 0; k < n; k++) {
    times.push(rng.int(ctx.dataStartMs, ctx.dataEndMs - 1));
  }
  times.sort((a, b) => a - b);

  let prevCents = baseCents;
  for (let k = 0; k < n; k++) {
    const delta = Math.round(prevCents * rng.range(-0.1, 0.1));
    const newCents = Math.max(100, prevCents + delta);
    const isOff = rng.bool(0.03);

    out.push({
      product_id,
      old_price: fromCents(prevCents),
      new_price: fromCents(newCents),
      change_type: isOff ? 'OFFSHELF' : 'ADJUST',
      change_time: ts(times[k]),
    });
    prevCents = newCents;
  }
  return out;
}

/**
 * 生成「初始版本」记录（change_type = 'INIT'）。
 *
 * 为什么必须有：
 *   第一条真实调价发生在区间内部（随机时刻），
 *   而订单从区间起点就开始产生 →
 *   「区间起点 ~ 第一次调价」这段区间在 SCD2 里**没有任何版本**，
 *   按时间点关联版本时会丢行（实测：21,530 行明细中有 12,504 行关联不上，占 58%）。
 *
 *   补一条 change_time = 数据区间起点、new_price = 初始价的 INIT 记录后，
 *   版本序列从区间起点就闭合，匹配率可达 100%。
 *
 * old_price 为 NULL 表示"此前无价格"（首次定价，不是变更）。
 */
export function initChangeRow(
  productIndex: number,
  basePriceCents: number,
  dataStartMs: number,
): PriceChangeRow {
  return {
    product_id: productIndex + 1,
    old_price: null,
    new_price: fromCents(basePriceCents),
    change_type: 'INIT',
    change_time: ts(dataStartMs),
  };
}

/**
 * 从价格历史直接导出流水行。
 *
 * ✅ 推荐使用本函数而非 generatePriceChanges：
 *   它保证「流水表」与「dim_product.price 的当前值」来自同一份价格序列，
 *   不会因为两处 RNG 取数顺序不一致而产生对不上的数据。
 */
export function priceChangesFromHistory(
  h: PriceHistory,
  productIndex: number,
  basePriceCents: number,
  totalChanges: number,
): PriceChangeRow[] {
  const n = h.counts[productIndex];
  if (n === 0) return [];
  const product_id = productIndex + 1;
  const tArr = h.times[productIndex];
  const pArr = h.prices[productIndex];

  const out: PriceChangeRow[] = [];
  let prev = basePriceCents;
  for (let k = 0; k < n; k++) {
    // 与首次生成时相同的"下架"判定（用独立 RNG，避免影响价格序列）
    const flagRng = new Rng(h.epochBaseMs + productIndex * 131 + k * 17 + totalChanges);
    const isOff = flagRng.bool(0.03);
    out.push({
      product_id,
      old_price: fromCents(prev),
      new_price: fromCents(pArr[k]),
      change_type: isOff ? 'OFFSHELF' : 'ADJUST',
      change_time: ts(h.epochBaseMs + tArr[k] * 1000),
    });
    prev = pArr[k];
  }
  return out;
}
