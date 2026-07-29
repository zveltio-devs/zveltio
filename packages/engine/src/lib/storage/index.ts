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

import { _registerStorageOnChange, storageConfig } from './config.js';
import type { StorageDriver } from './driver.js';
import { LocalDriver } from './local-driver.js';
import { S3Driver } from './s3-driver.js';

export type { StorageDriver, StorageObject, PutOptions } from './driver.js';
export { LocalDriver, safeLocalPath, verifySignedKey, signKey, localRoot } from './local-driver.js';
export { S3Driver } from './s3-driver.js';
export {
  storageConfig,
  setStorageOverlay,
  type StorageConfig,
  type S3Settings,
} from './config.js';
export { probeS3, probeLocal, type ProbeResult } from './probe.js';

let _driver: StorageDriver | null = null;

/** The process-wide storage driver (cached; dropped when config changes). */
export function getStorage(): StorageDriver {
  if (!_driver) _driver = storageConfig().driver === 's3' ? new S3Driver() : new LocalDriver();
  return _driver;
}

// A settings change (setStorageOverlay) must rebuild the driver.
_registerStorageOnChange(() => {
  _driver = null;
});

/** Test seam — reset the cached driver. */
export function _resetStorageForTests(): void {
  _driver = null;
}
