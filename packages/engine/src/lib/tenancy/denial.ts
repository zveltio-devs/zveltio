/**
 * A refusal is a fork in the road, not the end of one.
 *
 * The product used to answer `Forbidden: missing payroll:read permission`. In
 * English, on a Romanian product, naming an internal concept, to someone from
 * HR who opened a page. It says what is absent and nothing about what to do,
 * and the person reading it cannot tell whether they found a bug or a rule.
 *
 * That got worse before it got better: deny-by-default (beta.55) and the
 * tenant-isolation fix (beta.57) both made the system refuse correctly where it
 * used to wave things through, so more people meet this message more often. A
 * system that became stricter without becoming clearer is just harder to use.
 *
 * The information needed to fix it is already in the database. Somebody in this
 * tenant holds `tenant_admin` or `tenant_owner`; that is one query away, and
 * naming them turns a dead end into a next step.
 *
 * WHAT IS DELIBERATELY WITHHELD
 *
 * Names, never email addresses. The point is "ask Ana", not a directory export
 * for whoever probes a 403. Capped at three, because a list of fifteen is not
 * help. And nothing about WHY the resource is guarded beyond whether it is
 * confidential — which the person already knows if they work here.
 */
import { sql } from 'kysely';
import type { Database } from '../../db/index.js';
import { isSensitiveResource } from './permissions.js';
import { getCurrentDomain } from './tenant-context.js';

/** Someone who can grant access, as the person refused should see them. */
export interface Granter {
  name: string;
}

export interface DenialContext {
  resource: string;
  action: string;
  /** Whether this resource is withheld by policy rather than by omission. */
  confidential: boolean;
  /** Who to ask. Empty when nobody holds an administrative role here. */
  canGrant: Granter[];
}

/** How many names are useful. Beyond this it stops being a suggestion. */
const MAX_GRANTERS = 3;

/**
 * Who, in this tenant, can hand out access.
 *
 * Administrators rather than "whoever already holds this resource": a colleague
 * with payroll access cannot give it to you, and sending someone to them wastes
 * both their time. The grant lives with `tenant_admin` / `tenant_owner`, whose
 * policies are total.
 *
 * Grants at domain `*` are included — that is how a single-tenant install and
 * every pre-tenancy grant are stored, and excluding them would return nobody on
 * the most common deployment.
 */
export async function whoCanGrant(db: Database, tenantId?: string): Promise<Granter[]> {
  const domain = tenantId ?? getCurrentDomain();
  try {
    const rows = await sql<{ name: string | null }>`
      SELECT DISTINCT u.name
        FROM zvd_permissions g
        JOIN "user" u ON u.id = g.v0
       WHERE g.ptype = 'g'
         AND g.v1 IN ('tenant_owner', 'tenant_admin')
         AND (g.v2 = ${domain} OR g.v2 = '*')
         AND u.name IS NOT NULL
       ORDER BY u.name
       LIMIT ${MAX_GRANTERS}
    `.execute(db);
    return rows.rows
      .filter((r): r is { name: string } => Boolean(r.name))
      .map((r) => ({ name: r.name }));
  } catch {
    // A refusal must never fail. Losing the suggestion costs a nicer message;
    // throwing here would turn a 403 into a 500 and lose the refusal itself.
    return [];
  }
}

/**
 * Everything a caller needs to render a refusal a person can act on.
 *
 * Returned as data rather than a sentence so the Studio can draw a screen, a
 * CLI can print a line, and both can translate it. The engine does not decide
 * how it looks.
 */
export async function describeDenial(
  db: Database,
  resource: string,
  action: string,
  tenantId?: string,
): Promise<DenialContext> {
  return {
    resource,
    action,
    confidential: isSensitiveResource(resource),
    canGrant: await whoCanGrant(db, tenantId),
  };
}

/**
 * A sentence for callers that have nowhere to put structured data — logs, the
 * CLI, an extension that has not been updated.
 *
 * English here because this is the fallback, and the engine has no locale for a
 * request it is refusing. The Studio renders the structured form, translated.
 */
export function denialSentence(d: DenialContext): string {
  const what = d.confidential
    ? `${d.resource} is confidential`
    : `you do not have access to ${d.resource}`;
  if (d.canGrant.length === 0) {
    return `${what}. An administrator of this workspace can grant it.`;
  }
  const names = d.canGrant.map((g) => g.name);
  const who =
    names.length === 1
      ? names[0]
      : `${names.slice(0, -1).join(', ')} or ${names[names.length - 1]}`;
  return `${what}. ${who} can give you access.`;
}
