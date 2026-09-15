import { GearName } from '../config';
import { OrderGeneratorService } from './order-generator.service';
import { SeedService } from './seed.service';
import { SimService } from './sim.service';
import { StatsService } from './stats.service';
export declare class SimController {
    private readonly stats;
    private readonly sim;
    private readonly orderGen;
    private readonly seed;
    constructor(stats: StatsService, sim: SimService, orderGen: OrderGeneratorService, seed: SeedService);
    getStats(): Promise<Record<string, unknown>>;
    setGear(gear: string): {
        gear: GearName;
    };
    pause(): {
        paused: boolean;
    };
    resume(): {
        paused: boolean;
    };
    reseed(body?: {
        backfill?: boolean;
    }): Promise<Record<string, unknown>>;
}
