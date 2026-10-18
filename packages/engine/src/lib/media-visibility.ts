/**
 * Who may read a stored file.
 *
 * Historically `GET /api/media/files` (now extension-owned) required a session
 * and nothing else — no permission check, no owner filter — so every
 * authenticated user could list and download every file any colleague had ever
 * uploaded. On a Business OS for companies and public institutions that is HR's
 * scanned ID and finance's payroll export, readable by anyone with a login.
 *
 * It was not obviously wrong because `zv_media_files` serves two purposes
 * through one table. A CMS asset library WANTS tenant-wide reach: an editor
 * uploads the logo and everyone uses it. Personal storage does not. Nothing in
 * the schema said which a row was, so the code had to pick one answer for both
 * and picked the permissive one. Migration 028 adds the missing distinction;
 * this applies it.
 *
 * One helper rather than the same `or(...)` written at six call sites, because
 * a rule spelled out six times is a rule that will be missing from one of them
 * — which is what this audit kept finding.
 *
 * Note what does NOT go through here: a PUBLIC upload is served from its bare
 * URL with no authentication at all, which is the point of it, and that is what
 * a record's `file`/`image` field stores long-term (a private signed URL
 * expires in an hour, so it cannot be). Attachments therefore keep resolving
 * for colleagues regardless of the uploader's visibility setting.
 */

import { apiKeyRowId } from './data/index.js';

/** The only shape this needs from a query builder. */
interface Filterable<Q> {
  // biome-ignore lint/suspicious/noExplicitAny: Kysely's expression builder, over a runtime table
  where(fn: (eb: any) => unknown): Q;
}

/**
 * The owner column a principal is compared against. A session owns what it
 * uploaded (`created_by`). An API key's uploads record its issuer in
 * `created_by` — a foreign key into "user", which `apikey:<uuid>` is not — so
 * the key owns them through `created_by_api_key` (migration 021).
 */
function ownerColumn(principalId: string): ['created_by' | 'created_by_api_key', string] {
  return principalId.startsWith('apikey:')
    ? ['created_by_api_key', apiKeyRowId(principalId)]
    : ['created_by', principalId];
}

/**
 * Narrow a `zv_media_files` query to the files `principalId` may read in
 * `tenantId` — the tenant the request acts as (`tenantId(c)`).
 *
 * The tenant is part of the rule, not the caller's job. The row policy does not
 * pin it: it reads `zveltio_visible_tenants()`, which for a unit with a subtree
 * reach is that unit and everything below it, and for god every firm. Without
 * this predicate a `visibility = 'tenant'` file of a child unit matched here.
 *
 * Tenant admins are exempt from the owner rule, not from the tenant: they can
 * already delete any file in the tenant (`mayDeleteFile`), so hiding one from a
 * listing would be a lock on a door with no wall. Pass `isAdmin` from
 * `isTenantAdmin`, not from `user.role` — better-auth does not populate that.
 */
export function applyFileVisibility<Q extends Filterable<Q>>(
  query: Q,
  principalId: string,
  isAdmin: boolean,
  tenantId: string,
): Q {
  const inTenant = query.where((eb) => eb('tenant_id', '=', tenantId));
  if (isAdmin) return inTenant;
  const [column, owner] = ownerColumn(principalId);
  return inTenant.where((eb) => eb.or([eb('visibility', '=', 'tenant'), eb(column, '=', owner)]));
}

/** The columns the row checks read off an already-loaded `zv_media_files` row. */
interface FileRow {
  tenant_id?: string | null;
  visibility?: string | null;
  created_by?: string | null;
  created_by_api_key?: string | null;
}

/** Whether `principalId` uploaded this row. */
function ownsFile(file: FileRow, principalId: string): boolean {
  const [column, owner] = ownerColumn(principalId);
  return file[column] === owner;
}

/** Whether a single already-loaded row is readable by `principalId` in `tenantId`. */
export function mayReadFile(
  file: FileRow,
  principalId: string,
  isAdmin: boolean,
  tenantId: string,
): boolean {
  if (file.tenant_id !== tenantId) return false;
  if (isAdmin) return true;
  // A row written before migration 028 has no value only if something wrote it
  // outside the schema; treat the unknown as personal, which fails closed.
  return (file.visibility ?? 'personal') === 'tenant' || ownsFile(file, principalId);
}

/**
 * Whether `principalId` may delete this already-loaded row in `tenantId`: its
 * uploader, or a tenant admin. Reading a shared file and destroying it are
 * different acts, so `visibility` does not enter into it.
 */
export function mayDeleteFile(
  file: FileRow,
  principalId: string,
  isAdmin: boolean,
  tenantId: string,
): boolean {
  return file.tenant_id === tenantId && (isAdmin || ownsFile(file, principalId));
}
