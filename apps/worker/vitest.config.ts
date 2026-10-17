import { configDefaults, defineConfig } from 'vitest/config';

// Unit tests only; *.int.test.ts need Postgres + Redis (vitest.integration.config.ts).
export default defineConfig({
  test: { exclude: [...configDefaults.exclude, '**/*.int.test.ts'] },
});
