/**
 * The extension execution context + `ctx.internals` helper bag.
 *
 * Extracted from `extension-loader.ts` (H-04 split). `ExtensionContext` is the
 * engine-internal context handed to every extension's `register()`, extending
 * the SDK's public shape with concrete engine types. `ExtensionInternals` is the
 * lazy helper bag on `ctx.internals`, and `buildExtensionInternals()` constructs
 * it from statically-imported engine helpers (all already linked into the
 * binary, so this is just struct construction). The loader re-exports all three
 * so existing import sites keep working.
 */

import type { Context } from 'hono';
import type { ExtensionConfig, ServiceRegistry } from '@zveltio/sdk/extension';
import type { Database } from '../../db/index.js';
import { dynamicInsert } from '../../db/dynamic.js';
import type { EventBus } from '../runtime/index.js';
import type { FieldTypeRegistry } from '../data/index.js';
import { DDLManager } from '../data/index.js';
import type { QueryAlterScope } from '../data/index.js';
import type { EntityAccessScope } from '../tenancy/index.js';
import { introspectSchema } from '../introspection.js';
import { runQualityScan } from '../data-quality.js';
import { invalidateRulesCache } from '../validation-engine.js';
import { runFunction as runEdgeFunction } from '../edge-functions/sandbox.js';
import { extensionRegistry } from './extension-registry.js';
import { generatePDFAsync } from '../pdf-queue.js';
import { generatePDF, renderTemplate } from '../doc-generator.js';
import { moveToTrash } from '../cloud/trash.js';
import { extractTextFromFile, scheduleFileIndexing } from '../cloud/document-indexer.js';
import { checkQueryDepth, DataLoaderRegistry } from '../graphql-dataloader.js';
import { enqueueDDLJob } from '../data/index.js';
import { assertPublicUrl, validatePublicUrl } from '../edge-functions/safe-fetch.js';
import { assertNonMetadataUrl } from '../security/index.js';
import { createBetterAuthSession } from '../security/index.js';
import { encryptField } from '../data/index.js';
import type { Keyring } from '../security/index.js';
import {
  decryptWithKeyring,
  encryptWithKeyring,
  hmacAuthSecret,
  isKeyringValue,
} from '../security/index.js';
import { sendNotification } from '../notifications.js';

/**
 * Internal extension context — extends the public ExtensionContext from the SDK
 * with concrete engine types (Database, FieldTypeRegistry, EventBus, DDLManager).
 * Extensions receive this at runtime but only see the public interface.
 */
export interface ExtensionContext {
  /** Tenant-scoped DB (H-12): resolves the current request/job tenant
   * transaction (RLS-isolated), or the global pool outside a tenant context.
   * Safe for normal data access — no longer the cross-tenant global handle. */
  db: Database;
  /** Host-resolved configuration (`ctx.config`) — what an extension may read
   * instead of `process.env`. Built per extension, since `objectStorage` is
   * gated by the `storage` capability. */
  config?: ExtensionConfig;
  /** Explicit CROSS-TENANT handle. Present only when the manifest declares the
   * `db:admin` permission; otherwise any use throws. For legitimately global
   * operations only (e.g. platform-wide reporting). */
  adminDb?: Database;
  /** Per-request tenant-scoped DB (request's tenant transaction + table guard).
   * Equivalent to `ctx.db` within a request; kept for handlers that pass `c`. */
  reqDb?: (c: Context) => Database;
  // Better-Auth instance. Its type is a deep generic over the configured
  // plugins/adapters; naming it here would couple the loader to the exact
  // better-auth build. Kept `any` as a documented survivor (H-04).
  // biome-ignore lint/suspicious/noExplicitAny: better-auth instance is a deep generic; documented survivor (H-04)
  auth: any;
  fieldTypeRegistry: FieldTypeRegistry;
  events: EventBus;
  checkPermission: (userId: string, resource: string, action: string) => Promise<boolean>;
  getUserRoles: (userId: string) => Promise<string[]>;
  DDLManager: typeof DDLManager;
  /** Inter-extension service registry — see service-registry.ts */
  services: ServiceRegistry;
  /** Query-alter registry — see query-alter.ts. Extensions add global WHERE
   * filters here (tenant isolation, soft-delete masks, redaction). */
  queryAlter: QueryAlterScope;
  /** Entity-access registry — see entity-access.ts. Per-record allow/deny
   * callbacks; first deny wins across all extensions. */
  entityAccess: EntityAccessScope;
  /** Register a subsystem health check surfaced at `/api/health/deep` and
   * `/api/health/<name>` (H-1.4). Namespaced `ext:<extName>:<name>`; cleared on
   * reload. Mark `critical` only if this failing should fail readiness. */
  onHealthCheck: (
    name: string,
    run: () =>
      | Promise<{ ok: boolean; error?: string; detail?: Record<string, unknown> }>
      | { ok: boolean; error?: string; detail?: Record<string, unknown> },
    opts?: { critical?: boolean },
  ) => void;
  /** Escape hatch for routes on the engine's global app (outside /ext/<name>).
   * See SDK `registerPublicRoute` JSDoc for usage and trade-offs. */
  registerPublicRoute: (spec: {
    method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE' | 'OPTIONS' | 'HEAD' | 'ALL';
    path: string;
    handler: (c: Context) => Response | Promise<Response>;
  }) => void;
  internals: ExtensionInternals;
}

/**
 * Engine-internal helpers exposed to official extensions via ctx.internals.*.
 * Lazy-loaded at first access to avoid forcing every extension into pulling
 * heavy modules (PDF rendering, edge sandbox, etc.) when they don't need them.
 */
export interface ExtensionInternals {
  // Fields typed as `typeof <helper>` mirror the engine helper's real signature
  // (single source of truth) — no `any`, no cast in buildExtensionInternals().
  dynamicInsert: typeof dynamicInsert;
  introspectSchema: typeof introspectSchema;
  runQualityScan: typeof runQualityScan;
  invalidateRulesCache: (collection: string) => void;
  runEdgeFunction: typeof runEdgeFunction;
  extensionRegistry: typeof extensionRegistry;
  generatePDFAsync: (html: string, options?: Record<string, unknown>) => Promise<unknown>;
  renderTemplate: (template: string, variables: Record<string, unknown>) => string;
  generatePDF: typeof generatePDF;
  moveToTrash: typeof moveToTrash;
  scheduleFileIndexing: typeof scheduleFileIndexing;
  DataLoaderRegistry: typeof DataLoaderRegistry;
  checkQueryDepth: (query: string, maxDepth?: number) => string | null;
  enqueueDDLJob: typeof enqueueDDLJob;
  /**
   * Synchronous literal-host SSRF check. Throws on a blocked URL, returns
   * nothing. Declared `Promise<URL>` here for a long time, which was simply
   * wrong — the function is sync and returns void. It matters: an author who
   * believed the signature and wrote `await ctx.validatePublicUrl(u)` in an
   * async guard would still be validating, but one who branched on the
   * resolved value got `undefined`. Callers in a sync context (e.g. a zod
   * superRefine) depend on it staying synchronous.
   */
  validatePublicUrl: (url: string) => void;
  /**
   * DNS-aware SSRF check — everything validatePublicUrl does, plus rejecting
   * hostnames that RESOLVE into private space. Prefer this whenever the call
   * site can await; it is the only variant that stops an attacker-controlled
   * name pointing at cloud metadata. MUST be awaited.
   */
  assertPublicUrl: (url: string) => Promise<void>;
  /**
   * SSRF guard for an admin-configured endpoint that is ALLOWED to be
   * self-hosted (local Ollama, internal Meilisearch, on-prem object storage).
   * Permits private ranges but rejects cloud-metadata hosts. Use this — NOT
   * validatePublicUrl/assertPublicUrl — for provider "base URL" settings, or
   * you will break every localhost deployment. Synchronous; throws when blocked.
   */
  assertNonMetadataUrl: (url: string, label?: string) => void;
  extractTextFromFile: (
    buffer: ArrayBuffer | Buffer | Uint8Array,
    mimeType: string,
  ) => Promise<string>;
  // NOT `typeof sendNotification`: the SDK's public ExtensionContext declares a
  // looser `input` (message optional) than the engine helper (message required),
  // so this slot must stay at least as loose as the SDK's. `unknown` params keep
  // it loose without `any`; the real (stricter) fn is cast in buildExtensionInternals.
  sendNotification: (db: unknown, input: unknown) => Promise<void>;
  createBetterAuthSession: typeof createBetterAuthSession;
  /**
   * Encrypt with a host-held key. `keyring` selects WHICH key: 'field' (the
   * default, FIELD_ENCRYPTION_KEY) or 'mail' (MAIL_ENCRYPTION_KEY), so an
   * extension never has to hold key material to get blast-radius separation.
   */
  encryptSecret: (plaintext: string, opts?: { keyring?: Keyring }) => Promise<string>;
  /** Decrypt a value produced by `encryptSecret`, or by the per-extension
   * crypto that predated it — the envelope selects the key. */
  decryptSecret: (value: string, opts?: { keyring?: Keyring }) => Promise<string>;
  /**
   * HMAC-SHA256 under the instance auth secret, hex encoded. A compatibility
   * surface for auth/scim's stored bearer-token hashes — not a general MAC.
   */
  deriveTokenHash: (raw: string) => Promise<string>;
}

/**
 * Build the `ctx.internals` object passed to every extension. All helpers are
 * statically imported above and already linked into the engine binary — building
 * the object is just struct construction. Called once by the engine bootstrap
 * (index.ts) and passed to `loadAll`.
 */
export function buildExtensionInternals(): ExtensionInternals {
  return {
    dynamicInsert,
    introspectSchema,
    runQualityScan,
    invalidateRulesCache,
    runEdgeFunction,
    extensionRegistry,
    generatePDFAsync: generatePDFAsync as ExtensionInternals['generatePDFAsync'],
    renderTemplate,
    generatePDF,
    moveToTrash,
    scheduleFileIndexing,
    DataLoaderRegistry,
    checkQueryDepth,
    enqueueDDLJob,
    validatePublicUrl,
    assertPublicUrl,
    assertNonMetadataUrl,
    extractTextFromFile: extractTextFromFile as ExtensionInternals['extractTextFromFile'],
    sendNotification: sendNotification as ExtensionInternals['sendNotification'],
    createBetterAuthSession,
    encryptSecret: async (plaintext: string, opts?: { keyring?: Keyring }) => {
      const keyring = opts?.keyring ?? 'field';
      // Already-encrypted input is returned untouched so a caller that
      // re-saves a record does not double-wrap what it read.
      if (isKeyringValue(plaintext)) return plaintext;
      if (keyring === 'field') return encryptField(plaintext);
      return encryptWithKeyring(plaintext, keyring);
    },
    decryptSecret: async (value: string, opts?: { keyring?: Keyring }) => {
      if (!isKeyringValue(value)) return value;
      return decryptWithKeyring(value, opts?.keyring ?? 'field');
    },
    deriveTokenHash: hmacAuthSecret,
  };
}
