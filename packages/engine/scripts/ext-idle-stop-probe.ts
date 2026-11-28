/**
 * Idle stop on a real runner unit (ADR 0062 d3, F17). Plays the engine: loads
 * one signed worker extension through the engine's own `WorkerExtensionHost`
 * over the `runner` transport, with a short idle timeout, and reads the unit's
 * state from systemd at each step. Prints one JSON line:
 *
 *   { afterLoad, call, afterCall, capAfterBurst, idle, afterIdle, idleCrashes, wake,
 *     afterWake, external, externalCrashes, respawned, coldMs,
 *     spin: { inBurst, afterBurst, cpuMsPerSec, load } }
 *
 * `after*` are `systemctl is-active` of the extension's unit. Expected: the
 * unit is down after load (its init ran once and ended), up after a call, down
 * again after the idle timeout with no crash counted, up again on the next call;
 * a `systemctl stop` the host did not order is a crash and is respawned. The
 * start burst (ADR 0062 step 2b): `START_BURST_MS` after a cold start the unit's
 * cpu.max is the 20% cap again; an extension whose `register()` spins gets the
 * 1 s period, then the cap, then the init timeout's kill. Run by
 * ext-runner-systemd.sh; on its own it proves nothing.
 *
 *   bun scripts/ext-idle-stop-probe.ts <ext dir> <extension name>
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Hono } from 'hono';

// The host pulls the engine in, and with it tsyringe: the polyfill first, as
// `binary-entry.ts` does, and the rest after it (static imports are hoisted).
await import('reflect-metadata');
const { runnerUnit, START_BURST_MS } = await import('../src/lib/ext-runner.js');
const { WorkerExtensionHost } = await import('../src/lib/worker-extension-host.js');
const { signAsOperator } = await import('../src/testing/operator-signed.js');

const [extDir, name] = process.argv.slice(2);
if (!extDir || !name) {
  console.error('usage: ext-idle-stop-probe.ts <ext dir> <extension name>');
  process.exit(2);
}
process.env.ZVELTIO_EXT_TRANSPORT = 'runner';

mkdirSync(join(extDir, 'engine'), { recursive: true });
writeFileSync(
  join(extDir, 'engine', 'index.js'),
  `export default { name: ${JSON.stringify(name)}, routes: { ping: () => new Response('pong') }, async register() {} };\n`,
);
const keyId = await signAsOperator(extDir, name);

const unit = runnerUnit(name);
const active = () =>
  Bun.spawnSync(['systemctl', 'is-active', unit]).stdout.toString().trim() || 'unknown';
// Where a template instance's cgroup lives (the default slice); readable by all.
const cgroupOf = (u: string) =>
  `/sys/fs/cgroup/system.slice/system-zveltio\\x2dext\\x2drunner.slice/${u}`;
const cpuMax = (u: string) => {
  try {
    return readFileSync(`${cgroupOf(u)}/cpu.max`, 'utf8').trim();
  } catch {
    return 'unreadable';
  }
};
const app = new Hono();
const host = new WorkerExtensionHost(app);
const health = () => host.getHealth().find((h) => h.name === name)!;
const until = async (done: () => boolean, ms = 15_000) => {
  for (let t = 0; t < ms && !done(); t += 100) await Bun.sleep(100);
  return done();
};
const call = async () => {
  const t0 = performance.now();
  const r = await app.request(`/ext/${name}/ping`);
  return { status: `${r.status} ${await r.text()}`, ms: Math.round(performance.now() - t0) };
};

const out: Record<string, unknown> = {};
try {
  await host.start(name, extDir, 'engine/index.js', {
    keyId,
    declaredRoutes: [{ method: 'GET', path: '/ping', handler: 'ping' }],
    runtime: { alwaysOn: false, idleTimeoutMs: 2000 },
  });
  out.afterLoad = active();
  const first = await call();
  out.call = first.status;
  out.coldMs = first.ms;
  out.afterCall = active();
  await Bun.sleep(START_BURST_MS + 300);
  out.capAfterBurst = cpuMax(unit);
  out.idle = (await until(() => health().status === 'idle')) ? 'idle' : health().status;
  // `deactivating` is still on its way down: wait for the state the check asserts.
  await until(() => active() === 'inactive', 5000);
  out.afterIdle = active();
  out.idleCrashes = health().recentCrashes;
  out.wake = (await call()).status;
  out.afterWake = active();
  // A stop the host did not order: a crash, respawned.
  Bun.spawnSync(['systemctl', 'stop', '--no-ask-password', unit]);
  out.external = (await until(() => health().recentCrashes > 0)) ? 'crash' : 'none';
  out.externalCrashes = health().recentCrashes;
  out.respawned = (await until(() => health().status === 'running' && active() === 'active'))
    ? active()
    : `${health().status}/${active()}`;

  // A start that spins in init: the burst, then the cap, then the 15 s init kill.
  const spinName = `${name}-spin`;
  const spinDir = `${extDir}-spin`;
  mkdirSync(join(spinDir, 'engine'), { recursive: true });
  writeFileSync(
    join(spinDir, 'engine', 'index.js'),
    `export default { name: ${JSON.stringify(spinName)}, async register() { for (;;) {} } };\n`,
  );
  const spinKey = await signAsOperator(spinDir, spinName);
  const spinUnit = runnerUnit(spinName);
  const load = host
    .start(spinName, spinDir, 'engine/index.js', {
      keyId: spinKey,
      runtime: { alwaysOn: false, idleTimeoutMs: 2000 },
    })
    .then(
      () => 'loaded',
      (err: Error) => err.message,
    );
  const file = (f: string) => `${cgroupOf(spinUnit)}/${f}`;
  for (let t = 0; t < 10_000 && !existsSync(file('cpu.max')); t += 5) await Bun.sleep(5);
  // The burst is sent beside the start, so the cgroup can appear a few ms
  // before it: wait for it, never past the burst's own length.
  for (let t = 0; t < START_BURST_MS && cpuMax(spinUnit) !== '200000 1000000'; t += 5)
    await Bun.sleep(5);
  const spin: Record<string, unknown> = { inBurst: cpuMax(spinUnit) };
  await Bun.sleep(START_BURST_MS + 200);
  spin.afterBurst = cpuMax(spinUnit);
  const usage = () => Number(/usage_usec (\d+)/.exec(readFileSync(file('cpu.stat'), 'utf8'))?.[1]);
  const u0 = usage();
  await Bun.sleep(1000);
  spin.cpuMsPerSec = Math.round((usage() - u0) / 1000);
  spin.load = await load;
  out.spin = spin;
} catch (err) {
  out.error = (err as Error).message;
}
console.log(JSON.stringify(out));
await host.stopAll().catch(() => undefined);
process.exit(0);
