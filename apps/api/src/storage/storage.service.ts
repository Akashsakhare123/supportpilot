import { Injectable } from '@nestjs/common';
import { resolveStorageDir } from '@supportpilot/shared/node';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, resolve, sep } from 'node:path';

/**
 * File storage for uploads. Local disk today (STORAGE_DIR or <repo>/.data/uploads); an
 * S3-compatible driver (Cloudflare R2) implements the same three methods for production (T16).
 */
@Injectable()
export class StorageService {
  private readonly root = resolve(resolveStorageDir(process.env, __dirname));

  /** Absolute path for a key, refusing anything that would escape the storage root. */
  private pathFor(key: string): string {
    const full = resolve(this.root, key);
    if (!full.startsWith(this.root + sep)) throw new Error(`Invalid storage key: ${key}`);
    return full;
  }

  async put(key: string, data: Buffer): Promise<void> {
    const path = this.pathFor(key);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, data);
  }

  get(key: string): Promise<Buffer> {
    return readFile(this.pathFor(key));
  }

  async delete(key: string): Promise<void> {
    await rm(this.pathFor(key), { force: true });
  }
}
