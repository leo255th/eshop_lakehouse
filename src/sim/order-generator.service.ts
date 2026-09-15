import { Injectable, Logger } from '@nestjs/common';
import mysql from 'mysql2/promise';
import { GEARS, GEAR_WEIGHTS, GearName, config } from '../config';
import { DatabaseService } from '../db/database.service';
import { SeedService } from './seed.service';
import { StatsService } from './stats.service';
import { LoopedTask } from './task.base';
import { fromCents, pick, randInt, toCents } from './util';

/**
 * 下单生成器（insert 主战场 + 速率档位）：
 *  - 每次 tick 创建一个订单：随机用户 + 1~3 个商品 + 随机数量
 *  - unit_price 取下单瞬间 dim_product.price 快照（此后不再变化）
 *  - 主表 + 明细同一事务写入，保证无孤儿数据
 *  - 订单 order_time 取当前时间 = 事件时间，用于窗口函数
 *  - 低/中/高 三档随机间隔，模拟促销峰谷；默认每 2 分钟自动切档
 *  - 可选顺带扣减库存（dim_product 的 update 事件来源之一）
 */
@Injectable()
export class OrderGeneratorService extends LoopedTask {
  protected readonly logger = new Logger(OrderGeneratorService.name);
  private gear: GearName = 'medium';
  private switcherTimer?: NodeJS.Timeout;
  private lastRefreshAt = 0;
  private logCounter = 0;

  constructor(
    private readonly db: DatabaseService,
    private readonly seed: SeedService,
    private readonly stats: StatsService,
  ) {
    super();
  }

  get currentGear(): GearName {
    return this.gear;
  }

  setGear(g: GearName): void {
    this.gear = g;
    this.stats.setGear(g);
    const range = GEARS[g];
    this.setDelay(randInt(range.minMs, range.maxMs));
    this.logger.log(
      `order rate gear -> ${g} (${range.minMs}-${range.maxMs}ms)`,
    );
  }

  start(delayMs?: number): void {
    this.setGear(this.gear); // 初始化当前档位间隔
    super.start(delayMs);
    this.startGearSwitcher();
  }

  pause(): void {
    super.pause();
    this.stopGearSwitcher();
  }

  resume(): void {
    super.resume();
    this.startGearSwitcher();
  }

  onModuleDestroy(): void {
    super.onModuleDestroy();
    this.stopGearSwitcher();
  }

  startGearSwitcher(): void {
    this.stopGearSwitcher();
    this.switcherTimer = setInterval(() => {
      this.setGear(pick(GEAR_WEIGHTS));
    }, config.gears.switchMs);
    this.switcherTimer.unref?.();
  }

  stopGearSwitcher(): void {
    if (this.switcherTimer) {
      clearInterval(this.switcherTimer);
      this.switcherTimer = undefined;
    }
  }

  protected async tick(): Promise<void> {
    // 周期性刷新活跃用户/商品缓存（清洗器可能已删除部分）
    if (Date.now() - this.lastRefreshAt > 60_000) {
      this.lastRefreshAt = Date.now();
      await this.seed.refreshCache().catch(() => undefined);
    }

    const userId = this.seed.randomUser();
    const productIds = this.seed.randomProducts(randInt(1, 3));
    if (productIds.length === 0) return;

    const placeholders = productIds.map(() => '?').join(',');
    const rows = await this.db.query<{
      product_id: string;
      price: string;
      status: string;
    }>(
      `SELECT product_id, price, status FROM dim_product
       WHERE product_id IN (${placeholders}) AND status = 1`,
      productIds,
    );
    if (rows.length === 0) return;

    // 组装明细：unit_price = 当时售价快照（分整数运算）
    // order_time 与明细 create_time 用同一个时间戳，保证窗口 join 口径一致
    // v2：order_time 来自虚拟时钟，不是机器真实时间
    //（v1 这里是 new Date()，会让历史数据的时间戳落成"今天"）
    const orderTime = this.db.clock.now();
    const nowSql = this.db.clock.toSql(orderTime);
    const itemRows: unknown[][] = [];
    const qtyByProduct = new Map<number, number>();
    let totalCents = 0;
    let totalDiscountCents = 0;
    let totalQty = 0;
    for (const r of rows) {
      const pid = Number(r.product_id);
      const qty = randInt(1, 5);
      const unitPriceCents = toCents(r.price);
      const subtotalCents = unitPriceCents * qty;
      totalCents += subtotalCents;
      totalQty += qty;
      qtyByProduct.set(pid, qty);
      // v2：新增 discount_amount（30% 的行有 0~15% 优惠）
      const discountCents =
        Math.random() < 0.3
          ? Math.round(subtotalCents * Math.random() * 0.15)
          : 0;
      totalCents -= discountCents;
      totalDiscountCents += discountCents;
      itemRows.push([
        pid,
        qty,
        fromCents(unitPriceCents),
        fromCents(subtotalCents),
        fromCents(discountCents),
        nowSql,
      ]);
    }

    await this.db.transaction(async (conn) => {
      const [res] = await conn.query<mysql.ResultSetHeader>(
        `INSERT INTO fact_order
           (user_id, order_status, item_count, total_amount, discount_amount,
            order_time, update_time)
         VALUES (?, 'CREATED', ?, ?, ?, ?, ?)`,
        [
          userId,
          totalQty,
          fromCents(totalCents),
          fromCents(totalDiscountCents),
          nowSql,
          nowSql,
        ],
      );
      const orderId = res.insertId;

      await conn.query(
        `INSERT INTO fact_order_item
           (order_id, product_id, quantity, unit_price, subtotal, discount_amount, create_time)
         VALUES ?`,
        [itemRows.map((it) => [orderId, ...it])],
      );

      // 可选：扣减库存，产生 dim_product update 事件（CDC 演示更丰富）
      if (config.tasks.order.decrementStock) {
        for (const [pid, qty] of qtyByProduct) {
          await conn.query(
            'UPDATE dim_product SET stock = GREATEST(stock - ?, 0), update_time = ? WHERE product_id = ?',
            [qty, nowSql, pid],
          );
          // v2：记录库存变更流水（无事实事实表）
          await conn.query(
            `INSERT INTO fact_stock_change
               (product_id, order_id, change_type, delta, stock_after, change_time)
             SELECT ?, ?, 'ORDER_DEDUCT', ?, stock, ? FROM dim_product WHERE product_id = ?`,
            [pid, orderId, -qty, nowSql, pid],
          );
        }
      }
    });

    this.stats.counters.ordersCreated++;
    this.stats.counters.itemsCreated += itemRows.length;

    // 下一 tick 间隔取当前档位内随机值
    const range = GEARS[this.gear];
    this.setDelay(randInt(range.minMs, range.maxMs));

    this.logCounter++;
    if (this.logCounter % 25 === 0) {
      this.logger.log(
        `orders created: ${this.stats.counters.ordersCreated} (items ${this.stats.counters.itemsCreated}), gear=${this.gear}`,
      );
    }
  }
}
