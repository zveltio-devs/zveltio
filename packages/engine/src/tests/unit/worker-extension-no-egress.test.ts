/**
 * The worker runtime's `fetch` refusal, exercised through a REAL runtime process
 * (the `process` transport) running the bundle the engine actually ships.
 *
 * A mocked worker would prove nothing here. The guard lives inside
 * `worker-extension-runtime.ts`, which reaches production only after
 * `gen-worker-source.ts` compiles it into
 * `worker-extension-runtime-source.generated.ts` — so a test that stubs the
 * worker would keep passing if the guard never made it into the bundle. This
 * spawns the generated source and asks it to fetch.
 *
 * Read the refusal's own docstring for what it is not: the runtime has the
 * full Node API (`node:net` is one import away), so the boundary is the
 * runner's network, measured by the ext-runner-* scripts. These tests pin that
 * the shipped bundle refuses `fetch`, public addresses included.
 */

import { afterEach, describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { WORKER_RUNTIME_SOURCE } from '../../lib/worker-extension-runtime-source.generated.js';
import { spawnProcessRunner } from '../../lib/worker-extension-transport.js';

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

  const worker = spawnProcessRunner(runtimePath, { NODE_ENV: 'test' });

  try {
    return await new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('worker init timed out')), 15_000);
      worker.onmessage = (e) => {
        if (e.data.type === 'init:err') resolve(e.data.error ?? '');
        else if (e.data.type === 'init:ok') resolve('INIT-OK-NO-ERROR');
        else return;
        clearTimeout(timer);
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

describe('worker fetch refusal (ADR 0022: third-party routes and actions have no egress)', () => {
  for (const target of [
    'https://example.com/',
    'http://127.0.0.1:1/x',
    'http://169.254.169.254/latest/meta-data/',
  ]) {
    it(`refuses ${target}`, async () => {
      const msg = await fetchFromWorker(target);
      expect(msg).not.toContain('FETCH-ALLOWED');
      expect(msg).toContain('no network egress (ADR 0022)');
    }, 20_000);
  }
});
