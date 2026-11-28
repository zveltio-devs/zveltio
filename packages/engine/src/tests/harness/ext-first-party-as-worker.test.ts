/**
 * ADR 0062 order of work step 2 (the spike's loop, as a test): every first-party
 * extension of the sibling `zveltio-extensions` checkout is loaded through the
 * engine's own loader, `process` transport, its manifest unchanged — the
 * engine, not `engine.isolation`, decides where it runs (d1).
 *
 * - Off the engine's inline list: signed as a registry download leaves it,
 *   first-party in the catalogue, so level 0 (d2). Every one loads as a worker,
 *   the four `"*"` ones too.
 * - On the inline list: signed with the test operator key (level 3), which
 *   always runs on the runner, so each shows the refusal that keeps it inline
 *   until it is ported (the porting list).
 *
 * The sets are asserted exactly, so an extension that stops loading, or one
 * that starts loading past a refusal, fails here.
 *
 * Skips when the sibling is absent (the harness jobs have none); CI runs it in
 * the job that checks out both repositories.
 */

import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import { Glob } from 'bun';
import { Hono } from 'hono';
import type { Database } from '../../db/index.js';
import { extensionLoader } from '../../lib/extensions/extension-loader.js';
import { _setInlineForTests, INLINE_EXTENSIONS } from '../../lib/extensions/load-phases.js';
import { _resetWorkerHostForTests, getWorkerHost } from '../../lib/worker-extension-host.js';
import { sql } from 'kysely';
import {
  dropTestCollection,
  forgetInstalled,
  getTestApp,
  harnessAvailable,
  markInstalled,
} from '../../testing/app-harness.js';
import { signAsOperator } from '../../testing/operator-signed.js';

const SIBLING = join(import.meta.dir, '../../../../../../zveltio-extensions');
const SIGN = join(import.meta.dir, '../../../../../scripts/sign-as-registry.ts');
const d = harnessAvailable() && existsSync(SIBLING) ? describe : describe.skip;

/** Off the inline list: each runs as a worker, at level 0 (ADR 0062 d1, d2). */
const LOADS = [
  'ai',
  'analytics/quality',
  'auth/scim',
  'communications/mail',
  'compliance/ro/documents',
  'compliance/ro/efactura',
  'compliance/ro/etransport',
  'compliance/ro/procurement',
  'compliance/ro/saft',
  'content/drafts',
  'content/media',
  'crm',
  'data/import',
  'ecommerce/store',
  'finance/accounting',
  'finance/banking',
  'finance/expenses',
  'finance/invoicing',
  'finance/quotes',
  'finance/subscriptions',
  'forms',
  'geospatial/postgis',
  'hr/employees',
  'hr/leave',
  'hr/payroll',
  'hr/time-tracking',
  'i18n/translations',
  'integrations/migrators',
  'operations/assets',
  'operations/inventory',
  'operations/pos',
  'projects/helpdesk',
  'projects/management',
  'storage/cloud',
  'templates/ansvsa',
  'templates/helpdesk',
  'templates/inventory',
  'templates/invoicing',
  'templates/project',
  'workflow/approvals',
  'workflow/checklists',
];

/**
 * Loads, and is not ready: its `register()` keeps the refusing `ctx` without
 * touching it, and its sign-in route reads `ctx.db` from it at request time
 * (ADR 0062, "Measured today"). Listed apart so it is never counted with the 37.
 */
const LOADS_NOT_READY = ['auth/saml'];

/** `"*"` in an action: first-party only (ADR 0053 d5), which level 0 is on the runner (ADR 0062 d2). */
const STAR = ['analytics/quality', 'content/drafts', 'data/import', 'integrations/migrators'];

/**
 * Reach past the declared model (ADR 0062 porting list, less saml), each with
 * the refusal it gets today: `register()` touching the refusing app or ctx, a
 * job body that is not a Deno bundle, or a dependency that was refused.
 */
const PAST_MODEL = (what: string) =>
  new RegExp(`register\\(\\) used ${what}: .*declared model only`);
const REFUSED_PAST_MODEL: Record<string, RegExp> = {
  'analytics/dashboard': PAST_MODEL('app.route'),
  'auth/ldap': PAST_MODEL('app.route'),
  billing: /job "applyEvent" runs in the Deno runner, which needs engine\/jobs.js/,
  'compliance/gdpr': PAST_MODEL('app.route'),
  'content/document-templates': PAST_MODEL('app.route'),
  'content/documents': /Missing required extensions: content\/document-templates/,
  'content/pages': PAST_MODEL('app.get'),
  'data/export': PAST_MODEL('app.route'),
  'developer/api-docs': PAST_MODEL('app.route'),
  'developer/byod': PAST_MODEL('app.route'),
  'integrations/api-connector': PAST_MODEL('ctx.internals'),
  'operations/traceability': PAST_MODEL('app.route'),
  sms: PAST_MODEL('ctx.internals'),
};

/** No engine code at all: nothing to run anywhere. */
const NO_ENGINE = ['content/pdf-viewer'];

/** Every first-party extension directory: one holding a manifest.json. */
function firstParty(): string[] {
  return [...new Glob('**/manifest.json').scanSync({ cwd: SIBLING, onlyFiles: true })]
    .filter((p) => !p.includes('node_modules') && !p.startsWith('testing/'))
    .map((p) => dirname(p))
    .filter((p) => p !== '.')
    .sort();
}

d('every first-party extension, loaded as a signed worker (ADR 0062 step 2)', () => {
  let db: Database;
  let base: string;
  const app = new Hono();
  const names = existsSync(SIBLING) ? firstParty() : [];
  const outcome = new Map<string, string>();
  /** Declared collections that did not exist before this file: dropped after it. */
  const created: string[] = [];

  const keys = process.env.REGISTRY_PUBLIC_KEYS_JSON;
  let wasInline = false;

  beforeAll(async () => {
    db = (await getTestApp()).db;
    wasInline = _setInlineForTests(false);
    base = mkdtempSync(join(tmpdir(), 'fp-worker-'));
    process.env.ZVELTIO_EXT_TRANSPORT = 'process';
    _resetWorkerHostForTests();
    getWorkerHost(app);
    const ctx = extensionLoader.ctx ?? ({ db, fieldTypeRegistry: { register() {} } } as never);
    for (const name of names) {
      const manifest = JSON.parse(readFileSync(join(SIBLING, name, 'manifest.json'), 'utf8'));
      if (!manifest.engine) {
        outcome.set(name, 'no-engine');
        continue;
      }
      const dir = join(base, name);
      cpSync(join(SIBLING, name), dir, {
        recursive: true,
        // Its files, not a registry signature a local `sign-as-registry` left
        // there (gitignored): this load is the operator's, level 3.
        filter: (src) =>
          !relative(join(SIBLING, name), src)
            .split('/')
            .some((seg) => seg === 'node_modules' || seg === '.zveltio-registry'),
      });
      for (const c of (manifest.collections ?? []) as string[]) {
        const t = await sql<{
          t: string | null;
        }>`SELECT to_regclass(${`zvd_${c}`})::text AS t`.execute(db);
        if (t.rows[0]?.t === null) created.push(c);
      }
      // Kept as published: the manifest does not choose where it runs (d1).
      if (INLINE_EXTENSIONS.has(name)) await signAsOperator(dir, name);
      await markInstalled(db, name);
    }
    const registry = names.filter(
      (n) => outcome.get(n) !== 'no-engine' && !INLINE_EXTENSIONS.has(n),
    );
    const signed = Bun.spawnSync(['bun', SIGN, base, ...registry]);
    if (signed.exitCode !== 0) throw new Error(`sign-as-registry: ${signed.stderr.toString()}`);
    process.env.REGISTRY_PUBLIC_KEYS_JSON = signed.stdout
      .toString()
      .trim()
      .replace(/^REGISTRY_PUBLIC_KEYS_JSON=/, '');
    // Dependencies first: a dependent finds its dependency loaded, as at boot.
    // Two passes are enough for the first-party graph (depth 2).
    for (let pass = 0; pass < 2; pass++) {
      for (const name of names) {
        if (outcome.get(name) === 'no-engine' || extensionLoader.loaded.has(name)) continue;
        extensionLoader.lastLoadError.delete(name);
        await extensionLoader.loadExtension(name, app, ctx, base);
        outcome.set(
          name,
          extensionLoader.loaded.has(name)
            ? 'loaded'
            : `refused: ${extensionLoader.getLastLoadError(name) ?? '(no reason recorded)'}`,
        );
      }
    }
    console.log(
      `[fp-worker] ${[...outcome.values()].filter((v) => v === 'loaded').length} loaded of ${names.length}`,
    );
    for (const [n, v] of outcome)
      if (v !== 'loaded') console.log(`[fp-worker] ${n}: ${v.slice(0, 220)}`);
  }, 600_000);

  afterAll(async () => {
    await getWorkerHost(app).stopAll();
    _resetWorkerHostForTests();
    _setInlineForTests(wasInline);
    if (keys === undefined) delete process.env.REGISTRY_PUBLIC_KEYS_JSON;
    else process.env.REGISTRY_PUBLIC_KEYS_JSON = keys;
    for (const name of names) await extensionLoader.unload(name).catch(() => {});
    if (db) await forgetInstalled(db, ...names);
    // What the loads created, so a later file finds the names free.
    if (db) for (const c of created) await dropTestCollection(db, c).catch(() => {});
    if (base) rmSync(base, { recursive: true, force: true });
  }, 120_000);

  it('finds the 56 first-party extensions', () => {
    expect(names).toEqual(
      [...LOADS, ...LOADS_NOT_READY, ...Object.keys(REFUSED_PAST_MODEL), ...NO_ENGINE].sort(),
    );
    // What stays inline is the engine's list, and nothing else (ADR 0062 d1).
    expect([...INLINE_EXTENSIONS].sort()).toEqual(
      [...LOADS_NOT_READY, ...Object.keys(REFUSED_PAST_MODEL)].sort(),
    );
  });

  it('runs every extension off the inline list as a worker, at level 0 (ADR 0062 d1, d2)', () => {
    const loaded = names.filter((n) => outcome.get(n) === 'loaded');
    expect(loaded).toEqual([...LOADS, ...LOADS_NOT_READY].sort());
    // Running in a process of its own, not merely recorded as loaded.
    const host = getWorkerHost(app);
    for (const n of loaded) expect(host.isRunning(n)).toBe(true);
    const level = new Map(host.getHealth().map((h) => [h.name, h.level]));
    for (const n of LOADS) expect([n, level.get(n)]).toEqual([n, 0]);
    // The four "*" extensions run isolated with no port (d2).
    for (const n of STAR) expect(LOADS).toContain(n);
  });

  it('refuses the thirteen listed ones on the runner, naming what keeps them inline', () => {
    for (const [n, why] of Object.entries(REFUSED_PAST_MODEL)) {
      expect(outcome.get(n)).toMatch(why);
    }
  });
});
