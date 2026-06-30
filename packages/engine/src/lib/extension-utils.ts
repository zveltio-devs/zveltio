/**
 * Pure utilities used by the extension loader.
 *
 * Extracted from `extension-loader.ts` (PR #5) so the main loader file
 * is closer to its core responsibilities — install/register/unload —
 * and the helpers below can be unit-tested in isolation.
 *
 * Contents:
 *   - `inMemoryMutex` / `withExtensionLock` — same-process + cross-replica
 *     locking primitives used to serialise extension lifecycle ops.
 *   - `fetchWithRetry` — exponential-ish retry for transient HTTP errors.
 *   - `isPathInsideBase` — guard for path-traversal before filesystem
 *     writes.
 *   - `parseMigrationSql` / `ParsedMigration` — splits an extension's
 *     `.sql` file into UP + DOWN halves on the `-- DOWN` marker.
 *   - `directorySizeBytes` — recursive size sum, used by quota checks.
 *
 * Every export here is also re-exported from `extension-loader.ts` so
 * existing import sites (`import { ... } from './extension-loader.js'`)
 * keep working without code changes.
 */

import { sql as _sql } from 'kysely';
import type { Database } from '../db/index.js';
import { existsSync } from 'node:fs';
import { join } from 'path';

// ── Lifecycle mutex (same-process) ───────────────────────────────────────────
//
// In-flight extension operations are tracked here so a second concurrent
// install/uninstall/enable for the SAME extension serialises behind the
// first one. The map self-cleans when the in-flight Promise settles
// (see `inMemoryMutex` finally block).
//
// Trade-off: when a wrapped operation runs an external long task (download,
// npm install) the advisory-lock transaction stays open for that duration,
// holding one DB connection. Lifecycle ops are infrequent admin actions so
// this is acceptable. The pool default of 10 connections has plenty of headroom.
const extensionLifecycleLocks = new Map<string, Promise<unknown>>();

/**
 * Pure same-process mutex keyed by string. Concurrent calls with the same key
 * are serialized; different keys run in parallel. The map self-cleans when no
 * call is in flight for a key.
 *
 * Exported for tests; production callers should prefer withExtensionLock which
 * layers on the Postgres advisory lock for cross-replica safety.
 */
export async function inMemoryMutex<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const prior = extensionLifecycleLocks.get(key);
  if (prior) {
    await prior.catch(() => {
      /* swallow — not our concern */
    });
  }
  const current = fn();
  extensionLifecycleLocks.set(key, current);
  try {
    return await current;
  } finally {
    if (extensionLifecycleLocks.get(key) === current) {
      extensionLifecycleLocks.delete(key);
    }
  }
}

/**
 * Serialise lifecycle operations for an extension across both the
 * current process AND other engine replicas. Wraps `inMemoryMutex`
 * (which handles intra-process re-entry) around a Postgres
 * **session-level** `pg_advisory_lock` (which fences other replicas).
 *
 * Why a session lock on a reserved connection rather than
 * `pg_advisory_xact_lock` inside a transaction: an extension lifecycle op
 * (download → npm install → reload) can run for many seconds, and
 * `fn` is opaque (it opens its own transactions for DDL/migrations). The
 * old form held an open transaction for the whole duration, which pins an
 * MVCC snapshot and blocks `VACUUM` cluster-wide. A session-level lock gives
 * the SAME cross-replica mutual exclusion (one reserved connection holds the
 * lock) without an open transaction — `fn` runs its own statements on the
 * pool, and the lock is released in `finally`. If the connection dies first,
 * Postgres drops the lock on session end, so it can never leak.
 *
 * `hashtext` returns int4; `pg_advisory_lock` accepts int8 — Postgres
 * implicitly widens. Different extension names hash to different keys
 * (collisions are theoretically possible but harmless — at worst two
 * unrelated extensions would serialize each other).
 */
export async function withExtensionLock<T>(
  db: Database,
  name: string,
  fn: () => Promise<T>,
): Promise<T> {
  const key = `ext:${name}`;
  return inMemoryMutex(key, async () =>
    db.connection().execute(async (conn) => {
      await _sql`SELECT pg_advisory_lock(hashtext(${key}))`.execute(conn);
      try {
        return await fn();
      } finally {
        await _sql`SELECT pg_advisory_unlock(hashtext(${key}))`.execute(conn);
      }
    }),
  );
}

// ── Network ──────────────────────────────────────────────────────────────────

/**
 * `fetch` with exponential-ish backoff for transient (5xx + 429)
 * failures. 4xx are returned immediately because retrying won't fix
 * a client error. Network errors retry up to 3 attempts (500 ms,
 * 2 s, 5 s); the last error surfaces if all attempts fail.
 *
 * Used by the marketplace catalog + tarball download paths.
 */
export async function fetchWithRetry(url: string, init: RequestInit): Promise<Response> {
  const delays = [500, 2000, 5000];
  let lastError: Error | undefined;
  for (let attempt = 0; attempt < delays.length; attempt++) {
    try {
      const res = await fetch(url, init);
      if (!res.ok && res.status >= 400 && res.status < 500 && res.status !== 429) {
        return res;
      }
      if (!res.ok && attempt < delays.length - 1) {
        await Bun.sleep(delays[attempt]);
        continue;
      }
      return res;
    } catch (err) {
      lastError = err as Error;
      if (attempt < delays.length - 1) {
        await Bun.sleep(delays[attempt]);
        continue;
      }
    }
  }
  throw lastError ?? new Error(`fetchWithRetry exhausted retries for ${url}`);
}

// ── Filesystem safety ────────────────────────────────────────────────────────

/**
 * Returns true iff `target` resolves to a path strictly inside `base`.
 * Used before destructive filesystem operations to prevent path-traversal
 * attacks (e.g. an extension named "../../../etc" trying to escape
 * EXTENSIONS_DIR).
 *
 * Both paths are resolved to absolute form before comparison; we also reject
 * the case where they resolve to the exact same path (you should not delete
 * the base directory itself).
 */
export async function isPathInsideBase(base: string, target: string): Promise<boolean> {
  const { resolve, sep } = await import('path');
  const safeBase = resolve(base);
  const safeTarget = resolve(target);
  if (safeTarget === safeBase) return false;
  // Ensure base ends with a separator before the prefix check so
  // resolve('/foo') vs resolve('/foobar') is not a false match.
  const baseWithSep = safeBase.endsWith(sep) ? safeBase : safeBase + sep;
  return safeTarget.startsWith(baseWithSep);
}

// ── SQL parsing ──────────────────────────────────────────────────────────────

/**
 * Parsed SQL migration with separated UP / DOWN sections.
 *
 * The DOWN section starts at the first line that matches `-- DOWN` (case
 * insensitive). Everything before the marker is UP; everything after the
 * marker line is DOWN. If the marker is absent, the whole file is UP and
 * DOWN is null.
 */
export interface ParsedMigration {
  up: string;
  down: string | null;
}

export function parseMigrationSql(raw: string): ParsedMigration {
  const downIdx = raw.search(/^--\s*DOWN\b/im);
  if (downIdx < 0) {
    return { up: raw.trim(), down: null };
  }
  const up = raw.slice(0, downIdx).trim();
  // Skip the marker line itself, keep everything after the next newline.
  const downSection = raw.slice(downIdx);
  const firstNewline = downSection.indexOf('\n');
  const downBody = firstNewline >= 0 ? downSection.slice(firstNewline + 1).trim() : '';
  return { up, down: downBody.length > 0 ? downBody : null };
}

// ── Directory size (quota check) ─────────────────────────────────────────────

/**
 * Compute the total size of a directory recursively, in bytes.
 * Returns 0 if the directory does not exist or any traversal fails.
 */
export async function directorySizeBytes(dir: string): Promise<number> {
  if (!existsSync(dir)) return 0;
  let total = 0;
  try {
    const { readdir, stat } = await import('fs/promises');
    const stack: string[] = [dir];
    while (stack.length > 0) {
      const current = stack.pop()!;
      const entries = await readdir(current, { withFileTypes: true });
      for (const entry of entries) {
        const full = join(current, entry.name);
        if (entry.isDirectory()) {
          stack.push(full);
        } else if (entry.isFile()) {
          const st = await stat(full);
          total += st.size;
        }
      }
    }
  } catch {
    // Permission or transient FS errors — be lenient. A check that can't read
    // the directory shouldn't block install; better than false-positive quotas.
  }
  return total;
}
