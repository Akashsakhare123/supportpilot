import { loadDotEnv, parseServerEnv, type ServerEnv } from '@supportpilot/shared/node';

/** Injection token for the validated environment. */
export const ENV = Symbol('ENV');

let cached: ServerEnv | undefined;

/** Load the repo-root .env (if any) and validate env vars once. Throws with every problem listed. */
export function loadEnv(): ServerEnv {
  if (!cached) {
    loadDotEnv(__dirname);
    cached = parseServerEnv(process.env);
  }
  return cached;
}
