import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { dirname, join } from 'path';
import { createInterface } from 'readline';

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

type Step = { change: string; target: string; action: string; destructive?: boolean };

/** The schema files under `dir`, as `{ path: content }` — what the engine reads. */
function readSchemaDir(dir: string): Record<string, string> {
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
  return files;
}

/** POSTs the files to `/api/admin/schema/<route>`; exits 1 with the engine's reason on failure. */
async function postSchema(
  engineUrl: string,
  route: 'plan' | 'apply',
  files: Record<string, string>,
): Promise<Step[]> {
  const res = await fetch(`${engineUrl}/api/admin/schema/${route}`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${process.env.ZVELTIO_API_KEY || ''}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ files }),
  });
  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as { detail?: string } | null;
    console.error(`Schema ${route} failed: ${res.status} ${body?.detail ?? res.statusText}`);
    if (res.status === 401 || res.status === 403) {
      console.error('  Set ZVELTIO_API_KEY to a key of an instance admin.');
    }
    process.exit(1);
  }
  return ((await res.json()) as { steps: Step[] }).steps;
}

function printSteps(steps: Step[]) {
  const width = Math.max(...steps.map((s) => s.target.length));
  for (const s of steps) {
    console.log(
      `${s.change} ${s.target.padEnd(width)}  ${s.action}${s.destructive ? '   (destructive)' : ''}`,
    );
  }
  const destructive = steps.filter((s) => s.destructive).length;
  console.log(`\n${steps.length} change(s)` + (destructive ? `, ${destructive} destructive` : ''));
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
  const steps = await postSchema(engineUrl, 'plan', readSchemaDir(dir));
  if (!steps.length) {
    console.log(`No changes: the instance matches ${dir}`);
    return;
  }
  printSteps(steps);
  process.exit(1);
}

/**
 * `zveltio schema apply` — make the instance match the files (RFC step 3).
 * Shows the plan and asks, unless `--yes`. The engine refuses the whole plan
 * when it holds a step apply cannot run yet, so nothing is half-applied.
 */
export async function schemaApplyCommand(opts: { dir?: string; url?: string; yes?: boolean }) {
  const dir = opts.dir || './schema';
  const engineUrl = opts.url || process.env.ZVELTIO_URL || 'http://localhost:3000';
  const files = readSchemaDir(dir);
  const plan = await postSchema(engineUrl, 'plan', files);
  if (!plan.length) {
    console.log(`No changes: the instance matches ${dir}`);
    return;
  }
  printSteps(plan);
  if (!opts.yes) {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    const answer = await new Promise<string>((resolve) =>
      rl.question('\nApply these changes? Type "yes" to continue: ', resolve),
    );
    rl.close();
    if (answer.trim().toLowerCase() !== 'yes') {
      console.log('Cancelled; nothing was changed.');
      return;
    }
  }
  const applied = await postSchema(engineUrl, 'apply', files);
  console.log(`Applied ${applied.length} change(s).`);
}
