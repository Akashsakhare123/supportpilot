import type { ChatStreamEvent } from '@supportpilot/shared';
import type { Response } from 'express';

/** Minimal Server-Sent Events writer for one response. */
export class SseStream {
  private closed = false;
  readonly abort = new AbortController();

  constructor(private readonly res: Response) {
    res.status(200);
    res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
    // no-transform: stops compression proxies (e.g. the dashboard dev proxy) from buffering.
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders();
    // Visitor closed the tab: stop generating (saves tokens). (Not req 'close': since Node 16
    // that fires as soon as the request body has been read.)
    res.on('close', () => {
      if (!res.writableEnded) this.abort.abort();
      this.closed = true;
    });
  }

  send(event: ChatStreamEvent): void {
    if (this.closed || this.res.writableEnded) return;
    this.res.write(`event: ${event.event}\ndata: ${JSON.stringify(event.data)}\n\n`);
  }

  end(): void {
    if (!this.res.writableEnded) this.res.end();
  }
}
