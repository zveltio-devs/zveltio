import { describe, expect, it } from 'bun:test';
import { join } from 'node:path';
import { API_GROUPS, buildSpec } from '../../routes/openapi.js';

// ADR 0055 d4: every `/api/<group>` the engine mounts is classified as inside
// the HTTP API 1.0 contract or outside it, so a new group cannot enter the
// contract silently.

const SRC = join(import.meta.dir, '../..');
const MOUNT =
  /\bapp\.(?:route|get|post|put|patch|delete|all|on|use)\(\s*(?:\[[^\]]*\]\s*,\s*)?['"`]\/api\/([^/'"`*:]+)/g;

async function mountedGroups(): Promise<Map<string, string>> {
  const found = new Map<string, string>();
  for await (const file of new Bun.Glob('**/*.ts').scan(SRC)) {
    if (file.startsWith('tests/') || file.includes('.test.') || file.startsWith('testing/'))
      continue;
    const lines = (await Bun.file(join(SRC, file)).text()).split('\n');
    for (const line of lines) {
      const t = line.trimStart();
      if (t.startsWith('*') || t.startsWith('//')) continue;
      for (const m of line.matchAll(MOUNT)) if (!found.has(m[1])) found.set(m[1], file);
    }
  }
  return found;
}

describe('HTTP API contract groups (ADR 0055)', () => {
  it('classifies every mounted /api group', async () => {
    const groups = await mountedGroups();
    expect(groups.size).toBeGreaterThan(30);
    const missing = [...groups]
      .filter(([g]) => !(g in API_GROUPS))
      .map(([g, f]) => `/api/${g} (${f})`);
    expect(missing).toEqual([]);
  });

  it('lists no group the engine does not mount', async () => {
    const groups = await mountedGroups();
    expect(Object.keys(API_GROUPS).filter((g) => !groups.has(g))).toEqual([]);
  });

  it('marks the spec with the API version and the outside groups', () => {
    const spec = buildSpec();
    expect(spec.info['x-api-version']).toBe(1);
    for (const [path, item] of Object.entries(spec.paths)) {
      const group = path.split('/')[1] ?? '';
      expect(API_GROUPS[group]).toBeDefined();
      const contract = (item as Record<string, unknown>)['x-contract'];
      expect(contract).toBe(API_GROUPS[group] === 'none' ? 'none' : undefined);
    }
  });
});
