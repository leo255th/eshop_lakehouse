import { Logger } from '@nestjs/common';
import { DatabaseService } from '../db/database.service';
import { StatsService } from './stats.service';
import { LoopedTask } from './task.base';
export declare class DeletionCleanerService extends LoopedTask {
    private readonly db;
    private readonly stats;
    protected readonly logger: Logger;
    constructor(db: DatabaseService, stats: StatsService);
    private get clock();
    protected tick(): Promise<void>;
    private cleanCancelledOrders;
    private cleanDeactivatedUsers;
    private cleanOffShelfProducts;
}
