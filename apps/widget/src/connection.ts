// Type-only imports from @supportpilot/shared: importing values would pull zod into the bundle.
import type { WidgetClientEvents, WidgetServerEvents } from '@supportpilot/shared';
import { io, type Socket } from 'socket.io-client';

export type WidgetSocket = Socket<WidgetServerEvents, WidgetClientEvents>;

/** Must match WIDGET_NAMESPACE in @supportpilot/shared. */
const NAMESPACE = '/widget';

/** Socket.io connection to the API's /widget namespace (created when the chat is first opened). */
export function connectWidget(apiUrl: string, publicKey: string, visitorId: string): WidgetSocket {
  return io(`${apiUrl}${NAMESPACE}`, {
    auth: { key: publicKey, visitorId },
    // WebSocket first; long-polling only if a proxy blocks WebSockets.
    transports: ['websocket', 'polling'],
    reconnectionDelayMax: 10_000,
  });
}
