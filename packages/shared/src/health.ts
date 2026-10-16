export type DependencyStatus = 'ok' | 'error';

/** Response body of GET /health. */
export interface HealthReport {
  status: 'ok' | 'degraded';
  db: DependencyStatus;
  /** Installed pgvector version, or null when the extension is missing (run `pnpm db:migrate`). */
  pgvector: string | null;
  redis: DependencyStatus;
  uptimeSeconds: number;
  timestamp: string;
}
