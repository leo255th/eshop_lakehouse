import { DatabaseService } from '../db/database.service';
export declare class SeedService {
    private readonly db;
    private readonly logger;
    private userPool;
    private productPool;
    private productPrice;
    private idBounds;
    constructor(db: DatabaseService);
    private get clock();
    get userCount(): number;
    get productCount(): number;
    randomUser(): number;
    randomProducts(n: number): number[];
    refreshCache(): Promise<void>;
    seedIfNeeded(): Promise<{
        users: boolean;
        products: boolean;
    }>;
    count(table: string): Promise<number>;
    private seedUsers;
    private seedProducts;
    backfillOrders(): Promise<number>;
}
