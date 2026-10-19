import { Global, Module } from '@nestjs/common';
import { AgentGateway } from './agent.gateway';
import { RealtimeService } from './realtime.service';

/** Live events: the /agent namespace and the service every module uses to push updates. */
@Global()
@Module({
  providers: [RealtimeService, AgentGateway],
  exports: [RealtimeService],
})
export class RealtimeModule {}
