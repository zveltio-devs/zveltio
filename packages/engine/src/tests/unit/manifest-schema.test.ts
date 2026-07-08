/**
 * Extension manifest contract (lib/extensions/manifest-schema.ts) — the Zod
 * `ManifestSchema` is the single source of truth for what a `manifest.json` may
 * contain. Pure (path + zod). Covers required fields, format regexes, enums,
 * nested blocks, and the applied defaults.
 */

import { describe, it, expect } from 'bun:test';
import { ManifestSchema } from '../../lib/extensions/manifest-schema.js';

describe('ManifestSchema — required + defaults', () => {
  it('accepts a minimal manifest and applies defaults', () => {
    const m = ManifestSchema.parse({ name: 'probe' });
    expect(m.name).toBe('probe');
    expect(m.version).toBe('1.0.0'); // default
    expect(m.category).toBe('custom'); // default
    expect(m.dependencies).toEqual([]); // default
    expect(m.permissions).toEqual([]); // default
    expect(m.runtime).toBe('js'); // default
  });

  it('rejects a missing or empty name', () => {
    expect(ManifestSchema.safeParse({}).success).toBe(false);
    expect(ManifestSchema.safeParse({ name: '' }).success).toBe(false);
  });

  it('passes through unknown top-level keys', () => {
    const m = ManifestSchema.parse({ name: 'x', somethingCustom: 42 }) as Record<string, unknown>;
    expect(m.somethingCustom).toBe(42);
  });
});

describe('ManifestSchema — version + enums', () => {
  it('requires an x.y.z version', () => {
    expect(ManifestSchema.safeParse({ name: 'x', version: '2.3.4' }).success).toBe(true);
    expect(ManifestSchema.safeParse({ name: 'x', version: '1.0' }).success).toBe(false);
    expect(ManifestSchema.safeParse({ name: 'x', version: 'v1.0.0' }).success).toBe(false);
  });

  it('constrains the runtime enum', () => {
    expect(ManifestSchema.safeParse({ name: 'x', runtime: 'wasm' }).success).toBe(true);
    expect(ManifestSchema.safeParse({ name: 'x', runtime: 'python' }).success).toBe(false);
  });
});

describe('ManifestSchema — engine block', () => {
  it('accepts a bundled engine block with defaults', () => {
    const m = ManifestSchema.parse({
      name: 'x',
      engine: { entry: 'engine/index.js', bundled: true },
    });
    expect(m.engine?.format).toBe('esm');
    expect(m.engine?.target).toBe('bun');
    expect(m.engine?.isolation).toBe('inline');
  });

  it('requires engine.entry when the block is present', () => {
    expect(ManifestSchema.safeParse({ name: 'x', engine: { bundled: true } }).success).toBe(false);
  });

  it('constrains engine.isolation', () => {
    const ok = ManifestSchema.safeParse({
      name: 'x',
      engine: { entry: 'e.js', bundled: true, isolation: 'worker' },
    });
    expect(ok.success).toBe(true);
    const bad = ManifestSchema.safeParse({
      name: 'x',
      engine: { entry: 'e.js', bundled: true, isolation: 'sandbox' },
    });
    expect(bad.success).toBe(false);
  });
});

describe('ManifestSchema — integrity + quotas', () => {
  it('validates a 64-hex engineSha256', () => {
    expect(
      ManifestSchema.safeParse({ name: 'x', integrity: { engineSha256: 'a'.repeat(64) } }).success,
    ).toBe(true);
    expect(
      ManifestSchema.safeParse({ name: 'x', integrity: { engineSha256: 'nothex' } }).success,
    ).toBe(false);
  });

  it('rejects non-positive quota limits', () => {
    expect(ManifestSchema.safeParse({ name: 'x', quotas: { bundleSizeKbMax: -1 } }).success).toBe(
      false,
    );
  });

  it('accepts a well-formed dependencies array', () => {
    const m = ManifestSchema.parse({
      name: 'x',
      dependencies: [{ name: 'crm', minVersion: '1.0.0' }],
    });
    expect(m.dependencies[0]?.name).toBe('crm');
  });
});
