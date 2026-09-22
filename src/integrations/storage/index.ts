import { config } from '@/core/config';
import { LocalStorageAdapter } from './local-adapter';
import type { StorageAdapter } from './types';

export type { StorageAdapter, StoredObject, UploadInput } from './types';
export { LocalStorageAdapter } from './local-adapter';
export { buildStorageKey, checksum, validateUpload } from './validation';

let instance: StorageAdapter | undefined;
let pending: Promise<StorageAdapter> | undefined;

/** Async for the same reason as the cache: dynamic import, not require(). */
export function getStorage(): Promise<StorageAdapter> {
  pending ??= build();
  return pending;
}

async function build(): Promise<StorageAdapter> {
  if (instance) return instance;

  if (config.storage.driver === 's3') {
    const { S3StorageAdapter } = await import('./s3-adapter');
    instance = new S3StorageAdapter();
  } else {
    instance = new LocalStorageAdapter();
  }

  return instance;
}

export function setStorage(adapter: StorageAdapter | undefined): void {
  instance = adapter;
  pending = adapter ? Promise.resolve(adapter) : undefined;
}
