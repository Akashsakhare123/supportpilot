'use client';

import {
  type AgentClientEvents,
  type AgentPresence,
  type AgentServerEvents,
  PRESENCE,
} from '@supportpilot/shared';
import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
} from 'react';
import { io, type Socket } from 'socket.io-client';
import { useAuth } from './auth';
import { API_PUBLIC_URL } from './config';

type AgentSocket = Socket<AgentServerEvents, AgentClientEvents>;

type MyPresence = 'online' | 'away';

interface RealtimeValue {
  socket: AgentSocket | null;
  connected: boolean;
  /** This agent's chosen state (remembered per browser). */
  myPresence: MyPresence;
  setMyPresence: (state: MyPresence) => void;
  /** Every team member, online first (from presence:update). */
  team: AgentPresence[];
}

const RealtimeContext = createContext<RealtimeValue>({
  socket: null,
  connected: false,
  myPresence: 'online',
  setMyPresence: () => undefined,
  team: [],
});

const PRESENCE_KEY = 'sp_presence';

function savedPresence(): MyPresence {
  try {
    return window.localStorage.getItem(PRESENCE_KEY) === 'away' ? 'away' : 'online';
  } catch {
    return 'online';
  }
}

/**
 * One Socket.io connection per signed-in dashboard tab (/agent namespace). The access token and
 * the agent's presence go in the handshake; on an auth error the token is refreshed and the socket
 * reconnects. A heartbeat every 10 s keeps the agent online; when the tab closes or crashes the
 * server lets the presence expire.
 */
export function RealtimeProvider({ children }: { children: ReactNode }) {
  const { status, getAccessToken } = useAuth();
  const [socket, setSocket] = useState<AgentSocket | null>(null);
  const [connected, setConnected] = useState(false);
  const [myPresence, setMyPresenceState] = useState<MyPresence>('online');
  const [team, setTeam] = useState<AgentPresence[]>([]);
  const presenceRef = useRef<MyPresence>('online');
  const tokenGetter = useRef(getAccessToken);
  tokenGetter.current = getAccessToken;

  useEffect(() => {
    presenceRef.current = savedPresence();
    setMyPresenceState(presenceRef.current);
  }, []);

  useEffect(() => {
    if (status !== 'authenticated') return;
    let forceRefresh = false;
    const s: AgentSocket = io(`${API_PUBLIC_URL}/agent`, {
      transports: ['websocket', 'polling'],
      auth: (cb) => {
        void tokenGetter.current(forceRefresh).then((token) => {
          forceRefresh = false;
          cb({ token, presence: presenceRef.current });
        });
      },
    });
    const heartbeat = setInterval(() => {
      if (s.connected) s.emit('presence:heartbeat');
    }, PRESENCE.heartbeatMs);
    s.on('connect', () => setConnected(true));
    s.on('disconnect', () => setConnected(false));
    s.on('presence:update', ({ agents }) => setTeam(agents));
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
      clearInterval(heartbeat);
      s.disconnect();
      setSocket(null);
      setConnected(false);
    };
  }, [status]);

  const setMyPresence = useCallback(
    (state: MyPresence) => {
      presenceRef.current = state;
      setMyPresenceState(state);
      try {
        window.localStorage.setItem(PRESENCE_KEY, state);
      } catch {
        // Private mode: the choice lasts for this tab only.
      }
      socket?.emit('presence:set', { state });
    },
    [socket],
  );

  return (
    <RealtimeContext.Provider value={{ socket, connected, myPresence, setMyPresence, team }}>
      {children}
    </RealtimeContext.Provider>
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
