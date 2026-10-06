/**
 * Secrets read from files: `<NAME>_FILE=/run/secrets/x` instead of `<NAME>=…`.
 *
 * A value passed in the environment is in `/proc/self/environ` for the life of
 * the process, and deleting it from `process.env` does not remove it from
 * there. Every thread in the process can read that file, a worker-isolated
 * extension included: the `env` option of `new Worker()` hides variables from
 * `process.env`, not from the filesystem. A value read from a file and set here
 * never reaches `/proc/self/environ`.
 *
 * Imported first by every entry point, before any module reads its config at
 * import time.
 */

import { readFileSync } from 'node:fs';

/** The variables that may come from a file. Each one is a credential or a key. */
export const SECRET_FILE_VARS = [
  'AI_KEY_ENCRYPTION_KEY',
  'APNS_KEY',
  'APPLE_CLIENT_SECRET',
  'BACKUP_DB_PASSWORD',
  'BETTER_AUTH_SECRET',
  'DATABASE_PASSWORD',
  'DATABASE_URL',
  'DISCORD_CLIENT_SECRET',
  'ELECTRIC_AUTH_TOKEN',
  'FCM_SERVER_KEY',
  'FIELD_ENCRYPTION_KEY',
  'GITHUB_CLIENT_SECRET',
  'GOOGLE_CLIENT_SECRET',
  'MAIL_ENCRYPTION_KEY',
  'METRICS_TOKEN',
  'MICROSOFT_CLIENT_SECRET',
  'NATIVE_DATABASE_URL',
  'RECOVERY_TOKEN',
  'S3_ACCESS_KEY',
  'S3_SECRET_KEY',
  'TWITTER_CLIENT_SECRET',
  'VALKEY_URL',
  'VAPID_PRIVATE_KEY',
] as const;

/**
 * Fill `env[NAME]` from the file `env[NAME_FILE]` names, for every name in
 * `SECRET_FILE_VARS`. Throws when both are set (which one wins would be a
 * guess) or when the file is missing or empty (booting with no secret is how a
 * misconfiguration hides). One trailing newline is dropped; editors and
 * `echo` add it.
 */
export function loadSecretFiles(
  env: Record<string, string | undefined> = process.env,
  read: (path: string) => string = (p) => readFileSync(p, 'utf8'),
): string[] {
  const loaded: string[] = [];
  for (const name of SECRET_FILE_VARS) {
    const path = env[`${name}_FILE`];
    if (!path) continue;
    if (env[name] !== undefined && env[name] !== '') {
      throw new Error(`${name} and ${name}_FILE are both set; set one.`);
    }
    let value: string;
    try {
      value = read(path).replace(/\r?\n$/, '');
    } catch (err) {
      throw new Error(`${name}_FILE: cannot read ${path}: ${(err as Error).message}`);
    }
    if (value === '') throw new Error(`${name}_FILE: ${path} is empty.`);
    env[name] = value;
    loaded.push(name);
  }
  return loaded;
}

try {
  loadSecretFiles();
} catch (err) {
  console.error(`❌ ${(err as Error).message}`);
  process.exit(1);
}
