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

/** The only shape this needs from a query builder. */
interface Filterable<Q> {
  // biome-ignore lint/suspicious/noExplicitAny: Kysely's expression builder, over a runtime table
  where(fn: (eb: any) => unknown): Q;
}

/**
 * Narrow a `zv_media_files` query to the files `userId` may read.
 *
 * Tenant admins are exempt: they can already delete any file in the tenant
 * (`mayDeleteFile`), so hiding one from a listing would be a lock on a door
 * with no wall. Pass `isAdmin` from `isTenantAdmin`, not from `user.role` —
 * better-auth does not populate that.
 */
export function applyFileVisibility<Q extends Filterable<Q>>(
  query: Q,
  userId: string,
  isAdmin: boolean,
): Q {
  if (isAdmin) return query;
  return query.where((eb) =>
    eb.or([eb('visibility', '=', 'tenant'), eb('created_by', '=', userId)]),
  );
}

/** Whether a single already-loaded row is readable by `userId`. */
export function mayReadFile(
  file: { visibility?: string | null; created_by?: string | null },
  userId: string,
  isAdmin: boolean,
): boolean {
  if (isAdmin) return true;
  // A row written before migration 028 has no value only if something wrote it
  // outside the schema; treat the unknown as personal, which fails closed.
  return (file.visibility ?? 'personal') === 'tenant' || file.created_by === userId;
}
