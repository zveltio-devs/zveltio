/**
 * `writtenBy: "actions"`: a field, or a whole collection, that an extension
 * declares written only by its own actions and jobs. Their `host.collections`
 * writes carry the extension's name (`WriteRequest.writtenBy`), set by the
 * engine and never read from a request; every other write that sets such a
 * field, and any write on such a collection, is refused. God, admins and API
 * keys included: a wrong value is corrected by the extension's own actions.
 */

import { sql } from 'kysely';
import type { Database } from '../../db/index.js';
import { normalizeFields } from './shape.js';
import type { CollectionDef } from './types.js';

export const WRITTEN_BY_ACTIONS = 'written_by_actions';

/** Does `def` — a stored row or a definition — or one of its fields carry the flag? */
export function hasWrittenBy(of: object | null | undefined): boolean {
  const def = of as CollectionDef | null | undefined;
  return (
    def?.written_by != null ||
    def?.writtenBy !== undefined ||
    normalizeFields(def).some((f) => f.writtenBy !== undefined)
  );
}

/**
 * Why `writer` (the extension whose action or job writes; undefined for any
 * other path) may not write `keys` of `def` — `null` keys: a delete — or null
 * when it may. Fails closed: a flag on a collection no extension owns admits
 * nobody.
 *
 * ponytail: the flags come from DDLManager's metadata cache. An apply's schema
 * event on the realtime bus drops it on every replica; a replica that misses
 * that message keeps the old flags up to the cache's 30 s TTL. Upgrade path:
 * the bus invalidation made durable, not a second mechanism here.
 */
export function writtenByRefusal(
  def: CollectionDef | null | undefined,
  writer: string | undefined,
  keys: Iterable<string> | null,
): string | null {
  if (!def) return null;
  const owner = typeof def.owner_extension === 'string' ? def.owner_extension : null;
  if (writer !== undefined && writer === owner) return null;
  const by = `only by the actions of extension "${owner}"`;
  if (def.written_by != null) return `Collection "${def.name}" is written ${by}.`;
  if (keys === null) return null;
  const flagged = new Set(
    normalizeFields(def)
      .filter((f) => f.writtenBy !== undefined)
      .map((f) => f.name),
  );
  const hit = [...keys].filter((k) => flagged.has(k));
  return hit.length ? `Field ${hit.join(', ')} of "${def.name}" is written ${by}.` : null;
}

/**
 * Why deleting from `collection` is refused because a foreign key would carry
 * it into what only an extension's actions write: `ON DELETE CASCADE` into a
 * flagged collection (its rows go), `SET NULL` / `SET DEFAULT` into a flagged
 * collection or field (a column changes) — through every chain of cascades, and
 * through the m2m junction of a flagged relation field. Null when none is reached.
 * Asked of every delete path: the data API, bulk, sync, an extension's SQL.
 */
export async function cascadeRefusal(
  db: Database,
  collection: string,
  writer: string | undefined,
): Promise<string | null> {
  const { DDLManager } = await import('./ddl-manager.js');
  const seen = new Set([`zvd_${collection}`]);
  let frontier = [...seen];
  // ponytail: decided on the keys, not the rows — a parent such a key points at
  // is refused whether or not a row references it (fail closed; RI ignores the
  // caller's RLS, so a row probe would have to bypass it). One catalog read per
  // cascade level per delete; a per-collection cache if it shows.
  while (frontier.length > 0) {
    const edges = await sql<{ tbl: string; act: string; cols: string | null }>`
      SELECT c.conrelid::regclass::text AS tbl, c.confdeltype::text AS act,
             (SELECT string_agg(a.attname, ',') FROM pg_attribute a
               WHERE a.attrelid = c.conrelid AND a.attnum = ANY(c.conkey)) AS cols
        FROM pg_constraint c
       WHERE c.contype = 'f' AND c.confdeltype IN ('c', 'n', 'd')
         AND c.confrelid = ANY(${frontier}::text[]::regclass[])`.execute(db);
    const next: string[] = [];
    for (const { tbl, act, cols } of edges.rows) {
      const name = tbl.replace(/^public\./, '').replace(/"/g, '');
      if (!name.startsWith('zvd_')) continue;
      // A junction's rows are its relation field's value on the source collection.
      const holders = name.startsWith('zvd_jnc_')
        ? (
            await sql<{ source_collection: string; source_field: string }>`
              SELECT source_collection, source_field FROM zvd_relations
               WHERE junction_table = ${name}`.execute(db)
          ).rows.map((r) => ({ of: r.source_collection, keys: [r.source_field] }))
        : [{ of: name.slice(4), keys: act === 'c' ? null : (cols ?? '').split(',') }];
      for (const { of, keys } of holders) {
        const refused = writtenByRefusal(await DDLManager.getCollection(db, of), writer, keys);
        if (refused) return `Deleting from "${collection}" would reach "${of}": ${refused}`;
      }
      if (act === 'c' && !seen.has(name)) {
        seen.add(name);
        next.push(name);
      }
    }
    frontier = next;
  }
  return null;
}

/** Why a definition that carries the flag is refused where no extension declares it (a 422). */
export const writtenByNeedsOwner = (collection: string) =>
  `${collection}: writtenBy is a setting of a collection an extension declares, in its ` +
  'collection file; an operator neither adds nor removes it.';

/** The 409 a data API write answers when `writtenByRefusal` refuses it. */
export const writtenByBody = (error: string) => ({ error, code: WRITTEN_BY_ACTIONS });
