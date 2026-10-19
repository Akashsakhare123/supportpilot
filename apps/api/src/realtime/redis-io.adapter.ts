import type { INestApplicationContext } from '@nestjs/common';
import { IoAdapter } from '@nestjs/platform-socket.io';
import { createAdapter } from '@socket.io/redis-adapter';
import { redisOptionsFromUrl } from '@supportpilot/shared/node';
import { Redis } from 'ioredis';
import type { Server, ServerOptions } from 'socket.io';

/**
 * Socket.io with the Redis adapter: an event emitted to a room on one API instance reaches
 * sockets connected to any instance (horizontal scaling). One pub/sub pair per process.
 */
export class RedisIoAdapter extends IoAdapter {
  private pub: Redis | null = null;
  private sub: Redis | null = null;

  constructor(
    app: INestApplicationContext,
    private readonly redisUrl: string,
  ) {
    super(app);
  }

  override createIOServer(port: number, options?: ServerOptions): Server {
    const server = super.createIOServer(port, options) as Server;
    if (!this.pub) {
      this.pub = new Redis(redisOptionsFromUrl(this.redisUrl));
      this.sub = this.pub.duplicate();
    }
    server.adapter(createAdapter(this.pub, this.sub!));
    return server;
  }

  override async dispose(): Promise<void> {
    await super.dispose();
    this.pub?.disconnect();
    this.sub?.disconnect();
    this.pub = this.sub = null;
  }
}
