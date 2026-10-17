import { loadDotEnv, parseServerEnv, type ApiEnv } from '@supportpilot/shared/node';

/** Injection token for the validated environment. */
export const ENV = Symbol('ENV');

let cached: ApiEnv | undefined;

/** Load the repo-root .env (if any) and validate env vars once. Throws with every problem listed. */
export function loadEnv(): ApiEnv {
  if (!cached) {
    loadDotEnv(__dirname);
    cached = parseServerEnv(process.env);
  }
  return cached;
}
