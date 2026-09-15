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
var StatusFlowService_1;
Object.defineProperty(exports, "__esModule", { value: true });
exports.StatusFlowService = void 0;
const common_1 = require("@nestjs/common");
const config_1 = require("../config");
const database_service_1 = require("../db/database.service");
const stats_service_1 = require("./stats.service");
const task_base_1 = require("./task.base");
const util_1 = require("./util");
let StatusFlowService = StatusFlowService_1 = class StatusFlowService extends task_base_1.LoopedTask {
    db;
    stats;
    logger = new common_1.Logger(StatusFlowService_1.name);
    totalChanged = 0;
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
    async sampleOrders(statuses, needed) {
        if (this.maxOrderId === 0 || Date.now() - this.lastBoundsRefresh > 300_000) {
            const rows = await this.db.query('SELECT IFNULL(MAX(order_id),0) AS m FROM fact_order');
            this.maxOrderId = Number(rows[0]?.m ?? 0);
            this.lastBoundsRefresh = Date.now();
        }
        if (this.maxOrderId === 0)
            return [];
        const probeSize = 10;
        const probes = Math.max(1, Math.ceil(needed / probeSize));
        const out = [];
        for (let i = 0; i < probes && out.length < needed; i++) {
            const anchor = (0, util_1.randInt)(1, this.maxOrderId);
            const rows = await this.db.query(`SELECT order_id, order_status FROM fact_order
         WHERE order_id >= ?
           AND order_status IN (${statuses})
           AND is_deleted = 0
         ORDER BY order_id
         LIMIT ${probeSize}`, [anchor]);
            out.push(...rows);
        }
        return out.slice(0, needed);
    }
    async tick() {
        const batch = config_1.config.tasks.statusFlow.batch;
        const rows = await this.sampleOrders(`'CREATED','PAID','SHIPPED'`, batch);
        if (rows.length === 0)
            return;
        const nowSql = this.clock.toSql();
        let changed = 0;
        for (const r of rows) {
            const orderId = Number(r.order_id);
            const status = r.order_status;
            if (status === 'CREATED' && (0, util_1.chance)(0.2)) {
                const res = await this.db.execute(`UPDATE fact_order
           SET order_status = 'PAID', pay_time = ?, update_time = ?
           WHERE order_id = ? AND order_status = 'CREATED'`, [nowSql, nowSql, orderId]);
                if (res.affectedRows === 1)
                    changed++;
            }
            else if (status === 'PAID' && (0, util_1.chance)(0.15)) {
                const res = await this.db.execute(`UPDATE fact_order
           SET order_status = 'SHIPPED', shipping_time = ?, update_time = ?
           WHERE order_id = ? AND order_status = 'PAID'`, [nowSql, nowSql, orderId]);
                if (res.affectedRows === 1)
                    changed++;
            }
            else if (status === 'SHIPPED' && (0, util_1.chance)(0.1)) {
                const res = await this.db.execute(`UPDATE fact_order
           SET order_status = 'COMPLETED', complete_time = ?, update_time = ?
           WHERE order_id = ? AND order_status = 'SHIPPED'`, [nowSql, nowSql, orderId]);
                if (res.affectedRows === 1)
                    changed++;
            }
        }
        if (changed > 0) {
            this.stats.counters.ordersStatusChanged += changed;
            this.totalChanged += changed;
            if (this.totalChanged % 10 < changed) {
                this.logger.log(`status flow: +${changed} this tick, total=${this.stats.counters.ordersStatusChanged}`);
            }
        }
    }
};
exports.StatusFlowService = StatusFlowService;
exports.StatusFlowService = StatusFlowService = StatusFlowService_1 = __decorate([
    (0, common_1.Injectable)(),
    __metadata("design:paramtypes", [database_service_1.DatabaseService,
        stats_service_1.StatsService])
], StatusFlowService);
//# sourceMappingURL=status-flow.service.js.map