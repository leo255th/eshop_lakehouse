import { Logger } from '@nestjs/common';
import { DatabaseService } from '../db/database.service';
import { StatsService } from './stats.service';
import { LoopedTask } from './task.base';
export declare class UserUpdaterService extends LoopedTask {
    private readonly db;
    private readonly stats;
    protected readonly logger: Logger;
    private maxUserId;
    private lastBoundsRefresh;
    constructor(db: DatabaseService, stats: StatsService);
    private get clock();
    private sampleUsers;
    protected tick(): Promise<void>;
}
