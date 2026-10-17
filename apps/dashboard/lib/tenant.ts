'use client';

import type { TenantSettings, UpdateTenantInput } from '@supportpilot/shared';
import { useCallback, useEffect, useState } from 'react';
import { readError, useAuth } from './auth';

/** Load and update the signed-in tenant's settings (admins and owners). */
export function useTenantSettings() {
  const { apiFetch } = useAuth();
  const [settings, setSettings] = useState<TenantSettings | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    const res = await apiFetch('/tenant');
    if (res.ok) setSettings((await res.json()) as TenantSettings);
    else setError(await readError(res));
  }, [apiFetch]);

  useEffect(() => {
    void load();
  }, [load]);

  const update = useCallback(
    async (patch: UpdateTenantInput): Promise<TenantSettings> => {
      const res = await apiFetch('/tenant', { method: 'PATCH', body: JSON.stringify(patch) });
      if (!res.ok) throw new Error(await readError(res));
      const next = (await res.json()) as TenantSettings;
      setSettings(next);
      return next;
    },
    [apiFetch],
  );

  const rotateKey = useCallback(async (): Promise<TenantSettings> => {
    const res = await apiFetch('/tenant/public-key/rotate', { method: 'POST' });
    if (!res.ok) throw new Error(await readError(res));
    const next = (await res.json()) as TenantSettings;
    setSettings(next);
    return next;
  }, [apiFetch]);

  return { settings, error, update, rotateKey };
}
