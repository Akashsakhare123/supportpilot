// Integration tests: test/**/*.int-spec.ts against real Postgres (pgvector) and Redis.
module.exports = {
  rootDir: 'test',
  testEnvironment: 'node',
  testRegex: '.*\\.int-spec\\.ts$',
  moduleFileExtensions: ['ts', 'js', 'json'],
  transform: { '^.+\\.ts$': '@swc/jest' },
  setupFiles: ['<rootDir>/setup-env.ts'],
  testTimeout: 20000,
};
