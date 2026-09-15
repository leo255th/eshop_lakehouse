"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.runBulk = runBulk;
const fs_1 = require("fs");
const promises_1 = require("fs/promises");
const path_1 = require("path");
const promise_1 = __importDefault(require("mysql2/promise"));
const config_1 = require("../config");
const clock_service_1 = require("../clock/clock.service");
const seed_generators_1 = require("./seed-generators");
const tsv_writer_1 = require("./tsv-writer");
const range_filter_1 = require("./range-filter");
const loader_1 = require("./loader");
const rng_1 = require("./rng");
const DAY_MS = 86_400_000;
async function runBulk(opts) {
    const started = Date.now();
    const { profile } = opts;
    const db = profile.database;
    log(`=== 批量生成开始 ===`);
    log(`  规模      : ${profile.label} (${profile.orders.toLocaleString()} 订单)`);
    log(`  目标库    : ${db}`);
    log(`  维表      : ${profile.users.toLocaleString()} 用户 / ${profile.products.toLocaleString()} 商品`);
    log(`  数据区间  : ${clock_service_1.Clock.formatMs(opts.startMs)} ~ ${clock_service_1.Clock.formatMs(opts.endMs)}` +
        `  (${((opts.endMs - opts.startMs) / DAY_MS).toFixed(0)} 天, pattern=${opts.pattern})`);
    log(`  分片数    : ${opts.shards}`);
    if (!(0, range_filter_1.isEmpty)(opts.priceChangeProductFilter)) {
        log(`  价格历史范围: ${(0, range_filter_1.describe)(opts.priceChangeProductFilter)}（仅这些商品会调价）`);
    }
    log(`  随机种子  : ${opts.seed}  (固定种子 → 数据可复现)`);
    log('');
    await ensureDatabaseAndSchema(db, opts.recreate);
    (0, fs_1.mkdirSync)(opts.tmpDir, { recursive: true });
    const tProducts = Date.now();
    const { productPrice, basePrice, productStatus, productRows, tsvBytes: dimBytes } = await generateAndLoadProducts(opts, db);
    log(`      ⏱ 商品阶段耗时 ${(0, rng_1.humanDuration)(Date.now() - tProducts)}`);
    const tUsers = Date.now();
    const userBytes = await generateAndLoadUsers(opts, db);
    log(`      ⏱ 用户阶段耗时 ${(0, rng_1.humanDuration)(Date.now() - tUsers)}`);
    const rows = {
        dim_user: profile.users,
        dim_product: profile.products,
    };
    let totalTsvBytes = dimBytes + userBytes;
    let priceHistory;
    if (opts.priceChangePerProduct > 0) {
        log(`\n[3.5/5] 构建价格历史（每商品 ${opts.priceChangePerProduct} 次调价）...`);
        const priceFilter = opts.priceChangeProductFilter ?? range_filter_1.EMPTY_RANGE;
        const perProductArr = new Int32Array(profile.products);
        for (let i = 0; i < profile.products; i++) {
            perProductArr[i] = (0, range_filter_1.isEmpty)(priceFilter)
                ? opts.priceChangePerProduct
                : (0, range_filter_1.inRange)(priceFilter, i + 1)
                    ? opts.priceChangePerProduct
                    : 0;
        }
        priceHistory = (0, seed_generators_1.buildPriceHistoryPerProduct)(profile.products, opts.seed, opts.startMs, opts.endMs, perProductArr, basePrice);
        let changed = 0;
        for (let i = 0; i < profile.products; i++) {
            const fp = (0, seed_generators_1.finalPrice)(priceHistory, i, basePrice);
            if (fp !== basePrice[i]) {
                productPrice[i] = fp;
                changed++;
            }
        }
        if (changed > 0) {
            await applyPriceHistoryByTime(opts, db, priceHistory, basePrice, profile.products, opts.endMs);
            log(`      已按时间戳写回 dim_product.price（${changed.toLocaleString()} 个商品变价）`);
        }
    }
    const ctx = {
        seed: opts.seed,
        dataStartMs: opts.startMs,
        dataEndMs: opts.endMs,
        pattern: opts.pattern,
        userCount: profile.users,
        productCount: profile.products,
        itemCountWeights: config_1.config.gen.itemCountWeights,
        qtyWeights: config_1.config.gen.qtyWeights,
        cancelRatio: config_1.config.gen.cancelRatio,
        lateRatio: config_1.config.gen.lateRatio,
        lateMaxMs: config_1.config.gen.lateMaxSec * 1000,
        productPriceCents: productPrice,
        productStatus,
        priceHistory,
        basePriceCents: priceHistory ? basePrice : undefined,
    };
    const ranges = (0, rng_1.splitRanges)(profile.orders, opts.shards);
    log(`\n=== 事实表生成：${ranges.length} 个分片并行（生成+导入流水线）===`);
    log(`  （每分片会在「生成 TSV」与「LOAD DATA」之间交替，两种耗时分别统计）`);
    const tableOrder = (0, tsv_writer_1.shardFileName)(opts.tmpDir, 'fact_order', 0, profile.key).replace(/_s000\.tsv$/, '');
    const tableItem = (0, tsv_writer_1.shardFileName)(opts.tmpDir, 'fact_order_item', 0, profile.key).replace(/_s000\.tsv$/, '');
    const maxItemsPerOrder = config_1.config.gen.itemCountWeights.length;
    const shardSpan = Math.ceil(profile.orders / ranges.length);
    const shardItemBase = (shardIdx) => shardIdx * shardSpan * maxItemsPerOrder;
    let doneOrders = 0;
    let doneItems = 0;
    const shardStart = Date.now();
    const shardResults = await (0, rng_1.mapLimit)(ranges, Math.min(opts.shards, ranges.length), async ([from, to], idx) => {
        const orderFile = `${tableOrder}_s${String(idx).padStart(3, '0')}.tsv`;
        const itemFile = `${tableItem}_s${String(idx).padStart(3, '0')}.tsv`;
        const tGen = Date.now();
        const ow = new tsv_writer_1.TsvWriter(orderFile);
        const iw = new tsv_writer_1.TsvWriter(itemFile);
        let itemSeq = shardItemBase(idx);
        const f = loader_1.TABLE_COLUMNS.fact_order;
        const fi = loader_1.TABLE_COLUMNS.fact_order_item;
        for (let oi = from; oi < to; oi++) {
            const { order, items } = (0, seed_generators_1.generateOrder)(oi, ctx, itemSeq + 1);
            itemSeq += items.length;
            ow.write([
                order.order_id, order.user_id, order.order_status, order.item_count,
                order.total_amount, order.discount_amount, order.pay_time,
                order.shipping_time, order.complete_time, order.cancel_time,
                order.order_time, order.update_time, order.is_deleted, order.deleted_time,
            ]);
            for (const it of items) {
                iw.write([
                    it.item_id, it.order_id, it.product_id, it.quantity,
                    it.unit_price, it.subtotal, it.discount_amount, it.create_time,
                ]);
            }
            if (ow.needsDrain || iw.needsDrain) {
                await Promise.all([ow.drain(), iw.drain()]);
            }
        }
        await Promise.all([ow.close(), iw.close()]);
        const genMs = Date.now() - tGen;
        const tLoad = Date.now();
        const conn = await (0, loader_1.openLoadConnection)(db);
        try {
            const ro = await (0, loader_1.loadFiles)(conn, {
                database: db,
                table: 'fact_order',
                columns: [...f],
                files: [orderFile],
            });
            const ri = await (0, loader_1.loadFiles)(conn, {
                database: db,
                table: 'fact_order_item',
                columns: [...fi],
                files: [itemFile],
            });
            doneOrders += ro.rows;
            doneItems += ri.rows;
            log(`  [shard ${idx}] 生成 ${(0, rng_1.humanDuration)(genMs)} + 导入 ${(0, rng_1.humanDuration)(Date.now() - tLoad)} | ` +
                `订单 ${ro.rows.toLocaleString()} (${ro.rowsPerSec.toLocaleString()} 行/秒) + ` +
                `明细 ${ri.rows.toLocaleString()} (${ri.rowsPerSec.toLocaleString()} 行/秒) | ` +
                `分片累计 ${(0, rng_1.humanDuration)(Date.now() - shardStart)}`);
            return { orders: ro.rows, items: ri.rows, bytes: (0, fs_1.statSync)(orderFile).size + (0, fs_1.statSync)(itemFile).size };
        }
        finally {
            await (0, loader_1.closeLoadConnection)(conn);
        }
    });
    for (const r of shardResults)
        totalTsvBytes += r.bytes;
    rows.fact_order = doneOrders;
    rows.fact_order_item = doneItems;
    log(`\n事实表导入完成：${doneOrders.toLocaleString()} 订单 / ${doneItems.toLocaleString()} 明细，` +
        `耗时 ${(0, rng_1.humanDuration)(Date.now() - shardStart)}`);
    if (opts.priceChangePerProduct > 0) {
        rows.fact_product_price_change = await generatePriceChangeTable(opts, db, ctx, productRows);
    }
    await backfillFirstOrderTime(db);
    if (!opts.keepTsv) {
        await cleanTmp(opts.tmpDir);
    }
    else {
        log(`TSV 保留在 ${opts.tmpDir}`);
    }
    const elapsedMs = Date.now() - started;
    log(`\n=== 批量生成完成 ===`);
    log(`  总耗时  : ${(0, rng_1.humanDuration)(elapsedMs)}`);
    log(`  TSV 体积: ${(0, rng_1.humanBytes)(totalTsvBytes)}`);
    for (const [t, c] of Object.entries(rows)) {
        log(`  ${t.padEnd(26)} ${c.toLocaleString().padStart(14)} 行`);
    }
    log(`\n下一步：npm run generate:replay:${profile.key}   # 从数据区间终点开始模拟实时增量`);
    return { database: db, sizeKey: profile.key, rows, elapsedMs, tsvBytes: totalTsvBytes };
}
function log(msg) {
    console.log(msg);
}
async function ensureDatabaseAndSchema(db, recreate) {
    const root = await promise_1.default.createConnection({
        host: config_1.config.db.host,
        port: config_1.config.db.port,
        user: config_1.config.db.user,
        password: config_1.config.db.password,
        timezone: config_1.config.db.timezone,
        multipleStatements: true,
    });
    try {
        if (recreate) {
            log(`[1/5] 重建数据库 ${db} ...`);
            await root.query(`DROP DATABASE IF EXISTS \`${db}\``);
        }
        else {
            log(`[1/5] 确保数据库 ${db} 存在 ...`);
        }
        await root.query(`CREATE DATABASE IF NOT EXISTS \`${db}\` DEFAULT CHARACTER SET utf8mb4 DEFAULT COLLATE utf8mb4_unicode_ci`);
    }
    finally {
        await root.end();
    }
    const { readFileSync } = await import('fs');
    const { join: pjoin } = await import('path');
    const schemaPath = pjoin(process.cwd(), 'sql', 'schema.sql');
    const sql = readFileSync(schemaPath, 'utf8').replace(/__DB__/g, db);
    const statements = sql
        .split('\n')
        .filter((l) => !l.trim().startsWith('--'))
        .join('\n')
        .split(';')
        .map((s) => s.trim())
        .filter((s) => s.length > 0)
        .filter((s) => !/^CREATE\s+DATABASE/i.test(s));
    const conn = await promise_1.default.createConnection({
        host: config_1.config.db.host,
        port: config_1.config.db.port,
        user: config_1.config.db.user,
        password: config_1.config.db.password,
        database: db,
        timezone: config_1.config.db.timezone,
        multipleStatements: true,
    });
    try {
        for (const stmt of statements) {
            await conn.query(stmt);
        }
    }
    finally {
        await conn.end();
    }
    log(`      建表完成（${statements.length} 条 DDL）`);
}
async function generateAndLoadProducts(opts, db) {
    const n = opts.profile.products;
    log(`[2/5] 生成商品维表 ${n.toLocaleString()} 行 ...`);
    const file = (0, path_1.join)(opts.tmpDir, `dim_product_${opts.profile.key}.tsv`);
    const w = new tsv_writer_1.TsvWriter(file);
    const price = new Int32Array(n);
    const basePrice = new Int32Array(n);
    const status = new Uint8Array(n);
    const cache = new Array(n);
    for (let i = 0; i < n; i++) {
        const p = (0, seed_generators_1.generateProduct)(i, opts.seed, opts.startMs, n);
        cache[i] = p;
        const cents = Math.round(parseFloat(p.price) * 100);
        price[i] = cents;
        basePrice[i] = cents;
        status[i] = p.status;
        w.write([
            p.product_id, p.product_name, p.category, p.brand, p.price, p.cost_price,
            p.stock, p.status, p.is_deleted, p.deleted_time, p.create_time, p.update_time,
        ]);
    }
    await w.close();
    const conn = await (0, loader_1.openLoadConnection)(db);
    const res = await (0, loader_1.loadFiles)(conn, {
        database: db,
        table: 'dim_product',
        columns: [...loader_1.TABLE_COLUMNS.dim_product],
        files: [file],
    });
    await (0, loader_1.closeLoadConnection)(conn);
    const bytes = (0, fs_1.statSync)(file).size;
    log(`      导入完成 ${res.rows.toLocaleString()} 行 ` +
        `(${res.rowsPerSec.toLocaleString()} 行/秒, ${(0, rng_1.humanBytes)(bytes)})`);
    return {
        productPrice: price,
        basePrice,
        productStatus: status,
        productRows: cache,
        tsvBytes: bytes,
    };
}
async function generateAndLoadUsers(opts, db) {
    const n = opts.profile.users;
    log(`[3/5] 生成用户维表 ${n.toLocaleString()} 行 ...`);
    const file = (0, path_1.join)(opts.tmpDir, `dim_user_${opts.profile.key}.tsv`);
    const w = new tsv_writer_1.TsvWriter(file);
    for (let i = 0; i < n; i++) {
        const u = (0, seed_generators_1.generateUser)(i, opts.seed, opts.startMs);
        w.write([
            u.user_id, u.username, u.phone, u.email, u.province, u.city,
            u.user_level, u.status, u.register_channel, u.first_order_time,
            u.is_deleted, u.deleted_time, u.create_time, u.update_time,
        ]);
    }
    await w.close();
    const conn = await (0, loader_1.openLoadConnection)(db);
    const res = await (0, loader_1.loadFiles)(conn, {
        database: db,
        table: 'dim_user',
        columns: [...loader_1.TABLE_COLUMNS.dim_user],
        files: [file],
    });
    await (0, loader_1.closeLoadConnection)(conn);
    const bytes = (0, fs_1.statSync)(file).size;
    log(`      导入完成 ${res.rows.toLocaleString()} 行 ` +
        `(${res.rowsPerSec.toLocaleString()} 行/秒, ${(0, rng_1.humanBytes)(bytes)})`);
    return bytes;
}
async function generatePriceChangeTable(opts, db, ctx, products) {
    const n = opts.profile.products;
    const perProduct = opts.priceChangePerProduct;
    log(`\n[4/5] 生成价格变更流水（约 ${Math.round(n * perProduct).toLocaleString()} 行）...`);
    const ranges = (0, rng_1.splitRanges)(n, opts.shards);
    const base = (0, path_1.join)(opts.tmpDir, `price_change_${opts.profile.key}`);
    let total = 0;
    let bytes = 0;
    await (0, rng_1.mapLimit)(ranges, Math.min(opts.shards, ranges.length), async ([from, to], idx) => {
        const file = `${base}_s${String(idx).padStart(3, '0')}.tsv`;
        const w = new tsv_writer_1.TsvWriter(file);
        for (let i = from; i < to; i++) {
            w.write([
                i + 1,
                null,
                (0, rng_1.fromCents)(ctx.basePriceCents[i]),
                'INIT',
                clock_service_1.Clock.formatMs(ctx.dataStartMs),
            ]);
            const changes = (0, seed_generators_1.priceChangesFromHistory)(ctx.priceHistory, i, ctx.basePriceCents[i], perProduct);
            for (const c of changes) {
                w.write([
                    c.product_id, c.old_price, c.new_price, c.change_type, c.change_time,
                ]);
            }
        }
        await w.close();
        const conn = await (0, loader_1.openLoadConnection)(db);
        try {
            const res = await (0, loader_1.loadFiles)(conn, {
                database: db,
                table: 'fact_product_price_change',
                columns: [...loader_1.TABLE_COLUMNS.fact_product_price_change],
                files: [file],
            });
            total += res.rows;
            bytes += (0, fs_1.statSync)(file).size;
        }
        finally {
            await (0, loader_1.closeLoadConnection)(conn);
        }
    });
    log(`      导入完成 ${total.toLocaleString()} 行 (${(0, rng_1.humanBytes)(bytes)})`);
    return total;
}
async function applyPriceHistoryByTime(opts, db, history, basePrice, productCount, endMs) {
    const changes = [];
    for (let i = 0; i < productCount; i++) {
        const n = history.counts[i];
        if (n === 0)
            continue;
        const tArr = history.times[i];
        const pArr = history.prices[i];
        for (let k = 0; k < n; k++) {
            changes.push({
                pid: i + 1,
                priceCents: pArr[k],
                atMs: history.epochBaseMs + tArr[k] * 1000,
            });
        }
    }
    if (changes.length === 0)
        return;
    changes.sort((a, b) => a.atMs - b.atMs);
    const conn = await promise_1.default.createConnection({
        host: config_1.config.db.host,
        port: config_1.config.db.port,
        user: config_1.config.db.user,
        password: config_1.config.db.password,
        database: db,
        timezone: config_1.config.db.timezone,
        connectTimeout: 60_000,
    });
    try {
        await conn.query('SET SESSION sql_mode = ""');
        const CHUNK = opts.priceChangePerProduct > 0 ? 500 : 200;
        let affected = 0;
        for (let start = 0; start < changes.length; start += CHUNK) {
            const chunk = changes.slice(start, start + CHUNK);
            const lastByProduct = new Map();
            for (const c of chunk)
                lastByProduct.set(c.pid, c);
            const priceCase = [];
            const timeCase = [];
            const ids = [];
            for (const [pid, c] of lastByProduct) {
                ids.push(pid);
                priceCase.push(`WHEN ${pid} THEN ${(c.priceCents / 100).toFixed(2)}`);
                timeCase.push(`WHEN ${pid} THEN '${clock_service_1.Clock.formatMs(c.atMs)}'`);
            }
            if (ids.length === 0)
                continue;
            const priceExpr = `CASE product_id ${priceCase.join(' ')} END`;
            const timeExpr = `CASE product_id ${timeCase.join(' ')} END`;
            const [res] = await conn.query(`UPDATE dim_product
            SET price = ${priceExpr},
                update_time = ${timeExpr}
          WHERE product_id IN (${ids.join(',')})
            AND price <> ${priceExpr}`);
            affected += res.affectedRows ?? 0;
        }
        log(`      按时间戳写入 ${changes.toLocaleString()} 个变更点，实际更新 ${affected.toLocaleString()} 行`);
    }
    finally {
        await conn.end().catch(() => undefined);
    }
}
async function backfillFirstOrderTime(db) {
    log(`\n[5/5] 回填 dim_user.first_order_time ...`);
    const conn = await promise_1.default.createConnection({
        host: config_1.config.db.host,
        port: config_1.config.db.port,
        user: config_1.config.db.user,
        password: config_1.config.db.password,
        database: db,
        timezone: config_1.config.db.timezone,
        connectTimeout: 60_000,
    });
    try {
        await conn.query('SET SESSION sql_mode = ""');
        const [res] = await conn.query(`
      UPDATE dim_user u
      JOIN (
        SELECT user_id, MIN(order_time) AS first_ot
        FROM fact_order
        GROUP BY user_id
      ) o ON o.user_id = u.user_id
      SET u.first_order_time = o.first_ot
      WHERE u.first_order_time IS NULL
    `);
        const affected = res.affectedRows ?? 0;
        log(`      回填 ${affected.toLocaleString()} 行`);
    }
    finally {
        await conn.end();
    }
}
async function cleanTmp(dir) {
    try {
        if (!(0, fs_1.existsSync)(dir))
            return;
        const files = await (0, promises_1.readdir)(dir);
        for (const f of files) {
            (0, fs_1.rmSync)((0, path_1.join)(dir, f), { force: true });
        }
        log(`已清理临时目录 ${dir}`);
    }
    catch (e) {
        log(`清理临时目录失败（可忽略）：${e.message}`);
    }
}
//# sourceMappingURL=bulk.js.map