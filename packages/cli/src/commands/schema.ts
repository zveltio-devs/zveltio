import { existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from 'fs';
import { dirname, join } from 'path';

/**
 * `zveltio schema pull` — write the live schema to files
 * (docs/engine/rfc-schema-as-code.md, step 1).
 *
 * The engine builds the files, so the CLI and Studio's future dev-mode writer
 * share one serializer. A collection file with no collection behind it any more
 * is removed; migrations are never written here.
 */
export async function schemaPullCommand(opts: { dir?: string; url?: string }) {
  const dir = opts.dir || './schema';
  const engineUrl = opts.url || process.env.ZVELTIO_URL || 'http://localhost:3000';

  const res = await fetch(`${engineUrl}/api/admin/schema/export`, {
    headers: { Authorization: `Bearer ${process.env.ZVELTIO_API_KEY || ''}` },
  });
  if (!res.ok) {
    console.error(`Schema export failed: ${res.status} ${res.statusText}`);
    if (res.status === 401 || res.status === 403) {
      console.error('  Set ZVELTIO_API_KEY to a key of an instance admin.');
    }
    process.exit(1);
  }
  const { files } = (await res.json()) as { files: Record<string, string> };

  for (const [path, content] of Object.entries(files)) {
    const target = join(dir, path);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, content);
  }

  const collectionsDir = join(dir, 'collections');
  let removed = 0;
  if (existsSync(collectionsDir)) {
    for (const f of readdirSync(collectionsDir)) {
      if (f.endsWith('.json') && !(`collections/${f}` in files)) {
        rmSync(join(collectionsDir, f));
        removed++;
      }
    }
  }

  console.log(
    `Wrote ${Object.keys(files).length} files to ${dir}` +
      (removed ? `, removed ${removed} for collections that no longer exist` : ''),
  );
}
