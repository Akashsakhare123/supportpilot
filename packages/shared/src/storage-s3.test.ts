import { DeleteObjectCommand, GetObjectCommand, PutObjectCommand } from '@aws-sdk/client-s3';
import { describe, expect, it } from 'vitest';
import { LocalFileStorage } from './storage';
import { createFileStorage, type S3Like, S3FileStorage } from './storage-s3';

/** In-memory bucket that records the commands it receives. */
function fakeBucket() {
  const objects = new Map<string, Buffer>();
  const calls: string[] = [];
  const client: S3Like = {
    async send(command) {
      const input = command.input as { Bucket: string; Key: string; Body?: Buffer };
      calls.push(`${command.constructor.name} ${input.Bucket}/${input.Key}`);
      if (command instanceof PutObjectCommand) objects.set(input.Key, input.Body!);
      if (command instanceof DeleteObjectCommand) objects.delete(input.Key);
      if (command instanceof GetObjectCommand) {
        const body = objects.get(input.Key);
        if (!body) throw new Error('NoSuchKey');
        return { Body: { transformToByteArray: async () => new Uint8Array(body) } };
      }
      return {};
    },
  };
  return { client, objects, calls };
}

const options = { bucket: 'sp', accessKeyId: 'k', secretAccessKey: 's' };

describe('S3FileStorage', () => {
  it('stores, reads and deletes objects under the uploads/ prefix', async () => {
    const bucket = fakeBucket();
    const storage = new S3FileStorage(options, bucket.client);
    await storage.put('tenant-1/doc.md', Buffer.from('# Hello'));
    expect((await storage.get('tenant-1/doc.md')).toString()).toBe('# Hello');
    await storage.delete('tenant-1/doc.md');
    await expect(storage.get('tenant-1/doc.md')).rejects.toThrow();
    expect(bucket.calls[0]).toBe('PutObjectCommand sp/uploads/tenant-1/doc.md');
    expect(storage.root).toBe('s3://sp/uploads/');
  });

  it('refuses keys that try to leave the prefix', () => {
    const storage = new S3FileStorage(options, fakeBucket().client);
    for (const key of ['../other/x', 'a/../../x', '/abs', '']) {
      expect(() => storage.keyFor(key)).toThrow(/Invalid storage key/);
    }
  });
});

describe('createFileStorage', () => {
  it('uses a local folder by default and S3 when configured', () => {
    expect(createFileStorage({ STORAGE_DIR: './tmp-uploads' })).toBeInstanceOf(LocalFileStorage);
    expect(
      createFileStorage({
        STORAGE_DRIVER: 's3',
        S3_BUCKET: 'sp',
        S3_ACCESS_KEY_ID: 'k',
        S3_SECRET_ACCESS_KEY: 's',
        S3_ENDPOINT: 'https://account.r2.cloudflarestorage.com',
      }),
    ).toBeInstanceOf(S3FileStorage);
  });

  it('says which settings are missing', () => {
    expect(() => createFileStorage({ STORAGE_DRIVER: 's3', S3_BUCKET: 'sp' })).toThrow(
      'STORAGE_DRIVER=s3 needs S3_ACCESS_KEY_ID, S3_SECRET_ACCESS_KEY',
    );
  });
});
