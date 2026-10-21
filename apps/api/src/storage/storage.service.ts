import { Injectable } from '@nestjs/common';
import { createFileStorage, type FileStorage } from '@supportpilot/shared/node';

/**
 * File storage for uploads: a local folder in development (STORAGE_DIR or <repo>/.data/uploads),
 * an S3-compatible bucket in production (STORAGE_DRIVER=s3, T16). The worker reads the same
 * storage through the same factory.
 */
@Injectable()
export class StorageService implements FileStorage {
  private readonly storage = createFileStorage(process.env, __dirname);

  get root(): string {
    return this.storage.root;
  }

  put(key: string, data: Buffer): Promise<void> {
    return this.storage.put(key, data);
  }

  get(key: string): Promise<Buffer> {
    return this.storage.get(key);
  }

  delete(key: string): Promise<void> {
    return this.storage.delete(key);
  }
}
