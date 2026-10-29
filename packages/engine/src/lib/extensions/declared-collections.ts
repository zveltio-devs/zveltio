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

import { join } from 'node:path';
import type { Database } from '../../db/index.js';
import { CollectionSchema } from '../data/index.js';
import { applySchema, planExtensionSchema, SchemaApplyRefused } from '../schema-artifact/apply.js';
import { pendingMigrationsRefusal } from './migration-runner.js';

/** `{ 'collections/<name>.json': content }` for each declared name; throws on a missing or invalid file. */
export async function readDeclaredCollections(
  extName: string,
  extDir: string,
  names: string[],
): Promise<Record<string, string>> {
  const files: Record<string, string> = {};
  for (const name of names) {
    const rel = `schema/collections/${name}.json`;
    const file = Bun.file(join(extDir, rel));
    if (!(await file.exists())) {
      throw new Error(`Extension "${extName}" declares collection "${name}" but ships no ${rel}`);
    }
    const content = await file.text();
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
