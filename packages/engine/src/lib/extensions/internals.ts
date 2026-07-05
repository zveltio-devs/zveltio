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
import type { ServiceRegistry } from '@zveltio/sdk/extension';
import type { Database } from '../../db/index.js';
import { dynamicInsert } from '../../db/dynamic.js';
import type { EventBus } from '../event-bus.js';
import type { FieldTypeRegistry } from '../field-type-registry.js';
import { DDLManager } from '../ddl-manager.js';
import type { QueryAlterScope } from '../query-alter.js';
import type { EntityAccessScope } from '../entity-access.js';
import { introspectSchema } from '../introspection.js';
import { runQualityScan } from '../data-quality.js';
import { invalidateRulesCache } from '../validation-engine.js';
import { runFunction as runEdgeFunction } from '../edge-functions/sandbox.js';
import { extensionRegistry } from '../extension-registry.js';
import { generatePDFAsync } from '../pdf-queue.js';
import { generatePDF, renderTemplate } from '../doc-generator.js';
import { moveToTrash } from '../cloud/trash.js';
import { extractTextFromFile, scheduleFileIndexing } from '../cloud/document-indexer.js';
import { checkQueryDepth, DataLoaderRegistry } from '../graphql-dataloader.js';
import { enqueueDDLJob } from '../ddl-queue.js';
import { validatePublicUrl } from '../edge-functions/safe-fetch.js';
import { createBetterAuthSession } from '../sso-session.js';
import { decryptField, encryptField, isEncryptedValue } from '../field-crypto.js';
import { sendNotification } from '../notifications.js';

/**
 * Internal extension context — extends the public ExtensionContext from the SDK
 * with concrete engine types (Database, FieldTypeRegistry, EventBus, DDLManager).
 * Extensions receive this at runtime but only see the public interface.
 */
export interface ExtensionContext {
  db: Database;
  /** Per-request tenant-scoped DB (request's tenant transaction + table guard).
   * Data handlers should use `ctx.reqDb(c)`; `ctx.db` is the global pool. */
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
  validatePublicUrl: (url: string) => Promise<URL>;
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
  encryptSecret: (plaintext: string) => Promise<string>;
  decryptSecret: (value: string) => Promise<string>;
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
    validatePublicUrl: validatePublicUrl as ExtensionInternals['validatePublicUrl'],
    extractTextFromFile: extractTextFromFile as ExtensionInternals['extractTextFromFile'],
    sendNotification: sendNotification as ExtensionInternals['sendNotification'],
    createBetterAuthSession,
    encryptSecret: async (plaintext: string) => {
      if (isEncryptedValue(plaintext)) return plaintext;
      return encryptField(plaintext);
    },
    decryptSecret: async (value: string) => {
      if (!isEncryptedValue(value)) return value;
      return decryptField(value);
    },
  };
}
