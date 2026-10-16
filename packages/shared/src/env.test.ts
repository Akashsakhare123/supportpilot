import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { loadDotEnv, parseServerEnv } from './env';

const valid = {
  DATABASE_URL: 'postgres://u:p@localhost:5432/db',
  REDIS_URL: 'redis://localhost:6379',
};

describe('parseServerEnv', () => {
  it('applies defaults', () => {
    const env = parseServerEnv(valid);
    expect(env.API_PORT).toBe(4000);
    expect(env.NODE_ENV).toBe('development');
    expect(env.CORS_ORIGINS).toEqual(['http://localhost:3000', 'http://localhost:5173']);
  });

  it('coerces and splits values', () => {
    const env = parseServerEnv({
      ...valid,
      API_PORT: '8080',
      CORS_ORIGINS: 'https://a.com, https://b.com',
    });
    expect(env.API_PORT).toBe(8080);
    expect(env.CORS_ORIGINS).toEqual(['https://a.com', 'https://b.com']);
  });

  it('lists every missing variable in one error', () => {
    expect(() => parseServerEnv({})).toThrowError(/DATABASE_URL[\s\S]*REDIS_URL/);
  });
});

describe('loadDotEnv', () => {
  const key = 'SP_TEST_DOTENV_VALUE';
  afterEach(() => {
    delete process.env[key];
  });

  it('finds .env in a parent folder and stops at the workspace root', () => {
    const root = mkdtempSync(join(tmpdir(), 'sp-env-'));
    writeFileSync(join(root, 'pnpm-workspace.yaml'), 'packages: []\n');
    writeFileSync(join(root, '.env'), `${key}=from-root\n`);
    const nested = join(root, 'apps', 'api');
    mkdirSync(nested, { recursive: true });

    expect(loadDotEnv(nested)).toBe(join(root, '.env'));
    expect(process.env[key]).toBe('from-root');
  });

  it('returns null when there is no .env up to the workspace root', () => {
    const root = mkdtempSync(join(tmpdir(), 'sp-env-'));
    writeFileSync(join(root, 'pnpm-workspace.yaml'), 'packages: []\n');
    expect(loadDotEnv(root)).toBeNull();
  });
});
