/**
 * 实验 2 专用：CDC 端到端延迟 / 吞吐 基准写入器
 * ============================================================================
 *
 * 对比对象（同一条 MySQL 写入流，两条 CDC 链路，同一个 Paimon sink 表）：
 *   A) MySQL → Flink CDC ──────────────────→ Paimon ODS
 *   B) MySQL → Debezium → Kafka → Flink ───→ Paimon ODS
 *
 * ---------------------------------------------------------------------------
 * ★ 与其它生成器最根本的区别：本模块使用「真实墙钟」，不是虚拟时钟 ★
 *
 *   项目其余部分（bulk / replay / changelog / sim）都强制走虚拟时钟
 *   （见 src/clock/clock.service.ts 与 src/gen/cli.ts 里给 SIM_EPOCH 兜底默认值那段），
 *   目的是让回填的历史数据有正确的时间语义。
 *
 *   但本实验测的是「binlog 事件时间 → Flink 写入时间」的端到端延迟，
 *   锚点必须是真实墙钟：
 *     - 若 create_time 是虚拟时间，它就和 source_time（binlog 墙钟）、
 *       sink_time（Flink 墙钟）不在同一个时间轴上，延迟算出来是废数。
 *   所以本模块**强制**：
 *     1) 清掉 SIM_EPOCH（cli.ts 在本模式下不会给它兜底默认值）
 *     2) initClock(null, 1) → 非虚拟时钟
 *     3) 若 clock.isVirtual 仍为 true，直接抛错拒绝运行
 *
 * ---------------------------------------------------------------------------
 * 用法：
 *   # 1) 清空 cdc_test（必须在两种 CDC 都还没启动时执行）
 *   npm run cdc:reset:1m
 *
 *   # 2) 启动 Flink CDC 作业（或 Debezium connector），等它进入 RUNNING
 *
 *   # 3) 以 500 行/秒写入 5 分钟
 *   npm run cdc:load:1m -- --rate 500 --minutes 5
 *
 *   # 4) 记录打印出来的 id 区间（用于后续把两次 run 分开统计），
 *   #    然后换成另一种 CDC 模式重复 2)~3)（**不要再清表**，否则 id 会撞车）
 *
 * ---------------------------------------------------------------------------
 * 为什么写入速率要由这里精确控制：
 *   吞吐指标的分母是「实际写入窗口」，分子是「落进 Paimon 的行数」。
 *   如果本写入器自己就跑不到目标速率，实验结论会变成"测出了 MySQL 客户端的上限"。
 *   所以每轮结束都会打印**实际达成速率**，必须和 --rate 对得上才有意义。
 * ============================================================================
 */

import mysql from 'mysql2/promise';
import { readFileSync } from 'fs';
import { join as pjoin } from 'path';
import { config } from '../config';
import { Clock } from '../clock/clock.service';

/** 实验专用表名（schema.sql 第 7 节） */
const TABLE = 'cdc_test';

export interface CdcLoadOptions {
  /** 目标数据库（跟随规模档案，如 eshop_1m） */
  database: string;
  /** 目标写入速率（行/秒） */
  ratePerSecond: number;
  /** 持续时长（秒） */
  durationSec: number;
  /** 每批行数；默认按 rate/10 估算，即约每 100ms 一批 */
  batchSize?: number;
  /** 进度打印间隔（秒） */
  logEverySec?: number;
  /** 真实时钟（由 cli.ts 传入并已校验非虚拟） */
  clock: Clock;
}

export interface CdcLoadResult {
  database: string;
  rowsInserted: number;
  firstId: number;
  lastId: number;
  targetRate: number;
  actualRate: number;
  wallSec: number;
  batchSize: number;
  startedAt: string;
  endedAt: string;
  /** 调度落后于目标计划的最大毫秒数（>0 说明本机写入跟不上目标速率） */
  maxBehindMs: number;
}

function connBase(
  overrides: mysql.ConnectionOptions = {},
): mysql.ConnectionOptions {
  return {
    host: config.db.host,
    port: config.db.port,
    user: config.db.user,
    password: config.db.password,
    timezone: config.db.timezone,
    multipleStatements: true,
    ...overrides,
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, Math.max(0, ms)));
}

function fmtDur(sec: number): string {
  const s = Math.floor(sec);
  return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
}

/**
 * 幂等建库建表：复用 sql/schema.sql（与 DatabaseService / bulk.ts 同一份 DDL），
 * 保证 cdc_test 一定存在，且与 schema.sql 里的定义一致。
 */
async function ensureSchema(database: string): Promise<void> {
  const root = await mysql.createConnection(connBase());
  try {
    await root.query(
      `CREATE DATABASE IF NOT EXISTS \`${database}\` ` +
        `DEFAULT CHARACTER SET utf8mb4 DEFAULT COLLATE utf8mb4_unicode_ci`,
    );
  } finally {
    await root.end();
  }

  const sql = readFileSync(pjoin(process.cwd(), 'sql', 'schema.sql'), 'utf8').replace(
    /__DB__/g,
    database,
  );
  const statements = sql
    .split('\n')
    .filter((l) => !l.trim().startsWith('--'))
    .join('\n')
    .split(';')
    .map((s) => s.trim())
    .filter((s) => s.length > 0)
    .filter((s) => !/^CREATE\s+DATABASE/i.test(s));

  const conn = await mysql.createConnection(connBase({ database }));
  try {
    for (const stmt of statements) {
      await conn.query(stmt);
    }
  } finally {
    await conn.end();
  }
}

async function tableStat(database: string): Promise<{ count: number; maxId: number }> {
  const conn = await mysql.createConnection(connBase({ database }));
  try {
    const [rows] = await conn.query(
      `SELECT COUNT(*) AS c, IFNULL(MAX(id), 0) AS m FROM ${TABLE}`,
    );
    const r = (rows as Array<{ c: number | string; m: number | string }>)[0];
    return { count: Number(r?.c ?? 0), maxId: Number(r?.m ?? 0) };
  } finally {
    await conn.end();
  }
}

/**
 * 清空 cdc_test 并重置 AUTO_INCREMENT。
 *
 * ⚠️ 必须在两种 CDC 都**未启动**时执行。理由：
 *   1) TRUNCATE 是 DDL，会进 binlog；CDC 作业在线时可能触发 schema 变更处理
 *   2) 重置 id 会让新一轮的 id 与上一轮在 Paimon 主键表里**撞车**（互相覆盖），
 *      所以整个实验只在最开始清一次，两次 run 靠 id 区间区分
 */
export async function runCdcReset(opts: { database: string }): Promise<void> {
  await ensureSchema(opts.database);
  const before = await tableStat(opts.database);

  const conn = await mysql.createConnection(connBase({ database: opts.database }));
  try {
    await conn.query(`TRUNCATE TABLE ${TABLE}`);
  } finally {
    await conn.end();
  }

  const after = await tableStat(opts.database);
  console.log(
    `\n已清空 ${opts.database}.${TABLE}：${before.count} 行 → ${after.count} 行，` +
      `AUTO_INCREMENT 已重置。\n` +
      `接着可以启动 CDC 作业，然后执行 npm run cdc:load:1m -- --rate 500 --minutes 5\n`,
  );
}

/**
 * 以目标速率持续写入 cdc_test。
 *
 * 调度方式：固定批大小 + 绝对时间槽（nextSlot += intervalMs），而不是
 * 「插完 sleep(interval)」—— 后者会把每次插入的耗时累加成漂移，
 * 实际速率会明显低于目标值。
 *
 * 只写 create_time_ms（epoch 毫秒，真实墙钟）与 create_time（同值的可读 DATETIME）；
 * source_time / sink_time 保持 NULL，由两条 CDC 链路各自填入。
 * 这正是本实验能直接对比的原因。
 */
export async function runCdcLoad(opts: CdcLoadOptions): Promise<CdcLoadResult> {
  const { database, ratePerSecond, durationSec, clock } = opts;

  if (clock.isVirtual) {
    throw new Error(
      'cdc:load 必须使用真实墙钟，但当前时钟是虚拟时钟（SIM_EPOCH 生效中）。\n' +
        '       请确认执行前没有 export SIM_EPOCH，或改用干净 shell 重跑。',
    );
  }
  if (!(ratePerSecond > 0)) {
    throw new Error(`--rate 必须大于 0（收到 ${ratePerSecond}）`);
  }
  if (!(durationSec > 0)) {
    throw new Error(`--minutes 必须大于 0（收到 ${(durationSec / 60).toFixed(2)}）`);
  }

  // 约 10 批/秒 → 每批间隔 ~100ms。批太小会让 MySQL 变慢，批太大会让
  // create_time 在批内过度聚集（同一批共享一个时间戳）。
  const batchSize = Math.min(
    10_000,
    opts.batchSize ?? Math.max(1, Math.round(ratePerSecond / 10)),
  );
  const intervalMs = (batchSize / ratePerSecond) * 1000;
  const logEverySec = opts.logEverySec ?? 5;

  await ensureSchema(database);
  const pre = await tableStat(database);
  const firstId = pre.maxId + 1;

  const conn = await mysql.createConnection(connBase({ database }));
  try {
    console.log(
      `\nCDC 基准写入开始\n` +
        `  库表        : ${database}.${TABLE}\n` +
        `  目标速率    : ${ratePerSecond} 行/秒（批大小 ${batchSize}，间隔 ${intervalMs.toFixed(1)}ms）\n` +
        `  时长        : ${(durationSec / 60).toFixed(2)} 分钟（${durationSec}s）\n` +
        `  预计行数    : ${Math.round(ratePerSecond * durationSec)}\n` +
        `  起始 id     : ${firstId}（表内已有 ${pre.count} 行）\n` +
        `  开始时刻    : ${Clock.formatMs(clock.nowMs())}\n`,
    );

    // 复用同一个二维数组，每轮只刷新时间戳，避免每批重新分配
    const values: unknown[][] = Array.from({ length: batchSize }, () => [null, null]);

    const t0 = clock.nowMs();
    const deadline = t0 + durationSec * 1000;
    let inserted = 0;
    let lastId = firstId - 1;
    let nextSlot = t0;
    let lastLog = t0;
    let maxBehindMs = 0;

    for (;;) {
      const now = clock.nowMs();
      if (now >= deadline) break;
      if (nextSlot > now) {
        await sleep(nextSlot - now);
        if (clock.nowMs() >= deadline) break;
      }

      // 同一批共享一个时间戳：与真实"一个事务一次提交"的语义一致。
      // create_time_ms（epoch 毫秒）是延迟锚点 —— 它在两条 CDC 链路上都无歧义；
      // create_time（DATETIME）只是给肉眼看的可读形式。
      const nowMs = clock.nowMs();
      const nowSql = clock.toSql(new Date(nowMs));
      for (const row of values) {
        row[0] = nowMs;
        row[1] = nowSql;
      }

      const [res] = (await conn.query(
        `INSERT INTO ${TABLE} (create_time_ms, create_time) VALUES ?`,
        [values],
      )) as unknown as [mysql.ResultSetHeader];
      const affected = res.affectedRows || batchSize;
      inserted += affected;
      lastId = (res.insertId || 0) + affected - 1;

      const after = clock.nowMs();
      const behind = after - nextSlot;
      if (behind > maxBehindMs) maxBehindMs = behind;

      // 落后超过 10 个时间槽 → 重置基准，避免"追赶风暴"把速率拉爆
      nextSlot += intervalMs;
      if (after - nextSlot > 10 * intervalMs) nextSlot = after;

      if (after - lastLog >= logEverySec * 1000) {
        lastLog = after;
        const el = (after - t0) / 1000;
        console.log(
          `  [${fmtDur(el)}/${fmtDur(durationSec)}] 已写 ${inserted} 行 | ` +
            `实际 ${(inserted / el).toFixed(1)} 行/秒 | id ${firstId}~${lastId}`,
        );
      }
    }

    const t1 = clock.nowMs();
    const wallSec = (t1 - t0) / 1000;
    const actualRate = inserted / Math.max(0.001, wallSec);

    const result: CdcLoadResult = {
      database,
      rowsInserted: inserted,
      firstId,
      lastId,
      targetRate: ratePerSecond,
      actualRate,
      wallSec,
      batchSize,
      startedAt: Clock.formatMs(t0),
      endedAt: Clock.formatMs(t1),
      maxBehindMs,
    };

    const deviation = Math.abs(actualRate - ratePerSecond) / ratePerSecond;
    console.log(
      `\nCDC 基准写入结束\n` +
        `  实际写入    : ${inserted} 行 / ${wallSec.toFixed(1)}s\n` +
        `  实际速率    : ${actualRate.toFixed(1)} 行/秒（目标 ${ratePerSecond}，偏差 ${(deviation * 100).toFixed(2)}%）\n` +
        `  调度最大落后: ${maxBehindMs.toFixed(0)}ms\n` +
        `  写入窗口    : ${result.startedAt} ~ ${result.endedAt}\n` +
        `  ★ id 区间   : ${firstId} ~ ${lastId}   ← 记下来，分析 SQL 用它区分本次 run\n`,
    );
    if (deviation > 0.05) {
      console.warn(
        `  [warn] 实际速率与目标偏差 ${(deviation * 100).toFixed(1)}% > 5%。\n` +
          `         说明本机/MySQL 写不到这个速率，此时吞吐指标测的是客户端上限，\n` +
          `         不是 CDC 链路能力。请调低 --rate 后重跑。\n`,
      );
    }

    return result;
  } finally {
    await conn.end();
  }
}
