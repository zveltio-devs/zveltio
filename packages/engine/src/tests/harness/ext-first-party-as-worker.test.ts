/**
 * ADR 0062 order of work step 2 (the spike's loop, as a test): every first-party
 * extension of the sibling `zveltio-extensions` checkout is loaded as a signed
 * worker — its own files, `engine.isolation` set to `"worker"`, signed with the
 * test operator key (level 3) — through the engine's own loader, `process`
 * transport. The sets of what loads and what is refused are asserted exactly,
 * so an extension that stops loading, or one that starts loading past a
 * refusal, fails here.
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
import { _resetWorkerHostForTests, getWorkerHost } from '../../lib/worker-extension-host.js';
import {
  forgetInstalled,
  getTestApp,
  harnessAvailable,
  markInstalled,
} from '../../testing/app-harness.js';
import { signAsOperator } from '../../testing/operator-signed.js';

const SIBLING = join(import.meta.dir, '../../../../../../zveltio-extensions');
const d = harnessAvailable() && existsSync(SIBLING) ? describe : describe.skip;

/** Declared model only, with no `"*"`: these run isolated today, unchanged. */
const LOADS = [
  'ai',
  'auth/scim',
  'communications/mail',
  'compliance/ro/documents',
  'compliance/ro/efactura',
  'compliance/ro/etransport',
  'compliance/ro/procurement',
  'compliance/ro/saft',
  'content/media',
  'crm',
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

/** `"*"` in an action: first-party only, and a worker's tier never is (ADR 0053 d5, ADR 0062 F11). */
const REFUSED_STAR = [
  'analytics/quality',
  'content/drafts',
  'data/import',
  'integrations/migrators',
];

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

  beforeAll(async () => {
    db = (await getTestApp()).db;
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
      manifest.engine.isolation = 'worker';
      writeFileSync(join(dir, 'manifest.json'), JSON.stringify(manifest));
      await signAsOperator(dir, name);
      await markInstalled(db, name);
    }
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
    for (const name of names) await extensionLoader.unload(name).catch(() => {});
    if (db) await forgetInstalled(db, ...names);
    if (base) rmSync(base, { recursive: true, force: true });
  }, 120_000);

  it('finds the 56 first-party extensions', () => {
    expect(names).toEqual(
      [
        ...LOADS,
        ...LOADS_NOT_READY,
        ...REFUSED_STAR,
        ...Object.keys(REFUSED_PAST_MODEL),
        ...NO_ENGINE,
      ].sort(),
    );
  });

  it('loads the 37 declared-model extensions (and auth/saml, not ready) as workers', () => {
    const loaded = names.filter((n) => outcome.get(n) === 'loaded');
    expect(loaded).toEqual([...LOADS, ...LOADS_NOT_READY].sort());
    // Running in a process of its own, not merely recorded as loaded.
    for (const n of loaded) expect(getWorkerHost(app).isRunning(n)).toBe(true);
  });

  it('refuses the four "*" extensions, naming the first-party rule', () => {
    for (const n of REFUSED_STAR) {
      expect(outcome.get(n)).toMatch(/lists "\*".*first-party/);
    }
  });

  it('refuses the thirteen that reach past the declared model, naming it', () => {
    for (const [n, why] of Object.entries(REFUSED_PAST_MODEL)) {
      expect(outcome.get(n)).toMatch(why);
    }
  });
});
