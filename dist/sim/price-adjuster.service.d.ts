import { Logger } from '@nestjs/common';
import { DatabaseService } from '../db/database.service';
import { StatsService } from './stats.service';
import { LoopedTask } from './task.base';
export declare class PriceAdjusterService extends LoopedTask {
    private readonly db;
    private readonly stats;
    protected readonly logger: Logger;
    private maxProductId;
    private lastBoundsRefresh;
    constructor(db: DatabaseService, stats: StatsService);
    private get clock();
    private sampleProducts;
    protected tick(): Promise<void>;
}
