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
var DeletionCleanerService_1;
Object.defineProperty(exports, "__esModule", { value: true });
exports.DeletionCleanerService = void 0;
const common_1 = require("@nestjs/common");
const config_1 = require("../config");
const database_service_1 = require("../db/database.service");
const stats_service_1 = require("./stats.service");
const task_base_1 = require("./task.base");
let DeletionCleanerService = DeletionCleanerService_1 = class DeletionCleanerService extends task_base_1.LoopedTask {
    db;
    stats;
    logger = new common_1.Logger(DeletionCleanerService_1.name);
    constructor(db, stats) {
        super();
        this.db = db;
        this.stats = stats;
    }
    get clock() {
        return this.db.clock;
    }
    async tick() {
        await this.cleanCancelledOrders();
        await this.cleanDeactivatedUsers();
        await this.cleanOffShelfProducts();
    }
    async cleanCancelledOrders() {
        const minutes = config_1.config.tasks.cleaner.cancelledOrderMinutes;
        const limit = config_1.config.tasks.cleaner.maxBatch;
        const nowSql = this.clock.toSql();
        const rows = await this.db.query(`SELECT order_id FROM fact_order
       WHERE order_status = 'CANCELLED'
         AND is_deleted = 0
         AND update_time < DATE_SUB(?, INTERVAL ? MINUTE)
       ORDER BY update_time
       LIMIT ?`, [nowSql, minutes, limit]);
        if (rows.length === 0)
            return;
        const orderIds = rows.map((r) => Number(r.order_id));
        if (config_1.config.tasks.cleaner.softDelete) {
            const res = await this.db.run(`UPDATE fact_order SET is_deleted = 1, deleted_time = ?
         WHERE order_id IN (?)`, [nowSql, orderIds]);
            if (res.affectedRows > 0) {
                this.stats.counters.ordersDeleted += res.affectedRows;
                this.logger.log(`soft-deleted ${res.affectedRows} stale CANCELLED orders ` +
                    `(is_deleted=1, 历史指标口径不受影响)`);
            }
            return;
        }
        await this.db.transaction(async (conn) => {
            const [itemRes] = await conn.query('DELETE FROM fact_order_item WHERE order_id IN (?)', [orderIds]);
            const [orderRes] = await conn.query('DELETE FROM fact_order WHERE order_id IN (?)', [orderIds]);
            this.stats.counters.itemsDeleted +=
                itemRes.affectedRows ?? 0;
            this.stats.counters.ordersDeleted +=
                orderRes.affectedRows ?? 0;
        });
        this.logger.warn(`hard-deleted ${orderIds.length} CANCELLED orders ` +
            `(items ${this.stats.counters.itemsDeleted}, orders ${this.stats.counters.ordersDeleted}) ` +
            `-> CDC should emit -D events`);
    }
    async cleanDeactivatedUsers() {
        const minutes = config_1.config.tasks.cleaner.userMinutes;
        const limit = config_1.config.tasks.cleaner.maxBatch;
        const nowSql = this.clock.toSql();
        const rows = await this.db.query(`SELECT user_id FROM dim_user
       WHERE status = 0
         AND is_deleted = 0
         AND update_time < DATE_SUB(?, INTERVAL ? MINUTE)
       ORDER BY update_time
       LIMIT ?`, [nowSql, minutes, limit]);
        if (rows.length === 0)
            return;
        const ids = rows.map((r) => Number(r.user_id));
        if (config_1.config.tasks.cleaner.softDelete) {
            const res = await this.db.run(`UPDATE dim_user SET is_deleted = 1, deleted_time = ? WHERE user_id IN (?)`, [nowSql, ids]);
            if (res.affectedRows > 0) {
                this.stats.counters.usersDeleted += res.affectedRows;
                this.logger.log(`soft-deleted ${res.affectedRows} deactivated users`);
            }
            return;
        }
        const res = await this.db.run('DELETE FROM dim_user WHERE user_id IN (?)', [
            ids,
        ]);
        if (res.affectedRows > 0) {
            this.stats.counters.usersDeleted += res.affectedRows;
            this.logger.warn(`hard-deleted ${res.affectedRows} deactivated users -> CDC -D`);
        }
    }
    async cleanOffShelfProducts() {
        const minutes = config_1.config.tasks.cleaner.productMinutes;
        const limit = config_1.config.tasks.cleaner.maxBatch;
        const nowSql = this.clock.toSql();
        const rows = await this.db.query(`SELECT product_id FROM dim_product
       WHERE status = 0
         AND is_deleted = 0
         AND update_time < DATE_SUB(?, INTERVAL ? MINUTE)
       ORDER BY update_time
       LIMIT ?`, [nowSql, minutes, limit]);
        if (rows.length === 0)
            return;
        const ids = rows.map((r) => Number(r.product_id));
        if (config_1.config.tasks.cleaner.softDelete) {
            const res = await this.db.run(`UPDATE dim_product SET is_deleted = 1, deleted_time = ? WHERE product_id IN (?)`, [nowSql, ids]);
            if (res.affectedRows > 0) {
                this.stats.counters.productsDeleted += res.affectedRows;
                this.logger.log(`soft-deleted ${res.affectedRows} off-shelf products`);
            }
            return;
        }
        const res = await this.db.run('DELETE FROM dim_product WHERE product_id IN (?)', [ids]);
        if (res.affectedRows > 0) {
            this.stats.counters.productsDeleted += res.affectedRows;
            this.logger.warn(`hard-deleted ${res.affectedRows} off-shelf products -> CDC -D`);
        }
    }
};
exports.DeletionCleanerService = DeletionCleanerService;
exports.DeletionCleanerService = DeletionCleanerService = DeletionCleanerService_1 = __decorate([
    (0, common_1.Injectable)(),
    __metadata("design:paramtypes", [database_service_1.DatabaseService,
        stats_service_1.StatsService])
], DeletionCleanerService);
//# sourceMappingURL=deletion-cleaner.service.js.map