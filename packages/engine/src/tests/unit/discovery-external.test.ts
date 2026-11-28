/**
 * discovery.ts — extension discovery helpers.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { discoverExternal, getActiveExtensionNames } from '../../lib/extensions/discovery.js';

let savedEnv: string | undefined;

beforeEach(() => {
  savedEnv = process.env.ZVELTIO_EXTENSIONS;
});

afterEach(() => {
  if (savedEnv === undefined) delete process.env.ZVELTIO_EXTENSIONS;
  else process.env.ZVELTIO_EXTENSIONS = savedEnv;
});

describe('getActiveExtensionNames', () => {
  it('parses a comma-separated env list', () => {
    process.env.ZVELTIO_EXTENSIONS = ' ai, billing ,crm ';
    expect(getActiveExtensionNames()).toEqual(['ai', 'billing', 'crm']);
  });

  it('returns an empty array when unset', () => {
    delete process.env.ZVELTIO_EXTENSIONS;
    expect(getActiveExtensionNames()).toEqual([]);
  });
});

describe('discoverExternal', () => {
  it('lists each directory holding a manifest, by its path under the base', async () => {
    const base = mkdtempSync(join(tmpdir(), 'zv-disc-'));
    // An update's staging directory, holding the previous bundle: not an extension.
    for (const dir of ['alpha', 'hr/leave', '.update-abc123']) {
      mkdirSync(join(base, dir), { recursive: true });
      writeFileSync(join(base, dir, 'manifest.json'), '{}');
    }
    // No manifest: neither an extension nor holding one.
    mkdirSync(join(base, 'empty-category'));
    try {
      const names = await discoverExternal(base);
      expect(names.sort()).toEqual(['alpha', 'hr/leave']);
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });

  it('returns [] when the base path is unreadable', async () => {
    expect(await discoverExternal('/definitely/missing/zv-path')).toEqual([]);
  });
});
