/**
 * wasm-extension-host.ts — ABI mismatch, async register CPU budget, shutdown errors.
 */

import { afterEach, describe, expect, it, spyOn } from 'bun:test';
import { WASM_HOST_ABI_VERSION, instantiateWasmExtension } from '../../lib/wasm-extension-host.js';

const WASM_BYTES = new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0]);
const origInstantiate = WebAssembly.instantiate;

afterEach(() => {
  WebAssembly.instantiate = origInstantiate;
});

describe('instantiateWasmExtension — extra paths', () => {
  it('throws when the module requires a newer host ABI', async () => {
    WebAssembly.instantiate = (async () => ({
      instance: {
        exports: {
          register: () => {},
          _host_abi_version_required: WASM_HOST_ABI_VERSION + 1,
        },
      },
      module: {},
    })) as unknown as typeof WebAssembly.instantiate;

    await expect(instantiateWasmExtension(WASM_BYTES, { extName: 'abi-mismatch' })).rejects.toThrow(
      /requires host ABI/,
    );
  });

  it('warns and continues when shutdown() throws', async () => {
    WebAssembly.instantiate = (async () => ({
      instance: {
        exports: {
          register: () => {},
          shutdown: () => {
            throw new Error('shutdown boom');
          },
        },
      },
      module: {},
    })) as unknown as typeof WebAssembly.instantiate;

    const warn = spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const handle = await instantiateWasmExtension(WASM_BYTES, { extName: 'shutdown-bad' });
      await expect(handle.shutdown()).resolves.toBeUndefined();
      expect(warn.mock.calls.some((c) => String(c[0]).includes('shutdown threw'))).toBe(true);
    } finally {
      warn.mockRestore();
    }
  });

  it('invokes db_execute import stub for first-party extensions', async () => {
    WebAssembly.instantiate = (async (_bytes: BufferSource, imports?: WebAssembly.Imports) => {
      const z = imports!.zveltio as Record<string, (ptr: number, len: number) => number>;
      expect(z.db_execute(0, 0)).toBe(0);
      return {
        instance: { exports: { register: () => {} } },
        module: {},
      };
    }) as unknown as typeof WebAssembly.instantiate;

    const handle = await instantiateWasmExtension(WASM_BYTES, { extName: 'ai' });
    await handle.register();
  });
});
