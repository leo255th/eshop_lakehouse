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
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
var DatabaseService_1;
Object.defineProperty(exports, "__esModule", { value: true });
exports.DatabaseService = void 0;
const common_1 = require("@nestjs/common");
const fs_1 = require("fs");
const path_1 = require("path");
const promise_1 = __importDefault(require("mysql2/promise"));
const config_1 = require("../config");
const clock_service_1 = require("../clock/clock.service");
function loadSchemaSql(database) {
    const candidates = [
        (0, path_1.join)(process.cwd(), 'sql', 'schema.sql'),
        (0, path_1.join)(__dirname, '..', '..', 'sql', 'schema.sql'),
        (0, path_1.join)(__dirname, '..', '..', '..', 'sql', 'schema.sql'),
    ];
    for (const p of candidates) {
        if ((0, fs_1.existsSync)(p)) {
            return (0, fs_1.readFileSync)(p, 'utf8').replace(/__DB__/g, database);
        }
    }
    throw new Error(`schema.sql not found (tried: ${candidates.join(', ')})`);
}
function splitStatements(sql) {
    return sql
        .split('\n')
        .filter((l) => !l.trim().startsWith('--'))
        .join('\n')
        .split(';')
        .map((s) => s.trim())
        .filter((s) => s.length > 0);
}
let DatabaseService = DatabaseService_1 = class DatabaseService {
    logger = new common_1.Logger(DatabaseService_1.name);
    pool;
    clock = (0, clock_service_1.getClock)();
    constructor() {
        this.pool = promise_1.default.createPool({
            host: config_1.config.db.host,
            port: config_1.config.db.port,
            user: config_1.config.db.user,
            password: config_1.config.db.password,
            database: config_1.config.db.database,
            timezone: config_1.config.db.timezone,
            connectionLimit: config_1.config.db.connectionLimit,
            dateStrings: true,
            charset: 'utf8mb4',
            waitForConnections: true,
            queueLimit: 0,
        });
        this.pool.on('connection', (conn) => {
            const core = conn;
            core.query('SET time_zone = ?', [config_1.config.db.timezone], (err) => {
                if (err) {
                    this.logger.warn(`set session time_zone=${config_1.config.db.timezone} failed: ${err.message}`);
                }
            });
        });
    }
    async onModuleInit() {
        if (process.env.NODE_ENV === 'test')
            return;
        await this.ensureDatabase();
        if (config_1.config.schema.resetOnStart) {
            await this.reset();
        }
        else if (config_1.config.schema.autoCreate) {
            await this.ensureSchema();
        }
        if (this.clock.isVirtual) {
            this.logger.log(`virtual clock active: epoch=${this.clock.epoch.toISOString()} scale=${this.clock.currentScale}x`);
        }
    }
    async onModuleDestroy() {
        await this.pool
            .end()
            .catch((e) => this.logger.warn(`pool end: ${e.message}`));
    }
    async ensureDatabase() {
        const conn = await promise_1.default.createConnection({
            host: config_1.config.db.host,
            port: config_1.config.db.port,
            user: config_1.config.db.user,
            password: config_1.config.db.password,
            timezone: config_1.config.db.timezone,
        });
        try {
            await conn.query(`CREATE DATABASE IF NOT EXISTS \`${config_1.config.db.database}\` DEFAULT CHARACTER SET utf8mb4 DEFAULT COLLATE utf8mb4_unicode_ci`);
            this.logger.log(`database "${config_1.config.db.database}" ready`);
        }
        finally {
            await conn.end();
        }
    }
    async ensureSchema() {
        const statements = splitStatements(loadSchemaSql(config_1.config.db.database)).filter((s) => !/^CREATE\s+DATABASE/i.test(s));
        for (const stmt of statements) {
            await this.pool.query(stmt);
        }
        this.logger.log(`schema ensured (${statements.length} statements)`);
    }
    async reset() {
        const tables = [
            'cdc_test',
            'fact_stock_change',
            'fact_product_price_change',
            'fact_order_item',
            'fact_order',
            'dim_product',
            'dim_user',
        ];
        for (const t of tables) {
            await this.pool.query(`DROP TABLE IF EXISTS \`${t}\``);
        }
        this.logger.warn(`${tables.length} tables dropped`);
        await this.ensureSchema();
        this.logger.log('schema recreated');
    }
    async query(sql, params) {
        const [rows] = await this.pool.query(sql, params);
        return rows;
    }
    async execute(sql, params) {
        const [result] = await this.pool.execute(sql, params);
        return {
            affectedRows: result.affectedRows ?? 0,
            insertId: result.insertId ?? 0,
        };
    }
    async run(sql, params) {
        const [result] = await this.pool.query(sql, params);
        return {
            affectedRows: result.affectedRows ?? 0,
            insertId: result.insertId ?? 0,
        };
    }
    async insert(sql, params) {
        return this.run(sql, params);
    }
    async transaction(fn) {
        const conn = await this.pool.getConnection();
        try {
            await conn.beginTransaction();
            const result = await fn(conn);
            await conn.commit();
            return result;
        }
        catch (e) {
            await conn.rollback().catch(() => undefined);
            throw e;
        }
        finally {
            conn.release();
        }
    }
};
exports.DatabaseService = DatabaseService;
exports.DatabaseService = DatabaseService = DatabaseService_1 = __decorate([
    (0, common_1.Injectable)(),
    __metadata("design:paramtypes", [])
], DatabaseService);
//# sourceMappingURL=database.service.js.map