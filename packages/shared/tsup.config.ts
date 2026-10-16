import { defineConfig } from 'tsup';

export default defineConfig({
  // index: safe for browser + server (widget, dashboard, api, worker)
  // node:  server-only helpers (env parsing, .env loading)
  entry: ['src/index.ts', 'src/node.ts'],
  format: ['cjs', 'esm'],
  dts: true,
  sourcemap: true,
  clean: true,
  target: 'es2022',
});
