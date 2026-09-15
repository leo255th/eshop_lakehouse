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
var SimService_1;
Object.defineProperty(exports, "__esModule", { value: true });
exports.SimService = void 0;
const common_1 = require("@nestjs/common");
const config_1 = require("../config");
const database_service_1 = require("../db/database.service");
const canceler_service_1 = require("./canceler.service");
const deletion_cleaner_service_1 = require("./deletion-cleaner.service");
const order_generator_service_1 = require("./order-generator.service");
const price_adjuster_service_1 = require("./price-adjuster.service");
const seed_service_1 = require("./seed.service");
const stats_service_1 = require("./stats.service");
const status_flow_service_1 = require("./status-flow.service");
const user_updater_service_1 = require("./user-updater.service");
let SimService = SimService_1 = class SimService {
    db;
    seed;
    stats;
    orderGen;
    statusFlow;
    canceler;
    priceAdjust;
    userUpdate;
    cleaner;
    logger = new common_1.Logger(SimService_1.name);
    tasks = [];
    summaryTimer;
    constructor(db, seed, stats, orderGen, statusFlow, canceler, priceAdjust, userUpdate, cleaner) {
        this.db = db;
        this.seed = seed;
        this.stats = stats;
        this.orderGen = orderGen;
        this.statusFlow = statusFlow;
        this.canceler = canceler;
        this.priceAdjust = priceAdjust;
        this.userUpdate = userUpdate;
        this.cleaner = cleaner;
    }
    async onApplicationBootstrap() {
        if (process.env.NODE_ENV === 'test')
            return;
        const seedResult = config_1.config.seed.enabled
            ? await this.seed.seedIfNeeded()
            : { users: false, products: false };
        this.logger.log(`seed: users=${seedResult.users ? 'seeded' : 'already exists'} ` +
            `products=${seedResult.products ? 'seeded' : 'already exists'} ` +
            `(cache: ${this.seed.userCount} users, ${this.seed.productCount} products)`);
        if (config_1.config.backfill.enabled &&
            (await this.seed.count('fact_order')) === 0) {
            await this.seed.backfillOrders();
        }
        this.startTasks();
        this.startSummaryLogger();
        this.logger.log('eshop data source simulator started');
    }
    onModuleDestroy() {
        if (this.summaryTimer)
            clearInterval(this.summaryTimer);
        for (const t of this.tasks)
            t.stop();
    }
    startTasks() {
        const t = config_1.config.tasks;
        if (t.order.enabled) {
            this.orderGen.start();
            this.tasks.push(this.orderGen);
        }
        if (t.statusFlow.enabled) {
            this.statusFlow.start(t.statusFlow.intervalMs);
            this.tasks.push(this.statusFlow);
        }
        if (t.canceler.enabled) {
            this.canceler.start(t.canceler.intervalMs);
            this.tasks.push(this.canceler);
        }
        if (t.priceAdjust.enabled) {
            this.priceAdjust.start(t.priceAdjust.intervalMs);
            this.tasks.push(this.priceAdjust);
        }
        if (t.userUpdate.enabled) {
            this.userUpdate.start(t.userUpdate.intervalMs);
            this.tasks.push(this.userUpdate);
        }
        if (t.cleaner.enabled) {
            this.cleaner.start(t.cleaner.intervalMs);
            this.tasks.push(this.cleaner);
        }
    }
    pauseAll() {
        for (const t of this.tasks)
            t.pause();
        this.stats.paused = true;
        this.logger.warn('ALL tasks paused');
    }
    resumeAll() {
        for (const t of this.tasks)
            t.resume();
        this.stats.paused = false;
        this.logger.log('ALL tasks resumed');
    }
    startSummaryLogger() {
        this.summaryTimer = setInterval(() => {
            const c = this.stats.counters;
            this.logger.log(`[summary] gear=${this.stats.gear} paused=${this.stats.paused} ` +
                `orders+${c.ordersCreated} items+${c.itemsCreated} ` +
                `statusFlow+${c.ordersStatusChanged} cancel+${c.ordersCancelled} ` +
                `priceAdjust+${c.productsPriceAdjusted} userUpdate+${c.usersUpdated} ` +
                `delOrders+${c.ordersDeleted} delItems+${c.itemsDeleted} ` +
                `delUsers+${c.usersDeleted} delProducts+${c.productsDeleted} ` +
                `| uptime ${this.stats.uptimeSec}s`);
        }, 10_000);
        this.summaryTimer.unref?.();
    }
};
exports.SimService = SimService;
exports.SimService = SimService = SimService_1 = __decorate([
    (0, common_1.Injectable)(),
    __metadata("design:paramtypes", [database_service_1.DatabaseService,
        seed_service_1.SeedService,
        stats_service_1.StatsService,
        order_generator_service_1.OrderGeneratorService,
        status_flow_service_1.StatusFlowService,
        canceler_service_1.CancelerService,
        price_adjuster_service_1.PriceAdjusterService,
        user_updater_service_1.UserUpdaterService,
        deletion_cleaner_service_1.DeletionCleanerService])
], SimService);
//# sourceMappingURL=sim.service.js.map