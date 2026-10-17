import { describe, expect, it } from 'vitest';
import { redisOptionsFromUrl } from './paths';

describe('redisOptionsFromUrl', () => {
  it('parses host, port, auth, db and TLS', () => {
    expect(redisOptionsFromUrl('redis://localhost:6379')).toEqual({
      host: 'localhost',
      port: 6379,
      maxRetriesPerRequest: null,
    });
    expect(redisOptionsFromUrl('rediss://default:s%40cret@redis.example.com:6380/2')).toEqual({
      host: 'redis.example.com',
      port: 6380,
      username: 'default',
      password: 's@cret',
      db: 2,
      tls: {},
      maxRetriesPerRequest: null,
    });
  });
});
