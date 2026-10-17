/** localStorage that never throws (private mode, blocked cookies, sandboxed iframes). */
const memory = new Map<string, string>();

export function load(key: string): string | null {
  try {
    return window.localStorage.getItem(key);
  } catch {
    return memory.get(key) ?? null;
  }
}

export function save(key: string, value: string | null): void {
  try {
    if (value === null) window.localStorage.removeItem(key);
    else window.localStorage.setItem(key, value);
  } catch {
    if (value === null) memory.delete(key);
    else memory.set(key, value);
  }
}

/** Anonymous, random visitor id kept per browser and widget key (no cookies, no fingerprinting). */
export function visitorIdFor(publicKey: string): string {
  const storageKey = `sp_visitor_${publicKey}`;
  const existing = load(storageKey);
  if (existing && /^[A-Za-z0-9_-]{8,64}$/.test(existing)) return existing;
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  const id = `v_${Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')}`;
  save(storageKey, id);
  return id;
}
