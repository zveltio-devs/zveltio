/**
 * Extension manifest schema, types, and studio-page embedding.
 *
 * Extracted from `extension-loader.ts` (H-04 split). Owns the single source of
 * truth for what an extension's `manifest.json` may contain (`ManifestSchema`
 * Zod validator), the derived `ExtensionManifest` type, the `ManifestMeta`
 * shape cached for the Studio `/api/extensions` endpoint, and `embedPageSchemas`
 * (reads + inlines declarative studio-page JSON schemas at load time).
 *
 * Kept as a standalone module so the per-phase load helpers can import the
 * manifest type without a circular import back into the loader. The loader
 * re-exports these names so existing import sites keep working.
 */

import { join } from 'path';
import { z } from 'zod';

export const ManifestSchema = z
  .object({
    name: z.string().min(1),
    version: z
      .string()
      .regex(/^\d+\.\d+\.\d+$/)
      .default('1.0.0'),
    category: z.string().default('custom'),
    zveltioMinVersion: z.string().optional(),
    zveltioMaxVersion: z.string().nullable().optional(),
    dependencies: z
      .array(
        z.object({
          name: z.string(),
          minVersion: z.string().optional(),
        }),
      )
      .default([]),
    /** npm packages auto-installed when extension is activated (e.g. node-saml, ldapts) */
    peerDependencies: z.record(z.string(), z.string()).optional(),
    /** PostgreSQL extensions required in the database (e.g. postgis, pg_trgm) */
    requires: z
      .object({
        postgres_extensions: z.array(z.string()).optional(),
      })
      .optional(),
    permissions: z.array(z.string()).default([]),
    contributes: z
      .object({
        engine: z.boolean().default(true),
        studio: z.boolean().default(false),
        client: z.boolean().default(false),
        fieldTypes: z.array(z.string()).default([]),
        stepTypes: z.array(z.string()).default([]),
        collections: z.array(z.string()).default([]),
      })
      .optional(),
    /**
     * Resource quotas. Extensions exceeding any limit fail install with
     * EXT_QUOTA_EXCEEDED. Defaults are generous enough for current extensions;
     * publishers wanting a smaller footprint can tighten them per-extension.
     */
    quotas: z
      .object({
        bundleSizeKbMax: z.number().int().positive().default(50_000),
        nodeModulesSizeMbMax: z.number().int().positive().default(200),
        migrationsMax: z.number().int().positive().default(100),
      })
      .optional(),
    /**
     * Extension runtime. `"js"` (default) loads via dynamic
     * import of `engine/index.ts`. `"wasm"` loads via `WasmExtensionHost`
     * — the engine reads `engine/extension.wasm` and runs it inside a
     * capability-bound WebAssembly instance. WASM extensions get real
     * isolation (separate linear memory, no V8 heap access) at the cost
     * of a small ABI surface; see `docs/EXTENSION-DEVELOPER-GUIDE.md` §16.
     */
    runtime: z.enum(['js', 'wasm']).default('js').optional(),
    /**
     * v2 engine block. When present with `bundled: true`, the loader
     * imports `engine.entry` (a pre-built `.js` artifact) directly
     * without checking for the CORE_NPM_PACKAGES on disk — the bundle
     * has them inlined. See docs/EXTENSIONS-V2-PHASE1.md.
     */
    engine: z
      .object({
        entry: z.string(),
        format: z.literal('esm').default('esm'),
        target: z.enum(['bun', 'node', '*']).default('bun'),
        bundled: z.boolean(),
        bundlePeers: z.boolean().default(false),
        /**
         * Isolation strategy. `'inline'` (default) runs the extension
         * in the engine's main thread — same as today, max speed and
         * full access. `'worker'` spawns a Bun.Worker per enabled
         * extension; the worker has no DATABASE_URL, no service
         * registry write access, and all SQL is proxied through the
         * host. Use for third-party / untrusted extensions where
         * security trumps the +0.5-2ms IPC overhead per route hit.
         * See docs/EXTENSIONS-V2-PHASE1.md §10 for the threat model.
         */
        isolation: z.enum(['inline', 'worker']).default('inline'),
      })
      .optional(),
    integrity: z
      .object({
        engineSha256: z.string().regex(/^[a-f0-9]{64}$/),
        // archiveSha256 is computed by the registry on upload. The pack
        // command writes an empty string as a placeholder (registry fills
        // it in later); accept either missing/empty OR a valid hash.
        archiveSha256: z.union([z.literal(''), z.string().regex(/^[a-f0-9]{64}$/)]).optional(),
      })
      .optional(),
  })
  .passthrough();

export interface ManifestMeta {
  displayName?: string;
  description?: string;
  category?: string;
  contributes?: { engine?: boolean; studio?: boolean; client?: boolean };
  studio?: {
    navGroup?: string;
    pages?: Array<{
      path: string;
      label: string;
      icon?: string;
      /** Declarative page: a relative path under studio/ to a JSON schema
       * (in the manifest), replaced at load time by the parsed schema object
       * + `render: 'schema'` so the Studio renders it without per-host build. */
      schema?: unknown;
      render?: 'schema';
    }>;
  };
}

/**
 * Full parsed manifest type.
 *
 * Derived from the runtime Zod validator (`ManifestSchema`) rather than
 * `json-schema-to-ts` over `docs/manifest-v2.schema.json` (which H-04 proposed):
 * `z.infer` guarantees the type is exactly what `ManifestSchema.parse()` accepts
 * and returns at runtime — a stronger single-source guarantee than a mirror
 * JSON schema that nothing enforces. The `.passthrough()` fields the loader
 * reads but the strict object doesn't enumerate (`displayName`, `description`,
 * `studio`) are added explicitly so callers get real types, not `unknown`.
 */
export type ExtensionManifest = z.infer<typeof ManifestSchema> & {
  displayName?: string;
  description?: string;
  studio?: ManifestMeta['studio'];
};

/**
 * For each manifest studio page that names a JSON schema file, read + parse it
 * and inline the parsed object (so /api/extensions delivers it with no extra
 * round-trip and no per-host build). Read once at load; failures degrade
 * gracefully (the page is left as-is).
 */
export async function embedPageSchemas(
  extDir: string,
  studio: ManifestMeta['studio'],
): Promise<ManifestMeta['studio']> {
  if (!studio?.pages?.length) return studio;
  const pages = await Promise.all(
    studio.pages.map(async (p) => {
      if (typeof p.schema !== 'string') return p;
      try {
        const raw = await Bun.file(join(extDir, 'studio', p.schema)).text();
        return { ...p, schema: JSON.parse(raw) as unknown, render: 'schema' as const };
      } catch (e) {
        console.warn(`⚠️  Extension schema "${p.schema}" failed to load: ${(e as Error).message}`);
        return p;
      }
    }),
  );
  return { ...studio, pages };
}
