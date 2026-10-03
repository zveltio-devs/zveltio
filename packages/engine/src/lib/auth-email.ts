import { sql } from 'kysely';
import type { DBAdapter, Where } from 'better-auth';
import type { Database } from '../db/index.js';

/**
 * The spelling of `email` that "user" stores, so that an exact comparison finds
 * the account whatever case it was given in.
 *
 * Lookup side on purpose, never a rewrite of the stored value: a row rule
 * `owner_email eq user_email` compares exactly against row values written with
 * the stored casing, so lowercasing "user".email would cost its owner every row
 * that rule grants.
 *
 * With migration 048's `user_email_lower_key` in place there is at most one
 * candidate. Without it (accounts sharing an address in another case) the exact
 * spelling wins, and an address no account holds exactly matches nobody rather
 * than whichever twin Postgres returns first.
 */
export async function storedEmail(db: Database, email: string): Promise<string> {
  const r = await sql<{ email: string }>`
    SELECT email FROM "user" WHERE lower(email) = lower(${email})
     ORDER BY email = ${email} DESC LIMIT 2`.execute(db);
  const [first, second] = r.rows;
  if (!first || first.email === email) return email;
  if (!second) return first.email;
  console.warn(
    `[auth] ${email} matches several accounts in another case and none exactly; refusing to ` +
      'pick one. See "Accounts that share an address in another case" in docs/platform/troubleshooting.md.',
  );
  return email;
}

const LOOKUPS = [
  'findOne',
  'findMany',
  'count',
  'update',
  'updateMany',
  'delete',
  'deleteMany',
  'consumeOne',
  'incrementOne',
] as const;

/**
 * better-auth lowercases an address and then compares it EXACTLY — in sign-in,
 * sign-up, password reset, magic link, email verification, OAuth account
 * linking. A row stored in another case (older than that lowercasing, or written
 * by an SSO/SCIM extension with the IdP's spelling) was invisible to all of
 * them. Every one goes through this adapter, so this is the one place that
 * resolves the address to its stored spelling first.
 */
export function withStoredEmailLookup(adapter: DBAdapter, db: Database): DBAdapter {
  const resolve = async (where: Where[]) =>
    Promise.all(
      where.map(async (w) =>
        w.field === 'email' &&
        (w.operator ?? 'eq') === 'eq' &&
        w.mode !== 'insensitive' &&
        typeof w.value === 'string'
          ? { ...w, value: await storedEmail(db, w.value) }
          : w,
      ),
    );
  const wrapped: DBAdapter = { ...adapter };
  // A transaction hands its callback the inner adapter, which must resolve too.
  if (adapter.transaction) {
    wrapped.transaction = (cb) =>
      adapter.transaction((trx) => cb(withStoredEmailLookup(trx as DBAdapter, db)));
  }
  for (const name of LOOKUPS) {
    const original = adapter[name] as (arg: { model: string; where?: Where[] }) => Promise<unknown>;
    if (typeof original !== 'function') continue;
    (wrapped as unknown as Record<string, unknown>)[name] = async (arg: {
      model: string;
      where?: Where[];
    }) =>
      original(
        arg.model === 'user' && arg.where ? { ...arg, where: await resolve(arg.where) } : arg,
      );
  }
  return wrapped;
}
