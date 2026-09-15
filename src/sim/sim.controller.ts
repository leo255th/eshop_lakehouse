import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Param,
  Post,
} from '@nestjs/common';
import { GEARS, GearName } from '../config';
import { OrderGeneratorService } from './order-generator.service';
import { SeedService } from './seed.service';
import { SimService } from './sim.service';
import { StatsService } from './stats.service';

/**
 * 模拟控制台：
 *  GET  /api/stats            运行统计 + 数据库实时快照
 *  POST /api/gear/:gear       手动切换下单速率档位 low|medium|high
 *  POST /api/pause            暂停所有任务
 *  POST /api/resume           恢复所有任务
 *  POST /api/seed             幂等补种用户/商品（表为空时才写入）并刷新缓存
 */
@Controller('api')
export class SimController {
  constructor(
    private readonly stats: StatsService,
    private readonly sim: SimService,
    private readonly orderGen: OrderGeneratorService,
    private readonly seed: SeedService,
  ) {}

  @Get('stats')
  async getStats(): Promise<Record<string, unknown>> {
    const c = this.stats.counters;
    return {
      uptimeSec: this.stats.uptimeSec,
      paused: this.stats.paused,
      gear: this.stats.gear,
      gearRangesMs: GEARS,
      counters: c,
      db: await this.stats.dbSnapshot(),
    };
  }

  @Post('gear/:gear')
  setGear(@Param('gear') gear: string): { gear: GearName } {
    const g = gear.toLowerCase();
    if (!(g in GEARS)) {
      throw new BadRequestException(
        `invalid gear: ${gear} (use low|medium|high)`,
      );
    }
    this.orderGen.setGear(g as GearName);
    return { gear: g as GearName };
  }

  @Post('pause')
  pause(): { paused: boolean } {
    this.sim.pauseAll();
    return { paused: true };
  }

  @Post('resume')
  resume(): { paused: boolean } {
    this.sim.resumeAll();
    return { paused: false };
  }

  @Post('seed')
  async reseed(
    @Body() body?: { backfill?: boolean },
  ): Promise<Record<string, unknown>> {
    const result = await this.seed.seedIfNeeded();
    let backfilled = 0;
    if (body?.backfill) {
      backfilled = await this.seed.backfillOrders();
    }
    return {
      seededUsers: result.users,
      seededProducts: result.products,
      backfilledOrders: backfilled,
      cache: { users: this.seed.userCount, products: this.seed.productCount },
    };
  }
}
