import {
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { getSignedUrl as presign } from '@aws-sdk/s3-request-presigner';
import { config } from '@/core/config';
import { NotFoundError } from '@/core/errors';
import type { StorageAdapter, StoredObject, UploadInput } from './types';
import { buildStorageKey, checksum, validateUpload } from './validation';

/** S3-compatible storage: AWS S3, Cloudflare R2 or MinIO. */
export class S3StorageAdapter implements StorageAdapter {
  private readonly client: S3Client;
  private readonly bucket: string;

  constructor() {
    this.bucket = config.storage.bucket!;
    this.client = new S3Client({
      region: config.storage.region,
      ...(config.storage.endpoint ? { endpoint: config.storage.endpoint } : {}),
      forcePathStyle: config.storage.forcePathStyle,
      credentials: {
        accessKeyId: config.storage.accessKeyId!,
        secretAccessKey: config.storage.secretAccessKey!,
      },
    });
  }

  async upload(input: UploadInput): Promise<StoredObject> {
    validateUpload(input);

    const key = buildStorageKey(input.prefix, input.filename);
    const sum = checksum(input.body);

    await this.client.send(
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: key,
        Body: input.body,
        ContentType: input.contentType,
        // Force download rather than inline rendering. A stored PDF or SVG
        // rendered in-origin would be an XSS vector.
        ContentDisposition: 'attachment',
        ServerSideEncryption: 'AES256',
        Metadata: { checksum: sum },
      }),
    );

    return { key, size: input.body.length, contentType: input.contentType, checksum: sum };
  }

  async getSignedUrl(key: string, expiresInSeconds?: number): Promise<string> {
    return presign(this.client, new GetObjectCommand({ Bucket: this.bucket, Key: key }), {
      expiresIn: expiresInSeconds ?? config.storage.presignExpirySeconds,
    });
  }

  async download(key: string): Promise<Buffer> {
    try {
      const response = await this.client.send(
        new GetObjectCommand({ Bucket: this.bucket, Key: key }),
      );
      return Buffer.from(await response.Body!.transformToByteArray());
    } catch {
      throw new NotFoundError('File');
    }
  }

  async delete(key: string): Promise<void> {
    await this.client.send(new DeleteObjectCommand({ Bucket: this.bucket, Key: key }));
  }

  async exists(key: string): Promise<boolean> {
    try {
      await this.client.send(new HeadObjectCommand({ Bucket: this.bucket, Key: key }));
      return true;
    } catch {
      return false;
    }
  }
}
