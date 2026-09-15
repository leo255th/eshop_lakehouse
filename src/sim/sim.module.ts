import { Module } from '@nestjs/common';
import { DatabaseService } from '../db/database.service';
import { CancelerService } from './canceler.service';
import { DeletionCleanerService } from './deletion-cleaner.service';
import { OrderGeneratorService } from './order-generator.service';
import { PriceAdjusterService } from './price-adjuster.service';
import { SeedService } from './seed.service';
import { SimController } from './sim.controller';
import { SimService } from './sim.service';
import { StatsService } from './stats.service';
import { StatusFlowService } from './status-flow.service';
import { UserUpdaterService } from './user-updater.service';

@Module({
  controllers: [SimController],
  providers: [
    DatabaseService,
    StatsService,
    SeedService,
    SimService,
    OrderGeneratorService,
    StatusFlowService,
    CancelerService,
    PriceAdjusterService,
    UserUpdaterService,
    DeletionCleanerService,
  ],
  exports: [DatabaseService],
})
export class SimModule {}
