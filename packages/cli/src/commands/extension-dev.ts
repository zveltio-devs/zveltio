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
 *   2. **Studio HMR**: forwards to `bun run dev` inside `studio/` if that
 *      folder exists. The extension's Vite config is responsible for the
 *      browser-side HMR. The CLI just keeps the process running.
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
import { readdirSync } from 'fs';

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
        '\n  Engine returned 404 on /__zveltio_dev_reload. Is NODE_ENV=production? The endpoint is dev-only.',
      ),
    );
    process.exit(1);
  }
  // 400 / 500 for the probe is fine — the endpoint exists and we just sent a fake name.

  // Studio dev (if present and not skipped).
  let studioProc: ReturnType<typeof Bun.spawn> | null = null;
  if (!opts.noStudio && existsSync(join(dir, 'studio'))) {
    studioProc = Bun.spawn(['bun', 'run', 'dev'], {
      cwd: join(dir, 'studio'),
      stdout: 'inherit',
      stderr: 'inherit',
    });
    console.log(`  Studio:     ${c.green('watching (vite dev)')}`);
  } else {
    console.log(
      `  Studio:     ${c.dim(opts.noStudio ? 'skipped (--no-studio)' : 'no studio/ folder — skipped')}`,
    );
  }

  // Engine watch.
  if (!existsSync(engineDir)) {
    console.log(`  Engine src: ${c.yellow('no engine/ folder — engine watch disabled')}`);
  } else {
    const files = collectEngineFiles(engineDir);
    console.log(
      `  Engine src: ${c.green(`watching ${files.length} file(s)`)} ${c.dim(`(.ts / .js / .sql under engine/)`)}`,
    );

    let timer: ReturnType<typeof setTimeout> | null = null;
    let lastTrigger = '';
    const debounceMs = 250;

    const onChange = (filePath: string) => {
      lastTrigger = relative(dir, filePath);
      if (timer) clearTimeout(timer);
      timer = setTimeout(async () => {
        console.log(`\n${c.dim('→')} ${c.cyan(lastTrigger)} ${c.dim('changed — reloading…')}`);
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
