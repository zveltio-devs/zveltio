/**
 * Studio page schema inlining (lib/extensions/manifest-schema.ts embedPageSchemas).
 */

import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, spyOn } from 'bun:test';
import { embedPageSchemas } from '../../lib/extensions/manifest-schema.js';

function tmpExt(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), 'zv-embed-'));
  for (const [rel, content] of Object.entries(files)) {
    const full = join(dir, rel);
    mkdirSync(join(full, '..'), { recursive: true });
    writeFileSync(full, content);
  }
  return dir;
}

describe('embedPageSchemas', () => {
  it('returns studio unchanged when pages are absent', async () => {
    expect(await embedPageSchemas('/any', undefined)).toBeUndefined();
    expect(await embedPageSchemas('/any', { pages: [] })).toEqual({ pages: [] });
  });

  it('inlines a JSON schema file and sets render=schema', async () => {
    const dir = tmpExt({
      'studio/form.json': JSON.stringify({
        type: 'object',
        properties: { name: { type: 'string' } },
      }),
    });
    const studio = {
      pages: [{ path: '/form', label: 'Form', schema: 'form.json' as const }],
    };
    const out = await embedPageSchemas(dir, studio);
    expect(out?.pages?.[0]?.render).toBe('schema');
    expect(out?.pages?.[0]?.schema).toEqual({
      type: 'object',
      properties: { name: { type: 'string' } },
    });
  });

  it('leaves pages with inline schema objects untouched', async () => {
    const inline = { type: 'object' };
    const studio = { pages: [{ path: '/x', label: 'X', schema: inline }] };
    const out = await embedPageSchemas(tmpExt({}), studio);
    expect(out?.pages?.[0]?.schema).toBe(inline);
    expect(out?.pages?.[0]?.render).toBeUndefined();
  });

  it('warns and keeps the page when the schema file is missing or invalid', async () => {
    const warn = spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const dir = tmpExt({ 'studio/bad.json': '{not json' });
      const studio = { pages: [{ path: '/bad', label: 'Bad', schema: 'bad.json' }] };
      const out = await embedPageSchemas(dir, studio);
      expect(out?.pages?.[0]?.schema).toBe('bad.json');
      expect(warn.mock.calls.some((c) => String(c[0]).includes('bad.json'))).toBe(true);
    } finally {
      warn.mockRestore();
    }
  });
});
