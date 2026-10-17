import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { LocalFileStorage } from './storage';

describe('LocalFileStorage', () => {
  let dir: string;
  afterAll(async () => {
    if (dir) await rm(dir, { recursive: true, force: true });
  });

  it('stores, reads and deletes files under its root', async () => {
    dir = await mkdtemp(join(tmpdir(), 'sp-storage-'));
    const storage = new LocalFileStorage(dir);
    await storage.put('tenant-a/doc.md', Buffer.from('# Hi'));
    expect((await storage.get('tenant-a/doc.md')).toString()).toBe('# Hi');
    await storage.delete('tenant-a/doc.md');
    await expect(storage.get('tenant-a/doc.md')).rejects.toThrow();
    await storage.delete('missing.md'); // deleting a missing file is fine
  });

  it('refuses keys that escape the root', () => {
    const storage = new LocalFileStorage('/srv/uploads');
    expect(() => storage.pathFor('../etc/passwd')).toThrow(/Invalid storage key/);
    expect(() => storage.pathFor('/etc/passwd')).toThrow(/Invalid storage key/);
  });
});
