/**
 * Isolation probe for the extension runner (RFC extension-runner, steps 3/3b).
 *
 * Plays the engine: starts one extension over the given transport, and the
 * extension tries, in `register()`, to reach what it must not — the engine's
 * `.env`, the engine's process environment, a network address, and a path
 * outside its own (another extension's runner directory). It reports through
 * `console.log`, which the runtime forwards as `log` frames. Prints one JSON
 * line: { transport, env, environ, fetch, net, write, forks, threads,
 * addressSpace, uid, nice, niceLimit } — each what it got, or `DENIED <code>`. `fetch` is refused
 * by the runtime itself (ADR 0022); `net` opens a raw TCP socket to the same
 * host, which only the OS can stop.
 *
 *   bun scripts/ext-runner-isolation.ts process <env path> <ext dir>
 *   bun scripts/ext-runner-isolation.ts runner  <env path> <ext dir> <socket path>
 *   bun scripts/ext-runner-isolation.ts managed <env path> <ext dir> <extension name>
 *
 * `managed` starts the extension's `zveltio-ext-runner@` unit through systemd,
 * as the engine does. Optional env: PROBE_URL (fetched, and connected to), PROBE_WRITE (a file
 * the extension tries to create), PROBE_UNIX (unix socket paths, `@name` for
 * an abstract one, it tries to connect to), PROBE_TCP (`host:port` pairs, a
 * Postgres among them), PROBE_READ (paths it must not read: another
 * extension's files). `escapes` (ADR 0062 probe "security") holds only
 * `REACHED ...` or `DENIED ...`: native sockets through FFI, a child's raw
 * socket, /etc/shadow, PROBE_TCP and PROBE_READ. A runner reaches none. Run by ext-runner-isolation.sh (container),
 * ext-runner-systemd.sh (real systemd), ext-runner-compose.sh (the release
 * compose) and ext-runner-standalone.sh (one container); on its own it proves
 * nothing.
 */

import { lookup } from 'node:dns/promises';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import {
  closeExtensionsDir,
  ensureWorkerRuntimeOnDisk,
  START_BURST_MS,
  startRunner,
} from '../src/lib/ext-runner.js';
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
// The raw socket's target, resolved here (the engine's side) to an address.
const probeAddr = process.env.PROBE_URL
  ? await (async () => {
      const u = new URL(process.env.PROBE_URL as string);
      const { address } = await lookup(u.hostname);
      return { host: address, port: Number(u.port) || (u.protocol === 'https:' ? 443 : 80) };
    })()
  : null;
writeFileSync(
  bundle,
  `import { connect } from 'node:net';
const denied = (e) => 'DENIED ' + (e.code ?? e.name ?? e.message);
const read = async (p) => { try { return await Bun.file(p).text(); } catch (e) { return denied(e); } };
export default {
  name: 'isolation-probe',
  async register() {
    const url = ${JSON.stringify(process.env.PROBE_URL ?? '')};
    const write = ${JSON.stringify(process.env.PROBE_WRITE ?? '')};
    let fetched = 'skipped', net = 'skipped', wrote = 'skipped';
    if (url) {
      try { fetched = 'HTTP ' + (await fetch(url, { signal: AbortSignal.timeout(3000) })).status; }
      catch (e) { fetched = denied(e); }
      // A raw socket: what hostile code does, past the runtime's fetch refusal.
      // This one measures the OS rule.
      // Resolved on the engine's side: a refusal must come from the network
      // rule, not from a resolver the runner cannot reach.
      net = await new Promise((resolve) => {
        const s = connect(${JSON.stringify(probeAddr)});
        const done = (r) => { s.destroy(); resolve(r); };
        s.setTimeout(3000, () => done('DENIED timeout'));
        s.once('connect', () => done('CONNECTED'));
        s.once('error', (e) => done(denied(e)));
      });
    }
    if (write) {
      try { await Bun.write(write, 'x'); wrote = 'WROTE'; } catch (e) { wrote = denied(e); }
    }
    // Host AF_UNIX sockets ('@name' is abstract): on bare metal AF_UNIX stays
    // open (ADR 0023), so PrivateNetwork and InaccessiblePaths must hide them.
    const unix = {};
    for (const p of ${JSON.stringify((process.env.PROBE_UNIX ?? '').split(/\s+/).filter(Boolean))}) {
      unix[p] = await new Promise((resolve) => {
        const s = connect(p.startsWith('@') ? '\\0' + p.slice(1) : p);
        const done = (r) => { s.destroy(); resolve(r); };
        s.setTimeout(3000, () => done('DENIED timeout'));
        s.once('connect', () => done('CONNECTED'));
        s.once('error', (e) => done(denied(e)));
      });
    }
    // ADR 0062 probe "security": what native code, a child or a plain read reach.
    const escapes = {};
    const reach = (r) => (r === 'CONNECTED' || r.startsWith('READ') ? 'REACHED ' + r : r);
    escapes.shadow = await Bun.file('/etc/shadow').text().then((t) => 'REACHED ' + t.length + 'B', denied);
    for (const p of ${JSON.stringify((process.env.PROBE_READ ?? '').split(/\s+/).filter(Boolean))}) {
      escapes['read ' + p] = await Bun.file(p).text().then((t) => 'REACHED ' + t.length + 'B', denied);
    }
    for (const hp of ${JSON.stringify((process.env.PROBE_TCP ?? '').split(/\s+/).filter(Boolean))}) {
      const [host, port] = hp.split(':');
      escapes['tcp ' + hp] = reach(await new Promise((resolve) => {
        const s = connect({ host, port: Number(port) });
        const done = (r) => { s.destroy(); resolve(r); };
        s.setTimeout(3000, () => done('DENIED timeout'));
        s.once('connect', () => done('CONNECTED'));
        s.once('error', (e) => done(denied(e)));
      }));
    }
    // Native code: socket(2) through libc, past every JS-level refusal.
    try {
      const { dlopen } = await import('bun:ffi');
      let libc, last;
      for (const name of ['libc.musl-x86_64.so.1', 'libc.musl-aarch64.so.1', 'libc.so.6']) {
        try { libc = dlopen(name, { socket: { args: ['i32', 'i32', 'i32'], returns: 'i32' }, close: { args: ['i32'], returns: 'i32' } }); break; } catch (e) { last = e; }
      }
      // No libc loads: native code is refused one step earlier, at dlopen.
      if (!libc) throw Object.assign(new Error('dlopen: ' + last?.message), { code: 'dlopen: ' + last?.message });
      for (const [k, fam] of [['ffi socket AF_INET', 2], ['ffi socket AF_UNIX', 1]]) {
        const fd = libc.symbols.socket(fam, 1, 0);
        escapes[k] = fd >= 0 ? 'REACHED fd ' + fd : 'DENIED ' + fd;
        if (fd >= 0) libc.symbols.close(fd);
      }
    } catch (e) { escapes['ffi'] = denied(e); }
    // A child: does the ban hold for what it starts? (Its stdio is a file:
    // a pipe is a socketpair, which the ban refuses.)
    if (${JSON.stringify(probeAddr)}) {
      const outFile = '/tmp/zveltio-probe-child-' + Math.random().toString(36).slice(2);
      const code = 'const s=require("node:net").connect(' + JSON.stringify(${JSON.stringify(probeAddr)}) + ');' +
        'const w=(r)=>{require("node:fs").writeFileSync(' + JSON.stringify(outFile) + ',r);process.exit(0)};' +
        's.setTimeout(3000,()=>w("DENIED timeout"));s.on("connect",()=>w("CONNECTED"));s.on("error",(e)=>w("DENIED "+e.code))';
      try {
        const r = Bun.spawnSync([process.execPath, '-e', code], { env: { ...process.env, BUN_BE_BUN: '1' }, stdin: 'ignore', stdout: 'ignore', stderr: 'ignore' });
        escapes['child net'] = reach(await Bun.file(outFile).text().catch(() => 'DENIED child exit ' + r.exitCode));
      } catch (e) { escapes['child net'] = denied(e); }
    }
    let forks = 'skipped';
    if (${JSON.stringify(process.env.PROBE_FORKS ?? '')}) {
      // A shell's fork loop: Bun.spawn past the limit hangs instead of throwing.
      // Counted in a file: piped stdio is a socketpair, which the socket ban
      // refuses (ADR 0023).
      const count = '/tmp/zveltio-probe-forks-' + Math.random().toString(36).slice(2);
      Bun.spawnSync(['sh', '-c', 'n=0; while [ $n -lt 200 ]; do sleep 3 & n=$((n+1)); echo $n > ' + count + '; done'],
        { stdin: 'ignore', stdout: 'ignore', stderr: 'ignore' });
      forks = Number((await read(count)).trim() || 0);
    }
    if (${JSON.stringify(process.env.PROBE_ALLOC ?? '')}) {
      const hog = [];
      for (;;) hog.push(new Uint8Array(8 << 20).fill(1));
    }
    console.log(JSON.stringify({
      env: await read(${JSON.stringify(envPath)}),
      environ: await read('/proc/${process.pid}/environ'),
      fetch: fetched,
      net,
      write: wrote,
      unix,
      escapes,
      forks,
      addressSpace: (await read('/proc/self/limits')).match(/Max address space\\s+(\\S+)/)?.[1],
      threads: Number.parseInt((await read('/proc/self/status')).split('Threads:')[1] ?? ''),
      // process.getuid is not there inside the runtime; the kernel says.
      uid: Number.parseInt((await read('/proc/self/status')).split('Uid:')[1] ?? ''),
      // Field 19 of stat, after the parenthesised name (ADR 0062 F20).
      nice: Number((await read('/proc/self/stat')).split(') ')[1]?.split(' ')[16]),
      niceLimit: (await read('/proc/self/limits')).match(/Max nice priority\\s+(\\S+)/)?.[1],
    }));
  },
};
`,
);

// As the engine does before every spawn on the runner (ADR 0062, F15). Not a
// scratch directory under /tmp (the foreign-uid probe's), which is no
// extensions' directory, and not fatal: the read probe shows what it left open.
if (transport !== 'process' && dirname(extDir) !== tmpdir()) {
  try {
    closeExtensionsDir(dirname(extDir));
  } catch (e) {
    console.error(`probe: ${(e as Error).message}`);
  }
}

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
    // As an engine that lives on: the unit's start burst ends (ADR 0062 step 2b).
    const code = msg.type === 'init:ok' ? 0 : 1;
    if (transport === 'managed') setTimeout(() => process.exit(code), START_BURST_MS + 100);
    else process.exit(code);
  }
};
channel.postMessage({
  type: 'init',
  id: 'init-1',
  // The bytes, as the engine sends them: the process reads no extension file.
  bundle: readFileSync(bundle),
  // The runtime imports only bytes that hash to what the signature lists.
  bundleSha256: new Bun.CryptoHasher('sha256').update(readFileSync(bundle)).digest('hex'),
  extName: 'isolation-probe',
  env: { NODE_ENV: 'production' },
});
