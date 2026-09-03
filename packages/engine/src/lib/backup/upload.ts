/**
 * Putting a finished backup somewhere other than this machine.
 *
 * Until now `storage_destination` accepted `'s3'`, stored it, showed it back —
 * and nothing uploaded anything. `zv_backup_uploads`, the table that records an
 * upload, had no writer in the entire repository. An operator could configure
 * off-site copies, see them listed, and have none.
 *
 * ── Why not `StorageDriver.put()` ───────────────────────────────
 *
 * Because `put(key, bytes: Uint8Array)` wants the whole object in memory, and a
 * backup is the largest file this product produces. The integrity check next
 * door already had to stop doing that; its comment records the cost — "two full
 * copies of the database in memory at once".
 *
 * A presigned PUT lets the bytes go straight from disk to the network. Measured
 * before this was written, on this runtime: 300 MB uploaded, RSS grew 35 MB.
 *
 * ── What this is NOT ────────────────────────────────────────────
 *
 * It is not "off-site" on its own, and the difference matters because surviving
 * the loss of the machine is the only reason to copy a backup anywhere.
 *
 * Zveltio's default store is `local` — a zero-dependency directory — and the
 * SeaweedFS in `docker-compose.yml` is opt-in, behind a profile, OFF unless an
 * operator asks for it. When they do, it runs on the same host. An upload to
 * that endpoint moves the backup from one directory on the disk to another
 * process on the same disk, and a disk that dies takes both.
 *
 * So this is worth having when `S3_ENDPOINT` points somewhere else — a remote
 * bucket, another machine's MinIO — and worth nothing when it points at the
 * container next door. The engine cannot tell which, so it does not claim to:
 * `storage_destination` stays `local` by default, and
 * `docs/platform/disaster-recovery.md` keeps recommending that the operator copy the
 * files off themselves.
 */

import { sql } from 'kysely';
import type { Database } from '../../db/index.js';
import { getStorage } from '../storage/index.js';

/**
 * A single S3 PUT tops out at 5 GB. Past that the protocol requires multipart —
 * create, N parts, complete, and an abort path so a failure does not leave a
 * half-assembled object being billed for.
 *
 * That is a real piece of work, and this refuses rather than starts it. A backup
 * that uploads 5 GB of a 7 GB dump and reports success is worse than one that
 * did not run: the first is trusted.
 */
const MAX_SINGLE_PUT_BYTES = 5 * 1024 * 1024 * 1024;

export interface UploadOutcome {
  uploaded: boolean;
  key?: string;
  bytes?: number;
  error?: string;
}

/**
 * Upload one backup file and record what happened.
 *
 * Never throws: a backup that succeeded locally must not be reported as failed
 * because the copy off the machine did not land. The outcome is returned and
 * written to `zv_backup_uploads`, so both states are visible instead of one
 * hiding the other.
 */
export async function uploadBackup(
  db: Database,
  opts: { backupId: string; filepath: string; filename: string; prefix?: string | null },
): Promise<UploadOutcome> {
  const { backupId, filepath, filename } = opts;
  const key = `${(opts.prefix ?? 'backups').replace(/^\/+|\/+$/g, '')}/${filename}`;

  const record = async (status: string, bytes: number | null, error: string | null) => {
    await sql`
      INSERT INTO zv_backup_uploads (backup_id, destination, s3_key, size_bytes, status, error)
      VALUES (${backupId}::uuid, 's3', ${key}, ${bytes}, ${status}, ${error})
    `
      .execute(db)
      .catch((e) => console.error('[backup-upload] could not record the upload:', e));
  };

  try {
    const file = Bun.file(filepath);
    if (!(await file.exists())) {
      const msg = 'backup file is not on disk';
      await record('failed', null, msg);
      return { uploaded: false, error: msg };
    }

    const size = file.size;
    if (size > MAX_SINGLE_PUT_BYTES) {
      const msg =
        `backup is ${(size / 1024 ** 3).toFixed(1)} GB, over the 5 GB a single S3 PUT ` +
        'allows. Multipart upload is not implemented, so this was not uploaded rather ' +
        'than uploaded in part.';
      await record('failed', size, msg);
      return { uploaded: false, error: msg };
    }

    const url = await getStorage().signedPutUrl(key, 3600);
    if (!url) {
      const msg =
        'this instance stores files locally, which is the default and usually right — ' +
        'SeaweedFS in docker-compose is opt-in and off unless asked for. There is ' +
        'therefore nowhere to upload to. Either configure S3_ENDPOINT (pointing ' +
        'somewhere that is NOT this machine, or the copy is not off-site), or leave ' +
        "storage_destination as 'local' and copy the files off yourself — see " +
        'docs/platform/disaster-recovery.md §3.1.';
      await record('failed', size, msg);
      return { uploaded: false, error: msg };
    }

    // `Bun.file(...)` as the body streams from disk — this is the line the
    // 5 GB limit and the whole approach exist for.
    const res = await fetch(url, {
      method: 'PUT',
      body: file,
      headers: { 'Content-Type': 'application/gzip', 'Content-Length': String(size) },
    });

    if (!res.ok) {
      // S3 errors arrive as XML; the first 200 characters carry the code and
      // message, and the whole body can be long.
      const body = await res.text().catch(() => '');
      const msg = `upload failed: HTTP ${res.status} ${body.slice(0, 200)}`.trim();
      await record('failed', size, msg);
      return { uploaded: false, error: msg };
    }

    await record('completed', size, null);
    return { uploaded: true, key, bytes: size };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    await record('failed', null, msg);
    return { uploaded: false, error: msg };
  }
}
