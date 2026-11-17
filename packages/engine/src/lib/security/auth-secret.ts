/**
 * The instance auth secret: the only reader of `BETTER_AUTH_SECRET` and
 * `BETTER_AUTH_SECRETS` (ADR 0058 decision 7, DR-17).
 *
 * `BETTER_AUTH_SECRETS` is Better Auth's own versioned list,
 * `"<version>:<secret>,<version>:<secret>"`. The FIRST entry is current: Better
 * Auth signs cookies and encrypts new values (TOTP secret, backup codes) with it
 * and tags each ciphertext `$ba$<version>$`, and decrypts a tagged value with
 * whichever listed version wrote it. The first entry, not the highest version:
 * `"1:old,2:new"` keeps `old` current while every replica learns `new`, which is
 * phase 1 of a replica rollout.
 *
 * Beside the list, `BETTER_AUTH_SECRET` is only Better Auth's legacy key: it
 * decrypts the untagged values written before the list existed. Nothing the
 * engine signs uses it.
 *
 * Everything the engine signs or keys itself — Valkey cache signatures, sealed
 * cursors, local file URLs, API-key and extension token hashes — uses the
 * current secret only: an entry signed under any other secret is refused. One
 * exception on the verifying side: an API key whose stored hash an older held
 * secret wrote still verifies, and is rewritten under the current one on that
 * use (`apiKeyHashCandidates`, migration 126).
 */

export interface VersionedSecret {
  version: number;
  value: string;
}

export interface AuthSecrets {
  /** The secret the engine signs and verifies with. */
  current: string;
  /** Better Auth's `secrets`; first is current. Undefined without the list. */
  secrets?: VersionedSecret[];
  /** Better Auth's `secret`: the only secret, or beside the list the legacy decrypt key. */
  legacy?: string;
}

type Env = Record<string, string | undefined>;

/**
 * Parse both variables. Throws on a malformed list (never echoing a secret) and
 * when neither is set.
 */
export function readAuthSecrets(env: Env = process.env): AuthSecrets {
  const single = env.BETTER_AUTH_SECRET || undefined;
  const list = env.BETTER_AUTH_SECRETS;
  if (!list) {
    if (!single) throw new Error('BETTER_AUTH_SECRET (or BETTER_AUTH_SECRETS) is required');
    return { current: single, legacy: single };
  }
  const seen = new Set<number>();
  const secrets = list.split(',').map((raw, i) => {
    const m = /^(\d+):(.*)$/s.exec(raw.trim());
    const value = m?.[2]?.trim();
    if (!m || !value) {
      throw new Error(
        `BETTER_AUTH_SECRETS entry ${i + 1} is not "<version>:<secret>" (version a ` +
          'non-negative integer, secret non-empty, entries separated by commas).',
      );
    }
    const version = Number(m[1]);
    if (!Number.isSafeInteger(version) || seen.has(version)) {
      throw new Error(
        `BETTER_AUTH_SECRETS entry ${i + 1}: version ${m[1]} is repeated or too large.`,
      );
    }
    seen.add(version);
    return { version, value };
  });
  return { current: secrets[0]!.value, secrets, legacy: single };
}

/**
 * The secret every engine-side signature and keyed hash uses; undefined when
 * neither variable is set, so each caller keeps its own refusal message.
 */
export function currentAuthSecret(env: Env = process.env): string | undefined {
  if (!env.BETTER_AUTH_SECRETS && !env.BETTER_AUTH_SECRET) return undefined;
  return readAuthSecrets(env).current;
}
