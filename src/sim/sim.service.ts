import {
  Injectable,
  Logger,
  OnApplicationBootstrap,
  OnModuleDestroy,
} from '@nestjs/common';
import { config } from '../config';
import { DatabaseService } from '../db/database.service';
import { CancelerService } from './canceler.service';
import { DeletionCleanerService } from './deletion-cleaner.service';
import { OrderGeneratorService } from './order-generator.service';
import { PriceAdjusterService } from './price-adjuster.service';
import { SeedService } from './seed.service';
import { StatsService } from './stats.service';
import { StatusFlowService } from './status-flow.service';
import { LoopedTask } from './task.base';
import { UserUpdaterService } from './user-updater.service';

/**
 * 模拟编排器：
 *  启动时 建库建表(DatabaseService) → 种子化(幂等) → 历史回填 → 拉起全部任务
 *  提供 pauseAll/resumeAll（HTTP 触发）与周期性摘要日志
 */
@Injectable()
export class SimService implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = new Logger(SimService.name);
  private tasks: LoopedTask[] = [];
  private summaryTimer?: NodeJS.Timeout;

  constructor(
    private readonly db: DatabaseService,
    private readonly seed: SeedService,
    private readonly stats: StatsService,
    private readonly orderGen: OrderGeneratorService,
    private readonly statusFlow: StatusFlowService,
    private readonly canceler: CancelerService,
    private readonly priceAdjust: PriceAdjusterService,
    private readonly userUpdate: UserUpdaterService,
    private readonly cleaner: DeletionCleanerService,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    // 测试环境（jest e2e）不启动模拟器
    if (process.env.NODE_ENV === 'test') return;

    const seedResult = config.seed.enabled
      ? await this.seed.seedIfNeeded()
      : { users: false, products: false };
    this.logger.log(
      `seed: users=${seedResult.users ? 'seeded' : 'already exists'} ` +
        `products=${seedResult.products ? 'seeded' : 'already exists'} ` +
        `(cache: ${this.seed.userCount} users, ${this.seed.productCount} products)`,
    );

    // 历史回填：仅当 fact_order 为空时执行（重启幂等）
    if (
      config.backfill.enabled &&
      (await this.seed.count('fact_order')) === 0
    ) {
      await this.seed.backfillOrders();
    }

    this.startTasks();
    this.startSummaryLogger();
    this.logger.log('eshop data source simulator started');
  }

  onModuleDestroy(): void {
    if (this.summaryTimer) clearInterval(this.summaryTimer);
    for (const t of this.tasks) t.stop();
  }

  private startTasks(): void {
    const t = config.tasks;
    if (t.order.enabled) {
      this.orderGen.start();
      this.tasks.push(this.orderGen);
    }
    if (t.statusFlow.enabled) {
      this.statusFlow.start(t.statusFlow.intervalMs);
      this.tasks.push(this.statusFlow);
    }
    if (t.canceler.enabled) {
      this.canceler.start(t.canceler.intervalMs);
      this.tasks.push(this.canceler);
    }
    if (t.priceAdjust.enabled) {
      this.priceAdjust.start(t.priceAdjust.intervalMs);
      this.tasks.push(this.priceAdjust);
    }
    if (t.userUpdate.enabled) {
      this.userUpdate.start(t.userUpdate.intervalMs);
      this.tasks.push(this.userUpdate);
    }
    if (t.cleaner.enabled) {
      this.cleaner.start(t.cleaner.intervalMs);
      this.tasks.push(this.cleaner);
    }
  }

  pauseAll(): void {
    for (const t of this.tasks) t.pause();
    this.stats.paused = true;
    this.logger.warn('ALL tasks paused');
  }

  resumeAll(): void {
    for (const t of this.tasks) t.resume();
    this.stats.paused = false;
    this.logger.log('ALL tasks resumed');
  }

  private startSummaryLogger(): void {
    this.summaryTimer = setInterval(() => {
      const c = this.stats.counters;
      this.logger.log(
        `[summary] gear=${this.stats.gear} paused=${this.stats.paused} ` +
          `orders+${c.ordersCreated} items+${c.itemsCreated} ` +
          `statusFlow+${c.ordersStatusChanged} cancel+${c.ordersCancelled} ` +
          `priceAdjust+${c.productsPriceAdjusted} userUpdate+${c.usersUpdated} ` +
          `delOrders+${c.ordersDeleted} delItems+${c.itemsDeleted} ` +
          `delUsers+${c.usersDeleted} delProducts+${c.productsDeleted} ` +
          `| uptime ${this.stats.uptimeSec}s`,
      );
    }, 10_000);
    this.summaryTimer.unref?.();
  }
}
