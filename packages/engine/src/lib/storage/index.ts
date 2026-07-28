/**
 * Storage-driver selection.
 *
 *   STORAGE_DRIVER=local|s3   explicit choice
 *   (unset)                   → `s3` when S3_ENDPOINT is set (back-compat),
 *                               otherwise `local` (the self-hosted default)
 *
 * So an existing S3-configured install keeps its exact behaviour, while a fresh
 * single-node install stores files on local disk with zero external dependency.
 */

import type { StorageDriver } from './driver.js';
import { LocalDriver } from './local-driver.js';
import { S3Driver } from './s3-driver.js';

export type { StorageDriver, StorageObject, PutOptions } from './driver.js';
export { LocalDriver, safeLocalPath, verifySignedKey, signKey, localRoot } from './local-driver.js';
export { S3Driver } from './s3-driver.js';

let _driver: StorageDriver | null = null;

function selectKind(): 's3' | 'local' {
  const explicit = process.env.STORAGE_DRIVER?.toLowerCase();
  if (explicit === 's3' || explicit === 'local') return explicit;
  return process.env.S3_ENDPOINT ? 's3' : 'local';
}

/** The process-wide storage driver (cached). */
export function getStorage(): StorageDriver {
  if (!_driver) _driver = selectKind() === 's3' ? new S3Driver() : new LocalDriver();
  return _driver;
}

/** Test seam — reset the cached driver (e.g. after changing env in a test). */
export function _resetStorageForTests(): void {
  _driver = null;
}
