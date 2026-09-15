"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.runChangelog = runChangelog;
const promise_1 = __importDefault(require("mysql2/promise"));
const config_1 = require("../config");
const clock_service_1 = require("../clock/clock.service");
const rng_1 = require("./rng");
const seed_data_1 = require("../sim/seed-data");
const range_filter_1 = require("./range-filter");
const HOUR_MS = 3_600_000;
async function runChangelog(opts) {
    const mode = opts.replayMode ?? 'stream';
    if (mode === 'batch') {
        return runBatchReplay(opts);
    }
    const db = opts.profile.database;
    const log = (m) => console.log(m);
    log(`=== Changelog 生成（changelog / stream 模式）===`);
    log(`  目标库      : ${db}`);
    log(`  起始虚拟时间: ${clock_service_1.Clock.formatMs(opts.startMs)}`);
    log(`  商品数      : ${opts.profile.products.toLocaleString()}`);
    log(`  价格变更/商品: ${opts.priceChangesPerProduct}`);
    log(`  变更内容    : price ±10% / status 下架 / category / brand`);
    log(`  发出速率    : ${opts.ratePerSecond} 条 UPDATE/秒`);
    if (opts.maxTotalChanges > 0) {
        log(`  总变更上限  : ${opts.maxTotalChanges.toLocaleString()} 条`);
    }
    log('');
    log(`  ⓘ 请确认此时 Flink CDC 作业已在运行（scan.startup.mode=initial）`);
    log(`    本模式产生的是真实 UPDATE，会在 binlog 中形成 -U/+U 事件对`);
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
        dateStrings: true,
    });
    await conn.query('SET SESSION sql_mode = ""');
    try {
        const [cntRows] = await conn.query('SELECT COUNT(*) c FROM fact_product_price_change');
        const planCount = Number(cntRows[0].c);
        if (planCount === 0) {
            log(`❌ fact_product_price_change 为空 —— 无法重建变更时间表。\n` +
                `   请先用 bulk 模式生成数据集，且 --price-changes>0。`);
            return;
        }
        log(`变更时间表来源：fact_product_price_change（${planCount.toLocaleString()} 条历史记录）`);
        log(`   → 这些是"已有价格历史"，本模式把它们**按时间顺序重新发一遍真实 UPDATE**，\n` +
            `     让 binlog 产生 -U/+U 事件，供 Flink CDC 构建 SCD2。\n`);
        const [minMax] = await conn.query('SELECT MIN(change_time) mn, MAX(change_time) mx FROM fact_product_price_change');
        const mnStr = minMax[0].mn;
        const mxStr = minMax[0].mx;
        if (!mnStr || !mxStr) {
            log('❌ 无法确定变更时间范围');
            return;
        }
        const minMs = Date.parse(mnStr.replace(' ', 'T') + '+08:00');
        const maxMs = Date.parse(mxStr.replace(' ', 'T') + '+08:00');
        log(`变更时间范围：${mnStr} ~ ${mxStr}（跨度 ${((maxMs - minMs) / 86400000).toFixed(1)} 天）\n`);
        const startedReal = Date.now();
        const rng = new rng_1.Rng(opts.seed + 4242);
        const total = opts.maxTotalChanges > 0 ? opts.maxTotalChanges : planCount;
        let emitted = 0;
        let priceUpdates = 0;
        let statusUpdates = 0;
        let categoryUpdates = 0;
        let brandUpdates = 0;
        let skipped = 0;
        let lastLog = startedReal;
        const spanMs = Math.max(1, maxMs - minMs);
        const virtualStepMs = spanMs / total;
        let cursorMs = minMs;
        while (emitted < total) {
            const nowReal = Date.now();
            if (opts.maxRuntimeSec > 0 &&
                (nowReal - startedReal) / 1000 >= opts.maxRuntimeSec) {
                log(`\n达到运行时长上限 ${opts.maxRuntimeSec}s，停止。`);
                break;
            }
            const elapsedSec = (nowReal - startedReal) / 1000;
            const targetByNow = Math.floor(elapsedSec * opts.ratePerSecond);
            if (emitted >= targetByNow) {
                await sleep(Math.max(5, Math.min(50, 1000 / Math.max(opts.ratePerSecond, 1))));
                continue;
            }
            const batchEnd = Math.min(maxMs, cursorMs + virtualStepMs * Math.min(opts.ratePerSecond, 200));
            const virtualNowMs = cursorMs;
            const [rows] = await conn.query(`SELECT product_id, old_price, new_price, change_time
           FROM fact_product_price_change
          WHERE change_time >= ? AND change_time < ?
          ORDER BY change_time
          LIMIT 500`, [clock_service_1.Clock.formatMs(cursorMs), clock_service_1.Clock.formatMs(batchEnd)]);
            const changes = rows;
            if (changes.length === 0) {
                cursorMs = batchEnd;
                if (cursorMs >= maxMs) {
                    cursorMs = minMs;
                }
                continue;
            }
            for (const ch of changes) {
                if (emitted >= total)
                    break;
                const pid = Number(ch.product_id);
                const changeTimeSql = toSqlDatetime(ch.change_time);
                const res = await conn.query(`UPDATE dim_product SET price = ?, update_time = ?
            WHERE product_id = ? AND price <> ?`, [ch.new_price, changeTimeSql, pid, ch.new_price]);
                const affected = res[0].affectedRows ?? 0;
                if (affected > 0)
                    priceUpdates++;
                else
                    skipped++;
                if (rng.bool(opts.offShelfProb)) {
                    const r2 = await conn.query(`UPDATE dim_product SET status = 0, update_time = ?
              WHERE product_id = ? AND status = 1`, [changeTimeSql, pid]);
                    if ((r2[0].affectedRows ?? 0) > 0) {
                        statusUpdates++;
                    }
                }
                if (rng.bool(opts.categoryChangeProb)) {
                    const newCat = rng.pick(seed_data_1.CATEGORIES).name;
                    const r3 = await conn.query(`UPDATE dim_product SET category = ?, update_time = ?
              WHERE product_id = ? AND category <> ?`, [newCat, changeTimeSql, pid, newCat]);
                    if ((r3[0].affectedRows ?? 0) > 0) {
                        categoryUpdates++;
                    }
                }
                if (rng.bool(opts.brandChangeProb)) {
                    const cat = rng.pick(seed_data_1.CATEGORIES);
                    const newBrand = rng.pick(cat.brands);
                    const r4 = await conn.query(`UPDATE dim_product SET brand = ?, update_time = ?
              WHERE product_id = ? AND brand <> ?`, [newBrand, changeTimeSql, pid, newBrand]);
                    if ((r4[0].affectedRows ?? 0) > 0) {
                        brandUpdates++;
                    }
                }
                emitted++;
            }
            cursorMs = batchEnd;
            if (cursorMs >= maxMs)
                cursorMs = minMs;
            if (nowReal - lastLog >= opts.logEverySec * 1000) {
                const pct = ((emitted / total) * 100).toFixed(1);
                log(`  [${((nowReal - startedReal) / 1000).toFixed(0)}s] ${emitted.toLocaleString()}/${total.toLocaleString()} (${pct}%) | ` +
                    `实际速率 ${(emitted / ((nowReal - startedReal) / 1000)).toFixed(1)} 条/秒 | ` +
                    `price=${priceUpdates.toLocaleString()} status=${statusUpdates} cat=${categoryUpdates} brand=${brandUpdates}`);
                lastLog = nowReal;
            }
        }
        const elapsed = (Date.now() - startedReal) / 1000;
        log(`\n=== changelog 生成完成 ===`);
        log(`  发出变更        : ${emitted.toLocaleString()} 条`);
        log(`  价格 UPDATE     : ${priceUpdates.toLocaleString()} 条（binlog 中的 -U/+U 事件对）`);
        log(`  状态(下架)      : ${statusUpdates.toLocaleString()} 条`);
        log(`  品类变更        : ${categoryUpdates.toLocaleString()} 条`);
        log(`  品牌变更        : ${brandUpdates.toLocaleString()} 条`);
        log(`  跳过(值未变)    : ${skipped.toLocaleString()} 条`);
        log(`  总耗时          : ${elapsed.toFixed(0)}s（${(emitted / elapsed).toFixed(1)} 条/秒）`);
        log('');
        log(`  下一步：在 Flink 里用 ODS 主键表 + changelog-producer 构建 SCD2：`);
        log(`    1) ODS 表设 'changelog-producer' = 'input'（或 'lookup'）`);
        log(`       并用 input 模式读取，才能拿到 -U/+U 事件对`);
        log(`    2) DWD 侧按主键时间序做拉链（对比属性值，值未变则不开新版本）`);
        log(`    3) 可用 fact_order_item.unit_price 做价格快照的交叉验证`);
    }
    finally {
        await conn.end().catch(() => undefined);
    }
}
function sleep(ms) {
    return new Promise((r) => setTimeout(r, ms));
}
function toSqlDatetime(v) {
    if (typeof v === 'string')
        return v;
    if (v instanceof Date)
        return clock_service_1.Clock.format(v, config_1.config.db.timezone);
    return String(v);
}
async function runBatchReplay(opts) {
    const db = opts.profile.database;
    const log = (m) => console.log(m);
    const chunkSize = opts.batchChunk && opts.batchChunk > 0 ? opts.batchChunk : 500;
    const dropFinal = opts.dropFinalRecords !== false;
    const productFilter = opts.productFilter ?? range_filter_1.EMPTY_RANGE;
    log(`=== Changelog 生成（changelog / ★batch 模式）===`);
    log(`  目标库      : ${db}`);
    log(`  批次大小    : ${chunkSize} 条变更/语句`);
    log(`  商品范围    : ${(0, range_filter_1.describe)(productFilter)}`);
    log(`  删除 FINAL  : ${dropFinal ? '是（FINAL 是 bulk 补记的伪记录，非真实变更）' : '否'}`);
    log('');
    log(`  作用：把历史价格变更按时间顺序重放为真实 UPDATE，`);
    log(`        每行带自己的 change_time 作为 update_time，`);
    log(`        使 binlog 中的 -U/+U 序列时间戳正确 → SCD2 时间线正确。`);
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
        dateStrings: true,
    });
    await conn.query('SET SESSION sql_mode = ""');
    try {
        const cntParams = [];
        const cntConds = [];
        if (dropFinal)
            cntConds.push("change_type <> 'FINAL'");
        const cntRange = (0, range_filter_1.buildSqlCondition)(productFilter, 'product_id', cntParams);
        if (cntRange)
            cntConds.push(cntRange.replace(/^ AND /, ''));
        const [cntRows] = await conn.query(`SELECT COUNT(*) c FROM fact_product_price_change` +
            (cntConds.length ? ` WHERE ${cntConds.join(' AND ')}` : ''), cntParams);
        const total = Number(cntRows[0].c);
        if (total === 0) {
            log('❌ 没有可重放的变更记录。请先用 bulk 模式生成数据集。');
            return;
        }
        log(`待重放变更：${total.toLocaleString()} 条`);
        const startedReal = Date.now();
        let processed = 0;
        let updatedRows = 0;
        let noopRows = 0;
        let lastLog = startedReal;
        let lastTime = '';
        let lastId = 0;
        for (;;) {
            const conds = [];
            const params = [];
            if (dropFinal)
                conds.push("change_type <> 'FINAL'");
            if (lastTime) {
                conds.push('(change_time > ? OR (change_time = ? AND change_id > ?))');
                params.push(lastTime, lastTime, lastId);
            }
            const rangeCond = (0, range_filter_1.buildSqlCondition)(productFilter, 'product_id', params);
            if (rangeCond)
                conds.push(rangeCond.replace(/^ AND /, '').replace(/^/, '').slice(0));
            params.push(chunkSize);
            const [rows] = await conn.query(`SELECT change_id, product_id, new_price, change_time
           FROM fact_product_price_change
          ${conds.length ? 'WHERE ' + conds.join(' AND ') : ''}
          ORDER BY change_time, change_id
          LIMIT ?`, params);
            const changes = rows;
            if (changes.length === 0)
                break;
            const priceCase = [];
            const timeCase = [];
            const ids = [];
            const lastByProduct = new Map();
            for (const ch of changes) {
                const pid = Number(ch.product_id);
                const t = toSqlDatetime(ch.change_time);
                lastByProduct.set(pid, { price: String(ch.new_price), time: t });
            }
            const tail = changes[changes.length - 1];
            lastTime = toSqlDatetime(tail.change_time);
            lastId = Number(tail.change_id);
            for (const [pid, v] of lastByProduct) {
                ids.push(pid);
                priceCase.push(`WHEN ${pid} THEN ${Number(v.price).toFixed(2)}`);
                timeCase.push(`WHEN ${pid} THEN '${v.time}'`);
            }
            if (ids.length === 0) {
                processed += changes.length;
                continue;
            }
            const [res] = await conn.query(`UPDATE dim_product
            SET price = CASE product_id ${priceCase.join(' ')} END,
                update_time = CASE product_id ${timeCase.join(' ')} END
          WHERE product_id IN (${ids.join(',')})
            AND price <> CASE product_id ${priceCase.join(' ')} END`);
            const affected = res.affectedRows ?? 0;
            updatedRows += affected;
            noopRows += ids.length - affected;
            processed += changes.length;
            const nowReal = Date.now();
            if (nowReal - lastLog >= opts.logEverySec * 1000) {
                const pct = ((processed / total) * 100).toFixed(1);
                log(`  [${((nowReal - startedReal) / 1000).toFixed(0)}s] ${processed.toLocaleString()}/${total.toLocaleString()} (${pct}%) | ` +
                    `已更新时间戳 ${updatedRows.toLocaleString()} 行 | 值未变跳过 ${noopRows.toLocaleString()} 行`);
                lastLog = nowReal;
            }
        }
        const elapsed = (Date.now() - startedReal) / 1000;
        log('');
        log(`=== batch 重放完成 ===`);
        log(`  处理变更        : ${processed.toLocaleString()} 条`);
        if (processed !== total) {
            log(`  ❌ 不一致：应处理 ${total.toLocaleString()} 条，实际只处理 ${processed.toLocaleString()} 条` +
                `（缺 ${(total - processed).toLocaleString()} 条）—— 分页游标有问题，请勿继续使用该数据集！`);
        }
        else {
            log(`  ✅ 完整性校验：分页覆盖全部 ${total.toLocaleString()} 条待处理变更`);
        }
        log(`  实际 UPDATE 行数: ${updatedRows.toLocaleString()} 行（binlog 中的 -U/+U 事件对）`);
        log(`  值未变跳过      : ${noopRows.toLocaleString()} 行（不产生伪版本）`);
        log(`  总耗时          : ${elapsed.toFixed(1)}s`);
        log('');
        if (dropFinal) {
            const [r] = await conn.query("DELETE FROM fact_product_price_change WHERE change_type = 'FINAL'");
            const del = r.affectedRows ?? 0;
            log(`已清理 FINAL 伪记录：${del.toLocaleString()} 条`);
            log(`  （FINAL 是 bulk 为了让流水表"版本闭合"补记的，不是真实业务变更；
` +
                `    删掉后 fact_product_price_change 就是一份干净的变更流水）`);
            log('');
        }
        const [check] = await conn.query(`SELECT COUNT(*) c FROM (
         SELECT product_id, change_time,
                LAG(change_time) OVER (PARTITION BY product_id ORDER BY change_time) AS prev_t
         FROM fact_product_price_change
       ) t WHERE prev_t IS NOT NULL AND change_time <= prev_t`);
        const bad = Number(check[0].c);
        log(`时间戳递增性校验：逆序 ${bad} 条 ${bad === 0 ? '✅' : '❌'}`);
        const [stat] = await conn.query(`SELECT COUNT(*) total,
              COUNT(DISTINCT product_id) prods,
              MIN(change_time) mn, MAX(change_time) mx
         FROM fact_product_price_change`);
        const st = stat[0];
        log(`变更流水现状：${Number(st.total).toLocaleString()} 条 / ${Number(st.prods).toLocaleString()} 个商品 / ` +
            `${st.mn} ~ ${st.mx}`);
        log('');
        log(`  下一步：此时 binlog 中已有一条**时间戳正确**的商品变更序列。`);
        log(`    · 用 earliest 启动 CDC → 会重放这段历史，ODS 得到完整 changelog`);
        log(`    · 用 initial  启动 CDC → 快照拿最终状态，之后的变更才是增量`);
        log(`    两种方式下，DWD 用 ODS 的 input changelog 构建 SCD2，时间线都正确。`);
    }
    finally {
        await conn.end().catch(() => undefined);
    }
}
//# sourceMappingURL=changelog.js.map