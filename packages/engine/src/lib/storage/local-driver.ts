/**
 * Local-filesystem storage driver — the zero-dependency DEFAULT for self-hosted
 * single-node installs. Objects are files under STORAGE_LOCAL_DIR; the engine
 * serves them from its own `GET /files/<key>` route (see routes/files.ts).
 *
 * - Writes are atomic (temp file + rename) so a crash mid-upload never leaves a
 *   half-written object.
 * - Content-type is persisted in a `<file>.meta` sidecar (survives restarts).
 * - Keys are confined under the root (path-traversal is rejected).
 * - `signedUrl` is an HMAC over `key|exp` (secret = BETTER_AUTH_SECRET), which
 *   the serving route verifies — the local equivalent of an S3 presigned URL.
 */

import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { mkdir, rename, rm, stat } from 'node:fs/promises';
import { dirname, join, resolve, sep } from 'node:path';
import { storageConfig } from './config.js';
import type { PutOptions, StorageDriver, StorageObject } from './driver.js';

export function localRoot(): string {
  return resolve(storageConfig().localDir);
}

/**
 * Whether a key may be served over `/files/*` WITHOUT a signature. Files are
 * private by default (a valid HMAC signature is required); only explicitly
 * public namespaces are open. `media/` holds display assets (images shown in the
 * Studio + on the public web host); `public/` is the general public opt-in. Any
 * other key (e.g. `uploads/…` business files, HR docs, contracts) must present a
 * valid, unexpired signature — so a signed link can't be stripped to bare path
 * for permanent unauthenticated access.
 */
export function isPublicKey(key: string): boolean {
  const k = key.replace(/^\/+/, '');
  return k.startsWith('public/') || k.startsWith('media/');
}

/** Resolve `key` under the root, rejecting traversal (`..`, absolute escapes). */
export function safeLocalPath(key: string): string {
  const root = localRoot();
  const full = resolve(root, key.replace(/^\/+/, ''));
  if (full !== root && !full.startsWith(root + sep)) {
    throw new Error(`storage: key escapes the storage root: ${key}`);
  }
  return full;
}

function urlSecret(): string {
  const s = process.env.BETTER_AUTH_SECRET;
  if (!s) throw new Error('storage(local): BETTER_AUTH_SECRET is required to sign file URLs');
  return s;
}

/** HMAC-SHA256(key|exp) → hex. Shared by signedUrl + the serving route. */
export function signKey(key: string, exp: number): string {
  return createHmac('sha256', urlSecret()).update(`${key}|${exp}`).digest('hex');
}

/** Constant-time verify of a `/files` signed request. Returns true if valid + unexpired. */
export function verifySignedKey(key: string, exp: number, sig: string): boolean {
  if (!Number.isFinite(exp) || exp * 1000 < Date.now()) return false;
  const expected = signKey(key, exp);
  const a = Buffer.from(expected, 'hex');
  const b = Buffer.from(sig, 'hex');
  return a.length === b.length && timingSafeEqual(a, b);
}

function baseUrl(): string {
  const explicit = process.env.BASE_URL || process.env.BETTER_AUTH_URL;
  if (explicit) return explicit.replace(/\/$/, '');
  return `http://localhost:${process.env.PORT || '3000'}`;
}

export class LocalDriver implements StorageDriver {
  readonly kind = 'local' as const;

  isConfigured(): boolean {
    return true; // local disk is always available
  }

  async put(key: string, bytes: Uint8Array, opts?: PutOptions): Promise<void> {
    const full = safeLocalPath(key);
    await mkdir(dirname(full), { recursive: true });
    // Atomic: write a temp sibling, then rename over the target.
    const tmp = `${full}.tmp-${randomBytes(6).toString('hex')}`;
    await Bun.write(tmp, bytes);
    await rename(tmp, full);
    await Bun.write(`${full}.meta`, opts?.contentType || 'application/octet-stream');
  }

  async get(key: string): Promise<StorageObject | null> {
    const full = safeLocalPath(key);
    const file = Bun.file(full);
    if (!(await file.exists())) return null;
    const bytes = new Uint8Array(await file.arrayBuffer());
    let contentType = 'application/octet-stream';
    const meta = Bun.file(`${full}.meta`);
    if (await meta.exists()) contentType = (await meta.text()).trim() || contentType;
    return { bytes, contentType, size: bytes.length };
  }

  async delete(key: string): Promise<void> {
    const full = safeLocalPath(key);
    await rm(full, { force: true }).catch(() => {});
    await rm(`${full}.meta`, { force: true }).catch(() => {});
  }

  publicUrl(key: string): string {
    return `${baseUrl()}/files/${key.replace(/^\/+/, '')}`;
  }

  /**
   * Null, always. The local store IS this machine, so "upload the backup to it"
   * would copy a file into the directory it already lives in — which is not an
   * off-site copy, and pretending otherwise is the thing this whole area kept
   * doing.
   */
  async signedPutUrl(_key: string, _expiresInSec: number): Promise<string | null> {
    return null;
  }

  async signedUrl(key: string, expiresInSec: number): Promise<string> {
    const exp = Math.floor(Date.now() / 1000) + expiresInSec;
    const k = key.replace(/^\/+/, '');
    return `${baseUrl()}/files/${k}?exp=${exp}&sig=${signKey(k, exp)}`;
  }

  /** Cheap existence/size probe (used by tests). */
  async head(key: string): Promise<{ size: number } | null> {
    try {
      const s = await stat(safeLocalPath(key));
      return { size: s.size };
    } catch {
      return null;
    }
  }
}

// Re-export for the serving route without importing the class.
export { join as joinPath };
