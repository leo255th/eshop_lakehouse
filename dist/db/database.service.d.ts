import { OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { PoolConnection } from 'mysql2/promise';
import { Clock } from '../clock/clock.service';
export declare class DatabaseService implements OnModuleInit, OnModuleDestroy {
    private readonly logger;
    private pool;
    readonly clock: Clock;
    constructor();
    onModuleInit(): Promise<void>;
    onModuleDestroy(): Promise<void>;
    ensureDatabase(): Promise<void>;
    ensureSchema(): Promise<void>;
    reset(): Promise<void>;
    query<T = any>(sql: string, params?: any[]): Promise<T[]>;
    execute(sql: string, params?: any[]): Promise<{
        affectedRows: number;
        insertId: number;
    }>;
    run(sql: string, params?: any[]): Promise<{
        affectedRows: number;
        insertId: number;
    }>;
    insert(sql: string, params?: any[]): Promise<{
        affectedRows: number;
        insertId: number;
    }>;
    transaction<T>(fn: (conn: PoolConnection) => Promise<T>): Promise<T>;
}
