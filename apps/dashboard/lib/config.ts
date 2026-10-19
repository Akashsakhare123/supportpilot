/** Where widget.js is served from (CDN in production). Used to build the embed snippet. */
export const WIDGET_URL = process.env.NEXT_PUBLIC_WIDGET_URL ?? 'http://localhost:5173';

/** Public API URL the browser connects to for live updates (Socket.io cannot go through /api). */
export const API_PUBLIC_URL = (process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:4000').replace(
  /\/+$/,
  '',
);
