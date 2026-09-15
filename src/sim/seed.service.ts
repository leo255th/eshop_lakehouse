import { Injectable, Logger } from '@nestjs/common';
import { config } from '../config';
import { DatabaseService } from '../db/database.service';
import { CATEGORIES, CHANNELS, PROVINCES } from './seed-data';
import {
  chance,
  fromCents,
  pick,
  pickN,
  randInt,
  randomPhone,
  toCents,
  weightedIndex,
} from './util';

const ORDER_STATUSES = [
  'CREATED',
  'PAID',
  'SHIPPED',
  'COMPLETED',
  'CANCELLED',
] as const;

/**
 * 种子数据与历史回填（v2 改造）
 *
 * v2 的关键修复：
 *  1. **所有时间字段显式写入虚拟时钟时间**（clock.toSql()），不再依赖
 *     NOW()/CURRENT_TIMESTAMP/ON UPDATE —— 这是计划 4.0 节那个致命 bug 的修复
 *  2. **采样池替代全量 ID 缓存**：v1 的 refreshCache() 把全量活跃用户/商品 ID
 *     读进 JS 数组，百万级用户会 OOM。v2 只维护固定大小的采样池
 *     （而且批量生成器根本不走这条路径 —— 它用流式逐行生成）
 *  3. 新增字段：register_channel / first_order_time / is_deleted / deleted_time
 *     / cost_price / shipping_time / complete_time / cancel_time / discount_amount
 */
@Injectable()
export class SeedService {
  private readonly logger = new Logger(SeedService.name);

  /** 采样池（固定大小），而非全量 ID 数组 —— 避免 OOM */
  private userPool: number[] = [];
  private productPool: number[] = [];
  private productPrice: Map<number, string> = new Map();
  private idBounds = { minUserId: 1, maxUserId: 1, minProductId: 1, maxProductId: 1 };

  constructor(private readonly db: DatabaseService) {}

  private get clock() {
    return this.db.clock;
  }

  get userCount(): number {
    return this.idBounds.maxUserId;
  }
  get productCount(): number {
    return this.idBounds.maxProductId;
  }

  /** 从采样池随机取一个用户（池空则按 ID 范围随机兜底） */
  randomUser(): number {
    if (this.userPool.length > 0) return pick(this.userPool);
    const { minUserId, maxUserId } = this.idBounds;
    return minUserId + randInt(0, Math.max(0, maxUserId - minUserId));
  }

  /** 从采样池随机取 n 个商品 */
  randomProducts(n: number): number[] {
    if (this.productPool.length > 0) return pickN(this.productPool, n);
    const { minProductId, maxProductId } = this.idBounds;
    const out: number[] = [];
    for (let i = 0; i < n; i++) {
      out.push(minProductId + randInt(0, Math.max(0, maxProductId - minProductId)));
    }
    return out;
  }

  /**
   * 刷新采样池与 ID 边界。
   *
   * v1 做法：`SELECT user_id FROM dim_user WHERE status=1` 全量拉取 → 百万级 OOM
   * v2 做法：只取固定大小的样本（ORDER BY user_id LIMIT poolSize），
   *          并单独查 MIN/MAX 得到 ID 边界用于兜底随机
   */
  async refreshCache(): Promise<void> {
    const poolSize = config.tasks.userUpdate.samplePool;

    const bounds = await this.db.query<{
      min_u: string;
      max_u: string;
      min_p: string;
      max_p: string;
    }>(
      `SELECT
         (SELECT MIN(user_id) FROM dim_user) AS min_u,
         (SELECT MAX(user_id) FROM dim_user) AS max_u,
         (SELECT MIN(product_id) FROM dim_product) AS min_p,
         (SELECT MAX(product_id) FROM dim_product) AS max_p`,
    );
    this.idBounds = {
      minUserId: Number(bounds[0]?.min_u ?? 1),
      maxUserId: Number(bounds[0]?.max_u ?? 1),
      minProductId: Number(bounds[0]?.min_p ?? 1),
      maxProductId: Number(bounds[0]?.max_p ?? 1),
    };

    // 采样池：随机取固定数量（用主键范围采样，避免 ORDER BY RAND() 全表扫）
    const users = await this.db.query<{ user_id: string }>(
      `SELECT user_id FROM dim_user WHERE status = 1 AND is_deleted = 0 LIMIT ?`,
      [poolSize],
    );
    const products = await this.db.query<{
      product_id: string;
      price: string;
    }>(
      `SELECT product_id, price FROM dim_product WHERE status = 1 AND is_deleted = 0 LIMIT ?`,
      [Math.min(poolSize, 10000)],
    );

    this.userPool = users.map((r) => Number(r.user_id));
    this.productPool = products.map((r) => Number(r.product_id));
    this.productPrice = new Map(
      products.map((r) => [Number(r.product_id), r.price]),
    );

    this.logger.log(
      `cache refreshed: bounds user[${this.idBounds.minUserId},${this.idBounds.maxUserId}] ` +
        `product[${this.idBounds.minProductId},${this.idBounds.maxProductId}] ` +
        `pool users=${this.userPool.length} products=${this.productPool.length}`,
    );
  }

  /** 主入口：表为空则种子化用户/商品，并刷新缓存 */
  async seedIfNeeded(): Promise<{ users: boolean; products: boolean }> {
    const users = await this.count('dim_user');
    const products = await this.count('dim_product');
    const seededUsers = users === 0;
    const seededProducts = products === 0;
    if (seededUsers) {
      await this.seedUsers(config.seed.users);
    }
    if (seededProducts) {
      await this.seedProducts(config.seed.products);
    }
    await this.refreshCache();
    return { users: seededUsers, products: seededProducts };
  }

  async count(table: string): Promise<number> {
    const rows = await this.db.query<{ c: string }>(
      `SELECT COUNT(*) AS c FROM ${table}`,
    );
    return Number(rows[0]?.c ?? 0);
  }

  // ---------------------------------------------------------------- 用户
  private async seedUsers(count: number): Promise<void> {
    const BATCH = 200;
    const now = this.clock.nowMs();
    const DAY = 24 * 3600 * 1000;
    let inserted = 0;

    for (let start = 0; start < count; start += BATCH) {
      const rows: unknown[][] = [];
      for (let i = start; i < Math.min(start + BATCH, count); i++) {
        const region = pick(PROVINCES);
        const username = `user_${100000 + i}`;
        const createdAgo = Math.floor(Math.random() * 30) * DAY;
        // v2：显式写入虚拟时钟时间
        const createTime = this.clock.toSql(new Date(now - createdAgo));
        rows.push([
          username,
          randomPhone(),
          `${username}@example.com`,
          region.province,
          pick(region.cities),
          weightedIndex([60, 30, 10]) + 1, // user_level 1/2/3
          1, // status
          CHANNELS[weightedIndex([45, 25, 15, 8, 7])], // v2 新增 register_channel
          null, // first_order_time（由订单回填）
          0, // is_deleted
          null, // deleted_time
          createTime,
          createTime,
        ]);
      }
      await this.db.insert(
        `INSERT INTO dim_user
           (username, phone, email, province, city, user_level, status,
            register_channel, first_order_time, is_deleted, deleted_time,
            create_time, update_time)
         VALUES ?`,
        [rows],
      );
      inserted += rows.length;
    }
    this.logger.log(`seeded ${inserted} users`);
  }

  // ---------------------------------------------------------------- 商品
  private async seedProducts(count: number): Promise<void> {
    const BATCH = 200;
    const now = this.clock.nowMs();
    const DAY = 24 * 3600 * 1000;
    const perCategory = Math.max(1, Math.floor(count / CATEGORIES.length));
    let inserted = 0;

    for (let start = 0; start < count; start += BATCH) {
      const rows: unknown[][] = [];
      for (let i = start; i < Math.min(start + BATCH, count); i++) {
        const cat = CATEGORIES[Math.floor(i / perCategory) % CATEGORIES.length];
        const brand = pick(cat.brands);
        const [min, max] = cat.priceRange;
        const price = (
          Math.round((min + Math.random() * (max - min)) * 100) / 100
        ).toFixed(2);
        // v2 新增：成本价 = 售价 × 55%~85%
        const cost = (
          (Math.round(Number(price) * 100) * (0.55 + Math.random() * 0.3)) /
          100
        ).toFixed(2);
        const createdAgo = Math.floor(Math.random() * 30) * DAY;
        const createTime = this.clock.toSql(new Date(now - createdAgo));
        rows.push([
          `${brand} ${cat.name} ${String(i).padStart(3, '0')}`,
          cat.name,
          brand,
          price,
          cost, // v2 新增 cost_price
          randInt(0, 1000), // stock
          1, // status
          0, // is_deleted
          null, // deleted_time
          createTime,
          createTime,
        ]);
      }
      await this.db.insert(
        `INSERT INTO dim_product
           (product_name, category, brand, price, cost_price, stock, status,
            is_deleted, deleted_time, create_time, update_time)
         VALUES ?`,
        [rows],
      );
      inserted += rows.length;
    }
    this.logger.log(
      `seeded ${inserted} products (${CATEGORIES.length} categories)`,
    );
  }

  // ---------------------------------------------------------------- 历史回填
  /**
   * 回填历史订单。
   *
   * ⚠️ v2 说明：这张表的回填能力有限（受 BACKFILL_RATE / BACKFILL_MAX_ORDERS 限制），
   * **百万级以上规模请用批量生成器**：
   *   npm run generate:100m / generate:10m / generate:100m
   * 本方法保留用于小规模快速验证。
   */
  async backfillOrders(): Promise<number> {
    const hours = config.backfill.hours;
    const rate = config.backfill.ratePerSecond;
    const maxOrders = config.backfill.maxOrders;
    const total = Math.min(maxOrders, Math.round(hours * 3600 * rate));
    if (total <= 0) return 0;

    const products = await this.db.query<{
      product_id: string;
      price: string;
    }>('SELECT product_id, price FROM dim_product');
    const users = await this.db.query<{ user_id: string }>(
      'SELECT user_id FROM dim_user',
    );
    if (products.length === 0 || users.length === 0) {
      this.logger.warn('backfill skipped: no users/products');
      return 0;
    }

    const productIds = products.map((r) => Number(r.product_id));
    const productPriceMap = new Map(
      products.map((r) => [Number(r.product_id), r.price]),
    );
    const userIds = users.map((r) => Number(r.user_id));
    const hoursMs = hours * 3600 * 1000;
    const nowVirtual = this.clock.nowMs();
    const minCap = (t: number) => Math.min(t, nowVirtual);

    let orders = 0;
    const BATCH = 500;
    const statusCount: Record<string, number> = {};

    for (let batchStart = 0; batchStart < total; batchStart += BATCH) {
      const blocks: { order: unknown[]; items: unknown[][] }[] = [];
      const batchEnd = Math.min(batchStart + BATCH, total);

      for (let k = batchStart; k < batchEnd; k++) {
        const ageMs = Math.pow(Math.random(), 1.3) * hoursMs;
        const orderMs = nowVirtual - ageMs;
        const recent = ageMs < 30 * 60 * 1000;

        let status: string;
        if (recent) {
          status = ORDER_STATUSES[weightedIndex([50, 30, 10, 0, 10])];
        } else {
          status = ORDER_STATUSES[weightedIndex([5, 11, 14, 62, 8])];
        }
        statusCount[status] = (statusCount[status] ?? 0) + 1;

        // 里程碑时间戳（v2：四个时间戳按状态机语义推进）
        let payMs: number | null = null;
        let shipMs: number | null = null;
        let completeMs: number | null = null;
        let cancelMs: number | null = null;

        if (['PAID', 'SHIPPED', 'COMPLETED'].includes(status)) {
          payMs = minCap(orderMs + randInt(10_000, 300_000));
        } else if (status === 'CANCELLED' && chance(0.5)) {
          payMs = minCap(orderMs + randInt(10_000, 120_000));
        }

        const base = payMs ?? orderMs;
        switch (status) {
          case 'COMPLETED':
            shipMs = minCap(base + randInt(60_000, 1_200_000));
            completeMs = minCap(shipMs + randInt(120_000, 3_600_000));
            break;
          case 'SHIPPED':
            shipMs = minCap(base + randInt(60_000, 1_200_000));
            break;
          case 'CANCELLED':
            cancelMs = minCap(base + randInt(60_000, 1_800_000));
            break;
          default:
            break;
        }

        const updateMs = Math.max(
          orderMs,
          ...[payMs, shipMs, completeMs, cancelMs].filter(
            (v): v is number => v !== null,
          ),
        );

        const itemCount = weightedIndex([50, 30, 20]) + 1;
        const chosen = pickN(productIds, itemCount);
        let totalCents = 0;
        let totalDiscountCents = 0;
        let totalQty = 0;
        const items: unknown[][] = [];

        for (const pid of chosen) {
          const qty = weightedIndex([40, 30, 20, 7, 3]) + 1;
          const basePriceCents = toCents(productPriceMap.get(pid) ?? '0');
          const unitPriceCents = Math.round(
            basePriceCents * (1 + (Math.random() * 0.1 - 0.05)),
          );
          const subtotalCents = unitPriceCents * qty;
          // v2：明细级优惠
          const discountCents = chance(0.3)
            ? Math.round(subtotalCents * Math.random() * 0.15)
            : 0;

          totalCents += subtotalCents - discountCents;
          totalDiscountCents += discountCents;
          totalQty += qty;
          items.push([
            pid,
            qty,
            fromCents(unitPriceCents),
            fromCents(subtotalCents),
            fromCents(discountCents), // v2 discount_amount
            this.clock.toSql(new Date(orderMs)),
          ]);
        }

        blocks.push({
          order: [
            pick(userIds),
            status,
            totalQty,
            fromCents(totalCents),
            fromCents(totalDiscountCents), // v2 discount_amount
            payMs === null ? null : this.clock.toSql(new Date(payMs)),
            shipMs === null ? null : this.clock.toSql(new Date(shipMs)),
            completeMs === null ? null : this.clock.toSql(new Date(completeMs)),
            cancelMs === null ? null : this.clock.toSql(new Date(cancelMs)),
            this.clock.toSql(new Date(orderMs)),
            this.clock.toSql(new Date(updateMs)),
            0, // is_deleted
            null, // deleted_time
          ],
          items,
        });
      }

      await this.db.transaction(async (conn) => {
        const [r] = await conn.query(
          `INSERT INTO fact_order
             (user_id, order_status, item_count, total_amount, discount_amount,
              pay_time, shipping_time, complete_time, cancel_time,
              order_time, update_time, is_deleted, deleted_time)
           VALUES ?`,
          [blocks.map((b) => b.order)],
        );
        const firstId = (r as { insertId: number }).insertId;
        const flatItems: unknown[][] = [];
        blocks.forEach((b, bi) => {
          for (const it of b.items) {
            flatItems.push([firstId + bi, ...it]);
          }
        });
        await conn.query(
          `INSERT INTO fact_order_item
             (order_id, product_id, quantity, unit_price, subtotal, discount_amount, create_time)
           VALUES ?`,
          [flatItems],
        );
      });

      orders += batchEnd - batchStart;
      if (orders % 5000 === 0 || orders === total) {
        this.logger.log(
          `backfill progress: ${orders}/${total} orders, status=${JSON.stringify(statusCount)}`,
        );
      }
    }

    this.logger.log(
      `backfilled ${orders} historical orders over last ${hours}h, status=${JSON.stringify(statusCount)}`,
    );
    return orders;
  }
}
