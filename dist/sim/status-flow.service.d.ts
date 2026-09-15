import { Logger } from '@nestjs/common';
import { DatabaseService } from '../db/database.service';
import { StatsService } from './stats.service';
import { LoopedTask } from './task.base';
export declare class StatusFlowService extends LoopedTask {
    private readonly db;
    private readonly stats;
    protected readonly logger: Logger;
    private totalChanged;
    private maxOrderId;
    private lastBoundsRefresh;
    constructor(db: DatabaseService, stats: StatsService);
    private get clock();
    private sampleOrders;
    protected tick(): Promise<void>;
}
