import { Module } from '@nestjs/common';
import { createEmbeddingProvider, createLlmProvider } from '@supportpilot/ai';
import { InboxModule } from '../inbox/inbox.module';
import { WidgetModule } from '../widget/widget.module';
import { ChatController } from './chat.controller';
import { ChatService, EMBEDDING_PROVIDER, LLM_PROVIDER } from './chat.service';
import { PlaygroundController } from './playground.controller';
import { WidgetGateway } from './widget.gateway';

/** RAG chat. Providers come from env: LLM_PROVIDER (mock | openai), EMBEDDING_PROVIDER (local | openai). */
@Module({
  imports: [WidgetModule, InboxModule],
  controllers: [ChatController, PlaygroundController],
  providers: [
    ChatService,
    WidgetGateway,
    { provide: LLM_PROVIDER, useFactory: () => createLlmProvider(process.env) },
    { provide: EMBEDDING_PROVIDER, useFactory: () => createEmbeddingProvider(process.env) },
  ],
  exports: [ChatService, EMBEDDING_PROVIDER],
})
export class ChatModule {}
