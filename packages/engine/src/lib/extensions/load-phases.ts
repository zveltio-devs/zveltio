/**
 * Per-phase helpers for `ExtensionLoader.loadExtension` (H-04 split).
 *
 * Each phase is a standalone, `this`-free function that does the pure work of
 * one lifecycle stage (manifest resolve+validate, publisher-tier gate, entry
 * resolution) and returns a discriminated result. It NEVER mutates loader state
 * (`lastLoadError`, `manifestMeta`, `modules`, …) and NEVER logs — the caller
 * owns those side effects so the exact log strings, `lastLoadError.set` calls,
 * and early-return semantics stay byte-identical to the pre-split method.
 *
 * On failure the phase reports, verbatim, what the inline code did: which
 * `console.*` channel it used and with which argument(s) (`logLevel` +
 * `logArgs`), and what (if anything) it stashed in `lastLoadError`
 * (`lastLoadError`, or null when the inline path set nothing). The caller
 * replays those uniformly.
 */

import { existsSync, readFileSync } from 'node:fs';
import { sql as _sql } from 'kysely';
import { join } from 'path';
import type { Database } from '../../db/index.js';
import {
  type ExtensionCatalogEntry,
  resolvePublisherTier,
  tierAllowsInline,
} from '../extension-catalog.js';
import { CORE_NPM_PACKAGES, maybeSymlinkNodeModules } from '../extension-deps.js';
import { fetchRegistryCatalog } from '../extension-download.js';
import { DEFAULT_QUOTAS, QuotaExceededError } from '../extension-errors.js';
import { resolveExtensionsBase } from '../extension-paths.js';
import { directorySizeBytes } from '../extension-utils.js';
import { checkExtensionDependencies, getEngineVersion, isCompatible } from '../version-checker.js';
import {
  type ExtensionManifest,
  ManifestSchema,
  type ManifestMeta,
  embedPageSchemas,
} from './manifest-schema.js';
import { installExtensionNpmDependencies } from './npm-install.js';

/**
 * Discriminated result for a load phase.
 *
 * On failure it mirrors, exactly, what the pre-split inline path did:
 *   - `logLevel` — which `console.*` the inline code called (`'warn'` |
 *     `'error'`), or `'none'` when the inline path logged nothing.
 *   - `logArgs`  — the exact argument list passed to `console[logLevel]`
 *     (a tuple so two-argument calls are reproduced faithfully).
 *   - `lastLoadError` — the exact value the inline path stashed in the
 *     loader's `lastLoadError` map, or `null` when it stashed nothing.
 */
export type PhaseFail = {
  ok: false;
  logLevel: 'warn' | 'error' | 'none';
  logArgs: unknown[];
  lastLoadError: string | null;
};

export type PhaseResult<T> = { ok: true; value: T } | PhaseFail;

/** Fields the manifest phase derives + hands back to the caller. */
export interface ManifestResolution {
  /** Parsed + validated manifest, or null when the extension ships none. */
  manifest: ExtensionManifest | null;
  /** Migrations quota ceiling (from manifest.quotas or defaults). */
  migrationsLimit: number;
  /** Extension category (manifest.category or 'custom'). */
  extCategory: string;
  /** Runtime selector ('js' | 'wasm'). */
  extRuntime: 'js' | 'wasm';
  /**
   * When non-null, the caller should `manifestMeta.set(extName, ...)` with
   * this payload. Computed here (including embedPageSchemas) so the phase is
   * self-contained; the actual state write stays in the caller.
   */
  manifestMeta: ManifestMeta | null;
}

/**
 * Phase 1 — resolve + validate manifest.json, run compatibility / quota /
 * dependency / postgres-extension / peerDeps checks, and compute the
 * manifestMeta payload.
 *
 * Pure: no loader state, no logging. On any failure returns a `PhaseFail`
 * mirroring the exact `console.*` call + `lastLoadError` write the inline path
 * used; the caller replays them.
 */
export async function resolveManifest(
  extName: string,
  extDir: string,
  db: Database,
): Promise<PhaseResult<ManifestResolution>> {
  let migrationsLimit: number = DEFAULT_QUOTAS.migrationsMax;
  let extCategory = 'custom';
  let extRuntime: 'js' | 'wasm' = 'js';
  let manifest: ExtensionManifest | null = null;
  let manifestMeta: ManifestMeta | null = null;

  const manifestPath = join(extDir, 'manifest.json');
  if (existsSync(manifestPath)) {
    try {
      const rawManifest = JSON.parse(await Bun.file(manifestPath).text());
      manifest = ManifestSchema.parse(rawManifest) as ExtensionManifest;
    } catch (err) {
      const msg = `invalid manifest.json — ${(err as Error).message}`;
      return {
        ok: false,
        logLevel: 'warn',
        logArgs: [`⚠️  Extension "${extName}": ${msg}`],
        lastLoadError: msg,
      };
    }
    if (typeof manifest.category === 'string') extCategory = manifest.category;
    if (manifest.runtime === 'wasm') extRuntime = 'wasm';

    // Engine version compatibility
    const compat = isCompatible(
      getEngineVersion(),
      manifest.zveltioMinVersion,
      manifest.zveltioMaxVersion,
    );
    if (!compat.compatible) {
      return {
        ok: false,
        logLevel: 'warn',
        logArgs: [`⚠️  Extension "${extName}" incompatible: ${compat.reason}`],
        lastLoadError: null,
      };
    }

    // Resource quota: bundle size (extension folder excluding node_modules).
    // node_modules sits in the shared workspace root, not inside extDir, so
    // a recursive walk of extDir captures only this extension's own files.
    const quotas = manifest.quotas ?? DEFAULT_QUOTAS;
    migrationsLimit = quotas.migrationsMax;
    const bundleBytes = await directorySizeBytes(extDir);
    const bundleKb = Math.ceil(bundleBytes / 1024);
    if (bundleKb > quotas.bundleSizeKbMax) {
      const err = new QuotaExceededError('bundleSizeKb', bundleKb, quotas.bundleSizeKbMax, extName);
      return {
        ok: false,
        logLevel: 'warn',
        logArgs: [`⚠️  ${err.message}`],
        lastLoadError: err.message,
      };
    }

    // Extension dependencies (other Zveltio extensions)
    if (manifest.dependencies && manifest.dependencies.length > 0) {
      const deps = await checkExtensionDependencies(db, manifest.dependencies);
      if (!deps.satisfied) {
        const msg = `Missing required extensions: ${deps.missing.join(', ')}. Enable them first.`;
        return {
          ok: false,
          logLevel: 'warn',
          logArgs: [`⚠️  Extension "${extName}" ${msg}`],
          lastLoadError: msg,
        };
      }
    }

    // PostgreSQL extension requirements (e.g. postgis)
    const requiredPgExts: string[] = manifest.requires?.postgres_extensions ?? [];
    if (requiredPgExts.length > 0) {
      try {
        const result = await _sql<{ extname: string }>`
              SELECT extname FROM pg_extension WHERE extname = ANY(${
                // biome-ignore lint/suspicious/noExplicitAny: legacy any; tracked in docs/HARDENING-9-PLAN.md H-01
                requiredPgExts as any
              })
            `.execute(db);
        const installed = new Set(result.rows.map((r) => r.extname));
        const missing = requiredPgExts.filter((e) => !installed.has(e));
        if (missing.length > 0) {
          const msg =
            `Extension "${extName}" requires PostgreSQL extension(s) not installed: ${missing.join(', ')}. ` +
            `Install them in psql: ${missing.map((e) => `CREATE EXTENSION "${e}";`).join(' ')} then retry.`;
          return {
            ok: false,
            logLevel: 'warn',
            logArgs: [`⚠️  ${msg}`],
            lastLoadError: msg,
          };
        }
      } catch {
        // pg_extension query is non-fatal — continue and let the migration surface the real error.
      }
    }

    // npm peerDependencies — auto-install before loading. Failure is fatal
    // (an extension that needs `imapflow` but couldn't install it will crash
    // when imported). Cache the error for the marketplace HTTP response.
    if (manifest.peerDependencies && Object.keys(manifest.peerDependencies).length > 0) {
      try {
        await installExtensionNpmDependencies(extName, manifest.peerDependencies);
      } catch (err) {
        const msg = (err as Error).message;
        return {
          ok: false,
          logLevel: 'warn',
          logArgs: [`⚠️  ${msg}`],
          lastLoadError: msg,
        };
      }

      // Resource quota: total node_modules size in the shared workspace.
      // This is a coarse guard against accidentally pulling in multi-GB
      // packages. Note: it counts ALL extensions' deps, not just this one's,
      // so the limit needs headroom for the ecosystem total.
      const nodeModulesDir = join(resolveExtensionsBase(), 'node_modules');
      const nmBytes = await directorySizeBytes(nodeModulesDir);
      const nmMb = Math.ceil(nmBytes / (1024 * 1024));
      if (nmMb > quotas.nodeModulesSizeMbMax) {
        const err = new QuotaExceededError(
          'nodeModulesSizeMb',
          nmMb,
          quotas.nodeModulesSizeMbMax,
          extName,
        );
        return {
          ok: false,
          logLevel: 'warn',
          logArgs: [`⚠️  ${err.message}`],
          lastLoadError: err.message,
        };
      }
    }

    // Cache UI-relevant manifest fields for the /api/extensions Studio endpoint
    manifestMeta = {
      displayName: manifest.displayName,
      description: manifest.description,
      category: manifest.category,
      contributes: manifest.contributes as ManifestMeta['contributes'],
      studio: await embedPageSchemas(extDir, manifest.studio),
    };
  }

  return {
    ok: true,
    value: { manifest, migrationsLimit, extCategory, extRuntime, manifestMeta },
  };
}

/**
 * Phase 2 — MARKETPLACE-POLICY.md §2 publisher-tier gate. When the manifest did
 * NOT opt into worker isolation (and no operator inline override is set), fetch
 * the registry catalog and refuse inline execution for community/unaudited
 * extensions.
 *
 * Returns ok when the extension is allowed to proceed inline (or the gate is
 * skipped). Failures mirror the inline `console.error(❌ …)` lines.
 */
export async function enforcePublisherTier(
  extName: string,
  manifest: ExtensionManifest | null,
): Promise<PhaseResult<void>> {
  // MARKETPLACE-POLICY.md §2 enforcement: publisher tier governs
  // whether an extension may run inline. The registry catalog
  // carries `publisher_tier` (migration 010); older registries
  // omit it and resolvePublisherTier() falls back to is_official
  // (official → first-party, otherwise → community). Local
  // hardcoded catalog entries default to is_official=true, so the
  // 54 first-party + smoke fixtures stay exempt.
  //
  //   first-party / verified → inline allowed
  //   community (or unknown) → worker REQUIRED
  //
  // Two operator overrides:
  //   ZVELTIO_ALLOW_INLINE_THIRD_PARTY=1 — trusted self-hosted,
  //     accept inline for any extension (skip the gate entirely)
  //   ZVELTIO_REQUIRE_CATALOG=1 — fail-closed: if catalog fetch
  //     fails (network, registry down) refuse rather than
  //     fall through to local-only assumptions
  if (
    process.env.ZVELTIO_ALLOW_INLINE_THIRD_PARTY === '1' ||
    manifest?.engine?.isolation === 'worker'
  ) {
    return { ok: true, value: undefined };
  }

  let catalog: ExtensionCatalogEntry[] | null = null;
  let catalogFetchFailed = false;
  try {
    catalog = await fetchRegistryCatalog();
  } catch {
    catalogFetchFailed = true;
  }
  if (catalogFetchFailed && process.env.ZVELTIO_REQUIRE_CATALOG === '1') {
    const msg =
      `Extension "${extName}" cannot be enabled: catalog fetch ` +
      `failed and ZVELTIO_REQUIRE_CATALOG=1 forbids falling back ` +
      `to local-only first-party assumptions. Retry when the ` +
      `registry is reachable, or unset the env var.`;
    return {
      ok: false,
      logLevel: 'error',
      logArgs: [`❌ ${msg}`],
      lastLoadError: msg,
    };
  }
  if (catalog) {
    // An extension present in a successfully-loaded catalog uses
    // its declared tier; one that's ABSENT is unknown/unaudited
    // and must be treated as community (the strictest tier) —
    // otherwise a sideloaded inline extension that nobody
    // published would slip past the gate. The local hardcoded
    // catalog (the 54 first-party + smoke fixtures) is merged in
    // by fetchRegistryCatalog(), so genuine first-party
    // extensions are always found. Trusted self-hosted installs
    // that deliberately sideload inline code use
    // ZVELTIO_ALLOW_INLINE_THIRD_PARTY=1.
    const catEntry = catalog.find((e) => e.name === extName);
    const tier = catEntry ? resolvePublisherTier(catEntry) : 'community';
    if (!tierAllowsInline(tier)) {
      const what = catEntry
        ? `is a ${tier} submission`
        : `is not in the marketplace catalog (treated as ${tier})`;
      const msg =
        `Extension "${extName}" ${what} but does ` +
        `not declare engine.isolation: "worker". Per ` +
        `MARKETPLACE-POLICY §2, ${tier} extensions must run in ` +
        `worker isolation. Republish with isolation: "worker" ` +
        `or, for trusted self-hosted installs, set ` +
        `ZVELTIO_ALLOW_INLINE_THIRD_PARTY=1.`;
      return {
        ok: false,
        logLevel: 'error',
        logArgs: [`❌ ${msg}`],
        lastLoadError: msg,
      };
    }
  }
  return { ok: true, value: undefined };
}

/**
 * Phase 3 — resolve the on-disk module path to import.
 *
 * For bundled (manifest v2) extensions: verify the entry exists, the integrity
 * hash (if declared) matches, and that peer deps are inlined. For legacy/dev
 * extensions: refuse .ts in production, ensure the core-deps symlink + presence.
 *
 * Returns the resolved path to import. Failures mirror the inline
 * `console.error(❌ …)` lines (including the two-argument core-dep variant).
 *
 * `enginePath` is the loader's precomputed `join(extDir, 'engine/index.js')`.
 */
export async function resolveEntryPath(
  extName: string,
  extDir: string,
  enginePath: string,
  manifest: ExtensionManifest | null,
): Promise<PhaseResult<string>> {
  // Manifest v2: when `engine.bundled: true` the extension ships
  // a pre-built engine/index.js with hono/zod/kysely/@hono/zod-validator
  // inlined. The Bun compiled binary CAN'T resolve those bare
  // specifiers from disk-installed node_modules at runtime, so
  // bundling is the ONLY path that works on production binaries.
  // When bundled, we skip the CORE_NPM_PACKAGES presence check
  // and import the .js artifact directly.
  const isBundled = manifest?.engine?.bundled === true;
  const extBase = resolveExtensionsBase();

  if (isBundled) {
    // isBundled === true implies manifest?.engine?.bundled === true, so
    // manifest (and manifest.engine) are non-null in this branch.
    const m = manifest!;
    const bundledEntry = join(extDir, m.engine!.entry);
    if (!existsSync(bundledEntry)) {
      const msg =
        `Extension "${extName}" manifest declares engine.bundled=true ` +
        `but engine.entry "${m.engine!.entry}" is not on disk at ${bundledEntry}. ` +
        `Run \`zveltio extension pack\` before publishing.`;
      return { ok: false, logLevel: 'error', logArgs: [`❌ ${msg}`], lastLoadError: msg };
    }
    // Optional: verify integrity hash if the manifest declares one.
    if (m.integrity?.engineSha256) {
      const { createHash } = await import('node:crypto');
      const actual = createHash('sha256').update(readFileSync(bundledEntry)).digest('hex');
      if (actual !== m.integrity.engineSha256) {
        const msg =
          `Extension "${extName}" integrity check failed: ` +
          `manifest declares engineSha256=${m.integrity.engineSha256} ` +
          `but the on-disk bundle hashes to ${actual}. ` +
          `Re-pack and re-publish, or the bundle was tampered with.`;
        return { ok: false, logLevel: 'error', logArgs: [`❌ ${msg}`], lastLoadError: msg };
      }
    }
    // Bundled extensions that declare peer deps must inline them
    // (`engine.bundlePeers: true` at pack time). The compiled
    // Bun binary cannot resolve bare specifiers from dynamic
    // imports of disk files — neither via CWD node_modules nor
    // adjacent-to-the-bundle node_modules walks (verified live
    // alpha.112: imapflow import threw despite the peer being
    // installed in EXTENSIONS_DIR/node_modules AND a CWD
    // symlink AND a sibling engine/node_modules). For native
    // bindings that cannot be bundled, the extension author
    // must ship them via a separate engine plugin instead.
    if (
      m.peerDependencies &&
      Object.keys(m.peerDependencies).length > 0 &&
      m.engine?.bundlePeers !== true
    ) {
      const peers = Object.keys(m.peerDependencies).join(', ');
      const msg =
        `Extension "${extName}" declares peerDependencies (${peers}) but ` +
        `engine.bundlePeers is not true. Bun's compiled binary cannot ` +
        `resolve bare specifiers from a dynamically-imported disk file, ` +
        `so peers must be inlined at pack time. Re-pack with ` +
        `\`engine.bundlePeers: true\` in manifest.json, or remove the ` +
        `peerDependencies entry if the import was inadvertent.`;
      return { ok: false, logLevel: 'error', logArgs: [`❌ ${msg}`], lastLoadError: msg };
    }
    return { ok: true, value: bundledEntry };
  }

  // Legacy / dev path: .ts source + on-disk core deps.
  // Refuse legacy .ts in production. ZVELTIO_EXTENSION_DEV_RELOAD=1
  // keeps the door open for local development against unbundled
  // extensions, but the production binary should never load a
  // .ts because that pulls in the kysely/hono module-resolution
  // bug we spent 16 alpha releases fixing. Hard-fail here
  // surfaces "this extension wasn't packed" loudly instead of
  // letting it slip through to a cryptic dynamic-import throw.
  const allowLegacy = process.env.ZVELTIO_EXTENSION_DEV_RELOAD === '1';
  if (!allowLegacy && process.env.NODE_ENV === 'production') {
    const msg =
      `Extension "${extName}" is not bundled (manifest.engine.bundled !== true). ` +
      `Production refuses legacy .ts extensions because Bun's compiled-binary ` +
      `resolver cannot find core deps via disk node_modules walks. ` +
      `Run \`zveltio extension pack --dir <ext>\` and re-deploy the ` +
      `extension, or set ZVELTIO_EXTENSION_DEV_RELOAD=1 in dev environments.`;
    return { ok: false, logLevel: 'error', logArgs: [`❌ ${msg}`], lastLoadError: msg };
  }
  const resolvedPath = existsSync(enginePath) ? enginePath : join(extDir, 'engine/index.ts');
  maybeSymlinkNodeModules(extBase);
  for (const pkg of CORE_NPM_PACKAGES) {
    const pkgFolder = pkg.startsWith('@') ? pkg : pkg.split('/')[0];
    if (!existsSync(join(extBase, 'node_modules', pkgFolder))) {
      const msg =
        `Core package '${pkg}' not found in ${join(extBase, 'node_modules')}. ` +
        `Boot-time install of core deps failed or the directory is missing. ` +
        `Fix: ensure EXTENSIONS_DIR is set correctly and writable, then restart the engine. ` +
        `(Or migrate this extension to manifest v2 with engine.bundled=true via \`zveltio extension pack\`.)`;
      return {
        ok: false,
        logLevel: 'error',
        logArgs: [`❌ Extension "${extName}":`, msg],
        lastLoadError: msg,
      };
    }
  }
  return { ok: true, value: resolvedPath };
}
