"use strict";
var __decorate = (this && this.__decorate) || function (decorators, target, key, desc) {
    var c = arguments.length, r = c < 3 ? target : desc === null ? desc = Object.getOwnPropertyDescriptor(target, key) : desc, d;
    if (typeof Reflect === "object" && typeof Reflect.decorate === "function") r = Reflect.decorate(decorators, target, key, desc);
    else for (var i = decorators.length - 1; i >= 0; i--) if (d = decorators[i]) r = (c < 3 ? d(r) : c > 3 ? d(target, key, r) : d(target, key)) || r;
    return c > 3 && r && Object.defineProperty(target, key, r), r;
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.SimModule = void 0;
const common_1 = require("@nestjs/common");
const database_service_1 = require("../db/database.service");
const canceler_service_1 = require("./canceler.service");
const deletion_cleaner_service_1 = require("./deletion-cleaner.service");
const order_generator_service_1 = require("./order-generator.service");
const price_adjuster_service_1 = require("./price-adjuster.service");
const seed_service_1 = require("./seed.service");
const sim_controller_1 = require("./sim.controller");
const sim_service_1 = require("./sim.service");
const stats_service_1 = require("./stats.service");
const status_flow_service_1 = require("./status-flow.service");
const user_updater_service_1 = require("./user-updater.service");
let SimModule = class SimModule {
};
exports.SimModule = SimModule;
exports.SimModule = SimModule = __decorate([
    (0, common_1.Module)({
        controllers: [sim_controller_1.SimController],
        providers: [
            database_service_1.DatabaseService,
            stats_service_1.StatsService,
            seed_service_1.SeedService,
            sim_service_1.SimService,
            order_generator_service_1.OrderGeneratorService,
            status_flow_service_1.StatusFlowService,
            canceler_service_1.CancelerService,
            price_adjuster_service_1.PriceAdjusterService,
            user_updater_service_1.UserUpdaterService,
            deletion_cleaner_service_1.DeletionCleanerService,
        ],
        exports: [database_service_1.DatabaseService],
    })
], SimModule);
//# sourceMappingURL=sim.module.js.map