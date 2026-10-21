// Integration tests: test/**/*.int-spec.ts against real Postgres (pgvector) and Redis.
// `pnpm test:coverage` adds coverage of the API source (src/) with thresholds for the core services.
module.exports = {
  rootDir: '.',
  roots: ['<rootDir>/test'],
  testEnvironment: 'node',
  testRegex: '.*\.int-spec\.ts$',
  moduleFileExtensions: ['ts', 'js', 'json'],
  transform: { '^.+\.ts$': '@swc/jest' },
  globalSetup: '<rootDir>/test/global-setup.ts',
  setupFiles: ['<rootDir>/test/setup-env.ts'],
  testTimeout: 20000,
  collectCoverageFrom: ['src/**/*.ts', '!src/**/*.spec.ts', '!src/main.ts', '!src/eval/**'],
  coverageDirectory: 'coverage/integration',
  coverageReporters: ['text-summary', 'json-summary', 'lcov'],
  // At least 70% of lines overall and in each core service.
  coverageThreshold: {
    global: { lines: 70 },
    ...Object.fromEntries(
      [
        'auth/auth.service.ts',
        'billing/billing.service.ts',
        'billing/plan-limits.service.ts',
        'chat/chat.service.ts',
        'chat/widget.gateway.ts',
        'documents/documents.service.ts',
        'handoff/handoff.service.ts',
        'inbox/inbox.service.ts',
        'analytics/analytics.service.ts',
        'realtime/presence.service.ts',
      ].map((file) => [`./src/${file}`, { lines: 70 }]),
    ),
  },
};
