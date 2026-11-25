/**
 * Idle stop on a real runner unit (ADR 0062 d3, F17). Plays the engine: loads
 * one signed worker extension through the engine's own `WorkerExtensionHost`
 * over the `runner` transport, with a short idle timeout, and reads the unit's
 * state from systemd at each step. Prints one JSON line:
 *
 *   { afterLoad, call, afterCall, idle, afterIdle, idleCrashes, wake, afterWake,
 *     external, externalCrashes, respawned, coldMs }
 *
 * `after*` are `systemctl is-active` of the extension's unit. Expected: the
 * unit is down after load (its init ran once and ended), up after a call, down
 * again after the idle timeout with no crash counted, up again on the next call;
 * a `systemctl stop` the host did not order is a crash and is respawned. Run by
 * ext-runner-systemd.sh; on its own it proves nothing.
 *
 *   bun scripts/ext-idle-stop-probe.ts <ext dir> <extension name>
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Hono } from 'hono';
import { runnerUnit } from '../src/lib/ext-runner.js';
import { WorkerExtensionHost } from '../src/lib/worker-extension-host.js';
import { signAsOperator } from '../src/testing/operator-signed.js';

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
  out.idle = (await until(() => health().status === 'idle')) ? 'idle' : health().status;
  await until(() => active() !== 'active', 5000);
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
} catch (err) {
  out.error = (err as Error).message;
}
console.log(JSON.stringify(out));
await host.stopAll().catch(() => undefined);
process.exit(0);
