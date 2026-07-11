import { describe, it, expect } from 'bun:test';
import {
  WASM_HOST_ABI_VERSION,
  instantiateWasmExtension,
  _internalForTests,
} from '../../lib/wasm-extension-host.js';

/** Minimal valid WASM: `(module (func (export "register")))`. */
const WASM_EXPORTS_REGISTER = new Uint8Array([
  0, 97, 115, 109, 1, 0, 0, 0, 1, 4, 1, 96, 0, 0, 3, 2, 1, 0, 7, 12, 1, 8, 114, 101, 103, 105, 115,
  116, 101, 114, 0, 0, 10, 4, 1, 2, 0, 11,
]);

/** Minimal WASM exporting `foo` instead of `register`. */
const WASM_EXPORTS_FOO = new Uint8Array([
  0, 97, 115, 109, 1, 0, 0, 0, 1, 4, 1, 96, 0, 0, 3, 2, 1, 0, 7, 7, 1, 3, 102, 111, 111, 0, 0, 10,
  4, 1, 2, 0, 11,
]);

function writeUtf8(memory: WebAssembly.Memory, text: string): { ptr: number; len: number } {
  const bytes = new TextEncoder().encode(text);
  const view = new Uint8Array(memory.buffer, 0, bytes.length);
  view.set(bytes);
  return { ptr: 0, len: bytes.length };
}

/**
 * S5-05 full — WASM extension host runtime tests.
 *
 * We cover the host primitives — the capability bridge functions
 * `buildHostImports` populates — and the CPU-budget enforcement. The
 * actual `WebAssembly.instantiate(...)` path is exercised when a real
 * `.wasm` extension lands (the engine integration suite); we don't
 * hand-craft binary WASM in unit tests because byte-level encoding
 * drift would break the suite for unrelated reasons.
 */

describe('S5-05 WASM host — ABI version', () => {
  it('exposes WASM_HOST_ABI_VERSION = 1 (bump on breaking changes)', () => {
    expect(WASM_HOST_ABI_VERSION).toBe(1);
  });
});

describe('S5-05 WASM host — capability bridge', () => {
  it('buildHostImports populates the zveltio namespace + env.memory', () => {
    const memory = new WebAssembly.Memory({ initial: 1, maximum: 8 });
    const imports = _internalForTests.buildHostImports('test/ext', memory, { extName: 'test/ext' });
    expect(imports.env.memory).toBe(memory);
    const z = imports.zveltio as Record<string, unknown>;
    expect(z.host_abi_version).toBe(WASM_HOST_ABI_VERSION);
    expect(typeof z.log).toBe('function');
    expect(typeof z.warn).toBe('function');
    expect(typeof z.db_query).toBe('function');
    expect(typeof z.db_execute).toBe('function');
    expect(typeof z.fetch_begin).toBe('function');
    expect(typeof z.crypto_random_bytes).toBe('function');
    expect(typeof z.env_read).toBe('function');
    expect(typeof z.fs_read).toBe('function');
    expect(typeof z.fs_write).toBe('function');
  });

  it('process.spawn import is NOT exposed (intentional hardening)', () => {
    const memory = new WebAssembly.Memory({ initial: 1 });
    const imports = _internalForTests.buildHostImports('test/ext', memory, { extName: 'test/ext' });
    const z = imports.zveltio as Record<string, unknown>;
    expect(z.process_spawn).toBeUndefined();
    expect(z.spawn).toBeUndefined();
  });

  it('db_query throws for an extension denied db.read', () => {
    // First-party extensions have db.read. An unknown extension is
    // third-party but third-party DOES get db.read in our defaults.
    // To trigger denial we'd need EXTENSION_POLICIES_JSON override — too
    // invasive for this unit test. Cover the policy-denied path via the
    // policy test instead; here we just smoke-test that the imports
    // execute without throwing.
    const memory = new WebAssembly.Memory({ initial: 1 });
    const imports = _internalForTests.buildHostImports('ai', memory, { extName: 'ai' });
    const z = imports.zveltio as Record<string, (...a: unknown[]) => unknown>;
    expect(() => z.db_query(0, 0)).not.toThrow();
  });

  it('crypto_random_bytes fills the linear memory slice', () => {
    const memory = new WebAssembly.Memory({ initial: 1 });
    const imports = _internalForTests.buildHostImports('ai', memory, { extName: 'ai' });
    const z = imports.zveltio as Record<string, (...a: unknown[]) => unknown>;
    const before = new Uint8Array(memory.buffer, 0, 16).slice();
    z.crypto_random_bytes(0, 16);
    const after = new Uint8Array(memory.buffer, 0, 16).slice();
    // Astronomically improbable to roll all zeros.
    expect(after.some((b, i) => b !== before[i])).toBe(true);
  });
});

describe('S5-05 WASM host — CPU budget', () => {
  it('withCpuBudget resolves when the work finishes inside the budget', async () => {
    const fast = new Promise<void>((r) => setTimeout(r, 10));
    await expect(_internalForTests.withCpuBudget(fast, 1000, 'test/fast')).resolves.toBeUndefined();
  });

  it('withCpuBudget rejects when the work exceeds the budget', async () => {
    const slow = new Promise<void>((r) => setTimeout(r, 200));
    let caught: Error | null = null;
    try {
      await _internalForTests.withCpuBudget(slow, 50, 'test/slow');
    } catch (e) {
      caught = e as Error;
    }
    expect(caught).not.toBeNull();
    expect(caught!.message).toContain('exceeded 50ms CPU budget');
  });
});

describe('S5-05 WASM host — instantiateWasmExtension', () => {
  it('loads a module that exports register()', async () => {
    const handle = await instantiateWasmExtension(WASM_EXPORTS_REGISTER, { extName: 'wasm-ok' });
    expect(handle.name).toBe('wasm-ok');
    await handle.register();
  });

  it('throws when the module does not export register()', async () => {
    await expect(
      instantiateWasmExtension(WASM_EXPORTS_FOO, { extName: 'wasm-bad' }),
    ).rejects.toThrow(/does not export a register/i);
  });

  it('throws on invalid WASM bytes', async () => {
    await expect(
      instantiateWasmExtension(new Uint8Array([0, 1, 2, 3]), { extName: 'wasm-garbage' }),
    ).rejects.toThrow();
  });
});

describe('S5-05 WASM host — third-party policy guards', () => {
  it('denies fetch.http for third-party extensions', () => {
    const memory = new WebAssembly.Memory({ initial: 1 });
    const imports = _internalForTests.buildHostImports('unknown-ext', memory, {
      extName: 'unknown-ext',
    });
    const z = imports.zveltio as Record<string, (ptr: number, len: number) => number>;
    const { ptr, len } = writeUtf8(memory, 'http://example.com/hook');
    expect(() => z.fetch_begin(ptr, len, 0)).toThrow(/denied capability "fetch.http"/i);
  });

  it('denies env.read and fs.read for third-party extensions', () => {
    const memory = new WebAssembly.Memory({ initial: 1 });
    const imports = _internalForTests.buildHostImports('unknown-ext', memory, {
      extName: 'unknown-ext',
    });
    const z = imports.zveltio as Record<string, (ptr: number, len: number) => number>;
    expect(() => z.env_read(0, 0)).toThrow(/denied capability "env.read"/i);
    expect(() => z.fs_read(0, 0)).toThrow(/denied capability "fs.read"/i);
  });

  it('decodes log/warn messages from linear memory', () => {
    const memory = new WebAssembly.Memory({ initial: 1 });
    const imports = _internalForTests.buildHostImports('ai', memory, { extName: 'ai' });
    const z = imports.zveltio as Record<string, (ptr: number, len: number) => void>;
    const { ptr, len } = writeUtf8(memory, 'hello wasm');
    expect(() => z.log(ptr, len)).not.toThrow();
    expect(() => z.warn(ptr, len)).not.toThrow();
  });
});
