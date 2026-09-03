/**
 * Capability consent — what an administrator agreed to, versus what an
 * extension asks for.
 *
 * The manifest DECLARES capabilities. `zv_extension_registry.granted_capabilities`
 * records what was GRANTED. Without that distinction the capability contract is
 * only as strong as the extension's own manifest: ship v1 declaring nothing,
 * ship v2 declaring `db:admin`, and an update grants cross-tenant database
 * access with nobody deciding anything.
 *
 * So the set handed to the gate is the EFFECTIVE one — granted ∩ declared —
 * and a manifest that widens its request achieves nothing until an admin
 * approves it. Both directions of the intersection matter:
 *
 *   • declared minus granted → pending. The extension keeps running, but
 *     without the new power. This is the whole point.
 *   • granted minus declared → dropped. An extension that stops asking for a
 *     capability loses it; consent does not accumulate across versions.
 *
 * A widening request does NOT refuse the load. Refusing would turn a routine
 * update into an outage for every feature that does not touch the new
 * capability, and the failure would arrive as a dead extension rather than a
 * decision to make. Instead the extension runs with what it had, the first use
 * of the new power throws a CapabilityDeniedError naming it, and the pending
 * request is surfaced for the admin to approve or reject.
 */

import type { Database } from '../../db/index.js';
import { toJsonb } from '../jsonb.js';

/** Parse the JSONB column, tolerating the string form some drivers return. */
export function parseGranted(value: unknown): string[] | null {
  if (value === null || value === undefined) return null;
  let raw: unknown = value;
  if (typeof raw === 'string') {
    try {
      raw = JSON.parse(raw);
    } catch {
      return null;
    }
  }
  if (!Array.isArray(raw)) return null;
  return raw.filter((v): v is string => typeof v === 'string');
}

export interface EffectiveCapabilities {
  /** What the gate should enforce. */
  effective: string[];
  /** Declared but never consented to — an admin has to approve these. */
  pending: string[];
  /** Consented to previously, no longer requested. */
  dropped: string[];
  /** True when no consent has ever been recorded (pre-existing install). */
  grandfathered: boolean;
}

/**
 * Resolve what an extension may actually use.
 *
 * `granted === null` means the install predates consent tracking. Those are
 * grandfathered to their declared set rather than crippled: nobody was ever
 * asked, so treating silence as refusal would break working installs on an
 * engine upgrade. Consent is recorded from the next install/enable onwards.
 */
export function resolveCapabilities(
  declared: readonly string[],
  granted: readonly string[] | null,
): EffectiveCapabilities {
  if (granted === null) {
    return { effective: [...declared], pending: [], dropped: [], grandfathered: true };
  }
  const grantedSet = new Set(granted);
  const declaredSet = new Set(declared);
  return {
    effective: declared.filter((c) => grantedSet.has(c)),
    pending: declared.filter((c) => !grantedSet.has(c)),
    dropped: granted.filter((c) => !declaredSet.has(c)),
    grandfathered: false,
  };
}

/** Read the recorded consent for one extension. null = never recorded. */
export async function readGranted(db: Database, name: string): Promise<string[] | null> {
  const row = await db
    .selectFrom('zv_extension_registry')
    .select('granted_capabilities')
    .where('name', '=', name)
    .executeTakeFirst();
  if (!row) return null;
  return parseGranted(row.granted_capabilities);
}

/**
 * Record consent for exactly this set.
 *
 * Stored as the full set rather than a delta so the record answers "what may
 * this extension do" directly, without replaying history — and so a capability
 * an extension stopped asking for actually disappears.
 */
export async function recordConsent(
  db: Database,
  name: string,
  capabilities: readonly string[],
): Promise<void> {
  await db
    .updateTable('zv_extension_registry')
    .set({ granted_capabilities: toJsonb([...new Set(capabilities)].sort()) })
    .where('name', '=', name)
    .execute();
}
