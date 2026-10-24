/**
 * Boot recycles the pool once every migration has run (index.ts).
 *
 * A connection that prepared a statement before an extension migration altered
 * its table keeps the stale plan (0A000 "cached plan must not change result
 * type"). `recycleActivePool()` drops those connections; stale-plan-recycle
 * tests what it does, this asserts boot still calls it at the right point:
 * after engine migrations and extension loads, before `Bun.serve`.
 */
import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const src = readFileSync(join(import.meta.dir, '../../index.ts'), 'utf8');

describe('engine boot', () => {
  it('recycles the pool after every migration and before serving', () => {
    const at = (needle: string) => src.indexOf(needle);
    const recycle = at('await recycleActivePool();');
    expect(recycle).toBeGreaterThan(-1);
    expect(at('await autoMigrate(db);')).toBeLessThan(recycle);
    expect(at('extensionLoader.loadAll(')).toBeLessThan(recycle);
    expect(at('Bun.serve({')).toBeGreaterThan(recycle);
  });
});
