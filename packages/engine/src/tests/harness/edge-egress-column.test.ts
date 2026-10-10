/**
 * An edge function's egress is its `egress` column (migration 061), not the
 * `ZVELTIO_EGRESS` env var #1022 read.
 *
 * - 061 moves an existing env value into the column — lower-cased, split as
 *   the engine split it, entries that are not hosts dropped — and takes the key
 *   out of `env_vars`; its DOWN puts it back.
 * - The column's CHECK refuses what the engine would not read as a host, for
 *   every writer, not only the extension's API.
 * - `/api/fn/:name` hands the column to the runner: a function listing one host
 *   is refused another, with the reason naming its list.
 */

import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import type { Hono } from 'hono';
import { sql } from 'kysely';
import type { Database } from '../../db/index.js';
import { parseMigrationFile } from '../../db/migrations/index.js';
import { createGodSession, getTestApp, harnessAvailable } from '../../testing/app-harness.js';

const d = harnessAvailable() ? describe : describe.skip;
const FN = `egress-col-${Date.now()}`;
/** Its env_vars a jsonb STRING holding the object, as Bun.SQL stored `JSON.stringify`. */
const FN_STR = `${FN}-str`;
const CODE = `async function handler() {
  try { await fetch('https://other.test/'); return { status: 200, body: { reached: true } }; }
  catch (e) { return { status: 200, body: { denied: String(e && e.message) } }; }
}`;

d('edge function egress column (061)', () => {
  let app: Hono;
  let db: Database;
  let cookie: string;
  let up = '';
  let down = '';
  const savedTransport = process.env.ZVELTIO_EDGE_TRANSPORT;

  const row = async (name = FN) =>
    (
      await sql<{ egress: string[] | null; env_vars: Record<string, string> }>`
        SELECT egress, env_vars FROM zv_edge_functions WHERE name = ${name}
      `.execute(db)
    ).rows[0]!;

  beforeAll(async () => {
    ({ app, db } = await getTestApp());
    cookie = await createGodSession(app, db);
    const file = Bun.file(
      new URL('../../db/migrations/sql/061_edge_egress_column.sql', import.meta.url),
    );
    ({ up, down } = parseMigrationFile(await file.text()) as { up: string; down: string });
    await sql`
      INSERT INTO zv_edge_functions (name, display_name, code, http_method, path, env_vars)
      VALUES (${FN}, ${FN}, ${CODE}, 'POST', ${`/api/fn/${FN}`},
              ${JSON.stringify({ ZVELTIO_EGRESS: 'API.Allowed.test, b.test:8443 *.bad', KEEP: '1' })}::text::jsonb),
             (${FN_STR}, ${FN_STR}, ${CODE}, 'POST', ${`/api/fn/${FN_STR}`},
              to_jsonb(${JSON.stringify({ ZVELTIO_EGRESS: 'c.test', K: '2' })}::text))
    `.execute(db);
  });

  afterAll(async () => {
    if (savedTransport === undefined) delete process.env.ZVELTIO_EDGE_TRANSPORT;
    else process.env.ZVELTIO_EDGE_TRANSPORT = savedTransport;
    if (db) await sql`DELETE FROM zv_edge_functions WHERE name IN (${FN}, ${FN_STR})`.execute(db);
  });

  it('moves the env value into the column and out of env_vars; DOWN puts it back', async () => {
    await sql.raw(up).execute(db);
    expect(await row()).toEqual({
      egress: ['api.allowed.test', 'b.test:8443'],
      env_vars: { KEEP: '1' },
    });
    expect(await row(FN_STR)).toEqual({ egress: ['c.test'], env_vars: { K: '2' } });

    await sql.raw(down).execute(db);
    const cols = await sql`
      SELECT 1 FROM information_schema.columns
       WHERE table_name = 'zv_edge_functions' AND column_name = 'egress'
    `.execute(db);
    expect(cols.rows).toHaveLength(0);
    const back = await sql<{ env_vars: Record<string, string> }>`
      SELECT env_vars FROM zv_edge_functions WHERE name = ${FN}
    `.execute(db);
    expect(back.rows[0]!.env_vars).toEqual({
      KEEP: '1',
      ZVELTIO_EGRESS: 'api.allowed.test, b.test:8443',
    });

    // Re-runnable: up again leaves the installed shape.
    await sql.raw(up).execute(db);
    await sql.raw(up).execute(db);
    expect(await row()).toEqual({
      egress: ['api.allowed.test', 'b.test:8443'],
      env_vars: { KEEP: '1' },
    });
  });

  it('refuses, for any writer, an entry the engine would not read as a host', async () => {
    for (const bad of [
      `'{https://a.test}'`,
      `'{*.a.test}'`,
      `'{a.test/x}'`,
      `'{A.test}'`,
      `'{""}'`,
      `'{a.test,NULL}'`,
      `'{"a.test b.test"}'`,
      // One entry holding a comma, a nested list, a list not starting at 1: each
      // joins to a string the per-host pattern accepts, and parseEgress refuses
      // the first two while Bun.SQL cannot read the third at all.
      `'{"a.test,b.test"}'`,
      `'{{a.test},{b.test}}'`,
      `'[0:1]={a.test,b.test}'`,
    ]) {
      const err = await sql
        .raw(`UPDATE zv_edge_functions SET egress = ${bad}::text[] WHERE name = '${FN}'`)
        .execute(db)
        .then(
          () => null,
          // Bun.SQL carries the SQLSTATE on `errno`, pg on `code`.
          (e: { code?: string; errno?: string }) => e.errno ?? e.code,
        );
      expect([bad, err]).toEqual([bad, '23514']);
    }
    for (const ok of [`NULL`, `'{}'`, `'{a.test,[2001:db8::1]:8443,b-c.d.test:80}'`]) {
      await sql
        .raw(`UPDATE zv_edge_functions SET egress = ${ok}::text[] WHERE name = '${FN}'`)
        .execute(db);
    }
    await sql`UPDATE zv_edge_functions SET egress = '{api.allowed.test}' WHERE name = ${FN}`.execute(
      db,
    );
  });

  it('/api/fn/:name holds the function to its column', async () => {
    process.env.ZVELTIO_EDGE_TRANSPORT = 'process';
    const res = await app.request(`/api/fn/${FN}`, {
      method: 'POST',
      headers: { cookie, 'content-type': 'application/json' },
      body: '{}',
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      denied: "[egress] other.test is not in this function's egress (api.allowed.test)",
    });
  }, 20_000);
});
