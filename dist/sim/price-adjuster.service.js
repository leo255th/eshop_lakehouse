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
var PriceAdjusterService_1;
Object.defineProperty(exports, "__esModule", { value: true });
exports.PriceAdjusterService = void 0;
const common_1 = require("@nestjs/common");
const config_1 = require("../config");
const database_service_1 = require("../db/database.service");
const stats_service_1 = require("./stats.service");
const task_base_1 = require("./task.base");
const util_1 = require("./util");
let PriceAdjusterService = PriceAdjusterService_1 = class PriceAdjusterService extends task_base_1.LoopedTask {
    db;
    stats;
    logger = new common_1.Logger(PriceAdjusterService_1.name);
    maxProductId = 0;
    lastBoundsRefresh = 0;
    constructor(db, stats) {
        super();
        this.db = db;
        this.stats = stats;
    }
    get clock() {
        return this.db.clock;
    }
    async sampleProducts(needed) {
        if (this.maxProductId === 0 || Date.now() - this.lastBoundsRefresh > 300_000) {
            const rows = await this.db.query('SELECT IFNULL(MAX(product_id),0) AS m FROM dim_product');
            this.maxProductId = Number(rows[0]?.m ?? 0);
            this.lastBoundsRefresh = Date.now();
        }
        if (this.maxProductId === 0)
            return [];
        const out = [];
        for (let i = 0; i < needed; i++) {
            const anchor = (0, util_1.randInt)(1, this.maxProductId);
            const rows = await this.db.query(`SELECT product_id, price, stock, status FROM dim_product
         WHERE product_id >= ? AND is_deleted = 0
         ORDER BY product_id LIMIT 1`, [anchor]);
            if (rows[0])
                out.push(rows[0]);
        }
        return out;
    }
    async tick() {
        const { minBatch, maxBatch } = config_1.config.tasks.priceAdjust;
        const limit = (0, util_1.randInt)(minBatch, maxBatch);
        const rows = await this.sampleProducts(limit);
        if (rows.length === 0)
            return;
        const nowSql = this.clock.toSql();
        let adjusted = 0;
        let deactivated = 0;
        for (const r of rows) {
            const pid = Number(r.product_id);
            const status = Number(r.status);
            if (status === 1 && (0, util_1.chance)(0.015)) {
                const res = await this.db.execute('UPDATE dim_product SET status = 0, update_time = ? WHERE product_id = ? AND status = 1', [nowSql, pid]);
                if (res.affectedRows === 1) {
                    deactivated++;
                    await this.db.run(`INSERT INTO fact_product_price_change
               (product_id, old_price, new_price, change_type, change_time)
             VALUES (?, ?, ?, 'OFFSHELF', ?)`, [pid, r.price, r.price, nowSql]);
                    this.logger.log(`product ${pid} deactivated (下架)`);
                }
                continue;
            }
            if (status !== 1)
                continue;
            const priceCents = Math.round(Number(r.price) * 100);
            const delta = Math.round(priceCents * (Math.random() * 0.2 - 0.1));
            const newPriceCents = Math.max(100, priceCents + delta);
            const newStock = Math.max(0, Number(r.stock) + (0, util_1.randInt)(-50, 80));
            const res = await this.db.execute('UPDATE dim_product SET price = ?, stock = ?, update_time = ? WHERE product_id = ?', [(newPriceCents / 100).toFixed(2), newStock, nowSql, pid]);
            if (res.affectedRows === 1) {
                adjusted++;
                await this.db.run(`INSERT INTO fact_product_price_change
             (product_id, old_price, new_price, change_type, change_time)
           VALUES (?, ?, ?, 'ADJUST', ?)`, [
                    pid,
                    (priceCents / 100).toFixed(2),
                    (newPriceCents / 100).toFixed(2),
                    nowSql,
                ]);
            }
        }
        if (adjusted > 0 || deactivated > 0) {
            this.stats.counters.productsPriceAdjusted += adjusted;
            this.stats.counters.productsDeactivated += deactivated;
            this.logger.log(`price adjust: +${adjusted} price/stock, +${deactivated} deactivated, ` +
                `total adjusted=${this.stats.counters.productsPriceAdjusted}`);
        }
    }
};
exports.PriceAdjusterService = PriceAdjusterService;
exports.PriceAdjusterService = PriceAdjusterService = PriceAdjusterService_1 = __decorate([
    (0, common_1.Injectable)(),
    __metadata("design:paramtypes", [database_service_1.DatabaseService,
        stats_service_1.StatsService])
], PriceAdjusterService);
//# sourceMappingURL=price-adjuster.service.js.map