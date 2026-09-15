"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.runReplay = runReplay;
const promise_1 = __importDefault(require("mysql2/promise"));
const config_1 = require("../config");
const clock_service_1 = require("../clock/clock.service");
const rng_1 = require("./rng");
const seed_generators_1 = require("./seed-generators");
const range_filter_1 = require("./range-filter");
const DAY_MS = 86_400_000;
async function runReplay(opts) {
    const db = opts.profile.database;
    const log = (m) => console.log(m);
    log(`=== 实时增量生成开始（replay）===`);
    log(`  目标库     : ${db}`);
    log(`  起始虚拟时间: ${clock_service_1.Clock.formatMs(opts.startMs)}`);
    log(`  速率       : ${opts.ordersPerDay.toLocaleString()} 单/天 ` +
        `= ${(opts.ordersPerDay / 86400).toFixed(3)} 单/实时秒（scale=1 时）`);
    log(`  时间加速   : ${opts.timeScale}x  → 虚拟 ${(86400 * opts.timeScale).toLocaleString()} 秒/真实秒`);
    log(`  变更事件   : ${opts.withChurn ? '开启（状态流转/调价/取消/清理）' : '关闭'}`);
    if (opts.withChurn) {
        log(`    订单变更范围: ${(0, range_filter_1.describe)(opts.churnOrderFilter)}`);
        log(`    商品变更范围: ${(0, range_filter_1.describe)(opts.churnProductFilter)}`);
    }
    if (!(0, range_filter_1.isEmpty)(opts.orderIdFilter)) {
        log(`    新订单 ID 范围: ${(0, range_filter_1.describe)(opts.orderIdFilter)}`);
    }
    if (opts.burstEverySec > 0) {
        log(`  促销峰值   : 每 ${opts.burstEverySec}s 触发 ${opts.burstDurationSec}s 的 ${opts.burstMultiplier}x 爆发`);
    }
    log('');
    const conn = await promise_1.default.createConnection({
        host: config_1.config.db.host,
        port: config_1.config.db.port,
        user: config_1.config.db.user,
        password: config_1.config.db.password,
        database: db,
        timezone: config_1.config.db.timezone,
        connectTimeout: 30_000,
        charset: 'utf8mb4',
    });
    await conn.query('SET SESSION sql_mode = ""');
    try {
        const state = await readState(conn, opts.profile);
        log(`现有数据：订单 ${state.maxOrderId.toLocaleString()} / 明细 ${state.maxItemId.toLocaleString()} ` +
            `/ 用户 ${state.userCount.toLocaleString()} / 商品 ${state.productCount.toLocaleString()}`);
        const ctx = {
            seed: opts.seed,
            dataStartMs: opts.startMs,
            dataEndMs: opts.startMs + 365 * DAY_MS,
            pattern: config_1.config.gen.pattern,
            userCount: state.userCount,
            productCount: state.productCount,
            itemCountWeights: config_1.config.gen.itemCountWeights,
            qtyWeights: config_1.config.gen.qtyWeights,
            cancelRatio: config_1.config.gen.cancelRatio,
            lateRatio: config_1.config.gen.lateRatio,
            lateMaxMs: config_1.config.gen.lateMaxSec * 1000,
            productPriceCents: state.priceArr,
            productStatus: state.statusArr,
        };
        const ordersPerRealSec = (opts.ordersPerDay / 86400) * opts.timeScale;
        const ordersPerRealMs = ordersPerRealSec / 1000;
        log(`实际吞吐目标：${ordersPerRealSec.toFixed(2)} 单/真实秒 ` +
            `（若数据源和服务端同机可达 200+ 单/秒，此速率很轻松）\n`);
        const rng = new rng_1.Rng(opts.seed + 777);
        const startedReal = Date.now();
        let nextRealMs = startedReal;
        let nextOrderId = state.maxOrderId + 1;
        let nextItemId = state.maxItemId + 1;
        let created = 0;
        let lastLog = startedReal;
        let lastChurn = startedReal;
        let burstUntil = 0;
        let nextBurst = startedReal + opts.burstEverySec * 1000;
        let orderBuf = [];
        let itemBuf = [];
        while (true) {
            const nowReal = Date.now();
            if (opts.maxRuntimeSec > 0 && (nowReal - startedReal) / 1000 >= opts.maxRuntimeSec) {
                log(`\n达到运行时长上限 ${opts.maxRuntimeSec}s，停止。`);
                break;
            }
            let multiplier = 1;
            if (opts.burstEverySec > 0) {
                if (nowReal >= nextBurst && nowReal > burstUntil) {
                    burstUntil = nowReal + opts.burstDurationSec * 1000;
                    nextBurst = nowReal + opts.burstEverySec * 1000;
                    log(`  ⚡ 促销峰值开始（${opts.burstMultiplier}x，持续 ${opts.burstDurationSec}s）`);
                }
                if (nowReal < burstUntil)
                    multiplier = opts.burstMultiplier;
            }
            const virtualNowMs = opts.startMs + (nowReal - startedReal) * opts.timeScale;
            const generateOrders = ordersPerRealMs > 0;
            let n = 0;
            if (generateOrders) {
                const elapsed = nowReal - nextRealMs;
                const due = Math.floor(elapsed * ordersPerRealMs * multiplier);
                if (due <= 0) {
                    await sleep(Math.max(1, Math.min(50, 1 / Math.max(ordersPerRealMs, 1e-6))));
                    continue;
                }
                n = Math.min(due, 5000);
                nextRealMs += n / (ordersPerRealMs * multiplier);
            }
            ctx.eventTimeMs = virtualNowMs;
            ctx.streamJitterMs = config_1.config.gen.streamJitterMs;
            for (let k = 0; k < n; k++) {
                const oi = nextOrderId - 1;
                const { order, items } = (0, seed_generators_1.generateOrder)(oi, ctx, nextItemId);
                orderBuf.push([
                    order.order_id, order.user_id, order.order_status, order.item_count,
                    order.total_amount, order.discount_amount, order.pay_time,
                    order.shipping_time, order.complete_time, order.cancel_time,
                    order.order_time, order.update_time, order.is_deleted, order.deleted_time,
                ]);
                for (const it of items) {
                    itemBuf.push([
                        it.item_id, it.order_id, it.product_id, it.quantity,
                        it.unit_price, it.subtotal, it.discount_amount, it.create_time,
                    ]);
                }
                nextOrderId++;
                nextItemId += items.length;
                created++;
            }
            if (orderBuf.length >= opts.batchRows) {
                await flushOrders(conn, orderBuf, itemBuf);
                orderBuf = [];
                itemBuf = [];
            }
            if (nowReal - lastLog >= opts.logEverySec * 1000) {
                const elapsedSec = (nowReal - startedReal) / 1000;
                const virtualDays = (elapsedSec * opts.timeScale) / 86400;
                log(`  [${elapsedSec.toFixed(0)}s] 新订单 ${created.toLocaleString()} 单 ` +
                    `(${(created / elapsedSec).toFixed(2)} 单/真实秒) | ` +
                    `虚拟进度 +${virtualDays.toFixed(3)} 天 | 当前虚拟时间 ${clock_service_1.Clock.formatMs(virtualNowMs)}`);
                lastLog = nowReal;
            }
            if (!generateOrders) {
                await sleep(20);
            }
            if (opts.withChurn && nowReal - lastChurn >= 2000) {
                const lastChurnTs = lastChurn;
                lastChurn = nowReal;
                const virtualMsPassed = (nowReal - lastChurnTs) * opts.timeScale;
                await runChurnTick(conn, virtualNowMs, virtualMsPassed, rng, opts.profile, opts.churnOrderFilter ?? range_filter_1.EMPTY_RANGE, opts.churnProductFilter ?? range_filter_1.EMPTY_RANGE);
            }
        }
        if (orderBuf.length > 0) {
            await flushOrders(conn, orderBuf, itemBuf);
        }
        log(`\n=== replay 结束：新增 ${created.toLocaleString()} 订单 ===`);
    }
    finally {
        await conn.end().catch(() => undefined);
    }
}
function sleep(ms) {
    return new Promise((r) => setTimeout(r, ms));
}
async function readState(conn, profile) {
    const [o] = await conn.query('SELECT IFNULL(MAX(order_id),0) m FROM fact_order');
    const [i] = await conn.query('SELECT IFNULL(MAX(item_id),0) m FROM fact_order_item');
    const [u] = await conn.query('SELECT COUNT(*) c FROM dim_user');
    const [p] = await conn.query('SELECT COUNT(*) c FROM dim_product');
    const maxOrderId = Number(o[0].m);
    const maxItemId = Number(i[0].m);
    const userCount = Number(u[0].c);
    const productCount = Number(p[0].c);
    const priceArr = new Int32Array(productCount);
    const statusArr = new Uint8Array(productCount);
    const [rows] = await conn.query('SELECT product_id, price, status FROM dim_product ORDER BY product_id');
    for (const r of rows) {
        const idx = Number(r.product_id) - 1;
        if (idx >= 0 && idx < productCount) {
            priceArr[idx] = Math.round(Number(r.price) * 100);
            statusArr[idx] = Number(r.status);
        }
    }
    return { maxOrderId, maxItemId, userCount, productCount, priceArr, statusArr };
}
async function flushOrders(conn, orders, items) {
    if (orders.length > 0) {
        await conn.query(`INSERT INTO fact_order
         (order_id, user_id, order_status, item_count, total_amount, discount_amount,
          pay_time, shipping_time, complete_time, cancel_time, order_time, update_time,
          is_deleted, deleted_time)
       VALUES ?`, [orders]);
    }
    if (items.length > 0) {
        await conn.query(`INSERT INTO fact_order_item
         (item_id, order_id, product_id, quantity, unit_price, subtotal, discount_amount, create_time)
       VALUES ?`, [items]);
    }
}
async function runChurnTick(conn, virtualNowMs, virtualMsPassed, rng, _profile, orderFilter, productFilter) {
    const now = clock_service_1.Clock.formatMs(virtualNowMs);
    const virtualHours = virtualMsPassed / 3_600_000;
    const capPerTick = Math.max(1, Math.round((config_1.config.churn.maxPerSecond * virtualMsPassed) / 1000));
    const take = (perHour) => Math.min(Math.round(perHour * virtualHours), capPerTick);
    if (config_1.config.tasks.statusFlow.enabled) {
        const n = take(config_1.config.churn.statusFlowPerHour);
        if (n > 0)
            await optimisticTransitions(conn, rng, now, n, orderFilter);
    }
    if (config_1.config.tasks.canceler.enabled) {
        const n = take(config_1.config.churn.cancelPerHour);
        if (n > 0)
            await cancelSome(conn, rng, now, n, orderFilter);
    }
    if (config_1.config.tasks.priceAdjust.enabled) {
        const n = take(config_1.config.churn.priceAdjustPerHour);
        if (n > 0)
            await adjustPrices(conn, rng, now, n, productFilter);
    }
    if (config_1.config.tasks.cleaner.enabled) {
        const n = take(config_1.config.churn.cleanPerHour);
        if (n > 0)
            await softDeleteStale(conn, now, n, orderFilter);
    }
}
async function optimisticTransitions(conn, rng, now, batch, filter = range_filter_1.EMPTY_RANGE) {
    const [mx] = await conn.query('SELECT IFNULL(MAX(order_id),0) m FROM fact_order');
    const maxId = Number(mx[0].m);
    if (maxId === 0)
        return;
    const rows = [];
    if (!(0, range_filter_1.isEmpty)(filter)) {
        const params = [];
        const cond = (0, range_filter_1.buildSqlCondition)(filter, 'order_id', params);
        const [r] = await conn.query(`SELECT order_id, order_status FROM fact_order
       WHERE order_status IN ('CREATED','PAID','SHIPPED')${cond}
       ORDER BY order_id LIMIT ?`, [...params, batch]);
        rows.push(...r);
    }
    else {
        const probes = Math.max(1, Math.ceil(batch / 10));
        for (let p = 0; p < probes && rows.length < batch; p++) {
            const anchor = rng.int(1, maxId);
            const [r] = await conn.query(`SELECT order_id, order_status FROM fact_order
         WHERE order_id >= ? AND order_status IN ('CREATED','PAID','SHIPPED')
         ORDER BY order_id LIMIT 10`, [anchor]);
            rows.push(...r);
        }
    }
    for (const r of rows.slice(0, batch)) {
        const id = Number(r.order_id);
        const st = r.order_status;
        if (st === 'CREATED' && rng.bool(0.2)) {
            await conn.query(`UPDATE fact_order SET order_status='PAID', pay_time=?, update_time=?
         WHERE order_id=? AND order_status='CREATED'`, [now, now, id]);
        }
        else if (st === 'PAID' && rng.bool(0.15)) {
            await conn.query(`UPDATE fact_order SET order_status='SHIPPED', shipping_time=?, update_time=?
         WHERE order_id=? AND order_status='PAID'`, [now, now, id]);
        }
        else if (st === 'SHIPPED' && rng.bool(0.1)) {
            await conn.query(`UPDATE fact_order SET order_status='COMPLETED', complete_time=?, update_time=?
         WHERE order_id=? AND order_status='SHIPPED'`, [now, now, id]);
        }
    }
}
async function cancelSome(conn, rng, now, batch, filter = range_filter_1.EMPTY_RANGE) {
    const [mx] = await conn.query('SELECT IFNULL(MAX(order_id),0) m FROM fact_order');
    const maxId = Number(mx[0].m);
    if (maxId === 0)
        return;
    const rows = [];
    if (!(0, range_filter_1.isEmpty)(filter)) {
        const params = [];
        const cond = (0, range_filter_1.buildSqlCondition)(filter, 'order_id', params);
        const [r] = await conn.query(`SELECT order_id FROM fact_order
       WHERE order_status IN ('CREATED','PAID')${cond}
       ORDER BY order_id LIMIT ?`, [...params, batch]);
        rows.push(...r);
    }
    else {
        const probes = Math.max(1, Math.ceil(batch / 5));
        for (let p = 0; p < probes && rows.length < batch; p++) {
            const anchor = rng.int(1, maxId);
            const [r] = await conn.query(`SELECT order_id FROM fact_order
         WHERE order_id >= ? AND order_status IN ('CREATED','PAID')
         ORDER BY order_id LIMIT 5`, [anchor]);
            rows.push(...r);
        }
    }
    for (const r of rows.slice(0, batch)) {
        if (!rng.bool(config_1.config.tasks.canceler.cancelProb))
            continue;
        await conn.query(`UPDATE fact_order SET order_status='CANCELLED', cancel_time=?, update_time=?
       WHERE order_id=? AND order_status IN ('CREATED','PAID')`, [now, now, Number(r.order_id)]);
    }
}
async function adjustPrices(conn, rng, now, limit, filter = range_filter_1.EMPTY_RANGE) {
    const [mx] = await conn.query('SELECT IFNULL(MAX(product_id),0) m FROM dim_product');
    const maxId = Number(mx[0].m);
    if (maxId === 0)
        return;
    let pool = null;
    let cursor = 0;
    if (!(0, range_filter_1.isEmpty)(filter)) {
        const params = [];
        const cond = (0, range_filter_1.buildSqlCondition)(filter, 'product_id', params);
        const [r] = await conn.query(`SELECT product_id, price, stock, status FROM dim_product WHERE 1=1${cond} ORDER BY product_id`, params);
        pool = r;
        if (pool.length === 0)
            return;
    }
    for (let k = 0; k < limit; k++) {
        let row;
        if (pool) {
            row = pool[cursor % pool.length];
            cursor++;
        }
        else {
            const anchor = rng.int(1, maxId);
            const [r] = await conn.query('SELECT product_id, price, stock, status FROM dim_product WHERE product_id >= ? ORDER BY product_id LIMIT 1', [anchor]);
            row = r[0];
        }
        if (!row)
            continue;
        const pid = Number(row.product_id);
        if (Number(row.status) === 1 && rng.bool(0.015)) {
            await conn.query('UPDATE dim_product SET status=0, update_time=? WHERE product_id=?', [now, pid]);
            await conn.query(`INSERT INTO fact_product_price_change (product_id, old_price, new_price, change_type, change_time)
         VALUES (?, ?, ?, 'OFFSHELF', ?)`, [pid, row.price, row.price, now]);
            continue;
        }
        if (Number(row.status) !== 1)
            continue;
        const oldCents = Math.round(Number(row.price) * 100);
        const delta = Math.round(oldCents * (rng.float() * 0.2 - 0.1));
        const newCents = Math.max(100, oldCents + delta);
        const newStock = Math.max(0, Number(row.stock) + rng.int(-50, 80));
        await conn.query('UPDATE dim_product SET price=?, stock=?, update_time=? WHERE product_id=?', [(0, rng_1.fromCents)(newCents), newStock, now, pid]);
        await conn.query(`INSERT INTO fact_product_price_change (product_id, old_price, new_price, change_type, change_time)
       VALUES (?, ?, ?, 'ADJUST', ?)`, [pid, (0, rng_1.fromCents)(oldCents), (0, rng_1.fromCents)(newCents), now]);
    }
}
async function softDeleteStale(conn, now, limit, filter = range_filter_1.EMPTY_RANGE) {
    if (!config_1.config.tasks.cleaner.softDelete)
        return;
    const minutes = config_1.config.tasks.cleaner.cancelledOrderMinutes;
    const filterParams = [];
    const filterCond = (0, range_filter_1.buildSqlCondition)(filter, 'order_id', filterParams);
    await conn.query(`UPDATE fact_order
     SET is_deleted = 1, deleted_time = ?
     WHERE order_status = 'CANCELLED'
       AND is_deleted = 0
       AND update_time < DATE_SUB(?, INTERVAL ? MINUTE)${filterCond}
     LIMIT ?`, [now, now, minutes, ...filterParams, limit]);
}
//# sourceMappingURL=replay.js.map