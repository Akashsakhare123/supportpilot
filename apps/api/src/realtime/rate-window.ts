/**
 * Sliding-window counter kept on a socket: true (and counted) while fewer than `limit` events
 * happened in the last `windowMs`. Used to drop floods of ephemeral events such as typing.
 */
export function withinRate(
  times: number[],
  limit: number,
  windowMs: number,
  now = Date.now(),
): boolean {
  while (times.length && now - times[0]! >= windowMs) times.shift();
  if (times.length >= limit) return false;
  times.push(now);
  return true;
}
