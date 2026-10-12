/**
 * The edge sandbox reaches the globals it was reviewed for, and nothing else.
 *
 * The lockdown used to be a block list: a name Bun adds in a future release
 * would have been reachable by default. It is now an allowlist
 * (SANDBOX_GLOBALS): every other name on the global object and its prototype
 * chain is blocked.
 *
 * Regression: before the switch `alert`, `confirm` and `prompt` were reachable.
 * They write raw to stdout, the channel the child answers the engine on, so an
 * edge function could print an envelope of its own before the handler returned
 * — measured: `alert('{"ok":true,…}')` replaced the handler's real response.
 *
 * The names are not taken from memory. The first test enumerates the global of a
 * bare module run by this very interpreter; the second calls every function
 * reachable from what is left with no receiver — the way a bare `name()` call
 * reaches it — and checks that nothing hands back the global object, `Bun` or
 * `process` (the EventTarget methods once did: edge-subprocess-global-escape).
 */

import { afterAll, describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { EdgeRequest } from '../../lib/edge-function-runner.js';
import {
  drainRunnerPool,
  runEdgeFunctionInSubprocess,
  SANDBOX_GLOBALS,
} from '../../lib/edge-functions/subprocess-runner.js';

const REQ: EdgeRequest = { method: 'GET', headers: {}, query: {}, body: null, path: '/' };
// The sandbox hands these to the handler itself, as parameters.
const PROVIDED = new Set(['console', 'fetch']);
const IDENT = /^[A-Za-z_$][\w$]*$/;

afterAll(async () => {
  await drainRunnerPool();
});

/** Every string-keyed global, own and inherited, of a module this interpreter runs. */
async function runtimeGlobals(): Promise<string[]> {
  const dir = mkdtempSync(join(tmpdir(), 'zv-globals-'));
  try {
    const file = join(dir, 'names.mjs');
    writeFileSync(
      file,
      `const s = new Set();
       for (let o = globalThis; o; o = Object.getPrototypeOf(o)) for (const k of Object.getOwnPropertyNames(o)) s.add(k);
       console.log(JSON.stringify([...s]));`,
    );
    const proc = Bun.spawn([process.execPath, 'run', file], { stdout: 'pipe', stderr: 'pipe' });
    const text = await new Response(proc.stdout).text();
    await proc.exited;
    return JSON.parse(text) as string[];
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** A handler that reads each name as a bare identifier: 'blocked', or its typeof. */
function readEach(names: string[]): string {
  const getters = names.map((n) => `[${JSON.stringify(n)}]: () => ${n}`).join(',');
  return `async function handler() {
    const get = {${getters}}, out = Object.create(null);
    for (const n of Object.keys(get)) { try { out[n] = typeof get[n](); } catch (e) { out[n] = 'blocked'; } }
    return { status: 200, body: out };
  }`;
}

/**
 * Walks everything reachable from the allowed globals (own and inherited
 * properties, three levels deep, getters read on the instance) and calls every
 * function with an undefined and a null receiver, with callbacks that walk
 * whatever `this` and arguments they are handed. Two passes, because a listener
 * registered in one call only fires on a later dispatch.
 */
const WALKER = `
const out = { hits: [], calls: 0, called: [] };
const FnProto = Object.getPrototypeOf(function () {});
const isGlobal = (x) => { try { const k = Reflect.ownKeys(x); return k.includes('Bun') || k.includes('process'); } catch (e) { return false; } };
const capOf = (x) => {
  try { if (typeof x.spawn === 'function' && typeof x.file === 'function') return 'Bun'; } catch (e) {}
  try { if (typeof x.binding === 'function' || typeof x.dlopen === 'function') return 'process'; } catch (e) {}
  return null;
};
const seen = new WeakSet(), queue = [], fns = [];
const push = (path, v, depth, derived) => {
  if (!v || (typeof v !== 'object' && typeof v !== 'function')) return;
  try { if (v instanceof Promise) v.catch(() => {}); } catch (e) {}
  if (isGlobal(v)) out.hits.push('global object via ' + path);
  const cap = capOf(v); if (cap) out.hits.push(cap + ' via ' + path);
  if (!seen.has(v)) { seen.add(v); queue.push([path, v, depth, derived]); }
};
// Blocking or exiting: a hang here is the invocation's own timeout, not a leak.
const NOCALL = new Set(['wait', 'reportError']);
const cb = (path) => function (...a) { push(path + ' this', this, 1, true); a.forEach((x, i) => push(path + ' arg' + i, x, 1, true)); };
const call = async (path, f) => {
  const argsets = [[], [cb(path)], ['zv', cb(path)], [cb(path), 0], [{}], [new Event('zv')]];
  for (const recv of [undefined, null]) for (const args of argsets) {
    out.calls++;
    let r;
    try { r = Reflect.apply(f, recv, args); } catch (e) { continue; }
    try { if (r && typeof r.then === 'function') r = await Promise.race([r, new Promise((res) => setTimeout(res, 20))]); } catch (e) { continue; }
    push(path + '()', r, 2, true);
  }
};
const drain = async () => {
  while (queue.length) {
    const [path, v, depth, derived] = queue.shift();
    if (typeof v === 'function' && !derived && !NOCALL.has(path.split('.').pop())) { fns.push([path, v]); out.called.push(path); await call(path, v); }
    if (depth >= 3) continue;
    const keys = new Set();
    try { for (let o = v; o && o !== Object.prototype && o !== FnProto; o = Object.getPrototypeOf(o)) for (const k of Reflect.ownKeys(o)) keys.add(k); } catch (e) {}
    for (const k of keys) { let x; try { x = v[k]; } catch (e) { continue; } push(path + '.' + String(k), x, depth + 1, derived); }
    try { push(path + '.__proto__', Object.getPrototypeOf(v), depth + 1, derived); } catch (e) {}
  }
};
for (const [n, get] of Object.entries(ROOTS)) { let v; try { v = get(); } catch (e) { continue; } push(n, v, 0, false); }
await drain();
for (const [path, f] of fns.slice()) await call(path, f);
await drain();
try {
  const prev = Error.prepareStackTrace;
  Error.prepareStackTrace = (e, cs) => cs;
  const cs = await (async () => { await null; return new Error('zv').stack; })();
  Error.prepareStackTrace = prev;
  if (Array.isArray(cs)) cs.forEach((c, i) => {
    try { push('callsite' + i + '.getThis()', c.getThis(), 3, true); } catch (e) {}
    try { push('callsite' + i + '.getFunction()', c.getFunction(), 3, true); } catch (e) {}
  });
} catch (e) {}
await new Promise((r) => setTimeout(r, 200));
await drain();
`;

describe('edge sandbox — globals are an allowlist', () => {
  it('every runtime global outside SANDBOX_GLOBALS is unreachable', async () => {
    const allowed = new Set(SANDBOX_GLOBALS);
    const names = (await runtimeGlobals()).filter((n) => IDENT.test(n) && !PROVIDED.has(n));
    // The enumeration ran: a child that printed nothing would pass every check below.
    expect(names).toContain('setTimeout');
    const denied = names.filter((n) => !allowed.has(n) && n !== 'eval');
    expect(denied).toContain('Bun');

    const res = await runEdgeFunctionInSubprocess(readEach(names), REQ, {}, 15_000);
    expect(res.error).toBeUndefined();
    const seen = res.response?.body as Record<string, string>;
    // A denied name reads as blocked, or as undefined where a handler parameter
    // shadows it (Bun, process, …).
    expect(denied.filter((n) => seen[n] !== 'blocked' && seen[n] !== 'undefined')).toEqual([]);
    // And the allowlist is not dead letter: what it lists is still there.
    const present = names.filter((n) => allowed.has(n));
    expect(present.filter((n) => seen[n] === 'blocked')).toEqual([]);
    expect(present.length).toBeGreaterThan(100);
  }, 30_000);

  it('no function reachable from the allowed globals, called with no receiver, yields the global, Bun or process', async () => {
    const roots = SANDBOX_GLOBALS.filter((n) => IDENT.test(n))
      .map((n) => `[${JSON.stringify(n)}]: () => ${n}`)
      .join(',');
    const code = `async function handler() {
      const ROOTS = {${roots}};
      ${WALKER}
      return { status: 200, body: { hits: out.hits, calls: out.calls, called: out.called } };
    }`;
    const res = await runEdgeFunctionInSubprocess(code, REQ, {}, 60_000);
    expect(res.error).toBeUndefined();
    const body = res.response?.body as { hits: string[]; calls: number; called: string[] };
    // The walk reached the route that once escaped, and far beyond it.
    expect(body.called.some((p) => p.endsWith('.addEventListener'))).toBe(true);
    expect(body.called.length).toBeGreaterThan(500);
    expect([...new Set(body.hits)]).toEqual([]);
  }, 90_000);
});
