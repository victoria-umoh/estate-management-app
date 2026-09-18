import { mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { NotFoundError } from '@/core/errors';
import type { StorageAdapter, StoredObject, UploadInput } from './types';
import { buildStorageKey, checksum, validateUpload } from './validation';

/**
 * Filesystem storage for development and tests.
 *
 * Rejected in production by the config schema: files would be local to one
 * instance and would not survive a redeploy.
 */
export class LocalStorageAdapter implements StorageAdapter {
  private readonly root: string;

  constructor(root = join(process.cwd(), 'tmp', 'uploads')) {
    this.root = resolve(root);
  }

  /**
   * Resolve a key to an absolute path, refusing anything that escapes the root.
   *
   * Keys are generated internally, but this is the last line of defence against
   * a traversal sequence reaching the filesystem.
   */
  private pathFor(key: string): string {
    const full = resolve(join(this.root, key));
    if (!full.startsWith(this.root + '/') && full !== this.root) {
      throw new NotFoundError('File');
    }
    return full;
  }

  async upload(input: UploadInput): Promise<StoredObject> {
    validateUpload(input);

    const key = buildStorageKey(input.prefix, input.filename);
    const path = this.pathFor(key);

    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, input.body);

    return {
      key,
      size: input.body.length,
      contentType: input.contentType,
      checksum: checksum(input.body),
    };
  }

  async getSignedUrl(key: string): Promise<string> {
    // No signing locally — the route handler still performs the permission
    // check, which is where authorisation actually lives.
    return `/api/v1/documents/local/${encodeURIComponent(key)}`;
  }

  async download(key: string): Promise<Buffer> {
    try {
      return await readFile(this.pathFor(key));
    } catch {
      throw new NotFoundError('File');
    }
  }

  async delete(key: string): Promise<void> {
    await rm(this.pathFor(key), { force: true });
  }

  async exists(key: string): Promise<boolean> {
    try {
      await stat(this.pathFor(key));
      return true;
    } catch {
      return false;
    }
  }
}
