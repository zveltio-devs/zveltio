/**
 * Single source of storage configuration.
 *
 * Resolves the driver + S3 settings from environment variables, with an
 * optional DB overlay (the `storage` row in zv_settings) layered on top so an
 * admin can configure/point-at object storage from the Studio without editing
 * env files. The overlay wins when present (admin intent); env is the base +
 * fallback for anything the overlay leaves unset.
 *
 * Drivers + `getStorage()` read exclusively from here, so a settings change
 * takes effect after `setStorageOverlay()` (which also resets the cached
 * driver).
 */

export interface S3Settings {
  endpoint: string;
  accessKey: string;
  secretKey: string;
  region: string;
  bucket: string;
  publicUrl: string;
}

export interface StorageConfig {
  driver: 's3' | 'local';
  localDir: string;
  s3: S3Settings;
}

/** DB overlay (subset of config). Empty until `setStorageOverlay` is called. */
let _overlay: Partial<{ driver: string; localDir: string; s3: Partial<S3Settings> }> = {};

/** Callback the index registers so changing config drops the cached driver. */
let _onChange: (() => void) | null = null;
export function _registerStorageOnChange(fn: () => void): void {
  _onChange = fn;
}

/** Apply the DB overlay (from zv_settings). Pass `{}` to clear it. */
export function setStorageOverlay(
  overlay: Partial<{ driver: string; localDir: string; s3: Partial<S3Settings> }>,
): void {
  _overlay = overlay ?? {};
  _onChange?.();
}

const DEFAULT_LOCAL_DIR = '/var/lib/zveltio/storage';

/** The effective, merged storage configuration. */
export function storageConfig(): StorageConfig {
  const env = process.env;
  const o = _overlay;
  const s3: S3Settings = {
    endpoint: (o.s3?.endpoint ?? env.S3_ENDPOINT ?? '').trim(),
    accessKey: o.s3?.accessKey ?? env.S3_ACCESS_KEY ?? '',
    secretKey: o.s3?.secretKey ?? env.S3_SECRET_KEY ?? '',
    region: o.s3?.region || env.S3_REGION || 'us-east-1',
    bucket: o.s3?.bucket || env.S3_BUCKET || 'zveltio',
    publicUrl: (o.s3?.publicUrl ?? env.S3_PUBLIC_URL ?? '').trim(),
  };

  const explicit = (o.driver || env.STORAGE_DRIVER || '').toLowerCase();
  const driver: 's3' | 'local' =
    explicit === 's3' || explicit === 'local' ? explicit : s3.endpoint ? 's3' : 'local';

  return {
    driver,
    localDir: o.localDir || env.STORAGE_LOCAL_DIR || DEFAULT_LOCAL_DIR,
    s3,
  };
}
