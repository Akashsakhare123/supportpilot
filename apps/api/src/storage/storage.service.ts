import { Injectable } from '@nestjs/common';
import { LocalFileStorage, resolveStorageDir } from '@supportpilot/shared/node';

/**
 * File storage for uploads: STORAGE_DIR or <repo>/.data/uploads. The worker reads the same
 * folder through the same LocalFileStorage class.
 */
@Injectable()
export class StorageService extends LocalFileStorage {
  constructor() {
    super(resolveStorageDir(process.env, __dirname));
  }
}
