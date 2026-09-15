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
Object.defineProperty(exports, "__esModule", { value: true });
exports.StatsService = void 0;
exports.emptyCounters = emptyCounters;
const common_1 = require("@nestjs/common");
const database_service_1 = require("../db/database.service");
function emptyCounters() {
    return {
        ordersCreated: 0,
        itemsCreated: 0,
        ordersStatusChanged: 0,
        ordersCancelled: 0,
        productsPriceAdjusted: 0,
        productsDeactivated: 0,
        usersUpdated: 0,
        usersDeactivated: 0,
        ordersDeleted: 0,
        itemsDeleted: 0,
        usersDeleted: 0,
        productsDeleted: 0,
        gearSwitches: 0,
    };
}
let StatsService = class StatsService {
    db;
    counters = emptyCounters();
    startedAt = Date.now();
    paused = false;
    currentGear = 'medium';
    constructor(db) {
        this.db = db;
    }
    get gear() {
        return this.currentGear;
    }
    setGear(g) {
        if (this.currentGear !== g) {
            this.counters.gearSwitches++;
        }
        this.currentGear = g;
    }
    get uptimeSec() {
        return Math.floor((Date.now() - this.startedAt) / 1000);
    }
    async dbSnapshot() {
        try {
            const users = await this.db.query('SELECT COUNT(*) AS c FROM dim_user');
            const products = await this.db.query('SELECT COUNT(*) AS c FROM dim_product');
            const orders = await this.db.query('SELECT COUNT(*) AS c FROM fact_order');
            const items = await this.db.query('SELECT COUNT(*) AS c FROM fact_order_item');
            const byStatus = await this.db.query(`SELECT order_status, COUNT(*) AS c FROM fact_order GROUP BY order_status`);
            return {
                dim_user: Number(users[0]?.c ?? 0),
                dim_product: Number(products[0]?.c ?? 0),
                fact_order: Number(orders[0]?.c ?? 0),
                fact_order_item: Number(items[0]?.c ?? 0),
                order_status_distribution: Object.fromEntries(byStatus.map((r) => [r.order_status, Number(r.c)])),
            };
        }
        catch (e) {
            return { error: e.message };
        }
    }
};
exports.StatsService = StatsService;
exports.StatsService = StatsService = __decorate([
    (0, common_1.Injectable)(),
    __metadata("design:paramtypes", [database_service_1.DatabaseService])
], StatsService);
//# sourceMappingURL=stats.service.js.map