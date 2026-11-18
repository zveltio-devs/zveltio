/**
 * The extension manifest's JSON Schema, shipped in @zveltio/sdk as
 * `@zveltio/sdk/manifest/schema.json` (DR-28), is generated from the engine's
 * own `ManifestSchema` (packages/engine/src/lib/extensions/manifest-schema.ts),
 * so an author's editor checks `manifest.json` against what the engine parses.
 *
 * It describes shapes only: the engine's refinements (cron syntax, egress
 * hosts, capability names, view specs) are checked at load, not here.
 *
 * Run: `bun run scripts/gen-manifest-schema.ts`; `--check` (CI,
 * `check:manifest-schema`) fails when the committed file is stale.
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { ManifestSchema } from '../packages/engine/src/lib/extensions/manifest-schema.ts';

const OUT = join(import.meta.dir, '../packages/sdk/schemas/extension-manifest.schema.json');

const { $schema: _, ...body } = ManifestSchema.toJSONSchema({ io: 'input' });
const schema = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  $id: 'https://zveltio.com/schemas/extension-manifest.schema.json',
  title: 'Zveltio extension manifest',
  description:
    'manifest.json of a Zveltio extension. Generated from the engine ManifestSchema by scripts/gen-manifest-schema.ts; shapes only, the engine checks the rest at load.',
  ...body,
};
const text = `${JSON.stringify(schema, null, 2)}\n`;

if (process.argv.includes('--check')) {
  let current = '';
  try {
    current = readFileSync(OUT, 'utf8');
  } catch {}
  if (current !== text) {
    console.error(
      '[manifest-schema] packages/sdk/schemas/extension-manifest.schema.json is stale: run `bun run scripts/gen-manifest-schema.ts`',
    );
    process.exit(1);
  }
  console.log('[manifest-schema] OK');
} else {
  writeFileSync(OUT, text);
  console.log('[manifest-schema] wrote packages/sdk/schemas/extension-manifest.schema.json');
}
