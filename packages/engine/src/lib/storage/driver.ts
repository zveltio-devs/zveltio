/**
 * Pluggable object-storage driver.
 *
 * The engine's file/media routes used to call aws4fetch (S3) directly, so a
 * self-hosted single-node install could not store files without standing up an
 * external S3-compatible object store. This interface abstracts the small
 * surface those routes actually need (put / get / delete / URL) behind a driver,
 * so the DEFAULT is a zero-dependency local-filesystem store (`local`), with the
 * existing S3 path (`s3`) kept for deployments that scale. Mirrors how Directus,
 * Appwrite, Strapi et al. ship a local default + optional cloud adapters.
 */

/** Bytes + the content-type to serve them with. */
export interface StorageObject {
  bytes: Uint8Array;
  contentType: string;
  size: number;
}

export interface PutOptions {
  /** MIME type to persist + serve (already content-sniffed by the caller). */
  contentType?: string;
}

export interface StorageDriver {
  /** Driver id for diagnostics/logs. */
  readonly kind: 's3' | 'local';

  /**
   * True when the driver can actually store bytes. `local` is always true;
   * `s3` is true only when S3_ENDPOINT is configured. Routes return 503 when
   * false, preserving the previous "Storage not configured" behaviour.
   */
  isConfigured(): boolean;

  /** Store `bytes` under `key` (e.g. "uploads/2026/uuid.pdf"). Overwrites. */
  put(key: string, bytes: Uint8Array, opts?: PutOptions): Promise<void>;

  /** Read the whole object, or null if it does not exist. */
  get(key: string): Promise<StorageObject | null>;

  /** Best-effort delete; never throws when the object is already gone. */
  delete(key: string): Promise<void>;

  /**
   * A stable URL a browser can GET directly. For `s3` this is the public bucket
   * URL; for `local` it is the engine's own `/files/<key>` route. Public by
   * unguessable path — same posture as the S3 public-bucket URLs used today.
   */
  publicUrl(key: string): string;

  /**
   * A time-limited URL for the object. For `s3` this is an aws4fetch presigned
   * GET; for `local` it is `/files/<key>?exp=…&sig=…` (HMAC-verified by the
   * serving route).
   */
  signedUrl(key: string, expiresInSec: number): Promise<string>;

  /**
   * A time-limited URL that accepts a PUT, or null when this store has no such
   * thing.
   *
   * It exists for one caller: uploading a backup off the machine. `put()` cannot
   * do that job — it takes the whole object as a `Uint8Array`, and a backup is
   * the largest file this product produces. The integrity check next door
   * already had to stop doing exactly that; its comment records what it cost.
   *
   * A presigned PUT lets the file be streamed straight from disk, which was
   * measured before this was written: 300 MB uploaded for 35 MB of RSS.
   *
   * `local` returns null, and that is not a gap — the store IS the machine, so
   * "upload the backup to it" is a copy from a directory to itself.
   */
  signedPutUrl(key: string, expiresInSec: number): Promise<string | null>;
}
