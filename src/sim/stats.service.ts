import { Injectable } from '@nestjs/common';
import { GearName } from '../config';
import { DatabaseService } from '../db/database.service';

export interface SimCounters {
  ordersCreated: number;
  itemsCreated: number;
  ordersStatusChanged: number;
  ordersCancelled: number;
  productsPriceAdjusted: number;
  productsDeactivated: number;
  usersUpdated: number;
  usersDeactivated: number;
  ordersDeleted: number;
  itemsDeleted: number;
  usersDeleted: number;
  productsDeleted: number;
  gearSwitches: number;
}

export function emptyCounters(): SimCounters {
  return {
    ordersCreated: 0,
    itemsCreated: 0,
    ordersStatusChanged: 0,
    ordersCancelled: 0,
    productsPriceAdjusted: 0,
    productsDeactivated: 0,
    usersUpdated: 0,
    usersDeactivated: 0,
    ordersDeleted: 0,
    itemsDeleted: 0,
    usersDeleted: 0,
    productsDeleted: 0,
    gearSwitches: 0,
  };
}

/**
 * 全局模拟状态：事件计数器 + 速率档位。各任务服务共享同一实例。
 */
@Injectable()
export class StatsService {
  readonly counters: SimCounters = emptyCounters();
  readonly startedAt = Date.now();
  paused = false;
  private currentGear: GearName = 'medium';

  constructor(private readonly db: DatabaseService) {}

  get gear(): GearName {
    return this.currentGear;
  }

  setGear(g: GearName): void {
    if (this.currentGear !== g) {
      this.counters.gearSwitches++;
    }
    this.currentGear = g;
  }

  get uptimeSec(): number {
    return Math.floor((Date.now() - this.startedAt) / 1000);
  }

  /** 从数据库取实时快照（表行数 + 订单状态分布），用于 /api/stats */
  async dbSnapshot(): Promise<Record<string, unknown>> {
    try {
      const users = await this.db.query<{ c: string }>(
        'SELECT COUNT(*) AS c FROM dim_user',
      );
      const products = await this.db.query<{ c: string }>(
        'SELECT COUNT(*) AS c FROM dim_product',
      );
      const orders = await this.db.query<{ c: string }>(
        'SELECT COUNT(*) AS c FROM fact_order',
      );
      const items = await this.db.query<{ c: string }>(
        'SELECT COUNT(*) AS c FROM fact_order_item',
      );
      const byStatus = await this.db.query<{ order_status: string; c: string }>(
        `SELECT order_status, COUNT(*) AS c FROM fact_order GROUP BY order_status`,
      );
      return {
        dim_user: Number(users[0]?.c ?? 0),
        dim_product: Number(products[0]?.c ?? 0),
        fact_order: Number(orders[0]?.c ?? 0),
        fact_order_item: Number(items[0]?.c ?? 0),
        order_status_distribution: Object.fromEntries(
          byStatus.map((r) => [r.order_status, Number(r.c)]),
        ),
      };
    } catch (e) {
      return { error: (e as Error).message };
    }
  }
}
