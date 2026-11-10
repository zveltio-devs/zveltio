/**
 * ADR 0032: a job reaches only the stored files its user hands it.
 *
 * The user hands them in the action request, as `$files` beside the input;
 * `admitFileGrant` checks them as the caller before the action runs, the action
 * passes them to one job (`host.enqueue(job, input, { files: true })`), and the
 * job's payload records them. `jobFiles` is that job's `host.files`: `get` of a
 * granted id, checked again as the enqueuer on every call, and one `put` bound
 * to the granted name and size. Nothing else: no delete, no listing, no other id.
 */

import { sql } from 'kysely';
import { z } from 'zod';
import type { HostFile, HostFiles, RequestUser } from '@zveltio/sdk/extension';
import { type Database, getDb } from '../../db/index.js';
import {
  apiKeyHoldsScope,
  apiKeyRowId,
  isApiKeyPrincipal,
  STORAGE_SCOPE,
  stillAuthenticated,
} from '../data/index.js';
import { mayReadFile } from '../media-visibility.js';
import { problem } from '../problem.js';
import { queueRoleWindow } from '../role-window.js';
import { withSavepoint } from '../savepoint.js';
import { getStorage } from '../storage/index.js';
import {
  type FileActor,
  type FileRefusal,
  fileActorOf,
  maxUploadBytes,
  readableFile,
  type StoredFile,
  storeFile,
  UUID_RE,
} from '../stored-files.js';
import { stillInTenant } from '../tenancy/index.js';

/** What the user handed: files a job may read, and the one it may store. */
export interface FileGrant {
  read: string[];
  write?: { name: string; maxBytes: number };
}

/**
 * What one call, and one run, of a job may move through `host.files` (ADR 0031
 * decision 4). Mail attachments run to 25 MB; the engine holds a call's bytes
 * whole, as the storage drivers do.
 */
export const JOB_FILE_LIMITS = { callBytes: 32 * 1024 * 1024, runBytes: 64 * 1024 * 1024 };

const GRANT = z
  .object({
    read: z.array(z.string().regex(UUID_RE, 'not a uuid')).max(32).default([]),
    write: z
      .object({ name: z.string().min(1).max(255), maxBytes: z.number().int().positive() })
      .strict()
      .optional(),
  })
  .strict();

/**
 * `$files` of an action request, checked as `user` in the request transaction
 * `trx`, before the action's code runs. Throws the refusal; a refused call
 * queues nothing. A file the caller cannot read is 404, as `/api/storage/:id`
 * answers.
 */
export async function admitFileGrant(
  trx: Database,
  user: RequestUser,
  tenantId: string,
  raw: unknown,
): Promise<FileGrant> {
  const parsed = GRANT.safeParse(raw);
  if (!parsed.success) {
    throw problem(
      'invalid_files',
      400,
      '$files is { read?: uuid[] (at most 32), write?: { name, maxBytes } }',
      parsed.error.issues,
    );
  }
  const grant: FileGrant = { ...parsed.data, read: [...new Set(parsed.data.read)] };
  const { write } = grant;
  if (isApiKeyPrincipal(user)) {
    for (const [need, action] of [
      [grant.read.length > 0, 'read'],
      [write, 'create'],
    ] as const) {
      if (need && !apiKeyHoldsScope(user.scopes, STORAGE_SCOPE, action)) {
        throw problem(
          'scope_required',
          403,
          `API key lacks the ${STORAGE_SCOPE} scope for ${action}`,
        );
      }
    }
  }
  if (write) {
    // Any type: a file outside the inline types is served only as a download (ADR 0033).
    const max = Math.min(JOB_FILE_LIMITS.callBytes, maxUploadBytes());
    if (write.maxBytes > max) {
      throw problem('file_too_large', 413, `$files.write.maxBytes is at most ${max}`);
    }
  }
  if (grant.read.length > 0) {
    const actor = await fileActorOf(user, tenantId);
    for (const id of grant.read) {
      if (!(await readableFile(trx, actor, id))) {
        throw problem('file_not_found', 404, `File not found: ${id}`);
      }
    }
  }
  return grant;
}

/**
 * Run `fn` on the job's transaction `trx` as the engine's own work: with
 * `zveltio.actor` off, so migration 115's per-user policies stand down (the
 * tenant one does not), and back on after. Alone on the transaction: no other
 * statement of the run lands inside the window.
 */
function withoutActor<T>(trx: Database, fn: () => Promise<T>): Promise<T> {
  return queueRoleWindow(trx, async () => {
    const set = await sql<{ prev: string | null }>`
      SELECT current_setting('zveltio.actor', true) AS prev,
             set_config('zveltio.actor', 'off', true)`.execute(trx);
    const restore = () =>
      sql`SELECT set_config('zveltio.actor', ${set.rows[0]?.prev ?? ''}, true)`.execute(trx);
    try {
      const out = await fn();
      await restore();
      return out;
    } catch (err) {
      // A failed statement aborted the (sub)transaction, whose rollback restores it.
      await restore().catch(() => undefined);
      throw err;
    }
  });
}

/**
 * The user who handed the job its files, as `/api/storage` would take them now
 * for `action`, or null when it would refuse them: a key revoked, expired or
 * without `$storage` for `action`; a user barred or deleted; either no longer
 * in the tenant. On the pool, as the realtime sweep asks it.
 */
async function enqueuerNow(
  enqueuedBy: string,
  author: string | null,
  tenantId: string,
  action: 'read' | 'create',
): Promise<FileActor | null> {
  const db = getDb();
  let user: Pick<RequestUser, 'id' | 'rlsBypass' | 'authorUserId'>;
  if (isApiKeyPrincipal({ id: enqueuedBy })) {
    const keyId = apiKeyRowId(enqueuedBy);
    const { keys } = await stillAuthenticated(db, [{ kind: 'api_key', keyId, issuerId: author }]);
    const key = keys.get(keyId);
    if (!key || !apiKeyHoldsScope(key.scopes, STORAGE_SCOPE, action)) return null;
    user = { id: enqueuedBy, rlsBypass: key.rlsBypass, authorUserId: author };
  } else {
    if (!author || author !== enqueuedBy) return null;
    const live = await db
      .selectFrom('user')
      .select('id')
      .where('id', '=', author)
      .where((eb) => eb.or([eb('banned', 'is', null), eb('banned', '=', false)]))
      .executeTakeFirst();
    if (!live) return null;
    user = { id: author };
  }
  const principal = isApiKeyPrincipal(user)
    ? { kind: 'api_key', issuerId: author }
    : { kind: 'session', userId: user.id };
  const inTenant = await stillInTenant(db, [{ tenantId, principal }]);
  if (!inTenant({ tenantId, principal })) return null;
  return fileActorOf(user, tenantId);
}

/** A stored file as `host.files` answers it. */
export const hostFile = (f: StoredFile): HostFile => ({
  id: f.id,
  name: f.original_name,
  contentType: f.mimetype,
  size: Number(f.size),
});

/**
 * `host.files` of one attempt of job `jobId`, in its tenant transaction `trx`
 * (ADR 0032 decision 2). `held`: the extension holds `files`. `grant`: what the
 * payload records, absent for a job handed none. `run` lives as long as the
 * attempt (its byte budget, whether it has put); `onRollback` removes a put's
 * bytes if `trx` rolls back.
 */
export function jobFiles(o: {
  extName: string;
  held: boolean;
  trx: Database;
  tenantId: string;
  jobId: string;
  enqueuedBy: string;
  author: string | null;
  grant: FileGrant | undefined;
  run: { bytes: number; put: boolean };
  onRollback: (fn: () => Promise<unknown>) => void;
}): HostFiles {
  const { trx, tenantId, grant, run } = o;
  const need = (member: string) => {
    if (!o.held) {
      throw problem(
        'capability_required',
        403,
        `host.files.${member}: "${o.extName}" does not hold the "files" capability ` +
          '(declared in its manifest and approved by an administrator)',
      );
    }
  };
  const notGranted = (what: string) =>
    problem('file_not_granted', 403, `host.files.${what}: the user did not hand this job that`);
  // Asked before the bytes are read or stored, so a refused call costs nothing.
  const room = (member: string, n: number) => {
    const { callBytes, runBytes } = JOB_FILE_LIMITS;
    if (n > callBytes) {
      throw problem(
        'file_too_large',
        413,
        `host.files.${member}: ${n} bytes; a call moves at most ${callBytes}`,
      );
    }
    if (run.bytes + n > runBytes) {
      throw problem(
        'file_budget_exceeded',
        413,
        `host.files.${member}: a run moves at most ${runBytes} bytes`,
      );
    }
  };
  const refused = (member: string, r: FileRefusal) =>
    problem('file_refused', r.status, `host.files.${member}: ${r.body.error}`);
  // The one row, read as the engine's work: under 115 the job's own view holds
  // no personal file, its author's included (ADR 0028 decision 4).
  const row = (id: string, live: boolean) =>
    withoutActor(trx, () => {
      let q = trx
        .selectFrom('zv_media_files')
        .selectAll()
        .where('tenant_id', '=', tenantId)
        .where('id', '=', id);
      if (live) q = q.where('deleted_at', 'is', null);
      return q.executeTakeFirst();
    });
  const storage = getStorage();
  return {
    get: async (id) => {
      need('get');
      if (typeof id !== 'string' || !grant?.read.includes(id)) throw notGranted(`get(${id})`);
      // As `/api/storage/:id` would answer the enqueuer now, not as the author:
      // a key sees less than its issuer.
      const actor = await enqueuerNow(o.enqueuedBy, o.author, tenantId, 'read');
      if (!actor) return null;
      const file = await row(id, true);
      if (!file || !mayReadFile(file, actor.principalId, actor.seesAll, tenantId)) return null;
      // The row's size first, so a file past the limits is never read into memory.
      room('get', Number(file.size));
      if (!storage.isConfigured()) {
        throw problem('storage_not_configured', 503, 'Storage not configured');
      }
      const obj = await storage.get(file.storage_path).catch((err: unknown) => {
        console.error('storage: read failed', file.id, err);
        return undefined;
      });
      if (!obj) {
        throw problem(
          'file_bytes_unavailable',
          502,
          `host.files.get: ${file.id} could not be read`,
        );
      }
      room('get', obj.bytes.byteLength);
      run.bytes += obj.bytes.byteLength;
      return { ...hostFile(file), bytes: obj.bytes };
    },
    put: async (bytes) => {
      need('put');
      const write = grant?.write;
      if (!write) throw notGranted('put');
      if (!(bytes instanceof Uint8Array)) throw new Error('host.files.put: (bytes: Uint8Array)');
      if (run.put) throw problem('file_already_put', 409, 'host.files.put: a job puts one file');
      run.put = true;
      try {
        if (bytes.byteLength > write.maxBytes) {
          throw problem(
            'file_too_large',
            413,
            `host.files.put: ${bytes.byteLength} bytes; the user allowed ${write.maxBytes}`,
          );
        }
        room('put', bytes.byteLength);
        const actor = await enqueuerNow(o.enqueuedBy, o.author, tenantId, 'create');
        if (!actor) {
          throw problem('file_refused', 403, 'host.files.put: the user may no longer upload here');
        }
        // An earlier attempt's put committed (a job with egress commits each
        // call): the same file, stored and counted once.
        const earlier = await row(o.jobId, false);
        if (earlier) return hostFile(earlier);
        run.bytes += bytes.byteLength;
        // In a savepoint, so a refused insert does not abort the run's
        // transaction; with no actor, as 115's insert policy refuses a
        // `created_by` a job writes. Recorded as the enqueuer's own upload.
        const r = await withSavepoint(
          trx,
          'host_files',
          () =>
            withoutActor(trx, () =>
              storeFile(trx, actor, { id: o.jobId, name: write.name, bytes }),
            ),
          (err) => {
            throw err;
          },
        );
        if (!('file' in r)) throw refused('put', r);
        const path = r.file.storage_path;
        if (storage.isConfigured()) o.onRollback(() => storage.delete(path));
        return hostFile(r.file);
      } catch (err) {
        run.put = false;
        throw err;
      }
    },
  };
}
