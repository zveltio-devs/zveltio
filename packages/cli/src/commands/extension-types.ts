/**
 * `zveltio extension types` — generate a `.d.ts` for an extension from the
 * SQL migrations under its `engine/migrations/` folder. Pure offline tool:
 * doesn't talk to the engine.
 *
 * Run from inside the extension's root (where `manifest.json` lives):
 *   $ zveltio extension types
 *
 * Writes `<extension-root>/.zveltio/db.d.ts`. The extension imports the
 * generated `ExtensionSchema` and parameterizes its `ZveltioExtension<DB>`:
 *
 *   import type { ZveltioExtension } from '@zveltio/sdk/extension';
 *   import type { ExtensionSchema as DB } from './.zveltio/db';
 *
 *   const ext: ZveltioExtension<DB> = { ... }
 *
 * (The `ZveltioExtension<DB>` generic propagation itself lands as a small
 * SDK update — for now `ctx.db` stays `any` and the generated types are
 * usable via explicit casts like `ctx.db as Kysely<DB>`.)
 */

import { existsSync, readdirSync, readFileSync, mkdirSync, writeFileSync } from 'fs';
import { join, relative } from 'path';
import { parseSchema, emitTypeScript } from '@zveltio/sdk/codegen';

// ── ANSI helpers ─────────────────────────────────────────────────────────────
const c = {
  bold: (s: string) => `\x1b[1m${s}\x1b[0m`,
  green: (s: string) => `\x1b[32m${s}\x1b[0m`,
  dim: (s: string) => `\x1b[2m${s}\x1b[0m`,
  red: (s: string) => `\x1b[31m${s}\x1b[0m`,
  yellow: (s: string) => `\x1b[33m${s}\x1b[0m`,
};

export interface ExtensionTypesOptions {
  /** Override the extension root. Defaults to `process.cwd()`. */
  dir?: string;
  /** Override the output file. Defaults to `<dir>/.zveltio/db.d.ts`. */
  output?: string;
}

export async function extensionTypesCommand(opts: ExtensionTypesOptions = {}): Promise<void> {
  const dir = opts.dir ?? process.cwd();

  console.log(`\n${c.bold('Extension types')}\n`);
  console.log(`  Extension dir: ${c.dim(dir)}`);

  // Sanity: must look like an extension (manifest + engine/migrations).
  const manifestPath = join(dir, 'manifest.json');
  if (!existsSync(manifestPath)) {
    console.error(c.red(`No manifest.json found in ${dir}`));
    console.error(c.dim('  Run this command from your extension\'s root folder, or pass --dir.'));
    process.exit(1);
  }

  const migrationsDir = join(dir, 'engine', 'migrations');
  if (!existsSync(migrationsDir)) {
    console.error(c.yellow(`No engine/migrations directory found at ${migrationsDir}`));
    console.error(c.dim('  Nothing to generate. Add SQL migrations first.'));
    process.exit(0);
  }

  // Collect .sql files in order.
  const sqlFiles = readdirSync(migrationsDir)
    .filter((f) => f.endsWith('.sql'))
    .sort();

  if (sqlFiles.length === 0) {
    console.error(c.yellow(`No .sql files in ${migrationsDir}`));
    process.exit(0);
  }

  console.log(`  Migrations:    ${c.dim(`${sqlFiles.length} file(s)`)}`);

  const chunks = sqlFiles.map((f) => readFileSync(join(migrationsDir, f), 'utf8'));

  // Parse + emit.
  const schema = parseSchema(chunks);
  if (schema.tables.length === 0) {
    console.log(c.yellow('  No tables parsed. Check that CREATE TABLE statements are well-formed.'));
  } else {
    console.log(`  Tables parsed: ${c.dim(`${schema.tables.length}`)}`);
    for (const t of schema.tables) {
      console.log(`    - ${t.name} (${t.columns.length} cols)`);
    }
  }

  // Read manifest for banner (extension name).
  let extName = '<unknown>';
  try {
    const m = JSON.parse(readFileSync(manifestPath, 'utf8'));
    if (typeof m.name === 'string') extName = m.name;
  } catch { /* non-fatal */ }

  const banner = `Generated from ${extName} migrations: ${sqlFiles.join(', ')}`;
  const tsBody = emitTypeScript(schema, { banner });

  // Write to `.zveltio/db.d.ts` by default.
  const outputPath = opts.output ?? join(dir, '.zveltio', 'db.d.ts');
  mkdirSync(join(outputPath, '..'), { recursive: true });
  writeFileSync(outputPath, tsBody, 'utf8');

  console.log(`\n${c.green('Written:')} ${relative(process.cwd(), outputPath) || outputPath}`);
  console.log(c.dim('  Add `.zveltio/` to your .gitignore. Regenerate with this command after every migration.'));
  console.log('');
}
