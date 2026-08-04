/**
 * The worker runtime's `fetch` guard, exercised through a REAL Bun.Worker
 * running the bundle the engine actually ships.
 *
 * A mocked worker would prove nothing here. The guard lives inside
 * `worker-extension-runtime.ts`, which reaches production only after
 * `gen-worker-source.ts` compiles it into
 * `worker-extension-runtime-source.generated.ts` — so a test that stubs the
 * worker would keep passing if the guard never made it into the bundle. This
 * spawns the generated source and asks it to fetch a private address.
 *
 * Read the guard's own docstring for what it is not: a Bun.Worker is a thread
 * with the full Node API, so this stops accidental SSRF, not hostile code
 * (`node:http` is one import away). These tests pin the accident case.
 */

import { afterEach, describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { WORKER_RUNTIME_SOURCE } from '../../lib/worker-extension-runtime-source.generated.js';

const dirs: string[] = [];

afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

/**
 * Boot the shipped runtime with an extension whose register() performs
 * `fetch(target)`, and return whatever that fetch produced. register() errors
 * surface as `init:err`, which is exactly the channel we want to read.
 */
async function fetchFromWorker(target: string): Promise<string> {
  const dir = mkdtempSync(join(tmpdir(), 'zv-fetchguard-'));
  dirs.push(dir);

  const runtimePath = join(dir, 'runtime.mjs');
  writeFileSync(runtimePath, WORKER_RUNTIME_SOURCE, 'utf8');

  const bundlePath = join(dir, 'ext.mjs');
  writeFileSync(
    bundlePath,
    `export default {
       name: 'probe',
       async register() {
         try {
           await fetch(${JSON.stringify(target)});
           throw new Error('FETCH-ALLOWED');
         } catch (e) {
           throw new Error('RESULT:' + e.message);
         }
       },
     };`,
    'utf8',
  );

  const worker = new Worker(pathToFileURL(runtimePath).href, {
    env: { NODE_ENV: 'test' },
  } as WorkerOptions);

  try {
    return await new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('worker init timed out')), 15_000);
      worker.onmessage = (e: MessageEvent<{ type: string; error?: string }>) => {
        clearTimeout(timer);
        if (e.data.type === 'init:err') resolve(e.data.error ?? '');
        else if (e.data.type === 'init:ok') resolve('INIT-OK-NO-ERROR');
      };
      worker.onerror = (e: ErrorEvent) => {
        clearTimeout(timer);
        reject(new Error(e.message));
      };
      worker.postMessage({
        type: 'init',
        id: 'probe-1',
        bundleUrl: pathToFileURL(bundlePath).href,
        extName: 'probe',
        env: { NODE_ENV: 'test', extensionPath: dir },
      });
    });
  } finally {
    worker.terminate();
  }
}

describe('worker fetch guard', () => {
  it('refuses loopback', async () => {
    const msg = await fetchFromWorker('http://127.0.0.1:1/x');
    expect(msg).not.toContain('FETCH-ALLOWED');
    expect(msg.toLowerCase()).toMatch(/private|loopback|blocked|refus|not allowed/);
  }, 20_000);

  it('refuses the cloud metadata address', async () => {
    // The one that turns a webhook URL field into an instance-credential leak.
    const msg = await fetchFromWorker('http://169.254.169.254/latest/meta-data/');
    expect(msg).not.toContain('FETCH-ALLOWED');
    expect(msg.toLowerCase()).toMatch(/private|link-local|metadata|blocked|refus|not allowed/);
  }, 20_000);

  it('refuses an RFC1918 address', async () => {
    const msg = await fetchFromWorker('http://10.0.0.1/admin');
    expect(msg).not.toContain('FETCH-ALLOWED');
    expect(msg.toLowerCase()).toMatch(/private|blocked|refus|not allowed/);
  }, 20_000);
});
