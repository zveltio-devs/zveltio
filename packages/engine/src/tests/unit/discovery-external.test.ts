/**
 * discovery.ts — extension discovery helpers.
 */

import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
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
  it('lists subdirectory names under a base path', async () => {
    const base = mkdtempSync(join(tmpdir(), 'zv-disc-'));
    mkdirSync(join(base, 'alpha'));
    mkdirSync(join(base, 'beta'));
    try {
      const names = await discoverExternal(base);
      expect(names.sort()).toEqual(['alpha', 'beta']);
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });

  it('returns [] when the base path is unreadable', async () => {
    expect(await discoverExternal('/definitely/missing/zv-path')).toEqual([]);
  });
});
