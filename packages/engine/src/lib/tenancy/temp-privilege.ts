/**
 * Only the engine's own role may create temporary objects in its database.
 *
 * Postgres gives TEMPORARY on a database to PUBLIC, so every restricted role —
 * `zveltio_rls`, `zveltio_ext`, `zveltio_worker`, `zveltio_flow_reader` — could
 * create temp tables and temp functions. pg_temp is searched FIRST for relations
 * unless a function pins it last, and a temp table without ON COMMIT DROP outlives
 * the role window on a pooled connection. So one statement the SQL analyzer let
 * through could leave a `pg_temp."user"` (or a trigger-bearing copy of any engine
 * table) for the next engine query on that connection to read from or write
 * into — as the engine role. The narrow roles exist so an analyzer miss reaches
 * extension data and never the engine's; TEMPORARY was the way around that.
 *
 * The engine itself needs it: migration 001 creates `ON COMMIT DROP` temp tables
 * as the engine role. So it is granted to the connecting role first and only then
 * taken from PUBLIC, in one block — a role that cannot do the first does not do
 * the second.
 *
 * Needs the database owner (scripts/bootstrap-db-role.sh makes the engine role
 * the owner) or a superuser. Where neither holds, GRANT/REVOKE only warn, so the
 * outcome is read back rather than assumed, and the worker bridge discards temp
 * objects before it returns a connection to the pool
 * (`temporaryObjectsRestricted`).
 */

import { sql } from 'kysely';
import type { Database } from '../../db/index.js';

const RESTRICTED_ROLES = ['zveltio_rls', 'zveltio_ext', 'zveltio_worker', 'zveltio_flow_reader'];

let _restricted = false;
let _warned = false;

/** Whether no restricted role may create temporary objects. False until checked. */
export function temporaryObjectsRestricted(): boolean {
  return _restricted;
}

/** Idempotent; runs at every boot so a restored or operator-made database is healed. */
export async function restrictTemporaryObjects(db: Database): Promise<boolean> {
  let reason = '';
  try {
    await sql`
      DO $restrict_temp$
      BEGIN
        EXECUTE format('GRANT TEMPORARY ON DATABASE %I TO %I', current_database(), current_user);
        EXECUTE format('REVOKE TEMPORARY ON DATABASE %I FROM PUBLIC', current_database());
      END
      $restrict_temp$;
    `.execute(db);
  } catch (err) {
    reason = (err as Error).message;
  }
  try {
    const r = await sql<{ rolname: string }>`
      SELECT rolname FROM pg_roles
       WHERE rolname = ANY(${RESTRICTED_ROLES}::text[])
         AND has_database_privilege(oid, current_database(), 'TEMPORARY')
    `.execute(db);
    _restricted = r.rows.length === 0;
    if (!_restricted) reason ||= `still held by ${r.rows.map((x) => x.rolname).join(', ')}`;
  } catch (err) {
    _restricted = false;
    reason ||= (err as Error).message;
  }
  if (!_restricted && !_warned) {
    _warned = true;
    console.warn(
      '[db-roles] restricted roles can still create temporary objects in this database ' +
        `(${reason}). Run as the database owner or a superuser: ` +
        'GRANT TEMPORARY ON DATABASE <db> TO <engine role>; ' +
        'REVOKE TEMPORARY ON DATABASE <db> FROM PUBLIC; (continuing)',
    );
  }
  return _restricted;
}
