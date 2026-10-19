'use client';

import type { AgentClientEvents, AgentServerEvents } from '@supportpilot/shared';
import { createContext, type ReactNode, useContext, useEffect, useRef, useState } from 'react';
import { io, type Socket } from 'socket.io-client';
import { useAuth } from './auth';
import { API_PUBLIC_URL } from './config';

type AgentSocket = Socket<AgentServerEvents, AgentClientEvents>;

interface RealtimeValue {
  socket: AgentSocket | null;
  connected: boolean;
}

const RealtimeContext = createContext<RealtimeValue>({ socket: null, connected: false });

/**
 * One Socket.io connection per signed-in dashboard tab (/agent namespace). The access token goes
 * in the handshake; on an auth error the token is refreshed and the socket reconnects.
 */
export function RealtimeProvider({ children }: { children: ReactNode }) {
  const { status, getAccessToken } = useAuth();
  const [socket, setSocket] = useState<AgentSocket | null>(null);
  const [connected, setConnected] = useState(false);
  const tokenGetter = useRef(getAccessToken);
  tokenGetter.current = getAccessToken;

  useEffect(() => {
    if (status !== 'authenticated') return;
    let forceRefresh = false;
    const s: AgentSocket = io(`${API_PUBLIC_URL}/agent`, {
      transports: ['websocket', 'polling'],
      auth: (cb) => {
        void tokenGetter.current(forceRefresh).then((token) => {
          forceRefresh = false;
          cb({ token });
        });
      },
    });
    s.on('connect', () => setConnected(true));
    s.on('disconnect', () => setConnected(false));
    s.on('connect_error', (error) => {
      setConnected(false);
      // Expired access token: fetch a new one and try again.
      if (/token/i.test(error.message)) {
        forceRefresh = true;
        setTimeout(() => s.connect(), 1_000);
      }
    });
    setSocket(s);
    return () => {
      s.disconnect();
      setSocket(null);
      setConnected(false);
    };
  }, [status]);

  return (
    <RealtimeContext.Provider value={{ socket, connected }}>{children}</RealtimeContext.Provider>
  );
}

export function useRealtime(): RealtimeValue {
  return useContext(RealtimeContext);
}

/** Subscribe to one server event while the component is mounted. */
export function useAgentEvent<E extends keyof AgentServerEvents>(
  event: E,
  handler: AgentServerEvents[E],
): void {
  const { socket } = useRealtime();
  const latest = useRef(handler);
  latest.current = handler;
  useEffect(() => {
    if (!socket) return;
    const listener = (...args: unknown[]) => (latest.current as (...a: unknown[]) => void)(...args);
    socket.on(event, listener as never);
    return () => {
      socket.off(event, listener as never);
    };
  }, [socket, event]);
}
