import { Injectable, Logger } from '@nestjs/common';
import { config } from '../config';
import { DatabaseService } from '../db/database.service';
import { StatsService } from './stats.service';
import { LoopedTask } from './task.base';
import { chance, randInt } from './util';

/**
 * 订单状态流转器（update 主战场）
 *
 * v2 的两处关键修复：
 *
 * 1. **虚拟时钟**：`pay_time = NOW(3)` → `clock.toSql()`
 *    v1 用服务器时钟，导致历史数据（2025-10）的 pay_time 落成机器真实时间（2026），
 *    支付时长类指标全部失真。
 *
 * 2. **主键范围采样替代 ORDER BY RAND()**
 *    v1:  `SELECT ... WHERE order_status IN (...) ORDER BY RAND() LIMIT ?`
 *         → 在千万行规模上是「全表扫描 + 临时表排序」，每 tick 执行一次会拖垮 MySQL。
 *         计划 4.3 节把这个列为必须修的瓶颈 1。
 *    v2:  在 [minId, maxId] 内随机取若干探测点，每次取一小段连续行
 *         （`WHERE order_id >= ? AND order_status IN (...) LIMIT k`），
 *         走 PRIMARY 索引范围扫描。用 LIMIT 而非 = 是为了容忍删除造成的空洞。
 *
 * 同时按状态机语义写入完整里程碑时间戳（v2 新增字段）：
 *   CREATED → PAID      写 pay_time
 *   PAID    → SHIPPED   写 shipping_time
 *   SHIPPED → COMPLETED 写 complete_time
 */
@Injectable()
export class StatusFlowService extends LoopedTask {
  protected readonly logger = new Logger(StatusFlowService.name);
  private totalChanged = 0;
  /** 缓存的 ID 上界（定期刷新，避免每 tick 都查 MAX） */
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

  /** 用主键范围采样代替 ORDER BY RAND() */
  private async sampleOrders(
    statuses: string,
    needed: number,
  ): Promise<{ order_id: string; order_status: string }[]> {
    if (this.maxOrderId === 0 || Date.now() - this.lastBoundsRefresh > 300_000) {
      const rows = await this.db.query<{ m: string }>(
        'SELECT IFNULL(MAX(order_id),0) AS m FROM fact_order',
      );
      this.maxOrderId = Number(rows[0]?.m ?? 0);
      this.lastBoundsRefresh = Date.now();
    }
    if (this.maxOrderId === 0) return [];

    const probeSize = 10;
    const probes = Math.max(1, Math.ceil(needed / probeSize));
    const out: { order_id: string; order_status: string }[] = [];

    for (let i = 0; i < probes && out.length < needed; i++) {
      const anchor = randInt(1, this.maxOrderId);
      const rows = await this.db.query<{
        order_id: string;
        order_status: string;
      }>(
        `SELECT order_id, order_status FROM fact_order
         WHERE order_id >= ?
           AND order_status IN (${statuses})
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
    const batch = config.tasks.statusFlow.batch;
    const rows = await this.sampleOrders(`'CREATED','PAID','SHIPPED'`, batch);
    if (rows.length === 0) return;

    const nowSql = this.clock.toSql();
    let changed = 0;

    for (const r of rows) {
      const orderId = Number(r.order_id);
      const status = r.order_status;

      if (status === 'CREATED' && chance(0.2)) {
        const res = await this.db.execute(
          `UPDATE fact_order
           SET order_status = 'PAID', pay_time = ?, update_time = ?
           WHERE order_id = ? AND order_status = 'CREATED'`,
          [nowSql, nowSql, orderId],
        );
        if (res.affectedRows === 1) changed++;
      } else if (status === 'PAID' && chance(0.15)) {
        const res = await this.db.execute(
          `UPDATE fact_order
           SET order_status = 'SHIPPED', shipping_time = ?, update_time = ?
           WHERE order_id = ? AND order_status = 'PAID'`,
          [nowSql, nowSql, orderId],
        );
        if (res.affectedRows === 1) changed++;
      } else if (status === 'SHIPPED' && chance(0.1)) {
        const res = await this.db.execute(
          `UPDATE fact_order
           SET order_status = 'COMPLETED', complete_time = ?, update_time = ?
           WHERE order_id = ? AND order_status = 'SHIPPED'`,
          [nowSql, nowSql, orderId],
        );
        if (res.affectedRows === 1) changed++;
      }
    }

    if (changed > 0) {
      this.stats.counters.ordersStatusChanged += changed;
      this.totalChanged += changed;
      if (this.totalChanged % 10 < changed) {
        this.logger.log(
          `status flow: +${changed} this tick, total=${this.stats.counters.ordersStatusChanged}`,
        );
      }
    }
  }
}
