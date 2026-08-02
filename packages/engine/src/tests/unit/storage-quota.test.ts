/**
 * Per-user storage quota.
 *
 * There are two ways to put a file into `zv_media_files` — `/api/media/upload`
 * and `/api/storage/upload` — and they draw on the same allowance. Only the
 * first checked it; the second enforced a per-FILE size limit, which answers a
 * different question. A user at their limit could keep uploading indefinitely
 * through the other endpoint as long as each file stayed under 50 MB, so the
 * quota had a documented way around it.
 *
 * The check lives in one place now. These cases pin what it counts and where
 * it draws the line.
 */

import { describe, expect, it } from 'bun:test';
import type { Database } from '../../db/index.js';
import { DEFAULT_QUOTA_BYTES, checkStorageQuota } from '../../lib/storage-quota.js';
import { CannedDb } from './fixtures/canned-db.js';

const TENANT = '00000000-0000-0000-0000-000000000001';
const USER = 'u-1';

function db(used: number, quotaRow?: { quota_bytes: number }): CannedDb {
  const d = new CannedDb();
  d.when(/from "zv_media_files"/i, [{ total: String(used) }]);
  d.when(/from "zv_storage_quotas"/i, quotaRow ? [quotaRow] : []);
  return d;
}

const check = (d: CannedDb, incoming: number, tenant: string | null = TENANT) =>
  checkStorageQuota(d.kysely as unknown as Database, tenant, USER, incoming);

describe('checkStorageQuota', () => {
  it('allows an upload that fits', async () => {
    const r = await check(db(100, { quota_bytes: 1000 }), 500);
    expect(r.ok).toBe(true);
    expect(r.usedBytes).toBe(100);
    expect(r.quotaBytes).toBe(1000);
  });

  it('refuses an upload that would exceed the quota', async () => {
    const r = await check(db(900, { quota_bytes: 1000 }), 500);
    expect(r.ok).toBe(false);
  });

  it('allows an upload that lands exactly on the limit', async () => {
    // `>` rather than `>=`: filling the quota precisely is not exceeding it,
    // and an off-by-one here rejects a legitimate final upload.
    const r = await check(db(500, { quota_bytes: 1000 }), 500);
    expect(r.ok).toBe(true);
  });

  it('falls back to the default when the user has no quota row', async () => {
    // Most users never get an explicit row, so this is the common path.
    const r = await check(db(0), 1024);
    expect(r.quotaBytes).toBe(DEFAULT_QUOTA_BYTES);
    expect(r.ok).toBe(true);
  });

  it('treats a missing usage sum as zero', async () => {
    // SUM() over no rows is NULL, which is what a brand-new user gets.
    const d = new CannedDb();
    d.when(/from "zv_media_files"/i, [{ total: null }]);
    d.when(/from "zv_storage_quotas"/i, []);
    const r = await check(d, 1);
    expect(r.usedBytes).toBe(0);
    expect(r.ok).toBe(true);
  });

  it('counts only this tenant’s files', async () => {
    const d = db(0, { quota_bytes: 1000 });
    await check(d, 1);
    const usage = d.executed(/from "zv_media_files"/i)[0];
    expect(usage?.sql).toMatch(/"tenant_id"/);
    expect(usage?.parameters).toContain(TENANT);
  });

  it('omits the tenant filter on a single-tenant install', async () => {
    // `tenantId` is null there, and `where tenant_id = NULL` matches nothing —
    // which would report every user as having used zero bytes.
    const d = db(0, { quota_bytes: 1000 });
    await check(d, 1, null);
    const usage = d.executed(/from "zv_media_files"/i)[0];
    expect(usage?.sql).not.toMatch(/"tenant_id"/);
  });

  it('counts only the user’s own live files', async () => {
    // Soft-deleted files have been given back; charging for them would make
    // the quota unrecoverable.
    const d = db(0, { quota_bytes: 1000 });
    await check(d, 1);
    const usage = d.executed(/from "zv_media_files"/i)[0];
    expect(usage?.sql).toMatch(/"created_by"/);
    expect(usage?.sql).toMatch(/"deleted_at" is null/i);
  });
});
