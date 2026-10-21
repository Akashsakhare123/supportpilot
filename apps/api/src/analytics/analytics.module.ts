import { Module } from '@nestjs/common';
import { ChatModule } from '../chat/chat.module';
import { AnalyticsController } from './analytics.controller';
import { AnalyticsService } from './analytics.service';

/** Analytics dashboard API (T12). Uses the chat module's embedding provider to group questions. */
@Module({
  imports: [ChatModule],
  controllers: [AnalyticsController],
  providers: [AnalyticsService],
})
export class AnalyticsModule {}
