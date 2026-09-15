import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { config } from './config';

async function bootstrap() {
  // 注册关闭钩子：Ctrl+C / SIGTERM 时触发各服务 onModuleDestroy（清理定时器、关闭连接池）
  const app = await NestFactory.create(AppModule, {
    logger: ['log', 'warn', 'error'],
  });
  app.enableShutdownHooks();
  await app.listen(config.http.port);
  console.log(
    `eshop-datasource listening on http://localhost:${config.http.port}`,
  );
  console.log(
    'sim control: GET /api/stats | POST /api/gear/:low|medium|high | POST /api/pause | POST /api/resume',
  );
}
void bootstrap();
