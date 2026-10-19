import { Global, Module } from '@nestjs/common';
import { AgentGateway } from './agent.gateway';
import { PresenceService } from './presence.service';
import { RealtimeService } from './realtime.service';

/**
 * Live events: the /agent namespace, the service every module uses to push updates, and agent
 * presence.
 */
@Global()
@Module({
  providers: [RealtimeService, PresenceService, AgentGateway],
  exports: [RealtimeService, PresenceService],
})
export class RealtimeModule {}
