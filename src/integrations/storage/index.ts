import { config } from '@/core/config';
import { LocalStorageAdapter } from './local-adapter';
import type * as S3AdapterModule from './s3-adapter';
import type { StorageAdapter } from './types';

export type { StorageAdapter, StoredObject, UploadInput } from './types';
export { LocalStorageAdapter } from './local-adapter';
export { buildStorageKey, checksum, validateUpload } from './validation';

let instance: StorageAdapter | undefined;

export function getStorage(): StorageAdapter {
  if (instance) return instance;

  if (config.storage.driver === 's3') {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { S3StorageAdapter } = require('./s3-adapter') as typeof S3AdapterModule;
    instance = new S3StorageAdapter();
  } else {
    instance = new LocalStorageAdapter();
  }

  return instance;
}

export function setStorage(adapter: StorageAdapter | undefined): void {
  instance = adapter;
}
