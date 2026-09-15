/**
 * 实时增量生成模式（replay）
 *
 * 场景（对应你的需求）：
 *   已用 bulk 模式批量生成 2025-10-01 ~ 2025-10-31 的历史数据，
 *   现在需要从 2025-11-01 开始，以「一天 3~4 万单」的真实业务速率
 *   持续产生新的实时订单 + 变更事件。
 *
 *   npm run generate:replay:100m
 *     → 100 万档，默认 35,000 单/天
 *
 * 关键设计：
 *   1. **按「每日单数」配置速率，而不是按毫秒间隔**
 *      间隔受 tick 抖动影响无法精确控制日产量；按日单数配置才能与业务口径对齐。
 *      100 万档：35000/86400 ≈ 0.405 单/秒
 *      1000 万档：323000/86400 ≈ 3.74 单/秒
 *      1 亿档：3226000/86400 ≈ 37.3 单/秒
 *   2. **支持时间加速**（--time-scale）
 *      否则 1000 万档要跑 30 天才能攒够数据。加速后 1 小时可模拟数天。
 *      加速时所有变更任务（状态流转/调价/清理）同步按虚拟时间节拍执行。
 *   3. **订单 ID 从现有最大值续接**，时间从「历史数据终点」续接，
 *      与 bulk 数据集无缝衔接。
 *   4. **幂等**：ID 由生成器维护，不使用 ON DUPLICATE KEY，避免重复写入。
 */

import mysql from 'mysql2/promise';
import { config, SizeProfile } from '../config';
import { Clock } from '../clock/clock.service';
import { Rng, fromCents } from './rng';
import {
  generateOrder,
  OrderGenContext,
} from './seed-generators';
import {
  RangeFilter,
  EMPTY_RANGE,
  buildSqlCondition,
  describe as describeRange,
  isEmpty as isRangeEmpty,
  randomInRange,
} from './range-filter';
import { openLoadConnection, closeLoadConnection } from './loader';

const DAY_MS = 86_400_000;

export interface ReplayOptions {
  profile: SizeProfile;
  /** 起始虚拟时间（毫秒）。默认 = SIM_EPOCH */
  startMs: number;
  /** 每日订单数 */
  ordersPerDay: number;
  /** 时间加速倍率 */
  timeScale: number;
  /** 是否同时产生变更事件（状态流转/调价/取消/清理） */
  withChurn: boolean;
  /** 每批写入行数 */
  batchRows: number;
  /** 进度日志间隔（秒，真实时间） */
  logEverySec: number;
  /** 运行时长上限（秒，真实时间）。0 = 无限 */
  maxRuntimeSec: number;
  /** 随机种子 */
  seed: number;
  /** 促销峰值：每隔一段时间触发一次爆发 */
  burstEverySec: number;
  burstMultiplier: number;
  burstDurationSec: number;

  // ===== 目标范围限定（实验用）=====
  /**
   * 这些过滤器的语义是「**只改这些，不改别的**」：
   *   · 指定后，变更事件只作用于范围内的订单/商品
   *   · 未指定（空）时维持原行为：全表随机采样
   * 用途：
   *   实验 1 —— 只改指定几个订单，全程追踪其状态变更轨迹
   *   实验 4 —— 只改指定若干商品，便于与 unit_price 快照做精确对照
   */
  /** 新订单 ID 的允许范围（不指定则从已有 max_order_id+1 连续生成） */
  orderIdFilter?: RangeFilter;
  /** 状态流转 / 取消 / 清理 只作用于这些订单 */
  churnOrderFilter?: RangeFilter;
  /** 调价 / 下架 只作用于这些商品 */
  churnProductFilter?: RangeFilter;
}

interface ProductLite {
  id: number;
  priceCents: number;
  costCents: number;
  stock: number;
  status: number;
  category: string;
}

export async function runReplay(opts: ReplayOptions): Promise<void> {
  const db = opts.profile.database;
  const log = (m: string) => console.log(m);

  log(`=== 实时增量生成开始（replay）===`);
  log(`  目标库     : ${db}`);
  log(`  起始虚拟时间: ${Clock.formatMs(opts.startMs)}`);
  log(
    `  速率       : ${opts.ordersPerDay.toLocaleString()} 单/天 ` +
      `= ${(opts.ordersPerDay / 86400).toFixed(3)} 单/实时秒（scale=1 时）`,
  );
  log(`  时间加速   : ${opts.timeScale}x  → 虚拟 ${(86400 * opts.timeScale).toLocaleString()} 秒/真实秒`);
  log(`  变更事件   : ${opts.withChurn ? '开启（状态流转/调价/取消/清理）' : '关闭'}`);
  if (opts.withChurn) {
    log(`    订单变更范围: ${describeRange(opts.churnOrderFilter)}`);
    log(`    商品变更范围: ${describeRange(opts.churnProductFilter)}`);
  }
  if (!isRangeEmpty(opts.orderIdFilter)) {
    log(`    新订单 ID 范围: ${describeRange(opts.orderIdFilter)}`);
  }
  if (opts.burstEverySec > 0) {
    log(`  促销峰值   : 每 ${opts.burstEverySec}s 触发 ${opts.burstDurationSec}s 的 ${opts.burstMultiplier}x 爆发`);
  }
  log('');

  const conn = await mysql.createConnection({
    host: config.db.host,
    port: config.db.port,
    user: config.db.user,
    password: config.db.password,
    database: db,
    timezone: config.db.timezone,
    connectTimeout: 30_000,
    charset: 'utf8mb4',
  });
  await conn.query('SET SESSION sql_mode = ""');

  try {
    // ---- 1. 读取现有状态（ID 水位、商品、用户数）----
    const state = await readState(conn, opts.profile);
    log(
      `现有数据：订单 ${state.maxOrderId.toLocaleString()} / 明细 ${state.maxItemId.toLocaleString()} ` +
        `/ 用户 ${state.userCount.toLocaleString()} / 商品 ${state.productCount.toLocaleString()}`,
    );

    const ctx: OrderGenContext = {
      seed: opts.seed,
      dataStartMs: opts.startMs,
      dataEndMs: opts.startMs + 365 * DAY_MS,
      pattern: config.gen.pattern,
      userCount: state.userCount,
      productCount: state.productCount,
      itemCountWeights: config.gen.itemCountWeights,
      qtyWeights: config.gen.qtyWeights,
      cancelRatio: config.gen.cancelRatio,
      lateRatio: config.gen.lateRatio,
      lateMaxMs: config.gen.lateMaxSec * 1000,
      productPriceCents: state.priceArr,
      productStatus: state.statusArr,
    };

    // ---- 2. 速率控制 ----
    // 每个真实毫秒应产生的订单数（考虑时间加速）：
    //   虚拟时间推进 = 真实时间 × timeScale
    //   虚拟秒产量   = ordersPerDay / 86400
    //   真实秒产量   = 虚拟秒产量 × timeScale
    const ordersPerRealSec = (opts.ordersPerDay / 86400) * opts.timeScale;
    const ordersPerRealMs = ordersPerRealSec / 1000;
    log(
      `实际吞吐目标：${ordersPerRealSec.toFixed(2)} 单/真实秒 ` +
        `（若数据源和服务端同机可达 200+ 单/秒，此速率很轻松）\n`,
    );

    // ---- 3. 主循环 ----
    const rng = new Rng(opts.seed + 777);
    const startedReal = Date.now();
    let nextRealMs = startedReal;
    let nextOrderId = state.maxOrderId + 1;
    let nextItemId = state.maxItemId + 1;
    let created = 0;
    let lastLog = startedReal;
    let lastChurn = startedReal;
    let burstUntil = 0;
    let nextBurst = startedReal + opts.burstEverySec * 1000;

    // 待写入缓冲
    let orderBuf: unknown[][] = [];
    let itemBuf: unknown[][] = [];

    while (true) {
      const nowReal = Date.now();

      // 运行时长上限
      if (opts.maxRuntimeSec > 0 && (nowReal - startedReal) / 1000 >= opts.maxRuntimeSec) {
        log(`\n达到运行时长上限 ${opts.maxRuntimeSec}s，停止。`);
        break;
      }

      // 促销爆发窗口
      let multiplier = 1;
      if (opts.burstEverySec > 0) {
        if (nowReal >= nextBurst && nowReal > burstUntil) {
          burstUntil = nowReal + opts.burstDurationSec * 1000;
          nextBurst = nowReal + opts.burstEverySec * 1000;
          log(`  ⚡ 促销峰值开始（${opts.burstMultiplier}x，持续 ${opts.burstDurationSec}s）`);
        }
        if (nowReal < burstUntil) multiplier = opts.burstMultiplier;
      }

      // 时间加速下的虚拟时间点
      const virtualNowMs = opts.startMs + (nowReal - startedReal) * opts.timeScale;

      // 本轮到现在的应生成订单数（按真实时间累积）
      // ⚠️ 修正：原来无条件把 nextRealMs = nowReal，会把不足 1 单的余量"抹零"，
      //    高倍速下累积误差使实测速率偏高约 2 倍。
      //    改为「只推进已消费的时间」：把已生成订单数折算回时间再扣减。
      /**
       * ⚠️ ordersPerDay = 0 时必须跳过「按速率生成订单」这一段。
       *
       * 踩过的 bug：原来无条件算 due 并在 due<=0 时 continue，
       * 于是 ordersPerDay=0 ⇒ due 恒为 0 ⇒ 每次都 continue ⇒
       * 主循环变成死循环，**变更事件（churn）永远得不到执行**。
       * 症状：replay 跑满时长却什么也没改，日志只有"新增 0 订单"。
       *
       * 这个场景（只产生变更、不新增订单）是合法用法：
       *   实验 6（Compaction）需要大量 UPDATE 但不想让数据量继续涨。
       * 所以正确的做法是：ordersPerDay=0 时不进入订单生成分支，
       * 但仍要走到下面的 churn 分支。
       */
      const generateOrders = ordersPerRealMs > 0;
      let n = 0;
      if (generateOrders) {
        const elapsed = nowReal - nextRealMs;
        const due = Math.floor(elapsed * ordersPerRealMs * multiplier);
        if (due <= 0) {
          await sleep(Math.max(1, Math.min(50, 1 / Math.max(ordersPerRealMs, 1e-6))));
          continue;
        }
        n = Math.min(due, 5000);
        // 扣减对应的时间（保留余量，供下一轮累积）
        nextRealMs += n / (ordersPerRealMs * multiplier);
      }

      // 生成 due 个订单（限制单轮上限，避免突发时内存暴涨）
      // 显式指定「当前虚拟时刻」，让订单集中产生在当下而不是散落到一年后
      ctx.eventTimeMs = virtualNowMs;
      // 事件时间相对当前虚拟时刻往前抖动的上限。
      // ★ 原先这里硬编码 60_000，导致实验 9 没法做乱序对照
      //   （watermark 想设 5 秒，而抖动打底 60 秒 → 全部迟到，三档区分不出来）。
      //   现在由 --stream-jitter-ms / GEN_STREAM_JITTER_MS 控制，默认仍是 60000。
      ctx.streamJitterMs = config.gen.streamJitterMs;
      for (let k = 0; k < n; k++) {
        const oi = nextOrderId - 1; // generateOrder 的 orderIndex 语义
        const { order, items } = generateOrder(oi, ctx, nextItemId);
        orderBuf.push([
          order.order_id, order.user_id, order.order_status, order.item_count,
          order.total_amount, order.discount_amount, order.pay_time,
          order.shipping_time, order.complete_time, order.cancel_time,
          order.order_time, order.update_time, order.is_deleted, order.deleted_time,
        ]);
        for (const it of items) {
          itemBuf.push([
            it.item_id, it.order_id, it.product_id, it.quantity,
            it.unit_price, it.subtotal, it.discount_amount, it.create_time,
          ]);
        }
        nextOrderId++;
        nextItemId += items.length;
        created++;
      }

      // 刷盘
      if (orderBuf.length >= opts.batchRows) {
        await flushOrders(conn, orderBuf, itemBuf);
        orderBuf = [];
        itemBuf = [];
      }

      // 进度日志
      if (nowReal - lastLog >= opts.logEverySec * 1000) {
        const elapsedSec = (nowReal - startedReal) / 1000;
        const virtualDays = (elapsedSec * opts.timeScale) / 86400;
        log(
          `  [${elapsedSec.toFixed(0)}s] 新订单 ${created.toLocaleString()} 单 ` +
            `(${(created / elapsedSec).toFixed(2)} 单/真实秒) | ` +
            `虚拟进度 +${virtualDays.toFixed(3)} 天 | 当前虚拟时间 ${Clock.formatMs(virtualNowMs)}`,
        );
        lastLog = nowReal;
      }

      // ordersPerDay=0 时主循环会空转，加个短 sleep 避免烧 CPU
      if (!generateOrders) {
        await sleep(20);
      }

      // 变更事件：按虚拟时间节拍执行
      if (opts.withChurn && nowReal - lastChurn >= 2000) {
        const lastChurnTs = lastChurn;
        lastChurn = nowReal;
        // 本 tick 推进的虚拟毫秒数（不是秒 —— 变量名与语义对齐，避免再次算错）
        const virtualMsPassed = (nowReal - lastChurnTs) * opts.timeScale;
        await runChurnTick(
          conn,
          virtualNowMs,
          virtualMsPassed,
          rng,
          opts.profile,
          opts.churnOrderFilter ?? EMPTY_RANGE,
          opts.churnProductFilter ?? EMPTY_RANGE,
        );
      }
    }

    // 收尾刷新
    if (orderBuf.length > 0) {
      await flushOrders(conn, orderBuf, itemBuf);
    }
    log(`\n=== replay 结束：新增 ${created.toLocaleString()} 订单 ===`);
  } finally {
    await conn.end().catch(() => undefined);
  }
}

// =====================================================================
// 辅助
// =====================================================================

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

interface ReplayState {
  maxOrderId: number;
  maxItemId: number;
  userCount: number;
  productCount: number;
  priceArr: Int32Array;
  statusArr: Uint8Array;
}

async function readState(
  conn: mysql.Connection,
  profile: SizeProfile,
): Promise<ReplayState> {
  const [o] = await conn.query('SELECT IFNULL(MAX(order_id),0) m FROM fact_order');
  const [i] = await conn.query('SELECT IFNULL(MAX(item_id),0) m FROM fact_order_item');
  const [u] = await conn.query('SELECT COUNT(*) c FROM dim_user');
  const [p] = await conn.query('SELECT COUNT(*) c FROM dim_product');

  const maxOrderId = Number((o as any[])[0].m);
  const maxItemId = Number((i as any[])[0].m);
  const userCount = Number((u as any[])[0].c);
  const productCount = Number((p as any[])[0].c);

  // 只把「价格 + 状态」读进紧凑数组，不读对象（避免大维表 OOM）
  const priceArr = new Int32Array(productCount);
  const statusArr = new Uint8Array(productCount);
  const [rows] = await conn.query(
    'SELECT product_id, price, status FROM dim_product ORDER BY product_id',
  );
  for (const r of rows as any[]) {
    const idx = Number(r.product_id) - 1;
    if (idx >= 0 && idx < productCount) {
      priceArr[idx] = Math.round(Number(r.price) * 100);
      statusArr[idx] = Number(r.status);
    }
  }

  return { maxOrderId, maxItemId, userCount, productCount, priceArr, statusArr };
}

async function flushOrders(
  conn: mysql.Connection,
  orders: unknown[][],
  items: unknown[][],
): Promise<void> {
  if (orders.length > 0) {
    await conn.query(
      `INSERT INTO fact_order
         (order_id, user_id, order_status, item_count, total_amount, discount_amount,
          pay_time, shipping_time, complete_time, cancel_time, order_time, update_time,
          is_deleted, deleted_time)
       VALUES ?`,
      [orders],
    );
  }
  if (items.length > 0) {
    await conn.query(
      `INSERT INTO fact_order_item
         (item_id, order_id, product_id, quantity, unit_price, subtotal, discount_amount, create_time)
       VALUES ?`,
      [items],
    );
  }
}

/**
 * 一轮变更事件：状态流转 + 取消 + 调价 + 逻辑清理。
 *
 * 速率语义（v2 修正）：
 *   配置里的 XxxPerHour 是「每个虚拟小时产生多少变更」，
 *   本函数按「本次 tick 推进了多少虚拟时间」折算应产生的数量，
 *   并受 churn.maxPerSecond 与 maxRuntimeSec 双重约束。
 *
 *   ⚠️ 初版 bug：把 chunk 频率与时间加速倍率叠加，导致 120x 下
 *      2 秒真实时间就产生数千次变更（等于重写整个数据集）。
 *      现在无论加速多少倍，虚拟世界里的变更密度都是恒定的。
 *
 * 同时，所有采样都用**主键范围采样**替代 v1 的 ORDER BY RAND()
 * （计划 4.3 节瓶颈 1）。
 */
async function runChurnTick(
  conn: mysql.Connection,
  virtualNowMs: number,
  virtualMsPassed: number,
  rng: Rng,
  _profile: SizeProfile,
  orderFilter: RangeFilter,
  productFilter: RangeFilter,
): Promise<void> {
  const now = Clock.formatMs(virtualNowMs);
  const virtualHours = virtualMsPassed / 3_600_000;
  const capPerTick = Math.max(
    1,
    Math.round((config.churn.maxPerSecond * virtualMsPassed) / 1000),
  );

  // 每 tick 的产量 = 每小时速率 × 本 tick 推进的虚拟小时数
  const take = (perHour: number) =>
    Math.min(Math.round(perHour * virtualHours), capPerTick);

  if (config.tasks.statusFlow.enabled) {
    const n = take(config.churn.statusFlowPerHour);
    if (n > 0) await optimisticTransitions(conn, rng, now, n, orderFilter);
  }
  if (config.tasks.canceler.enabled) {
    const n = take(config.churn.cancelPerHour);
    if (n > 0) await cancelSome(conn, rng, now, n, orderFilter);
  }
  if (config.tasks.priceAdjust.enabled) {
    const n = take(config.churn.priceAdjustPerHour);
    if (n > 0) await adjustPrices(conn, rng, now, n, productFilter);
  }
  if (config.tasks.cleaner.enabled) {
    const n = take(config.churn.cleanPerHour);
    if (n > 0) await softDeleteStale(conn, now, n, orderFilter);
  }
}

/**
 * 状态流转：用主键范围采样，避免全表扫。
 *
 * 做法：在 [1, maxOrderId] 里随机取若干探测点，每次取一段连续行
 * （WHERE order_id >= ? AND order_status IN (...) LIMIT k），
 * 用 LIMIT 容忍删除造成的空洞。
 */
async function optimisticTransitions(
  conn: mysql.Connection,
  rng: Rng,
  now: string,
  batch: number,
  filter: RangeFilter = EMPTY_RANGE,
): Promise<void> {
  const [mx] = await conn.query('SELECT IFNULL(MAX(order_id),0) m FROM fact_order');
  const maxId = Number((mx as any[])[0].m);
  if (maxId === 0) return;

  const rows: any[] = [];

  // ---- 模式 A：限定了订单范围 → 直接查询范围内的待流转订单（精准，不做随机探测）----
  if (!isRangeEmpty(filter)) {
    const params: unknown[] = [];
    const cond = buildSqlCondition(filter, 'order_id', params);
    const [r] = await conn.query(
      `SELECT order_id, order_status FROM fact_order
       WHERE order_status IN ('CREATED','PAID','SHIPPED')${cond}
       ORDER BY order_id LIMIT ?`,
      [...params, batch],
    );
    rows.push(...(r as any[]));
  } else {
    // ---- 模式 B（原行为）：主键范围随机探测，容忍删除空洞 ----
    const probes = Math.max(1, Math.ceil(batch / 10));
    for (let p = 0; p < probes && rows.length < batch; p++) {
      const anchor = rng.int(1, maxId);
      const [r] = await conn.query(
        `SELECT order_id, order_status FROM fact_order
         WHERE order_id >= ? AND order_status IN ('CREATED','PAID','SHIPPED')
         ORDER BY order_id LIMIT 10`,
        [anchor],
      );
      rows.push(...(r as any[]));
    }
  }

  for (const r of rows.slice(0, batch)) {
    const id = Number(r.order_id);
    const st = r.order_status;
    if (st === 'CREATED' && rng.bool(0.2)) {
      await conn.query(
        `UPDATE fact_order SET order_status='PAID', pay_time=?, update_time=?
         WHERE order_id=? AND order_status='CREATED'`,
        [now, now, id],
      );
    } else if (st === 'PAID' && rng.bool(0.15)) {
      await conn.query(
        `UPDATE fact_order SET order_status='SHIPPED', shipping_time=?, update_time=?
         WHERE order_id=? AND order_status='PAID'`,
        [now, now, id],
      );
    } else if (st === 'SHIPPED' && rng.bool(0.1)) {
      await conn.query(
        `UPDATE fact_order SET order_status='COMPLETED', complete_time=?, update_time=?
         WHERE order_id=? AND order_status='SHIPPED'`,
        [now, now, id],
      );
    }
  }
}

async function cancelSome(
  conn: mysql.Connection,
  rng: Rng,
  now: string,
  batch: number,
  filter: RangeFilter = EMPTY_RANGE,
): Promise<void> {
  const [mx] = await conn.query('SELECT IFNULL(MAX(order_id),0) m FROM fact_order');
  const maxId = Number((mx as any[])[0].m);
  if (maxId === 0) return;

  const rows: any[] = [];

  if (!isRangeEmpty(filter)) {
    const params: unknown[] = [];
    const cond = buildSqlCondition(filter, 'order_id', params);
    const [r] = await conn.query(
      `SELECT order_id FROM fact_order
       WHERE order_status IN ('CREATED','PAID')${cond}
       ORDER BY order_id LIMIT ?`,
      [...params, batch],
    );
    rows.push(...(r as any[]));
  } else {
    const probes = Math.max(1, Math.ceil(batch / 5));
    for (let p = 0; p < probes && rows.length < batch; p++) {
      const anchor = rng.int(1, maxId);
      const [r] = await conn.query(
        `SELECT order_id FROM fact_order
         WHERE order_id >= ? AND order_status IN ('CREATED','PAID')
         ORDER BY order_id LIMIT 5`,
        [anchor],
      );
      rows.push(...(r as any[]));
    }
  }

  for (const r of rows.slice(0, batch)) {
    if (!rng.bool(config.tasks.canceler.cancelProb)) continue;
    await conn.query(
      `UPDATE fact_order SET order_status='CANCELLED', cancel_time=?, update_time=?
       WHERE order_id=? AND order_status IN ('CREATED','PAID')`,
      [now, now, Number(r.order_id)],
    );
  }
}

async function adjustPrices(
  conn: mysql.Connection,
  rng: Rng,
  now: string,
  limit: number,
  filter: RangeFilter = EMPTY_RANGE,
): Promise<void> {
  const [mx] = await conn.query('SELECT IFNULL(MAX(product_id),0) m FROM dim_product');
  const maxId = Number((mx as any[])[0].m);
  if (maxId === 0) return;

  /**
   * 两种取样方式：
   *   限定范围 → 一次性查出范围内全部商品，在内存里轮转（精准、可复现）
   *   未限定   → 主键范围随机探测（原行为，避免全表扫）
   */
  let pool: any[] | null = null;
  let cursor = 0;
  if (!isRangeEmpty(filter)) {
    const params: unknown[] = [];
    const cond = buildSqlCondition(filter, 'product_id', params);
    const [r] = await conn.query(
      `SELECT product_id, price, stock, status FROM dim_product WHERE 1=1${cond} ORDER BY product_id`,
      params,
    );
    pool = r as any[];
    if (pool.length === 0) return;
  }

  for (let k = 0; k < limit; k++) {
    let row: any;
    if (pool) {
      // 顺序轮转遍历范围内的商品（保证每个目标商品都被改到）
      row = pool[cursor % pool.length];
      cursor++;
    } else {
      const anchor = rng.int(1, maxId);
      const [r] = await conn.query(
        'SELECT product_id, price, stock, status FROM dim_product WHERE product_id >= ? ORDER BY product_id LIMIT 1',
        [anchor],
      );
      row = (r as any[])[0];
    }
    if (!row) continue;
    const pid = Number(row.product_id);

    if (Number(row.status) === 1 && rng.bool(0.015)) {
      await conn.query('UPDATE dim_product SET status=0, update_time=? WHERE product_id=?', [now, pid]);
      await conn.query(
        `INSERT INTO fact_product_price_change (product_id, old_price, new_price, change_type, change_time)
         VALUES (?, ?, ?, 'OFFSHELF', ?)`,
        [pid, row.price, row.price, now],
      );
      continue;
    }
    if (Number(row.status) !== 1) continue;

    const oldCents = Math.round(Number(row.price) * 100);
    const delta = Math.round(oldCents * (rng.float() * 0.2 - 0.1));
    const newCents = Math.max(100, oldCents + delta);
    const newStock = Math.max(0, Number(row.stock) + rng.int(-50, 80));

    await conn.query(
      'UPDATE dim_product SET price=?, stock=?, update_time=? WHERE product_id=?',
      [fromCents(newCents), newStock, now, pid],
    );
    await conn.query(
      `INSERT INTO fact_product_price_change (product_id, old_price, new_price, change_type, change_time)
       VALUES (?, ?, ?, 'ADJUST', ?)`,
      [pid, fromCents(oldCents), fromCents(newCents), now],
    );
  }
}

/**
 * 清理器：v2 改为**逻辑删除**。
 *
 * v1 是物理 DELETE，导致历史指标口径漂移（数仓学习笔记 03 §6.8）：
 *   10:00 取消率 = 20/100 = 20%
 *   12:00 清理器删了 15 个 CANCELLED → 取消率 = 5/85 = 5.9%  ❌ 分子分母同时变小
 * v2 只打 is_deleted=1 标记，历史统计口径稳定。
 * 需要真实 CDC -D 事件时，用 --hard-delete 参数（见 CLI）单独触发物理删除。
 */
async function softDeleteStale(
  conn: mysql.Connection,
  now: string,
  limit: number,
  filter: RangeFilter = EMPTY_RANGE,
): Promise<void> {
  if (!config.tasks.cleaner.softDelete) return;
  const minutes = config.tasks.cleaner.cancelledOrderMinutes;
  const filterParams: unknown[] = [];
  const filterCond = buildSqlCondition(filter, 'order_id', filterParams);
  // 用 idx_status_update(order_status, update_time) 索引，避免全表扫
  await conn.query(
    `UPDATE fact_order
     SET is_deleted = 1, deleted_time = ?
     WHERE order_status = 'CANCELLED'
       AND is_deleted = 0
       AND update_time < DATE_SUB(?, INTERVAL ? MINUTE)${filterCond}
     LIMIT ?`,
    [now, now, minutes, ...filterParams, limit],
  );
}
