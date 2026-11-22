/**
 * isRegistrationEnabled — the self-signup gate (settings.ts). Default MUST be
 * false: Zveltio is app/intranet-first, and the public sign-up middleware fails
 * closed on this. A regression flipping the default to true would silently
 * re-open registration, so it is locked here.
 */

import { afterEach, describe, expect, it } from 'bun:test';
import type { Database } from '../../db/index.js';
import { operationalModeWarnings } from '../../lib/operational-modes.js';
import { isRegistrationEnabled } from '../../routes/settings.js';
import { CannedDb } from './fixtures/canned-db.js';

const saved = process.env.ZVELTIO_REGISTRATION_ENABLED;
afterEach(() => {
  if (saved === undefined) delete process.env.ZVELTIO_REGISTRATION_ENABLED;
  else process.env.ZVELTIO_REGISTRATION_ENABLED = saved;
});

function asDb(db: CannedDb): Database {
  return db.kysely as unknown as Database;
}

describe('isRegistrationEnabled', () => {
  it('defaults to false when the setting is absent', async () => {
    delete process.env.ZVELTIO_REGISTRATION_ENABLED;
    const db = new CannedDb(); // unmatched query → no rows
    expect(await isRegistrationEnabled(asDb(db))).toBe(false);
  });

  it('is true when the DB setting is "true"', async () => {
    delete process.env.ZVELTIO_REGISTRATION_ENABLED;
    const db = new CannedDb();
    db.when(/from "zv_settings"/i, [{ value: 'true' }]);
    expect(await isRegistrationEnabled(asDb(db))).toBe(true);
  });

  it('stays false when the DB setting is "false"', async () => {
    delete process.env.ZVELTIO_REGISTRATION_ENABLED;
    const db = new CannedDb();
    db.when(/from "zv_settings"/i, [{ value: 'false' }]);
    expect(await isRegistrationEnabled(asDb(db))).toBe(false);
  });

  it('env override wins over the DB (on)', async () => {
    process.env.ZVELTIO_REGISTRATION_ENABLED = '1';
    const db = new CannedDb();
    db.when(/from "zv_settings"/i, [{ value: 'false' }]);
    expect(await isRegistrationEnabled(asDb(db))).toBe(true);
  });

  it('env override wins over the DB (off)', async () => {
    process.env.ZVELTIO_REGISTRATION_ENABLED = 'false';
    const db = new CannedDb();
    db.when(/from "zv_settings"/i, [{ value: 'true' }]);
    expect(await isRegistrationEnabled(asDb(db))).toBe(false);
  });

  // The boot warns for every mode that is on (ADR 0058 d4): a value that opens
  // sign-up and earns no warning is a hatch nobody sees. `TRUE` used to.
  it('opens exactly when the boot warns about it', async () => {
    for (const v of ['1', 'true', 'TRUE', 'True', ' 1', 'yes', '0', 'false', ' ']) {
      process.env.ZVELTIO_REGISTRATION_ENABLED = v;
      const warned = operationalModeWarnings().some((l) =>
        l.includes('ZVELTIO_REGISTRATION_ENABLED'),
      );
      const db = new CannedDb();
      db.when(/from "zv_settings"/i, [{ value: 'true' }]);
      expect({ v, open: await isRegistrationEnabled(asDb(db)) }).toEqual({ v, open: warned });
    }
  });
});
