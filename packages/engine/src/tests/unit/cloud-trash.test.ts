/**
 * Media trash helper (lib/cloud/trash.ts) — soft-deletes zv_media_files rows.
 */

import { describe, expect, it } from 'bun:test';
import type { Database } from '../../db/index.js';
import { moveToTrash } from '../../lib/cloud/trash.js';
import { CannedDb } from './fixtures/canned-db.js';

describe('moveToTrash', () => {
  it('updates deleted_at when a live row exists', async () => {
    const canned = new CannedDb();
    canned.whenAffected(/update "zv_media_files"/i, 1);
    const db = canned.kysely as unknown as Database;

    await moveToTrash(db, 'file-1', 'u1');
    expect(canned.executed(/update "zv_media_files"/i).length).toBe(1);
  });

  it('throws when the file is missing or already deleted', async () => {
    const canned = new CannedDb();
    canned.whenAffected(/update "zv_media_files"/i, 0);
    const db = canned.kysely as unknown as Database;

    await expect(moveToTrash(db, 'gone', 'u1')).rejects.toThrow(/not found|already deleted/i);
  });
});
