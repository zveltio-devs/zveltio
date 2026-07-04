/**
 * Extension runtime policy + observability layer.
 *
 * The original WASM sandbox plan called for wasmtime-bun (or Wasmer)
 * for third-party isolation. That's a multi-week
 * architectural shift: extensions today share the engine's V8/JSC heap,
 * and moving third-party code into WASM requires:
 *
 *   1. A capability-based bridge for `db`, `fetch`, `crypto`, OTel, etc.
 *   2. Build-pipeline support so authors can target wasm32-wasi from TS.
 *   3. A way to share Hono / Kysely types across the boundary.
 *   4. Performance characterisation against the current JS-in-process path.
 *
 * Today's reality: ALL extensions in the marketplace are first-party
 * (`zveltio-extensions/`). There is no third-party JS executing inside
 * a Zveltio engine that wasn't reviewed by the registry admin. WASM
 * isolation is the right answer for v2.0 when a third-party ecosystem
 * exists.
 *
 * What this module ships TODAY (the foundation a future WASM layer
 * plugs on top of):
 *
 *   - `ExtensionPolicy` interface — per-extension quotas + capabilities.
 *     Quotas are read from manifest (already validated by S1-06) plus
 *     env-configurable defaults. Capabilities are an explicit allow-list
 *     so a "I want to call fetch" check has a single decision point.
 *   - `policyFor(extName)` — singleton accessor; returns a default
 *     "first-party-trusted" policy when the extension isn't explicitly
 *     declared in `EXTENSION_POLICIES_JSON`.
 *   - `observePolicyDecision(...)` — fire-and-forget telemetry hook so
 *     future WASM sandbox can emit "capability X denied" events through
 *     the same surface engine internals do.
 *
 * Calling code (extension-loader.ts, restricted-db.ts) should read
 * policies through `policyFor(extName)` rather than hardcoding limits.
 * That way the WASM migration in a future wave just swaps the
 * enforcement mechanism without touching call sites.
 */

import { engineEvents } from './event-bus.js';

/** Capabilities an extension may request. Closed enum — adding a new
 *  capability requires a code change + policy review. */
export type ExtensionCapability =
  | 'db.read'
  | 'db.write'
  | 'fetch.http'
  | 'fetch.https'
  | 'crypto.subtle'
  | 'env.read'
  | 'fs.read'
  | 'fs.write'
  | 'process.spawn';

export interface ExtensionPolicy {
  /** Canonical extension name. */
  name: string;
  /** True when the extension is first-party (ships in zveltio-extensions/). */
  firstParty: boolean;
  /**
   * Allowed capabilities. First-party extensions get the full set by
   * default; third-party gets a curated subset (`db.read`, `db.write` on
   * their owned namespace, `fetch.https` only). Override per-extension
   * via `EXTENSION_POLICIES_JSON`.
   */
  capabilities: ReadonlySet<ExtensionCapability>;
  /**
   * Resource quotas. Numeric limits that the engine + future WASM
   * sandbox enforce. Bytes for memory; ms for CPU per request.
   */
  quotas: {
    /** Max archive size at install (already enforced by S1-06). */
    bundleSizeKbMax: number;
    /** Max `node_modules` size after install. */
    nodeModulesSizeKbMax: number;
    /** Max number of SQL migrations the extension may ship. */
    migrationsMax: number;
    /** Max routes registered. -1 disables the limit. */
    routesMax: number;
    /** Soft CPU budget per single request (ms). -1 disables. */
    cpuMsPerRequest: number;
    /** Memory ceiling for the extension's WASM instance (KB). Enforced
     *  by `WasmExtensionHost`; ignored for JS extensions (same process). */
    memoryKbMax: number;
  };
}

// ── Defaults ────────────────────────────────────────────────────────────────

const FIRST_PARTY_CAPABILITIES: ReadonlySet<ExtensionCapability> = new Set([
  'db.read',
  'db.write',
  'fetch.http',
  'fetch.https',
  'crypto.subtle',
  'env.read',
  'fs.read',
  'fs.write',
  // process.spawn intentionally OFF even for first-party — too
  // dangerous; if an extension needs it, audit + add explicitly.
]);

const THIRD_PARTY_CAPABILITIES: ReadonlySet<ExtensionCapability> = new Set([
  'db.read',
  'db.write',
  'fetch.https',
  'crypto.subtle',
  // No env.read (would leak secrets), no fs, no http (only https).
]);

const FIRST_PARTY_QUOTAS: ExtensionPolicy['quotas'] = {
  bundleSizeKbMax: 5 * 1024, // 5 MB
  nodeModulesSizeKbMax: 50 * 1024, // 50 MB
  migrationsMax: 50,
  routesMax: -1,
  cpuMsPerRequest: -1,
  memoryKbMax: 512 * 1024, // 512 MB
};

const THIRD_PARTY_QUOTAS: ExtensionPolicy['quotas'] = {
  bundleSizeKbMax: 2 * 1024, // 2 MB
  nodeModulesSizeKbMax: 10 * 1024, // 10 MB
  migrationsMax: 20,
  routesMax: 50,
  cpuMsPerRequest: 5_000, // 5 s
  memoryKbMax: 128 * 1024, // 128 MB
};

// First-party extensions are recognized by name prefix. We could also
// detect via manifest.is_official from S3-04 but the prefix is a stable
// signal that doesn't require a DB lookup on the hot path.
const FIRST_PARTY_PREFIXES = [
  'ai',
  'analytics/',
  'auth/',
  'billing',
  'communications/',
  'compliance/',
  'content/',
  'crm',
  'data/',
  'developer/',
  'ecommerce/',
  'finance/',
  'forms',
  'geospatial/',
  'hr/',
  'i18n/',
  'integrations/',
  'operations/',
  'projects/',
  'search',
  'sms',
  'storage/',
  'workflow/',
];

function isFirstParty(name: string): boolean {
  return FIRST_PARTY_PREFIXES.some((p) =>
    p.endsWith('/') ? name.startsWith(p) : name === p || name.startsWith(`${p}/`),
  );
}

// ── Override layer ──────────────────────────────────────────────────────────
//
// `EXTENSION_POLICIES_JSON` is a JSON object keyed by extension name. Each
// entry overrides the defaults derived above. Example:
//
//   {
//     "third-party/risky": {
//       "capabilities": ["db.read"],
//       "quotas": { "cpuMsPerRequest": 1000 }
//     }
//   }

interface PolicyOverride {
  capabilities?: ExtensionCapability[];
  quotas?: Partial<ExtensionPolicy['quotas']>;
}

function loadOverrides(): Record<string, PolicyOverride> {
  const raw = process.env.EXTENSION_POLICIES_JSON;
  if (!raw) return {};
  try {
    return JSON.parse(raw) as Record<string, PolicyOverride>;
  } catch (err) {
    console.warn(
      '[extension-sandbox] EXTENSION_POLICIES_JSON invalid JSON:',
      (err as Error).message,
    );
    return {};
  }
}

const _overrides = loadOverrides();
const _cache = new Map<string, ExtensionPolicy>();

/**
 * Resolve the policy for an extension name. Cached per process (env
 * vars don't change after start). Always returns a policy — never
 * undefined; an unknown extension gets the third-party defaults so the
 * engine fails closed rather than open.
 */
export function policyFor(extName: string): ExtensionPolicy {
  const cached = _cache.get(extName);
  if (cached) return cached;

  const firstParty = isFirstParty(extName);
  const baseCaps = firstParty ? FIRST_PARTY_CAPABILITIES : THIRD_PARTY_CAPABILITIES;
  const baseQuotas = firstParty ? FIRST_PARTY_QUOTAS : THIRD_PARTY_QUOTAS;
  const override = _overrides[extName];

  const policy: ExtensionPolicy = {
    name: extName,
    firstParty,
    capabilities: override?.capabilities
      ? (new Set(override.capabilities) as ReadonlySet<ExtensionCapability>)
      : baseCaps,
    quotas: { ...baseQuotas, ...(override?.quotas ?? {}) },
  };
  _cache.set(extName, policy);
  return policy;
}

/**
 * Check whether an extension is allowed to use a capability. Logs the
 * decision via `observePolicyDecision` for audit + telemetry.
 *
 * The runtime enforcement happens at the call site (e.g. RestrictedDb
 * already enforces `db.write` against zv_* tables in S2-02). This
 * function is the policy-decision point; the call sites consume it.
 */
export function hasCapability(extName: string, cap: ExtensionCapability): boolean {
  const policy = policyFor(extName);
  const allowed = policy.capabilities.has(cap);
  if (!allowed) observePolicyDecision(extName, cap, 'denied');
  return allowed;
}

/**
 * Emit a policy decision event. Today: log + engine event so the OTel
 * layer can surface it. Tomorrow (when WASM lands): same hook, the
 * sandbox emits one of these on every capability check.
 */
function observePolicyDecision(
  extName: string,
  cap: ExtensionCapability,
  decision: 'allowed' | 'denied',
): void {
  if (decision === 'denied') {
    console.warn(`[policy] extension="${extName}" capability="${cap}" decision=denied`);
  }
  // Best-effort event emit — never throws.
  try {
    // biome-ignore lint/suspicious/noExplicitAny: legacy any; tracked in docs/HARDENING-9-PLAN.md H-01
    (engineEvents as any).emit?.('extension.policy.decision', { extName, cap, decision });
  } catch {
    /* */
  }
}

// ── Internal helpers exposed for tests ─────────────────────────────────────

export const _internalForTests = {
  isFirstParty,
  resetCache: () => _cache.clear(),
  FIRST_PARTY_CAPABILITIES,
  THIRD_PARTY_CAPABILITIES,
};
