/**
 * The edge sandbox locks the GLOBAL OBJECT, not a list of names for it.
 *
 * Regression: the bootstrap hid the global object by shadowing `globalThis` and
 * `self` as parameters of the user function, and left the real `fetch` on the
 * object. Every other route to the object reached it: `global.fetch` read
 * `file:///etc/hostname` and connected to 127.0.0.1 while the sandboxed `fetch`
 * refused both, and so did the `target` of an event dispatched on the global (a
 * proxy that is not even `=== global`, so no name list can catch it).
 * `new ShadowRealm()` was worse: a fresh realm with its own `fetch`, `Bun` and
 * `process`.
 *
 * The probes below try every route this file knows, and then walk every own
 * property of the global object one level deep, so a route added by a future
 * Bun is exercised by behaviour rather than by name. Flow `run_script` steps
 * run on this same runner, so this covers them too.
 */

import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { rmSync } from 'node:fs';
import type { EdgeRequest } from '../../lib/edge-function-runner.js';
import {
  drainRunnerPool,
  runEdgeFunctionInSubprocess,
} from '../../lib/edge-functions/subprocess-runner.js';
import { runScript } from '../../lib/script-runner.js';

const REQ: EdgeRequest = { method: 'GET', headers: {}, query: {}, body: null, path: '/' };
const MARKER = `zv-escape-${crypto.randomUUID()}`;
const SECRET = join(tmpdir(), `${MARKER}.txt`);

let hits = 0;
let server: ReturnType<typeof Bun.serve>;

beforeAll(async () => {
  await Bun.write(SECRET, MARKER);
  server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    fetch() {
      hits++;
      return new Response('loopback');
    },
  });
});

afterAll(async () => {
  server.stop(true);
  rmSync(SECRET, { force: true });
  await drainRunnerPool();
});

/** The probe body. Returns { route: outcome }; `leak:` marks a route that worked. */
function probe(fileUrl: string, loopUrl: string): string {
  return `
  const out = {};
  const FILE = ${JSON.stringify(fileUrl)}, LOOP = ${JSON.stringify(loopUrl)};
  const tryFetch = async (route, f) => {
    if (typeof f !== 'function') return;
    for (const url of [FILE, LOOP]) {
      try { out[route + ' ' + url.slice(0, 4)] = 'leak: ' + (await (await f(url)).text()); }
      catch (e) { out[route + ' ' + url.slice(0, 4)] = 'refused: ' + e.message; }
    }
  };
  const tryCap = (route, read) => {
    try { const v = read(); if (v !== undefined) out[route] = 'leak: ' + typeof v; }
    catch (e) { /* blocked */ }
  };

  let viaEvent;
  try {
    addEventListener('zv', (e) => { viaEvent = e.target; });
    dispatchEvent(new Event('zv'));
  } catch (e) {}

  const roots = { eventTarget: viaEvent };
  const reach = { global: () => global, globalThis: () => globalThis, self: () => self, window: () => window };
  for (const [name, get] of Object.entries(reach)) {
    try { const v = get(); if (v) roots[name] = v; else out['root ' + name] = 'absent'; }
    catch (e) { out['root ' + name] = 'refused: ' + e.message; }
  }
  // The EventTarget methods called with no receiver: a runtime that defaulted
  // 'this' to the global object would hand it over as event.target.
  try {
    let t;
    EventTarget.prototype.addEventListener.call(undefined, 'zv2', (e) => { t = e.target; });
    EventTarget.prototype.dispatchEvent.call(undefined, new Event('zv2'));
    if (t) roots.unbound = t; else out['root unbound'] = 'absent';
  } catch (e) { out['root unbound'] = 'refused: ' + e.message; }
  for (const [rootName, root] of Object.entries(roots)) {
    if (!root) continue;
    let names = [];
    try { names = Object.getOwnPropertyNames(root); } catch (e) {}
    const objects = [[rootName, root]];
    for (const n of names) {
      try {
        const v = root[n];
        if (v && (typeof v === 'object' || typeof v === 'function')) objects.push([rootName + '.' + n, v]);
      } catch (e) { /* a blocked name throws: that is the point */ }
    }
    for (const [route, o] of objects) {
      let f; try { f = o.fetch; } catch (e) {}
      if (f !== fetch) await tryFetch(route + '.fetch', f && f.bind(o));
      for (const cap of ['Bun', 'process', 'require', 'ShadowRealm', 'WebSocket']) tryCap(route + '.' + cap, () => o[cap]);
    }
  }

  try {
    const realm = new ShadowRealm();
    out['ShadowRealm Bun'] = 'leak: ' + realm.evaluate('typeof Bun');
  } catch (e) { out['ShadowRealm'] = 'refused: ' + e.message; }

  try {
    const ws = new WebSocket(LOOP.replace('http', 'ws'));
    out['WebSocket'] = 'leak: ' + await new Promise((r) => {
      ws.onopen = () => r('open'); ws.onerror = () => r('error'); ws.onclose = () => r('close');
      setTimeout(() => r('timeout'), 2000);
    });
  } catch (e) { out['WebSocket'] = 'refused: ' + e.message; }
  `;
}

function leaks(body: Record<string, string>): string[] {
  return Object.entries(body)
    .filter(([, v]) => typeof v === 'string' && (v.startsWith('leak:') || v.includes(MARKER)))
    .map(([k, v]) => `${k} => ${v.slice(0, 80)}`);
}

describe('edge sandbox — the global object, by any name', () => {
  it('an edge function reaches neither file:// nor loopback through any alias', async () => {
    const before = hits;
    const loop = `http://127.0.0.1:${server.port}/`;
    const code = `async function handler() {${probe(`file://${SECRET}`, loop)}
      return { status: 200, body: out };
    }`;
    const res = await runEdgeFunctionInSubprocess(code, REQ, {}, 15_000);
    expect(res.error).toBeUndefined();
    const body = res.response?.body as Record<string, string>;
    // The probe ran the routes it claims to: a global that disappeared entirely
    // would make every check below pass for the wrong reason.
    for (const r of ['global', 'globalThis', 'self', 'window', 'unbound'])
      expect(body).toHaveProperty(`root ${r}`);
    expect(leaks(body)).toEqual([]);
    expect(hits - before).toBe(0);
  }, 30_000);

  it('a flow run_script step is held by the same lock', async () => {
    const before = hits;
    const loop = `http://127.0.0.1:${server.port}/`;
    const res = await runScript(`${probe(`file://${SECRET}`, loop)}\n return out;`, {}, 15_000);
    expect(res.error).toBeUndefined();
    const out = res.output as Record<string, string>;
    for (const r of ['global', 'globalThis', 'self', 'window', 'unbound'])
      expect(out).toHaveProperty(`root ${r}`);
    expect(leaks(out)).toEqual([]);
    expect(hits - before).toBe(0);
  }, 30_000);

  it('the sandboxed fetch is the one the global object carries, and it still works', async () => {
    const code = `async function handler() {
      const out = {};
      try { out.same = global.fetch === fetch; } catch (e) { out.same = e.message; }
      try { await fetch('http://127.0.0.1:${server.port}/'); out.loop = 'reached'; }
      catch (e) { out.loop = e.message; }
      out.web = [typeof URL, typeof TextEncoder, typeof crypto.randomUUID, typeof Response,
        typeof structuredClone, typeof setTimeout, typeof AbortSignal.timeout].join(',');
      return { status: 200, body: out };
    }`;
    const res = await runEdgeFunctionInSubprocess(code, REQ, {}, 10_000);
    const body = res.response?.body as Record<string, unknown>;
    expect(String(body.same)).toMatch(/\[sandbox\].*"global" is blocked/);
    expect(String(body.loop)).toMatch(/\[sandbox\].*blocked/);
    expect(body.web).toBe('function,function,function,function,function,function,function');
  }, 20_000);
});
