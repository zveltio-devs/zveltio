/**
 * The pool ceiling and the advice about it must be the same number.
 *
 * They were not. `initDatabase` built the pool with `?? 25`; `startup-guards.ts`
 * reasoned with `?? 10`. A boot with `DB_POOL_MAX` unset therefore announced:
 *
 *   Concurrency ceiling: DB_POOL_MAX=10 in-flight requests per instance
 *   (server max_connections=200, so ~19 instance(s) fit).
 *
 * while the pool it had just created was 25, and about 7 instances fit. That
 * line is what an operator sizes a deployment from, so the error lands as
 * connection exhaustion under load — the failure furthest in time from its cause.
 *
 * Two spellings of one default cannot be kept honest by review, so there is one
 * spelling and this holds it there.
 */

import { afterEach, describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { DEFAULT_DB_POOL_MAX, resolvePoolMax } from '../../db/index.js';

const ENGINE = join(import.meta.dir, '..', '..', '..');

describe('DB_POOL_MAX has one source', () => {
  const saved = process.env.DB_POOL_MAX;

  afterEach(() => {
    if (saved === undefined) delete process.env.DB_POOL_MAX;
    else process.env.DB_POOL_MAX = saved;
  });

  it('falls back to the shared default when unset', () => {
    delete process.env.DB_POOL_MAX;
    expect(resolvePoolMax()).toBe(DEFAULT_DB_POOL_MAX);
  });

  it('honours an explicit value', () => {
    process.env.DB_POOL_MAX = '40';
    expect(resolvePoolMax()).toBe(40);
  });

  it('ignores a value that is not a usable number', () => {
    // An empty or malformed variable must not silently become a zero-sized pool,
    // which would refuse every request rather than fall back.
    for (const bad of ['', '   ', 'lots', '0', '-5']) {
      process.env.DB_POOL_MAX = bad;
      expect(resolvePoolMax()).toBe(DEFAULT_DB_POOL_MAX);
    }
  });

  it('neither the pool nor the advice spells the default itself', () => {
    // The regression is textual: a second `?? <number>` reintroduces the drift
    // even while both files still look correct on their own.
    for (const rel of ['src/db/index.ts', 'src/lib/startup-guards.ts']) {
      const src = readFileSync(join(ENGINE, rel), 'utf8');
      const inlineDefaults = src.match(/process\.env\.DB_POOL_MAX\s*\?\?\s*\d+/g) ?? [];
      expect(`${rel}: ${JSON.stringify(inlineDefaults)}`).toBe(`${rel}: []`);
    }
  });
});
