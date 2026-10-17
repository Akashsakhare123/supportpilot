import { Module } from '@nestjs/common';
import { AppController } from './app.controller';
import { AuthModule } from './auth/auth.module';
import { ConfigModule } from './config/config.module';
import { DatabaseModule } from './database/database.module';
import { DocumentsModule } from './documents/documents.module';
import { HealthModule } from './health/health.module';
import { QueueModule } from './queue/queue.module';
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
    StorageModule,
    AuthModule,
    UsersModule,
    TenantModule,
    WidgetModule,
    DocumentsModule,
    HealthModule,
  ],
  controllers: [AppController],
})
export class AppModule {}
