/**
 * Changelog 生成模式（changelog）★ 支撑 ODS → DWD SCD2 的关键
 *
 * =====================================================================
 * 为什么需要独立的 changelog 模式
 * =====================================================================
 *
 * 【核心限制】Flink CDC 的 `scan.startup.mode = 'initial'` 语义是：
 *     ① 先做一次全表快照（snapshot），每个表只发一条 +I（最终状态）
 *     ② 然后从「作业启动那一刻」的 binlog 位点开始读增量
 *
 *   ⇒ **作业启动之前发生的所有 UPDATE，都不会作为 changelog 事件出现。**
 *
 * 所以 bulk 模式（无论怎么写）都无法为"历史期"提供 changelog：
 *   - bulk 一次性 INSERT 最终状态  → 快照只有最终值，无 -U/+U
 *   - 即便 bulk 按虚拟时间顺序发 1000 万条 UPDATE，只要作业在之后启动，
 *     这些 UPDATE 就落在 binlog 里而不在"增量窗口"内，依然读不到
 *
 * 【本模式的做法】
 *   在 CDC 作业**运行期间**，按虚拟时间顺序逐条发出真实的 UPDATE 语句，
 *   从而在 binlog 中产生真实的 `-U / +U` 事件对，被 Flink CDC 捕获。
 *
 * 【必须用 scale=1（实时）】
 *   本模式刻意要求时间加速倍率为 1，原因：
 *     binlog 记录的是「提交时刻」（真实时间），而事件时间戳用的是虚拟时间。
 *     若 scale > 1，虚拟时间会跑在真实时间前面，
 *     导致 binlog 时间戳与虚拟时间戳不一致，
 *     下游任何基于 binlog 时间的窗口/水位线都会出错。
 *   scale=1 时虚拟时间 == 真实时间，两者语义一致。
 *
 * 【变更内容】
 *   为了让 DWD 商品 SCD2 维表「有东西可拉链」，本模式修改真正会变的属性：
 *     1. price       价格  ±10%          —— 同时也写 fact_product_price_change
 *     2. status      1 上架 / 0 下架      —— 真实的"下架"业务事件
 *     3. category    品类调整（小概率）    —— 让 SCD2 的品类属性真正变化
 *     4. brand       品牌变更（小概率）    —— 同上（并购/更名的业务场景）
 *
 *   ⚠️ 模型建议（Kimball）：**价格不应放进 SCD2 维表**，它是事实快照
 *      （见 数仓学习笔记 01 §4.4）。SCD2 应该只拉链真正需要历史轨迹的
 *      描述性属性（category / brand / status）。
 *      本模式两者都改，你可以自由选择拉链哪些列来做对照实验。
 */

import mysql from 'mysql2/promise';
import { config, SizeProfile } from '../config';
import { Clock } from '../clock/clock.service';
import { Rng, fromCents } from './rng';
import { CATEGORIES } from '../sim/seed-data';
import {
  RangeFilter,
  EMPTY_RANGE,
  buildSqlCondition,
  describe as describeRange,
  isEmpty as isRangeEmpty,
} from './range-filter';

const HOUR_MS = 3_600_000;

/**
 * 重放方式
 *   stream : 按虚拟时间顺序「逐条/小批」实时发出 UPDATE，模拟真实业务节奏
 *            （配合 Flink CDC 运行时用，变更以真实业务速率被捕获）
 *   batch  : 一次性把全部历史变更「按时间分块」重放完毕，**每行带自己的真实时间戳**
 *            （配合 earliest / initial 启动方式用：
 *              binlog 里从此有了时间戳正确的 -U/+U 序列，
 *              无论 CDC 用哪种 startup mode 都能得到正确的 SCD2 数据源）
 */
export type ReplayMode = 'stream' | 'batch';

export interface ChangelogOptions {
  profile: SizeProfile;
  /** 重放方式，默认 stream */
  replayMode?: ReplayMode;
  /** batch 模式：每个时间块包含多少条变更（越小时间线越细，但语句数越多） */
  batchChunk?: number;
  /** batch 模式：完成后是否删除 bulk 阶段补记的 FINAL 伪记录 */
  dropFinalRecords?: boolean;
  /** 起始虚拟时间 */
  startMs: number;
  /** 每个商品发出多少次价格变更 */
  priceChangesPerProduct: number;
  /** 品类变更概率（相对每次变更） */
  categoryChangeProb: number;
  /** 品牌变更概率 */
  brandChangeProb: number;
  /** 下架概率 */
  offShelfProb: number;
  /** 总变更上限（0 = 不限制）。用于控制实验规模 */
  maxTotalChanges: number;
  /** 运行时长上限（秒真实时间，0=不限） */
  maxRuntimeSec: number;
  /** 每秒最多发出多少条 UPDATE（保护源库 + 匹配 CDC 消费能力） */
  ratePerSecond: number;
  /** 进度日志间隔（秒） */
  logEverySec: number;
  seed: number;
  /**
   * 商品范围限定：只对范围内的商品重放价格变更。
   *
   * 用途（实验 4）：挑若干商品做精确对照，避免"事后大海捞针"。
   * 语义是「**只改这些，不改别的**」；为空则处理全部商品（原行为）。
   */
  productFilter?: RangeFilter;
}

export async function runChangelog(opts: ChangelogOptions): Promise<void> {
  const mode: ReplayMode = opts.replayMode ?? 'stream';
  if (mode === 'batch') {
    return runBatchReplay(opts);
  }
  const db = opts.profile.database;
  const log = (m: string) => console.log(m);

  log(`=== Changelog 生成（changelog / stream 模式）===`);
  log(`  目标库      : ${db}`);
  log(`  起始虚拟时间: ${Clock.formatMs(opts.startMs)}`);
  log(`  商品数      : ${opts.profile.products.toLocaleString()}`);
  log(`  价格变更/商品: ${opts.priceChangesPerProduct}`);
  log(`  变更内容    : price ±10% / status 下架 / category / brand`);
  log(`  发出速率    : ${opts.ratePerSecond} 条 UPDATE/秒`);
  if (opts.maxTotalChanges > 0) {
    log(`  总变更上限  : ${opts.maxTotalChanges.toLocaleString()} 条`);
  }
  log('');
  log(`  ⓘ 请确认此时 Flink CDC 作业已在运行（scan.startup.mode=initial）`);
  log(`    本模式产生的是真实 UPDATE，会在 binlog 中形成 -U/+U 事件对`);
  log('');

  // ------------------------------------------------------------------
  // 从价格历史还原「变更时间表」
  // ------------------------------------------------------------------
  // 说明：bulk 阶段已把每次调价写入 fact_product_price_change（含 change_time）。
  //       这里直接读它，保证 changelog 与已生成的流水完全一致。
  // ------------------------------------------------------------------
  const conn = await mysql.createConnection({
    host: config.db.host,
    port: config.db.port,
    user: config.db.user,
    password: config.db.password,
    database: db,
    timezone: config.db.timezone,
    connectTimeout: 30_000,
    charset: 'utf8mb4',
    dateStrings: true, // 见 batch 模式同名注释
  });
  await conn.query('SET SESSION sql_mode = ""');

  try {
    const [cntRows] = await conn.query(
      'SELECT COUNT(*) c FROM fact_product_price_change',
    );
    const planCount = Number((cntRows as any[])[0].c);
    if (planCount === 0) {
      log(
        `❌ fact_product_price_change 为空 —— 无法重建变更时间表。\n` +
          `   请先用 bulk 模式生成数据集，且 --price-changes>0。`,
      );
      return;
    }
    log(
      `变更时间表来源：fact_product_price_change（${planCount.toLocaleString()} 条历史记录）`,
    );
    log(
      `   → 这些是"已有价格历史"，本模式把它们**按时间顺序重新发一遍真实 UPDATE**，\n` +
        `     让 binlog 产生 -U/+U 事件，供 Flink CDC 构建 SCD2。\n`,
    );

    // 按时间分桶读取（避免一次性把全部行读进内存）
    const [minMax] = await conn.query(
      'SELECT MIN(change_time) mn, MAX(change_time) mx FROM fact_product_price_change',
    );
    const mnStr = (minMax as any[])[0].mn as string;
    const mxStr = (minMax as any[])[0].mx as string;
    if (!mnStr || !mxStr) {
      log('❌ 无法确定变更时间范围');
      return;
    }
    // MySQL DATETIME 字符串按 +08:00 解析
    const minMs = Date.parse(mnStr.replace(' ', 'T') + '+08:00');
    const maxMs = Date.parse(mxStr.replace(' ', 'T') + '+08:00');
    log(
      `变更时间范围：${mnStr} ~ ${mxStr}（跨度 ${((maxMs - minMs) / 86400000).toFixed(1)} 天）\n`,
    );

    // ------------------------------------------------------------------
    // 变更发射循环
    // ------------------------------------------------------------------
    const startedReal = Date.now();
    const rng = new Rng(opts.seed + 4242);
    const total = opts.maxTotalChanges > 0 ? opts.maxTotalChanges : planCount;
    let emitted = 0;
    let priceUpdates = 0;
    let statusUpdates = 0;
    let categoryUpdates = 0;
    let brandUpdates = 0;
    let skipped = 0;
    let lastLog = startedReal;

    // 虚拟时间游标：从变更时间范围的起点开始推进
    const spanMs = Math.max(1, maxMs - minMs);
    // 每发一条变更，虚拟时间前进多少
    const virtualStepMs = spanMs / total;

    let cursorMs = minMs;

    while (emitted < total) {
      const nowReal = Date.now();

      // 运行时长上限
      if (
        opts.maxRuntimeSec > 0 &&
        (nowReal - startedReal) / 1000 >= opts.maxRuntimeSec
      ) {
        log(`\n达到运行时长上限 ${opts.maxRuntimeSec}s，停止。`);
        break;
      }

      // 速率控制：本秒应发多少条
      const elapsedSec = (nowReal - startedReal) / 1000;
      const targetByNow = Math.floor(elapsedSec * opts.ratePerSecond);
      if (emitted >= targetByNow) {
        await sleep(Math.max(5, Math.min(50, 1000 / Math.max(opts.ratePerSecond, 1))));
        continue;
      }

      // 本批要处理的变更时间窗口
      const batchEnd = Math.min(
        maxMs,
        cursorMs + virtualStepMs * Math.min(opts.ratePerSecond, 200),
      );
      const virtualNowMs = cursorMs;

      // 取这个时间窗口内的价格变更记录
      const [rows] = await conn.query(
        `SELECT product_id, old_price, new_price, change_time
           FROM fact_product_price_change
          WHERE change_time >= ? AND change_time < ?
          ORDER BY change_time
          LIMIT 500`,
        [Clock.formatMs(cursorMs), Clock.formatMs(batchEnd)],
      );
      const changes = rows as any[];

      if (changes.length === 0) {
        cursorMs = batchEnd;
        if (cursorMs >= maxMs) {
          // 窗口走完了但还没发够 total：把游标重置回去继续
          cursorMs = minMs;
        }
        continue;
      }

      for (const ch of changes) {
        if (emitted >= total) break;
        const pid = Number(ch.product_id);
        // 变更时间用记录的 change_time（保持与流水表一致）
        const changeTimeSql = toSqlDatetime(ch.change_time);

        // ---- 1. 价格变更：真实 UPDATE（产生 -U/+U）----
        const res = await conn.query(
          `UPDATE dim_product SET price = ?, update_time = ?
            WHERE product_id = ? AND price <> ?`,
          [ch.new_price, changeTimeSql, pid, ch.new_price],
        );
        const affected = (res[0] as mysql.ResultSetHeader).affectedRows ?? 0;
        if (affected > 0) priceUpdates++;
        else skipped++; // 价格已是该值（幂等重跑时会出现）

        // ---- 2. 状态变更：下架（真实业务事件，SCD2 必须拉链）----
        if (rng.bool(opts.offShelfProb)) {
          const r2 = await conn.query(
            `UPDATE dim_product SET status = 0, update_time = ?
              WHERE product_id = ? AND status = 1`,
            [changeTimeSql, pid],
          );
          if (((r2[0] as mysql.ResultSetHeader).affectedRows ?? 0) > 0) {
            statusUpdates++;
          }
        }

        // ---- 3. 品类变更（让 SCD2 的品类属性真正变化）----
        if (rng.bool(opts.categoryChangeProb)) {
          const newCat = rng.pick(CATEGORIES).name;
          const r3 = await conn.query(
            `UPDATE dim_product SET category = ?, update_time = ?
              WHERE product_id = ? AND category <> ?`,
            [newCat, changeTimeSql, pid, newCat],
          );
          if (((r3[0] as mysql.ResultSetHeader).affectedRows ?? 0) > 0) {
            categoryUpdates++;
          }
        }

        // ---- 4. 品牌变更（同上）----
        if (rng.bool(opts.brandChangeProb)) {
          const cat = rng.pick(CATEGORIES);
          const newBrand = rng.pick(cat.brands);
          const r4 = await conn.query(
            `UPDATE dim_product SET brand = ?, update_time = ?
              WHERE product_id = ? AND brand <> ?`,
            [newBrand, changeTimeSql, pid, newBrand],
          );
          if (((r4[0] as mysql.ResultSetHeader).affectedRows ?? 0) > 0) {
            brandUpdates++;
          }
        }

        emitted++;
      }

      cursorMs = batchEnd;
      if (cursorMs >= maxMs) cursorMs = minMs;

      // 进度日志
      if (nowReal - lastLog >= opts.logEverySec * 1000) {
        const pct = ((emitted / total) * 100).toFixed(1);
        log(
          `  [${((nowReal - startedReal) / 1000).toFixed(0)}s] ${emitted.toLocaleString()}/${total.toLocaleString()} (${pct}%) | ` +
            `实际速率 ${(emitted / ((nowReal - startedReal) / 1000)).toFixed(1)} 条/秒 | ` +
            `price=${priceUpdates.toLocaleString()} status=${statusUpdates} cat=${categoryUpdates} brand=${brandUpdates}`,
        );
        lastLog = nowReal;
      }
    }

    const elapsed = (Date.now() - startedReal) / 1000;
    log(`\n=== changelog 生成完成 ===`);
    log(`  发出变更        : ${emitted.toLocaleString()} 条`);
    log(`  价格 UPDATE     : ${priceUpdates.toLocaleString()} 条（binlog 中的 -U/+U 事件对）`);
    log(`  状态(下架)      : ${statusUpdates.toLocaleString()} 条`);
    log(`  品类变更        : ${categoryUpdates.toLocaleString()} 条`);
    log(`  品牌变更        : ${brandUpdates.toLocaleString()} 条`);
    log(`  跳过(值未变)    : ${skipped.toLocaleString()} 条`);
    log(`  总耗时          : ${elapsed.toFixed(0)}s（${(emitted / elapsed).toFixed(1)} 条/秒）`);
    log('');
    log(`  下一步：在 Flink 里用 ODS 主键表 + changelog-producer 构建 SCD2：`);
    log(`    1) ODS 表设 'changelog-producer' = 'input'（或 'lookup'）`);
    log(`       并用 input 模式读取，才能拿到 -U/+U 事件对`);
    log(`    2) DWD 侧按主键时间序做拉链（对比属性值，值未变则不开新版本）`);
    log(`    3) 可用 fact_order_item.unit_price 做价格快照的交叉验证`);
  } finally {
    await conn.end().catch(() => undefined);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * 把任意形态的时间值归一化为 MySQL DATETIME(3) 字面量。
 *  - string（dateStrings=true）→ 原样返回
 *  - Date 对象 → 按 DB_TZ 格式化
 * 这是防御性处理：不同 mysql2 配置/版本下返回类型不同，
 * 一旦是 Date 对象却拿去拼 SQL，就会得到非法 DATETIME（实测踩过）。
 */
function toSqlDatetime(v: unknown): string {
  if (typeof v === 'string') return v;
  if (v instanceof Date) return Clock.format(v, config.db.timezone);
  return String(v);
}


// =====================================================================
// batch 重放模式：批量重放历史价格变更（带真实时间戳）
// =====================================================================
//
// 【解决的问题】
//   bulk 阶段的 applyCurrentPrices 用一条 `CASE WHEN` 批量改了多行价格，
//   这一批 UPDATE 的 update_time 全部是「区间终点」——**同一个时间戳**。
//   后果：通过 binlog 重放这批变更时，SCD2 只能得到一堆时间点相同、
//         顺序无意义的版本，拉链表的时间线是错的。
//
//   本模式把 dim_product 的价格改动**按 change_time 排序后分块重放**，
//   每行的 update_time 使用它自己的真实变更时刻，
//   从而在 binlog 中形成一条**时间戳正确、严格递增**的 -U/+U 序列。
//
// 【与 stream 模式的区别】
//   ┌──────────┬────────────────────────┬──────────────────────────┐
//   │          │ stream                 │ batch                    │
//   ├──────────┼────────────────────────┼──────────────────────────┤
//   │ 节奏     │ 按虚拟时间实时推进       │ 尽快跑完，不模拟节奏       │
//   │ 用途     │ CDC 运行中实时捕获变更    │ CDC 启动前把历史变更写进 binlog │
//   │ 适用启动 │ initial                │ **earliest 或 initial 均可** │
//   │ 时间精度 │ 由节拍决定（可能聚集）    │ **每行精确到自己的变更时刻**  │
//   └──────────┴────────────────────────┴──────────────────────────┘
//
// 【正确性保证】
//   1. 严格按 change_time 升序处理 → binlog 顺序 == 业务时间顺序
//   2. 每行的 update_time = 该行自己的 change_time → SCD2 时间线精确
//   3. 块内用 CASE WHEN 一次性写多行（每行各自的 update_time），
//      既减少语句数（网络往返），又不牺牲时间精度
//   4. 跳过 bulk 补记的 FINAL 伪记录（可选）—— 那是为了让流水表闭合而造的，
//      不是真实业务变更，不该出现在 SCD2 里

async function runBatchReplay(opts: ChangelogOptions): Promise<void> {
  const db = opts.profile.database;
  const log = (m: string) => console.log(m);
  const chunkSize = opts.batchChunk && opts.batchChunk > 0 ? opts.batchChunk : 500;
  const dropFinal = opts.dropFinalRecords !== false;
  const productFilter: RangeFilter = opts.productFilter ?? EMPTY_RANGE;

  log(`=== Changelog 生成（changelog / ★batch 模式）===`);
  log(`  目标库      : ${db}`);
  log(`  批次大小    : ${chunkSize} 条变更/语句`);
  log(`  商品范围    : ${describeRange(productFilter)}`);
  log(`  删除 FINAL  : ${dropFinal ? '是（FINAL 是 bulk 补记的伪记录，非真实变更）' : '否'}`);
  log('');
  log(`  作用：把历史价格变更按时间顺序重放为真实 UPDATE，`);
  log(`        每行带自己的 change_time 作为 update_time，`);
  log(`        使 binlog 中的 -U/+U 序列时间戳正确 → SCD2 时间线正确。`);
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
    // ★ 必须：否则 DATETIME 列会返回 JS Date 对象，
    //   字符串插值后变成 'Fri Oct 24 2025 08:10:25 GMT+0800 (...)'，
    //   MySQL 报 ER_WRONG_VALUE（实测踩过）
    dateStrings: true,
  });
  await conn.query('SET SESSION sql_mode = ""');

  try {
    // ------------------------------------------------------------------
    // 1. 读取全部历史变更（按时间升序），排除 FINAL 伪记录
    // ------------------------------------------------------------------
    const cntParams: unknown[] = [];
    const cntConds: string[] = [];
    if (dropFinal) cntConds.push("change_type <> 'FINAL'");
    const cntRange = buildSqlCondition(productFilter, 'product_id', cntParams);
    if (cntRange) cntConds.push(cntRange.replace(/^ AND /, ''));
    const [cntRows] = await conn.query(
      `SELECT COUNT(*) c FROM fact_product_price_change` +
        (cntConds.length ? ` WHERE ${cntConds.join(' AND ')}` : ''),
      cntParams,
    );
    const total = Number((cntRows as any[])[0].c);
    if (total === 0) {
      log('❌ 没有可重放的变更记录。请先用 bulk 模式生成数据集。');
      return;
    }
    log(`待重放变更：${total.toLocaleString()} 条`);

    // 用一个游标按 change_time 分页读取，避免全量载入内存
    const startedReal = Date.now();
    let processed = 0;
    let updatedRows = 0;
    let noopRows = 0;
    let lastLog = startedReal;
    /**
     * keyset 分页游标（复合键）。
     *
     * ⚠️ 踩过的坑：最初只用 `change_time > lastTime` 做游标，
     *    但同一时间戳可能有多行 —— 尤其是 INIT 初始版本记录，
     *    5000 个商品的时间戳**完全相同**（都是区间起点）。
     *    结果翻页时把同时间戳的剩余行整批跳过，
     *    实测 20000 条只处理了 15499 条（丢 4501 条，恰好是 INIT 的绝大部分）。
     *    修法：游标必须用 `(change_time, change_id)` 复合键。
     */
    let lastTime = '';
    let lastId = 0;

    // 记录每个商品的「上一个已知价格」用于生成正确的前像语义校验
    // （注意：我们不改 old_price，只改 price → update_time，
    //   前像由 MySQL 自己在 binlog 中生成，所以这里不需要额外处理）

    for (;;) {
      // 取下一块：按 (change_time, change_id) 升序，跨块时用游标续接
      const conds: string[] = [];
      const params: unknown[] = [];
      if (dropFinal) conds.push("change_type <> 'FINAL'");
      if (lastTime) {
        // 复合游标：时间相同则按 change_id 续接，避免同时间戳的行被跳过
        conds.push('(change_time > ? OR (change_time = ? AND change_id > ?))');
        params.push(lastTime, lastTime, lastId);
      }
      // ★ 商品范围限定：只重放范围内商品的变更
      const rangeCond = buildSqlCondition(productFilter, 'product_id', params);
      if (rangeCond) conds.push(rangeCond.replace(/^ AND /, '').replace(/^/, '').slice(0));
      params.push(chunkSize);
      const [rows] = await conn.query(
        `SELECT change_id, product_id, new_price, change_time
           FROM fact_product_price_change
          ${conds.length ? 'WHERE ' + conds.join(' AND ') : ''}
          ORDER BY change_time, change_id
          LIMIT ?`,
        params,
      );
      const changes = rows as any[];
      if (changes.length === 0) break;

      // ------------------------------------------------------------------
      // 2. 构造「每行各自时间戳」的批量 UPDATE
      //    CASE WHEN product_id = X THEN '<该行自己的 change_time>' END
      //    价格取该块内每个商品的**最后一条**变更值（块内多条时以最后为准）
      // ------------------------------------------------------------------
      const priceCase: string[] = [];
      const timeCase: string[] = [];
      const ids: number[] = [];

      // 块内同一商品可能有多条变更：取最后一条作为价格，
      // 时间戳也取最后一条（中间态不单独体现——但如果它们在不同块里，
      // 就会各自成为一次独立的、时间戳正确的变更，这正是我们要的粒度）
      const lastByProduct = new Map<number, { price: string; time: string }>();
      for (const ch of changes) {
        const pid = Number(ch.product_id);
        // 归一化为 MySQL DATETIME 字面量（防御：驱动可能返回 Date 或 string）
        const t = toSqlDatetime(ch.change_time);
        lastByProduct.set(pid, { price: String(ch.new_price), time: t });
      }
      // 游标推进到本页最后一行（按 ORDER BY change_time, change_id）
      const tail = changes[changes.length - 1];
      lastTime = toSqlDatetime(tail.change_time);
      lastId = Number(tail.change_id);

      for (const [pid, v] of lastByProduct) {
        ids.push(pid);
        priceCase.push(`WHEN ${pid} THEN ${Number(v.price).toFixed(2)}`);
        timeCase.push(`WHEN ${pid} THEN '${v.time}'`);
      }
      if (ids.length === 0) {
        processed += changes.length;
        continue;
      }

      // 只更新价格确实发生变化的行，避免产生「值未变」的伪 UPDATE
      // （虽然 v2 的 schema 已去掉 ON UPDATE CURRENT_TIMESTAMP，
      //   但显式 SET 同值同样会让 update_time 前进，产生伪版本）
      const [res] = await conn.query(
        `UPDATE dim_product
            SET price = CASE product_id ${priceCase.join(' ')} END,
                update_time = CASE product_id ${timeCase.join(' ')} END
          WHERE product_id IN (${ids.join(',')})
            AND price <> CASE product_id ${priceCase.join(' ')} END`,
      );
      const affected = (res as mysql.ResultSetHeader).affectedRows ?? 0;
      updatedRows += affected;
      noopRows += ids.length - affected;
      processed += changes.length;

      // 进度
      const nowReal = Date.now();
      if (nowReal - lastLog >= opts.logEverySec * 1000) {
        const pct = ((processed / total) * 100).toFixed(1);
        log(
          `  [${((nowReal - startedReal) / 1000).toFixed(0)}s] ${processed.toLocaleString()}/${total.toLocaleString()} (${pct}%) | ` +
            `已更新时间戳 ${updatedRows.toLocaleString()} 行 | 值未变跳过 ${noopRows.toLocaleString()} 行`,
        );
        lastLog = nowReal;
      }
    }

    const elapsed = (Date.now() - startedReal) / 1000;
    log('');
    log(`=== batch 重放完成 ===`);
    log(`  处理变更        : ${processed.toLocaleString()} 条`);
    // ★ 完整性断言：分页必须覆盖全部待处理行，否则说明游标有 bug
    if (processed !== total) {
      log(
        `  ❌ 不一致：应处理 ${total.toLocaleString()} 条，实际只处理 ${processed.toLocaleString()} 条` +
          `（缺 ${(total - processed).toLocaleString()} 条）—— 分页游标有问题，请勿继续使用该数据集！`,
      );
    } else {
      log(`  ✅ 完整性校验：分页覆盖全部 ${total.toLocaleString()} 条待处理变更`);
    }
    log(`  实际 UPDATE 行数: ${updatedRows.toLocaleString()} 行（binlog 中的 -U/+U 事件对）`);
    log(`  值未变跳过      : ${noopRows.toLocaleString()} 行（不产生伪版本）`);
    log(`  总耗时          : ${elapsed.toFixed(1)}s`);
    log('');

    // ------------------------------------------------------------------
    // 3. 可选：清理 FINAL 伪记录
    // ------------------------------------------------------------------
    if (dropFinal) {
      const [r] = await conn.query(
        "DELETE FROM fact_product_price_change WHERE change_type = 'FINAL'",
      );
      const del = (r as mysql.ResultSetHeader).affectedRows ?? 0;
      log(`已清理 FINAL 伪记录：${del.toLocaleString()} 条`);
      log(
        `  （FINAL 是 bulk 为了让流水表"版本闭合"补记的，不是真实业务变更；
` +
          `    删掉后 fact_product_price_change 就是一份干净的变更流水）`,
      );
      log('');
    }

    // ------------------------------------------------------------------
    // 4. 校验：每个商品的时间戳是否严格递增
    // ------------------------------------------------------------------
    const [check] = await conn.query(
      `SELECT COUNT(*) c FROM (
         SELECT product_id, change_time,
                LAG(change_time) OVER (PARTITION BY product_id ORDER BY change_time) AS prev_t
         FROM fact_product_price_change
       ) t WHERE prev_t IS NOT NULL AND change_time <= prev_t`,
    );
    const bad = Number((check as any[])[0].c);
    log(`时间戳递增性校验：逆序 ${bad} 条 ${bad === 0 ? '✅' : '❌'}`);

    const [stat] = await conn.query(
      `SELECT COUNT(*) total,
              COUNT(DISTINCT product_id) prods,
              MIN(change_time) mn, MAX(change_time) mx
         FROM fact_product_price_change`,
    );
    const st = (stat as any[])[0];
    log(
      `变更流水现状：${Number(st.total).toLocaleString()} 条 / ${Number(st.prods).toLocaleString()} 个商品 / ` +
        `${st.mn} ~ ${st.mx}`,
    );
    log('');
    log(`  下一步：此时 binlog 中已有一条**时间戳正确**的商品变更序列。`);
    log(`    · 用 earliest 启动 CDC → 会重放这段历史，ODS 得到完整 changelog`);
    log(`    · 用 initial  启动 CDC → 快照拿最终状态，之后的变更才是增量`);
    log(`    两种方式下，DWD 用 ODS 的 input changelog 构建 SCD2，时间线都正确。`);
  } finally {
    await conn.end().catch(() => undefined);
  }
}
