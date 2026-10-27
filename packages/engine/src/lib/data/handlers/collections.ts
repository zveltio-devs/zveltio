import type { Context } from 'hono';
import type { Database } from '../../../db/index.js';
import { DDLManager } from '../ddl-manager.js';
import { readScope } from '../read-scope.js';
import { getDb } from '../write-pipeline.js';
import { checkAccess } from '../auth.js';
import type { CollectionField } from '../types.js';

/**
 * `GET /api/data` — the collections this caller may read, each with the fields
 * it may see. What an app needs to draw its navigation and a generic list or
 * form for any collection, without the Console's `/api/collections`, which is
 * instance-admin only and serves the whole schema.
 *
 * Every answer comes from the gates `GET /api/data/:collection` itself runs:
 * `checkAccess(…, 'read')` for the collection and `readScope` for the columns.
 * A field the caller cannot read is absent here as it is absent from a record,
 * so the schema never names what the data hides. A field they can read but not
 * write is marked `readonly`.
 *
 * Only display metadata is copied out; collection internals (`virtual_config`
 * with its upstream credential, routing, AI settings) never are.
 */
export async function listReadableCollections(c: Context, db: Database): Promise<Response> {
  const user = c.get('user');
  const conn = getDb(c, db);
  const out = [];
  for (const def of await DDLManager.getCollections(conn)) {
    if (!(await checkAccess(conn, user, def.name, 'read'))) continue;
    const scope = await readScope(conn, def.name, user, c.get('authType'));
    const fields = (def.fields as CollectionField[])
      .filter((f) => scope.readable(f.name))
      .map((f) => ({
        name: f.name,
        type: f.type,
        label: f.label ?? null,
        description: f.description ?? null,
        required: f.required === true,
        options: f.options ?? null,
        ...(scope.columns.readOnly.has(f.name) ? { readonly: true } : {}),
      }));
    out.push({
      name: def.name,
      display_name: def.display_name ?? null,
      singular_name: def.singular_name ?? null,
      icon: def.icon ?? null,
      fields,
    });
  }
  return c.json({ collections: out });
}
