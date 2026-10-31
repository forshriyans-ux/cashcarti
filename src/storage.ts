import { mkdir, writeFile, readFile, unlink } from 'node:fs/promises';
import { resolve } from 'node:path';
import {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
  DeleteObjectCommand,
} from '@aws-sdk/client-s3';
import type { Config } from './config.js';
export interface Storage {
  put(key: string, data: Buffer, mime: string): Promise<void>;
  get(key: string): Promise<Buffer>;
  delete(key: string): Promise<void>;
}
export function storage(c: Config): Storage {
  const check = (key: string) => {
    if (!/^[a-f0-9-]{36}\/(?:[a-f0-9-]{36})$/.test(key)) throw new Error('Invalid storage key');
    return key;
  };
  if (c.STORAGE_DRIVER === 's3') {
    const s3 = new S3Client({
      region: c.S3_REGION,
      endpoint: c.S3_ENDPOINT,
      forcePathStyle: !!c.S3_ENDPOINT,
    });
    return {
      async put(key, data, mime) {
        await s3.send(
          new PutObjectCommand({
            Bucket: c.S3_BUCKET,
            Key: check(key),
            Body: data,
            ContentType: mime,
            ServerSideEncryption: 'AES256',
          }),
        );
      },
      async get(key) {
        const r = await s3.send(new GetObjectCommand({ Bucket: c.S3_BUCKET, Key: check(key) }));
        if (!r.Body) throw new Error('Object missing');
        return Buffer.from(await r.Body.transformToByteArray());
      },
      async delete(key) {
        await s3.send(new DeleteObjectCommand({ Bucket: c.S3_BUCKET, Key: check(key) }));
      },
    };
  }
  const root = resolve(c.STORAGE_PATH);
  return {
    async put(key, data) {
      const target = resolve(root, check(key));
      await mkdir(resolve(target, '..'), { recursive: true, mode: 0o700 });
      await writeFile(target, data, { flag: 'wx', mode: 0o600 });
    },
    async get(key) {
      return readFile(resolve(root, check(key)));
    },
    async delete(key) {
      await unlink(resolve(root, check(key))).catch((e) => {
        if (e.code !== 'ENOENT') throw e;
      });
    },
  };
}
