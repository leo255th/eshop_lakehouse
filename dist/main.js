"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const core_1 = require("@nestjs/core");
const app_module_1 = require("./app.module");
const config_1 = require("./config");
async function bootstrap() {
    const app = await core_1.NestFactory.create(app_module_1.AppModule, {
        logger: ['log', 'warn', 'error'],
    });
    app.enableShutdownHooks();
    await app.listen(config_1.config.http.port);
    console.log(`eshop-datasource listening on http://localhost:${config_1.config.http.port}`);
    console.log('sim control: GET /api/stats | POST /api/gear/:low|medium|high | POST /api/pause | POST /api/resume');
}
void bootstrap();
//# sourceMappingURL=main.js.map