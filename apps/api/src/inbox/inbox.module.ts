import { Module } from '@nestjs/common';
import { HandoffService } from '../handoff/handoff.service';
import { InboxController } from './inbox.controller';
import { InboxService } from './inbox.service';

@Module({
  controllers: [InboxController],
  providers: [InboxService, HandoffService],
  exports: [InboxService, HandoffService],
})
export class InboxModule {}
