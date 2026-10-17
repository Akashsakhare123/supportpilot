import { defineConfig } from 'tsup';

export default defineConfig((options) => ({
  entry: ['src/index.ts'],
  format: ['cjs', 'esm'],
  dts: true,
  sourcemap: true,
  // Never wipe dist/ in watch mode: running apps import it.
  clean: !options.watch,
  target: 'es2022',
}));
