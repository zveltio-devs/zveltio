/**
 * The boot checks the tenant fallback a new engine connection actually gets,
 * not only what the catalog stores (DR-03, A04 2026-11-20, owner 2026-11-21).
 *
 * `zveltio.fail_closed_tenant` reaches a connection from three places: the
 * database's stored value, the login role's (which wins over the database's),
 * and the client's startup options — `options=-c …` in DATABASE_URL or
 * PGOPTIONS, which no catalog shows. The boot used to read only the catalog, so
 * a startup option opened the fallback on every connection without a word, and
 * a role-level 'on' silently closed what ZVELTIO_FAIL_CLOSED_TENANT=0 asked
 * open. Now any difference warns in development and test and refuses to boot
 * in production.
 *
 * Driven through `createDb`, the engine's own driver config, so it runs on
 * both lanes (Bun.SQL and pg honour the startup options alike).
 */

import { afterEach, describe, expect, it, spyOn } from 'bun:test';
import { sql } from 'kysely';
import { createDb, type Database } from '../../db/index.js';
import { applyFailClosedTenantSetting } from '../../lib/tenancy/fail-closed-tenant.js';
import { harnessAvailable } from '../../testing/app-harness.js';

const d = harnessAvailable() ? describe : describe.skip;
const URL_ = process.env.TEST_DATABASE_URL ?? '';

function withStartupOption(url: string, value: string): string {
  const u = new URL(url);
  u.searchParams.set('options', `-c zveltio.fail_closed_tenant=${value}`);
  return u.toString();
}

const ENV_KEYS = ['ZVELTIO_FAIL_CLOSED_TENANT', 'NODE_ENV'] as const;

d('the tenant fallback a fresh engine connection gets', () => {
  const saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
  const handles: Database[] = [];
  const open = (url: string) => {
    const db = createDb(url);
    handles.push(db);
    return db;
  };

  afterEach(async () => {
    for (const k of ENV_KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
    const admin = open(URL_);
    const name = (await sql<{ d: string }>`SELECT current_database() AS d`.execute(admin)).rows[0]!
      .d;
    await sql.raw(`ALTER DATABASE "${name}" RESET zveltio.fail_closed_tenant`).execute(admin);
    await sql
      .raw(`ALTER ROLE CURRENT_USER IN DATABASE "${name}" RESET zveltio.fail_closed_tenant`)
      .execute(admin);
    for (const h of handles.splice(0)) await h.destroy();
  });

  it('closed asked, options=-c opens it: production refuses to boot', async () => {
    delete process.env.ZVELTIO_FAIL_CLOSED_TENANT;
    process.env.NODE_ENV = 'production';
    const db = open(withStartupOption(URL_, 'off'));
    await expect(applyFailClosedTenantSetting(db)).rejects.toThrow('PGOPTIONS');
  });

  it('closed asked, options=-c opens it: test only warns', async () => {
    delete process.env.ZVELTIO_FAIL_CLOSED_TENANT;
    process.env.NODE_ENV = 'test';
    const db = open(withStartupOption(URL_, 'off'));
    const warn = spyOn(console, 'warn').mockImplementation(() => {});
    try {
      await applyFailClosedTenantSetting(db);
      expect(warn.mock.calls.some((c) => String(c[0]).includes('fail-open'))).toBe(true);
    } finally {
      warn.mockRestore();
    }
  });

  it('=0 asked, a role-level on closes it: production refuses to boot', async () => {
    process.env.ZVELTIO_FAIL_CLOSED_TENANT = '0';
    process.env.NODE_ENV = 'production';
    const admin = open(URL_);
    const name = (await sql<{ d: string }>`SELECT current_database() AS d`.execute(admin)).rows[0]!
      .d;
    // Stored before the handle under test opens, so its connections already see
    // both: the role's 'on' wins over the database's 'off'.
    await sql.raw(`ALTER DATABASE "${name}" SET zveltio.fail_closed_tenant = 'off'`).execute(admin);
    await sql
      .raw(`ALTER ROLE CURRENT_USER IN DATABASE "${name}" SET zveltio.fail_closed_tenant = 'on'`)
      .execute(admin);
    const warn = spyOn(console, 'warn').mockImplementation(() => {});
    try {
      await expect(applyFailClosedTenantSetting(open(URL_))).rejects.toThrow('PGOPTIONS');
    } finally {
      warn.mockRestore();
    }
  });

  it('what is asked is what a connection gets: no warning, no refusal', async () => {
    delete process.env.ZVELTIO_FAIL_CLOSED_TENANT;
    process.env.NODE_ENV = 'production';
    await expect(applyFailClosedTenantSetting(open(URL_))).resolves.toBeUndefined();
  });
});
