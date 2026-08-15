import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'bun:test';
import { isPlatformTable } from '../../lib/introspection.js';

/**
 * BYOD introspection must never import a table the platform owns.
 *
 * The filter was four prefixes — `zv_`, `zvd_`, `_zv_`, `pg_` — and the engine's
 * most sensitive tables carry none of them: Better-Auth creates `user`,
 * `session`, `account`, `verification` and `twoFactor` unprefixed in `public`.
 * Importing the default schema registered them as ordinary collections, after
 * which the generic record API could read `account.password` and `session.token`
 * for anyone granted the collection.
 *
 * The fix enumerates those names, and an enumeration rots. This test reads what
 * the migrations ACTUALLY create and fails if any unprefixed table is not
 * refused — so adding one and forgetting the list is a red build, not a
 * disclosure two releases later.
 */
const MIGRATIONS = join(import.meta.dir, '..', '..', 'db', 'migrations', 'sql');

/** Table names created by the engine's own migrations. */
function createdTables(): string[] {
  const names = new Set<string>();
  for (const file of readdirSync(MIGRATIONS).filter((f) => f.endsWith('.sql'))) {
    const sql = readFileSync(join(MIGRATIONS, file), 'utf8');
    for (const m of sql.matchAll(
      /CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?("?)([A-Za-z_][\w]*)\1/gi,
    )) {
      names.add(m[2]!);
    }
  }
  // `CREATE TABLE public.x` puts the schema where the name is matched; and the
  // regex also catches the odd English word from a comment. Keep only names the
  // migrations plausibly created — anything else is noise, and noise that made
  // this test fail would train someone to ignore it.
  const noise = new Set(['public', 'IF', 'for', 'in', 'was']);
  return [...names].filter((n) => !noise.has(n));
}

describe('introspection refuses every table the engine owns', () => {
  it('refuses each one, prefixed or not', () => {
    const missed = createdTables().filter((t) => !isPlatformTable(t));
    expect({ missed }).toEqual({ missed: [] });
  });

  it('names the five unprefixed ones explicitly, since no prefix can catch them', () => {
    for (const t of ['user', 'session', 'account', 'verification', 'twoFactor']) {
      expect(isPlatformTable(t)).toBe(true);
    }
  });

  it('still admits a customer table that merely looks similar', () => {
    // The point of BYOD is importing tables nobody has seen before; over-refusing
    // would break the feature rather than secure it.
    for (const t of ['users', 'user_profiles', 'sessions', 'accounts_payable', 'customers']) {
      expect(isPlatformTable(t)).toBe(false);
    }
  });

  it('is not fooled by case, which PostgreSQL folds', () => {
    expect(isPlatformTable('USER')).toBe(true);
    expect(isPlatformTable('TwoFactor')).toBe(true);
    expect(isPlatformTable('Session')).toBe(true);
  });
});
