/**
 * lib/backup/upload.ts — copying a finished backup off the machine.
 *
 * Before this module `storage_destination` accepted `'s3'`, stored it and showed
 * it back while nothing uploaded anything. So the tests that matter are the ones
 * about honesty: every path that does NOT upload has to say so, in a row an
 * operator can read, rather than leaving the configured intent looking satisfied.
 *
 *   - local storage is the DEFAULT and usually right; there is simply nowhere to
 *     upload to, and that is explained rather than reported as a failure of S3
 *   - a dump over 5 GB is refused, not uploaded in part — a backup that uploads
 *     5 of 7 GB and reports success is worse than one that did not run
 *   - an HTTP error keeps the status and the start of the S3 XML body
 *   - nothing here throws: a backup that succeeded locally must not be reported
 *     as failed because the off-site copy did not land
 *
 * The S3 driver signs URLs locally, with no network, so these drive the real
 * driver through env rather than mocking the storage layer. Only `fetch` is
 * stubbed — the one part that would leave this machine.
 */

import { afterEach, beforeEach, describe, expect, it, spyOn } from 'bun:test';
import { uploadBackup } from '../../lib/backup/upload.js';
import { _resetStorageForTests } from '../../lib/storage/index.js';
import { CannedDb } from './fixtures/canned-db.js';

const INSERT_UPLOAD = /INSERT INTO zv_backup_uploads/i;

const DIR = `/tmp/zveltio-upload-test-${process.pid}-${Date.now()}`;
const FILE = `${DIR}/backup-1.sql.gz`;
const PAYLOAD = 'gzipped backup bytes\n';

const ENV_KEYS = [
  'STORAGE_DRIVER',
  'S3_ENDPOINT',
  'S3_BUCKET',
  'S3_REGION',
  'S3_ACCESS_KEY',
  'S3_SECRET_KEY',
] as const;
const saved: Record<string, string | undefined> = {};

/** Point the real S3 driver at a bucket that is not this machine. */
function useS3(): void {
  process.env.STORAGE_DRIVER = 's3';
  process.env.S3_ENDPOINT = 'https://s3.example.net';
  process.env.S3_BUCKET = 'zveltio-backups';
  process.env.S3_REGION = 'us-east-1';
  process.env.S3_ACCESS_KEY = 'AKIAEXAMPLE';
  process.env.S3_SECRET_KEY = 'secret-example';
  _resetStorageForTests();
}

/** The default: a directory on this disk, with nowhere to upload to. */
function useLocal(): void {
  process.env.STORAGE_DRIVER = 'local';
  _resetStorageForTests();
}

beforeEach(async () => {
  for (const k of ENV_KEYS) saved[k] = process.env[k];
  await Bun.spawn(['mkdir', '-p', DIR]).exited;
  await Bun.write(FILE, PAYLOAD);
});

afterEach(async () => {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  _resetStorageForTests();
  await Bun.spawn(['rm', '-rf', DIR]).exited;
});

const args = (over: Partial<Parameters<typeof uploadBackup>[1]> = {}) => ({
  backupId: '11111111-1111-1111-1111-111111111111',
  filepath: FILE,
  filename: 'backup-1.sql.gz',
  ...over,
});

describe('uploadBackup — when there is nowhere to put it', () => {
  it('explains that local storage is the default, and does not call it an S3 failure', async () => {
    useLocal();
    const db = new CannedDb();

    const out = await uploadBackup(db.kysely as never, args());

    expect(out.uploaded).toBe(false);
    expect(out.error).toContain('stores files locally');
    expect(out.error).toContain('S3_ENDPOINT');
    // The point of the sentence: an endpoint on this machine is not off-site.
    expect(out.error).toContain('NOT this machine');

    const rows = db.executed(INSERT_UPLOAD);
    expect(rows.length).toBe(1);
    expect(rows[0]!.parameters).toContain('failed');
  });

  it('records the attempt when the file is gone', async () => {
    useS3();
    const db = new CannedDb();

    const out = await uploadBackup(db.kysely as never, args({ filepath: `${DIR}/missing.gz` }));

    expect(out.uploaded).toBe(false);
    expect(out.error).toBe('backup file is not on disk');
    expect(db.executed(INSERT_UPLOAD).length).toBe(1);
  });

  it('refuses a dump over 5 GB rather than uploading part of it', async () => {
    // A backup that uploads 5 of 7 GB and reports success is worse than one that
    // did not run: the first is trusted.
    useS3();
    const db = new CannedDb();
    const big = spyOn(Bun, 'file').mockReturnValue({
      exists: () => Promise.resolve(true),
      size: 7 * 1024 ** 3,
    } as never);

    const out = await uploadBackup(db.kysely as never, args());
    big.mockRestore();

    expect(out.uploaded).toBe(false);
    expect(out.error).toContain('7.0 GB');
    expect(out.error).toContain('Multipart upload is not implemented');
    expect(out.error).toContain('not uploaded rather');
  });
});

describe('uploadBackup — when there is', () => {
  it('PUTs the file and records the size and key', async () => {
    useS3();
    const db = new CannedDb();
    let seen: { url: string; method?: string } | null = null;
    const f = spyOn(globalThis, 'fetch').mockImplementation(((url: string, init?: RequestInit) => {
      seen = { url: String(url), method: init?.method };
      return Promise.resolve(new Response('', { status: 200 }));
    }) as unknown as typeof fetch);

    const out = await uploadBackup(db.kysely as never, args());
    f.mockRestore();

    expect(out.uploaded).toBe(true);
    expect(out.bytes).toBe(PAYLOAD.length);
    expect(out.key).toBe('backups/backup-1.sql.gz');
    expect(seen!.method).toBe('PUT');
    // A presigned URL — signed locally, which is why this needs no network.
    expect(seen!.url).toContain('backups/backup-1.sql.gz');
    expect(seen!.url).toContain('X-Amz-Signature');

    const rows = db.executed(INSERT_UPLOAD);
    expect(rows[0]!.parameters).toContain('completed');
    expect(rows[0]!.parameters).toContain(PAYLOAD.length);
  });

  it('strips stray slashes from the prefix instead of doubling them in the key', async () => {
    useS3();
    const db = new CannedDb();
    const f = spyOn(globalThis, 'fetch').mockImplementation((() =>
      Promise.resolve(new Response('', { status: 200 }))) as unknown as typeof fetch);

    const out = await uploadBackup(db.kysely as never, args({ prefix: '/nightly/' }));
    f.mockRestore();

    expect(out.key).toBe('nightly/backup-1.sql.gz');
  });

  it('keeps the status and the start of the S3 error body', async () => {
    useS3();
    const db = new CannedDb();
    const xml = `<?xml version="1.0"?><Error><Code>AccessDenied</Code>${'x'.repeat(500)}</Error>`;
    const f = spyOn(globalThis, 'fetch').mockImplementation((() =>
      Promise.resolve(new Response(xml, { status: 403 }))) as unknown as typeof fetch);

    const out = await uploadBackup(db.kysely as never, args());
    f.mockRestore();

    expect(out.uploaded).toBe(false);
    expect(out.error).toContain('HTTP 403');
    expect(out.error).toContain('AccessDenied');
    // Truncated: the whole body can be long, and the code is at the front.
    expect(out.error!.length).toBeLessThan(260);
  });

  it('does not throw when the network itself fails', async () => {
    // The whole contract: a backup that succeeded locally must not be reported as
    // failed because the copy off the machine did not land.
    useS3();
    const db = new CannedDb();
    const f = spyOn(globalThis, 'fetch').mockImplementation((() =>
      Promise.reject(
        new Error('getaddrinfo ENOTFOUND s3.example.net'),
      )) as unknown as typeof fetch);

    const out = await uploadBackup(db.kysely as never, args());
    f.mockRestore();

    expect(out.uploaded).toBe(false);
    expect(out.error).toContain('ENOTFOUND');
    expect(db.executed(INSERT_UPLOAD).length).toBe(1);
  });
});
