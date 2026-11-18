/**
 * Re-encrypt every two-factor row under the current auth secret (DR-17,
 * ADR 0058 decision 7), so a rotation can finish: once no row needs an older
 * secret, that secret leaves `BETTER_AUTH_SECRETS` and `BETTER_AUTH_SECRET`.
 *
 * Better Auth encrypts `"twoFactor".secret` and `."backupCodes"` with the
 * current `BETTER_AUTH_SECRETS` entry, tagged `$ba$<version>$`, and never
 * rewrites a row it reads: a value written before the list (untagged, keyed on
 * `BETTER_AUTH_SECRET`) or under an older version keeps needing that secret.
 * This pass runs at every boot and rewrites each such value under the current
 * version, with Better Auth's own `symmetricDecrypt`/`symmetricEncrypt`.
 *
 * - Fail-safe: a value no held secret decrypts is left as it is and its user
 *   is named in a warning, every boot, until their factors are reset.
 * - Replicas and live sign-ins: the UPDATE is conditional on both values being
 *   what this pass read. A row changed meanwhile is skipped and the next boot
 *   retries; it is never overwritten with a stale value.
 * - `"twoFactor"` is one global table (no tenant schema holds one), so a single
 *   pass covers every tenant.
 * - Without `BETTER_AUTH_SECRETS` there is no version to tag with: nothing runs.
 */

import { type SecretConfig, symmetricDecrypt, symmetricEncrypt } from 'better-auth/crypto';
import { sql } from 'kysely';
import type { Database } from '../../db/index.js';
import { readAuthSecrets } from './auth-secret.js';

export interface TwoFactorReencryptResult {
  /** Rows rewritten under the current version. */
  reencrypted: number;
  /** Users with a value that no held secret decrypts (left untouched). */
  undecryptable: string[];
  /** Rows changed by someone else between read and write (retried next boot). */
  skipped: number;
}

export async function reencryptTwoFactorRows(db: Database): Promise<TwoFactorReencryptResult> {
  const result: TwoFactorReencryptResult = { reencrypted: 0, undecryptable: [], skipped: 0 };
  const { secrets, legacy } = readAuthSecrets();
  if (!secrets) return result;
  const key: SecretConfig = {
    keys: new Map(secrets.map((s) => [s.version, s.value])),
    currentVersion: secrets[0]!.version,
    legacySecret: legacy,
  };
  const tag = `$ba$${key.currentVersion}$`;

  const { rows } = await sql<{ id: string; userId: string; secret: string; backupCodes: string }>`
    SELECT id, "userId", secret, "backupCodes" FROM "twoFactor"
     WHERE secret NOT LIKE ${`${tag}%`} OR "backupCodes" NOT LIKE ${`${tag}%`}
  `.execute(db);

  const rewrite = async (value: string): Promise<string | null> => {
    if (value.startsWith(tag)) return value;
    try {
      return await symmetricEncrypt({ key, data: await symmetricDecrypt({ key, data: value }) });
    } catch {
      return null;
    }
  };

  for (const row of rows) {
    const secret = await rewrite(row.secret);
    const backupCodes = await rewrite(row.backupCodes);
    if (secret === null || backupCodes === null) result.undecryptable.push(row.userId);
    // Each column that decrypted moves on its own: a TOTP secret still waits on
    // its old version only if it, not its neighbour, fails to decrypt.
    const next = { secret: secret ?? row.secret, backupCodes: backupCodes ?? row.backupCodes };
    if (next.secret === row.secret && next.backupCodes === row.backupCodes) continue;
    const { rows: updated } = await sql`
      UPDATE "twoFactor" SET secret = ${next.secret}, "backupCodes" = ${next.backupCodes}
       WHERE id = ${row.id} AND secret = ${row.secret} AND "backupCodes" = ${row.backupCodes}
      RETURNING id
    `.execute(db);
    if (updated.length > 0) result.reencrypted++;
    else result.skipped++;
  }
  return result;
}

/** Boot wrapper: reports, never blocks the boot. */
export async function reencryptTwoFactorRowsAtBoot(db: Database): Promise<void> {
  try {
    const { reencrypted, undecryptable, skipped } = await reencryptTwoFactorRows(db);
    if (reencrypted > 0) {
      console.log(
        `✅ [auth] re-encrypted ${reencrypted} two-factor row(s) under the current secret`,
      );
    }
    if (skipped > 0) {
      console.warn(
        `[auth] ${skipped} two-factor row(s) changed during re-encryption; next boot retries`,
      );
    }
    if (undecryptable.length > 0) {
      const shown = undecryptable.slice(0, 20).join(', ');
      const more = undecryptable.length > 20 ? ` and ${undecryptable.length - 20} more` : '';
      console.warn(
        `⚠️  [auth] ${undecryptable.length} two-factor row(s) decrypt under no secret in ` +
          'BETTER_AUTH_SECRETS or BETTER_AUTH_SECRET and were left as they are; those users ' +
          `cannot pass TOTP or backup codes until their factors are reset: ${shown}${more}`,
      );
    }
  } catch (err) {
    console.warn('[auth] could not re-encrypt two-factor rows:', (err as Error).message);
  }
}
