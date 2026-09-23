/**
 * Load the engine's migration modules for the CLI's direct-to-database path.
 *
 * `migrate --database-url` and `rollback` import the engine's own runner rather
 * than reimplementing it. They reached it with
 * `new URL('../../../engine/src/db/index.js', import.meta.url)`, which is
 * correct from `src/commands/` and wrong from the bundle: `bun build` emits a
 * single `dist/index.js`, one directory shallower, so the same expression
 * resolved to `<repo>/engine/src/db/index.js` — a path that has never existed.
 * Every `zveltio migrate --database-url` run from the published CLI answered
 *
 *   ❌ Migration failed: Cannot find module '…/zveltio/engine/src/db/index.js'
 *
 * and `rollback`, which had no try/catch around the import, answered with a
 * stack trace.
 *
 * The published package makes it worse than a path bug: `@zveltio/cli` ships
 * `dist` only and does not depend on `@zveltio/engine`, so an npm install has
 * no engine sources to point at under any spelling. Hence both halves here —
 * try the locations that exist in a checkout, and when none does, say what to
 * run instead rather than printing a module path at an operator.
 */

import { existsSync } from 'fs';
import { fileURLToPath } from 'url';

// biome-ignore lint/suspicious/noExplicitAny: the engine's runtime modules are untyped from here
type EngineModules = { db: any; migrations: any };

const CANDIDATES = [
  // src/commands/migrate.ts → packages/engine/…
  '../../../engine/src/db/',
  // dist/index.js → packages/engine/…
  '../../engine/src/db/',
];

export class EngineModulesUnavailable extends Error {
  constructor() {
    super(
      'this CLI cannot reach the engine’s migration runner.\n\n' +
        '   The published @zveltio/cli package does not ship the engine, so the\n' +
        '   direct-to-database path only works from a repository checkout.\n\n' +
        '   Use one of these instead:\n' +
        '     zveltio migrate                     # the release binary, with DATABASE_URL set\n' +
        '     zveltio migrate --url http://host   # against a running engine',
    );
    this.name = 'EngineModulesUnavailable';
  }
}

/** Resolve and import the engine's `db` + `db/migrations` modules. */
export async function loadEngineMigrationModules(): Promise<EngineModules> {
  for (const base of CANDIDATES) {
    const dbUrl = new URL(`${base}index.js`, import.meta.url);
    // The `.js` specifier is what the runtime imports; the file on disk in a
    // checkout is `.ts`, and Bun resolves either — so probe for both.
    const path = fileURLToPath(dbUrl);
    if (!existsSync(path) && !existsSync(path.replace(/\.js$/, '.ts'))) continue;
    const db = await import(dbUrl.href);
    const migrations = await import(new URL(`${base}migrations/index.js`, import.meta.url).href);
    return { db, migrations };
  }
  throw new EngineModulesUnavailable();
}
