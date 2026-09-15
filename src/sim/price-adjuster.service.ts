import { Injectable, Logger } from '@nestjs/common';
import { config } from '../config';
import { DatabaseService } from '../db/database.service';
import { StatsService } from './stats.service';
import { LoopedTask } from './task.base';
import { chance, randInt } from './util';

/**
 * 调价器（维表 update 来源）
 *
 * v2 修复：
 *  1. 虚拟时钟：显式写 update_time（v1 依赖 ON UPDATE CURRENT_TIMESTAMP，
 *     在虚拟时钟模式下会落成机器真实时间）
 *  2. 主键范围采样替代 ORDER BY RAND()（与 status-flow / canceler 同一方案）
 *  3. **新增价格变更流水写入** —— 这是 v2 最重要的建模补强：
 *     v1 的 dim_product.price 只有当前值，调价历史全部丢失，
 *     导致「事实快照 vs SCD2」实验无法做严格对照。
 *     v2 把每次调价写入 fact_product_price_change（无事实事实表），
 *     使价格历史可追溯，也让 SCD2 拉链表可以用真实数据验证。
 */
@Injectable()
export class PriceAdjusterService extends LoopedTask {
  protected readonly logger = new Logger(PriceAdjusterService.name);
  private maxProductId = 0;
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

  /** 主键范围采样（替代 ORDER BY RAND() 全表扫） */
  private async sampleProducts(
    needed: number,
  ): Promise<
    { product_id: string; price: string; stock: string; status: string }[]
  > {
    if (this.maxProductId === 0 || Date.now() - this.lastBoundsRefresh > 300_000) {
      const rows = await this.db.query<{ m: string }>(
        'SELECT IFNULL(MAX(product_id),0) AS m FROM dim_product',
      );
      this.maxProductId = Number(rows[0]?.m ?? 0);
      this.lastBoundsRefresh = Date.now();
    }
    if (this.maxProductId === 0) return [];

    const out: {
      product_id: string;
      price: string;
      stock: string;
      status: string;
    }[] = [];
    for (let i = 0; i < needed; i++) {
      const anchor = randInt(1, this.maxProductId);
      const rows = await this.db.query<{
        product_id: string;
        price: string;
        stock: string;
        status: string;
      }>(
        `SELECT product_id, price, stock, status FROM dim_product
         WHERE product_id >= ? AND is_deleted = 0
         ORDER BY product_id LIMIT 1`,
        [anchor],
      );
      if (rows[0]) out.push(rows[0]);
    }
    return out;
  }

  protected async tick(): Promise<void> {
    const { minBatch, maxBatch } = config.tasks.priceAdjust;
    const limit = randInt(minBatch, maxBatch);
    const rows = await this.sampleProducts(limit);
    if (rows.length === 0) return;

    const nowSql = this.clock.toSql();
    let adjusted = 0;
    let deactivated = 0;

    for (const r of rows) {
      const pid = Number(r.product_id);
      const status = Number(r.status);

      // 上架商品小概率下架
      if (status === 1 && chance(0.015)) {
        const res = await this.db.execute(
          'UPDATE dim_product SET status = 0, update_time = ? WHERE product_id = ? AND status = 1',
          [nowSql, pid],
        );
        if (res.affectedRows === 1) {
          deactivated++;
          // v2：记录下架事件
          await this.db.run(
            `INSERT INTO fact_product_price_change
               (product_id, old_price, new_price, change_type, change_time)
             VALUES (?, ?, ?, 'OFFSHELF', ?)`,
            [pid, r.price, r.price, nowSql],
          );
          this.logger.log(`product ${pid} deactivated (下架)`);
        }
        continue;
      }

      if (status !== 1) continue;

      // 价格 ±10%（不低于 1.00 元），库存随机增减
      const priceCents = Math.round(Number(r.price) * 100);
      const delta = Math.round(priceCents * (Math.random() * 0.2 - 0.1));
      const newPriceCents = Math.max(100, priceCents + delta);
      const newStock = Math.max(0, Number(r.stock) + randInt(-50, 80));
      const res = await this.db.execute(
        'UPDATE dim_product SET price = ?, stock = ?, update_time = ? WHERE product_id = ?',
        [(newPriceCents / 100).toFixed(2), newStock, nowSql, pid],
      );
      if (res.affectedRows === 1) {
        adjusted++;
        // v2：记录调价流水（无事实事实表）—— 让价格历史可追溯
        await this.db.run(
          `INSERT INTO fact_product_price_change
             (product_id, old_price, new_price, change_type, change_time)
           VALUES (?, ?, ?, 'ADJUST', ?)`,
          [
            pid,
            (priceCents / 100).toFixed(2),
            (newPriceCents / 100).toFixed(2),
            nowSql,
          ],
        );
      }
    }

    if (adjusted > 0 || deactivated > 0) {
      this.stats.counters.productsPriceAdjusted += adjusted;
      this.stats.counters.productsDeactivated += deactivated;
      this.logger.log(
        `price adjust: +${adjusted} price/stock, +${deactivated} deactivated, ` +
          `total adjusted=${this.stats.counters.productsPriceAdjusted}`,
      );
    }
  }
}
