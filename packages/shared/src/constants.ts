/** BullMQ queue names, shared by the API (producer) and the worker (consumer). */
export const QUEUES = {
  ingestion: 'ingestion',
} as const;

export type QueueName = (typeof QUEUES)[keyof typeof QUEUES];

/** Redis pub/sub channels. The worker publishes; the API relays to dashboards (sockets, T09). */
export const CHANNELS = {
  documentStatus: 'supportpilot:document-status',
} as const;

/** Default local ports, used as fallbacks when env vars are missing. */
export const DEFAULT_PORTS = {
  api: 4000,
  dashboard: 3000,
  widget: 5173,
  bullBoard: 4100,
} as const;
