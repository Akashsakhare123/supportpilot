import {
  DeleteObjectCommand,
  GetObjectCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { type FileStorage, LocalFileStorage } from './storage';
import { resolveStorageDir } from './paths';

export interface S3StorageOptions {
  bucket: string;
  /** Endpoint for S3-compatible services, e.g. https://<account>.r2.cloudflarestorage.com. */
  endpoint?: string;
  region?: string;
  accessKeyId: string;
  secretAccessKey: string;
  /** Key prefix inside the bucket (default "uploads/"). */
  prefix?: string;
}

/** The S3 calls we use, so tests can pass a fake client. */
export interface S3Like {
  send(command: PutObjectCommand | GetObjectCommand | DeleteObjectCommand): Promise<unknown>;
}

/**
 * Upload storage in an S3-compatible bucket (Cloudflare R2, AWS S3, MinIO) for production
 * (T16): the API and the worker run on separate machines, so a local folder cannot be shared.
 * Keys are the same tenant-prefixed keys LocalFileStorage uses; private bucket, no public URLs.
 */
export class S3FileStorage implements FileStorage {
  readonly root: string;
  private readonly prefix: string;

  constructor(
    private readonly options: S3StorageOptions,
    private readonly client: S3Like = new S3Client({
      region: options.region || 'auto',
      endpoint: options.endpoint || undefined,
      credentials: { accessKeyId: options.accessKeyId, secretAccessKey: options.secretAccessKey },
      // R2 and MinIO address buckets by path.
      forcePathStyle: !!options.endpoint,
    }),
  ) {
    this.prefix = options.prefix ?? 'uploads/';
    this.root = `s3://${options.bucket}/${this.prefix}`;
  }

  /** Bucket key for a storage key; refuses keys that try to leave the prefix. */
  keyFor(key: string): string {
    if (!key || key.startsWith('/') || key.split(/[/\\]/).includes('..')) {
      throw new Error(`Invalid storage key: ${key}`);
    }
    return `${this.prefix}${key}`;
  }

  async put(key: string, data: Buffer): Promise<void> {
    await this.client.send(
      new PutObjectCommand({ Bucket: this.options.bucket, Key: this.keyFor(key), Body: data }),
    );
  }

  async get(key: string): Promise<Buffer> {
    const result = (await this.client.send(
      new GetObjectCommand({ Bucket: this.options.bucket, Key: this.keyFor(key) }),
    )) as { Body?: { transformToByteArray(): Promise<Uint8Array> } };
    if (!result.Body) throw new Error(`Empty object: ${key}`);
    return Buffer.from(await result.Body.transformToByteArray());
  }

  async delete(key: string): Promise<void> {
    await this.client.send(
      new DeleteObjectCommand({ Bucket: this.options.bucket, Key: this.keyFor(key) }),
    );
  }
}

/**
 * Storage from env: STORAGE_DRIVER=s3 with S3_BUCKET, S3_ACCESS_KEY_ID, S3_SECRET_ACCESS_KEY
 * (+ S3_ENDPOINT for R2 / MinIO, S3_REGION), otherwise a local folder (STORAGE_DIR).
 */
export function createFileStorage(
  env: NodeJS.ProcessEnv = process.env,
  startDir?: string,
): FileStorage & { root: string } {
  if ((env.STORAGE_DRIVER ?? 'local').toLowerCase() !== 's3') {
    return new LocalFileStorage(resolveStorageDir(env, startDir));
  }
  const missing = ['S3_BUCKET', 'S3_ACCESS_KEY_ID', 'S3_SECRET_ACCESS_KEY'].filter((k) => !env[k]);
  if (missing.length) throw new Error(`STORAGE_DRIVER=s3 needs ${missing.join(', ')}`);
  return new S3FileStorage({
    bucket: env.S3_BUCKET!,
    endpoint: env.S3_ENDPOINT,
    region: env.S3_REGION,
    accessKeyId: env.S3_ACCESS_KEY_ID!,
    secretAccessKey: env.S3_SECRET_ACCESS_KEY!,
  });
}
