/**
 * The extension capability contract.
 *
 * Every powerful thing an extension can reach through `ctx.internals` is named
 * here and must be declared in the manifest's `permissions` array. Anything not
 * declared throws on use, with a message naming the capability to add.
 *
 * Three properties matter, and each is a lesson from the audit:
 *
 *  1. **Enforcement lives on the HOST side of the boundary.** This module is
 *     consulted in `buildRestrictedContext`, in the engine, when handing the
 *     context to an extension — not inside the extension's own execution. The
 *     previous capability policy (`hasCapability`) failed because its only
 *     production call site was the WASM host, so for JS extensions no denial
 *     was reachable: the policy was documented but dead.
 *
 *  2. **The list is measured, not invented.** Each entry below exists because
 *     something in the catalogue reaches for it. A contract with capabilities
 *     nobody uses is a contract that has to be carried across every future
 *     boundary for nothing — `queryAlter` and `entityAccess` are in the
 *     extension API today with zero users, and they are exactly the kind of
 *     surface that made isolation expensive.
 *
 *  3. **It is designed, not subtracted.** Closing the load-time isolation gap
 *     meant dropping field types, cron and cleanup from worker-isolated
 *     extensions — "the wide API minus what did not fit". That produces a
 *     surface nobody can build against coherently. This list is the surface a
 *     third party is meant to program against, chosen up front.
 *
 * Adding a capability is a contract change: it must be versioned, because once
 * third parties build against it you cannot subtract. See CAPABILITY_CONTRACT_VERSION.
 */

/**
 * Bumped whenever a capability is added, removed or its meaning changes.
 * The manifest may pin `capabilityContract` to refuse loading against an engine
 * that speaks a different major version.
 */
export const CAPABILITY_CONTRACT_VERSION = 1;

/**
 * Every capability an extension may declare.
 *
 * `net:<host>` is the one parameterised form — an extension declares each
 * outbound host it needs (`net:api.stripe.com`), so review sees the egress list
 * rather than a blanket "this extension uses the network".
 */
export const CAPABILITIES = [
  /** Cross-tenant database handle (`ctx.adminDb`). The most dangerous one. */
  'db:admin',
  /** Enqueue schema changes (DDL) — creates/alters physical tables. */
  'ddl',
  /** Encrypt/decrypt values with the engine's field key. */
  'secrets',
  /**
   * Mint a Better-Auth session for a user. Effectively "log anyone in", which
   * is why it must be declared: six catalogue extensions call it today and
   * nothing gated it.
   */
  'auth:session',
  /** Send notifications to users. */
  'notifications',
  /** Read/extract from stored files, move to trash, schedule indexing. */
  'files',
  /** Render PDFs and HTML templates. */
  'documents',
  /** Run an edge function. */
  'edge-functions',
  /** Inspect the database schema / extension registry. */
  'introspection',
  /**
   * Read object-storage settings and credentials via `ctx.config.objectStorage`.
   * Declared by the two extensions that talk to S3 directly; everything else
   * goes through the engine's storage routes and needs nothing.
   */
  'storage',
  /** Register cron schedules. */
  'cron',
  /** Contribute engine-side field types (code-backed). First-party only. */
  'field-types',
] as const;

export type Capability = (typeof CAPABILITIES)[number];

const CAPABILITY_SET: ReadonlySet<string> = new Set(CAPABILITIES);

/**
 * Coarse labels the catalogue already declares, kept accepted so existing
 * manifests keep validating. They grant and deny nothing.
 *
 * They predate any enforcement: `database` appears in 55 manifests and cannot
 * mean anything, because `ctx.db` is table-restricted for every extension
 * whether or not it is declared. `network` is the one worth replacing — with
 * `net:<host>`, which review can actually read as an egress list.
 *
 * `storage` used to be here too. It now gates `ctx.config.objectStorage`, which
 * carries S3 credentials — and the only two manifests that declared it are
 * exactly the two extensions that talk to S3, so the label acquired a meaning
 * without a single manifest changing.
 *
 * @deprecated Declare a capability from CAPABILITIES instead.
 */
const LEGACY_LABELS: ReadonlySet<string> = new Set(['database', 'settings', 'network']);

/** Whether `value` is a legacy no-op label rather than an enforced capability. */
export function isLegacyLabel(value: string): boolean {
  return LEGACY_LABELS.has(value);
}

/** `net:<host>` — an outbound destination, declared per host. */
const NET_RE = /^net:[a-z0-9.*-]+(?::\d+)?$/i;

/** Whether `value` is a capability this engine understands. */
export function isKnownCapability(value: string): boolean {
  return CAPABILITY_SET.has(value) || NET_RE.test(value) || LEGACY_LABELS.has(value);
}

/** The outbound hosts a capability list permits. */
export function declaredNetHosts(capabilities: readonly string[]): string[] {
  return capabilities.filter((c) => NET_RE.test(c)).map((c) => c.slice(4));
}

export class CapabilityDeniedError extends Error {
  constructor(
    readonly extName: string,
    readonly capability: Capability,
    readonly member: string,
    /**
     * True when the manifest DOES declare the capability but no administrator
     * approved it. The two cases need different messages: one is fixed by the
     * extension author editing a manifest, the other by an administrator
     * clicking approve. Telling an operator to "add it to manifest.json" when
     * it is already there sends them to the wrong place entirely.
     */
    readonly awaitingApproval = false,
  ) {
    super(
      awaitingApproval
        ? `Extension "${extName}" used ctx.internals.${member}, which needs the ` +
            `"${capability}" capability. Its manifest declares it, but no administrator ` +
            `has approved it — the extension is running without it. Approve with ` +
            `POST /api/marketplace/${extName}/approve-capabilities, then reload the extension.`
        : `Extension "${extName}" used ctx.internals.${member} without declaring the ` +
            `"${capability}" capability. Add it to "permissions" in manifest.json. ` +
            `Capabilities are shown to the administrator at install time, so an ` +
            `extension that needs more power has to ask for it visibly.`,
    );
    this.name = 'CapabilityDeniedError';
  }
}

/**
 * Which capability each guarded `ctx.internals` member requires.
 *
 * Members absent from this map are ungated — they are helpers with no ambient
 * authority (`validatePublicUrl`, `checkQueryDepth`, …). Gating those would add
 * friction without removing power.
 */
export const INTERNALS_CAPABILITY: Readonly<Record<string, Capability>> = {
  // Schema
  enqueueDDLJob: 'ddl',
  introspectSchema: 'introspection',
  extensionRegistry: 'introspection',
  runQualityScan: 'introspection',
  // Secrets — 26 call sites across the catalogue, previously ungated
  encryptSecret: 'secrets',
  decryptSecret: 'secrets',
  // HMAC under the instance auth secret. Gated with the other key-material
  // helpers: the extension that needs it used to hold BETTER_AUTH_SECRET itself.
  deriveTokenHash: 'secrets',
  // Identity — "log anyone in"
  createBetterAuthSession: 'auth:session',
  // Messaging
  sendNotification: 'notifications',
  // Files
  extractTextFromFile: 'files',
  moveToTrash: 'files',
  scheduleFileIndexing: 'files',
  // Rendering
  generatePDF: 'documents',
  generatePDFAsync: 'documents',
  renderTemplate: 'documents',
  // Compute
  runEdgeFunction: 'edge-functions',
};

/**
 * Wrap an internals bag so each guarded member throws unless the extension
 * declared its capability.
 *
 * The wrapper is a Proxy rather than a rebuilt object so a member added to
 * ExtensionInternals later is ungated-but-present by default, instead of
 * silently disappearing — a missing helper is a confusing bug, whereas an
 * ungated one is a review item caught by the test that asserts every guarded
 * member is mapped.
 */
export function gateInternals<T extends object>(
  extName: string,
  internals: T,
  capabilities: readonly string[],
  /**
   * Capabilities the manifest declares but no administrator approved. Used only
   * to phrase the denial correctly — they are NOT granted.
   */
  pending: readonly string[] = [],
): T {
  // `ctx.internals` is optional on the context type and absent in some callers
  // (test stubs, and any path that builds a context before internals exist).
  // A guard that crashes the loader when there is nothing to guard would be a
  // worse failure than the one it prevents.
  if (internals === null || typeof internals !== 'object') return internals;

  const granted = new Set(capabilities);
  const awaiting = new Set(pending);

  return new Proxy(internals, {
    get(target, prop, receiver) {
      const value = Reflect.get(target, prop, receiver);
      if (typeof prop !== 'string') return value;

      const required = INTERNALS_CAPABILITY[prop];
      if (!required || granted.has(required)) return value;
      const unapproved = awaiting.has(required);

      // Throw at CALL time, not at property access: extensions destructure
      // (`const { decryptSecret } = ctx.internals`) at module scope, and
      // throwing there would fail the load with a stack that points nowhere
      // near the offending call.
      if (typeof value === 'function') {
        return () => {
          throw new CapabilityDeniedError(extName, required, prop, unapproved);
        };
      }
      throw new CapabilityDeniedError(extName, required, prop, unapproved);
    },
  });
}
