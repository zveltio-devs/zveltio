/**
 * ADR 0034: an extension route's `host.files`, as its caller.
 *
 * The same `lib/stored-files.ts` path and the same checks `/api/storage` makes
 * for the same user (size, quota, folder in tenant, sniffing, visibility, a key's
 * `$storage` scope), in the request's transaction. The bytes follow it: a put's
 * are removed if it rolls back, a delete's only once it has committed. No
 * driver credential leaves the engine, and a route without a caller (one of its
 * `publicRoutes`) has no files.
 *
 * ADR 0052: an action called over HTTP gets the same, bound to the `$files` its
 * request carried: `read` of a handed id, one `put` under the handed name.
 */

import type { ActionHostFiles, CallerFiles, HostFile, RequestUser } from '@zveltio/sdk/extension';
import type { Database } from '../../db/index.js';
import { gatePrincipal } from '../../middleware/extension-auth-gate.js';
import { apiKeyHoldsScope, isApiKeyPrincipal, STORAGE_SCOPE } from '../data/index.js';
import { problem } from '../problem.js';
import { withSavepoint } from '../savepoint.js';
import { getStorage } from '../storage/index.js';
import {
  fileActorOf,
  type FileRefusal,
  readableFile,
  removeFile,
  storeFile,
} from '../stored-files.js';
import { getCurrentTenantTrx, onAfterCommit, onAfterRollback } from '../tenancy/index.js';
import { holdsCapability } from './capabilities.js';
import { type FileGrant, hostFile, storedBytes } from './file-grants.js';

type Caller = { trx: Database; tenantId: string; user: RequestUser };

/**
 * The gate's principal for request `c`, allowed `action` on stored files as
 * `/api/storage` would allow it (a key needs its `$storage` scope); else a throw.
 * Only for an extension holding `files`, only in the request's own transaction.
 */
function callerOf(
  c: unknown,
  extName: string,
  member: string,
  action: 'read' | 'create' | 'delete',
): Caller {
  if (!holdsCapability(extName, 'files')) {
    throw problem(
      'capability_required',
      403,
      `host.files.${member}: "${extName}" does not hold the "files" capability`,
    );
  }
  const p = gatePrincipal(c);
  if (!p?.trx || !p.tenantId) {
    throw problem('caller_required', 403, `host.files.${member}: only a signed-in caller's`);
  }
  // In the request's own transaction: its outcome is what the bytes follow.
  if (getCurrentTenantTrx() !== p.trx) {
    throw new Error(`host.files.${member}: acts only in its request's transaction`);
  }
  if (isApiKeyPrincipal(p.user) && !apiKeyHoldsScope(p.user.scopes, STORAGE_SCOPE, action)) {
    throw problem('scope_required', 403, `API key lacks the ${STORAGE_SCOPE} scope for ${action}`);
  }
  return { trx: p.trx, tenantId: p.tenantId, user: p.user };
}

const refused = (member: string, r: FileRefusal) =>
  problem('file_refused', r.status, `host.files.${member}: ${r.body.error}`);

// In a savepoint, so a refusal the extension catches leaves its transaction usable.
const inSavepoint = <T>(trx: Database, fn: () => Promise<T>) =>
  withSavepoint(trx, 'host_files', fn, (err) => {
    throw err;
  });

/** A new private file of the caller's, through `/api/storage`'s path; its bytes go if the request rolls back. */
async function putAsCaller(
  { trx, tenantId, user }: Caller,
  member: string,
  input: Parameters<typeof storeFile>[2],
): Promise<HostFile> {
  const actor = await fileActorOf(user, tenantId);
  const r = await inSavepoint(trx, () => storeFile(trx, actor, input));
  if (!('file' in r)) throw refused(member, r);
  const storage = getStorage();
  const path = r.file.storage_path;
  if (storage.isConfigured()) onAfterRollback(() => storage.delete(path));
  return hostFile(r.file);
}

/** `host.files` of one of `extName`'s routes, serving request `c`. */
export function callerFiles(c: unknown, extName: string): CallerFiles {
  return {
    put: async (name, bytes, options) => {
      const who = callerOf(c, extName, 'put', 'create');
      if (typeof name !== 'string' || name.length === 0 || !(bytes instanceof Uint8Array)) {
        throw new Error('host.files.put: (name: string, bytes: Uint8Array, { folderId? })');
      }
      return putAsCaller(who, 'put', { name, bytes, folderId: options?.folderId ?? null });
    },
    delete: async (id) => {
      const { trx, tenantId, user } = callerOf(c, extName, 'delete', 'delete');
      const actor = await fileActorOf(user, tenantId);
      const r = await inSavepoint(trx, () =>
        removeFile(trx, actor, String(id), (remove) => onAfterCommit(remove)),
      );
      if (!('ok' in r)) throw refused('delete', r);
    },
  };
}

/**
 * The `$files` an action's request carried (ADR 0032), and where it went: one
 * consumer, a job (`enqueue(…, { files: true })`) or the action's own
 * `host.files` (ADR 0052 decision 3). `put`: the action stored its one file.
 */
export interface HandedFiles {
  grant: FileGrant;
  to?: 'job' | 'action';
  put?: boolean;
}

/**
 * ADR 0052: `host.files` of an action called over HTTP, bound to `handed`, the
 * request's `$files`, and nothing else. `none`: why there is no grant (the
 * request carried none, or another action ran this one). As the caller, through
 * the same checks as a route's `host.files`, in the request's transaction.
 */
export function grantedFiles(
  c: unknown,
  extName: string,
  handed: HandedFiles | undefined,
  none: string,
): ActionHostFiles {
  const take = (member: string, action: 'read' | 'create') => {
    const who = callerOf(c, extName, member, action);
    if (!handed) throw problem('file_not_granted', 403, `host.files.${member}: ${none}`);
    if (handed.to === 'job') {
      throw problem(
        'file_not_granted',
        409,
        `host.files.${member}: the request's $files already went to a job`,
      );
    }
    handed.to = 'action';
    return { who, grant: handed.grant };
  };
  return {
    read: async (id) => {
      const { who, grant } = take('read', 'read');
      if (typeof id !== 'string' || !grant.read.includes(id)) {
        throw problem(
          'file_not_granted',
          403,
          `host.files.read(${String(id)}): the request did not hand this action that file`,
        );
      }
      const file = await readableFile(who.trx, await fileActorOf(who.user, who.tenantId), id);
      if (!file) throw problem('file_not_found', 404, `host.files.read: file not found: ${id}`);
      return { ...hostFile(file), bytes: await storedBytes('read', file) };
    },
    put: async (bytes, options) => {
      const { who, grant } = take('put', 'create');
      const write = grant.write;
      if (!write) {
        throw problem(
          'file_not_granted',
          403,
          'host.files.put: the request handed no $files.write',
        );
      }
      if (!(bytes instanceof Uint8Array)) {
        throw new Error('host.files.put: (bytes: Uint8Array, { contentType? })');
      }
      if (handed!.put)
        throw problem('file_already_put', 409, 'host.files.put: an action puts one file');
      if (bytes.byteLength > write.maxBytes) {
        throw problem(
          'file_too_large',
          413,
          `host.files.put: ${bytes.byteLength} bytes; the user allowed ${write.maxBytes}`,
        );
      }
      // Taken before the await: two puts in flight cannot both store.
      handed!.put = true;
      try {
        const typeHint = typeof options?.contentType === 'string' ? options.contentType : undefined;
        return await putAsCaller(who, 'put', { name: write.name, bytes, typeHint });
      } catch (err) {
        handed!.put = false;
        throw err;
      }
    },
  };
}
