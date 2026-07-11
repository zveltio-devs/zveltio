/**
 * Unit coverage for lib/extensions/extension-marketplace-routes.ts — the
 * marketplace HTTP surface driven with CannedDb + mocked auth/catalog/loader.
 */

import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  mock,
  spyOn,
} from 'bun:test';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Hono } from 'hono';
import type { Database } from '../../db/index.js';
import type { ExtensionCatalogEntry } from '../../lib/extensions/extension-catalog.js';
import { DownMissingError } from '../../lib/extensions/extension-errors.js';
import type { ExtensionLoader } from '../../lib/extensions/extension-loader.js';
import { auth, initAuth } from '../../lib/auth.js';
import { initPermissions } from '../../lib/tenancy/index.js';
import { CannedDb } from './fixtures/canned-db.js';

const POLICY_ROWS = [
  { ptype: 'p', v0: 'admin', v1: '*', v2: '*', v3: '*', v4: null, v5: null },
  { ptype: 'g', v0: 'u-god', v1: 'admin', v2: '*', v3: null, v4: null, v5: null },
];
const CATALOG_ENTRY: ExtensionCatalogEntry = {
  name: 'unit-ext',
  displayName: 'Unit Ext',
  description: 'test',
  category: 'other',
  version: '1.0.0',
  author: 'tester',
  tags: [],
  permissions: [],
  download_url: 'https://registry.test/dl/unit-ext',
  is_official: true,
};

const fetchCatalogMock = mock(async () => [CATALOG_ENTRY]);
const downloadMock = mock(async () => {});
const loadDynamicMock = mock(async () => {});
const isActiveMock = mock((_name: string) => false);
const unloadMock = mock(async () => {});
const topoSortMock = mock(async (names: string[]) => names);
const purgeMock = mock(async () => {});
const triggerReloadMock = mock(async () => {});

mock.module('../../lib/extensions/extension-download.js', () => ({
  REGISTRY_URL: 'https://registry.test',
  fetchRegistryCatalog: fetchCatalogMock,
  downloadExtension: downloadMock,
}));

const { registerMarketplaceRoutes } = await import(
  '../../lib/extensions/extension-marketplace-routes.js'
);

function asDb(db: CannedDb): Database {
  return db.kysely as unknown as Database;
}

function seedDb(db: CannedDb): void {
  db.when(/pg_advisory_xact_lock/i, []);
  db.when(/from "zv_extension_registry"/i, []);
  db.when(/from "zv_settings"/i, []);
  db.when(/from "zv_license_audit"/i, []);
}

function makeLoader(): ExtensionLoader {
  return {
    isActive: isActiveMock,
    loadDynamic: loadDynamicMock,
    unload: unloadMock,
    topoSortExtensions: topoSortMock,
    purgeExtensionData: purgeMock,
    lastLoadError: new Map(),
  } as unknown as ExtensionLoader;
}

function writeExtOnDisk(extBase: string, name: string, deps: string[] = []): void {
  const dir = join(extBase, name);
  mkdirSync(join(dir, 'engine'), { recursive: true });
  writeFileSync(join(dir, 'engine', 'index.ts'), 'export default {}');
  writeFileSync(
    join(dir, 'manifest.json'),
    JSON.stringify({ name, version: '1.0.0', dependencies: deps }),
  );
}

function mountRoutes(db: CannedDb, extBase: string): Hono {
  process.env.EXTENSIONS_DIR = extBase;
  const app = new Hono();
  registerMarketplaceRoutes(makeLoader(), app, asDb(db), triggerReloadMock);
  return app;
}

const adminHeaders = { cookie: 'session=admin' };

describe('registerMarketplaceRoutes (unit)', () => {
  let db: CannedDb;
  let extBase: string;
  let getSessionSpy: ReturnType<typeof spyOn>;

  beforeAll(async () => {
    process.env.BETTER_AUTH_SECRET ??= 'unit-test-secret-minimum-32-characters-xx';
    const seed = new CannedDb();
    seed.when(/FROM zvd_permissions/i, POLICY_ROWS);
    seed.when(/SELECT role FROM "user" WHERE id = /i, (q) => [
      { role: q.parameters[0] === 'u-god' ? 'god' : 'member' },
    ]);
    await initAuth(seed.kysely as unknown as Database);
    await initPermissions(seed.kysely as unknown as Database);
  });

  beforeEach(() => {
    db = new CannedDb();
    seedDb(db);
    extBase = mkdtempSync(join(tmpdir(), 'zv-mkt-'));
    getSessionSpy = spyOn(auth.api, 'getSession').mockResolvedValue({
      user: { id: 'u-god' },
    } as never);
    fetchCatalogMock.mockImplementation(async () => [CATALOG_ENTRY]);
    downloadMock.mockImplementation(async () => {});
    loadDynamicMock.mockImplementation(async () => {});
    isActiveMock.mockImplementation(() => false);
    unloadMock.mockImplementation(async () => {});
    topoSortMock.mockImplementation(async (names: string[]) => names);
    purgeMock.mockImplementation(async () => {});
    loadDynamicMock.mockClear();
    unloadMock.mockClear();
    topoSortMock.mockClear();
    triggerReloadMock.mockClear();
    isActiveMock.mockClear();
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.includes('/api/licenses/verify')) {
        return { ok: true, status: 200, json: async () => ({ valid: true }) } as Response;
      }
      return fetch(input, init);
    }) as typeof fetch;
  });

  afterEach(() => {
    delete process.env.EXTENSIONS_DIR;
    getSessionSpy.mockRestore();
  });

  afterAll(() => {
    mock.restore();
  });

  it('GET /api/marketplace returns 401 for non-admin', async () => {
    getSessionSpy.mockResolvedValue({ user: { id: 'u-nobody' } } as never);
    const app = mountRoutes(db, extBase);
    const res = await app.request('/api/marketplace', { headers: adminHeaders });
    expect(res.status).toBe(401);
  });

  it('GET /api/marketplace merges catalog with registry rows', async () => {
    writeExtOnDisk(extBase, CATALOG_ENTRY.name);
    db.when(/from "zv_extension_registry"/i, [
      {
        name: CATALOG_ENTRY.name,
        is_installed: true,
        is_enabled: false,
        tenant_id: null,
        config: { flag: true },
      },
    ]);
    const app = mountRoutes(db, extBase);
    const res = await app.request('/api/marketplace', { headers: adminHeaders });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      extensions: Array<{ name: string; is_installed: boolean; config: Record<string, unknown> }>;
    };
    const row = body.extensions.find((e) => e.name === CATALOG_ENTRY.name);
    expect(row?.is_installed).toBe(true);
    expect(row?.config).toEqual({ flag: true });
  });

  it('POST install returns 404 when the extension is absent from the catalog', async () => {
    const app = mountRoutes(db, extBase);
    const res = await app.request(`/api/marketplace/ghost-ext/install`, {
      method: 'POST',
      headers: { ...adminHeaders, 'Content-Type': 'application/json' },
      body: '{}',
    });
    expect(res.status).toBe(404);
  });

  it('POST install returns 422 when download fails and nothing is on disk', async () => {
    downloadMock.mockImplementation(async () => {
      throw new Error('registry offline');
    });
    const app = mountRoutes(db, extBase);
    const res = await app.request(`/api/marketplace/${CATALOG_ENTRY.name}/install`, {
      method: 'POST',
      headers: { ...adminHeaders, 'Content-Type': 'application/json' },
      body: '{}',
    });
    expect(res.status).toBe(422);
    const body = (await res.json()) as { success: boolean; files_on_disk: boolean };
    expect(body.success).toBe(false);
    expect(body.files_on_disk).toBe(false);
  });

  it('POST install succeeds when files already exist on disk', async () => {
    writeExtOnDisk(extBase, CATALOG_ENTRY.name);
    const app = mountRoutes(db, extBase);
    const res = await app.request(`/api/marketplace/${CATALOG_ENTRY.name}/install`, {
      method: 'POST',
      headers: { ...adminHeaders, 'Content-Type': 'application/json' },
      body: '{}',
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { success: boolean; downloaded: boolean };
    expect(body.success).toBe(true);
    expect(body.downloaded).toBe(false);
  });

  it('POST enable hot-loads and triggers reload on success', async () => {
    writeExtOnDisk(extBase, CATALOG_ENTRY.name);
    let active = false;
    isActiveMock.mockImplementation(() => active);
    loadDynamicMock.mockImplementation(async () => {
      active = true;
    });
    const app = mountRoutes(db, extBase);
    const res = await app.request(`/api/marketplace/${CATALOG_ENTRY.name}/enable`, {
      method: 'POST',
      headers: { ...adminHeaders, 'Content-Type': 'application/json' },
      body: '{}',
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { hot_loaded: boolean; success: boolean };
    expect(body.hot_loaded).toBe(true);
    expect(body.success).toBe(true);
    expect(triggerReloadMock).toHaveBeenCalled();
  });

  it('POST enable returns 422 when loadDynamic throws', async () => {
    writeExtOnDisk(extBase, CATALOG_ENTRY.name);
    loadDynamicMock.mockImplementation(async () => {
      throw new Error('npm missing');
    });
    isActiveMock.mockImplementation(() => false);
    const app = mountRoutes(db, extBase);
    const res = await app.request(`/api/marketplace/${CATALOG_ENTRY.name}/enable`, {
      method: 'POST',
      headers: { ...adminHeaders, 'Content-Type': 'application/json' },
      body: '{}',
    });
    expect(res.status).toBe(422);
    const body = (await res.json()) as { error_detail?: string };
    expect(body.error_detail).toContain('npm missing');
  });

  it('POST enable reports hot_loaded when the extension is already active', async () => {
    writeExtOnDisk(extBase, CATALOG_ENTRY.name);
    loadDynamicMock.mockClear();
    isActiveMock.mockImplementation(() => true);
    const app = mountRoutes(db, extBase);
    const res = await app.request(`/api/marketplace/${CATALOG_ENTRY.name}/enable`, {
      method: 'POST',
      headers: { ...adminHeaders, 'Content-Type': 'application/json' },
      body: '{}',
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { hot_loaded: boolean };
    expect(body.hot_loaded).toBe(true);
    expect(loadDynamicMock).not.toHaveBeenCalled();
  });

  it('POST disable unloads an active extension and triggers reload', async () => {
    isActiveMock.mockImplementation(() => true);
    const app = mountRoutes(db, extBase);
    const res = await app.request(`/api/marketplace/${CATALOG_ENTRY.name}/disable`, {
      method: 'POST',
      headers: { ...adminHeaders, 'Content-Type': 'application/json' },
      body: '{}',
    });
    expect(res.status).toBe(200);
    expect(unloadMock).toHaveBeenCalled();
    expect(triggerReloadMock).toHaveBeenCalled();
  });

  it('PUT config upserts registry config JSON', async () => {
    const app = mountRoutes(db, extBase);
    const res = await app.request(`/api/marketplace/${CATALOG_ENTRY.name}/config`, {
      method: 'PUT',
      headers: { ...adminHeaders, 'Content-Type': 'application/json' },
      body: JSON.stringify({ api_key: 'secret' }),
    });
    expect(res.status).toBe(200);
    expect(db.executed(/insert into "zv_extension_registry"/i).length).toBeGreaterThan(0);
  });

  it('POST uninstall soft marks the extension uninstalled', async () => {
    const app = mountRoutes(db, extBase);
    const res = await app.request(`/api/marketplace/${CATALOG_ENTRY.name}/uninstall`, {
      method: 'POST',
      headers: { ...adminHeaders, 'Content-Type': 'application/json' },
      body: '{}',
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { purged: boolean };
    expect(body.purged).toBe(false);
  });

  it('POST uninstall purge returns 422 on DownMissingError', async () => {
    purgeMock.mockImplementation(async () => {
      throw new DownMissingError(CATALOG_ENTRY.name, ['001.sql']);
    });
    const app = mountRoutes(db, extBase);
    const res = await app.request(
      `/api/marketplace/${CATALOG_ENTRY.name}/uninstall?purgeData=true`,
      {
        method: 'POST',
        headers: { ...adminHeaders, 'Content-Type': 'application/json' },
        body: '{}',
      },
    );
    expect(res.status).toBe(422);
    const body = (await res.json()) as { error: string; missing_migrations: string[] };
    expect(body.error).toBe('EXT_DOWN_MISSING');
    expect(body.missing_migrations).toEqual(['001.sql']);
  });

  it('POST enable-all loads installed extensions in topo order', async () => {
    writeExtOnDisk(extBase, 'ext-a');
    writeExtOnDisk(extBase, 'ext-b');
    db.when(/from "zv_extension_registry"[\s\S]*is_installed/i, [
      { name: 'ext-a' },
      { name: 'ext-b' },
    ]);
    isActiveMock.mockImplementation(() => false);
    const app = mountRoutes(db, extBase);
    const res = await app.request('/api/marketplace/enable-all', {
      method: 'POST',
      headers: { ...adminHeaders, 'Content-Type': 'application/json' },
      body: '{}',
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { results: Array<{ name: string; ok: boolean }> };
    expect(body.results.length).toBe(2);
    expect(topoSortMock).toHaveBeenCalled();
    expect(triggerReloadMock).toHaveBeenCalled();
  });

  it('POST license store rejects missing license_key', async () => {
    const app = mountRoutes(db, extBase);
    const res = await app.request(`/api/marketplace/license/${CATALOG_ENTRY.name}`, {
      method: 'POST',
      headers: { ...adminHeaders, 'Content-Type': 'application/json' },
      body: '{}',
    });
    expect(res.status).toBe(400);
  });

  it('POST license store rejects invalid keys from the registry', async () => {
    globalThis.fetch = (async () =>
      ({
        ok: false,
        status: 400,
        json: async () => ({ message: 'bad key' }),
      }) as Response) as unknown as typeof fetch;
    const app = mountRoutes(db, extBase);
    const res = await app.request(`/api/marketplace/license/${CATALOG_ENTRY.name}`, {
      method: 'POST',
      headers: { ...adminHeaders, 'Content-Type': 'application/json' },
      body: JSON.stringify({ license_key: 'nope' }),
    });
    expect(res.status).toBe(400);
  });

  it('POST license rotate mints a new marketplace token', async () => {
    db.when(/from "zv_settings"[\s\S]*marketplace_auth_token/i, [{ value: 'old-token' }]);
    const app = mountRoutes(db, extBase);
    const res = await app.request('/api/admin/license/rotate', {
      method: 'POST',
      headers: adminHeaders,
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; token: string };
    expect(body.ok).toBe(true);
    expect(body.token).toMatch(/^[0-9a-f]{64}$/);
  });

  it('GET license history returns audit rows', async () => {
    db.when(/from "zv_license_audit"/i, [{ action: 'rotate', extension_name: null }]);
    const app = mountRoutes(db, extBase);
    const res = await app.request('/api/admin/license/history', { headers: adminHeaders });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { history: unknown[] };
    expect(body.history.length).toBe(1);
  });

  it('catalog lists missing_dependencies from manifest', async () => {
    writeExtOnDisk(extBase, CATALOG_ENTRY.name, ['dep-a']);
    const app = mountRoutes(db, extBase);
    const res = await app.request('/api/marketplace', { headers: adminHeaders });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      extensions: Array<{ name: string; missing_dependencies: string[] }>;
    };
    const row = body.extensions.find((e) => e.name === CATALOG_ENTRY.name);
    expect(row?.missing_dependencies).toContain('dep-a');
  });
});
