import type { Connection } from 'mysql2/promise';
export interface LoadOptions {
    host?: string;
    port?: number;
    user?: string;
    password?: string;
    database: string;
    table: string;
    columns: string[];
    files: string[];
    onProgress?: (file: string, rows: number, elapsedMs: number) => void;
}
export interface LoadResult {
    table: string;
    files: number;
    rows: number;
    elapsedMs: number;
    rowsPerSec: number;
    warnings: number;
}
export declare function openLoadConnection(database: string): Promise<Connection>;
export declare function loadFiles(conn: Connection, opts: LoadOptions): Promise<LoadResult>;
export declare function closeLoadConnection(conn: Connection): Promise<void>;
export declare const TABLE_COLUMNS: {
    readonly dim_user: readonly ["user_id", "username", "phone", "email", "province", "city", "user_level", "status", "register_channel", "first_order_time", "is_deleted", "deleted_time", "create_time", "update_time"];
    readonly dim_product: readonly ["product_id", "product_name", "category", "brand", "price", "cost_price", "stock", "status", "is_deleted", "deleted_time", "create_time", "update_time"];
    readonly fact_order: readonly ["order_id", "user_id", "order_status", "item_count", "total_amount", "discount_amount", "pay_time", "shipping_time", "complete_time", "cancel_time", "order_time", "update_time", "is_deleted", "deleted_time"];
    readonly fact_order_item: readonly ["item_id", "order_id", "product_id", "quantity", "unit_price", "subtotal", "discount_amount", "create_time"];
    readonly fact_product_price_change: readonly ["product_id", "old_price", "new_price", "change_type", "change_time"];
    readonly fact_stock_change: readonly ["product_id", "order_id", "change_type", "delta", "stock_after", "change_time"];
};
export type TableName = keyof typeof TABLE_COLUMNS;
