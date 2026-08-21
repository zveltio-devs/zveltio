/**
 * Per-user storage quota.
 *
 * Core upload path: `POST /api/storage/upload`. The media library lives in the
 * `content/media` extension (`/ext/content/media`) and must call the same check
 * for any write into `zv_media_files`. A quota with a second unguarded door is
 * not a quota — that dual-door bug is why `/api/media` was removed from core.
 */

import type { Database } from '../db/index.js';
import { toNumber } from './numeric.js';

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

  // `SUM('size')` and `quota_bytes` are both BIGINT, so both arrive as strings.
  // This function was already right — the `Number()` on the sum meant the `+`
  // added rather than concatenated, and `<=` coerced the quota. It was right by
  // habit, not by construction: drop the `Number()` and `usedBytes + incomingBytes`
  // becomes "1024000512", compared lexicographically against the quota.
  // Converting both explicitly is what makes the next edit here safe.
  const usedBytes = toNumber(usageResult?.total, 0, 'zv_media_files.size sum');
  const quotaBytes = toNumber(quotaRecord?.quota_bytes, DEFAULT_QUOTA_BYTES, 'quota_bytes');
  return { ok: usedBytes + incomingBytes <= quotaBytes, usedBytes, quotaBytes };
}
