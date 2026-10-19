import { Module } from '@nestjs/common';
import { AppController } from './app.controller';
import { AuthModule } from './auth/auth.module';
import { ChatModule } from './chat/chat.module';
import { ConfigModule } from './config/config.module';
import { DatabaseModule } from './database/database.module';
import { DocumentsModule } from './documents/documents.module';
import { HealthModule } from './health/health.module';
import { InboxModule } from './inbox/inbox.module';
import { QueueModule } from './queue/queue.module';
import { RealtimeModule } from './realtime/realtime.module';
import { RedisModule } from './redis/redis.module';
import { StorageModule } from './storage/storage.module';
import { TenantModule } from './tenant/tenant.module';
import { UsersModule } from './users/users.module';
import { WidgetModule } from './widget/widget.module';

@Module({
  imports: [
    ConfigModule,
    DatabaseModule,
    RedisModule,
    QueueModule,
    RealtimeModule,
    StorageModule,
    AuthModule,
    UsersModule,
    TenantModule,
    WidgetModule,
    DocumentsModule,
    ChatModule,
    InboxModule,
    HealthModule,
  ],
  controllers: [AppController],
})
export class AppModule {}
