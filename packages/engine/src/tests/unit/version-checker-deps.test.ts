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
    expect(result).toEqual({ satisfied: true, missing: [] });
  });

  it('flags an installed version below the required minVersion', async () => {
    const db = new CannedDb();
    db.when(/from "zv_extension_registry"/i, [
      { version: '1.2.0', installed_version: '1.2.0', is_enabled: true },
    ]);
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
    expect(result).toEqual({ satisfied: true, missing: [] });
  });
});
