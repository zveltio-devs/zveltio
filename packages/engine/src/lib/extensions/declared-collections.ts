/**
 * ADR 0012: an extension declares its collections as schema files; the engine
 * creates them and owns them.
 *
 * Each name in the manifest's `collections` has `schema/collections/<name>.json`
 * in the package, in the instance's schema-as-code format. They are planned
 * against what the extension owns (`planExtensionSchema`) and applied through
 * the instance's apply, with the extension written as owner at creation. DDL is
 * god's decision, so a load that only a firm's row asks for refuses while the
 * plan has steps, as it refuses pending SQL migrations.
 */

import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { Database } from '../../db/index.js';
import { CollectionSchema } from '../data/index.js';
import { applySchema, planExtensionSchema, SchemaApplyRefused } from '../schema-artifact/apply.js';
import { pendingMigrationsRefusal } from './migration-runner.js';

/** Every `.json` under the package's `schema/`, by path relative to it. */
export async function readSchemaDir(extDir: string): Promise<Map<string, Uint8Array>> {
  const dir = join(extDir, 'schema');
  const out = new Map<string, Uint8Array>();
  if (!existsSync(dir)) return out;
  for (const rel of new Bun.Glob('**/*.json').scanSync({ cwd: dir, onlyFiles: true })) {
    out.set(rel.replace(/\\/g, '/'), await Bun.file(join(dir, rel)).bytes());
  }
  return out;
}

/**
 * `integrity.schemaSha256`, as `zveltio extension pack` writes it (ADR 0012
 * amendment 1 point 4): every `.json` under `schema/`, sorted by path, each
 * path and its bytes — so a changed, added or renamed file, collection or
 * migration alike, is a different digest.
 */
export function schemaDigest(files: Map<string, Uint8Array>): string {
  const h = createHash('sha256');
  for (const path of [...files.keys()].sort()) {
    h.update(path);
    h.update('\0');
    h.update(files.get(path) as Uint8Array);
    h.update('\0');
  }
  return h.digest('hex');
}

/**
 * `{ 'collections/<name>.json': content }` for each declared name; throws on a
 * missing or invalid file, and on files that are not the ones the extension was
 * packed with (`schemaSha256`, the manifest's): those would be DDL nobody signed.
 */
export async function readDeclaredCollections(
  extName: string,
  extDir: string,
  names: string[],
  schemaSha256: string | undefined,
): Promise<Record<string, string>> {
  const files: Record<string, string> = {};
  if (names.length === 0) return files;
  if (!schemaSha256) {
    throw new Error(
      `Extension "${extName}" declares collections but its manifest has no integrity.schemaSha256. ` +
        'Run `zveltio extension pack`.',
    );
  }
  // Hashed and parsed from the same bytes: a file swapped in between is neither.
  const onDisk = await readSchemaDir(extDir);
  const actual = schemaDigest(onDisk);
  if (actual !== schemaSha256) {
    throw new Error(
      `Extension "${extName}" integrity check failed: manifest declares schemaSha256=${schemaSha256} ` +
        `but its schema/ files hash to ${actual}. Re-pack and re-publish, or the files were changed after pack.`,
    );
  }
  for (const name of names) {
    const rel = `schema/collections/${name}.json`;
    const bytes = onDisk.get(`collections/${name}.json`);
    if (!bytes) {
      throw new Error(`Extension "${extName}" declares collection "${name}" but ships no ${rel}`);
    }
    const content = new TextDecoder().decode(bytes);
    let parsed: unknown;
    try {
      parsed = JSON.parse(content);
    } catch (err) {
      throw new Error(`Extension "${extName}": ${rel}: ${(err as Error).message}`);
    }
    // The engine's own collection schema, the one a create runs; the plan
    // below refuses the keys the format does not have and a mismatched name.
    const result = CollectionSchema.safeParse(parsed);
    if (!result.success) {
      const issue = result.error.issues[0];
      throw new Error(
        `Extension "${extName}": ${rel}: ${issue.path.join('.') || 'value'}: ${issue.message}`,
      );
    }
    files[`collections/${name}.json`] = content;
  }
  return files;
}

/**
 * Brings the extension's collections to its files. `migrate` false (a firm's
 * row is all that asks for the load): refuses instead while anything is owed.
 */
export async function applyDeclaredCollections(
  db: Database,
  extName: string,
  files: Record<string, string>,
  migrate: boolean,
): Promise<void> {
  if (!migrate) {
    const steps = await planExtensionSchema(db, extName, files);
    if (steps.length > 0) {
      throw new Error(
        pendingMigrationsRefusal(
          extName,
          steps.map((s) => `${s.change} ${s.target} ${s.action}`),
        ),
      );
    }
    return;
  }
  try {
    await applySchema(db, files, undefined, { owner: extName });
  } catch (err) {
    if (err instanceof SchemaApplyRefused) {
      // ponytail: extension schema/migrations ops (drop, rename, type change) are ADR 0012 slice 2.
      throw new Error(
        `Extension "${extName}": its declared collections cannot be applied: ${err.message}. A drop, rename or ` +
          'type change needs schema migration ops, which extensions cannot ship yet.',
      );
    }
    throw new Error(`Extension "${extName}": declared collections: ${(err as Error).message}`);
  }
}
