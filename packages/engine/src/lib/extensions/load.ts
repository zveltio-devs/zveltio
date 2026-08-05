/**
 * The `loadExtension` pipeline for `ExtensionLoader` (H-04 split).
 *
 * `loadExtensionFromDir` is the full per-extension load orchestration lifted out
 * of the loader class: resolve the extension directory, short-circuit
 * Studio/client-only extensions, run the three pure validation phases
 * (`resolveManifest` / `enforcePublisherTier` / `resolveEntryPath`), take the
 * WASM-or-import branch, run migrations + field types, build the allowed-tables
 * set, then hand off to `finalizeExtensionLoad` (register.ts) for the
 * route-register core.
 *
 * It mutates loader state (`loaded`, `manifestMeta`, `lastLoadError`,
 * `modules`, `ctx`) so it takes the `ExtensionLoader` instance via a TYPE-ONLY
 * import (no runtime cycle); the class keeps a thin `loadExtension` delegator so
 * all callers are unchanged. Every `console.*` string, error message,
 * early-return order, and state write is byte-identical to the pre-split inline
 * method — zero behaviour change.
 */

import { existsSync, readdirSync } from 'node:fs';
import { join } from 'path';
import { pathToFileURL } from 'node:url';
import type { Hono } from 'hono';
import type { ZveltioExtension } from '@zveltio/sdk/extension';
import { auditLog } from '../audit.js';
import { QuotaExceededError } from './extension-errors.js';
import { resolveExtensionsBase } from './extension-paths.js';
import { runExtensionMigrations } from './migration-runner.js';
import { embedPageSchemas, type ManifestMeta } from './manifest-schema.js';
import { enforcePublisherTier, resolveEntryPath, resolveManifest } from './load-phases.js';
import { checkRevoked, revocationCheckRequired, revocationMessage } from './revocations.js';
import type { ExtensionContext } from './internals.js';
import { buildAllowedTables, EXTENSION_TABLE_GRANTS, finalizeExtensionLoad } from './register.js';
import type { ExtensionLoader } from './extension-loader.js';

export async function loadExtensionFromDir(
  loader: ExtensionLoader,
  extName: string,
  app: Hono,
  ctx: ExtensionContext,
  basePath?: string,
): Promise<void> {
  try {
    // Resolve extension directory.
    // Priority: explicit basePath > resolveExtensionsBase() (EXTENSIONS_DIR, CWD, dev sibling).
    const defaultBase = resolveExtensionsBase();
    const extDir = basePath ? join(basePath, extName) : join(defaultBase, extName);

    const enginePath = join(extDir, 'engine/index.js');

    const earlyManifestPath = join(extDir, 'manifest.json');
    // Raw manifest JSON, read once for the two decisions that must happen
    // before the engine bundle is imported: revocation and the Studio-only
    // short-circuit. `resolveManifest` below does the real validation.
    let early: {
      version?: unknown;
      displayName?: string;
      description?: string;
      category?: string;
      contributes?: { engine?: boolean };
      studio?: ManifestMeta['studio'];
    } | null = null;
    if (existsSync(earlyManifestPath)) {
      try {
        early = JSON.parse(await Bun.file(earlyManifestPath).text());
      } catch {
        // Malformed manifest — leave `early` null; the engine path re-reads it
        // below and surfaces the parse error properly.
      }
    }

    // Revocation gate — the registry no longer stands behind this build.
    //
    // `revocations.ts` was written for exactly this case ("every install that
    // already has the files keeps running it") but was wired only into the
    // marketplace routes, so it fired on install and on hot-load and never on
    // boot. An extension revoked after it was installed kept loading on every
    // restart — the moment the control exists to cover. Every entry point
    // (boot `loadFromDB`, `loadDynamic`, marketplace install) reaches this
    // function, so one check here governs all of them.
    //
    // It sits above the Studio-only short-circuit deliberately: that branch
    // marks the extension active and wires its Studio components, so a gate
    // below it would let a revoked client-only extension through. Revocation
    // means "we no longer stand behind this", independent of runtime.
    //
    // Fail-open vs fail-closed is decided inside the module, not here: a list
    // that was never fetched fails open, because air-gapped installs are
    // supported and a control an operator switches off protects nobody. Set
    // ZVELTIO_REQUIRE_REVOCATION_CHECK=1 to invert that for a connected fleet.
    const extVersion = typeof early?.version === 'string' ? early.version : undefined;
    const verdict = await checkRevoked(extName, extVersion);
    if (verdict.revoked && verdict.entry) {
      const msg = revocationMessage(extName, extVersion ?? 'unknown', verdict.entry);
      console.error(`[extensions] ${msg}`);
      loader.lastLoadError.set(extName, msg);
      return;
    }
    if (verdict.unknown && revocationCheckRequired()) {
      const msg =
        `Cannot verify whether "${extName}" has been revoked — the registry is unreachable ` +
        `and ZVELTIO_REQUIRE_REVOCATION_CHECK=1 requires a successful check.`;
      console.error(`[extensions] ${msg}`);
      loader.lastLoadError.set(extName, msg);
      return;
    }

    // Studio/client-only extensions (`contributes.engine: false`) ship no
    // engine routes — there's nothing to load into the engine. Register
    // them as active (their Studio components are wired by the Studio
    // rebuild, separately) and skip the whole engine-load path below,
    // which would otherwise hard-fail on the missing engine bundle.
    if (early?.contributes?.engine === false) {
      loader.loaded.set(extName, {
        name: extName,
        registeredRoutes: false,
        allowedTables: new Set<string>(),
      });
      loader.manifestMeta.set(extName, {
        displayName: early.displayName,
        description: early.description,
        category: early.category,
        contributes: early.contributes,
        studio: await embedPageSchemas(extDir, early.studio),
      });
      console.log(`🔌 Extension loaded: ${extName} (Studio/client-only — no engine)`);
      return;
    }

    if (!existsSync(enginePath)) {
      // Try TypeScript source (dev mode)
      const engineTsPath = join(extDir, 'engine/index.ts');
      if (!existsSync(engineTsPath)) {
        console.warn(`⚠️  Extension "${extName}": engine/index.js not found at ${enginePath}`);
        return;
      }
    }

    // Phase 1 — resolve + validate manifest.json (compat / quota / deps /
    // pg-exts / peerDeps) and compute the manifestMeta payload. The helper is
    // pure; it reports the exact console.* call + lastLoadError write the
    // pre-split inline path used, which we replay here verbatim.
    const manifestPhase = await resolveManifest(
      extName,
      extDir,
      ctx.db,
      new Set(loader.loaded.keys()),
    );
    if (!manifestPhase.ok) {
      if (manifestPhase.logLevel !== 'none') {
        console[manifestPhase.logLevel](...manifestPhase.logArgs);
      }
      if (manifestPhase.lastLoadError !== null) {
        loader.lastLoadError.set(extName, manifestPhase.lastLoadError);
      }
      return;
    }
    const { manifest, migrationsLimit, extCategory, extRuntime, manifestMeta } =
      manifestPhase.value;
    // Cache UI-relevant manifest fields for the /api/extensions Studio endpoint.
    // Computed inside the phase (including embedPageSchemas); the state write
    // stays here so the phase is loader-state-free.
    if (manifestMeta !== null) {
      loader.manifestMeta.set(extName, manifestMeta);
    }

    // WASM runtime path — if the manifest opts in, load the `.wasm`
    // extension through `WasmExtensionHost`. Returns a synthetic
    // `ZveltioExtension` whose register() invokes the WASM module's
    // exported register inside the capability-bound sandbox. The rest
    // of the loader treats it the same as a JS extension.
    //
    // Note today's WASM ABI is small (log, db_*, fetch_*, crypto*,
    // env_read, fs_*). Route registration from inside WASM isn't yet
    // wired through the imports table — that arrives with the
    // companion tooling wave. So WASM extensions today are
    // compute-only or background-only. JS first-party extensions
    // continue to handle the HTTP surface.
    // MARKETPLACE-POLICY.md §2 publisher-tier gate, BEFORE the runtime is
    // chosen below.
    //
    // It used to sit inside the inline branch, which meant it governed exactly
    // one of the three runtimes. A manifest with `runtime: "wasm"` took the
    // branch below and returned before ever reaching it, so a community-tier
    // WASM extension loaded and registered without the gate having an opinion —
    // the one decision whose entire job is to say whether untrusted code may
    // run in this process. (The comment in the worker branch still claimed the
    // gate "sends community extensions down this branch"; it is below that
    // branch and sends nothing anywhere. It refuses.)
    //
    // Hoisting changes nothing for the other two: the helper already returns ok
    // for `isolation: 'worker'` and for ZVELTIO_ALLOW_INLINE_THIRD_PARTY, so
    // the inline and worker paths see the same answer they saw before, just
    // sooner.
    const tierPhase = await enforcePublisherTier(extName, manifest);
    if (!tierPhase.ok) {
      if (tierPhase.logLevel !== 'none') {
        console[tierPhase.logLevel](...tierPhase.logArgs);
      }
      if (tierPhase.lastLoadError !== null) {
        loader.lastLoadError.set(extName, tierPhase.lastLoadError);
      }
      return;
    }

    let extension: ZveltioExtension;
    if (extRuntime === 'wasm') {
      const wasmPath = join(extDir, 'engine', 'extension.wasm');
      if (!existsSync(wasmPath)) {
        loader.lastLoadError.set(
          extName,
          `manifest.runtime = "wasm" but engine/extension.wasm is missing`,
        );
        return;
      }
      const { loadWasmExtension } = await import('../wasm-extension-host.js');
      const wasm = await loadWasmExtension(wasmPath, { extName });
      // Synthetic ZveltioExtension that proxies into the WASM handle.
      extension = {
        name: extName,
        category: extCategory,
        mountStrategy: 'global',
        async register(_app, _ctx) {
          // WASM register() runs inside the sandbox. It can't bind
          // Hono routes today; that requires a routing-bridge ABI.
          // Compute / background work happens here.
          await wasm.register();
        },
      };
      // Keep a reference so reloads + unloads can call shutdown().
      (extension as ZveltioExtension & { __wasmHandle?: unknown }).__wasmHandle = wasm;
    } else if (manifest?.engine?.isolation === 'worker' && manifest?.engine?.bundled === true) {
      // Worker-isolated path — deliberately does NOT import the entry module.
      //
      // `enforcePublisherTier` above REFUSES a community (untrusted,
      // third-party) extension that has not declared this isolation, precisely
      // because the worker is meant to be the boundary. Importing the module here would run its TOP-LEVEL code in
      // the engine process, with engine privileges, before any worker exists —
      // so a hostile extension never has to reach a route handler to win, and
      // everything the worker enforces afterwards is irrelevant to it.
      //
      // The worker imports the bundle itself. The engine only needs enough
      // metadata to run migrations and mount the proxy, and that comes from the
      // manifest and the filesystem instead.
      //
      // The cost is that a worker-isolated extension cannot contribute
      // engine-side field types, cron schedules or a cleanup hook: all three
      // require running its code in this process, which is the thing being
      // avoided. First-party extensions run inline and keep them.
      const migrationDir = join(extDir, 'engine', 'migrations');
      const migrationFiles = existsSync(migrationDir)
        ? readdirSync(migrationDir)
            .filter((f) => f.endsWith('.sql'))
            // Same lexicographic order the hand-written getMigrations() lists
            // use (001_, 002_, …) — the runner applies them in array order.
            .sort()
            .map((f) => join(migrationDir, f))
        : [];

      extension = {
        name: extName,
        category: extCategory,
        mountStrategy: 'global',
        getMigrations: () => migrationFiles,
        // Never called: registerExtensionRoutes takes the worker branch for
        // this extension and hands routing to the host. Present because the
        // loader's shape check requires it.
        async register() {},
      };
    } else {
      // Import and register extension.
      //
      // History: we previously appended `?v=<timestamp>` whenever
      // NODE_ENV !== 'production' for hot-reload during dev. In a
      // compiled Bun binary, the `?v=…` suffix becomes part of the
      // importer path, which breaks the node_modules walk-up that
      // resolves bare specifiers like `kysely`. The fix is to:
      //
      //   1. Gate the cache-buster on an EXPLICIT dev-reload flag
      //      (ZVELTIO_EXTENSION_DEV_RELOAD=1) rather than NODE_ENV.
      //      Detecting "compiled binary" via Bun.embeddedFiles was
      //      fragile across Bun versions.
      //   2. Import via `pathToFileURL(...).href` so resolution is
      //      anchored to the file's own location (which has a path
      //      walk to <EXTENSIONS_DIR>/node_modules) and not to the
      //      binary's CWD.
      //   3. Re-run maybeSymlinkNodeModules at every load — first-time
      //      install adds new node_modules at the EXTENSIONS_DIR but
      //      the CWD symlink only gets refreshed by ensureExtensionCoreDeps,
      //      which runs once at boot.
      // Manifest v2: when `engine.bundled: true` the extension ships
      // a pre-built engine/index.js with hono/zod/kysely/@hono/zod-validator
      // inlined. The Bun compiled binary CAN'T resolve those bare
      // specifiers from disk-installed node_modules at runtime, so
      // bundling is the ONLY path that works on production binaries.
      // When bundled, we skip the CORE_NPM_PACKAGES presence check
      // and import the .js artifact directly.
      const isBundled = manifest?.engine?.bundled === true;

      // Phase 3 — resolve the on-disk module path (bundled entry + integrity +
      // bundlePeers, or legacy .ts + core-dep presence). Same verbatim-replay
      // contract for its failures.
      const entryPhase = await resolveEntryPath(extName, extDir, enginePath, manifest);
      if (!entryPhase.ok) {
        if (entryPhase.logLevel !== 'none') {
          console[entryPhase.logLevel](...entryPhase.logArgs);
        }
        if (entryPhase.lastLoadError !== null) {
          loader.lastLoadError.set(extName, entryPhase.lastLoadError);
        }
        return;
      }
      const resolvedPath = entryPhase.value;

      const useCacheBuster = !isBundled && process.env.ZVELTIO_EXTENSION_DEV_RELOAD === '1';
      const importHref = useCacheBuster
        ? `${pathToFileURL(resolvedPath).href}?v=${Date.now()}`
        : pathToFileURL(resolvedPath).href;
      const module = await import(importHref);
      extension = module.default;
    }

    if (!extension || typeof extension.register !== 'function') {
      console.warn(`⚠️  Extension "${extName}": missing default export or register() function`);
      return;
    }

    // Cache module for re-registration during hot-reload (avoids re-importing)
    loader.modules.set(extName, extension);

    // Run extension migrations
    const migrationPaths = extension.getMigrations?.() ?? [];
    if (migrationPaths.length > migrationsLimit) {
      const err = new QuotaExceededError(
        'migrations',
        migrationPaths.length,
        migrationsLimit,
        extName,
      );
      console.warn(`⚠️  ${err.message}`);
      loader.lastLoadError.set(extName, err.message);
      return;
    }
    if (migrationPaths.length > 0) {
      await runExtensionMigrations(extension, ctx.db);
    }

    // Register new field types contributed by extension
    if (extension.registerFieldTypes) {
      extension.registerFieldTypes(ctx.fieldTypeRegistry);
    }

    // Build allowed-tables set from migration CREATE TABLE statements + explicit grants.
    const allowedTables = await buildAllowedTables(migrationPaths, extName);
    for (const t of EXTENSION_TABLE_GRANTS[extName] ?? []) allowedTables.add(t);

    // Register-core (build restrictedCtx, mount routes with the
    // matcher-already-built swallow, register schedules, capture loaded state
    // + success audit) extracted to lib/extensions/register.ts (H-04 split);
    // shared with reRegisterExtension. Byte-identical behaviour.
    await finalizeExtensionLoad(
      loader,
      extension,
      extName,
      extDir,
      app,
      ctx,
      manifest ?? null,
      allowedTables,
    );
  } catch (err) {
    const errMsg = (err as Error).message ?? String(err);
    console.error(`❌ Failed to load extension "${extName}":`, err);
    loader.lastLoadError.set(extName, errMsg);
    // Audit trail — record load failure
    if (loader.ctx) {
      auditLog(loader.ctx.db, {
        type: 'extension.load_failed',
        resourceId: extName,
        resourceType: 'extension',
        metadata: { error: (err as Error).message, actor: 'system' },
      }).catch((err: Error) => {
        console.error('[extension-loader] audit log failed:', err.message);
      });
    }
  }
}
