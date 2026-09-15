#!/usr/bin/env node
/**
 * 数据源生成器 CLI
 *
 * 用法（对应 package.json 里的 npm scripts）：
 *   npm run generate:1m             批量生成 100 万订单  → eshop_1m
 *   npm run generate:10m            批量生成 1000 万订单 → eshop_10m
 *   npm run generate:100m           批量生成 1 亿订单    → eshop_100m
 *
 *   npm run generate:replay:1m      在 1m 数据集上追加实时增量
 *   npm run generate:replay:10m     同上（10m）
 *   npm run generate:replay:100m    同上（100m）
 *
 * 高级参数（直接传 flags）：
 *   --days=31                 数据时间跨度（天）
 *   --pattern=diurnal|uniform|flashsale   时间分布形态
 *   --shards=4                并行分片数
 *   --seed=20251001           随机种子（固定种子 → 数据可复现）
 *   --keep-tsv                保留生成的 TSV 文件
 *   --no-recreate             不重建库（默认会 DROP 后重建，保证幂等）
 *   --price-changes=3         每商品价格变更次数（0=不生成）
 *   --late-ratio=0.02         乱序注入比例（实验 9：Watermark/迟到数据）
 *   --no-stock-change         不生成库存变更流水
 *
 * 重要：所有参数在 import 业务模块之前写入 process.env，
 *       因为 src/config.ts 在模块加载时就读取环境变量。
 */

import { parseSize, SizeProfile } from '../config';
import { parseRange, describe as describeRange } from './range-filter';

interface CliArgs {
  mode: 'bulk' | 'replay' | 'changelog' | 'cdcload' | 'cdcreset';
  size: SizeProfile | null;
  days?: number;
  pattern?: string;
  shards?: number;
  seed?: number;
  keepTsv?: boolean;
  recreate?: boolean;
  priceChanges?: number;
  lateRatio?: number;
  /** replay：事件时间相对当前时刻的抖动上限（毫秒）。0 = 严格有序，实验 9 用 */
  streamJitterMs?: number;
  withStockChange?: boolean;
  // replay 专用
  ordersPerDay?: number;
  timeScale?: number;
  withChurn?: boolean;
  batchRows?: number;
  maxRuntimeSec?: number;
  burstEverySec?: number;
  burstMultiplier?: number;
  burstDurationSec?: number;
  startAt?: string;
  logEverySec?: number;
  // changelog 专用
  changesPerProduct?: number;
  maxChanges?: number;
  updateRate?: number;
  offShelfProb?: number;
  categoryProb?: number;
  brandProb?: number;
  replayMode?: 'stream' | 'batch';
  batchChunk?: number;
  dropFinal?: boolean;
  // 目标范围限定（实验用）
  orderIdRange?: string;
  productIdRange?: string;
  targetOrderIds?: string;
  targetProductIds?: string;
  priceChangeProducts?: string;
  // 实验2 CDC 基准专用
  rate?: number;
  minutes?: number;
  help: boolean;
}

const CMD_MAP: Record<string, { mode: CliArgs['mode']; size: string }> = {
  'generate:1m': { mode: 'bulk', size: '1m' },
  'generate:10m': { mode: 'bulk', size: '10m' },
  'generate:100m': { mode: 'bulk', size: '100m' },
  'generate:replay:1m': { mode: 'replay', size: '1m' },
  'generate:replay:10m': { mode: 'replay', size: '10m' },
  'generate:replay:100m': { mode: 'replay', size: '100m' },
  'generate:changelog:1m': { mode: 'changelog', size: '1m' },
  'generate:changelog:10m': { mode: 'changelog', size: '10m' },
  'generate:changelog:100m': { mode: 'changelog', size: '100m' },
  // 实验2：CDC 端到端延迟/吞吐 基准
  'cdc:reset:1m': { mode: 'cdcreset', size: '1m' },
  'cdc:reset:10m': { mode: 'cdcreset', size: '10m' },
  'cdc:reset:100m': { mode: 'cdcreset', size: '100m' },
  'cdc:load:1m': { mode: 'cdcload', size: '1m' },
  'cdc:load:10m': { mode: 'cdcload', size: '10m' },
  'cdc:load:100m': { mode: 'cdcload', size: '100m' },
};

/**
 * 各规模的默认「每日订单数」。
 * 口径：让 replay 追加的新订单速率与 bulk 历史数据的日均产量一致，
 *       这样整条时间线上的业务速率是连续的。
 *   1m   : 1,000,000 / 31 天   ≈ 32,258    → 取 35,000
 *   10m  : 10,000,000 / 90 天  ≈ 111,111   → 取 115,000
 *   100m : 100,000,000 / 31 天 ≈ 3,225,806 → 取 3,230,000
 */
const DEFAULT_ORDERS_PER_DAY: Record<string, number> = {
  '1m': 35_000,
  '10m': 115_000,
  '100m': 3_230_000,
};

function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = { mode: 'bulk', size: null, help: false };

  // 第一段：npm 传入的脚本名（如 generate:100m）
  const scriptName = argv[0];
  const mapped = scriptName ? CMD_MAP[scriptName] : undefined;
  if (mapped) {
    args.mode = mapped.mode;
    args.size = parseSize(mapped.size);
  }

  const num = (v: string | undefined, dflt?: number): number | undefined => {
    if (v === undefined) return dflt;
    const n = parseFloat(v);
    return Number.isFinite(n) ? n : dflt;
  };

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const [key, inlineVal] = a.includes('=') ? a.split(/=(.*)/s, 2) : [a, undefined];

    switch (key) {
      case '--mode':
        args.mode = (inlineVal ?? argv[++i]) as CliArgs['mode'];
        break;
      case '--size':
        args.size = parseSize(inlineVal ?? argv[++i]);
        break;
      case '--days':
        args.days = num(inlineVal ?? argv[++i]);
        break;
      case '--pattern':
        args.pattern = inlineVal ?? argv[++i];
        break;
      case '--shards':
        args.shards = num(inlineVal ?? argv[++i]);
        break;
      case '--seed':
        args.seed = num(inlineVal ?? argv[++i]);
        break;
      case '--keep-tsv':
        args.keepTsv = true;
        break;
      case '--no-recreate':
        args.recreate = false;
        break;
      case '--recreate':
        args.recreate = true;
        break;
      case '--price-changes':
        args.priceChanges = num(inlineVal ?? argv[++i]);
        break;
      case '--late-ratio':
        args.lateRatio = num(inlineVal ?? argv[++i]);
        break;
      case '--stream-jitter-ms':
        // 实验 9：0 = 干净基线（到达顺序==事件时间顺序）
        args.streamJitterMs = num(inlineVal ?? argv[++i]);
        break;
      case '--no-stock-change':
        args.withStockChange = false;
        break;
      case '--orders-per-day':
        args.ordersPerDay = num(inlineVal ?? argv[++i]);
        break;
      case '--time-scale':
        args.timeScale = num(inlineVal ?? argv[++i]);
        break;
      case '--with-churn':
        args.withChurn = true;
        break;
      case '--no-churn':
        args.withChurn = false;
        break;
      case '--batch-rows':
        args.batchRows = num(inlineVal ?? argv[++i]);
        break;
      case '--max-runtime':
        args.maxRuntimeSec = num(inlineVal ?? argv[++i]);
        break;
      case '--burst-every':
        args.burstEverySec = num(inlineVal ?? argv[++i]);
        break;
      case '--burst-multiplier':
        args.burstMultiplier = num(inlineVal ?? argv[++i]);
        break;
      case '--burst-duration':
        args.burstDurationSec = num(inlineVal ?? argv[++i]);
        break;
      case '--start-at':
        args.startAt = inlineVal ?? argv[++i];
        break;
      case '--log-every':
        args.logEverySec = num(inlineVal ?? argv[++i]);
        break;
      // ===== 实验2 CDC 基准专用 =====
      case '--rate':
        args.rate = num(inlineVal ?? argv[++i]);
        break;
      case '--minutes':
        args.minutes = num(inlineVal ?? argv[++i]);
        break;
      case '--changes-per-product':
        args.changesPerProduct = num(inlineVal ?? argv[++i]);
        break;
      case '--max-changes':
        args.maxChanges = num(inlineVal ?? argv[++i]);
        break;
      case '--update-rate':
        args.updateRate = num(inlineVal ?? argv[++i]);
        break;
      case '--offshelf-prob':
        args.offShelfProb = num(inlineVal ?? argv[++i]);
        break;
      case '--category-prob':
        args.categoryProb = num(inlineVal ?? argv[++i]);
        break;
      case '--brand-prob':
        args.brandProb = num(inlineVal ?? argv[++i]);
        break;
      case '--replay':
        args.replayMode = (inlineVal ?? argv[++i]) as 'stream' | 'batch';
        break;
      case '--batch-chunk':
        args.batchChunk = num(inlineVal ?? argv[++i]);
        break;
      case '--keep-final':
        args.dropFinal = false;
        break;
      // ===== 目标范围限定 =====
      case '--order-id-range':
        args.orderIdRange = inlineVal ?? argv[++i];
        break;
      case '--product-id-range':
        args.productIdRange = inlineVal ?? argv[++i];
        break;
      case '--target-order-ids':
        args.targetOrderIds = inlineVal ?? argv[++i];
        break;
      case '--target-product-ids':
        args.targetProductIds = inlineVal ?? argv[++i];
        break;
      case '--price-change-products':
        args.priceChangeProducts = inlineVal ?? argv[++i];
        break;
      case '--help':
      case '-h':
        args.help = true;
        break;
      default:
        if (a.startsWith('--')) {
          console.warn(`[warn] 未知参数，已忽略：${a}`);
        }
    }
  }

  return args;
}

function printHelp(): void {
  console.log(`
eshop-datasource 数据生成器

批量生成（一次性写入独立数据库）：
  npm run generate:1m            100 万订单  → eshop_1m
  npm run generate:10m           1000 万订单 → eshop_10m
  npm run generate:100m          1 亿订单    → eshop_100m

实时增量（在已有数据集上追加）：
  npm run generate:replay:1m    → 35,000 单/天 的实时订单 + 变更事件
  npm run generate:replay:10m   → 115,000 单/天
  npm run generate:replay:100m  → 3,230,000 单/天

Changelog 生成（★ 供 ODS→DWD SCD2 用）—— 两种子模式：

  A) stream（默认）：模拟真实业务节奏逐条发变更，需 CDC 作业同时在运行
     npm run generate:changelog:1m
     适用 startup mode: initial

  B) batch（★ 推荐）：一次性把历史价格变更按时间顺序重放完毕，
     **每行带自己的真实时间戳** —— binlog 中形成时间戳正确的 -U/+U 序列
     npm run generate:changelog:1m -- --replay=batch
     适用 startup mode: earliest 或 initial 均可
     解决了 bulk 用 CASE WHEN 批量改价导致"一批 UPDATE 同一时间戳"的问题

CDC 端到端延迟/吞吐 基准（★ 实验2 专用，只写 cdc_test 表）：

  三步走（两种 CDC 模式各做一遍，两次 run 之间**不要清表**）：

    # 1) 清空 cdc_test —— 必须在两种 CDC 都还没启动时执行
    npm run cdc:reset:1m

    # 2) 启动 Flink CDC 作业（或 Debezium connector），等它 RUNNING

    # 3) 以 500 行/秒写入 5 分钟
    npm run cdc:load:1m -- --rate 500 --minutes 5

  跑完会打印本次 run 的 id 区间，分析 P50/P95 时用它区分两次 run。

  ★ 本模式强制使用**真实墙钟**（会忽略 SIM_EPOCH）。
    原因：延迟 = sink_time - source_time，而 source_time 是 binlog 的墙上时间，
    若 create_time 用虚拟时钟，两个时间戳就不在同一时间轴上。

  参数：
    --rate=500       目标写入速率（行/秒）
    --minutes=5      持续时长（分钟，支持小数）
    --log-every=5    进度打印间隔（秒）

  说明：cdc_test 里只有 create_time_ms（epoch 毫秒）和 create_time 由本写入器填；
        source_time / sink_time 恒为 NULL，由 CDC 链路各自填入。

  ★ 延迟锚点用 create_time_ms，不要用 source_time ★
    实测 MySQL binlog 事件时间只有**秒级**精度（source.ts_ms 恒为 1000 的整数倍），
    用它算延迟会有 +0~1000ms 的量化误差，会淹没真实延迟。

常用参数：
  --days=31                 数据时间跨度（天）
  --pattern=diurnal         时间分布：diurnal(默认,真实作息) | uniform | flashsale
  --shards=4                并行分片数
  --seed=20251001           随机种子（固定种子保证数据可复现）
  --keep-tsv                保留 TSV 文件（便于重导/排查）
  --no-recreate             不 DROP 重建库（默认重建，保证幂等）
  --price-changes=3         每商品价格变更次数（0=不生成价格流水）
  --late-ratio=0.02         乱序注入比例（实验 9）
  --orders-per-day=35000    replay 速率
  --time-scale=60           replay 时间加速倍率
  --stream-jitter-ms=0      实验9：事件时间抖动上限（毫秒）
                            0=到达顺序严格==事件时间顺序（干净基线）
                            默认 60000（事件时间在最近 60 秒内均匀散开）
                            做 watermark 实验时必须显式设小，否则全部迟到
  --max-runtime=300         replay 运行时长上限（秒）
  --burst-every=120 --burst-multiplier=10 --burst-duration=30
                            促销峰值冲击（测背压 / checkpoint 抖动）
  --start-at=2025-11-01T00:00:00+08:00   replay 起始虚拟时间

★ 目标范围限定（实验用）—— 语义是「只改这些，不改别的」：
  --target-order-ids=10001,10002,10003       只对这几个订单做状态流转/取消
  --order-id-range=1000-2000                 只对订单 ID 区间（支持 1000- / -2000）
  --target-product-ids=100,200,300-320       只对这几个商品调价
  --product-id-range=1-500                   只对商品 ID 区间
  --price-change-products=1-500              生成数据集时只让这些商品有价格历史
                                             （实验 4 用：精确控制"哪些商品被调过价"）

  可混用枚举/区间：--target-product-ids=1,5,10-20,100-

changelog 专用参数：
  --price-changes=3         每商品发出多少次价格变更
  --max-changes=300000      总变更上限（控制实验规模）
  --update-rate=200         每秒发出多少条 UPDATE（保护源库）
  --offshelf-prob=0.03      下架概率
  --category-prob=0.05      品类变更概率（让 SCD2 真正拉链）
  --brand-prob=0.05         品牌变更概率
  --replay=stream|batch     重放方式（默认 stream）
  --batch-chunk=500         batch 模式每批多少条变更
  --keep-final              batch 模式保留 FINAL 伪记录（默认删除）

环境变量（连接配置）：
  DB_HOST DB_PORT DB_USER DB_PASSWORD DB_NAME DB_TZ
  SIM_EPOCH              虚拟时间起点，如 2025-11-01T00:00:00+08:00
  SIM_TIME_SCALE         时间加速倍率
`);
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const args = parseArgs(argv);

  if (args.help || argv.length === 0) {
    printHelp();
    process.exit(0);
  }

  if (!args.size) {
    console.error('错误：未指定规模。用法见下方帮助。\n');
    printHelp();
    process.exit(1);
  }

  const profile = args.size;

  // ==================================================================
  // 实验2 专用模式：CDC 基准写入 / 清表
  //
  // ★ 必须放在下面「虚拟时钟兜底默认值」那段之前 ★
  //   那段会在 SIM_EPOCH 为空时强行塞一个"当天 00:00"，
  //   而本实验的延迟锚点必须是真实墙钟 —— 否则 create_time 与
  //   source_time(binlog 墙钟) / sink_time(Flink 墙钟) 不在同一时间轴上，
  //   算出来的延迟是废数。详见 src/gen/cdc-load.ts 头部说明。
  // ==================================================================
  if (args.mode === 'cdcload' || args.mode === 'cdcreset') {
    process.env.DB_NAME = profile.database;
    if (process.env.SIM_EPOCH) {
      console.warn(
        `[warn] 检测到 SIM_EPOCH=${process.env.SIM_EPOCH}，` +
          `但实验2 的延迟口径要求真实墙钟，本次已忽略它。`,
      );
    }
    delete process.env.SIM_EPOCH;

    const { initClock } = await import('../clock/clock.service.js');
    const clock = initClock(null, 1);

    if (args.mode === 'cdcreset') {
      const { runCdcReset } = await import('./cdc-load.js');
      await runCdcReset({ database: profile.database });
      process.exit(0);
    }

    const { runCdcLoad } = await import('./cdc-load.js');
    await runCdcLoad({
      database: profile.database,
      ratePerSecond: args.rate ?? 500,
      durationSec: (args.minutes ?? 5) * 60,
      logEverySec: args.logEverySec ?? 5,
      clock,
    });
    process.exit(0);
  }

  const DAY_MS = 86_400_000;

  // ------------------------------------------------------------------
  // 关键：在 import 业务模块之前把所有参数写入 process.env
  // （src/config.ts 在模块加载时读取环境变量）
  // ------------------------------------------------------------------

  // 目标数据库随规模切换
  process.env.DB_NAME = profile.database;

  // 数据区间：默认数据区间终点 = 虚拟时间的"今天"，起点 = 终点 - days 天
  const defaultEnd = new Date(); // 仅用于构造 ISO 字符串，不直接写入数据
  const days = args.days ?? profile.days;
  const pattern = args.pattern ?? 'diurnal';
  const shards = args.shards ?? 4;
  const seed = args.seed ?? 20251001;
  const priceChanges = args.priceChanges ?? 3;
  const lateRatio = args.lateRatio ?? 0;

  process.env.GEN_PATTERN = pattern;
  process.env.GEN_SHARDS = String(shards);
  process.env.GEN_SEED = String(seed);
  process.env.GEN_LATE_RATIO = String(lateRatio);
  // 实验 9 的自变量之一：事件时间抖动上限。默认 60000，保持既有行为不变。
  process.env.GEN_STREAM_JITTER_MS = String(args.streamJitterMs ?? 60_000);
  if (args.keepTsv) process.env.GEN_KEEP_TSV = 'true';
  if (args.batchRows) process.env.GEN_BATCH_ROWS = String(args.batchRows);

  // 虚拟时钟：必须设置 SIM_EPOCH，否则写入的时间戳会是机器真实时间
  // （这正是计划 4.0 节指出的致命 bug，v2 通过显式虚拟时钟修掉）
  if (!process.env.SIM_EPOCH) {
    // 默认：虚拟"今天" = 运行时刻所在自然日的 00:00（本地时区，按 +08:00 呈现）
    const nowMs = defaultEnd.getTime();
    const tzOffsetMin = 8 * 60; // +08:00
    const localDayStartMs =
      Math.floor((nowMs + tzOffsetMin * 60_000) / DAY_MS) * DAY_MS - tzOffsetMin * 60_000;
    process.env.SIM_EPOCH = new Date(localDayStartMs).toISOString();
  }

  const endMs = Date.parse(process.env.SIM_EPOCH);
  const startMs = endMs - days * DAY_MS;

  // ===== 解析范围过滤器 =====
  // 组合规则：--target-xxx-ids 与 --xxx-id-range 可同时给出，取并集
  const joinExpr = (...parts: (string | undefined)[]) =>
    parts.filter((x) => x && x.trim() !== '').join(',');

  let churnOrderFilter, churnProductFilter, orderIdFilter, priceChangeFilter;
  try {
    const orderExpr = joinExpr(args.targetOrderIds, args.orderIdRange);
    const productExpr = joinExpr(args.targetProductIds, args.productIdRange);
    churnOrderFilter = parseRange(orderExpr);
    // 注意：不把订单范围复用给 orderIdFilter。
    // replay 目前总是从 max_order_id+1 连续生成新订单，
    // 若把新订单也限制在某个区间，会与已有 ID 重叠。
    // orderIdFilter 预留给未来的"指定新订单 ID 区间"用法。
    orderIdFilter = parseRange(undefined);
    churnProductFilter = parseRange(productExpr);
    priceChangeFilter = parseRange(args.priceChangeProducts);
  } catch (e) {
    console.error(`错误：范围参数解析失败 —— ${(e as Error).message}`);
    process.exit(1);
  }

  if (churnOrderFilter.ranges.length || churnProductFilter.ranges.length || priceChangeFilter.ranges.length) {
    console.log('[info] 目标范围限定已生效：');
    if (churnOrderFilter.ranges.length) console.log(`        订单范围  = ${describeRange(churnOrderFilter)}`);
    if (churnProductFilter.ranges.length) console.log(`        商品范围  = ${describeRange(churnProductFilter)}`);
    if (priceChangeFilter.ranges.length) console.log(`        价格历史范围 = ${describeRange(priceChangeFilter)}`);
    console.log('');
  }

  const { initClock, Clock } = await import('../clock/clock.service.js');
  initClock(process.env.SIM_EPOCH, parseFloat(process.env.SIM_TIME_SCALE ?? '1'));

  if (args.mode === 'bulk') {
    const { runBulk } = await import('./bulk.js');
    const result = await runBulk({
      priceChangeProductFilter: priceChangeFilter,
      profile,
      startMs,
      endMs,
      pattern: pattern as any,
      shards,
      seed,
      tmpDir: process.env.GEN_TMP_DIR ?? '/tmp/eshop-gen',
      keepTsv: args.keepTsv ?? false,
      recreate: args.recreate !== false,
      priceChangePerProduct: priceChanges,
      withStockChange: args.withStockChange !== false,
      logIntervalMs: 5000,
    });
    console.log(
      `\n数据集已就绪：${result.database}（${Clock.formatMs(startMs)} ~ ${Clock.formatMs(endMs)}）`,
    );
    process.exit(0);
  }

  if (args.mode === 'replay') {
    const ordersPerDay =
      args.ordersPerDay ?? DEFAULT_ORDERS_PER_DAY[profile.key] ?? 35_000;
    const startVirtual = args.startAt ? Date.parse(args.startAt) : endMs;
    if (!Number.isFinite(startVirtual)) {
      console.error(`错误：--start-at 无法解析：${args.startAt}`);
      process.exit(1);
    }
    process.env.SIM_EPOCH = new Date(startVirtual).toISOString();
    process.env.SIM_TIME_SCALE = String(args.timeScale ?? 1);
    initClock(process.env.SIM_EPOCH, args.timeScale ?? 1);

    const { runReplay } = await import('./replay.js');
    await runReplay({
      profile,
      startMs: startVirtual,
      ordersPerDay,
      timeScale: args.timeScale ?? 1,
      withChurn: args.withChurn !== false,
      batchRows: args.batchRows ?? 1000,
      logEverySec: args.logEverySec ?? 10,
      maxRuntimeSec: args.maxRuntimeSec ?? 0,
      seed,
      burstEverySec: args.burstEverySec ?? 0,
      burstMultiplier: args.burstMultiplier ?? 10,
      burstDurationSec: args.burstDurationSec ?? 30,
      orderIdFilter,
      churnOrderFilter,
      churnProductFilter,
    });
    process.exit(0);
  }

  if (args.mode === 'changelog') {
    // ★ 强制实时：binlog 记录的是提交时刻（真实时间），
    //   若虚拟时间跑在真实时间前面，两者的时间语义就不一致了
    if ((args.timeScale ?? 1) !== 1) {
      console.warn(
        `[warn] changelog 模式强制 SIM_TIME_SCALE=1（收到 ${args.timeScale}）。` +
          `原因：binlog 时间戳是提交时刻，时间加速会让虚拟时间与之一致性破裂。`,
      );
    }
    process.env.SIM_TIME_SCALE = '1';
    const startVirtual = args.startAt ? Date.parse(args.startAt) : endMs;
    process.env.SIM_EPOCH = new Date(startVirtual).toISOString();
    initClock(process.env.SIM_EPOCH, 1);

    if (args.replayMode === 'batch') {
      console.log(
        '[info] batch 模式：不模拟业务节奏，会尽快把全部历史变更重放完。\n' +
          '       目的是让 binlog 里出现"时间戳正确"的 -U/+U 序列，\n' +
          '       因此 CDC 用 earliest 或 initial 启动都能得到正确的 SCD2 数据源。\n',
      );
    }

    const { runChangelog } = await import('./changelog.js');
    await runChangelog({
      profile,
      replayMode: args.replayMode ?? 'stream',
      batchChunk: args.batchChunk ?? 500,
      dropFinalRecords: args.dropFinal !== false,
      startMs: startVirtual,
      priceChangesPerProduct: args.priceChanges ?? 3,
      categoryChangeProb: args.categoryProb ?? 0.05,
      brandChangeProb: args.brandProb ?? 0.05,
      offShelfProb: args.offShelfProb ?? 0.03,
      maxTotalChanges: args.maxChanges ?? 300_000,
      maxRuntimeSec: args.maxRuntimeSec ?? 0,
      ratePerSecond: args.updateRate ?? 200,
      logEverySec: args.logEverySec ?? 5,
      seed,
      productFilter: churnProductFilter,
    });
    process.exit(0);
  }

  console.error(`暂未实现的模式：${args.mode}`);
  process.exit(1);
}

main().catch((e) => {
  console.error('\n生成失败：', e);
  process.exit(1);
});
