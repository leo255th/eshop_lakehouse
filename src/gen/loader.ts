/**
 * LOAD DATA LOCAL INFILE 批量导入器
 *
 * 相比多值 INSERT 的优势：快 3~5 倍。
 * 依赖 MySQL 端 local_infile=ON（已在 my.cnf 中配置，见 实验环境准备.md 2.2 节）。
 *
 * 注意点：
 *  1. LOAD DATA 是**单线程**的，所以并行度靠多分片 + 多连接
 *  2. 导入期间临时关闭唯一性检查/外键检查可以提速（本数据源无外键，
 *     唯一键只有主键且由 AUTO_INCREMENT 生成，关闭检查是安全的）
 *  3. 每张表开始前 TRUNCATE，保证可重复执行（幂等）
 */

import mysql from 'mysql2/promise';
import type { Connection } from 'mysql2/promise';
import { createReadStream } from 'fs';
import { config } from '../config';

export interface LoadOptions {
  host?: string;
  port?: number;
  user?: string;
  password?: string;
  database: string;
  /** 表名 */
  table: string;
  /** 列清单（与 TSV 字段顺序严格一致，不含自增主键） */
  columns: string[];
  /** 要导入的 TSV 文件路径列表 */
  files: string[];
  /** 单文件导入完成回调 */
  onProgress?: (file: string, rows: number, elapsedMs: number) => void;
}

/** 导入统计 */
export interface LoadResult {
  table: string;
  files: number;
  rows: number;
  elapsedMs: number;
  rowsPerSec: number;
  warnings: number;
}

function connOptions(overrides: { database: string }): mysql.ConnectionOptions {
  return {
    host: config.db.host,
    port: config.db.port,
    user: config.db.user,
    password: config.db.password,
    database: overrides.database,
    timezone: config.db.timezone,
    /**
     * ⚠️ mysql2 v3 的 LOCAL INFILE 机制：
     * 服务端收到 LOCAL INFILE 语句后回一个 LOCAL_INFILE 请求包，
     * 客户端必须通过 `infileStreamFactory(path)` 返回 ReadStream。
     *
     * 注意选项名是 **`infileStreamFactory`**：
     *   - 官方报错信息里写的是 "streamFactory"，但那是误导 —— 传 streamFactory
     *     会被判为 invalid configuration option 且不生效
     *   - `localInfile: true` 是更老的选项，在 v3 同样无效
     * 依据：node_modules/mysql2/lib/commands/query.js:40
     *   this._streamFactory = options.infileStreamFactory;
     */
    infileStreamFactory: (filePath: string) => createReadStream(filePath),
    multipleStatements: true,
    connectTimeout: 30_000,
    charset: 'utf8mb4',
  } as mysql.ConnectionOptions;
}

/**
 * 建立一条专用导入连接（LOAD DATA 期间不做别的）。
 */
export async function openLoadConnection(database: string): Promise<Connection> {
  const conn = await mysql.createConnection(connOptions({ database }));
  // 大批量导入期放宽会话约束（只影响当前会话）
  await conn.query('SET SESSION unique_checks = 0');
  await conn.query('SET SESSION foreign_key_checks = 0');
  await conn.query('SET SESSION sql_mode = ""');
  // 会话时区对齐（避免 TIMESTAMP 类字段产生偏移；本 schema 用 DATETIME 不受影响，
  // 但保持一致性更安全）
  await conn.query('SET SESSION time_zone = ?', [config.db.timezone]);
  return conn;
}

/**
 * 用一条连接导入一批文件。
 *
 * @param conn   已打开的导入连接（来自 openLoadConnection）
 */
export async function loadFiles(
  conn: Connection,
  opts: LoadOptions,
): Promise<LoadResult> {
  const started = Date.now();
  let totalRows = 0;
  let totalWarnings = 0;

  const colList = opts.columns.map((c) => `\`${c}\``).join(', ');
  const sql =
    `LOAD DATA LOCAL INFILE ? INTO TABLE \`${opts.table}\` ` +
    `CHARACTER SET utf8mb4 ` +
    `FIELDS TERMINATED BY '\\t' ESCAPED BY '\\\\' ` +
    `LINES TERMINATED BY '\\n' ` +
    `(${colList})`;

  for (const file of opts.files) {
    const t0 = Date.now();
    // mysql2 对 LOCAL INFILE 会把文件流式推给服务端，不会整文件读进内存
    const [result] = await conn.query(sql, [file]);
    const info = result as mysql.ResultSetHeader;
    const rows = info.affectedRows ?? 0;
    totalRows += rows;
    totalWarnings += info.warningStatus ?? 0;
    opts.onProgress?.(file, rows, Date.now() - t0);
  }

  const elapsedMs = Date.now() - started;
  return {
    table: opts.table,
    files: opts.files.length,
    rows: totalRows,
    elapsedMs,
    rowsPerSec: elapsedMs > 0 ? Math.round((totalRows / elapsedMs) * 1000) : 0,
    warnings: totalWarnings,
  };
}

/** 关闭导入连接，恢复会话检查 */
export async function closeLoadConnection(conn: Connection): Promise<void> {
  try {
    await conn.query('SET SESSION unique_checks = 1');
    await conn.query('SET SESSION foreign_key_checks = 1');
  } catch {
    /* 忽略：连接可能已断开 */
  }
  await conn.end().catch(() => undefined);
}

// =====================================================================
// 表列定义（与 schema.sql 严格对应，且与 TSV 字段顺序一致）
// =====================================================================

export const TABLE_COLUMNS = {
  dim_user: [
    'user_id',
    'username',
    'phone',
    'email',
    'province',
    'city',
    'user_level',
    'status',
    'register_channel',
    'first_order_time',
    'is_deleted',
    'deleted_time',
    'create_time',
    'update_time',
  ],
  dim_product: [
    'product_id',
    'product_name',
    'category',
    'brand',
    'price',
    'cost_price',
    'stock',
    'status',
    'is_deleted',
    'deleted_time',
    'create_time',
    'update_time',
  ],
  fact_order: [
    'order_id',
    'user_id',
    'order_status',
    'item_count',
    'total_amount',
    'discount_amount',
    'pay_time',
    'shipping_time',
    'complete_time',
    'cancel_time',
    'order_time',
    'update_time',
    'is_deleted',
    'deleted_time',
  ],
  fact_order_item: [
    'item_id',
    'order_id',
    'product_id',
    'quantity',
    'unit_price',
    'subtotal',
    'discount_amount',
    'create_time',
  ],
  fact_product_price_change: [
    'product_id',
    'old_price',
    'new_price',
    'change_type',
    'change_time',
  ],
  fact_stock_change: [
    'product_id',
    'order_id',
    'change_type',
    'delta',
    'stock_after',
    'change_time',
  ],
} as const;

export type TableName = keyof typeof TABLE_COLUMNS;
