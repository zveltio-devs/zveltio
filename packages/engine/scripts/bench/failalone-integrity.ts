/** Writes integrity.{schemaSha256,engineSha256} into a manifest (what `extension pack` does). bun failalone-integrity.ts <ext-dir> [worker] */
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { readSchemaDir, schemaDigest } from '../../src/lib/extensions/declared-collections.js';

const [dir, worker] = process.argv.slice(2);
const f = join(dir!, 'manifest.json');
const m = JSON.parse(readFileSync(f, 'utf8'));
m.integrity = {
  schemaSha256: schemaDigest(await readSchemaDir(dir!)),
  engineSha256: createHash('sha256')
    .update(readFileSync(join(dir!, m.engine.entry)))
    .digest('hex'),
};
if (worker) m.engine.isolation = 'worker';
writeFileSync(f, JSON.stringify(m, null, 2));
