/**
 * `ZVELTIO_COLLECTION_RLS_EXEMPT` — extensions an operator exempts from
 * collection permissions in the database (R1), by name, until they are adapted.
 *
 * Owner decision (2026-10-04): collection permissions are always enforced, and
 * cannot be switched off for the engine's own routes. What an operator can do is
 * name extensions that still assume the old world; those run as "system inside
 * the tenant" — tenant isolation and the table guard still hold — and nothing
 * else changes. An exemption is loud on purpose: a warning at every boot, a
 * field in `/api/health/deep`, and it goes away at 3.0.0 GA.
 *
 * Mechanism: the extension's own database roles join `zveltio_coll_exempt`
 * (migration 058), which `zveltio_collection_allows` admits. Only per-extension
 * roles can be exempted. On a database where extensions share one role
 * (no CREATEROLE), exempting one would exempt them all, so nothing is exempted
 * and the boot says why.
 */

import { sql } from 'kysely';
import type { Database } from '../../db/index.js';

export const EXEMPT_ROLE = 'zveltio_coll_exempt';

/** The extension names the operator listed. Read per call: tests set it. */
export function collectionRlsExemptions(): Set<string> {
  return new Set(
    (process.env.ZVELTIO_COLLECTION_RLS_EXEMPT ?? '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),
  );
}

/** Extensions that are exempt right now — their roles hold the membership. */
const applied = new Set<string>();

/** What `/api/health/deep` reports. */
export function collectionRlsExemptionStatus(): {
  configured: string[];
  applied: string[];
} {
  return { configured: [...collectionRlsExemptions()].sort(), applied: [...applied].sort() };
}

/**
 * Give `roles` (an extension's own: plain, bypass twin, worker) the exemption
 * when the extension is listed, take it away when it is not. Never throws: a
 * database without the role, or an engine without ADMIN on it, is warned about
 * and leaves the extension enforced — the safe direction.
 */
export async function syncCollectionExemption(
  db: Database,
  extName: string,
  roles: ReadonlyArray<string | null | undefined>,
): Promise<void> {
  const exempt = collectionRlsExemptions().has(extName);
  const own = roles.filter(
    (r): r is string => typeof r === 'string' && /^[a-z0-9_]{1,63}$/.test(r),
  );
  try {
    const present = await sql<{ ok: boolean }>`
      SELECT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = ${EXEMPT_ROLE}) AS ok
    `.execute(db);
    if (!present.rows[0]?.ok) {
      if (exempt) {
        console.warn(
          `[collection-rls] "${extName}" is listed in ZVELTIO_COLLECTION_RLS_EXEMPT, but ` +
            `${EXEMPT_ROLE} does not exist (migration 058 could not create it) — not exempted`,
        );
      }
      return;
    }
    for (const role of own) {
      if (exempt) await sql.raw(`GRANT ${EXEMPT_ROLE} TO ${role}`).execute(db);
      else
        await sql
          .raw(`REVOKE ${EXEMPT_ROLE} FROM ${role}`)
          .execute(db)
          .catch(() => undefined);
    }
    if (exempt && own.length > 0) applied.add(extName);
    else applied.delete(extName);
  } catch (err) {
    applied.delete(extName);
    console.warn(
      `[collection-rls] could not ${exempt ? 'exempt' : 'un-exempt'} "${extName}":`,
      (err as Error).message,
    );
  }
}

/**
 * The boot warning. Every boot, naming each exempted extension, until they are
 * adapted or the exemption is removed at 3.0.0 GA.
 */
export function warnCollectionRlsExemptions(sharedRoles: boolean): void {
  const listed = [...collectionRlsExemptions()];
  if (listed.length === 0) return;
  console.warn(
    `[collection-rls] ${listed.length} extension(s) run WITHOUT collection permissions in the ` +
      `database (ZVELTIO_COLLECTION_RLS_EXEMPT): ${listed.join(', ')}. They act as the system ` +
      'inside each tenant. Adapt them (ctx.internals.asSystem for what is more than the ' +
      "user's rights) and remove them from the list; the exemption is removed at 3.0.0 GA.",
  );
  if (sharedRoles) {
    console.warn(
      '[collection-rls] extensions share one database role here (no CREATEROLE), so an ' +
        'exemption cannot be limited to one extension — none is applied.',
    );
  }
}
