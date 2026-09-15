import { Logger } from '@nestjs/common';
import { GearName } from '../config';
import { DatabaseService } from '../db/database.service';
import { SeedService } from './seed.service';
import { StatsService } from './stats.service';
import { LoopedTask } from './task.base';
export declare class OrderGeneratorService extends LoopedTask {
    private readonly db;
    private readonly seed;
    private readonly stats;
    protected readonly logger: Logger;
    private gear;
    private switcherTimer?;
    private lastRefreshAt;
    private logCounter;
    constructor(db: DatabaseService, seed: SeedService, stats: StatsService);
    get currentGear(): GearName;
    setGear(g: GearName): void;
    start(delayMs?: number): void;
    pause(): void;
    resume(): void;
    onModuleDestroy(): void;
    startGearSwitcher(): void;
    stopGearSwitcher(): void;
    protected tick(): Promise<void>;
}
