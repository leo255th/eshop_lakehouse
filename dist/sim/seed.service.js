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
var SeedService_1;
Object.defineProperty(exports, "__esModule", { value: true });
exports.SeedService = void 0;
const common_1 = require("@nestjs/common");
const config_1 = require("../config");
const database_service_1 = require("../db/database.service");
const seed_data_1 = require("./seed-data");
const util_1 = require("./util");
const ORDER_STATUSES = [
    'CREATED',
    'PAID',
    'SHIPPED',
    'COMPLETED',
    'CANCELLED',
];
let SeedService = SeedService_1 = class SeedService {
    db;
    logger = new common_1.Logger(SeedService_1.name);
    userPool = [];
    productPool = [];
    productPrice = new Map();
    idBounds = { minUserId: 1, maxUserId: 1, minProductId: 1, maxProductId: 1 };
    constructor(db) {
        this.db = db;
    }
    get clock() {
        return this.db.clock;
    }
    get userCount() {
        return this.idBounds.maxUserId;
    }
    get productCount() {
        return this.idBounds.maxProductId;
    }
    randomUser() {
        if (this.userPool.length > 0)
            return (0, util_1.pick)(this.userPool);
        const { minUserId, maxUserId } = this.idBounds;
        return minUserId + (0, util_1.randInt)(0, Math.max(0, maxUserId - minUserId));
    }
    randomProducts(n) {
        if (this.productPool.length > 0)
            return (0, util_1.pickN)(this.productPool, n);
        const { minProductId, maxProductId } = this.idBounds;
        const out = [];
        for (let i = 0; i < n; i++) {
            out.push(minProductId + (0, util_1.randInt)(0, Math.max(0, maxProductId - minProductId)));
        }
        return out;
    }
    async refreshCache() {
        const poolSize = config_1.config.tasks.userUpdate.samplePool;
        const bounds = await this.db.query(`SELECT
         (SELECT MIN(user_id) FROM dim_user) AS min_u,
         (SELECT MAX(user_id) FROM dim_user) AS max_u,
         (SELECT MIN(product_id) FROM dim_product) AS min_p,
         (SELECT MAX(product_id) FROM dim_product) AS max_p`);
        this.idBounds = {
            minUserId: Number(bounds[0]?.min_u ?? 1),
            maxUserId: Number(bounds[0]?.max_u ?? 1),
            minProductId: Number(bounds[0]?.min_p ?? 1),
            maxProductId: Number(bounds[0]?.max_p ?? 1),
        };
        const users = await this.db.query(`SELECT user_id FROM dim_user WHERE status = 1 AND is_deleted = 0 LIMIT ?`, [poolSize]);
        const products = await this.db.query(`SELECT product_id, price FROM dim_product WHERE status = 1 AND is_deleted = 0 LIMIT ?`, [Math.min(poolSize, 10000)]);
        this.userPool = users.map((r) => Number(r.user_id));
        this.productPool = products.map((r) => Number(r.product_id));
        this.productPrice = new Map(products.map((r) => [Number(r.product_id), r.price]));
        this.logger.log(`cache refreshed: bounds user[${this.idBounds.minUserId},${this.idBounds.maxUserId}] ` +
            `product[${this.idBounds.minProductId},${this.idBounds.maxProductId}] ` +
            `pool users=${this.userPool.length} products=${this.productPool.length}`);
    }
    async seedIfNeeded() {
        const users = await this.count('dim_user');
        const products = await this.count('dim_product');
        const seededUsers = users === 0;
        const seededProducts = products === 0;
        if (seededUsers) {
            await this.seedUsers(config_1.config.seed.users);
        }
        if (seededProducts) {
            await this.seedProducts(config_1.config.seed.products);
        }
        await this.refreshCache();
        return { users: seededUsers, products: seededProducts };
    }
    async count(table) {
        const rows = await this.db.query(`SELECT COUNT(*) AS c FROM ${table}`);
        return Number(rows[0]?.c ?? 0);
    }
    async seedUsers(count) {
        const BATCH = 200;
        const now = this.clock.nowMs();
        const DAY = 24 * 3600 * 1000;
        let inserted = 0;
        for (let start = 0; start < count; start += BATCH) {
            const rows = [];
            for (let i = start; i < Math.min(start + BATCH, count); i++) {
                const region = (0, util_1.pick)(seed_data_1.PROVINCES);
                const username = `user_${100000 + i}`;
                const createdAgo = Math.floor(Math.random() * 30) * DAY;
                const createTime = this.clock.toSql(new Date(now - createdAgo));
                rows.push([
                    username,
                    (0, util_1.randomPhone)(),
                    `${username}@example.com`,
                    region.province,
                    (0, util_1.pick)(region.cities),
                    (0, util_1.weightedIndex)([60, 30, 10]) + 1,
                    1,
                    seed_data_1.CHANNELS[(0, util_1.weightedIndex)([45, 25, 15, 8, 7])],
                    null,
                    0,
                    null,
                    createTime,
                    createTime,
                ]);
            }
            await this.db.insert(`INSERT INTO dim_user
           (username, phone, email, province, city, user_level, status,
            register_channel, first_order_time, is_deleted, deleted_time,
            create_time, update_time)
         VALUES ?`, [rows]);
            inserted += rows.length;
        }
        this.logger.log(`seeded ${inserted} users`);
    }
    async seedProducts(count) {
        const BATCH = 200;
        const now = this.clock.nowMs();
        const DAY = 24 * 3600 * 1000;
        const perCategory = Math.max(1, Math.floor(count / seed_data_1.CATEGORIES.length));
        let inserted = 0;
        for (let start = 0; start < count; start += BATCH) {
            const rows = [];
            for (let i = start; i < Math.min(start + BATCH, count); i++) {
                const cat = seed_data_1.CATEGORIES[Math.floor(i / perCategory) % seed_data_1.CATEGORIES.length];
                const brand = (0, util_1.pick)(cat.brands);
                const [min, max] = cat.priceRange;
                const price = (Math.round((min + Math.random() * (max - min)) * 100) / 100).toFixed(2);
                const cost = ((Math.round(Number(price) * 100) * (0.55 + Math.random() * 0.3)) /
                    100).toFixed(2);
                const createdAgo = Math.floor(Math.random() * 30) * DAY;
                const createTime = this.clock.toSql(new Date(now - createdAgo));
                rows.push([
                    `${brand} ${cat.name} ${String(i).padStart(3, '0')}`,
                    cat.name,
                    brand,
                    price,
                    cost,
                    (0, util_1.randInt)(0, 1000),
                    1,
                    0,
                    null,
                    createTime,
                    createTime,
                ]);
            }
            await this.db.insert(`INSERT INTO dim_product
           (product_name, category, brand, price, cost_price, stock, status,
            is_deleted, deleted_time, create_time, update_time)
         VALUES ?`, [rows]);
            inserted += rows.length;
        }
        this.logger.log(`seeded ${inserted} products (${seed_data_1.CATEGORIES.length} categories)`);
    }
    async backfillOrders() {
        const hours = config_1.config.backfill.hours;
        const rate = config_1.config.backfill.ratePerSecond;
        const maxOrders = config_1.config.backfill.maxOrders;
        const total = Math.min(maxOrders, Math.round(hours * 3600 * rate));
        if (total <= 0)
            return 0;
        const products = await this.db.query('SELECT product_id, price FROM dim_product');
        const users = await this.db.query('SELECT user_id FROM dim_user');
        if (products.length === 0 || users.length === 0) {
            this.logger.warn('backfill skipped: no users/products');
            return 0;
        }
        const productIds = products.map((r) => Number(r.product_id));
        const productPriceMap = new Map(products.map((r) => [Number(r.product_id), r.price]));
        const userIds = users.map((r) => Number(r.user_id));
        const hoursMs = hours * 3600 * 1000;
        const nowVirtual = this.clock.nowMs();
        const minCap = (t) => Math.min(t, nowVirtual);
        let orders = 0;
        const BATCH = 500;
        const statusCount = {};
        for (let batchStart = 0; batchStart < total; batchStart += BATCH) {
            const blocks = [];
            const batchEnd = Math.min(batchStart + BATCH, total);
            for (let k = batchStart; k < batchEnd; k++) {
                const ageMs = Math.pow(Math.random(), 1.3) * hoursMs;
                const orderMs = nowVirtual - ageMs;
                const recent = ageMs < 30 * 60 * 1000;
                let status;
                if (recent) {
                    status = ORDER_STATUSES[(0, util_1.weightedIndex)([50, 30, 10, 0, 10])];
                }
                else {
                    status = ORDER_STATUSES[(0, util_1.weightedIndex)([5, 11, 14, 62, 8])];
                }
                statusCount[status] = (statusCount[status] ?? 0) + 1;
                let payMs = null;
                let shipMs = null;
                let completeMs = null;
                let cancelMs = null;
                if (['PAID', 'SHIPPED', 'COMPLETED'].includes(status)) {
                    payMs = minCap(orderMs + (0, util_1.randInt)(10_000, 300_000));
                }
                else if (status === 'CANCELLED' && (0, util_1.chance)(0.5)) {
                    payMs = minCap(orderMs + (0, util_1.randInt)(10_000, 120_000));
                }
                const base = payMs ?? orderMs;
                switch (status) {
                    case 'COMPLETED':
                        shipMs = minCap(base + (0, util_1.randInt)(60_000, 1_200_000));
                        completeMs = minCap(shipMs + (0, util_1.randInt)(120_000, 3_600_000));
                        break;
                    case 'SHIPPED':
                        shipMs = minCap(base + (0, util_1.randInt)(60_000, 1_200_000));
                        break;
                    case 'CANCELLED':
                        cancelMs = minCap(base + (0, util_1.randInt)(60_000, 1_800_000));
                        break;
                    default:
                        break;
                }
                const updateMs = Math.max(orderMs, ...[payMs, shipMs, completeMs, cancelMs].filter((v) => v !== null));
                const itemCount = (0, util_1.weightedIndex)([50, 30, 20]) + 1;
                const chosen = (0, util_1.pickN)(productIds, itemCount);
                let totalCents = 0;
                let totalDiscountCents = 0;
                let totalQty = 0;
                const items = [];
                for (const pid of chosen) {
                    const qty = (0, util_1.weightedIndex)([40, 30, 20, 7, 3]) + 1;
                    const basePriceCents = (0, util_1.toCents)(productPriceMap.get(pid) ?? '0');
                    const unitPriceCents = Math.round(basePriceCents * (1 + (Math.random() * 0.1 - 0.05)));
                    const subtotalCents = unitPriceCents * qty;
                    const discountCents = (0, util_1.chance)(0.3)
                        ? Math.round(subtotalCents * Math.random() * 0.15)
                        : 0;
                    totalCents += subtotalCents - discountCents;
                    totalDiscountCents += discountCents;
                    totalQty += qty;
                    items.push([
                        pid,
                        qty,
                        (0, util_1.fromCents)(unitPriceCents),
                        (0, util_1.fromCents)(subtotalCents),
                        (0, util_1.fromCents)(discountCents),
                        this.clock.toSql(new Date(orderMs)),
                    ]);
                }
                blocks.push({
                    order: [
                        (0, util_1.pick)(userIds),
                        status,
                        totalQty,
                        (0, util_1.fromCents)(totalCents),
                        (0, util_1.fromCents)(totalDiscountCents),
                        payMs === null ? null : this.clock.toSql(new Date(payMs)),
                        shipMs === null ? null : this.clock.toSql(new Date(shipMs)),
                        completeMs === null ? null : this.clock.toSql(new Date(completeMs)),
                        cancelMs === null ? null : this.clock.toSql(new Date(cancelMs)),
                        this.clock.toSql(new Date(orderMs)),
                        this.clock.toSql(new Date(updateMs)),
                        0,
                        null,
                    ],
                    items,
                });
            }
            await this.db.transaction(async (conn) => {
                const [r] = await conn.query(`INSERT INTO fact_order
             (user_id, order_status, item_count, total_amount, discount_amount,
              pay_time, shipping_time, complete_time, cancel_time,
              order_time, update_time, is_deleted, deleted_time)
           VALUES ?`, [blocks.map((b) => b.order)]);
                const firstId = r.insertId;
                const flatItems = [];
                blocks.forEach((b, bi) => {
                    for (const it of b.items) {
                        flatItems.push([firstId + bi, ...it]);
                    }
                });
                await conn.query(`INSERT INTO fact_order_item
             (order_id, product_id, quantity, unit_price, subtotal, discount_amount, create_time)
           VALUES ?`, [flatItems]);
            });
            orders += batchEnd - batchStart;
            if (orders % 5000 === 0 || orders === total) {
                this.logger.log(`backfill progress: ${orders}/${total} orders, status=${JSON.stringify(statusCount)}`);
            }
        }
        this.logger.log(`backfilled ${orders} historical orders over last ${hours}h, status=${JSON.stringify(statusCount)}`);
        return orders;
    }
};
exports.SeedService = SeedService;
exports.SeedService = SeedService = SeedService_1 = __decorate([
    (0, common_1.Injectable)(),
    __metadata("design:paramtypes", [database_service_1.DatabaseService])
], SeedService);
//# sourceMappingURL=seed.service.js.map