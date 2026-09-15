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
var OrderGeneratorService_1;
Object.defineProperty(exports, "__esModule", { value: true });
exports.OrderGeneratorService = void 0;
const common_1 = require("@nestjs/common");
const config_1 = require("../config");
const database_service_1 = require("../db/database.service");
const seed_service_1 = require("./seed.service");
const stats_service_1 = require("./stats.service");
const task_base_1 = require("./task.base");
const util_1 = require("./util");
let OrderGeneratorService = OrderGeneratorService_1 = class OrderGeneratorService extends task_base_1.LoopedTask {
    db;
    seed;
    stats;
    logger = new common_1.Logger(OrderGeneratorService_1.name);
    gear = 'medium';
    switcherTimer;
    lastRefreshAt = 0;
    logCounter = 0;
    constructor(db, seed, stats) {
        super();
        this.db = db;
        this.seed = seed;
        this.stats = stats;
    }
    get currentGear() {
        return this.gear;
    }
    setGear(g) {
        this.gear = g;
        this.stats.setGear(g);
        const range = config_1.GEARS[g];
        this.setDelay((0, util_1.randInt)(range.minMs, range.maxMs));
        this.logger.log(`order rate gear -> ${g} (${range.minMs}-${range.maxMs}ms)`);
    }
    start(delayMs) {
        this.setGear(this.gear);
        super.start(delayMs);
        this.startGearSwitcher();
    }
    pause() {
        super.pause();
        this.stopGearSwitcher();
    }
    resume() {
        super.resume();
        this.startGearSwitcher();
    }
    onModuleDestroy() {
        super.onModuleDestroy();
        this.stopGearSwitcher();
    }
    startGearSwitcher() {
        this.stopGearSwitcher();
        this.switcherTimer = setInterval(() => {
            this.setGear((0, util_1.pick)(config_1.GEAR_WEIGHTS));
        }, config_1.config.gears.switchMs);
        this.switcherTimer.unref?.();
    }
    stopGearSwitcher() {
        if (this.switcherTimer) {
            clearInterval(this.switcherTimer);
            this.switcherTimer = undefined;
        }
    }
    async tick() {
        if (Date.now() - this.lastRefreshAt > 60_000) {
            this.lastRefreshAt = Date.now();
            await this.seed.refreshCache().catch(() => undefined);
        }
        const userId = this.seed.randomUser();
        const productIds = this.seed.randomProducts((0, util_1.randInt)(1, 3));
        if (productIds.length === 0)
            return;
        const placeholders = productIds.map(() => '?').join(',');
        const rows = await this.db.query(`SELECT product_id, price, status FROM dim_product
       WHERE product_id IN (${placeholders}) AND status = 1`, productIds);
        if (rows.length === 0)
            return;
        const orderTime = this.db.clock.now();
        const nowSql = this.db.clock.toSql(orderTime);
        const itemRows = [];
        const qtyByProduct = new Map();
        let totalCents = 0;
        let totalDiscountCents = 0;
        let totalQty = 0;
        for (const r of rows) {
            const pid = Number(r.product_id);
            const qty = (0, util_1.randInt)(1, 5);
            const unitPriceCents = (0, util_1.toCents)(r.price);
            const subtotalCents = unitPriceCents * qty;
            totalCents += subtotalCents;
            totalQty += qty;
            qtyByProduct.set(pid, qty);
            const discountCents = Math.random() < 0.3
                ? Math.round(subtotalCents * Math.random() * 0.15)
                : 0;
            totalCents -= discountCents;
            totalDiscountCents += discountCents;
            itemRows.push([
                pid,
                qty,
                (0, util_1.fromCents)(unitPriceCents),
                (0, util_1.fromCents)(subtotalCents),
                (0, util_1.fromCents)(discountCents),
                nowSql,
            ]);
        }
        await this.db.transaction(async (conn) => {
            const [res] = await conn.query(`INSERT INTO fact_order
           (user_id, order_status, item_count, total_amount, discount_amount,
            order_time, update_time)
         VALUES (?, 'CREATED', ?, ?, ?, ?, ?)`, [
                userId,
                totalQty,
                (0, util_1.fromCents)(totalCents),
                (0, util_1.fromCents)(totalDiscountCents),
                nowSql,
                nowSql,
            ]);
            const orderId = res.insertId;
            await conn.query(`INSERT INTO fact_order_item
           (order_id, product_id, quantity, unit_price, subtotal, discount_amount, create_time)
         VALUES ?`, [itemRows.map((it) => [orderId, ...it])]);
            if (config_1.config.tasks.order.decrementStock) {
                for (const [pid, qty] of qtyByProduct) {
                    await conn.query('UPDATE dim_product SET stock = GREATEST(stock - ?, 0), update_time = ? WHERE product_id = ?', [qty, nowSql, pid]);
                    await conn.query(`INSERT INTO fact_stock_change
               (product_id, order_id, change_type, delta, stock_after, change_time)
             SELECT ?, ?, 'ORDER_DEDUCT', ?, stock, ? FROM dim_product WHERE product_id = ?`, [pid, orderId, -qty, nowSql, pid]);
                }
            }
        });
        this.stats.counters.ordersCreated++;
        this.stats.counters.itemsCreated += itemRows.length;
        const range = config_1.GEARS[this.gear];
        this.setDelay((0, util_1.randInt)(range.minMs, range.maxMs));
        this.logCounter++;
        if (this.logCounter % 25 === 0) {
            this.logger.log(`orders created: ${this.stats.counters.ordersCreated} (items ${this.stats.counters.itemsCreated}), gear=${this.gear}`);
        }
    }
};
exports.OrderGeneratorService = OrderGeneratorService;
exports.OrderGeneratorService = OrderGeneratorService = OrderGeneratorService_1 = __decorate([
    (0, common_1.Injectable)(),
    __metadata("design:paramtypes", [database_service_1.DatabaseService,
        seed_service_1.SeedService,
        stats_service_1.StatsService])
], OrderGeneratorService);
//# sourceMappingURL=order-generator.service.js.map