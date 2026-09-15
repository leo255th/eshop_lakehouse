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
var UserUpdaterService_1;
Object.defineProperty(exports, "__esModule", { value: true });
exports.UserUpdaterService = void 0;
const common_1 = require("@nestjs/common");
const config_1 = require("../config");
const database_service_1 = require("../db/database.service");
const seed_data_1 = require("./seed-data");
const stats_service_1 = require("./stats.service");
const task_base_1 = require("./task.base");
const util_1 = require("./util");
let UserUpdaterService = UserUpdaterService_1 = class UserUpdaterService extends task_base_1.LoopedTask {
    db;
    stats;
    logger = new common_1.Logger(UserUpdaterService_1.name);
    maxUserId = 0;
    lastBoundsRefresh = 0;
    constructor(db, stats) {
        super();
        this.db = db;
        this.stats = stats;
    }
    get clock() {
        return this.db.clock;
    }
    async sampleUsers(needed) {
        if (this.maxUserId === 0 || Date.now() - this.lastBoundsRefresh > 300_000) {
            const rows = await this.db.query('SELECT IFNULL(MAX(user_id),0) AS m FROM dim_user');
            this.maxUserId = Number(rows[0]?.m ?? 0);
            this.lastBoundsRefresh = Date.now();
        }
        if (this.maxUserId === 0)
            return [];
        const out = [];
        for (let i = 0; i < needed; i++) {
            const anchor = (0, util_1.randInt)(1, this.maxUserId);
            const rows = await this.db.query(`SELECT user_id, email, user_level FROM dim_user
         WHERE user_id >= ? AND is_deleted = 0
         ORDER BY user_id LIMIT 1`, [anchor]);
            if (rows[0])
                out.push(rows[0]);
        }
        return out;
    }
    async tick() {
        const batch = config_1.config.tasks.userUpdate.batch;
        const rows = await this.sampleUsers(batch);
        if (rows.length === 0)
            return;
        const nowSql = this.clock.toSql();
        let updated = 0;
        let deactivated = 0;
        for (const r of rows) {
            const uid = Number(r.user_id);
            if ((0, util_1.chance)(0.02)) {
                const res = await this.db.execute('UPDATE dim_user SET status = 0, update_time = ? WHERE user_id = ? AND status = 1', [nowSql, uid]);
                if (res.affectedRows === 1) {
                    deactivated++;
                    this.logger.log(`user ${uid} deactivated (注销)`);
                }
                continue;
            }
            const region = (0, util_1.pick)(seed_data_1.PROVINCES);
            const newPhone = (0, util_1.randomPhone)();
            const newEmail = (0, util_1.chance)(0.5)
                ? `u${uid}_${(0, util_1.randInt)(1000, 9999)}@example.com`
                : r.email;
            const newCity = (0, util_1.pick)(region.cities);
            const newLevel = (0, util_1.weightedIndex)([60, 30, 10]) + 1;
            const res = await this.db.execute(`UPDATE dim_user SET phone = ?, email = ?, city = ?, user_level = ?, update_time = ?
         WHERE user_id = ? AND status = 1`, [newPhone, newEmail, newCity, newLevel, nowSql, uid]);
            if (res.affectedRows === 1)
                updated++;
        }
        if (updated > 0 || deactivated > 0) {
            this.stats.counters.usersUpdated += updated;
            this.stats.counters.usersDeactivated += deactivated;
            this.logger.log(`user update: +${updated} fields, +${deactivated} deactivated, ` +
                `total updated=${this.stats.counters.usersUpdated}`);
        }
    }
};
exports.UserUpdaterService = UserUpdaterService;
exports.UserUpdaterService = UserUpdaterService = UserUpdaterService_1 = __decorate([
    (0, common_1.Injectable)(),
    __metadata("design:paramtypes", [database_service_1.DatabaseService,
        stats_service_1.StatsService])
], UserUpdaterService);
//# sourceMappingURL=user-updater.service.js.map