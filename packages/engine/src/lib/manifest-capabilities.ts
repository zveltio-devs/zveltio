/**
 * What an extension manifest asks consent for, read from its raw JSON. Pure:
 * `extensions/consent.ts` decides with it, and `tenancy/resource-grants.ts`
 * prunes with it when a new manifest is recorded, which neither subsystem
 * could do through the other's barrel without a cycle.
 */

/** A job's consented egress authority, as a capability (ADR 0022 decision 5). */
export const EGRESS_PREFIX = 'egress:';

const strings = (v: unknown) =>
  Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
const jobsOf = (manifest: unknown): unknown[] => {
  const jobs = ((manifest ?? {}) as { jobs?: unknown }).jobs;
  return Array.isArray(jobs) ? jobs : [];
};

/**
 * ADR 0047: an action listing `"*"` in `reads` / `writes` reaches any
 * collection the person running it can read / write. Derived from the actions,
 * never declarable in `permissions`, and consented like any capability: a
 * version that starts asking runs without it until an administrator approves.
 */
export const ANY_COLLECTION = {
  reads: 'collections:any:read',
  writes: 'collections:any:write',
} as const;

/**
 * What a manifest asks consent for: its `permissions`, one
 * `egress:<authority>` per authority its jobs declare, and `ANY_COLLECTION`'s
 * entries for `"*"` in an action's `reads` / `writes`. Anything not a string
 * is ignored, as it is for `permissions`.
 */
export function declaredCapabilities(manifest: unknown): string[] {
  const egress = jobsOf(manifest).flatMap((j) =>
    strings((j as { egress?: unknown } | null)?.egress).map((a) => `${EGRESS_PREFIX}${a}`),
  );
  const actions = (manifest as { actions?: unknown } | null)?.actions;
  const any = (Array.isArray(actions) ? actions : []).flatMap((a) =>
    (['reads', 'writes'] as const)
      .filter((k) => strings((a as Record<string, unknown> | null)?.[k]).includes('*'))
      .map((k) => ANY_COLLECTION[k]),
  );
  return [
    ...new Set([
      ...strings((manifest as { permissions?: unknown } | null)?.permissions),
      ...egress,
      ...any,
    ]),
  ];
}

/**
 * A job's `egressSlots` entry: a name, an HTTP slot, or `{ name, kind }`
 * (ADR 0026 amendment: `kind: "tcp"` is a relayed TCP stream). Anything else
 * is ignored, as a non-string permission is.
 */
type Slot = { name: string; kind: 'http' | 'tcp' };
const slotsOf = (j: unknown): Slot[] => {
  const raw = (j as { egressSlots?: unknown } | null)?.egressSlots;
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((s): Slot[] => {
    if (typeof s === 'string') return [{ name: s, kind: 'http' }];
    const o = s as { name?: unknown; kind?: unknown } | null;
    if (typeof o?.name !== 'string') return [];
    if (o.kind === undefined || o.kind === 'http') return [{ name: o.name, kind: 'http' }];
    return o.kind === 'tcp' ? [{ name: o.name, kind: 'tcp' }] : [];
  });
};

/** Every slot name a manifest's jobs declare (`egressSlots`). */
export function declaredSlots(manifest: unknown): Set<string> {
  return new Set(jobsOf(manifest).flatMap((j) => slotsOf(j).map((s) => s.name)));
}

/** The slots a manifest's jobs declare as `kind: "tcp"`: each binding carries a port. */
export function declaredTcpSlots(manifest: unknown): Set<string> {
  return new Set(
    jobsOf(manifest).flatMap((j) =>
      slotsOf(j)
        .filter((s) => s.kind === 'tcp')
        .map((s) => s.name),
    ),
  );
}

/** The slot a consent entry binds (`egress:<slot>=…`, ADR 0026), or null. */
export function boundSlot(cap: string): string | null {
  return /^egress:([a-z][a-z0-9_]*)=/.exec(cap)?.[1] ?? null;
}

/**
 * The consent that survives a new manifest: what it still declares, and the
 * bindings of the slots it still declares. A capability a version stopped
 * asking for is not carried to a later version that asks again: that one
 * asks again (owner decision 2026-11-08, ADR 0026 amendment).
 */
export function consentKeptBy(granted: readonly string[], manifest: unknown): string[] {
  const declared = new Set(declaredCapabilities(manifest));
  const slots = declaredSlots(manifest);
  return granted.filter((c) => {
    const slot = boundSlot(c);
    return slot === null ? declared.has(c) : slots.has(slot);
  });
}
