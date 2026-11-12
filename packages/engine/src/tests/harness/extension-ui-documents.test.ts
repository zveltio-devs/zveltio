/**
 * ADR 0038 decision 4: an enabled extension's built documents are served under
 * `/api/extensions/<name>/ui/*`, each response under a policy that makes it an
 * opaque origin with no network; a disabled or unloaded extension answers 404.
 *
 * The browser half — "a frame cannot read `parent.document`" — follows from the
 * `sandbox` directive without `allow-same-origin`: the document gets an opaque
 * origin, so every access to the host's DOM is a cross-origin access and throws.
 * What is pinned here is that header, on every file, including a direct open.
 */

import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { sql } from 'kysely';
import { invalidateActivationCache } from '../../lib/extensions/activation.js';
import { extensionLoader } from '../../lib/extensions/extension-loader.js';
import { getTestApp, harnessAvailable } from '../../testing/app-harness.js';
import type { Database } from '../../db/index.js';

const d = harnessAvailable() ? describe : describe.skip;
const NAME = `uidocs/x${Date.now()}`;
const BASE = `/api/extensions/${NAME}/ui`;

function directives(csp: string): Map<string, string[]> {
  return new Map(
    csp
      .split(';')
      .map((p) => p.trim().split(/\s+/))
      .filter((p) => p[0])
      .map(([k, ...v]) => [k as string, v]),
  );
}

d('extension ui documents', () => {
  let app: Awaited<ReturnType<typeof getTestApp>>['app'];
  let db: Database;
  let dir = '';

  const setEnabled = async (on: boolean) => {
    await sql`UPDATE zv_extension_registry SET is_enabled = ${on} WHERE name = ${NAME}`.execute(db);
    invalidateActivationCache();
  };

  beforeAll(async () => {
    ({ app, db } = await getTestApp());
    dir = await mkdtemp(join(tmpdir(), 'zv-ui-'));
    await mkdir(join(dir, 'ui', 'assets'), { recursive: true });
    await writeFile(
      join(dir, 'ui', 'index.html'),
      '<!doctype html><script src="assets/a.js"></script>',
    );
    await writeFile(join(dir, 'ui', 'assets', 'a.js'), 'console.log(1)');
    await writeFile(join(dir, 'manifest.json'), '{"secret":true}');
    await symlink(join(dir, 'manifest.json'), join(dir, 'ui', 'escape.json'));
    await sql`
      INSERT INTO zv_extension_registry (name, display_name, tenant_id, is_installed, is_enabled)
      VALUES (${NAME}, ${NAME}, NULL, true, true)
    `.execute(db);
    extensionLoader.markActive(NAME);
    extensionLoader.extDirs.set(NAME, dir);
    invalidateActivationCache();
  });

  afterAll(async () => {
    extensionLoader.loaded.delete(NAME);
    extensionLoader.extDirs.delete(NAME);
    await sql`DELETE FROM zv_extension_registry WHERE name = ${NAME}`.execute(db);
    invalidateActivationCache();
    await rm(dir, { recursive: true, force: true });
  });

  it('serves an enabled extension’s files, each with its own sandbox and no network', async () => {
    for (const [file, type] of [
      ['index.html', 'text/html'],
      ['assets/a.js', 'javascript'],
    ] as const) {
      const res = await app.request(`${BASE}/${file}`);
      expect(res.status).toBe(200);
      expect(res.headers.get('content-type')).toContain(type);
      const csp = directives(res.headers.get('content-security-policy') ?? '');
      // Opaque origin: no `allow-same-origin`, so `parent.document` is cross-origin.
      expect(csp.get('sandbox')).toEqual(['allow-scripts', 'allow-forms']);
      expect(csp.get('default-src')).toEqual(["'none'"]);
      expect(csp.get('connect-src')).toEqual(["'none'"]);
      expect(csp.get('form-action')).toEqual(["'none'"]);
      // Its own files, data: and blob: — not the engine's origin.
      expect(csp.get('img-src')).toEqual([`localhost${BASE}/`, 'data:', 'blob:']);
      expect(csp.get('script-src')).not.toContain("'self'");
      // A front end must be able to frame it.
      expect(res.headers.get('x-frame-options')).toBeNull();
    }
  });

  it('never leaves ui/', async () => {
    for (const p of ['../manifest.json', '%2e%2e/manifest.json', 'escape.json', 'assets']) {
      expect((await app.request(`${BASE}/${p}`)).status).toBe(404);
    }
    expect((await app.request(BASE)).status).toBe(404);
  });

  it('answers 404 once the extension is disabled, and again once it is unloaded', async () => {
    await setEnabled(false);
    expect((await app.request(`${BASE}/index.html`)).status).toBe(404);
    await setEnabled(true);
    expect((await app.request(`${BASE}/index.html`)).status).toBe(200);
    extensionLoader.loaded.delete(NAME);
    expect((await app.request(`${BASE}/index.html`)).status).toBe(404);
    extensionLoader.markActive(NAME);
  });
});
