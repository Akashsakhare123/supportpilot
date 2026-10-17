import { defineConfig } from 'tsup';

export default defineConfig((options) => ({
  // index: safe for browser + server (widget, dashboard, api, worker)
  // node:  server-only helpers (env parsing, .env loading)
  entry: ['src/index.ts', 'src/node.ts'],
  format: ['cjs', 'esm'],
  dts: true,
  sourcemap: true,
  // Never wipe dist/ in watch mode: running apps import it.
  clean: !options.watch,
  target: 'es2022',
}));
