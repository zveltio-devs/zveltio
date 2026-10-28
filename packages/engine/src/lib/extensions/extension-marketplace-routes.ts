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
  forgetSensitiveResources,
  isGodUser,
  isTenantAdmin,
  readManifestObject,
  recordManifest,
  requireInstanceAdmin,
} from '../tenancy/index.js';
import { invalidateActivationCache, isExtensionActiveAnywhere } from './activation.js';
import { isPendingMigrationsRefusal, observeExtensionMigrations } from './migration-runner.js';
import { loadedVersionStale } from './lifecycle.js';
import {
  resolveExtensionsBase,
  extensionFilesPresent,
  extensionFilesPresentCached,
  invalidateFilesPresent,
} from './extension-paths.js';
import {
  REGISTRY_URL,
  fetchRegistryCatalog,
  downloadExtension,
  stageExtensionDir,
} from './extension-download.js';
import {
  getLicenseKey,
  writeLicenseAudit,
  fingerprintToken,
  clientIp,
} from './extension-license.js';
import { withExtensionLock, isPathInsideBase } from './extension-utils.js';
import { resolvePublisherTier } from './extension-catalog.js';
import { DownMissingError } from './extension-errors.js';
import { revokeExtensionDbRoles } from './ext-db-role.js';
import { auditLog } from '../audit.js';
import { toJsonb } from '../jsonb.js';
import { requireStepUp } from '../step-up.js';
import { guardAdmin } from '../admin-guard.js';
import {
  announceForwardApproval,
  type ForwardMap,
  forwardPairsOutside,
  parseForwardMap,
  parseGranted,
  recordConsent,
  recordForwardApproval,
  resolveCapabilities,
  resolveForwarded,
} from './consent.js';
import { checkRevoked, revocationCheckRequired, revocationMessage } from './revocations.js';
import { announceExtensionLifecycle } from '../runtime/index.js';
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
    requireStepUp?: typeof requireStepUp;
  } = { fetchRegistryCatalog, downloadExtension },
): void {
  const { fetchRegistryCatalog: fetchCatalog, downloadExtension: doDownload } = deps;
  const spendStepUp = deps.requireStepUp ?? requireStepUp;
  // Admin-only guard
  const requireAdmin = (c: Context) => guardAdmin(c, auth, requireInstanceAdmin);

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
  const requireGod = (c: Context) => guardAdmin(c, auth, isGodUser);

  /**
   * Every god MUTATION here also spends a step-up token for `action`
   * (lib/step-up.ts): a session alone — a stolen cookie — does not put code on
   * the instance. Reads stay on the plain gate. Operators who enable extensions
   * from config or the CLI never reach these routes.
   */
  const requireGodStepUp = async (c: Context, action: string) => {
    const gate = await requireGod(c);
    if (gate instanceof Response) return gate;
    const stepUp = await spendStepUp(c, action);
    if (stepUp instanceof Response) return stepUp;
    // What `godAuditMiddleware` reads: without it no god row was written for
    // any mutation here, and the step-up method had nowhere to be recorded.
    c.set('user', gate);
    return gate;
  };

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
    const gate = await requireGodStepUp(c, `extension.license:${name}`);
    if (gate instanceof Response) return gate;

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
    const gate = await requireGodStepUp(c, `extension.license-delete:${c.req.param('name') ?? ''}`);
    if (gate instanceof Response) return gate;

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
      performed_by: gate.id ?? null,
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
    const gate = await requireGodStepUp(c, 'extension.license-rotate');
    if (gate instanceof Response) return gate;

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
      performed_by: gate.id ?? null,
      ip: clientIp(c),
      user_agent: c.req.header('user-agent') ?? null,
      details: { old_token_fingerprint: oldFingerprint },
    });

    return c.json({ ok: true, token: newToken });
  });

  // GET /api/admin/license/history — last 50 audit entries (most recent first)
  app.get('/api/admin/license/history', async (c) => {
    const gate = await requireAdmin(c);
    if (gate instanceof Response) return gate;
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
    const gate = await requireAdmin(c);
    if (gate instanceof Response) return gate;

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
    const [catalog, rows, licenseRows, forwardRows] = await Promise.all([
      fetchCatalog(),
      db.selectFrom('zv_extension_registry').selectAll().execute(),
      db.selectFrom('zv_settings').select(['key']).where('key', 'like', 'ext_license:%').execute(),
      db.selectFrom('zv_extension_forward_approvals').select(['name', 'approved']).execute(),
    ]);
    const forwardApprovals = new Map(forwardRows.map((r) => [r.name, r.approved]));

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

    /** Public routes the worker is handed the caller's credentials on (manifest `forwardCredentials`). */
    const readForwarded = (name: string): ForwardMap => {
      try {
        const m = JSON.parse(readFileSync(join(extBase, name, 'manifest.json'), 'utf8'));
        return parseForwardMap(m.forwardCredentials) ?? {};
      } catch {
        return {};
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
        // `tierAllowsInline()` lets only first-party run in the engine
        // process and confines verified and community to a worker — but it was never sent to
        // the Studio, so the operator approving an install could not see the
        // one fact that governs how much of their server the code can touch.
        // An extension missing from the catalog resolves to `community`, which
        // is the honest answer: unknown provenance is not a lesser claim than
        // known-untrusted.
        publisher_tier: resolvePublisherTier(entry),
        // Requested by the manifest; forwarded only once approved as a whole.
        ...(() => {
          const declared = readForwarded(entry.name);
          const approved = parseForwardMap(forwardApprovals.get(entry.name));
          return {
            forwarded_credentials: declared,
            approved_forward_credentials: approved,
            pending_forward_credentials: resolveForwarded(declared, approved).pending,
          };
        })(),
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

  /** The version of the bundle in `dir`, per its manifest. */
  const diskVersion = (dir: string): string | null => {
    try {
      const { version } = JSON.parse(readFileSync(join(dir, 'manifest.json'), 'utf8'));
      return typeof version === 'string' ? version : null;
    } catch {
      return null;
    }
  };

  const installExtension = async (c: Context, name: string) => {
    const gate = await requireGodStepUp(c, `extension.install:${name}`);
    if (gate instanceof Response) return gate;

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
      // Downloaded from the registry before, and the catalog has moved on: installing
      // again would answer success over the old version. That is an update. Files put
      // there by hand (nothing on record) still win, as above.
      const onDisk = diskVersion(extDir);
      if (onDisk && onDisk !== entry.version && (await pinFor(name, onDisk))) {
        const msg =
          `"${name}" ${onDisk} is installed; the registry serves ${entry.version}. ` +
          `POST /api/marketplace/${name}/update to replace it.`;
        return c.json({ success: false, error: msg, message: msg, installed_version: onDisk }, 409);
      }
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

      // Installing consents to the capabilities shown, but not to handing the
      // worker the caller's credentials: that takes `forward_credentials` in the
      // body naming the map approved. Without it the install succeeds and the
      // worker gets no credentials until approve-forward-credentials.
      let manifest: { permissions?: unknown; forwardCredentials?: unknown } = {};
      try {
        manifest = JSON.parse(readFileSync(join(extDir, 'manifest.json'), 'utf8'));
      } catch {
        /* UI-only or unreadable manifest: declares nothing */
      }
      const declaredForward = parseForwardMap(manifest.forwardCredentials) ?? {};
      const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown> | null;
      let forwardApproval: ForwardMap | null = null;
      if (body?.forward_credentials !== undefined) {
        forwardApproval = parseForwardMap(body.forward_credentials);
        if (!forwardApproval) {
          return c.json({ error: 'forward_credentials must map a route to header names' }, 400);
        }
        const undeclared = forwardPairsOutside(forwardApproval, declaredForward);
        if (undeclared.length > 0) {
          return c.json(
            {
              error: `Not declared by "${name}": ${undeclared.join(', ')}`,
              forwarded_credentials: declaredForward,
            },
            409,
          );
        }
      }

      // A new row carries its claim from the start; an existing one is moved
      // forward by `recordManifest`, which keeps a newer one already recorded.
      const recorded = await readManifestObject(extDir);
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
          ...(recorded ? { manifest: toJsonb(recorded) } : {}),
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
      // What it claims is read from the row from now on, files or not.
      await recordManifest(db, entry.name, extDir);

      // Installing IS the consent: the admin was shown what the extension asks
      // for and chose to install it. Record the set so a later version that
      // asks for more has to come back and ask again.
      const declaredAtInstall = (
        Array.isArray(manifest.permissions) ? (manifest.permissions as unknown[]) : []
      ).filter((x: unknown): x is string => typeof x === 'string');
      await recordConsent(db, entry.name, declaredAtInstall).catch(() => undefined);
      // An install records the approval it carries, and none when it carries none.
      await recordForwardApproval(db, entry.name, forwardApproval);
      await announceForwardApproval(db, entry.name);

      return c.json({
        success: true,
        downloaded,
        files_on_disk: true,
        granted_capabilities: declaredAtInstall,
        approved_forward_credentials: forwardApproval,
        pending_forward_credentials: resolveForwarded(declaredForward, forwardApproval).pending,
        message: `Extension "${name}" installed successfully. Enable it to activate.`,
      });
    });
  };

  /**
   * Load `name` unless it already runs, and record the outcome on its rows: the
   * error the marketplace shows, or none. A failure never flips `is_enabled`:
   * a transient one (npm-install timing, dependency load order, a missing PG
   * extension the operator then installs) self-heals on the next boot or retry,
   * and boot-load (loadFromDB) skips a failing extension while keeping it
   * enabled. Persisting the error shows the operator WHY instead of the
   * extension silently vanishing.
   */
  const loadRecorded = async (name: string): Promise<{ hotLoaded: boolean; loadError: string }> => {
    // Active for a firm's row at an older version than the one on disk: load
    // this one, or its migrations wait for the next boot behind a success.
    if (loadedVersionStale(self, name)) await self.unload(name);
    if (!self.isActive(name)) {
      try {
        await self.loadDynamic(name, app);
      } catch (e) {
        const loadError = (e as Error).message;
        console.warn(`Hot-load failed for ${name}:`, loadError);
        await db
          .updateTable('zv_extension_registry')
          .set({ last_load_error: loadError, last_load_at: new Date() })
          .where('name', '=', name)
          .execute()
          .catch(() => {});
        return { hotLoaded: false, loadError };
      }
    }
    // Cleared on success so a previously-failing extension loses its badge.
    await db
      .updateTable('zv_extension_registry')
      .set({ last_load_error: null, last_load_at: new Date() })
      .where('name', '=', name)
      .execute()
      .catch(() => {});
    return { hotLoaded: true, loadError: '' };
  };

  // POST /api/marketplace/:name/update (registered via the dispatcher below)
  /**
   * Replace an installed extension with the version the registry serves now, in
   * place: no uninstall, so its data, config and grants stay.
   *
   * The bundle is fetched with every check install makes (revocation, declared
   * SHA-256, Ed25519 signature) into a sibling directory and swapped in whole.
   * The new version then loads with its migrations (god's decision, so a firm's
   * activation still never runs one) and only then is it recorded and the old
   * files dropped. Any failure before that puts the old files back and reloads
   * them: the old version keeps running. The new version's migrations commit
   * before its code starts, so a failure after them runs their DOWNs, all or
   * none. When they cannot run (one has no DOWN), the old code is not put back
   * onto the new schema: the new version stays installed, not loaded, and says so.
   *
   * Capabilities the new version adds are NOT consented here: they wait for
   * approve-capabilities, as for any version that asks for more.
   *
   * No rollback route: the registry serves only an extension's current version.
   */
  const updateExtension = async (c: Context, name: string) => {
    const gate = await requireGodStepUp(c, `extension.update:${name}`);
    if (gate instanceof Response) return gate;

    return withExtensionLock(db, name, async () => {
      // The registry must answer: with it down, the catalog baked into this binary
      // would pick the version to install.
      let catalog: Awaited<ReturnType<typeof fetchCatalog>>;
      try {
        catalog = await fetchCatalog({ requireRemote: true });
      } catch (err) {
        const msg = `Cannot update "${name}": the registry is unreachable (${(err as Error).message}).`;
        return c.json({ success: false, error: msg, message: msg }, 503);
      }
      const entry = catalog.find((e) => e.name === name);
      if (!entry) return c.json({ error: 'Extension not found in catalog' }, 404);

      const extBase = resolveExtensionsBase();
      const extDir = join(extBase, name);
      if (!isPathInsideBase(extBase, extDir))
        return c.json({ error: 'Invalid extension name' }, 400);
      const rows = await db
        .selectFrom('zv_extension_registry')
        .select(['tenant_id', 'is_installed', 'is_enabled', 'installed_sha256', 'last_load_error'])
        .where('name', '=', name)
        .execute();
      const godRow = rows.find((r) => r.tenant_id === null);
      if (!godRow?.is_installed) {
        return c.json({ error: `"${name}" is not installed. Install it first.` }, 409);
      }
      const from = diskVersion(extDir);
      if (from === entry.version) {
        // A failed update whose migrations could not be undone left this version
        // installed and not loaded: asking again retries the load, as enable does,
        // instead of a success that leaves it down.
        const stuck =
          !self.isActive(name) && godRow.last_load_error && rows.some((r) => r.is_enabled);
        if (stuck) {
          const { hotLoaded, loadError } = await loadRecorded(name);
          if (!hotLoaded) {
            const msg = `"${name}" ${from} is installed and still does not start: ${loadError}`;
            return c.json({ success: false, updated: false, error: msg, message: msg }, 422);
          }
          await triggerReloadFn(`update:${name}`);
          return c.json({ success: true, updated: false, version: from, hot_loaded: true });
        }
        return c.json({ success: true, updated: false, version: from });
      }
      // Never downloaded: the files were put there by hand (EXTENSIONS_DIR, a dev
      // checkout). Swapping them for the registry's would delete the operator's copy.
      if (!godRow.installed_sha256) {
        const msg =
          `"${name}" was not installed from the registry (no download on record): ` +
          `replace its files under ${extBase} instead.`;
        return c.json({ success: false, error: msg, message: msg }, 409);
      }
      // Forward only: the registry serving an older version is not a request to go back.
      let older = false;
      try {
        older = from !== null && Bun.semver.order(entry.version, from) < 0;
      } catch {
        older = true; // not comparable: not provably forward
      }
      if (older) {
        const msg = `"${name}" ${from} is installed; the registry serves ${entry.version}, which is not newer.`;
        return c.json({ success: false, error: msg, message: msg }, 409);
      }

      const verdict = await checkRevoked(name, entry.version);
      if (verdict.revoked && verdict.entry) {
        const msg = revocationMessage(name, entry.version, verdict.entry);
        return c.json({ success: false, error: msg, message: msg, revoked: true }, 451);
      }
      if (verdict.unknown && revocationCheckRequired()) {
        const msg =
          `Cannot verify whether "${name}" ${entry.version} has been revoked — the registry ` +
          `is unreachable and ZVELTIO_REQUIRE_REVOCATION_CHECK is set.`;
        return c.json({ success: false, error: msg, message: msg }, 503);
      }

      const authToken = await getLicenseKey(db, name);
      // A version not installed before has no digest on record (null): the registry's
      // declared SHA-256 and Ed25519 signature are the check, as at a first install.
      const pin = await pinFor(name, entry.version);
      let staged: Awaited<ReturnType<typeof stageExtensionDir>>;
      try {
        staged = await stageExtensionDir(entry, extBase, (b) =>
          doDownload(entry, b, authToken, pin),
        );
      } catch (err) {
        const msg = `"${name}" was not updated: ${(err as Error).message}`;
        return c.json({ success: false, updated: false, error: msg, message: msg }, 422);
      }

      const wasActive = self.isActive(name);
      const wanted = wasActive || rows.some((r) => r.is_enabled);
      // The migrations this update runs, and only those: a failure undoes them. Noted
      // beside the staged files as well, for the boot that follows a crash.
      const applied: number[] = [];
      const stopObserving = observeExtensionMigrations(name, (ids) => {
        applied.push(...ids);
        staged.noteMigrations(applied);
      });
      try {
        // Unloaded first: the old code never runs over the new files.
        if (wasActive) await self.unload(name);
        staged.swap();
        invalidateFilesPresent(extDir);
        // Migrations run: god asked for this version.
        if (wanted) await self.loadDynamic(name, app);
        await db
          .updateTable('zv_extension_registry')
          .set({
            version: entry.version,
            installed_version: entry.version,
            installed_sha256: staged.archiveSha256,
            installed_at: new Date(),
            ...(wanted ? { last_load_error: null, last_load_at: new Date() } : {}),
          })
          .where('name', '=', name)
          .where('tenant_id', 'is', null)
          .execute();
        await recordManifest(db, name, extDir);
      } catch (err) {
        stopObserving();
        const why = (err as Error).message;
        if (self.isActive(name)) await self.unload(name);
        // The old code must not run on the new version's schema: its migrations go first.
        try {
          await self.purgeExtensionData(name, db, applied);
        } catch (e) {
          // They cannot: the new version stays, files and schema, recorded and not loaded.
          console.error(`[marketplace] "${name}": ${entry.version}'s migrations not undone:`, e);
          try {
            await db
              .updateTable('zv_extension_registry')
              .set({
                version: entry.version,
                installed_version: entry.version,
                installed_sha256: staged.archiveSha256,
                installed_at: new Date(),
                last_load_error: why,
                last_load_at: new Date(),
              })
              .where('name', '=', name)
              .where('tenant_id', 'is', null)
              .execute();
            await recordManifest(db, name, extDir);
            // Recorded: the old files go. Unrecorded, they stay for the boot sweep to settle.
            staged.commit();
          } catch (e2) {
            console.error(`[marketplace] "${name}": ${entry.version} not recorded or settled:`, e2);
          }
          await triggerReloadFn(`update-failed:${name}`);
          const msg =
            `"${name}" ${entry.version} does not start: ${why}. Its migrations could not be ` +
            `undone (${(e as Error).message}), so ${from ?? 'the previous version'} was not put ` +
            `back onto their schema: ${entry.version} stays installed and is not loaded.`;
          return c.json(
            { success: false, updated: false, restored: false, error: msg, message: msg },
            422,
          );
        }
        let restored = true;
        try {
          staged.rollback();
        } catch (e) {
          restored = false;
          console.error(`[marketplace] "${name}": the old files could not be put back:`, e);
        }
        invalidateFilesPresent(extDir);
        if (wasActive && restored) {
          try {
            await self.loadDynamic(name, app);
          } catch (e) {
            restored = false;
            console.error(`[marketplace] "${name}": the old version did not reload:`, e);
          }
        }
        await triggerReloadFn(`update-failed:${name}`);
        const msg =
          `"${name}" ${entry.version} was not installed: ${why}. ` +
          (restored
            ? `${from ?? 'The previous version'} is back in place.`
            : 'The previous version could not be restored; check the server logs.');
        return c.json({ success: false, updated: false, restored, error: msg, message: msg }, 422);
      }
      stopObserving();
      // The new version is live and recorded: failing to delete the old files changes neither.
      try {
        staged.commit();
      } catch (e) {
        console.warn(`[marketplace] "${name}": the previous version's files were not removed:`, e);
      }
      if (wanted) await triggerReloadFn(`update:${name}`);
      return c.json({
        success: true,
        updated: true,
        from,
        version: entry.version,
        hot_loaded: wanted && self.isActive(name),
      });
    });
  };

  // POST /api/marketplace/:name/enable (registered via the dispatcher below)
  const enableExtension = async (c: Context, name: string) => {
    const gate = await requireGodStepUp(c, `extension.enable:${name}`);
    if (gate instanceof Response) return gate;

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
      // Pinned as install pins it: the other replicas fetch these same bytes (lifecycle.ts).
      let downloadedSha: string | null = null;
      if (!extensionFilesPresent(extDir)) {
        try {
          const authToken = await getLicenseKey(db, name);
          const result = await doDownload(
            entry,
            extBase,
            authToken,
            await pinFor(name, entry.version),
          );
          downloadedSha = result?.archiveSha256 ?? null;
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

      // A new row carries its claim from the start; an existing one is moved
      // forward by `recordManifest`, which keeps a newer one already recorded.
      const recorded = await readManifestObject(extDir);
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
          ...(recorded ? { manifest: toJsonb(recorded) } : {}),
          ...(downloadedSha
            ? { installed_sha256: downloadedSha, installed_version: entry.version }
            : {}),
        })
        .onConflict((oc) =>
          oc.columns(['tenant_id', 'name']).doUpdateSet({
            is_installed: true,
            is_enabled: true,
            enabled_at: new Date(),
            tenant_id: null,
            ...(downloadedSha
              ? { installed_sha256: downloadedSha, installed_version: entry.version }
              : {}),
          }),
        )
        .execute();
      // Recorded before the load, which may fail: the claim is known either way.
      await recordManifest(db, name, extDir);

      const { hotLoaded, loadError } = await loadRecorded(name);

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
    const gate = await requireGodStepUp(c, 'extension.enable-all');
    if (gate instanceof Response) return gate;

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
    const refused = new Map<string, string>();
    const ordered = await self.topoSortExtensions(names, extBase, refused);

    const results: { name: string; ok: boolean; error?: string }[] = [
      ...[...refused].map(([name, error]) => ({ name, ok: false, error })),
    ];
    for (const name of ordered) {
      // Mark enabled regardless of load outcome (self-heal model).
      const recorded = await readManifestObject(join(extBase, name));
      await db
        .insertInto('zv_extension_registry')
        .values({
          name,
          display_name: name,
          is_installed: true,
          is_enabled: true,
          ...(recorded ? { manifest: toJsonb(recorded) } : {}),
        })
        .onConflict((oc) =>
          oc
            .columns(['tenant_id', 'name'])
            .doUpdateSet({ is_enabled: true, enabled_at: new Date() }),
        )
        .execute()
        .catch(() => {});

      if (loadedVersionStale(self, name)) await self.unload(name);
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
    for (const name of ordered) announceExtensionLifecycle(name);
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
    const gate = await requireGodStepUp(c, `extension.disable:${name}`);
    if (gate instanceof Response) return gate;

    return withExtensionLock(db, name, async () => {
      // An update, never an upsert: only an install makes a row. A row for a name
      // never installed has no manifest, and that stops every collection create
      // and drop, and every other extension's purge (`nonCollectionObjects`).
      await db
        .updateTable('zv_extension_registry')
        .set({ is_enabled: false })
        .where('name', '=', name)
        .where('tenant_id', 'is', null)
        .execute();

      // God's row is only the default: a firm that turned the extension on keeps
      // it (activation.ts), so its code stays loaded while any row is on — what
      // boot and the lifecycle sync load too.
      if (!(await isExtensionActiveAnywhere(db, name))) {
        // Remove from in-memory registry so buildHonoApp() won't re-register routes
        if (self.isActive(name)) await self.unload(name);
        // Its database roles keep nothing: the grants given at load were never
        // taken back, so a disabled extension's role still reached its tables.
        await revokeExtensionDbRoles(db, name);
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
    const gate = await requireGodStepUp(c, `extension.config:${name}`);
    if (gate instanceof Response) return gate;

    const config = await c.req.json();

    // An update, never an upsert: see `disableExtension`.
    // RETURNING, not a count: the Bun SQL dialect reports no affected rows.
    const updated = await db
      .updateTable('zv_extension_registry')
      .set({ config })
      .where('name', '=', name)
      .where('tenant_id', 'is', null)
      .returning('name')
      .executeTakeFirst();
    if (!updated) {
      return c.json({ error: 'Not found', detail: `"${name}" is not installed.` }, 404);
    }

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
    const gate = await requireGodStepUp(c, `extension.uninstall:${name}`);
    if (gate instanceof Response) return gate;

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
      // Soft or purge, the extension's database roles go; a reinstall makes them again.
      await revokeExtensionDbRoles(db, name, true);

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
      if (isPathInsideBase(extBase, extDir)) {
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
      // Its data is gone: its names are ordinary again (other replicas: syncWithRegistry).
      forgetSensitiveResources(name);
      await recordForwardApproval(db, name, null);

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
    const gate = await requireGodStepUp(c, `extension.approve-capabilities:${name}`);
    if (gate instanceof Response) return gate;

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
    await auditLog(db, {
      type: 'extension.capabilities.approved',
      tenantId: null,
      userId: gate.id ?? undefined,
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

  /**
   * POST /api/marketplace/:name/approve-forward-credentials
   *
   * Body `{ forward_credentials: { route: [header, ...] } }` naming the exact map
   * approved; it replaces the record (`{}` withdraws every approval). The worker
   * receives credentials only while the manifest's map is inside it. A change
   * restarts the running worker here and on every other replica at once.
   *
   * Needs no registry row (migration 071): an extension loaded from
   * ZVELTIO_EXTENSIONS has none, and its manifest is read from wherever it was
   * loaded (ZVELTIO_EXTENSIONS_PATH included).
   */
  const approveForwardCredentials = async (c: Context, name: string) => {
    const gate = await requireGodStepUp(c, `extension.approve-forward-credentials:${name}`);
    if (gate instanceof Response) return gate;

    const extBase = resolveExtensionsBase();
    if (!isPathInsideBase(extBase, join(extBase, name))) {
      return c.json({ error: 'Invalid extension name' }, 400);
    }
    const extDir = self.extDirs.get(name) ?? join(extBase, name);

    let declared: ForwardMap;
    try {
      const m = JSON.parse(readFileSync(join(extDir, 'manifest.json'), 'utf8'));
      declared = parseForwardMap(m.forwardCredentials) ?? {};
    } catch {
      return c.json({ error: `No manifest on disk for "${name}"` }, 404);
    }

    const body = await c.req.json().catch(() => ({}) as Record<string, unknown>);
    const approve = parseForwardMap(body?.forward_credentials);
    if (!approve) {
      return c.json(
        {
          error:
            'Body must be { forward_credentials: { route: [header, ...] } } naming exactly ' +
            'what you are approving.',
          forwarded_credentials: declared,
        },
        400,
      );
    }
    const undeclared = forwardPairsOutside(approve, declared);
    if (undeclared.length > 0) {
      return c.json(
        {
          error: `Not declared by "${name}": ${undeclared.join(', ')}`,
          forwarded_credentials: declared,
        },
        409,
      );
    }

    await recordForwardApproval(db, name, approve);
    await announceForwardApproval(db, name);
    await auditLog(db, {
      type: 'extension.forward_credentials.approved',
      tenantId: null,
      userId: gate.id ?? undefined,
      resourceId: name,
      resourceType: 'extension',
      metadata: { approved: approve, declared },
    }).catch(() => undefined);

    return c.json({
      success: true,
      approved_forward_credentials: approve,
      pending_forward_credentials: resolveForwarded(declared, approve).pending,
      message: `Recorded for "${name}"; its running worker, here and on every replica, follows it now.`,
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
    const gate = await guardAdmin(c, auth, (id) => isTenantAdmin(id).catch(() => false));
    if (gate instanceof Response) return gate;

    const tenantId = resolveFirm(c);
    if (!tenantId) return c.json({ error: 'No tenant resolved for this request' }, 400);

    // A firm may only decide about what god put on the instance. Without this,
    // "activate" on an uninstalled extension would write a row claiming an
    // extension is on for a firm while no code exists to run.
    const global = await db
      .selectFrom('zv_extension_registry')
      .select(['is_installed', 'is_enabled'])
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

    // With god's row off, this row alone would load the code, and the load would
    // run its pending migrations — DDL for the whole instance, god's decision
    // (owner, 2026-10-23). That load refuses instead (load.ts); the row it was
    // refused for is put back as it was, below.
    const firmOnly = enabled && !global.is_enabled;
    const prior = firmOnly
      ? await db
          .selectFrom('zv_extension_registry')
          .select(['is_enabled', 'enabled_at'])
          .where('name', '=', name)
          .where('tenant_id', '=', tenantId)
          .executeTakeFirst()
      : undefined;

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
    // This row can decide whether the code runs at all: on while god's default is
    // off, or the last one on going off. Load or unload here as every replica
    // does on the announcement the dispatcher sends; with no row on any more,
    // take its database roles back, as a disable does.
    const refusal = await self.syncWithRegistry(name);
    if (firmOnly && !self.isActive(name) && isPendingMigrationsRefusal(refusal)) {
      if (prior) {
        await db
          .updateTable('zv_extension_registry')
          .set({ is_enabled: prior.is_enabled, enabled_at: prior.enabled_at })
          .where('name', '=', name)
          .where('tenant_id', '=', tenantId)
          .execute();
      } else {
        await db
          .deleteFrom('zv_extension_registry')
          .where('name', '=', name)
          .where('tenant_id', '=', tenantId)
          .execute();
      }
      invalidateActivationCache(name);
      return c.json({ error: refusal }, 409);
    }
    // Only when this row is what loads the code: with god's row on, whether it
    // loaded is god's enable's outcome, already on record.
    if (firmOnly && !self.isActive(name)) {
      // Before boot finishes the sync is queued: it loads, or refuses and records
      // why, once the engine is up.
      if (refusal === undefined) {
        return c.json(
          { success: true, name, tenant_id: tenantId, is_enabled: true, queued: true },
          202,
        );
      }
      // As an enable that fails to load: the row stays on (the next boot or sync
      // retries) and the reason is on record for the marketplace to show.
      await db
        .updateTable('zv_extension_registry')
        .set({ last_load_error: refusal, last_load_at: new Date() })
        .where('name', '=', name)
        .execute()
        .catch(() => {});
      return c.json({ error: refusal }, 422);
    }
    if (!enabled) {
      await withExtensionLock(db, name, async () => {
        if (!(await isExtensionActiveAnywhere(db, name))) await revokeExtensionDbRoles(db, name);
      });
    }
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
  // Here and on every other replica: theirs load or unload to match (lifecycle.ts),
  // and drop the activation decisions they cached.
  const lifecycleChanged = (name: string) => {
    invalidateActivationCache(name);
    announceExtensionLifecycle(name);
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
        // And a newer version now on disk replaces a copy a firm's row keeps
        // loaded, here and on the other replicas (lifecycle.ts).
        return installExtension(c, name).finally(async () => {
          lifecycleChanged(name);
          await self.syncWithRegistry(name);
        });
      case 'update':
        // Every other replica fetches the recorded version and reloads it (lifecycle.ts).
        return updateExtension(c, name).finally(() => lifecycleChanged(name));
      case 'enable':
        // After the write, never before: a concurrent read between a clear and
        // the write would cache the old answer for the rest of the TTL.
        return enableExtension(c, name).finally(() => lifecycleChanged(name));
      case 'disable':
        // After the write, never before: a concurrent read between a clear and
        // the write would cache the old answer for the rest of the TTL.
        return disableExtension(c, name).finally(() => lifecycleChanged(name));
      case 'uninstall':
        // After the write, never before: a concurrent read between a clear and
        // the write would cache the old answer for the rest of the TTL.
        return uninstallExtension(c, name).finally(() => lifecycleChanged(name));
      case 'approve-capabilities':
        return approveCapabilities(c, name);
      case 'approve-forward-credentials':
        return approveForwardCredentials(c, name);
      case 'activate':
        return setActivation(c, name, true).finally(() => lifecycleChanged(name));
      case 'deactivate':
        return setActivation(c, name, false).finally(() => lifecycleChanged(name));
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
