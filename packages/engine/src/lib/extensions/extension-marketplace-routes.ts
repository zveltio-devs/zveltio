// Marketplace + admin HTTP routes for extension lifecycle (install / enable /
// disable / uninstall / license management).
//
// Extracted from extension-loader.ts (loader split). Behavior-preserving: this is
// the verbatim body of ExtensionLoader.registerMarketplace, lifted into a free
// function. The loader passes itself as `self` (so the handlers reach its hot-load
// methods) and forwards its module-level `triggerReload` as `triggerReloadFn`
// (passed in rather than imported, to avoid an import cycle with the loader).

import { Hono } from 'hono';
import type { Context } from 'hono';
import { readFileSync } from 'node:fs';
import { join } from 'path';
import type { Database } from '../../db/index.js';
import { auth } from '../auth.js';
import {
  checkPermission,
  isGodUser,
  isTenantAdmin,
  requireInstanceAdmin,
} from '../tenancy/index.js';
import { invalidateActivationCache } from './activation.js';
import {
  resolveExtensionsBase,
  extensionFilesPresent,
  extensionFilesPresentCached,
  invalidateFilesPresent,
} from './extension-paths.js';
import { REGISTRY_URL, fetchRegistryCatalog, downloadExtension } from './extension-download.js';
import {
  getLicenseKey,
  writeLicenseAudit,
  fingerprintToken,
  clientIp,
} from './extension-license.js';
import { withExtensionLock, isPathInsideBase } from './extension-utils.js';
import { resolvePublisherTier } from './extension-catalog.js';
import { DownMissingError } from './extension-errors.js';
import { auditLog } from '../audit.js';
import { parseGranted, recordConsent, resolveCapabilities } from './consent.js';
import { checkRevoked, revocationCheckRequired, revocationMessage } from './revocations.js';
import type { ExtensionLoader } from './extension-loader.js';

export function registerMarketplaceRoutes(
  self: ExtensionLoader,
  app: Hono,
  db: Database,
  triggerReloadFn: (reason: string) => Promise<void>,
  // Injectable registry client. Defaults to the real module functions; tests
  // pass fakes here instead of mock.module (which leaks across bun test files).
  deps: {
    fetchRegistryCatalog: typeof fetchRegistryCatalog;
    downloadExtension: typeof downloadExtension;
  } = { fetchRegistryCatalog, downloadExtension },
): void {
  const { fetchRegistryCatalog: fetchCatalog, downloadExtension: doDownload } = deps;
  // Admin-only guard
  async function requireAdmin(c: Context): Promise<boolean> {
    const session = await auth.api.getSession({ headers: c.req.raw.headers });
    if (!session) return false;
    const isAdmin = await requireInstanceAdmin(session.user.id);
    return isAdmin;
  }

  /**
   * Installing, enabling or removing an extension is a GOD decision.
   *
   * `requireInstanceAdmin` is god OR an admin of the default tenant. That second
   * arm is right for most instance operations and wrong for this one: installing
   * puts NEW CODE on the instance, and an extension's migrations may alter the
   * engine's own tables — the `ai` extension adds three columns to
   * `zvd_collections`, measured. On a holding, the default tenant is the parent
   * company, so its administrator would be deciding what code runs for every
   * subsidiary.
   *
   * Reading the catalogue stays on `requireAdmin`: listing what COULD be
   * installed harms nobody, and taking it away would blank the Studio page for
   * an operator who has not been made god.
   *
   * Consequence, stated rather than discovered: an instance with no god user
   * cannot install anything until `zveltio create-god` has been run. That is the
   * intended shape — a single superadmin per instance — not an oversight.
   */
  async function requireGod(c: Context): Promise<boolean> {
    const session = await auth.api.getSession({ headers: c.req.raw.headers });
    if (!session) return false;
    return isGodUser(session.user.id);
  }

  // Resolve optional tenant scope from X-Tenant-Id header.
  // null = global (no tenant filter); string = scoped to that tenant.
  function getTenantId(c: Context): string | null {
    return (c.req.header('x-tenant-id') as string | undefined) ?? null;
  }

  // ── License key management ────────────────────────────────────────────────
  // Free extensions need no license key — they download without auth.
  // Paid extensions require a license key purchased on apps.zveltio.com.
  // Keys are stored per-extension in zv_settings as ext_license:<name>.

  // POST /api/marketplace/license/:name — store (and optionally verify) a license key
  const setLicense = async (c: Context, name: string) => {
    if (!(await requireGod(c))) return c.json({ error: 'Unauthorized' }, 401);

    const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
    const key = body?.license_key as string | undefined;
    if (!key?.trim()) return c.json({ error: 'license_key is required' }, 400);

    // Verify with the registry before storing
    const res = await fetch(`${REGISTRY_URL}/api/licenses/verify`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ extension: name, license_key: key }),
      signal: AbortSignal.timeout(8_000),
    }).catch(() => null);

    // `res` is null when the fetch threw — DNS failure, connection refused, or
    // the 8s timeout.
    //
    // Storing anyway is deliberate, and the reason is the same one revocation
    // gives a few files over: an air-gapped or self-hosted install must be able
    // to enter a key it paid for without reaching registry.zveltio.com. The
    // stored key is only ever sent as a Bearer token when downloading, where
    // the registry validates it properly — an invalid one fails there, with a
    // message, rather than silently working.
    //
    // What was wrong was the TELLING. The handler answered `{ ok: true }`
    // identically whether the registry had approved the key or had never been
    // asked, under a comment promising "Verify with the registry before
    // storing". An operator had no way to distinguish "verified" from
    // "unverifiable", which is the difference between a key that will work and
    // one that will fail at the next download.
    let verified = true;
    if (!res) {
      verified = false;
      console.warn(
        `[marketplace] stored license key for "${name}" WITHOUT verification — ` +
          'the registry was unreachable. It will be checked at download time.',
      );
    }
    // A response that came back and said no is a real rejection — refuse it.
    // That is different from never having asked, handled above.
    if (res && !res.ok) {
      const err = (await res.json().catch(() => null)) as { message?: string } | null;
      return c.json({ error: err?.message || 'Invalid license key' }, 400);
    }

    await db
      .insertInto('zv_settings')
      .values({ key: `ext_license:${name}`, value: key.trim(), is_public: false })
      .onConflict((oc) => oc.column('key').doUpdateSet({ value: key.trim() }))
      .execute();

    // `verified` says which of the two happened. Callers that care can show
    // "saved, not yet verified" rather than implying the registry agreed.
    return c.json({ ok: true, verified });
  };

  // DELETE /api/marketplace/license/:name — remove a stored license key
  app.delete('/api/marketplace/license/:name{.+}', async (c) => {
    if (!(await requireGod(c))) return c.json({ error: 'Unauthorized' }, 401);

    const name = c.req.param('name') ?? '';
    await db
      .deleteFrom('zv_settings')
      .where('key', '=', `ext_license:${name}`)
      .execute()
      .catch((err: Error) => {
        console.error('[extension-loader] license delete failed:', err.message);
      });

    // Audit: record the deletion. Best-effort — never block the response.
    await writeLicenseAudit(db, {
      action: 'delete',
      extension_name: name,
      performed_by: (await auth.api.getSession({ headers: c.req.raw.headers }))?.user?.id ?? null,
      ip: clientIp(c),
      user_agent: c.req.header('user-agent') ?? null,
    }).catch((err: Error) => {
      console.error('[extension-loader] audit log failed:', err.message);
    });

    return c.json({ ok: true });
  });

  // ── License rotation + audit (S3-04) ──────────────────────────────────
  // The marketplace_auth_token in zv_settings authenticates this engine
  // installation against registry-side per-tenant features (analytics,
  // private mirror access). A rotation invalidates the old token AND
  // writes an audit row. Admin-only; bearer-token auth would create a
  // bootstrap problem since this is exactly the token being rotated.

  // POST /api/admin/license/rotate — mint a fresh marketplace token
  app.post('/api/admin/license/rotate', async (c) => {
    if (!(await requireGod(c))) return c.json({ error: 'Unauthorized' }, 401);
    const session = await auth.api.getSession({ headers: c.req.raw.headers });

    // 32 bytes of high-entropy randomness, hex-encoded → 64 chars.
    const buf = new Uint8Array(32);
    crypto.getRandomValues(buf);
    const newToken = Array.from(buf, (b) => b.toString(16).padStart(2, '0')).join('');

    // Capture a fingerprint of the OLD token for the audit row — never
    // log the new token plaintext (it would defeat the rotation purpose).
    const oldRow = await db
      .selectFrom('zv_settings')
      .select('value')
      .where('key', '=', 'marketplace_auth_token')
      .executeTakeFirst()
      .catch(() => undefined);
    const oldFingerprint = oldRow?.value ? await fingerprintToken(oldRow.value as string) : null;

    await db
      .insertInto('zv_settings')
      .values({ key: 'marketplace_auth_token', value: newToken, is_public: false })
      .onConflict((oc) => oc.column('key').doUpdateSet({ value: newToken }))
      .execute();

    await writeLicenseAudit(db, {
      action: 'rotate',
      extension_name: null,
      performed_by: session?.user?.id ?? null,
      ip: clientIp(c),
      user_agent: c.req.header('user-agent') ?? null,
      details: { old_token_fingerprint: oldFingerprint },
    });

    return c.json({ ok: true, token: newToken });
  });

  // GET /api/admin/license/history — last 50 audit entries (most recent first)
  app.get('/api/admin/license/history', async (c) => {
    if (!(await requireAdmin(c))) return c.json({ error: 'Unauthorized' }, 401);
    // An audit trail that renders empty is a statement — "no licence action has
    // ever been taken here" — and it is the statement an administrator checking for
    // unauthorised changes is least able to verify independently. A failed read must
    // not look like a clean history.
    const rows = await db
      .selectFrom('zv_license_audit')
      .selectAll()
      .orderBy('performed_at', 'desc')
      .limit(50)
      .execute();
    return c.json({ history: rows });
  });

  // GET /api/marketplace — catalog fetched from registry (fallback: local) merged with DB state
  app.get('/api/marketplace', async (c) => {
    if (!(await requireAdmin(c))) return c.json({ error: 'Unauthorized or admin required' }, 401);

    const tenantId = getTenantId(c);
    const extBase = resolveExtensionsBase();

    // Neither read carries a `.catch(() => [])` any more.
    //
    // This route merges the registry catalogue with what the database says is
    // installed and licensed. An empty registry read renders EVERY extension as not
    // installed, and an empty licence read renders every paid one as unlicensed — so
    // an administrator looking at the marketplace after a transient failure sees a
    // blank slate and starts installing things that are already there. The screen is
    // the one place they have to check that from.
    //
    // `fetchCatalog()` handles its own registry-unreachable fallback; that is a
    // different failure with a real local answer.
    const [catalog, rows, licenseRows] = await Promise.all([
      fetchCatalog(),
      db.selectFrom('zv_extension_registry').selectAll().execute(),
      db.selectFrom('zv_settings').select(['key']).where('key', 'like', 'ext_license:%').execute(),
    ]);

    // This listing reports what the RUNTIME will do, not what the schema allows.
    //
    // `zv_extension_registry.tenant_id` was added by migration 070 with the
    // documented meaning "NULL = instance-wide, set = that tenant only", and
    // this endpoint used to honour it: with a tenant, the tenant row overrode
    // the global one; without, only global rows were returned.
    //
    // The loader does not honour it. `extension-loader.ts` selects
    // `WHERE is_enabled = true` and nothing else, as do the boot path and the
    // version checker. So a row marked enabled for one tenant loads for the
    // whole instance — and the old listing would show that extension as absent
    // to every other tenant while its code was running for them.
    //
    // A half-built feature that reports the opposite of what happens is worse
    // than one that is missing, so the listing now says what is true: an
    // extension is enabled if ANY registry row for it is enabled. Per-tenant
    // activation stays a real thing to design — extensions register routes,
    // hooks and migrations into one process, so honouring `tenant_id` means
    // gating per request, not filtering a load query. The column and its indexes
    // are left in place for that work rather than dropped.
    type RegRow = (typeof rows)[number];
    const merged = new Map<string, RegRow>();
    for (const r of rows) {
      const seen = merged.get(r.name);
      // An enabled row wins, whichever tenant it names, because that is the one
      // the loader will act on.
      if (!seen || (!seen.is_enabled && r.is_enabled)) merged.set(r.name, r);
    }
    const rowsFiltered: RegRow[] = [...merged.values()];

    const dbMap = new Map(rowsFiltered.map((r) => [r.name, r]));
    const licenseSet = new Set(licenseRows.map((r) => r.key.replace('ext_license:', '')));

    // An extension is a satisfied dependency once it is enabled (or already
    // running). Computed once so each extension can report which of its declared
    // dependencies are still unmet — the marketplace shows "Depends on …" and
    // blocks Enable until they are.
    const enabledNames = new Set(
      catalog
        .map((e) => e.name)
        .filter((n) => dbMap.get(n)?.is_enabled === true || self.isActive(n)),
    );
    const readDeps = (name: string): string[] => {
      try {
        const m = JSON.parse(readFileSync(join(extBase, name, 'manifest.json'), 'utf8'));
        return ((m.dependencies ?? []) as unknown[])
          .map((d) => (typeof d === 'string' ? d : (d as { name?: string })?.name))
          .filter((x: unknown): x is string => typeof x === 'string' && x.length > 0);
      } catch {
        return [];
      }
    };

    /** What a manifest asks for. Only a request until consent is recorded. */
    const readDeclared = (name: string): string[] => {
      try {
        const m = JSON.parse(readFileSync(join(extBase, name, 'manifest.json'), 'utf8'));
        return ((m.permissions ?? []) as unknown[]).filter(
          (x: unknown): x is string => typeof x === 'string',
        );
      } catch {
        return [];
      }
    };

    const extensions = catalog.map((entry) => {
      const dbEntry = dbMap.get(entry.name);
      const runtimeActive = self.isActive(entry.name);
      const extDir = join(extBase, entry.name);
      const filesOnDisk = extensionFilesPresentCached(extDir);
      const dependencies = readDeps(entry.name);
      const missing_dependencies = dependencies.filter((d) => !enabledNames.has(d));

      return {
        ...entry,
        dependencies,
        // Declared dependencies that are not yet enabled — the UI disables Enable
        // and shows "enable these first" when this is non-empty.
        missing_dependencies,
        // Who stands behind this build. The engine already decides with it —
        // `tierAllowsInline()` lets first-party and verified run in the engine
        // process and confines community to a worker — but it was never sent to
        // the Studio, so the operator approving an install could not see the
        // one fact that governs how much of their server the code can touch.
        // An extension missing from the catalog resolves to `community`, which
        // is the honest answer: unknown provenance is not a lesser claim than
        // known-untrusted.
        publisher_tier: resolvePublisherTier(entry),
        is_installed: dbEntry?.is_installed ?? runtimeActive,
        is_enabled: dbEntry?.is_enabled ?? runtimeActive,
        is_running: runtimeActive,
        files_on_disk: filesOnDisk,
        has_license: licenseSet.has(entry.name),
        tenant_id: dbEntry?.tenant_id ?? null,
        needs_restart:
          filesOnDisk &&
          ((dbEntry?.is_enabled && !runtimeActive) ||
            (!dbEntry?.is_enabled && runtimeActive && dbEntry !== undefined)),
        config: dbEntry?.config ?? {},
        installed_at: dbEntry?.installed_at ?? null,
        enabled_at: dbEntry?.enabled_at ?? null,
        // Persisted load failure (null = clean). Lets the marketplace show a
        // red badge + reason for an enabled-but-not-running extension.
        last_load_error: dbEntry?.last_load_error ?? self.lastLoadError.get(entry.name) ?? null,
        last_load_at: dbEntry?.last_load_at ?? null,
        // Capability consent. `pending_capabilities` non-empty means the
        // extension asks for more than was approved and is running WITHOUT the
        // difference — the UI shows an Approve prompt naming each one.
        ...(() => {
          const declared = readDeclared(entry.name);
          const granted = parseGranted(dbEntry?.granted_capabilities);
          const r = resolveCapabilities(declared, granted);
          return {
            declared_capabilities: declared,
            granted_capabilities: granted,
            pending_capabilities: r.pending,
            capabilities_grandfathered: r.grandfathered,
          };
        })(),
      };
    });

    return c.json({ extensions });
  });

  // POST /api/marketplace/:name/install (registered via the dispatcher below)
  /**
   * The digest recorded when this extension was last installed, but only when
   * the version has not moved. A new version legitimately carries new bytes;
   * the same version must not.
   */
  const pinFor = async (name: string, version: string): Promise<string | null> => {
    const row = await db
      .selectFrom('zv_extension_registry')
      .select(['installed_sha256', 'installed_version'])
      .where('name', '=', name)
      .executeTakeFirst()
      .catch(() => undefined);
    if (!row?.installed_sha256) return null;
    return row.installed_version === version ? row.installed_sha256 : null;
  };

  const installExtension = async (c: Context, name: string) => {
    if (!(await requireGod(c))) return c.json({ error: 'Unauthorized or admin required' }, 401);

    return withExtensionLock(db, name, async () => {
      const catalog = await fetchCatalog();
      const entry = catalog.find((e) => e.name === name);
      if (!entry) return c.json({ error: 'Extension not found in catalog' }, 404);

      // A signature proves the artifact came from the registry; it says nothing
      // about whether the registry still stands behind it. Check before any
      // files are fetched — installing and then refusing to enable leaves the
      // bytes on disk for the next person to enable by hand.
      const verdict = await checkRevoked(name, entry.version);
      if (verdict.revoked && verdict.entry) {
        const msg = revocationMessage(name, entry.version, verdict.entry);
        console.error(`[marketplace] refusing install: ${msg}`);
        return c.json({ success: false, error: msg, message: msg, revoked: true }, 451);
      }
      if (verdict.unknown && revocationCheckRequired()) {
        const msg =
          `Cannot verify whether "${name}" has been revoked — the registry is unreachable ` +
          `and ZVELTIO_REQUIRE_REVOCATION_CHECK is set. Restore registry access or unset it.`;
        return c.json({ success: false, error: msg, message: msg }, 503);
      }

      // Determine where extension files should live
      const extBase = resolveExtensionsBase();
      const extDir = join(extBase, name);

      // Local files win: when the extension is already deployed under
      // EXTENSIONS_DIR (self-contained / air-gapped installs), use it and
      // never touch the registry. Only reach out to download when nothing is
      // on disk yet. `extensionFilesPresent` also recognises UI-only
      // (`contributes.engine: false`) extensions, which ship no engine entry.
      const authToken = await getLicenseKey(db, name);
      let downloaded = false;
      let downloadError = '';
      let downloadedSha: string | null = null;
      if (!extensionFilesPresent(extDir)) {
        try {
          const result = await doDownload(
            entry,
            extBase,
            authToken,
            await pinFor(name, entry.version),
          );
          downloadedSha = result?.archiveSha256 ?? null;
          downloaded = true;
          invalidateFilesPresent(extDir); // disk changed — refresh listing cache
        } catch (err) {
          downloadError = (err as Error).message;
          console.warn(`[marketplace] Could not download "${name}":`, downloadError);
        }
      }

      const filesOnDisk = extensionFilesPresent(extDir);

      // Still nothing on disk and the registry couldn't supply it — fail loudly.
      if (!filesOnDisk) {
        const hint = process.env.EXTENSIONS_DIR
          ? `No files found under EXTENSIONS_DIR (${extBase}/${name}) and the registry was unreachable.`
          : `Registry unreachable and EXTENSIONS_DIR is not set. Set EXTENSIONS_DIR to a directory containing the extension, or restore registry access.`;
        const msg =
          `Extension "${name}" could not be installed: ` + (downloadError || '') + ` ${hint}`;
        return c.json(
          { success: false, downloaded: false, files_on_disk: false, error: msg, message: msg },
          422,
        );
      }

      await db
        .insertInto('zv_extension_registry')
        .values({
          name: entry.name,
          display_name: entry.displayName,
          description: entry.description,
          category: entry.category,
          version: entry.version,
          author: entry.author,
          is_installed: true,
          is_enabled: false,
          installed_at: new Date(),
          tenant_id: null,
          // Pin what we actually installed. Only set on a real download —
          // files already on disk (air-gapped / EXTENSIONS_DIR) were never
          // fetched, so there is no digest to attest to and inventing one
          // would pin whatever happened to be there.
          ...(downloadedSha
            ? { installed_sha256: downloadedSha, installed_version: entry.version }
            : {}),
        })
        .onConflict((oc) =>
          oc.columns(['tenant_id', 'name']).doUpdateSet({
            is_installed: true,
            installed_at: new Date(),
            tenant_id: null,
            ...(downloadedSha
              ? { installed_sha256: downloadedSha, installed_version: entry.version }
              : {}),
          }),
        )
        .execute();

      // Installing IS the consent: the admin was shown what the extension asks
      // for and chose to install it. Record the set so a later version that
      // asks for more has to come back and ask again.
      const declaredAtInstall = (() => {
        try {
          const m = JSON.parse(readFileSync(join(extDir, 'manifest.json'), 'utf8'));
          return ((m.permissions ?? []) as unknown[]).filter(
            (x: unknown): x is string => typeof x === 'string',
          );
        } catch {
          return [] as string[];
        }
      })();
      await recordConsent(db, entry.name, declaredAtInstall).catch(() => undefined);

      return c.json({
        success: true,
        downloaded,
        files_on_disk: true,
        granted_capabilities: declaredAtInstall,
        message: `Extension "${name}" installed successfully. Enable it to activate.`,
      });
    });
  };

  // POST /api/marketplace/:name/enable (registered via the dispatcher below)
  const enableExtension = async (c: Context, name: string) => {
    if (!(await requireGod(c))) return c.json({ error: 'Unauthorized or admin required' }, 401);

    return withExtensionLock(db, name, async () => {
      // Use live registry catalog (with local fallback) so extensions from apps.zveltio.com work
      const catalog = await fetchCatalog();
      const entry = catalog.find((e) => e.name === name);
      if (!entry) return c.json({ error: 'Extension not found in catalog' }, 404);

      // Checked again here, not only at install: an extension installed last
      // month is revoked today, and enable is the moment its code starts
      // running. Anything already on disk reaches this path.
      const verdict = await checkRevoked(name, entry.version);
      if (verdict.revoked && verdict.entry) {
        const msg = revocationMessage(name, entry.version, verdict.entry);
        console.error(`[marketplace] refusing enable: ${msg}`);
        return c.json(
          { success: false, hot_loaded: false, error: msg, message: msg, revoked: true },
          451,
        );
      }
      if (verdict.unknown && revocationCheckRequired()) {
        const msg =
          `Cannot verify whether "${name}" has been revoked — the registry is unreachable ` +
          `and ZVELTIO_REQUIRE_REVOCATION_CHECK is set.`;
        return c.json({ success: false, hot_loaded: false, error: msg, message: msg }, 503);
      }

      // If extension files are not on disk yet, try to download them now before
      // marking it enabled in the DB. This covers the case where Install succeeded
      // via registry but files were not present, or the user clicked Enable directly.
      const extBase = resolveExtensionsBase();
      const extDir = join(extBase, name);
      if (!extensionFilesPresent(extDir)) {
        try {
          const authToken = await getLicenseKey(db, name);
          await doDownload(entry, extBase, authToken, await pinFor(name, entry.version));
          invalidateFilesPresent(extDir); // disk changed — refresh listing cache
        } catch (downloadErr) {
          const msg =
            `Extension "${name}" files not found and download failed: ${(downloadErr as Error).message}. ` +
            `Set EXTENSIONS_DIR to the extensions directory and retry.`;
          return c.json(
            { success: false, hot_loaded: false, needs_restart: false, error: msg, message: msg },
            422,
          );
        }
      }

      await db
        .insertInto('zv_extension_registry')
        .values({
          name: entry.name,
          display_name: entry.displayName,
          description: entry.description,
          category: entry.category,
          version: entry.version,
          author: entry.author,
          is_installed: true,
          is_enabled: true,
          installed_at: new Date(),
          enabled_at: new Date(),
          tenant_id: null,
        })
        .onConflict((oc) =>
          oc.columns(['tenant_id', 'name']).doUpdateSet({
            is_installed: true,
            is_enabled: true,
            enabled_at: new Date(),
            tenant_id: null,
          }),
        )
        .execute();

      let hotLoaded = false;
      let loadError = '';
      if (!self.isActive(name)) {
        try {
          await self.loadDynamic(name, app);
          hotLoaded = true;
        } catch (e) {
          loadError = (e as Error).message;
          console.warn(`Hot-load failed for ${name}:`, loadError);
          // Do NOT flip is_enabled=false. A transient failure (npm-install
          // timing, dependency load order, a missing PG extension the operator
          // then installs) self-heals on the next boot/retry — boot-load
          // (loadFromDB) tolerates per-extension failures by skipping while
          // keeping is_enabled=true. Persist the error so the operator sees
          // WHY in the marketplace instead of the extension silently vanishing.
          await db
            .updateTable('zv_extension_registry')
            .set({ last_load_error: loadError, last_load_at: new Date() })
            .where('name', '=', name)
            .execute()
            .catch(() => {});
        }
      } else {
        hotLoaded = true;
      }
      // Cleared on success so a previously-failing extension loses its badge.
      if (hotLoaded) {
        await db
          .updateTable('zv_extension_registry')
          .set({ last_load_error: null, last_load_at: new Date() })
          .where('name', '=', name)
          .execute()
          .catch(() => {});
      }

      // Rebuild and swap the Hono app so the new extension's engine routes
      // are live without restarting the process.
      if (hotLoaded) {
        await triggerReloadFn(`enable:${name}`);
      }

      // Studio pages are always served from the pre-built dist: declarative
      // SDUI pages render via the generic host (data, not code), and Tier-3
      // code pages are baked into the Studio at release. There is no runtime
      // Studio rebuild — a refresh picks up newly-enabled pages.
      const nowActive = self.isActive(name);
      return c.json(
        {
          success: nowActive,
          hot_loaded: hotLoaded,
          needs_restart: false,
          // Kept for API compatibility with the marketplace UI: pages are
          // always prebuilt, so there is never a runtime rebuild to report.
          studio_rebuild: 'skipped',
          studio_rebuild_ms: 0,
          studio_pages_prebuilt: true,
          message: nowActive
            ? `Extension ${name} is now active. Refresh to see its pages.`
            : `Extension ${name} could not be loaded: ${loadError || 'check server logs'}.`,
          ...(loadError ? { error_detail: loadError } : {}),
        },
        nowActive ? 200 : 422,
      );
    });
  };

  // POST /api/marketplace/enable-all
  // Single-pass "enable everything installed" in dependency order, with one
  // retry per transient failure. This is what a clean "install all" needs so
  // it doesn't leave dependency-ordered extensions disabled. A failure keeps
  // the extension is_enabled=true (it self-heals on the next boot) and records
  // last_load_error — never flips it off.
  const enableAllExtensions = async (c: Context) => {
    if (!(await requireGod(c))) return c.json({ error: 'Unauthorized or admin required' }, 401);

    // No `.catch(() => [])`. This is "enable every installed extension": an empty
    // list means there is nothing to enable, so a failed read enabled nothing and
    // answered the operator with a success. They watch the button succeed and the
    // extensions stay off.
    const installed = await db
      .selectFrom('zv_extension_registry')
      .select(['name'])
      .where('is_installed', '=', true)
      .execute();

    const extBase = resolveExtensionsBase();
    const names = installed.map((r) => r.name);
    const ordered = await self.topoSortExtensions(names, extBase).catch(() => names);

    const results: { name: string; ok: boolean; error?: string }[] = [];
    for (const name of ordered) {
      // Mark enabled regardless of load outcome (self-heal model).
      await db
        .insertInto('zv_extension_registry')
        .values({ name, display_name: name, is_installed: true, is_enabled: true })
        .onConflict((oc) =>
          oc
            .columns(['tenant_id', 'name'])
            .doUpdateSet({ is_enabled: true, enabled_at: new Date() }),
        )
        .execute()
        .catch(() => {});

      if (self.isActive(name)) {
        results.push({ name, ok: true });
        continue;
      }
      let ok = false;
      let err = '';
      for (let attempt = 0; attempt < 2 && !ok; attempt++) {
        try {
          await self.loadDynamic(name, app);
          ok = true;
        } catch (e) {
          err = (e as Error).message;
        }
      }
      await db
        .updateTable('zv_extension_registry')
        .set({ last_load_error: ok ? null : err, last_load_at: new Date() })
        .where('name', '=', name)
        .execute()
        .catch(() => {});
      results.push(ok ? { name, ok } : { name, ok, error: err });
    }

    await triggerReloadFn('enable-all');
    const failed = results.filter((r) => !r.ok);
    return c.json({
      success: failed.length === 0,
      enabled: results.filter((r) => r.ok).length,
      failed: failed.length,
      results,
    });
  };

  // POST /api/marketplace/:name/disable
  const disableExtension = async (c: Context, name: string) => {
    if (!(await requireGod(c))) return c.json({ error: 'Unauthorized or admin required' }, 401);

    return withExtensionLock(db, name, async () => {
      await db
        .insertInto('zv_extension_registry')
        .values({
          name,
          display_name: name,
          category: 'custom',
          version: '1.0.0',
          author: '',
          is_installed: true,
          is_enabled: false,
        })
        .onConflict((oc) => oc.columns(['tenant_id', 'name']).doUpdateSet({ is_enabled: false }))
        .execute();

      // Remove from in-memory registry so buildHonoApp() won't re-register routes
      const wasRunning = self.isActive(name);
      if (wasRunning) {
        await self.unload(name);
      }

      // Rebuild Hono app without this extension's routes (zero-downtime)
      await triggerReloadFn(`disable:${name}`);

      // Studio pages are served from the pre-built dist; there is no runtime
      // rebuild. A disabled extension's pages stop resolving once its routes
      // are gone from the engine — a refresh clears them from the UI.
      return c.json({
        success: true,
        needs_restart: false,
        studio_rebuild: 'skipped',
        studio_rebuild_ms: 0,
        message: `Extension ${name} disabled. Refresh to remove its pages.`,
      });
    });
  };

  // PUT /api/marketplace/:name/config (registered via the dispatcher below)
  const configExtension = async (c: Context, name: string) => {
    if (!(await requireGod(c))) return c.json({ error: 'Unauthorized or admin required' }, 401);

    const config = await c.req.json();

    await db
      .insertInto('zv_extension_registry')
      .values({
        name,
        display_name: name,
        category: 'custom',
        version: '1.0.0',
        author: '',
        is_installed: true,
        is_enabled: false,
        config,
      })
      .onConflict((oc) => oc.columns(['tenant_id', 'name']).doUpdateSet({ config }))
      .execute();

    return c.json({ success: true });
  };

  // POST /api/marketplace/:name/uninstall[?purgeData=true]
  //
  // Default (purgeData=false or omitted): soft uninstall — mark
  // is_installed=false in the registry, keep the extension's tables and
  // migration history. A future reinstall picks up where we left off.
  //
  // Purge (purgeData=true): run DOWN migrations in reverse, delete migration
  // rows, remove files from disk, delete the registry row. Fully destructive.
  const uninstallExtension = async (c: Context, name: string) => {
    if (!(await requireGod(c))) return c.json({ error: 'Unauthorized or admin required' }, 401);

    const purgeData = c.req.query('purgeData') === 'true';

    return withExtensionLock(db, name, async () => {
      // Always unload from memory + trigger reload so live routes stop.
      // The Hono matcher still holds the routes until restart (a known
      // limitation tracked as S3-01); the reload at least re-runs setup
      // without the extension in self.loaded.
      const wasActive = self.isActive(name);
      if (wasActive) {
        await self.unload(name);
      }

      if (!purgeData) {
        // Soft path: keep tables + migrations + files, just deactivate.
        await db
          .updateTable('zv_extension_registry')
          .set({ is_installed: false, is_enabled: false })
          .where('name', '=', name)
          .execute();

        if (wasActive) {
          await triggerReloadFn(`uninstall:${name}`);
        }

        return c.json({
          success: true,
          purged: false,
          needs_restart: wasActive,
          message: `Extension ${name} uninstalled. Tables and data preserved. Pass ?purgeData=true to drop them.`,
        });
      }

      // Hard purge path: roll back DDL, remove files, drop registry row.
      try {
        await self.purgeExtensionData(name, db);
      } catch (err) {
        if (err instanceof DownMissingError) {
          return c.json(
            {
              success: false,
              purged: false,
              error: 'EXT_DOWN_MISSING',
              missing_migrations: err.missingMigrations,
              message: err.message,
            },
            422,
          );
        }
        throw err;
      }

      // Remove extension files from disk, guarded against path-traversal.
      const extBase = resolveExtensionsBase();
      const extDir = join(extBase, name);
      if (await isPathInsideBase(extBase, extDir)) {
        const fs = await import('fs');
        try {
          fs.rmSync(extDir, { recursive: true, force: true });
          invalidateFilesPresent(extDir); // files gone — refresh listing cache
        } catch (err) {
          console.warn(`[marketplace] could not remove ${extDir}:`, err);
        }
      } else {
        console.warn(`[marketplace] refusing to remove "${extDir}" — not inside extensions base`);
      }

      await db.deleteFrom('zv_extension_registry').where('name', '=', name).execute();

      if (wasActive) {
        await triggerReloadFn(`uninstall-purge:${name}`);
      }

      return c.json({
        success: true,
        purged: true,
        needs_restart: wasActive,
        message: `Extension ${name} uninstalled and purged.`,
      });
    });
  };

  /**
   * POST /api/marketplace/:name/approve-capabilities
   *
   * Grant what the extension currently declares. This is the other half of the
   * capability contract: the manifest asks, an administrator decides. Without
   * it an update is a silent privilege grant — ship v1 declaring nothing, ship
   * v2 declaring `db:admin`, and the extension has cross-tenant database access
   * because it said so.
   *
   * The request must name the exact capabilities being approved. Approving
   * "whatever it asks for right now" would let a version that lands between the
   * admin reading the prompt and clicking the button be approved unseen — the
   * click has to mean the specific set the admin was shown.
   */
  const approveCapabilities = async (c: Context, name: string) => {
    if (!(await requireGod(c))) return c.json({ error: 'Unauthorized or admin required' }, 401);

    const extBase = resolveExtensionsBase();
    const extDir = join(extBase, name);
    if (!isPathInsideBase(extBase, extDir)) return c.json({ error: 'Invalid extension name' }, 400);

    let declared: string[];
    try {
      const m = JSON.parse(readFileSync(join(extDir, 'manifest.json'), 'utf8'));
      declared = ((m.permissions ?? []) as unknown[]).filter(
        (x: unknown): x is string => typeof x === 'string',
      );
    } catch {
      return c.json({ error: `No manifest on disk for "${name}"` }, 404);
    }

    const body = await c.req.json().catch(() => ({}) as Record<string, unknown>);
    const approve = body?.capabilities;
    if (!Array.isArray(approve) || approve.some((x) => typeof x !== 'string')) {
      return c.json(
        {
          error:
            'Body must be { capabilities: string[] } naming exactly what you are approving. ' +
            'Approving whatever the manifest happens to ask for at this instant would let ' +
            'a version that lands mid-decision be approved unseen.',
          declared_capabilities: declared,
        },
        400,
      );
    }

    // Refuse to grant anything the manifest does not currently ask for: the
    // record must describe this artifact, not a superset someone typed.
    const notDeclared = (approve as string[]).filter((x) => !declared.includes(x));
    if (notDeclared.length > 0) {
      return c.json(
        {
          error: `Not declared by "${name}": ${notDeclared.join(', ')}`,
          declared_capabilities: declared,
        },
        409,
      );
    }

    await recordConsent(db, name, approve as string[]);
    const granted = [...new Set(approve as string[])].sort();
    const session = await auth.api.getSession({ headers: c.req.raw.headers });
    await auditLog(db, {
      type: 'extension.capabilities.approved',
      userId: session?.user?.id ?? undefined,
      resourceId: name,
      resourceType: 'extension',
      metadata: { granted, declared },
    }).catch(() => undefined);

    return c.json({
      success: true,
      granted_capabilities: granted,
      message:
        `Approved for "${name}". Reload or re-enable the extension for the new ` +
        `capabilities to take effect.`,
    });
  };

  // ── Per-firm activation ──────────────────────────────────────
  //
  // God installs; the admin of a firm decides whether it acts there. Everything
  // above this point is a god decision and writes the global row (tenant_id
  // NULL); these two write the firm's own row and nothing else.
  //
  // The firm is the one `tenantMiddleware` RESOLVED, never `x-tenant-id`. The
  // header is what the caller asked for, and taking a tenant from what the
  // caller sends is the shape of a defect this codebase has already had once:
  // an admin of firm A could otherwise switch an extension off for firm B by
  // changing one header.
  //
  // `isTenantAdmin` asks Casbin in the ambient domain, so it answers "admin of
  // THIS firm" — a god user passes it everywhere, which is the intended order.
  const resolveFirm = (c: Context): string | null => {
    const t = c.get('tenant') as { id?: unknown } | null | undefined;
    return typeof t?.id === 'string' ? t.id : null;
  };

  const setActivation = async (c: Context, name: string, enabled: boolean) => {
    const session = await auth.api.getSession({ headers: c.req.raw.headers });
    if (!session) return c.json({ error: 'Unauthorized' }, 401);
    if (!(await isTenantAdmin(session.user.id).catch(() => false))) {
      return c.json({ error: 'Unauthorized or admin required' }, 401);
    }

    const tenantId = resolveFirm(c);
    if (!tenantId) return c.json({ error: 'No tenant resolved for this request' }, 400);

    // A firm may only decide about what god put on the instance. Without this,
    // "activate" on an uninstalled extension would write a row claiming an
    // extension is on for a firm while no code exists to run.
    const global = await db
      .selectFrom('zv_extension_registry')
      .select(['is_installed'])
      .where('name', '=', name)
      .where('tenant_id', 'is', null)
      .executeTakeFirst();
    if (!global?.is_installed) {
      return c.json(
        {
          error: 'Not found',
          detail: `"${name}" is not installed on this instance. Installing is a god decision.`,
        },
        404,
      );
    }

    await db
      .insertInto('zv_extension_registry')
      .values({
        name,
        display_name: name,
        tenant_id: tenantId,
        is_installed: true,
        is_enabled: enabled,
        enabled_at: enabled ? new Date() : null,
      })
      .onConflict((oc) =>
        oc.columns(['tenant_id', 'name']).doUpdateSet({
          is_enabled: enabled,
          enabled_at: enabled ? new Date() : null,
        }),
      )
      .execute();

    invalidateActivationCache(name);
    return c.json({ success: true, name, tenant_id: tenantId, is_enabled: enabled });
  };

  // ── POST/PUT dispatcher ──────────────────────────────────────────────────
  // Hono's RegExpRouter can't match `/api/marketplace/:name{.+}/<suffix>` when
  // the name spans 3+ path segments (e.g. `compliance/ro/saft`) AND there are
  // sibling routes under the same prefix — the multi-segment param collides and
  // the request 404s. A single wildcard route with manual parsing sidesteps all
  // of that, keeping the public paths (/api/marketplace/<name>/<action>)
  // unchanged and working at any nesting depth. DELETE/GET keep their own
  // routes (different method, no collision).
  // c.req.path keeps `%2F` encoded (Hono preserves segment boundaries); the old
  // `:name` param decoded it, and downstream traversal guards rely on the decoded
  // form — so decode the parsed name here to preserve behaviour byte-for-byte.
  const decodeName = (s: string): string => {
    try {
      return decodeURIComponent(s);
    } catch {
      return s;
    }
  };
  app.post('/api/marketplace/*', (c) => {
    const rest = c.req.path.slice('/api/marketplace/'.length);
    if (rest === 'enable-all') return enableAllExtensions(c);
    if (rest.startsWith('license/'))
      return setLicense(c, decodeName(rest.slice('license/'.length)));
    const i = rest.lastIndexOf('/');
    if (i <= 0) return c.json({ error: 'Not found' }, 404);
    const name = decodeName(rest.slice(0, i));
    switch (rest.slice(i + 1)) {
      case 'install':
        // After the write, never before: a concurrent read between a clear and
        // the write would cache the old answer for the rest of the TTL.
        return installExtension(c, name).finally(() => invalidateActivationCache(name));
      case 'enable':
        // After the write, never before: a concurrent read between a clear and
        // the write would cache the old answer for the rest of the TTL.
        return enableExtension(c, name).finally(() => invalidateActivationCache(name));
      case 'disable':
        // After the write, never before: a concurrent read between a clear and
        // the write would cache the old answer for the rest of the TTL.
        return disableExtension(c, name).finally(() => invalidateActivationCache(name));
      case 'uninstall':
        // After the write, never before: a concurrent read between a clear and
        // the write would cache the old answer for the rest of the TTL.
        return uninstallExtension(c, name).finally(() => invalidateActivationCache(name));
      case 'approve-capabilities':
        return approveCapabilities(c, name);
      case 'activate':
        return setActivation(c, name, true);
      case 'deactivate':
        return setActivation(c, name, false);
      default:
        return c.json({ error: 'Unknown marketplace action' }, 404);
    }
  });
  app.put('/api/marketplace/*', (c) => {
    const rest = c.req.path.slice('/api/marketplace/'.length);
    const i = rest.lastIndexOf('/');
    if (i <= 0 || rest.slice(i + 1) !== 'config') return c.json({ error: 'Not found' }, 404);
    return configExtension(c, decodeName(rest.slice(0, i)));
  });
}
