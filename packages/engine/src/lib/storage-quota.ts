/**
 * Per-user storage quota.
 *
 * There are two ways to put a file into `zv_media_files`: `POST /api/media/files`
 * and `POST /api/storage/upload`. They write the same rows to the same table
 * and count against the same allowance — and only the first one checked it.
 * The second enforced a per-FILE size limit, which is a different question
 * entirely: a user at their limit could keep uploading indefinitely as long as
 * each file was under 50 MB, simply by using the other endpoint.
 *
 * A quota with a documented way around it is not a quota, so the check lives
 * here now and both routes call it. Anything that grows a third upload path
 * has one obvious thing to call.
 */

import type { Database } from '../db/index.js';

/** 5 GiB, the default when a user has no explicit row. */
export const DEFAULT_QUOTA_BYTES = 5_368_709_120;

export interface QuotaCheck {
  ok: boolean;
  usedBytes: number;
  quotaBytes: number;
}

/**
 * Would storing `incomingBytes` for `userId` exceed their allowance?
 *
 * `db` must be the request-scoped handle so the usage sum is counted inside
 * the caller's tenant, not across the instance.
 */
export async function checkStorageQuota(
  db: Database,
  tenantId: string | null,
  userId: string,
  incomingBytes: number,
): Promise<QuotaCheck> {
  let usage = db
    .selectFrom('zv_media_files')
    .select(({ fn }) => fn.sum('size').as('total'))
    .where('created_by', '=', userId)
    .where('deleted_at', 'is', null);
  if (tenantId) usage = usage.where('tenant_id', '=', tenantId);

  const [usageResult, quotaRecord] = await Promise.all([
    usage.executeTakeFirst(),
    db.selectFrom('zv_storage_quotas').selectAll().where('user_id', '=', userId).executeTakeFirst(),
  ]);

  const usedBytes = Number(usageResult?.total || 0);
  const quotaBytes = quotaRecord?.quota_bytes ?? DEFAULT_QUOTA_BYTES;
  return { ok: usedBytes + incomingBytes <= quotaBytes, usedBytes, quotaBytes };
}
