/**
 * Which IANA time zone "today" means for a tenant: the tenant's own
 * (`zv_tenants.settings.timezone`), else the instance's public `timezone`
 * setting, else UTC. A firm in Bucharest and one in Lisbon on the same instance
 * close their day at different hours; an invoice paid at 00:30 local time was
 * dated yesterday when every "today" was the UTC date.
 *
 * A stored value that is not a zone this runtime knows is skipped, not thrown:
 * a typo in a setting must not fail every write that asks for a date.
 */

import { sql } from 'kysely';
import type { Database } from '../../db/index.js';

export function isTimeZone(tz: unknown): tz is string {
  if (typeof tz !== 'string' || tz === '' || tz.length > 64) return false;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

/** One query: the tenant's zone and the instance's, resolved in that order. */
export async function effectiveTimeZone(db: Database, tenantId: string | null): Promise<string> {
  const r = await sql<{ tenant: string | null; instance: string | null }>`
    SELECT
      (SELECT settings->>'timezone' FROM zv_tenants WHERE id = ${tenantId}::uuid) AS tenant,
      (SELECT value #>> '{}' FROM zv_settings WHERE key = 'timezone' AND is_public = true) AS instance
  `.execute(db);
  const row = r.rows[0];
  if (isTimeZone(row?.tenant)) return row.tenant;
  if (isTimeZone(row?.instance)) return row.instance;
  return 'UTC';
}
