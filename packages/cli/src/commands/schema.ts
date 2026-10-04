import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'fs';
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

/**
 * `zveltio schema diff` — print what `apply` would change to make the instance
 * match the files (RFC step 2). The engine computes the plan; this only ships
 * the files and renders the answer. Exits 1 when there is drift, so CI can
 * fail on it.
 */
export async function schemaDiffCommand(opts: { dir?: string; url?: string }) {
  const dir = opts.dir || './schema';
  const engineUrl = opts.url || process.env.ZVELTIO_URL || 'http://localhost:3000';

  const files: Record<string, string> = {};
  for (const path of ['zveltio-schema.json', 'roles.json']) {
    if (existsSync(join(dir, path))) files[path] = readFileSync(join(dir, path), 'utf8');
  }
  const collectionsDir = join(dir, 'collections');
  if (existsSync(collectionsDir)) {
    for (const f of readdirSync(collectionsDir).filter((f) => f.endsWith('.json'))) {
      files[`collections/${f}`] = readFileSync(join(collectionsDir, f), 'utf8');
    }
  }

  const res = await fetch(`${engineUrl}/api/admin/schema/plan`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${process.env.ZVELTIO_API_KEY || ''}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ files }),
  });
  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as { detail?: string } | null;
    console.error(`Schema plan failed: ${res.status} ${body?.detail ?? res.statusText}`);
    if (res.status === 401 || res.status === 403) {
      console.error('  Set ZVELTIO_API_KEY to a key of an instance admin.');
    }
    process.exit(1);
  }
  const { steps } = (await res.json()) as {
    steps: { change: string; target: string; action: string; destructive?: boolean }[];
  };

  if (!steps.length) {
    console.log(`No changes: the instance matches ${dir}`);
    return;
  }
  const width = Math.max(...steps.map((s) => s.target.length));
  for (const s of steps) {
    console.log(
      `${s.change} ${s.target.padEnd(width)}  ${s.action}${s.destructive ? '   (destructive)' : ''}`,
    );
  }
  const destructive = steps.filter((s) => s.destructive).length;
  console.log(`\n${steps.length} change(s)` + (destructive ? `, ${destructive} destructive` : ''));
  process.exit(1);
}
