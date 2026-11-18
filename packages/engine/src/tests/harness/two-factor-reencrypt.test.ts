/**
 * A rotation can finish for TOTP (DR-17 slice 3, ADR 0058 decision 7).
 *
 * Better Auth decrypts a two-factor value with the secret that wrote it and
 * never rewrites it, so the old secret had to stay listed (and stay
 * `BETTER_AUTH_SECRET`, for rows written before the list) for as long as any
 * enrolment lived. The boot pass rewrites each value under the current version:
 * afterwards a config holding ONLY the current secret decrypts every row. A
 * value no held secret decrypts is never touched; a rerun changes nothing; two
 * replicas running it at once write each row once.
 */

import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { type SecretConfig, symmetricDecrypt, symmetricEncrypt } from 'better-auth/crypto';
import { sql } from 'kysely';
import type { Database } from '../../db/index.js';
import { auth } from '../../lib/auth.js';
import { reencryptTwoFactorRows } from '../../lib/security/two-factor-reencrypt.js';
import { getTestApp, harnessAvailable } from '../../testing/app-harness.js';

const d = harnessAvailable() ? describe : describe.skip;
const OLD = `old-${'o'.repeat(40)}`;
const NEW = `new-${'n'.repeat(40)}`;
const ROGUE = `rogue-${'r'.repeat(40)}`;
const tagged = (version: number, secret: string): SecretConfig => ({
  keys: new Map([[version, secret]]),
  currentVersion: version,
});
/** What remains once the old secret is dropped everywhere. */
const NEW_ONLY = tagged(2, NEW);

class Rollback extends Error {}

d('two-factor re-encryption under the current secret (DR-17)', () => {
  let db: Database;
  const saved = {
    list: process.env.BETTER_AUTH_SECRETS,
    single: process.env.BETTER_AUTH_SECRET,
  };

  beforeAll(async () => {
    ({ db } = await getTestApp());
  });

  afterAll(() => {
    for (const [k, v] of [
      ['BETTER_AUTH_SECRETS', saved.list],
      ['BETTER_AUTH_SECRET', saved.single],
    ] as const) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

  /** Seed rows inside a transaction that is always rolled back. */
  async function inRolledBackTxn(fn: (trx: Database) => Promise<void>) {
    await db
      .transaction()
      .execute(async (trx) => {
        // Only this test's rows: the pass walks the whole table.
        await sql`DELETE FROM "twoFactor"`.execute(trx);
        await fn(trx as unknown as Database);
        throw new Rollback();
      })
      .catch((err) => {
        if (!(err instanceof Rollback)) throw err;
      });
  }

  async function seed(
    trx: Database,
    rows: Record<string, { secret: string; backupCodes: string }>,
  ) {
    for (const [id, v] of Object.entries(rows)) {
      await sql`INSERT INTO "user" (id, name, email) VALUES (${id}, ${id}, ${`${id}@tfa.test`})`.execute(
        trx,
      );
      await sql`INSERT INTO "twoFactor" (id, secret, "backupCodes", "userId")
                VALUES (${`tf-${id}`}, ${v.secret}, ${v.backupCodes}, ${id})`.execute(trx);
    }
  }

  const read = async (trx: Database) =>
    Object.fromEntries(
      (
        await sql<{ userId: string; secret: string; backupCodes: string }>`
          SELECT "userId", secret, "backupCodes" FROM "twoFactor"`.execute(trx)
      ).rows.map((r) => [r.userId, { secret: r.secret, backupCodes: r.backupCodes }]),
    );

  const enc = (key: string | SecretConfig, data: string) => symmetricEncrypt({ key, data });
  const tag = Math.random().toString(36).slice(2, 8);
  const u = (n: string) => `tfa-${tag}-${n}`;
  const TOTP = 'JBSWY3DPEHPK3PXP';
  const CODES = JSON.stringify(['aaaaa-bbbbb', 'ccccc-ddddd']);

  it('moves every decryptable value to the current version, leaves the rest, and is idempotent', async () => {
    process.env.BETTER_AUTH_SECRET = OLD;
    process.env.BETTER_AUTH_SECRETS = `2:${NEW},1:${OLD}`;
    await inRolledBackTxn(async (trx) => {
      const current = await enc(NEW_ONLY, TOTP);
      const rogue = {
        secret: await enc(tagged(1, ROGUE), TOTP),
        backupCodes: await enc(ROGUE, CODES),
      };
      await seed(trx, {
        // Written before the list existed: untagged, under BETTER_AUTH_SECRET.
        [u('legacy')]: { secret: await enc(OLD, TOTP), backupCodes: await enc(OLD, CODES) },
        // Written while 1:<old> was current.
        [u('v1')]: {
          secret: await enc(tagged(1, OLD), TOTP),
          backupCodes: await enc(tagged(1, OLD), CODES),
        },
        [u('current')]: { secret: current, backupCodes: await enc(NEW_ONLY, CODES) },
        // No held secret decrypts either value.
        [u('rogue')]: rogue,
        // The secret decrypts, the backup codes do not.
        [u('half')]: { secret: await enc(tagged(1, OLD), TOTP), backupCodes: rogue.backupCodes },
      });
      const before = await read(trx);

      const first = await reencryptTwoFactorRows(trx);
      expect(first.reencrypted).toBe(3);
      expect(first.skipped).toBe(0);
      expect(first.undecryptable.sort()).toEqual([u('half'), u('rogue')].sort());

      const after = await read(trx);
      for (const id of [u('legacy'), u('v1')]) {
        expect(after[id]!.secret.startsWith('$ba$2$')).toBe(true);
        expect(after[id]!.backupCodes.startsWith('$ba$2$')).toBe(true);
        // The old secret can go: the current one alone decrypts them.
        expect(await symmetricDecrypt({ key: NEW_ONLY, data: after[id]!.secret })).toBe(TOTP);
        expect(await symmetricDecrypt({ key: NEW_ONLY, data: after[id]!.backupCodes })).toBe(CODES);
      }
      expect(after[u('current')]).toEqual(before[u('current')]!);
      expect(after[u('rogue')]).toEqual(rogue);
      expect(await symmetricDecrypt({ key: NEW_ONLY, data: after[u('half')]!.secret })).toBe(TOTP);
      expect(after[u('half')]!.backupCodes).toBe(rogue.backupCodes);

      const second = await reencryptTwoFactorRows(trx);
      expect(second.reencrypted).toBe(0);
      expect(second.undecryptable.sort()).toEqual([u('half'), u('rogue')].sort());
      expect(await read(trx)).toEqual(after);
    });
  });

  it('two passes at once write each row once (the UPDATE is conditional on what was read)', async () => {
    process.env.BETTER_AUTH_SECRET = OLD;
    process.env.BETTER_AUTH_SECRETS = `2:${NEW},1:${OLD}`;
    await inRolledBackTxn(async (trx) => {
      await seed(trx, {
        [u('a')]: { secret: await enc(OLD, TOTP), backupCodes: await enc(OLD, CODES) },
        [u('b')]: { secret: await enc(tagged(1, OLD), TOTP), backupCodes: await enc(OLD, CODES) },
      });
      const [x, y] = await Promise.all([reencryptTwoFactorRows(trx), reencryptTwoFactorRows(trx)]);
      expect(x.reencrypted + y.reencrypted).toBe(2);
      for (const v of Object.values(await read(trx))) {
        expect(await symmetricDecrypt({ key: NEW_ONLY, data: v.secret })).toBe(TOTP);
      }
    });
  });

  it('encrypts legacy plaintext backup codes under the current version', async () => {
    process.env.BETTER_AUTH_SECRET = OLD;
    process.env.BETTER_AUTH_SECRETS = `2:${NEW},1:${OLD}`;
    await inRolledBackTxn(async (trx) => {
      const secret = await enc(NEW_ONLY, TOTP);
      await seed(trx, {
        // Stored before `storeBackupCodes: 'encrypted'`: a JSON array in the clear.
        [u('plain')]: { secret, backupCodes: CODES },
        [u('plain-old')]: { secret: await enc(OLD, TOTP), backupCodes: CODES },
        // Neither ciphertext nor a list of codes: left alone, reported.
        [u('junk')]: { secret, backupCodes: '{"a":1}' },
      });
      const first = await reencryptTwoFactorRows(trx);
      expect(first.undecryptable).toEqual([u('junk')]);
      expect(first.reencrypted).toBe(2);
      const after = await read(trx);
      for (const id of [u('plain'), u('plain-old')]) {
        expect(after[id]!.backupCodes.startsWith('$ba$2$')).toBe(true);
        expect(await symmetricDecrypt({ key: NEW_ONLY, data: after[id]!.backupCodes })).toBe(CODES);
        expect(await symmetricDecrypt({ key: NEW_ONLY, data: after[id]!.secret })).toBe(TOTP);
      }
      expect(after[u('junk')]!.backupCodes).toBe('{"a":1}');
    });
  });

  it('without BETTER_AUTH_SECRETS, encrypts plaintext backup codes so Better Auth reads them', async () => {
    // Better Auth's own read path, on committed rows: it decrypts with the
    // config it booted with (the harness BETTER_AUTH_SECRET, no list).
    process.env.BETTER_AUTH_SECRET = saved.single;
    delete process.env.BETTER_AUTH_SECRETS;
    const id = u('ba');
    const secret = await enc(saved.single!, TOTP);
    await sql`INSERT INTO "user" (id, name, email) VALUES (${id}, ${id}, ${`${id}@tfa.test`})`.execute(
      db,
    );
    try {
      await sql`INSERT INTO "twoFactor" (id, secret, "backupCodes", "userId")
                VALUES (${`tf-${id}`}, ${secret}, ${CODES}, ${id})`.execute(db);
      // Server-only endpoint: present at runtime, absent from the inferred type.
      const api = auth.api as unknown as {
        viewBackupCodes(a: { body: { userId: string } }): Promise<{ backupCodes: string[] }>;
      };
      const view = () => api.viewBackupCodes({ body: { userId: id } });
      // A plaintext array is not ciphertext: Better Auth's decrypt throws on it.
      await expect(view()).rejects.toThrow();

      const result = await reencryptTwoFactorRows(db);
      expect(result.undecryptable).not.toContain(id);
      const [row] = (
        await sql<{ secret: string; backupCodes: string }>`
          SELECT secret, "backupCodes" FROM "twoFactor" WHERE "userId" = ${id}`.execute(db)
      ).rows;
      expect(row!.secret).toBe(secret);
      expect(row!.backupCodes).not.toBe(CODES);
      expect((await view()).backupCodes).toEqual(JSON.parse(CODES));
      // A rerun changes nothing.
      await reencryptTwoFactorRows(db);
      expect((await view()).backupCodes).toEqual(JSON.parse(CODES));
    } finally {
      await sql`DELETE FROM "user" WHERE id = ${id}`.execute(db);
    }
  });

  it('does nothing else without BETTER_AUTH_SECRETS: there is no version to tag with', async () => {
    process.env.BETTER_AUTH_SECRET = OLD;
    delete process.env.BETTER_AUTH_SECRETS;
    await inRolledBackTxn(async (trx) => {
      await seed(trx, {
        [u('single')]: { secret: await enc(OLD, TOTP), backupCodes: await enc(OLD, CODES) },
      });
      const before = await read(trx);
      expect(await reencryptTwoFactorRows(trx)).toEqual({
        reencrypted: 0,
        undecryptable: [],
        skipped: 0,
      });
      expect(await read(trx)).toEqual(before);
    });
  });
});
