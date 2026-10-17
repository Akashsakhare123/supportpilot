'use client';

import type { AuthUser, LoginResponse, SignupInput } from '@supportpilot/shared';
import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';

type Status = 'loading' | 'authenticated' | 'anonymous';

type ApiInit = Omit<RequestInit, 'headers'> & { headers?: Record<string, string> };

interface AuthContextValue {
  status: Status;
  user: AuthUser | null;
  login(email: string, password: string): Promise<void>;
  signup(input: SignupInput): Promise<void>;
  logout(): Promise<void>;
  /** Re-read the signed-in user (e.g. after onboarding changes the tenant). */
  reloadUser(): Promise<void>;
  /** Store a session returned by login / accept-invite. */
  setSession(session: LoginResponse): void;
  /** fetch('/api' + path) with the access token; refreshes once and retries on 401. */
  apiFetch(path: string, init?: ApiInit): Promise<Response>;
}

const AuthContext = createContext<AuthContextValue | null>(null);

/** Human-readable message from an API error response. */
export async function readError(res: Response): Promise<string> {
  try {
    const body = (await res.json()) as { message?: unknown; issues?: { message: string }[] };
    if (body.issues?.length) return body.issues.map((issue) => issue.message).join('. ');
    if (typeof body.message === 'string') return body.message;
  } catch {
    // not JSON
  }
  return `Request failed (${res.status})`;
}

/**
 * Keeps the access token in memory only (never localStorage). On load it silently restores the
 * session from the httpOnly refresh cookie; concurrent refreshes are de-duplicated.
 */
export function AuthProvider({ children }: { children: ReactNode }) {
  const [status, setStatus] = useState<Status>('loading');
  const [user, setUser] = useState<AuthUser | null>(null);
  const tokenRef = useRef<string | null>(null);
  const refreshing = useRef<Promise<string | null> | null>(null);

  const setSession = useCallback((session: LoginResponse) => {
    tokenRef.current = session.accessToken;
    setUser(session.user);
    setStatus('authenticated');
  }, []);

  const clear = useCallback(() => {
    tokenRef.current = null;
    setUser(null);
    setStatus('anonymous');
  }, []);

  const refresh = useCallback((): Promise<string | null> => {
    refreshing.current ??= (async () => {
      try {
        const res = await fetch('/api/auth/refresh', { method: 'POST' });
        if (!res.ok) {
          clear();
          return null;
        }
        const session = (await res.json()) as LoginResponse;
        setSession(session);
        return session.accessToken;
      } catch {
        clear();
        return null;
      } finally {
        refreshing.current = null;
      }
    })();
    return refreshing.current;
  }, [clear, setSession]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const login = useCallback(
    async (email: string, password: string) => {
      const res = await fetch('/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, password }),
      });
      if (!res.ok) throw new Error(await readError(res));
      setSession((await res.json()) as LoginResponse);
    },
    [setSession],
  );

  const signup = useCallback(
    async (input: SignupInput) => {
      const res = await fetch('/api/auth/signup', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(input),
      });
      if (!res.ok) throw new Error(await readError(res));
      setSession((await res.json()) as LoginResponse);
    },
    [setSession],
  );

  const logout = useCallback(async () => {
    await fetch('/api/auth/logout', { method: 'POST' }).catch(() => undefined);
    clear();
  }, [clear]);

  const apiFetch = useCallback(
    async (path: string, init: ApiInit = {}) => {
      const send = (token: string | null) =>
        fetch(`/api${path}`, {
          ...init,
          headers: {
            // JSON bodies are strings; FormData sets its own multipart boundary header.
            ...(typeof init.body === 'string' ? { 'Content-Type': 'application/json' } : {}),
            ...init.headers,
            ...(token ? { Authorization: `Bearer ${token}` } : {}),
          },
        });
      let res = await send(tokenRef.current);
      if (res.status === 401) {
        const token = await refresh();
        if (token) res = await send(token);
      }
      return res;
    },
    [refresh],
  );

  const reloadUser = useCallback(async () => {
    const res = await apiFetch('/auth/me');
    if (res.ok) setUser((await res.json()) as AuthUser);
  }, [apiFetch]);

  const value = useMemo<AuthContextValue>(
    () => ({ status, user, login, signup, logout, reloadUser, setSession, apiFetch }),
    [status, user, login, signup, logout, reloadUser, setSession, apiFetch],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
  const context = useContext(AuthContext);
  if (!context) throw new Error('useAuth must be used inside <AuthProvider>');
  return context;
}
