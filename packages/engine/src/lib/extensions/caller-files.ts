/**
 * ADR 0034: an extension route's `host.files`, as its caller.
 *
 * The same `lib/stored-files.ts` path and the same checks `/api/storage` makes
 * for the same user (size, quota, folder in tenant, sniffing, visibility, a key's
 * `$storage` scope), in the request's transaction. The bytes follow it: a put's
 * are removed if it rolls back, a delete's only once it has committed. No
 * driver credential leaves the engine, and a route without a caller (one of its
 * `publicRoutes`) has no files.
 */

import type { CallerFiles } from '@zveltio/sdk/extension';
import { gatePrincipal } from '../../middleware/extension-auth-gate.js';
import { apiKeyHoldsScope, isApiKeyPrincipal, STORAGE_SCOPE } from '../data/index.js';
import { problem } from '../problem.js';
import { withSavepoint } from '../savepoint.js';
import { getStorage } from '../storage/index.js';
import { fileActorOf, type FileRefusal, removeFile, storeFile } from '../stored-files.js';
import { getCurrentTenantTrx, onAfterCommit, onAfterRollback } from '../tenancy/index.js';
import { holdsCapability } from './capabilities.js';
import { hostFile } from './file-grants.js';

/** `host.files` of one of `extName`'s routes, serving request `c`. */
export function callerFiles(c: unknown, extName: string): CallerFiles {
  /** The gate's principal for `c`, allowed `action` on stored files; else a throw. */
  const caller = (member: string, action: 'create' | 'delete') => {
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
      throw problem(
        'scope_required',
        403,
        `API key lacks the ${STORAGE_SCOPE} scope for ${action}`,
      );
    }
    return { trx: p.trx, tenantId: p.tenantId, user: p.user };
  };
  const refused = (member: string, r: FileRefusal) =>
    problem('file_refused', r.status, `host.files.${member}: ${r.body.error}`);
  // In a savepoint, so a refusal the route catches leaves its transaction usable.
  const inSavepoint = <T>(trx: Parameters<typeof withSavepoint>[0], fn: () => Promise<T>) =>
    withSavepoint(trx, 'host_files', fn, (err) => {
      throw err;
    });

  return {
    put: async (name, bytes, options) => {
      const { trx, tenantId, user } = caller('put', 'create');
      if (typeof name !== 'string' || name.length === 0 || !(bytes instanceof Uint8Array)) {
        throw new Error('host.files.put: (name: string, bytes: Uint8Array, { folderId? })');
      }
      const actor = await fileActorOf(user, tenantId);
      const r = await inSavepoint(trx, () =>
        storeFile(trx, actor, { name, bytes, folderId: options?.folderId ?? null }),
      );
      if (!('file' in r)) throw refused('put', r);
      const storage = getStorage();
      const path = r.file.storage_path;
      if (storage.isConfigured()) onAfterRollback(() => storage.delete(path));
      return hostFile(r.file);
    },
    delete: async (id) => {
      const { trx, tenantId, user } = caller('delete', 'delete');
      const actor = await fileActorOf(user, tenantId);
      const r = await inSavepoint(trx, () =>
        removeFile(trx, actor, String(id), (remove) => onAfterCommit(remove)),
      );
      if (!('ok' in r)) throw refused('delete', r);
    },
  };
}
