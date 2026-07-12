/**
 * instantiateWasmExtension — async register() wrapped in CPU budget (wasm-extension-host.ts).
 */

import { afterEach, describe, expect, it } from 'bun:test';
import { instantiateWasmExtension } from '../../lib/wasm-extension-host.js';

const WASM_BYTES = new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0]);
const origInstantiate = WebAssembly.instantiate;

afterEach(() => {
  WebAssembly.instantiate = origInstantiate;
});

describe('instantiateWasmExtension — async register CPU budget', () => {
  it('awaits an async register export for third-party extensions', async () => {
    let resolved = false;
    WebAssembly.instantiate = (async () => ({
      instance: {
        exports: {
          register: () =>
            new Promise<void>((resolve) => {
              setTimeout(() => {
                resolved = true;
                resolve();
              }, 10);
            }),
        },
      },
      module: {},
    })) as unknown as typeof WebAssembly.instantiate;

    const handle = await instantiateWasmExtension(WASM_BYTES, { extName: 'unknown-ext' });
    await handle.register();
    expect(resolved).toBe(true);
  });

  it('rejects when async register exceeds the third-party CPU budget', async () => {
    WebAssembly.instantiate = (async () => ({
      instance: {
        exports: {
          register: () => new Promise<void>((resolve) => setTimeout(resolve, 6_000)),
        },
      },
      module: {},
    })) as unknown as typeof WebAssembly.instantiate;

    const handle = await instantiateWasmExtension(WASM_BYTES, { extName: 'unknown-ext' });
    await expect(handle.register()).rejects.toThrow(/CPU budget/);
  }, 10_000);
});
