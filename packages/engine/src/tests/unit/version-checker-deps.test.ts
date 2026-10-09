/**
 * checkExtensionDependencies (lib/version-checker.ts) — installed + minVersion gate.
 */

import { describe, expect, it } from 'bun:test';
import type { Database } from '../../db/index.js';
import { checkExtensionDependencies } from '../../lib/version-checker.js';
import { CannedDb } from './fixtures/canned-db.js';

function asDb(db: CannedDb): Database {
  return db.kysely as unknown as Database;
}

describe('checkExtensionDependencies', () => {
  it('reports missing when the dependency is not installed or enabled', async () => {
    const db = new CannedDb();
    db.when(/from "zv_extension_registry"/i, []);
    const result = await checkExtensionDependencies(asDb(db), [{ name: 'forms' }]);
    expect(result.satisfied).toBe(false);
    expect(result.missing).toEqual(['forms (not installed)']);
  });

  it('accepts an installed dependency with no minVersion', async () => {
    const db = new CannedDb();
    db.when(/from "zv_extension_registry"/i, [{ version: '2.0.0', is_enabled: true }]);
    const result = await checkExtensionDependencies(asDb(db), [{ name: 'forms' }]);
    expect(result).toEqual({ satisfied: true, missing: [], tooOld: [] });
  });

  it('flags an installed version below the required minVersion', async () => {
    // Only `version`/`is_enabled` are ever selected from this table (see the
    // real query in checkExtensionDependencies) — a canned row with an
    // `installed_version` field the code never reads would let a wrong field
    // name pass silently. Match the real projection.
    const db = new CannedDb();
    db.when(/from "zv_extension_registry"/i, [{ version: '1.2.0', is_enabled: true }]);
    const result = await checkExtensionDependencies(asDb(db), [
      { name: 'forms', minVersion: '2.0.0' },
    ]);
    expect(result.satisfied).toBe(false);
    expect(result.missing[0]).toMatch(/forms >= 2\.0\.0/);
    expect(result.missing[0]).toMatch(/installed: 1\.2\.0/);
  });

  it('accepts when the installed version meets minVersion', async () => {
    const db = new CannedDb();
    db.when(/from "zv_extension_registry"/i, [{ version: '3.1.0', is_enabled: true }]);
    const result = await checkExtensionDependencies(asDb(db), [
      { name: 'analytics', minVersion: '3.0.0' },
    ]);
    expect(result).toEqual({ satisfied: true, missing: [], tooOld: [] });
  });

  /**
   * This assertion used to be `expect(result.missing).toEqual(['forms (not
   * installed)'])`, under the title "treats a registry query failure as not
   * installed" — an accurate description of a defect, held in place by a passing
   * test.
   *
   * "I could not read the registry" and "this extension is not installed" are
   * different facts, and the second is the one an operator acts on: they go and
   * install something that is already there. The extension still refuses to load
   * either way, which is the right direction; what changes is what it says.
   *
   * `loadExtensionFromDir` wraps the caller in a per-extension boundary, so the
   * throw fails that one extension's load with the database's own message and
   * every other extension still loads.
   */
  it('reports a registry read failure as a failure, not as "not installed"', async () => {
    const db = new CannedDb();
    db.fail(/from "zv_extension_registry"/i, new Error('registry offline'));
    await expect(checkExtensionDependencies(asDb(db), [{ name: 'forms' }])).rejects.toThrow(
      /registry offline/,
    );
  });

  it('still reports a genuinely absent extension as not installed', async () => {
    // The fix must not turn "no such row" into an error — that is the case this
    // function exists to detect, and it is not a failure of anything.
    const db = new CannedDb();
    db.when(/from "zv_extension_registry"/i, []);
    const result = await checkExtensionDependencies(asDb(db), [{ name: 'forms' }]);
    expect(result.satisfied).toBe(false);
    expect(result.missing).toEqual(['forms (not installed)']);
  });

  /**
   * A dependency loaded in this boot skipped the check whole, `minVersion`
   * included: `alreadyLoaded` was a set of names, so a dependency running at
   * 1.0.0 satisfied `minVersion: "2.0.0"` and the dependent loaded against it.
   * The registry row here says 3.0.0 on purpose — the loaded version is the one
   * answering calls, so it is the one held to the minimum.
   */
  it('holds a dependency loaded in this boot to minVersion, at the version it loaded', async () => {
    const db = new CannedDb();
    db.when(/from "zv_extension_registry"/i, [{ version: '3.0.0', is_enabled: true }]);
    const result = await checkExtensionDependencies(
      asDb(db),
      [{ name: 'forms', minVersion: '2.0.0' }],
      new Map([['forms', '1.0.0']]),
    );
    expect(result).toEqual({
      satisfied: false,
      missing: ['forms >= 2.0.0 (installed: 1.0.0)'],
      tooOld: ['forms'],
    });
  });

  it('accepts a loaded dependency at or above minVersion without reading the table', async () => {
    const db = new CannedDb();
    db.fail(/from "zv_extension_registry"/i, new Error('must not be read'));
    const result = await checkExtensionDependencies(
      asDb(db),
      [{ name: 'forms', minVersion: '2.0.0' }, { name: 'crm' }],
      new Map<string, string | undefined>([
        ['forms', '2.0.0'],
        ['crm', undefined],
      ]),
    );
    expect(result).toEqual({ satisfied: true, missing: [], tooOld: [] });
  });

  it('refuses a loaded dependency whose version nobody recorded when a minimum is asked', async () => {
    const db = new CannedDb();
    db.when(/from "zv_extension_registry"/i, []);
    const result = await checkExtensionDependencies(
      asDb(db),
      [{ name: 'forms', minVersion: '2.0.0' }],
      new Map([['forms', undefined]]),
    );
    expect(result.missing).toEqual(['forms >= 2.0.0 (installed: unknown)']);
    expect(result.tooOld).toEqual(['forms']);
  });
});
