import { Injectable, Logger } from '@nestjs/common';
import { config } from '../config';
import { DatabaseService } from '../db/database.service';
import { StatsService } from './stats.service';
import { LoopedTask } from './task.base';
import { chance, randInt } from './util';

/**
 * 取消器（update 来源之一，并喂给删除清理器）
 *
 * v2 修复：
 *  1. 虚拟时钟（cancel_time 显式写入，不再依赖 ON UPDATE CURRENT_TIMESTAMP）
 *  2. 主键范围采样替代 `ORDER BY RAND()`（同 status-flow，见其注释）
 *  3. 写入 v2 新增的 cancel_time 字段
 */
@Injectable()
export class CancelerService extends LoopedTask {
  protected readonly logger = new Logger(CancelerService.name);
  private maxOrderId = 0;
  private lastBoundsRefresh = 0;

  constructor(
    private readonly db: DatabaseService,
    private readonly stats: StatsService,
  ) {
    super();
  }

  private get clock() {
    return this.db.clock;
  }

  /** 主键范围采样（容忍删除空洞） */
  private async sampleCancellable(
    needed: number,
  ): Promise<{ order_id: string }[]> {
    if (this.maxOrderId === 0 || Date.now() - this.lastBoundsRefresh > 300_000) {
      const rows = await this.db.query<{ m: string }>(
        'SELECT IFNULL(MAX(order_id),0) AS m FROM fact_order',
      );
      this.maxOrderId = Number(rows[0]?.m ?? 0);
      this.lastBoundsRefresh = Date.now();
    }
    if (this.maxOrderId === 0) return [];

    const probeSize = 5;
    const probes = Math.max(1, Math.ceil(needed / probeSize));
    const out: { order_id: string }[] = [];

    for (let i = 0; i < probes && out.length < needed; i++) {
      const anchor = randInt(1, this.maxOrderId);
      const rows = await this.db.query<{ order_id: string }>(
        `SELECT order_id FROM fact_order
         WHERE order_id >= ?
           AND order_status IN ('CREATED','PAID')
           AND is_deleted = 0
         ORDER BY order_id
         LIMIT ${probeSize}`,
        [anchor],
      );
      out.push(...rows);
    }
    return out.slice(0, needed);
  }

  protected async tick(): Promise<void> {
    const batch = config.tasks.canceler.batch;
    const prob = config.tasks.canceler.cancelProb;
    const rows = await this.sampleCancellable(batch);
    if (rows.length === 0) return;

    const nowSql = this.clock.toSql();
    let cancelled = 0;

    for (const r of rows) {
      if (!chance(prob)) continue;
      const res = await this.db.execute(
        `UPDATE fact_order
         SET order_status = 'CANCELLED', cancel_time = ?, update_time = ?
         WHERE order_id = ? AND order_status IN ('CREATED','PAID')`,
        [nowSql, nowSql, Number(r.order_id)],
      );
      if (res.affectedRows === 1) cancelled++;
    }

    if (cancelled > 0) {
      this.stats.counters.ordersCancelled += cancelled;
      this.logger.log(
        `cancelled ${cancelled} orders, total=${this.stats.counters.ordersCancelled}`,
      );
    }
  }
}
