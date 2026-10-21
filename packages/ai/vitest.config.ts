import { defineConfig } from 'vitest/config';

// `pnpm test:coverage` (T14): v8 coverage of src/, at least 70% of lines.
export default defineConfig({
  test: {
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      exclude: ['src/**/*.test.ts', 'src/index.ts'],
      reporter: ['text-summary', 'json-summary', 'lcov'],
      thresholds: { lines: 70 },
    },
  },
});
