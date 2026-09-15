import { Module } from '@nestjs/common';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { SimModule } from './sim/sim.module';

@Module({
  imports: [SimModule],
  controllers: [AppController],
  providers: [AppService],
})
export class AppModule {}
