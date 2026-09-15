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
var __param = (this && this.__param) || function (paramIndex, decorator) {
    return function (target, key) { decorator(target, key, paramIndex); }
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.SimController = void 0;
const common_1 = require("@nestjs/common");
const config_1 = require("../config");
const order_generator_service_1 = require("./order-generator.service");
const seed_service_1 = require("./seed.service");
const sim_service_1 = require("./sim.service");
const stats_service_1 = require("./stats.service");
let SimController = class SimController {
    stats;
    sim;
    orderGen;
    seed;
    constructor(stats, sim, orderGen, seed) {
        this.stats = stats;
        this.sim = sim;
        this.orderGen = orderGen;
        this.seed = seed;
    }
    async getStats() {
        const c = this.stats.counters;
        return {
            uptimeSec: this.stats.uptimeSec,
            paused: this.stats.paused,
            gear: this.stats.gear,
            gearRangesMs: config_1.GEARS,
            counters: c,
            db: await this.stats.dbSnapshot(),
        };
    }
    setGear(gear) {
        const g = gear.toLowerCase();
        if (!(g in config_1.GEARS)) {
            throw new common_1.BadRequestException(`invalid gear: ${gear} (use low|medium|high)`);
        }
        this.orderGen.setGear(g);
        return { gear: g };
    }
    pause() {
        this.sim.pauseAll();
        return { paused: true };
    }
    resume() {
        this.sim.resumeAll();
        return { paused: false };
    }
    async reseed(body) {
        const result = await this.seed.seedIfNeeded();
        let backfilled = 0;
        if (body?.backfill) {
            backfilled = await this.seed.backfillOrders();
        }
        return {
            seededUsers: result.users,
            seededProducts: result.products,
            backfilledOrders: backfilled,
            cache: { users: this.seed.userCount, products: this.seed.productCount },
        };
    }
};
exports.SimController = SimController;
__decorate([
    (0, common_1.Get)('stats'),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", []),
    __metadata("design:returntype", Promise)
], SimController.prototype, "getStats", null);
__decorate([
    (0, common_1.Post)('gear/:gear'),
    __param(0, (0, common_1.Param)('gear')),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String]),
    __metadata("design:returntype", Object)
], SimController.prototype, "setGear", null);
__decorate([
    (0, common_1.Post)('pause'),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", []),
    __metadata("design:returntype", Object)
], SimController.prototype, "pause", null);
__decorate([
    (0, common_1.Post)('resume'),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", []),
    __metadata("design:returntype", Object)
], SimController.prototype, "resume", null);
__decorate([
    (0, common_1.Post)('seed'),
    __param(0, (0, common_1.Body)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object]),
    __metadata("design:returntype", Promise)
], SimController.prototype, "reseed", null);
exports.SimController = SimController = __decorate([
    (0, common_1.Controller)('api'),
    __metadata("design:paramtypes", [stats_service_1.StatsService,
        sim_service_1.SimService,
        order_generator_service_1.OrderGeneratorService,
        seed_service_1.SeedService])
], SimController);
//# sourceMappingURL=sim.controller.js.map