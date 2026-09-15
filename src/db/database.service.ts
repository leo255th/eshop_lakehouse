import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { existsSync, readFileSync } from 'fs';
import { join } from 'path';
import mysql, { Pool, PoolConnection } from 'mysql2/promise';
import type { Connection as CoreConnection } from 'mysql2';
import { config } from '../config';
import { Clock, getClock } from '../clock/clock.service';

/**
 * 加载 sql/schema.sql（唯一 DDL 来源）。
 *
 * v2 变化：
 *   1. schema.sql 里的库名写成占位符 `__DB__`，运行时替换为 config.db.database
 *      → 让 eshop_100m / eshop_10m / eshop_100m 共用同一份 DDL
 *   2. 兼容 ts-node 运行（src/db → ../../sql）与编译后运行（dist/db → ../../sql）
 *      → 编译后路径是 dist/db → ../../sql，即项目根/sql ✅
 */
function loadSchemaSql(database: string): string {
  const candidates = [
    join(process.cwd(), 'sql', 'schema.sql'),
    join(__dirname, '..', '..', 'sql', 'schema.sql'),
    join(__dirname, '..', '..', '..', 'sql', 'schema.sql'),
  ];
  for (const p of candidates) {
    if (existsSync(p)) {
      return readFileSync(p, 'utf8').replace(/__DB__/g, database);
    }
  }
  throw new Error(`schema.sql not found (tried: ${candidates.join(', ')})`);
}

/** 按 ';' 切分 SQL，去掉 -- 注释行，返回可逐条执行的语句列表 */
function splitStatements(sql: string): string[] {
  return sql
    .split('\n')
    .filter((l) => !l.trim().startsWith('--'))
    .join('\n')
    .split(';')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

@Injectable()
export class DatabaseService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(DatabaseService.name);
  private pool: Pool;

  /** 虚拟时钟单例：所有写入时间必须来自这里 */
  readonly clock: Clock = getClock();

  constructor() {
    this.pool = mysql.createPool({
      host: config.db.host,
      port: config.db.port,
      user: config.db.user,
      password: config.db.password,
      database: config.db.database,
      timezone: config.db.timezone,
      connectionLimit: config.db.connectionLimit,
      dateStrings: true,
      charset: 'utf8mb4',
      waitForConnections: true,
      queueLimit: 0,
    });

    // 时区修复：mysql2 的 timezone 选项只是「客户端 JS Date 的格式化约定」，
    // 不会向服务器下发 SET time_zone。这里对池中每个新连接显式设置，
    // 保证服务器生成的时间与 App 显式写入的时间使用同一套墙钟。
    // （v2 中所有时间已由虚拟时钟显式写入，此项作为兜底保留）
    this.pool.on('connection', (conn) => {
      const core = conn as unknown as CoreConnection;
      core.query('SET time_zone = ?', [config.db.timezone], (err) => {
        if (err) {
          this.logger.warn(
            `set session time_zone=${config.db.timezone} failed: ${err.message}`,
          );
        }
      });
    });
  }

  async onModuleInit(): Promise<void> {
    if (process.env.NODE_ENV === 'test') return;
    await this.ensureDatabase();
    if (config.schema.resetOnStart) {
      await this.reset();
    } else if (config.schema.autoCreate) {
      await this.ensureSchema();
    }
    if (this.clock.isVirtual) {
      this.logger.log(
        `virtual clock active: epoch=${this.clock.epoch.toISOString()} scale=${this.clock.currentScale}x`,
      );
    }
  }

  async onModuleDestroy(): Promise<void> {
    await this.pool
      .end()
      .catch((e: unknown) =>
        this.logger.warn(`pool end: ${(e as Error).message}`),
      );
  }

  /** 确保数据库存在（用不指定 database 的引导连接） */
  async ensureDatabase(): Promise<void> {
    const conn = await mysql.createConnection({
      host: config.db.host,
      port: config.db.port,
      user: config.db.user,
      password: config.db.password,
      timezone: config.db.timezone,
    });
    try {
      await conn.query(
        `CREATE DATABASE IF NOT EXISTS \`${config.db.database}\` DEFAULT CHARACTER SET utf8mb4 DEFAULT COLLATE utf8mb4_unicode_ci`,
      );
      this.logger.log(`database "${config.db.database}" ready`);
    } finally {
      await conn.end();
    }
  }

  /** 建表（幂等）：执行 schema.sql 中除去 CREATE DATABASE 之外的全部语句 */
  async ensureSchema(): Promise<void> {
    const statements = splitStatements(loadSchemaSql(config.db.database)).filter(
      (s) => !/^CREATE\s+DATABASE/i.test(s),
    );
    for (const stmt of statements) {
      await this.pool.query(stmt);
    }
    this.logger.log(`schema ensured (${statements.length} statements)`);
  }

  /** 清库重建（v2 表更多，按依赖顺序 DROP） */
  async reset(): Promise<void> {
    const tables = [
      // 实验2 基准表（无外键依赖，放最前）
      'cdc_test',
      'fact_stock_change',
      'fact_product_price_change',
      'fact_order_item',
      'fact_order',
      'dim_product',
      'dim_user',
    ];
    for (const t of tables) {
      await this.pool.query(`DROP TABLE IF EXISTS \`${t}\``);
    }
    this.logger.warn(`${tables.length} tables dropped`);
    await this.ensureSchema();
    this.logger.log('schema recreated');
  }

  async query<T = any>(sql: string, params?: any[]): Promise<T[]> {
    const [rows] = await this.pool.query(sql, params);
    return rows as T[];
  }

  /** 执行 DML，返回 { affectedRows, insertId } */
  async execute(
    sql: string,
    params?: any[],
  ): Promise<{ affectedRows: number; insertId: number }> {
    const [result] = await this.pool.execute(sql, params);
    return {
      affectedRows: (result as mysql.ResultSetHeader).affectedRows ?? 0,
      insertId: (result as mysql.ResultSetHeader).insertId ?? 0,
    };
  }

  /**
   * 通用 DML（走 pool.query，而非预编译 execute）：
   * mysql2 的 execute 不支持多行 `VALUES ?` 展开，也不支持数组参数在
   * `IN (?)` 中展开 —— 只有 query 支持这两种用法。
   */
  async run(
    sql: string,
    params?: any[],
  ): Promise<{ affectedRows: number; insertId: number }> {
    const [result] = await this.pool.query(sql, params);
    return {
      affectedRows: (result as mysql.ResultSetHeader).affectedRows ?? 0,
      insertId: (result as mysql.ResultSetHeader).insertId ?? 0,
    };
  }

  /** 批量插入：走 pool.query（见 run 的说明） */
  async insert(
    sql: string,
    params?: any[],
  ): Promise<{ affectedRows: number; insertId: number }> {
    return this.run(sql, params);
  }

  /**
   * 事务包装：fn 内所有操作在同一连接上执行并原子提交/回滚。
   */
  async transaction<T>(fn: (conn: PoolConnection) => Promise<T>): Promise<T> {
    const conn = await this.pool.getConnection();
    try {
      await conn.beginTransaction();
      const result = await fn(conn);
      await conn.commit();
      return result;
    } catch (e) {
      await conn.rollback().catch(() => undefined);
      throw e;
    } finally {
      conn.release();
    }
  }
}
