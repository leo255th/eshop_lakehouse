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
export declare function emptyCounters(): SimCounters;
export declare class StatsService {
    private readonly db;
    readonly counters: SimCounters;
    readonly startedAt: number;
    paused: boolean;
    private currentGear;
    constructor(db: DatabaseService);
    get gear(): GearName;
    setGear(g: GearName): void;
    get uptimeSec(): number;
    dbSnapshot(): Promise<Record<string, unknown>>;
}
