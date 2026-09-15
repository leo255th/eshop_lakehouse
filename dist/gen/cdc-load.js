"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.runCdcReset = runCdcReset;
exports.runCdcLoad = runCdcLoad;
const promise_1 = __importDefault(require("mysql2/promise"));
const fs_1 = require("fs");
const path_1 = require("path");
const config_1 = require("../config");
const clock_service_1 = require("../clock/clock.service");
const TABLE = 'cdc_test';
function connBase(overrides = {}) {
    return {
        host: config_1.config.db.host,
        port: config_1.config.db.port,
        user: config_1.config.db.user,
        password: config_1.config.db.password,
        timezone: config_1.config.db.timezone,
        multipleStatements: true,
        ...overrides,
    };
}
function sleep(ms) {
    return new Promise((r) => setTimeout(r, Math.max(0, ms)));
}
function fmtDur(sec) {
    const s = Math.floor(sec);
    return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
}
async function ensureSchema(database) {
    const root = await promise_1.default.createConnection(connBase());
    try {
        await root.query(`CREATE DATABASE IF NOT EXISTS \`${database}\` ` +
            `DEFAULT CHARACTER SET utf8mb4 DEFAULT COLLATE utf8mb4_unicode_ci`);
    }
    finally {
        await root.end();
    }
    const sql = (0, fs_1.readFileSync)((0, path_1.join)(process.cwd(), 'sql', 'schema.sql'), 'utf8').replace(/__DB__/g, database);
    const statements = sql
        .split('\n')
        .filter((l) => !l.trim().startsWith('--'))
        .join('\n')
        .split(';')
        .map((s) => s.trim())
        .filter((s) => s.length > 0)
        .filter((s) => !/^CREATE\s+DATABASE/i.test(s));
    const conn = await promise_1.default.createConnection(connBase({ database }));
    try {
        for (const stmt of statements) {
            await conn.query(stmt);
        }
    }
    finally {
        await conn.end();
    }
}
async function tableStat(database) {
    const conn = await promise_1.default.createConnection(connBase({ database }));
    try {
        const [rows] = await conn.query(`SELECT COUNT(*) AS c, IFNULL(MAX(id), 0) AS m FROM ${TABLE}`);
        const r = rows[0];
        return { count: Number(r?.c ?? 0), maxId: Number(r?.m ?? 0) };
    }
    finally {
        await conn.end();
    }
}
async function runCdcReset(opts) {
    await ensureSchema(opts.database);
    const before = await tableStat(opts.database);
    const conn = await promise_1.default.createConnection(connBase({ database: opts.database }));
    try {
        await conn.query(`TRUNCATE TABLE ${TABLE}`);
    }
    finally {
        await conn.end();
    }
    const after = await tableStat(opts.database);
    console.log(`\n已清空 ${opts.database}.${TABLE}：${before.count} 行 → ${after.count} 行，` +
        `AUTO_INCREMENT 已重置。\n` +
        `接着可以启动 CDC 作业，然后执行 npm run cdc:load:1m -- --rate 500 --minutes 5\n`);
}
async function runCdcLoad(opts) {
    const { database, ratePerSecond, durationSec, clock } = opts;
    if (clock.isVirtual) {
        throw new Error('cdc:load 必须使用真实墙钟，但当前时钟是虚拟时钟（SIM_EPOCH 生效中）。\n' +
            '       请确认执行前没有 export SIM_EPOCH，或改用干净 shell 重跑。');
    }
    if (!(ratePerSecond > 0)) {
        throw new Error(`--rate 必须大于 0（收到 ${ratePerSecond}）`);
    }
    if (!(durationSec > 0)) {
        throw new Error(`--minutes 必须大于 0（收到 ${(durationSec / 60).toFixed(2)}）`);
    }
    const batchSize = Math.min(10_000, opts.batchSize ?? Math.max(1, Math.round(ratePerSecond / 10)));
    const intervalMs = (batchSize / ratePerSecond) * 1000;
    const logEverySec = opts.logEverySec ?? 5;
    await ensureSchema(database);
    const pre = await tableStat(database);
    const firstId = pre.maxId + 1;
    const conn = await promise_1.default.createConnection(connBase({ database }));
    try {
        console.log(`\nCDC 基准写入开始\n` +
            `  库表        : ${database}.${TABLE}\n` +
            `  目标速率    : ${ratePerSecond} 行/秒（批大小 ${batchSize}，间隔 ${intervalMs.toFixed(1)}ms）\n` +
            `  时长        : ${(durationSec / 60).toFixed(2)} 分钟（${durationSec}s）\n` +
            `  预计行数    : ${Math.round(ratePerSecond * durationSec)}\n` +
            `  起始 id     : ${firstId}（表内已有 ${pre.count} 行）\n` +
            `  开始时刻    : ${clock_service_1.Clock.formatMs(clock.nowMs())}\n`);
        const values = Array.from({ length: batchSize }, () => [null, null]);
        const t0 = clock.nowMs();
        const deadline = t0 + durationSec * 1000;
        let inserted = 0;
        let lastId = firstId - 1;
        let nextSlot = t0;
        let lastLog = t0;
        let maxBehindMs = 0;
        for (;;) {
            const now = clock.nowMs();
            if (now >= deadline)
                break;
            if (nextSlot > now) {
                await sleep(nextSlot - now);
                if (clock.nowMs() >= deadline)
                    break;
            }
            const nowMs = clock.nowMs();
            const nowSql = clock.toSql(new Date(nowMs));
            for (const row of values) {
                row[0] = nowMs;
                row[1] = nowSql;
            }
            const [res] = (await conn.query(`INSERT INTO ${TABLE} (create_time_ms, create_time) VALUES ?`, [values]));
            const affected = res.affectedRows || batchSize;
            inserted += affected;
            lastId = (res.insertId || 0) + affected - 1;
            const after = clock.nowMs();
            const behind = after - nextSlot;
            if (behind > maxBehindMs)
                maxBehindMs = behind;
            nextSlot += intervalMs;
            if (after - nextSlot > 10 * intervalMs)
                nextSlot = after;
            if (after - lastLog >= logEverySec * 1000) {
                lastLog = after;
                const el = (after - t0) / 1000;
                console.log(`  [${fmtDur(el)}/${fmtDur(durationSec)}] 已写 ${inserted} 行 | ` +
                    `实际 ${(inserted / el).toFixed(1)} 行/秒 | id ${firstId}~${lastId}`);
            }
        }
        const t1 = clock.nowMs();
        const wallSec = (t1 - t0) / 1000;
        const actualRate = inserted / Math.max(0.001, wallSec);
        const result = {
            database,
            rowsInserted: inserted,
            firstId,
            lastId,
            targetRate: ratePerSecond,
            actualRate,
            wallSec,
            batchSize,
            startedAt: clock_service_1.Clock.formatMs(t0),
            endedAt: clock_service_1.Clock.formatMs(t1),
            maxBehindMs,
        };
        const deviation = Math.abs(actualRate - ratePerSecond) / ratePerSecond;
        console.log(`\nCDC 基准写入结束\n` +
            `  实际写入    : ${inserted} 行 / ${wallSec.toFixed(1)}s\n` +
            `  实际速率    : ${actualRate.toFixed(1)} 行/秒（目标 ${ratePerSecond}，偏差 ${(deviation * 100).toFixed(2)}%）\n` +
            `  调度最大落后: ${maxBehindMs.toFixed(0)}ms\n` +
            `  写入窗口    : ${result.startedAt} ~ ${result.endedAt}\n` +
            `  ★ id 区间   : ${firstId} ~ ${lastId}   ← 记下来，分析 SQL 用它区分本次 run\n`);
        if (deviation > 0.05) {
            console.warn(`  [warn] 实际速率与目标偏差 ${(deviation * 100).toFixed(1)}% > 5%。\n` +
                `         说明本机/MySQL 写不到这个速率，此时吞吐指标测的是客户端上限，\n` +
                `         不是 CDC 链路能力。请调低 --rate 后重跑。\n`);
        }
        return result;
    }
    finally {
        await conn.end();
    }
}
//# sourceMappingURL=cdc-load.js.map