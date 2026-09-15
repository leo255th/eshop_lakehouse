"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.TABLE_COLUMNS = void 0;
exports.openLoadConnection = openLoadConnection;
exports.loadFiles = loadFiles;
exports.closeLoadConnection = closeLoadConnection;
const promise_1 = __importDefault(require("mysql2/promise"));
const fs_1 = require("fs");
const config_1 = require("../config");
function connOptions(overrides) {
    return {
        host: config_1.config.db.host,
        port: config_1.config.db.port,
        user: config_1.config.db.user,
        password: config_1.config.db.password,
        database: overrides.database,
        timezone: config_1.config.db.timezone,
        infileStreamFactory: (filePath) => (0, fs_1.createReadStream)(filePath),
        multipleStatements: true,
        connectTimeout: 30_000,
        charset: 'utf8mb4',
    };
}
async function openLoadConnection(database) {
    const conn = await promise_1.default.createConnection(connOptions({ database }));
    await conn.query('SET SESSION unique_checks = 0');
    await conn.query('SET SESSION foreign_key_checks = 0');
    await conn.query('SET SESSION sql_mode = ""');
    await conn.query('SET SESSION time_zone = ?', [config_1.config.db.timezone]);
    return conn;
}
async function loadFiles(conn, opts) {
    const started = Date.now();
    let totalRows = 0;
    let totalWarnings = 0;
    const colList = opts.columns.map((c) => `\`${c}\``).join(', ');
    const sql = `LOAD DATA LOCAL INFILE ? INTO TABLE \`${opts.table}\` ` +
        `CHARACTER SET utf8mb4 ` +
        `FIELDS TERMINATED BY '\\t' ESCAPED BY '\\\\' ` +
        `LINES TERMINATED BY '\\n' ` +
        `(${colList})`;
    for (const file of opts.files) {
        const t0 = Date.now();
        const [result] = await conn.query(sql, [file]);
        const info = result;
        const rows = info.affectedRows ?? 0;
        totalRows += rows;
        totalWarnings += info.warningStatus ?? 0;
        opts.onProgress?.(file, rows, Date.now() - t0);
    }
    const elapsedMs = Date.now() - started;
    return {
        table: opts.table,
        files: opts.files.length,
        rows: totalRows,
        elapsedMs,
        rowsPerSec: elapsedMs > 0 ? Math.round((totalRows / elapsedMs) * 1000) : 0,
        warnings: totalWarnings,
    };
}
async function closeLoadConnection(conn) {
    try {
        await conn.query('SET SESSION unique_checks = 1');
        await conn.query('SET SESSION foreign_key_checks = 1');
    }
    catch {
    }
    await conn.end().catch(() => undefined);
}
exports.TABLE_COLUMNS = {
    dim_user: [
        'user_id',
        'username',
        'phone',
        'email',
        'province',
        'city',
        'user_level',
        'status',
        'register_channel',
        'first_order_time',
        'is_deleted',
        'deleted_time',
        'create_time',
        'update_time',
    ],
    dim_product: [
        'product_id',
        'product_name',
        'category',
        'brand',
        'price',
        'cost_price',
        'stock',
        'status',
        'is_deleted',
        'deleted_time',
        'create_time',
        'update_time',
    ],
    fact_order: [
        'order_id',
        'user_id',
        'order_status',
        'item_count',
        'total_amount',
        'discount_amount',
        'pay_time',
        'shipping_time',
        'complete_time',
        'cancel_time',
        'order_time',
        'update_time',
        'is_deleted',
        'deleted_time',
    ],
    fact_order_item: [
        'item_id',
        'order_id',
        'product_id',
        'quantity',
        'unit_price',
        'subtotal',
        'discount_amount',
        'create_time',
    ],
    fact_product_price_change: [
        'product_id',
        'old_price',
        'new_price',
        'change_type',
        'change_time',
    ],
    fact_stock_change: [
        'product_id',
        'order_id',
        'change_type',
        'delta',
        'stock_after',
        'change_time',
    ],
};
//# sourceMappingURL=loader.js.map