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
import type { Database } from '../db/index.js';
import { auth } from './auth.js';
import { checkPermission } from './permissions.js';
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
import { DownMissingError } from './extension-errors.js';
import type { ExtensionLoader } from './extension-loader.js';

export function registerMarketplaceRoutes(
  self: ExtensionLoader,
  app: Hono,
  db: Database,
  triggerReloadFn: (reason: string) => Promise<void>,
): void {
  // Admin-only guard
  async function requireAdmin(c: Context): Promise<boolean> {
    const session = await auth.api.getSession({ headers: c.req.raw.headers });
    if (!session) return false;
    const isAdmin = await checkPermission(session.user.id, 'admin', '*');
    return isAdmin;
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
  app.post('/api/marketplace/license/:name{.+}', async (c) => {
    if (!(await requireAdmin(c))) return c.json({ error: 'Unauthorized' }, 401);

    const name = c.req.param('name');
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

    if (res && !res.ok) {
      const err = (await res.json().catch(() => null)) as { message?: string } | null;
      return c.json({ error: err?.message || 'Invalid license key' }, 400);
    }

    await db
      .insertInto('zv_settings')
      .values({ key: `ext_license:${name}`, value: key.trim(), is_public: false })
      .onConflict((oc) => oc.column('key').doUpdateSet({ value: key.trim() }))
      .execute();

    return c.json({ ok: true });
  });

  // DELETE /api/marketplace/license/:name — remove a stored license key
  app.delete('/api/marketplace/license/:name{.+}', async (c) => {
    if (!(await requireAdmin(c))) return c.json({ error: 'Unauthorized' }, 401);

    const name = c.req.param('name');
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
    if (!(await requireAdmin(c))) return c.json({ error: 'Unauthorized' }, 401);
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
    const rows = await db
      .selectFrom('zv_license_audit')
      .selectAll()
      .orderBy('performed_at', 'desc')
      .limit(50)
      .execute()
      .catch(() => []);
    return c.json({ history: rows });
  });

  // GET /api/marketplace — catalog fetched from registry (fallback: local) merged with DB state
  app.get('/api/marketplace', async (c) => {
    if (!(await requireAdmin(c))) return c.json({ error: 'Unauthorized or admin required' }, 401);

    const tenantId = getTenantId(c);
    const extBase = resolveExtensionsBase();

    const [catalog, rows, licenseRows] = await Promise.all([
      fetchRegistryCatalog(),
      db
        .selectFrom('zv_extension_registry')
        .selectAll()
        .execute()
        .catch(() => []),
      db
        .selectFrom('zv_settings')
        .select(['key'])
        .where('key', 'like', 'ext_license:%')
        .execute()
        .catch(() => []),
    ]);

    // When a tenant is specified: prefer tenant-scoped row, fall back to global (tenant_id IS NULL).
    // When no tenant: return the global row (admin view).
    type RegRow = (typeof rows)[number];
    const rowsFiltered: RegRow[] = tenantId
      ? (() => {
          const tenantRows = rows.filter((r) => r.tenant_id === tenantId);
          const globalRows = rows.filter((r) => r.tenant_id === null || r.tenant_id === undefined);
          // Merge: tenant row wins over global for the same extension name
          const merged = new Map<string, RegRow>();
          for (const r of globalRows) merged.set(r.name, r);
          for (const r of tenantRows) merged.set(r.name, r); // override with tenant row
          return [...merged.values()];
        })()
      : rows.filter((r) => r.tenant_id === null || r.tenant_id === undefined);

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
      };
    });

    return c.json({ extensions });
  });

  // POST /api/marketplace/:name/install
  app.post('/api/marketplace/:name{.+}/install', async (c) => {
    if (!(await requireAdmin(c))) return c.json({ error: 'Unauthorized or admin required' }, 401);

    const name = c.req.param('name');
    return withExtensionLock(db, name, async () => {
      const catalog = await fetchRegistryCatalog();
      const entry = catalog.find((e) => e.name === name);
      if (!entry) return c.json({ error: 'Extension not found in catalog' }, 404);

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
      if (!extensionFilesPresent(extDir)) {
        try {
          await downloadExtension(entry, extBase, authToken);
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

      const tenantId = getTenantId(c);

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
          tenant_id: tenantId,
        })
        .onConflict((oc) =>
          oc
            .column('name')
            .doUpdateSet({ is_installed: true, installed_at: new Date(), tenant_id: tenantId }),
        )
        .execute();

      return c.json({
        success: true,
        downloaded,
        files_on_disk: true,
        message: `Extension "${name}" installed successfully. Enable it to activate.`,
      });
    });
  });

  // POST /api/marketplace/:name/enable
  app.post('/api/marketplace/:name{.+}/enable', async (c) => {
    if (!(await requireAdmin(c))) return c.json({ error: 'Unauthorized or admin required' }, 401);

    const name = c.req.param('name');
    return withExtensionLock(db, name, async () => {
      // Use live registry catalog (with local fallback) so extensions from apps.zveltio.com work
      const catalog = await fetchRegistryCatalog();
      const entry = catalog.find((e) => e.name === name);
      if (!entry) return c.json({ error: 'Extension not found in catalog' }, 404);

      // If extension files are not on disk yet, try to download them now before
      // marking it enabled in the DB. This covers the case where Install succeeded
      // via registry but files were not present, or the user clicked Enable directly.
      const extBase = resolveExtensionsBase();
      const extDir = join(extBase, name);
      if (!extensionFilesPresent(extDir)) {
        try {
          const authToken = await getLicenseKey(db, name);
          await downloadExtension(entry, extBase, authToken);
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

      const tenantId = getTenantId(c);

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
          tenant_id: tenantId,
        })
        .onConflict((oc) =>
          oc.column('name').doUpdateSet({
            is_installed: true,
            is_enabled: true,
            enabled_at: new Date(),
            tenant_id: tenantId,
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
  });

  // POST /api/marketplace/enable-all
  // Single-pass "enable everything installed" in dependency order, with one
  // retry per transient failure. This is what a clean "install all" needs so
  // it doesn't leave dependency-ordered extensions disabled. A failure keeps
  // the extension is_enabled=true (it self-heals on the next boot) and records
  // last_load_error — never flips it off.
  app.post('/api/marketplace/enable-all', async (c) => {
    if (!(await requireAdmin(c))) return c.json({ error: 'Unauthorized or admin required' }, 401);

    const installed = await db
      .selectFrom('zv_extension_registry')
      .select(['name'])
      .where('is_installed', '=', true)
      .execute()
      .catch(() => [] as { name: string }[]);

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
          oc.column('name').doUpdateSet({ is_enabled: true, enabled_at: new Date() }),
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
  });

  // POST /api/marketplace/:name/disable
  app.post('/api/marketplace/:name{.+}/disable', async (c) => {
    if (!(await requireAdmin(c))) return c.json({ error: 'Unauthorized or admin required' }, 401);

    const name = c.req.param('name');
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
        .onConflict((oc) => oc.column('name').doUpdateSet({ is_enabled: false }))
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
  });

  // PUT /api/marketplace/:name/config
  app.put('/api/marketplace/:name{.+}/config', async (c) => {
    if (!(await requireAdmin(c))) return c.json({ error: 'Unauthorized or admin required' }, 401);

    const name = c.req.param('name');
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
      .onConflict((oc) => oc.column('name').doUpdateSet({ config }))
      .execute();

    return c.json({ success: true });
  });

  // POST /api/marketplace/:name/uninstall[?purgeData=true]
  //
  // Default (purgeData=false or omitted): soft uninstall — mark
  // is_installed=false in the registry, keep the extension's tables and
  // migration history. A future reinstall picks up where we left off.
  //
  // Purge (purgeData=true): run DOWN migrations in reverse, delete migration
  // rows, remove files from disk, delete the registry row. Fully destructive.
  app.post('/api/marketplace/:name{.+}/uninstall', async (c) => {
    if (!(await requireAdmin(c))) return c.json({ error: 'Unauthorized or admin required' }, 401);

    const name = c.req.param('name');
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
  });
}
