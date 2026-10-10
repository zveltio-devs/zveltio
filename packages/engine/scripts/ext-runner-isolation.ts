/**
 * Isolation probe for the extension runner (RFC extension-runner, steps 3/3b).
 *
 * Plays the engine: starts one extension over the given transport, and the
 * extension tries, in `register()`, to reach what it must not — the engine's
 * `.env`, the engine's process environment, a network address, and a path
 * outside its own (another extension's runner directory). It reports through
 * `console.log`, which the runtime forwards as `log` frames. Prints one JSON
 * line: { transport, env, environ, fetch, write, uid } — each what it got, or
 * `DENIED <code>`.
 *
 *   bun scripts/ext-runner-isolation.ts process <env path> <ext dir>
 *   bun scripts/ext-runner-isolation.ts runner  <env path> <ext dir> <socket path>
 *   bun scripts/ext-runner-isolation.ts managed <env path> <ext dir> <extension name>
 *
 * `managed` starts the extension's `zveltio-ext-runner@` unit through systemd,
 * as the engine does. Optional env: PROBE_URL (fetched), PROBE_WRITE (a file
 * the extension tries to create). Run by ext-runner-isolation.sh (container),
 * ext-runner-systemd.sh (real systemd) and ext-runner-compose.sh (the release
 * compose); on its own it proves nothing.
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { ensureWorkerRuntimeOnDisk, startRunner } from '../src/lib/ext-runner.js';
import { connectRunner, spawnProcessRunner } from '../src/lib/worker-extension-transport.js';

const [transport, envPath, extDir, target] = process.argv.slice(2);
if (
  !['process', 'runner', 'managed'].includes(transport ?? '') ||
  !envPath ||
  !extDir ||
  (transport !== 'process' && !target)
) {
  console.error('usage: ext-runner-isolation.ts <process|runner|managed> <env> <ext dir> [target]');
  process.exit(2);
}

mkdirSync(extDir, { recursive: true });
const bundle = join(extDir, 'index.mjs');
writeFileSync(
  bundle,
  `const denied = (e) => 'DENIED ' + (e.code ?? e.name ?? e.message);
const read = async (p) => { try { return await Bun.file(p).text(); } catch (e) { return denied(e); } };
export default {
  name: 'isolation-probe',
  async register() {
    const url = ${JSON.stringify(process.env.PROBE_URL ?? '')};
    const write = ${JSON.stringify(process.env.PROBE_WRITE ?? '')};
    let fetched = 'skipped', wrote = 'skipped';
    if (url) {
      try { fetched = 'HTTP ' + (await fetch(url, { signal: AbortSignal.timeout(3000) })).status; }
      catch (e) { fetched = denied(e); }
    }
    if (write) {
      try { await Bun.write(write, 'x'); wrote = 'WROTE'; } catch (e) { wrote = denied(e); }
    }
    console.log(JSON.stringify({
      env: await read(${JSON.stringify(envPath)}),
      environ: await read('/proc/${process.pid}/environ'),
      fetch: fetched,
      write: wrote,
      // process.getuid is not there inside the runtime; the kernel says.
      uid: Number.parseInt((await read('/proc/self/status')).split('Uid:')[1] ?? ''),
    }));
  },
};
`,
);

const channel =
  transport === 'process'
    ? spawnProcessRunner(ensureWorkerRuntimeOnDisk(), { NODE_ENV: 'production' })
    : connectRunner(transport === 'runner' ? target! : await startRunner(target!));

const timer = setTimeout(() => {
  console.error('probe: no answer in 20s');
  process.exit(1);
}, 20_000);
channel.onerror = (e) => {
  console.error(`probe: channel ended: ${e.message}`);
  process.exit(1);
};
channel.onmessage = (e) => {
  const msg = e.data as { type: string; message?: string; error?: string };
  if (msg.type === 'log' && msg.message?.startsWith('{')) {
    console.log(JSON.stringify({ transport, ...JSON.parse(msg.message) }));
  } else if (msg.type === 'init:ok' || msg.type === 'init:err') {
    clearTimeout(timer);
    if (msg.error) console.error(`probe: ${msg.error}`);
    channel.onerror = null;
    channel.terminate();
    process.exit(msg.type === 'init:ok' ? 0 : 1);
  }
};
channel.postMessage({
  type: 'init',
  id: 'init-1',
  bundleUrl: pathToFileURL(bundle).href,
  extName: 'isolation-probe',
  env: { NODE_ENV: 'production', extensionPath: extDir },
});
