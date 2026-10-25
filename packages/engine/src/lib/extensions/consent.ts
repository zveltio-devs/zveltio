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
import { EXTENSION_FORWARD_CHANGED_EVENT, realtimeBus } from '../runtime/index.js';
import { onAfterCommit } from '../tenancy/index.js';

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

// ── Credential forwarding ────────────────────────────────────────────
//
// A worker extension's manifest `forwardCredentials` asks for the caller's
// cookie, bearer token or API key on named public routes. Unlike capabilities
// there is no grandfathering and no partial grant: the worker is handed the
// manifest's map only when an operator approved every (route, header) pair in
// it. A version that asks for one pair more forwards nothing until approved
// again; one that asks for less keeps its approval.

/** Manifest `forwardCredentials` shape: public route pattern → credential header names. */
export type ForwardMap = Record<string, string[]>;

/** Parse a route → headers map (JSONB or its string form). null when absent or malformed. */
export function parseForwardMap(value: unknown): ForwardMap | null {
  let raw: unknown = value;
  if (typeof raw === 'string') {
    try {
      raw = JSON.parse(raw);
    } catch {
      return null;
    }
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const out: ForwardMap = {};
  for (const [route, headers] of Object.entries(raw)) {
    if (!Array.isArray(headers) || headers.some((h) => typeof h !== 'string')) return null;
    out[route] = [...new Set((headers as string[]).map((h) => h.toLowerCase()))].sort();
  }
  return out;
}

/** Each pair of `wanted` that `allowed` does not hold, as `route: header`. */
export function forwardPairsOutside(wanted: ForwardMap, allowed: ForwardMap | null): string[] {
  return Object.entries(wanted).flatMap(([route, headers]) =>
    headers
      .filter((h) => !allowed?.[route]?.includes(h.toLowerCase()))
      .map((h) => `${route}: ${h.toLowerCase()}`),
  );
}

/**
 * What the worker may be handed: the declared map when every pair in it was
 * approved, nothing otherwise. `pending` names the pairs still awaiting approval.
 */
export function resolveForwarded(
  declared: ForwardMap,
  approved: ForwardMap | null,
): { effective: ForwardMap; pending: string[] } {
  const pending = forwardPairsOutside(declared, approved);
  return { effective: pending.length === 0 ? declared : {}, pending };
}

/**
 * The approval recorded for `name` (migration 071: by name, so an extension
 * the registry has no row for, loaded from ZVELTIO_EXTENSIONS, has one too).
 * null = never approved (or unreadable).
 */
export async function readApprovedForward(db: Database, name: string): Promise<ForwardMap | null> {
  const row = await db
    .selectFrom('zv_extension_forward_approvals')
    .select('approved')
    .where('name', '=', name)
    .executeTakeFirst();
  return parseForwardMap(row?.approved);
}

/** Record exactly this approval; null clears it. */
export async function recordForwardApproval(
  db: Database,
  name: string,
  approved: ForwardMap | null,
): Promise<void> {
  if (approved === null) {
    await db.deleteFrom('zv_extension_forward_approvals').where('name', '=', name).execute();
    return;
  }
  await db
    .insertInto('zv_extension_forward_approvals')
    .values({ name, approved: toJsonb(approved) })
    .onConflict((oc) =>
      oc.column('name').doUpdateSet({ approved: toJsonb(approved), approved_at: new Date() }),
    )
    .execute();
}

/**
 * Bring the running workers' forwarded credentials in line with the recorded
 * approvals: each of `names` (default: every worker on this node) whose
 * effective map changed is restarted with the new one, so a withdrawal ends
 * forwarding at once and the restart drops whatever the worker kept of what it
 * was handed. Reads the table, never a message: a forged bus message can only
 * cause a re-read.
 */
export async function refreshForwardApproval(db: Database, names?: string[]): Promise<void> {
  const { getWorkerHostIfInitialized } = await import('../worker-extension-host.js');
  const host = getWorkerHostIfInitialized();
  if (!host) return;
  for (const name of names ?? host.runningNames()) {
    // Read in the worker's queue, not here (setForwardCredentials). Unreadable
    // approval is no approval, as at start (register.ts). A worker that fails
    // to come back is down, which forwards nothing; the approval stays
    // recorded and the next enable or boot starts it.
    await host
      .setForwardCredentials(
        name,
        async (declared) =>
          resolveForwarded(declared, await readApprovedForward(db, name).catch(() => null))
            .effective,
      )
      .catch((err: Error) => {
        console.error(
          `[extensions] ${name}: worker restart for forward approval failed:`,
          err.message,
        );
      });
  }
}

/**
 * After an approval for `name` was written: apply it on this node, then tell
 * the other replicas (they re-read the table) once the write is committed.
 */
export async function announceForwardApproval(db: Database, name: string): Promise<void> {
  await refreshForwardApproval(db, [name]);
  onAfterCommit(() =>
    realtimeBus()
      .publish({
        event: EXTENSION_FORWARD_CHANGED_EVENT,
        collection: name,
        timestamp: new Date().toISOString(),
      })
      .catch((err: Error) => {
        console.error(`[extensions] ${name}: forward approval not broadcast:`, err.message);
      }),
  );
}
