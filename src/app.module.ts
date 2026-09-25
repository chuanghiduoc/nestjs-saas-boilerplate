import { Module } from '@nestjs/common';
import { AppController } from './app.controller.js';
import { AppService } from './app.service.js';
import { ContextModule } from './core/context/context.module.js';

@Module({
  imports: [ContextModule],
  controllers: [AppController],
  providers: [AppService],
})
export class AppModule {}
