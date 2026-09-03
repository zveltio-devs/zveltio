/**
 * Is the archive on disk actually a backup?
 *
 * This lives in one place because it previously lived in two, and the copy is
 * how the defect survived: `routes/backup.ts` and `run-scheduled-backup.ts`
 * both ran `pg_dump | gzip`, both checked `pg_dump`'s exit code and the file's
 * existence, and neither looked at `gzip`. A third backup path would have
 * inherited the same pair of checks.
 *
 * What the two of them missed, in the order the checks now run:
 *
 *   `gzip`'s exit code is not redundant with `pg_dump`'s. The disk fills at the
 *   tail of the write, gzip dies on SIGXFSZ (128 + 25 = 153), and pg_dump —
 *   whose whole output already fitted in the 64 KB pipe buffer — exits 0. What
 *   is left on disk is a TRUNCATED archive, and it exists, so the old checks
 *   passed it and the row said `completed`. Measured against real processes
 *   under `ulimit -f 1`: pg_dump 0, gzip 153, 1024 bytes of an expected 31047,
 *   and `gzip -t` reporting "unexpected end of file".
 *
 *   A dump of nothing is still a valid archive. `gzip -c </dev/null` is exactly
 *   twenty bytes and passes `gzip -t`, with both processes exiting 0 — so no
 *   exit code, no existence check and no integrity check separates it from a
 *   real backup. Only the size does, and it is the shape every broken-wiring
 *   bug produces: detach gzip's stdin and this is what lands on disk.
 *
 * `scripts/dr-drill.sh` already carried the first lesson in prose — it had been
 * testing gzip's status alone, and its comment calls a half-written dump
 * reported as passing "the single worst thing a drill can do". The lesson had
 * been applied to the shell script and not to the product.
 */

/** The size of a gzip stream carrying zero bytes of input. */
export const EMPTY_ARCHIVE_BYTES = 20;

/** The half of a spawned gzip this check needs, so callers can pass the process. */
export interface GzipOutcome {
  exitCode: number | null;
  stderr: ReadableStream<Uint8Array> | null;
}

/**
 * Throws unless `filepath` holds an archive a restore could use. Returns its
 * size, which is the number the caller records.
 *
 * Call it only after BOTH processes have exited and after `pg_dump`'s own exit
 * code has been checked — a dump that failed outright has a better error than
 * anything here.
 */
export async function verifyArchive(gzip: GzipOutcome, filepath: string): Promise<number> {
  if (gzip.exitCode !== 0) {
    const stderr = gzip.stderr ? await new Response(gzip.stderr).text() : '';
    throw new Error(`gzip failed (exit ${gzip.exitCode}): ${stderr.trim() || 'no stderr'}`);
  }

  if (!(await Bun.file(filepath).exists())) {
    throw new Error('Backup file was not created');
  }

  const size = Bun.file(filepath).size;
  if (size <= EMPTY_ARCHIVE_BYTES) {
    throw new Error(
      `Backup archive contains no data (${size} bytes — an empty gzip stream is ` +
        `${EMPTY_ARCHIVE_BYTES}). The dump produced nothing.`,
    );
  }

  return size;
}
