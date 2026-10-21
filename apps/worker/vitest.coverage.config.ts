import { defineConfig, mergeConfig } from 'vitest/config';
import integration from './vitest.integration.config';

// `pnpm test:coverage` (T14): unit + integration tests together (needs Postgres + Redis),
// v8 coverage of src/, at least 70% of lines.
export default mergeConfig(
  integration,
  defineConfig({
    test: {
      include: ['src/**/*.test.ts'],
      coverage: {
        provider: 'v8',
        include: ['src/**/*.ts'],
        exclude: ['src/**/*.test.ts', 'src/index.ts', 'src/bull-board.ts'],
        reporter: ['text-summary', 'json-summary', 'lcov'],
        thresholds: { lines: 70 },
      },
    },
  }),
);
