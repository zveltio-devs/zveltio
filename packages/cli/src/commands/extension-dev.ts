/**
 * `zveltio extension dev` — engine watch + Studio HMR for an extension
 * under development (S4-03).
 *
 * Two concurrent pieces:
 *
 *   1. **Engine watch**: walks `engine/` for `.ts/.js` files, watches them
 *      via Node's `fs.watch`. On change, debounce 250ms, then POST
 *      `{ name }` to `<engine>/__zveltio_dev_reload`. The engine drops the
 *      cached module + scoped state and rebuilds its Hono app — the next
 *      request hits the new code without restarting the engine process.
 *
 *   2. **Studio**: tier-3 pages and slot contributions are compile-time copies
 *      into the monorepo Studio (`sync-extensions.ts`), not a per-extension
 *      Vite bundle. If `studio/package.json` exists (legacy scaffold only),
 *      forwards to `bun run dev` there; otherwise prints how to preview via
 *      `packages/studio` dev + sync.
 *
 * Designed for the local-development loop: an extension author edits a
 * route handler, sees the change live within ~1s, no engine restart.
 *
 * Constraints (deliberate):
 *   - Engine must already be running (we don't start it; we attach).
 *   - The extension must already be installed + active in the running
 *     engine — reload re-imports the source, it doesn't enable from
 *     scratch.
 *   - Migration changes still require a manual reinstall — this only
 *     re-imports `engine/index.ts`.
 */

import { existsSync, statSync } from 'fs';
import { watch as fsWatch } from 'fs';
import { join, basename, resolve, relative } from 'path';
import { readdirSync, readFileSync } from 'fs';
import { DIR_SIGNATURE_FILE } from './extension-sign.js';
import { bundleSourceFiles } from '../lib/bundle-sources.js';

const c = {
  bold: (s: string) => `\x1b[1m${s}\x1b[0m`,
  green: (s: string) => `\x1b[32m${s}\x1b[0m`,
  red: (s: string) => `\x1b[31m${s}\x1b[0m`,
  yellow: (s: string) => `\x1b[33m${s}\x1b[0m`,
  dim: (s: string) => `\x1b[2m${s}\x1b[0m`,
  cyan: (s: string) => `\x1b[36m${s}\x1b[0m`,
};

export interface ExtensionDevOptions {
  /** Extension root. Defaults to cwd. */
  dir?: string;
  /** Engine URL. Default: http://localhost:3000. */
  url?: string;
  /**
   * Extension `name` to reload. Default: read from manifest.json's `name`.
   * Required when the manifest can't be read (rare).
   */
  name?: string;
  /** Skip the studio dev process (engine watch only). */
  noStudio?: boolean;
}

interface Manifest {
  name: string;
  [k: string]: unknown;
}

function readManifestName(dir: string, override?: string): string {
  if (override) return override;
  const manifestPath = join(dir, 'manifest.json');
  if (!existsSync(manifestPath)) {
    throw new Error(
      `No manifest.json at ${manifestPath}. Pass --name or run from the extension's root.`,
    );
  }
  // biome-ignore lint/suspicious/noExplicitAny: legacy any; tracked in hardening plan item H-01
  const Bun_ = (globalThis as any).Bun;
  // Synchronous read for startup simplicity.
  const raw = require('fs').readFileSync(manifestPath, 'utf8') as string;
  let m: Manifest;
  try {
    m = JSON.parse(raw) as Manifest;
  } catch (e) {
    throw new Error(`manifest.json is not valid JSON: ${(e as Error).message}`);
  }
  if (typeof m.name !== 'string') throw new Error('manifest.json missing string `name`');
  return m.name;
}

/**
 * The CLI runs a signed directory needs before a reload: the engine verifies
 * `signature.json` at every load, so an edit is refused until the bundle is
 * packed and signed again with the same key. Null when the directory is not
 * operator-signed (nothing to redo).
 */
export function resignSteps(dir: string): string[][] | null {
  const file = join(dir, DIR_SIGNATURE_FILE);
  if (!existsSync(file)) return null;
  const keyId = (JSON.parse(readFileSync(file, 'utf8')) as { keyId?: unknown }).keyId;
  if (typeof keyId !== 'string' || keyId === '') {
    throw new Error(`${file} names no keyId; sign it once by hand: zveltio extension sign`);
  }
  return [
    ['extension', 'pack', '--dir', dir],
    ['extension', 'sign', '--dir', dir, '--key-id', keyId],
  ];
}

/** Run each step as this same CLI; false (output already printed) at the first failure. */
async function runSteps(steps: string[][]): Promise<boolean> {
  for (const args of steps) {
    const proc = Bun.spawn([process.execPath, process.argv[1]!, ...args], {
      stdout: 'ignore',
      stderr: 'inherit',
    });
    if ((await proc.exited) !== 0) {
      console.log(
        `  ${c.red('✗')} \`zveltio ${args.slice(0, 2).join(' ')}\` failed — not reloaded`,
      );
      return false;
    }
  }
  return true;
}

/** Walk `engine/` once and return all `.ts/.js` files to watch. */
function collectEngineFiles(engineDir: string): string[] {
  if (!existsSync(engineDir)) return [];
  const out: string[] = [];
  const stack: string[] = [engineDir];
  while (stack.length > 0) {
    const dir = stack.pop()!;
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      continue;
    }
    for (const name of entries) {
      if (name === 'node_modules' || name === 'dist' || name.startsWith('.')) continue;
      const full = join(dir, name);
      let st;
      try {
        st = statSync(full);
      } catch {
        continue;
      }
      if (st.isDirectory()) {
        stack.push(full);
      } else if (
        st.isFile() &&
        (name.endsWith('.ts') || name.endsWith('.js') || name.endsWith('.sql'))
      ) {
        out.push(full);
      }
    }
  }
  return out;
}

async function postReload(
  url: string,
  name: string,
  // biome-ignore lint/suspicious/noExplicitAny: legacy any; tracked in hardening plan item H-01
): Promise<{ ok: boolean; status: number; body: any }> {
  const endpoint = `${url.replace(/\/$/, '')}/__zveltio_dev_reload`;
  let res: Response;
  try {
    res = await fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name }),
    });
  } catch (e) {
    return { ok: false, status: 0, body: { error: (e as Error).message } };
  }
  const body = await res.json().catch(() => ({}));
  return { ok: res.ok, status: res.status, body };
}

export async function extensionDevCommand(opts: ExtensionDevOptions = {}): Promise<void> {
  const dir = resolve(opts.dir ?? process.cwd());
  const url = (opts.url ?? process.env.ZVELTIO_ENGINE_URL ?? 'http://localhost:3000').replace(
    /\/$/,
    '',
  );
  const engineDir = join(dir, 'engine');

  let extName: string;
  try {
    extName = readManifestName(dir, opts.name);
  } catch (e) {
    console.error(c.red((e as Error).message));
    process.exit(1);
  }

  console.log(`\n${c.bold('Extension dev')}\n`);
  console.log(`  Extension:  ${c.cyan(extName)}`);
  console.log(`  Folder:     ${c.dim(dir)}`);
  console.log(`  Engine:     ${c.dim(url)}`);

  // Probe the engine reload endpoint once so the user gets immediate
  // feedback if the engine isn't running (or is in production mode and the
  // endpoint is gated off).
  const probe = await postReload(url, '__probe__');
  if (probe.status === 0) {
    console.error(
      c.red(
        `\n  Cannot reach engine at ${url}. Start it with \`bun run dev\` in the engine package first.`,
      ),
    );
    process.exit(1);
  }
  if (probe.status === 404) {
    console.error(
      c.red(
        '\n  Engine returned 404 on /__zveltio_dev_reload: the endpoint is mounted only under NODE_ENV=development or test (unset is production). Restart the engine with NODE_ENV=development.',
      ),
    );
    process.exit(1);
  }
  // 400 / 500 for the probe is fine — the endpoint exists and we just sent a fake name.

  // Legacy per-extension Studio vite (v1 scaffold only). v2 extensions use
  // compile-time sync into packages/studio — no studio/package.json.
  let studioProc: ReturnType<typeof Bun.spawn> | null = null;
  const studioPkg = join(dir, 'studio', 'package.json');
  if (!opts.noStudio && existsSync(studioPkg)) {
    studioProc = Bun.spawn(['bun', 'run', 'dev'], {
      cwd: join(dir, 'studio'),
      stdout: 'inherit',
      stderr: 'inherit',
    });
    console.log(`  Studio:     ${c.green('watching (legacy studio/package.json vite dev)')}`);
  } else if (!opts.noStudio && existsSync(join(dir, 'studio'))) {
    console.log(
      `  Studio:     ${c.dim('tier-3 pages — run packages/studio dev after sync-extensions (see dev guide §2)')}`,
    );
  } else {
    console.log(
      `  Studio:     ${c.dim(opts.noStudio ? 'skipped (--no-studio)' : 'no studio/ folder — skipped')}`,
    );
  }

  // Engine watch.
  if (!existsSync(engineDir)) {
    console.log(`  Engine src: ${c.yellow('no engine/ folder — engine watch disabled')}`);
  } else {
    // Plus what the bundle imports from outside engine/ (`../client/icons.ts`):
    // the same files `extension pack` hashes as the bundle's source.
    const files = [...new Set([...collectEngineFiles(engineDir), ...bundleSourceFiles(dir)])];
    console.log(
      `  Engine src: ${c.green(`watching ${files.length} file(s)`)} ${c.dim(`(.ts / .js / .sql under engine/, and what the bundle imports)`)}`,
    );

    let timer: ReturnType<typeof setTimeout> | null = null;
    let lastTrigger = '';
    const debounceMs = 250;

    // `pack` writes engine/index.js: a change there is our own output, not an edit.
    const bundleOut = join(engineDir, 'index.js');
    const onChange = (filePath: string) => {
      if (filePath === bundleOut && existsSync(join(dir, DIR_SIGNATURE_FILE))) return;
      lastTrigger = relative(dir, filePath);
      if (timer) clearTimeout(timer);
      timer = setTimeout(async () => {
        console.log(`\n${c.dim('→')} ${c.cyan(lastTrigger)} ${c.dim('changed — reloading…')}`);
        let steps: string[][] | null;
        try {
          steps = resignSteps(dir);
        } catch (e) {
          console.log(`  ${c.red('✗')} ${(e as Error).message}`);
          return;
        }
        if (steps) {
          console.log(`  ${c.dim('signed directory — packing and signing again…')}`);
          if (!(await runSteps(steps))) return;
        }
        const result = await postReload(url, extName);
        if (result.ok) {
          console.log(`  ${c.green('✓')} engine reloaded ${c.dim(`(${result.status})`)}`);
        } else {
          console.log(`  ${c.red('✗')} reload failed ${c.dim(`(HTTP ${result.status})`)}`);
          if (result.body?.error) console.log(`  ${c.red(result.body.error)}`);
        }
      }, debounceMs);
    };

    // Watch each file individually. fs.watch on a directory is recursive on
    // some platforms but not others (Linux without { recursive: true } only
    // watches top-level entries). Per-file watch is portable.
    const watchers = files.map((f) => fsWatch(f, () => onChange(f)));

    // SIGINT handling.
    const cleanup = () => {
      console.log(`\n\n${c.dim('Stopping watchers…')}`);
      for (const w of watchers) {
        try {
          w.close();
        } catch {
          /* */
        }
      }
      if (studioProc && !studioProc.killed) studioProc.kill();
      process.exit(0);
    };
    process.on('SIGINT', cleanup);
    process.on('SIGTERM', cleanup);
  }

  console.log(`\n${c.dim('Ready. Edit engine/ files to trigger a hot-reload. Ctrl+C to stop.\n')}`);

  // Block forever (or until studio exits or SIGINT).
  if (studioProc) {
    await studioProc.exited;
  } else {
    // Idle wait — keep the process alive until SIGINT.
    await new Promise<void>(() => {
      /* never resolves */
    });
  }
}
