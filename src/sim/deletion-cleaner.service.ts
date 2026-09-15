import { Injectable, Logger } from '@nestjs/common';
import { config } from '../config';
import { DatabaseService } from '../db/database.service';
import { StatsService } from './stats.service';
import { LoopedTask } from './task.base';

/**
 * 删除清理器
 *
 * v2 的重要设计变更：**默认改为逻辑删除**
 *
 * v1 的行为（物理 DELETE）会破坏历史指标口径 —— 数仓学习笔记 03 §6.8 的例子：
 *   10:00  取消率 = 20 / 100  = 20%
 *   12:00  清理器删掉 15 个 CANCELLED 订单
 *   12:00  取消率 =  5 /  85  = 5.9%   ❌ 分子分母同时变小，指标彻底失真
 *   → 「下单GMV」「取消率」等所有历史指标都会随清理器运行而漂移
 *
 * v2 策略：
 *   CLEANER_SOFT_DELETE=true（默认）→ 只打 is_deleted=1 + deleted_time 标记
 *   CLEANER_SOFT_DELETE=false       → 物理 DELETE（**实验 1 需要真实 -D 事件时用**）
 *
 * 两种模式都改了：
 *   - 用 idx_status_update(order_status, update_time) 索引，v1 完全无可用索引
 *   - 占位符参数化（v1 用模板字符串拼 INTERVAL，虽无注入风险但不规范）
 *   - 虚拟时钟（v1 用 NOW(3)，在时间旅行模式下会误删全部数据 —— 致命 bug）
 */
@Injectable()
export class DeletionCleanerService extends LoopedTask {
  protected readonly logger = new Logger(DeletionCleanerService.name);

  constructor(
    private readonly db: DatabaseService,
    private readonly stats: StatsService,
  ) {
    super();
  }

  private get clock() {
    return this.db.clock;
  }

  protected async tick(): Promise<void> {
    await this.cleanCancelledOrders();
    await this.cleanDeactivatedUsers();
    await this.cleanOffShelfProducts();
  }

  // ------------------------------------------------------------------ 订单
  private async cleanCancelledOrders(): Promise<void> {
    const minutes = config.tasks.cleaner.cancelledOrderMinutes;
    const limit = config.tasks.cleaner.maxBatch;
    const nowSql = this.clock.toSql();

    const rows = await this.db.query<{ order_id: string }>(
      `SELECT order_id FROM fact_order
       WHERE order_status = 'CANCELLED'
         AND is_deleted = 0
         AND update_time < DATE_SUB(?, INTERVAL ? MINUTE)
       ORDER BY update_time
       LIMIT ?`,
      [nowSql, minutes, limit],
    );
    if (rows.length === 0) return;

    const orderIds = rows.map((r) => Number(r.order_id));

    if (config.tasks.cleaner.softDelete) {
      // 逻辑删除：历史指标口径稳定
      const res = await this.db.run(
        `UPDATE fact_order SET is_deleted = 1, deleted_time = ?
         WHERE order_id IN (?)`,
        [nowSql, orderIds],
      );
      if (res.affectedRows > 0) {
        this.stats.counters.ordersDeleted += res.affectedRows;
        this.logger.log(
          `soft-deleted ${res.affectedRows} stale CANCELLED orders ` +
            `(is_deleted=1, 历史指标口径不受影响)`,
        );
      }
      return;
    }

    // 物理删除：产生真实 CDC -D 事件（实验 1 用）
    await this.db.transaction(async (conn) => {
      const [itemRes] = await conn.query(
        'DELETE FROM fact_order_item WHERE order_id IN (?)',
        [orderIds],
      );
      const [orderRes] = await conn.query(
        'DELETE FROM fact_order WHERE order_id IN (?)',
        [orderIds],
      );
      this.stats.counters.itemsDeleted +=
        (itemRes as { affectedRows: number }).affectedRows ?? 0;
      this.stats.counters.ordersDeleted +=
        (orderRes as { affectedRows: number }).affectedRows ?? 0;
    });

    this.logger.warn(
      `hard-deleted ${orderIds.length} CANCELLED orders ` +
        `(items ${this.stats.counters.itemsDeleted}, orders ${this.stats.counters.ordersDeleted}) ` +
        `-> CDC should emit -D events`,
    );
  }

  // ------------------------------------------------------------------ 用户
  private async cleanDeactivatedUsers(): Promise<void> {
    const minutes = config.tasks.cleaner.userMinutes;
    const limit = config.tasks.cleaner.maxBatch;
    const nowSql = this.clock.toSql();

    const rows = await this.db.query<{ user_id: string }>(
      `SELECT user_id FROM dim_user
       WHERE status = 0
         AND is_deleted = 0
         AND update_time < DATE_SUB(?, INTERVAL ? MINUTE)
       ORDER BY update_time
       LIMIT ?`,
      [nowSql, minutes, limit],
    );
    if (rows.length === 0) return;

    const ids = rows.map((r) => Number(r.user_id));

    if (config.tasks.cleaner.softDelete) {
      const res = await this.db.run(
        `UPDATE dim_user SET is_deleted = 1, deleted_time = ? WHERE user_id IN (?)`,
        [nowSql, ids],
      );
      if (res.affectedRows > 0) {
        this.stats.counters.usersDeleted += res.affectedRows;
        this.logger.log(`soft-deleted ${res.affectedRows} deactivated users`);
      }
      return;
    }

    const res = await this.db.run('DELETE FROM dim_user WHERE user_id IN (?)', [
      ids,
    ]);
    if (res.affectedRows > 0) {
      this.stats.counters.usersDeleted += res.affectedRows;
      this.logger.warn(
        `hard-deleted ${res.affectedRows} deactivated users -> CDC -D`,
      );
    }
  }

  // ------------------------------------------------------------------ 商品
  private async cleanOffShelfProducts(): Promise<void> {
    const minutes = config.tasks.cleaner.productMinutes;
    const limit = config.tasks.cleaner.maxBatch;
    const nowSql = this.clock.toSql();

    const rows = await this.db.query<{ product_id: string }>(
      `SELECT product_id FROM dim_product
       WHERE status = 0
         AND is_deleted = 0
         AND update_time < DATE_SUB(?, INTERVAL ? MINUTE)
       ORDER BY update_time
       LIMIT ?`,
      [nowSql, minutes, limit],
    );
    if (rows.length === 0) return;

    const ids = rows.map((r) => Number(r.product_id));

    if (config.tasks.cleaner.softDelete) {
      const res = await this.db.run(
        `UPDATE dim_product SET is_deleted = 1, deleted_time = ? WHERE product_id IN (?)`,
        [nowSql, ids],
      );
      if (res.affectedRows > 0) {
        this.stats.counters.productsDeleted += res.affectedRows;
        this.logger.log(`soft-deleted ${res.affectedRows} off-shelf products`);
      }
      return;
    }

    const res = await this.db.run(
      'DELETE FROM dim_product WHERE product_id IN (?)',
      [ids],
    );
    if (res.affectedRows > 0) {
      this.stats.counters.productsDeleted += res.affectedRows;
      this.logger.warn(
        `hard-deleted ${res.affectedRows} off-shelf products -> CDC -D`,
      );
    }
  }
}
