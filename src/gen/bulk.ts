/**
 * 批量生成模式（bulk）
 *
 * 目标：一次性把一个规模档位的完整数据集写进独立数据库
 *   npm run generate:100m     → eshop_100m     (100 万订单)
 *   npm run generate:10m    → eshop_10m    (1000 万订单)
 *   npm run generate:100m   → eshop_100m   (1 亿订单)
 *
 * 流程：
 *   1. 建库 + 建表
 *   2. 生成并导入维表（dim_user / dim_product），同时在内存里保留
 *      productPrice / productStatus 两个紧凑数组（Int32Array/Uint8Array）
 *      —— 这是修复 v1「全量 ID 缓存 OOM」的做法：只存必要字段，不存对象
 *   3. 分片并行生成 + 导入事实表（fact_order / fact_order_item）
 *      「边生成边导入」而非「先生成完再导入」，避免磁盘峰值
 *   4. 生成价格变更流水与库存变更流水
 *   5. 回填 dim_user.first_order_time
 */

import { mkdirSync, rmSync, statSync, existsSync } from 'fs';
import { readdir } from 'fs/promises';
import { join } from 'path';
import mysql from 'mysql2/promise';
import { config, SizeProfile } from '../config';
import { Clock } from '../clock/clock.service';
import {
  generateUser,
  generateProduct,
  generateOrder,
  priceChangesFromHistory,
  buildPriceHistory,
  buildPriceHistoryPerProduct,
  finalPrice,
  OrderGenContext,
  PriceHistory,
  ProductRow,
  UserRow,
} from './seed-generators';
import { TsvWriter, shardFileName } from './tsv-writer';
import {
  RangeFilter,
  EMPTY_RANGE,
  describe as describeRange,
  isEmpty as isRangeEmpty,
  inRange,
} from './range-filter';
import {
  TABLE_COLUMNS,
  loadFiles,
  openLoadConnection,
  closeLoadConnection,
} from './loader';
import {
  Rng,
  splitRanges,
  humanDuration,
  humanBytes,
  mapLimit,
  fromCents,
} from './rng';

const DAY_MS = 86_400_000;

export interface BulkOptions {
  profile: SizeProfile;
  /** 数据区间起点（虚拟时间毫秒）。默认 = epoch - days 天 */
  startMs: number;
  /** 数据区间终点（虚拟时间毫秒）。默认 = epoch */
  endMs: number;
  /** 时间分布形态 */
  pattern: 'uniform' | 'diurnal' | 'flashsale';
  /** 分片数 */
  shards: number;
  /** 随机种子 */
  seed: number;
  /** 临时目录 */
  tmpDir: string;
  /** 导入后是否保留 TSV */
  keepTsv: boolean;
  /** 是否重新建库（DROP 后重建） */
  recreate: boolean;
  /** 商品价格变更次数（每商品） */
  priceChangePerProduct: number;
  /**
   * 价格历史只作用于这些商品（实验 4）。
   * 为空则全部商品都有价格变更。
   */
  priceChangeProductFilter?: RangeFilter;
  /** 是否生成库存流水 */
  withStockChange: boolean;
  /** 进度日志间隔（毫秒） */
  logIntervalMs: number;
}

export interface BulkResult {
  database: string;
  sizeKey: string;
  rows: Record<string, number>;
  elapsedMs: number;
  tsvBytes: number;
}

export async function runBulk(opts: BulkOptions): Promise<BulkResult> {
  const started = Date.now();
  const { profile } = opts;
  const db = profile.database;

  log(`=== 批量生成开始 ===`);
  log(`  规模      : ${profile.label} (${profile.orders.toLocaleString()} 订单)`);
  log(`  目标库    : ${db}`);
  log(`  维表      : ${profile.users.toLocaleString()} 用户 / ${profile.products.toLocaleString()} 商品`);
  log(
    `  数据区间  : ${Clock.formatMs(opts.startMs)} ~ ${Clock.formatMs(opts.endMs)}` +
      `  (${((opts.endMs - opts.startMs) / DAY_MS).toFixed(0)} 天, pattern=${opts.pattern})`,
  );
  log(`  分片数    : ${opts.shards}`);
  if (!isRangeEmpty(opts.priceChangeProductFilter)) {
    log(`  价格历史范围: ${describeRange(opts.priceChangeProductFilter)}（仅这些商品会调价）`);
  }
  log(`  随机种子  : ${opts.seed}  (固定种子 → 数据可复现)`);
  log('');

  // ------------------------------------------------------------------
  // 0. 建库 + 建表
  // ------------------------------------------------------------------
  await ensureDatabaseAndSchema(db, opts.recreate);

  // ------------------------------------------------------------------
  // 1. 维表：生成 + 导入，并保留紧凑数组
  // ------------------------------------------------------------------
  mkdirSync(opts.tmpDir, { recursive: true });

  const tProducts = Date.now();
  const { productPrice, basePrice, productStatus, productRows, tsvBytes: dimBytes } =
    await generateAndLoadProducts(opts, db);
  log(`      ⏱ 商品阶段耗时 ${humanDuration(Date.now() - tProducts)}`);

  const tUsers = Date.now();
  const userBytes = await generateAndLoadUsers(opts, db);
  log(`      ⏱ 用户阶段耗时 ${humanDuration(Date.now() - tUsers)}`);

  const rows: Record<string, number> = {
    dim_user: profile.users,
    dim_product: profile.products,
  };
  let totalTsvBytes = dimBytes + userBytes;

  // ------------------------------------------------------------------
  // 2. 事实表：分片「边生成边导入」
  // ------------------------------------------------------------------
  // ------------------------------------------------------------------
  // 价格历史：让明细的 unit_price 取「下单那一刻的真实售价」，
  // 与 dim_product.price（区间终点当前价）产生真实分叉。
  // 这是实验 4（事实快照 vs 当前维度）能测出数字的前提。
  // ------------------------------------------------------------------
  let priceHistory: PriceHistory | undefined;
  if (opts.priceChangePerProduct > 0) {
    log(`\n[3.5/5] 构建价格历史（每商品 ${opts.priceChangePerProduct} 次调价）...`);
    const priceFilter = opts.priceChangeProductFilter ?? EMPTY_RANGE;

    /**
     * ★ 只给「范围内的商品」构建价格历史。
     *
     * 做法：对范围外的商品传 changesPerProduct = 0
     *   → 它们的 basePrice 与 finalPrice 相同、流水为空
     *   → 全生命周期只有一个价格版本（INIT），天然正确
     *
     * 用途（实验 4）：精确控制"哪些商品被调过价"，
     *   便于挑 20 个目标商品与 unit_price 快照做对照，
     *   而不是事后大海捞针。
     */
    const perProductArr = new Int32Array(profile.products);
    for (let i = 0; i < profile.products; i++) {
      perProductArr[i] = isRangeEmpty(priceFilter)
        ? opts.priceChangePerProduct
        : inRange(priceFilter, i + 1)
          ? opts.priceChangePerProduct
          : 0;
    }

    priceHistory = buildPriceHistoryPerProduct(
      profile.products,
      opts.seed,
      opts.startMs,
      opts.endMs,
      perProductArr,
      basePrice,
    );

    // 把「区间终点的最终价」写回 dim_product.price
    // —— 这样 dim_product 是"当前维度"，而 order_item.unit_price 是"历史快照"
    let changed = 0;
    for (let i = 0; i < profile.products; i++) {
      const fp = finalPrice(priceHistory, i, basePrice);
      if (fp !== basePrice[i]) {
        productPrice[i] = fp;
        changed++;
      }
    }

    // ★★ 关键改进：按「每个商品各自的变更时间戳」逐次生效，
    //    而不是用一条 CASE WHEN 批量改（那样这批 UPDATE 的 update_time 全是同一个值）。
    //
    //    为什么要改：
    //      原来 applyCurrentPrices 把多行一次改完，所有行的 update_time = 区间终点。
    //      后果是 binlog 重放出来的价格变更时间戳全都相同 →
    //      DWD 的 SCD2 会得到一堆时间点相同、顺序无意义的版本，拉链时间线是错的。
    //      改为按时间戳逐次 UPDATE 后，binlog 中是一条**时间戳严格递增**的变更序列，
    //      无论 earliest 还是 initial 启动 CDC，SCD2 时间线都正确。
    //
    //    代价：UPDATE 语句数从「商品数/1000」变成「有变价的商品数」。
    //          本场景每商品 3 次调价、5000 商品 → 约 5000 条 UPDATE（分块后约几十条语句）。
    if (changed > 0) {
      await applyPriceHistoryByTime(
        opts,
        db,
        priceHistory,
        basePrice,
        profile.products,
        opts.endMs,
      );
      log(`      已按时间戳写回 dim_product.price（${changed.toLocaleString()} 个商品变价）`);
      // ★ 不再需要 appendFinalPriceChanges：
      //   那个函数是为「一条 CASE WHEN 批量改价导致流水缺最后一版」打的补丁。
      //   现在每次变更都按自己的时间戳单独生效并已在流水表里有对应记录，
      //   版本序列天然完整，无需补记伪记录。
    }
  }

  const ctx: OrderGenContext = {
    seed: opts.seed,
    dataStartMs: opts.startMs,
    dataEndMs: opts.endMs,
    pattern: opts.pattern,
    userCount: profile.users,
    productCount: profile.products,
    itemCountWeights: config.gen.itemCountWeights,
    qtyWeights: config.gen.qtyWeights,
    cancelRatio: config.gen.cancelRatio,
    lateRatio: config.gen.lateRatio,
    lateMaxMs: config.gen.lateMaxSec * 1000,
    productPriceCents: productPrice,
    productStatus,
    priceHistory,
    basePriceCents: priceHistory ? basePrice : undefined,
  };

  const ranges = splitRanges(profile.orders, opts.shards);
  log(`\n=== 事实表生成：${ranges.length} 个分片并行（生成+导入流水线）===`);
  log(`  （每分片会在「生成 TSV」与「LOAD DATA」之间交替，两种耗时分别统计）`);

  const tableOrder = shardFileName(opts.tmpDir, 'fact_order', 0, profile.key).replace(/_s000\.tsv$/, '');
  const tableItem = shardFileName(opts.tmpDir, 'fact_order_item', 0, profile.key).replace(/_s000\.tsv$/, '');

  /**
   * ★ 每个分片必须使用**互不重叠**的 item_id 区间
   *
   * 原来的实现让每个分片的 itemSeq 都从 0 开始 → 各分片生成相同的 item_id
   * → LOAD DATA 时主键冲突，**静默丢行**
   * （实测：10 万订单只导入了 4.2 万明细，期望 17 万）
   *
   * 做法：按「分片序号 × 每单最大明细数」预分配固定区间。
   * 每单最多 3 条明细（itemCountWeights 为 [50,30,20]，length=3），
   * 所以 25000 单最多需要 75000 个 ID，预分配足够。
   */
  const maxItemsPerOrder = config.gen.itemCountWeights.length;
  const shardSpan = Math.ceil(profile.orders / ranges.length);
  const shardItemBase = (shardIdx: number) =>
    shardIdx * shardSpan * maxItemsPerOrder;

  let doneOrders = 0;
  let doneItems = 0;
  const shardStart = Date.now();

  const shardResults = await mapLimit(ranges, Math.min(opts.shards, ranges.length), async ([from, to], idx) => {
    const orderFile = `${tableOrder}_s${String(idx).padStart(3, '0')}.tsv`;
    const itemFile = `${tableItem}_s${String(idx).padStart(3, '0')}.tsv`;

    // --- 生成 ---
    const tGen = Date.now();
    const ow = new TsvWriter(orderFile);
    const iw = new TsvWriter(itemFile);
    // ★ 分片独立的 item_id 起点，保证全局唯一
    let itemSeq = shardItemBase(idx);
    const f = TABLE_COLUMNS.fact_order;
    const fi = TABLE_COLUMNS.fact_order_item;

    for (let oi = from; oi < to; oi++) {
      const { order, items } = generateOrder(oi, ctx, itemSeq + 1);
      itemSeq += items.length;

      ow.write([
        order.order_id, order.user_id, order.order_status, order.item_count,
        order.total_amount, order.discount_amount, order.pay_time,
        order.shipping_time, order.complete_time, order.cancel_time,
        order.order_time, order.update_time, order.is_deleted, order.deleted_time,
      ]);
      for (const it of items) {
        iw.write([
          it.item_id, it.order_id, it.product_id, it.quantity,
          it.unit_price, it.subtotal, it.discount_amount, it.create_time,
        ]);
      }
      if (ow.needsDrain || iw.needsDrain) {
        await Promise.all([ow.drain(), iw.drain()]);
      }
    }
    await Promise.all([ow.close(), iw.close()]);
    const genMs = Date.now() - tGen;

    // --- 导入 ---
    const tLoad = Date.now();
    const conn = await openLoadConnection(db);
    try {
      const ro = await loadFiles(conn, {
        database: db,
        table: 'fact_order',
        columns: [...f],
        files: [orderFile],
      });
      const ri = await loadFiles(conn, {
        database: db,
        table: 'fact_order_item',
        columns: [...fi],
        files: [itemFile],
      });
      doneOrders += ro.rows;
      doneItems += ri.rows;
      log(
        `  [shard ${idx}] 生成 ${humanDuration(genMs)} + 导入 ${humanDuration(Date.now() - tLoad)} | ` +
          `订单 ${ro.rows.toLocaleString()} (${ro.rowsPerSec.toLocaleString()} 行/秒) + ` +
          `明细 ${ri.rows.toLocaleString()} (${ri.rowsPerSec.toLocaleString()} 行/秒) | ` +
          `分片累计 ${humanDuration(Date.now() - shardStart)}`,
      );
      return { orders: ro.rows, items: ri.rows, bytes: statSync(orderFile).size + statSync(itemFile).size };
    } finally {
      await closeLoadConnection(conn);
    }
  });

  for (const r of shardResults) totalTsvBytes += r.bytes;
  rows.fact_order = doneOrders;
  rows.fact_order_item = doneItems;

  log(
    `\n事实表导入完成：${doneOrders.toLocaleString()} 订单 / ${doneItems.toLocaleString()} 明细，` +
      `耗时 ${humanDuration(Date.now() - shardStart)}`,
  );

  // ------------------------------------------------------------------
  // 3. 价格变更 / 库存变更流水
  // ------------------------------------------------------------------
  if (opts.priceChangePerProduct > 0) {
    rows.fact_product_price_change = await generatePriceChangeTable(
      opts,
      db,
      ctx,
      productRows,
    );
  }

  // ------------------------------------------------------------------
  // 4. 回填 first_order_time（新客判定用）
  // ------------------------------------------------------------------
  await backfillFirstOrderTime(db);

  // ------------------------------------------------------------------
  // 5. 清理临时文件
  // ------------------------------------------------------------------
  if (!opts.keepTsv) {
    await cleanTmp(opts.tmpDir);
  } else {
    log(`TSV 保留在 ${opts.tmpDir}`);
  }

  const elapsedMs = Date.now() - started;
  log(`\n=== 批量生成完成 ===`);
  log(`  总耗时  : ${humanDuration(elapsedMs)}`);
  log(`  TSV 体积: ${humanBytes(totalTsvBytes)}`);
  for (const [t, c] of Object.entries(rows)) {
    log(`  ${t.padEnd(26)} ${c.toLocaleString().padStart(14)} 行`);
  }
  log(`\n下一步：npm run generate:replay:${profile.key}   # 从数据区间终点开始模拟实时增量`);

  return { database: db, sizeKey: profile.key, rows, elapsedMs, tsvBytes: totalTsvBytes };
}

// =====================================================================
// 子步骤实现
// =====================================================================

function log(msg: string): void {
  // eslint-disable-next-line no-console
  console.log(msg);
}

async function ensureDatabaseAndSchema(db: string, recreate: boolean): Promise<void> {
  const root = await mysql.createConnection({
    host: config.db.host,
    port: config.db.port,
    user: config.db.user,
    password: config.db.password,
    timezone: config.db.timezone,
    multipleStatements: true,
  });
  try {
    if (recreate) {
      log(`[1/5] 重建数据库 ${db} ...`);
      await root.query(`DROP DATABASE IF EXISTS \`${db}\``);
    } else {
      log(`[1/5] 确保数据库 ${db} 存在 ...`);
    }
    await root.query(
      `CREATE DATABASE IF NOT EXISTS \`${db}\` DEFAULT CHARACTER SET utf8mb4 DEFAULT COLLATE utf8mb4_unicode_ci`,
    );
  } finally {
    await root.end();
  }

  // 建表：直接读 schema.sql 并替换占位符（与 DatabaseService 同一份 DDL）
  const { readFileSync } = await import('fs');
  const { join: pjoin } = await import('path');
  const schemaPath = pjoin(process.cwd(), 'sql', 'schema.sql');
  const sql = readFileSync(schemaPath, 'utf8').replace(/__DB__/g, db);
  const statements = sql
    .split('\n')
    .filter((l) => !l.trim().startsWith('--'))
    .join('\n')
    .split(';')
    .map((s) => s.trim())
    .filter((s) => s.length > 0)
    .filter((s) => !/^CREATE\s+DATABASE/i.test(s));

  const conn = await mysql.createConnection({
    host: config.db.host,
    port: config.db.port,
    user: config.db.user,
    password: config.db.password,
    database: db,
    timezone: config.db.timezone,
    multipleStatements: true,
  });
  try {
    for (const stmt of statements) {
      await conn.query(stmt);
    }
  } finally {
    await conn.end();
  }
  log(`      建表完成（${statements.length} 条 DDL）`);
}

/**
 * 维表：商品。生成 + 导入，并返回紧凑数组供事实表使用。
 *
 * 内存占用（1 亿档 / 5 万商品）：
 *   Int32Array(50000) = 200KB，Uint8Array(50000) = 50KB —— 可忽略
 *   对比 v1：把 500 万用户 ID 读进 number[] 需要约 40MB+ 且每次刷新重建
 */
async function generateAndLoadProducts(
  opts: BulkOptions,
  db: string,
): Promise<{
  /** 当前价（若启用价格历史，会被更新为区间终点价） */
  productPrice: Int32Array;
  /** 初始价（价格历史二分的基准，不随时间变化） */
  basePrice: Int32Array;
  productStatus: Uint8Array;
  productRows: ProductRow[];
  tsvBytes: number;
}> {
  const n = opts.profile.products;
  log(`[2/5] 生成商品维表 ${n.toLocaleString()} 行 ...`);

  const file = join(opts.tmpDir, `dim_product_${opts.profile.key}.tsv`);
  const w = new TsvWriter(file);
  const price = new Int32Array(n);
  const basePrice = new Int32Array(n);
  const status = new Uint8Array(n);
  const cache: ProductRow[] = new Array(n);

  for (let i = 0; i < n; i++) {
    const p = generateProduct(i, opts.seed, opts.startMs, n);
    cache[i] = p;
    const cents = Math.round(parseFloat(p.price) * 100);
    price[i] = cents;
    basePrice[i] = cents;
    status[i] = p.status;
    w.write([
      p.product_id, p.product_name, p.category, p.brand, p.price, p.cost_price,
      p.stock, p.status, p.is_deleted, p.deleted_time, p.create_time, p.update_time,
    ]);
  }
  await w.close();

  const conn = await openLoadConnection(db);
  const res = await loadFiles(conn, {
    database: db,
    table: 'dim_product',
    columns: [...TABLE_COLUMNS.dim_product],
    files: [file],
  });
  await closeLoadConnection(conn);

  const bytes = statSync(file).size;
  log(
    `      导入完成 ${res.rows.toLocaleString()} 行 ` +
      `(${res.rowsPerSec.toLocaleString()} 行/秒, ${humanBytes(bytes)})`,
  );
  return {
    productPrice: price,
    basePrice,
    productStatus: status,
    productRows: cache,
    tsvBytes: bytes,
  };
}

async function generateAndLoadUsers(opts: BulkOptions, db: string): Promise<number> {
  const n = opts.profile.users;
  log(`[3/5] 生成用户维表 ${n.toLocaleString()} 行 ...`);

  const file = join(opts.tmpDir, `dim_user_${opts.profile.key}.tsv`);
  const w = new TsvWriter(file);

  for (let i = 0; i < n; i++) {
    const u = generateUser(i, opts.seed, opts.startMs);
    w.write([
      u.user_id, u.username, u.phone, u.email, u.province, u.city,
      u.user_level, u.status, u.register_channel, u.first_order_time,
      u.is_deleted, u.deleted_time, u.create_time, u.update_time,
    ]);
  }
  await w.close();

  const conn = await openLoadConnection(db);
  const res = await loadFiles(conn, {
    database: db,
    table: 'dim_user',
    columns: [...TABLE_COLUMNS.dim_user],
    files: [file],
  });
  await closeLoadConnection(conn);

  const bytes = statSync(file).size;
  log(
    `      导入完成 ${res.rows.toLocaleString()} 行 ` +
      `(${res.rowsPerSec.toLocaleString()} 行/秒, ${humanBytes(bytes)})`,
  );
  return bytes;
}

/**
 * 价格变更流水：分片并行生成 + 导入。
 * 这是一张「无事实事实表」，让价格历史可被追溯
 * （v1 的 dim_product.price 只有当前值，调价历史全部丢失）。
 */
async function generatePriceChangeTable(
  opts: BulkOptions,
  db: string,
  ctx: OrderGenContext,
  products: ProductRow[],
): Promise<number> {
  const n = opts.profile.products;
  const perProduct = opts.priceChangePerProduct;
  log(
    `\n[4/5] 生成价格变更流水（约 ${Math.round(n * perProduct).toLocaleString()} 行）...`,
  );

  const ranges = splitRanges(n, opts.shards);
  const base = join(opts.tmpDir, `price_change_${opts.profile.key}`);

  let total = 0;
  let bytes = 0;

  await mapLimit(ranges, Math.min(opts.shards, ranges.length), async ([from, to], idx) => {
    const file = `${base}_s${String(idx).padStart(3, '0')}.tsv`;
    const w = new TsvWriter(file);
    for (let i = from; i < to; i++) {
      // ★ 只为「范围内」的商品写 INIT 初始版本记录。
      //   为什么必须有 INIT：第一条真实调价发生在区间内部（随机时刻），
      //   而订单从区间起点就开始产生 → 「区间起点 ~ 第一次调价」这段区间
      //   在 SCD2 里没有版本 → 按时间点关联时会大量丢行（实测丢 58%）。
      //   补 INIT 后版本序列从区间起点闭合，匹配率可达 100%。
      //
      //   范围外商品（changesPerProduct = 0）整段区间价格恒定，
      //   只需一个版本即可，写 INIT 同样正确 —— 为保持 SCD2 完整性也写。
      w.write([
        i + 1,
        null, // old_price：首次定价，无前值
        fromCents(ctx.basePriceCents![i]),
        'INIT',
        Clock.formatMs(ctx.dataStartMs),
      ]);

      const changes = priceChangesFromHistory(
        ctx.priceHistory!,
        i,
        ctx.basePriceCents![i],
        perProduct,
      );
      for (const c of changes) {
        w.write([
          c.product_id, c.old_price, c.new_price, c.change_type, c.change_time,
        ]);
      }
    }
    await w.close();

    const conn = await openLoadConnection(db);
    try {
      const res = await loadFiles(conn, {
        database: db,
        table: 'fact_product_price_change',
        columns: [...TABLE_COLUMNS.fact_product_price_change],
        files: [file],
      });
      total += res.rows;
      bytes += statSync(file).size;
    } finally {
      await closeLoadConnection(conn);
    }
  });

  log(`      导入完成 ${total.toLocaleString()} 行 (${humanBytes(bytes)})`);
  return total;
}

/**
 * ★ 按「每个商品各自的变更时间戳」逐次把价格写入 dim_product。
 *
 * 为什么不用原来的 `applyCurrentPrices`（一条 CASE WHEN 批量改）：
 *   那个做法把多行一次改完，所有行的 update_time 都是同一个值（区间终点）。
 *   后果：binlog 里重放出来的价格变更**时间戳全相同** →
 *         DWD 的 SCD2 会得到一堆时间点相同、顺序无意义的版本，拉链时间线是错的。
 *
 * 本函数改为：
 *   1. 收集全部 (product_id, price, change_time) 变更点，按 change_time 排序
 *   2. 分成若干块（每块 chunkSize 条），每块用一条 UPDATE 写完
 *   3. UPDATE 里用 CASE WHEN 为**每一行指定各自的 update_time**
 *
 *   SQL 形如：
 *     UPDATE dim_product
 *        SET price       = CASE product_id WHEN 101 THEN 55.20 WHEN 102 THEN 88.00 END,
 *            update_time = CASE product_id WHEN 101 THEN '2026-08-15 09:23:11'
 *                                          WHEN 102 THEN '2026-08-18 14:07:52' END
 *      WHERE product_id IN (101,102)
 *        AND price <> CASE product_id WHEN 101 THEN 55.20 WHEN 102 THEN 88.00 END
 *
 *   → 一次写多行（减少网络往返），但每行带自己的时间戳（不牺牲时间精度）
 *   → 末尾的 `AND price <> ...` 过滤值未变的行，避免产生「时间戳前进但价格没变」的伪版本
 *
 * 同时按时间顺序执行，保证 binlog 中的事件顺序 == 业务时间顺序。
 */
async function applyPriceHistoryByTime(
  opts: BulkOptions,
  db: string,
  history: PriceHistory,
  basePrice: Int32Array,
  productCount: number,
  endMs: number,
): Promise<void> {
  // 1) 收集全部变更点
  type Change = { pid: number; priceCents: number; atMs: number };
  const changes: Change[] = [];
  for (let i = 0; i < productCount; i++) {
    const n = history.counts[i];
    if (n === 0) continue;
    const tArr = history.times[i];
    const pArr = history.prices[i];
    for (let k = 0; k < n; k++) {
      changes.push({
        pid: i + 1,
        priceCents: pArr[k],
        atMs: history.epochBaseMs + tArr[k] * 1000,
      });
    }
  }
  if (changes.length === 0) return;

  // 2) 按时间排序（保证 binlog 顺序 == 业务时间顺序）
  changes.sort((a, b) => a.atMs - b.atMs);

  const conn = await mysql.createConnection({
    host: config.db.host,
    port: config.db.port,
    user: config.db.user,
    password: config.db.password,
    database: db,
    timezone: config.db.timezone,
    connectTimeout: 60_000,
  });

  try {
    await conn.query('SET SESSION sql_mode = ""');
    const CHUNK = opts.priceChangePerProduct > 0 ? 500 : 200;
    let affected = 0;

    for (let start = 0; start < changes.length; start += CHUNK) {
      const chunk = changes.slice(start, start + CHUNK);

      /**
       * 同一块内若同一商品出现多次（该商品的多次调价恰好落在同一块），
       * 只保留**最后一次** —— 因为一条 UPDATE 语句对一个商品只能写一个价格。
       * 中间态不单独体现，但它们已经作为独立的流水记录存在，
       * 且分块粒度足够细（500 条），跨块的调价仍会各自成为独立变更。
       */
      const lastByProduct = new Map<number, Change>();
      for (const c of chunk) lastByProduct.set(c.pid, c);

      const priceCase: string[] = [];
      const timeCase: string[] = [];
      const ids: number[] = [];
      for (const [pid, c] of lastByProduct) {
        ids.push(pid);
        priceCase.push(`WHEN ${pid} THEN ${(c.priceCents / 100).toFixed(2)}`);
        timeCase.push(`WHEN ${pid} THEN '${Clock.formatMs(c.atMs)}'`);
      }
      if (ids.length === 0) continue;

      const priceExpr = `CASE product_id ${priceCase.join(' ')} END`;
      const timeExpr = `CASE product_id ${timeCase.join(' ')} END`;

      const [res] = await conn.query(
        `UPDATE dim_product
            SET price = ${priceExpr},
                update_time = ${timeExpr}
          WHERE product_id IN (${ids.join(',')})
            AND price <> ${priceExpr}`,
      );
      affected += (res as mysql.ResultSetHeader).affectedRows ?? 0;
    }

    log(`      按时间戳写入 ${changes.toLocaleString()} 个变更点，实际更新 ${affected.toLocaleString()} 行`);
  } finally {
    await conn.end().catch(() => undefined);
  }
}



/** 回填 dim_user.first_order_time（新客判定用，避免实时链路维护大状态） */
async function backfillFirstOrderTime(db: string): Promise<void> {
  log(`\n[5/5] 回填 dim_user.first_order_time ...`);
  const conn = await mysql.createConnection({
    host: config.db.host,
    port: config.db.port,
    user: config.db.user,
    password: config.db.password,
    database: db,
    timezone: config.db.timezone,
    connectTimeout: 60_000,
  });
  try {
    // 用 JOIN + 聚合一次性回填。注意需要索引 idx_user_time(user_id, order_time)
    await conn.query('SET SESSION sql_mode = ""');
    const [res] = await conn.query(`
      UPDATE dim_user u
      JOIN (
        SELECT user_id, MIN(order_time) AS first_ot
        FROM fact_order
        GROUP BY user_id
      ) o ON o.user_id = u.user_id
      SET u.first_order_time = o.first_ot
      WHERE u.first_order_time IS NULL
    `);
    const affected = (res as mysql.ResultSetHeader).affectedRows ?? 0;
    log(`      回填 ${affected.toLocaleString()} 行`);
  } finally {
    await conn.end();
  }
}

async function cleanTmp(dir: string): Promise<void> {
  try {
    if (!existsSync(dir)) return;
    const files = await readdir(dir);
    for (const f of files) {
      rmSync(join(dir, f), { force: true });
    }
    log(`已清理临时目录 ${dir}`);
  } catch (e) {
    log(`清理临时目录失败（可忽略）：${(e as Error).message}`);
  }
}
