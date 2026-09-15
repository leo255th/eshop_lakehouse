"use strict";
var __decorate = (this && this.__decorate) || function (decorators, target, key, desc) {
    var c = arguments.length, r = c < 3 ? target : desc === null ? desc = Object.getOwnPropertyDescriptor(target, key) : desc, d;
    if (typeof Reflect === "object" && typeof Reflect.decorate === "function") r = Reflect.decorate(decorators, target, key, desc);
    else for (var i = decorators.length - 1; i >= 0; i--) if (d = decorators[i]) r = (c < 3 ? d(r) : c > 3 ? d(target, key, r) : d(target, key)) || r;
    return c > 3 && r && Object.defineProperty(target, key, r), r;
};
var __metadata = (this && this.__metadata) || function (k, v) {
    if (typeof Reflect === "object" && typeof Reflect.metadata === "function") return Reflect.metadata(k, v);
};
var CancelerService_1;
Object.defineProperty(exports, "__esModule", { value: true });
exports.CancelerService = void 0;
const common_1 = require("@nestjs/common");
const config_1 = require("../config");
const database_service_1 = require("../db/database.service");
const stats_service_1 = require("./stats.service");
const task_base_1 = require("./task.base");
const util_1 = require("./util");
let CancelerService = CancelerService_1 = class CancelerService extends task_base_1.LoopedTask {
    db;
    stats;
    logger = new common_1.Logger(CancelerService_1.name);
    maxOrderId = 0;
    lastBoundsRefresh = 0;
    constructor(db, stats) {
        super();
        this.db = db;
        this.stats = stats;
    }
    get clock() {
        return this.db.clock;
    }
    async sampleCancellable(needed) {
        if (this.maxOrderId === 0 || Date.now() - this.lastBoundsRefresh > 300_000) {
            const rows = await this.db.query('SELECT IFNULL(MAX(order_id),0) AS m FROM fact_order');
            this.maxOrderId = Number(rows[0]?.m ?? 0);
            this.lastBoundsRefresh = Date.now();
        }
        if (this.maxOrderId === 0)
            return [];
        const probeSize = 5;
        const probes = Math.max(1, Math.ceil(needed / probeSize));
        const out = [];
        for (let i = 0; i < probes && out.length < needed; i++) {
            const anchor = (0, util_1.randInt)(1, this.maxOrderId);
            const rows = await this.db.query(`SELECT order_id FROM fact_order
         WHERE order_id >= ?
           AND order_status IN ('CREATED','PAID')
           AND is_deleted = 0
         ORDER BY order_id
         LIMIT ${probeSize}`, [anchor]);
            out.push(...rows);
        }
        return out.slice(0, needed);
    }
    async tick() {
        const batch = config_1.config.tasks.canceler.batch;
        const prob = config_1.config.tasks.canceler.cancelProb;
        const rows = await this.sampleCancellable(batch);
        if (rows.length === 0)
            return;
        const nowSql = this.clock.toSql();
        let cancelled = 0;
        for (const r of rows) {
            if (!(0, util_1.chance)(prob))
                continue;
            const res = await this.db.execute(`UPDATE fact_order
         SET order_status = 'CANCELLED', cancel_time = ?, update_time = ?
         WHERE order_id = ? AND order_status IN ('CREATED','PAID')`, [nowSql, nowSql, Number(r.order_id)]);
            if (res.affectedRows === 1)
                cancelled++;
        }
        if (cancelled > 0) {
            this.stats.counters.ordersCancelled += cancelled;
            this.logger.log(`cancelled ${cancelled} orders, total=${this.stats.counters.ordersCancelled}`);
        }
    }
};
exports.CancelerService = CancelerService;
exports.CancelerService = CancelerService = CancelerService_1 = __decorate([
    (0, common_1.Injectable)(),
    __metadata("design:paramtypes", [database_service_1.DatabaseService,
        stats_service_1.StatsService])
], CancelerService);
//# sourceMappingURL=canceler.service.js.map