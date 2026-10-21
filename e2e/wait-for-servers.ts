/**
 * `pnpm dev` starts every app at once; the dashboard can answer before the API, worker or widget
 * bundle are ready. Wait for all of them before the first test.
 */
const URLS = [
  'http://localhost:4000/health',
  'http://localhost:3000/login',
  'http://localhost:5173/widget.js',
];

export default async function waitForServers(): Promise<void> {
  const deadline = Date.now() + 180_000;
  for (const url of URLS) {
    for (;;) {
      try {
        if ((await fetch(url, { signal: AbortSignal.timeout(5_000) })).ok) break;
      } catch {
        // not up yet
      }
      if (Date.now() > deadline) throw new Error(`${url} did not come up`);
      await new Promise((resolve) => setTimeout(resolve, 2_000));
    }
  }
}
