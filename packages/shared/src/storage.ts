import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, resolve, sep } from 'node:path';

/** What the API (writes uploads) and the worker (reads them) need from file storage. */
export interface FileStorage {
  put(key: string, data: Buffer): Promise<void>;
  get(key: string): Promise<Buffer>;
  delete(key: string): Promise<void>;
}

/**
 * Local-disk storage under one root folder. An S3-compatible driver (Cloudflare R2) implements
 * the same interface for production (T16).
 */
export class LocalFileStorage implements FileStorage {
  readonly root: string;

  constructor(root: string) {
    this.root = resolve(root);
  }

  /** Absolute path for a key, refusing anything that would escape the storage root. */
  pathFor(key: string): string {
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
