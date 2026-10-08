/**
 * Isolation probe for the extension runner (RFC extension-runner, step 3).
 *
 * Plays the engine: starts one extension over the given transport, and the
 * extension tries, in `register()`, to read what an engine holds — its `.env`
 * and its process environment. It reports through `console.log`, which the
 * runtime forwards as `log` frames. Prints one JSON line:
 *   { transport, env: <what it read or the error>, environ: <same> }
 *
 * Run by scripts/ext-runner-isolation.sh inside a container with a real uid
 * boundary; on its own it proves nothing about isolation.
 *
 *   bun scripts/ext-runner-isolation.ts <process|runner> <engine .env path> <extension dir>
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { ensureWorkerRuntimeOnDisk } from '../src/lib/ext-runner.js';
import { connectRunner, spawnProcessRunner } from '../src/lib/worker-extension-transport.js';

const [transport, envPath, extDir] = process.argv.slice(2);
if ((transport !== 'process' && transport !== 'runner') || !envPath || !extDir) {
  console.error('usage: ext-runner-isolation.ts <process|runner> <env path> <extension dir>');
  process.exit(2);
}

mkdirSync(extDir, { recursive: true });
const bundle = join(extDir, 'index.mjs');
writeFileSync(
  bundle,
  `const read = async (p) => { try { return await Bun.file(p).text(); } catch (e) { return 'DENIED ' + e.code; } };
export default {
  name: 'isolation-probe',
  async register() {
    console.log(JSON.stringify({
      env: await read(${JSON.stringify(envPath)}),
      environ: await read('/proc/${process.pid}/environ'),
    }));
  },
};
`,
);

const channel =
  transport === 'runner'
    ? connectRunner()
    : spawnProcessRunner(ensureWorkerRuntimeOnDisk(), { NODE_ENV: 'production' });

const timer = setTimeout(() => {
  console.error('probe: no answer in 15s');
  process.exit(1);
}, 15_000);
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
