import { DEFAULT_PORTS, type HealthReport } from '@supportpilot/shared';

export const API_URL = process.env.NEXT_PUBLIC_API_URL ?? `http://localhost:${DEFAULT_PORTS.api}`;

/** Server-side health check used by the status card; never throws. */
export async function getHealth(): Promise<HealthReport | null> {
  try {
    const res = await fetch(`${API_URL}/health`, {
      cache: 'no-store',
      signal: AbortSignal.timeout(3000),
    });
    return (await res.json()) as HealthReport;
  } catch {
    return null;
  }
}
