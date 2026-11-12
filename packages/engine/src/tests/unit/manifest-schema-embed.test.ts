/**
 * Studio page schema inlining (lib/extensions/manifest-schema.ts embedPageSchemas).
 */

import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, spyOn } from 'bun:test';
import { embedPageSchemas, viewRefusal } from '../../lib/extensions/manifest-schema.js';

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

  it('sets render=schema for inline schema objects', async () => {
    const inline = {
      title: 'Inline',
      sduiSchema: 1,
      resources: [{ id: 'r', dataSource: '/x', columns: [] }],
    };
    const studio = { pages: [{ path: '/x', label: 'X', schema: inline }] };
    const out = await embedPageSchemas(tmpExt({}), studio);
    expect(out?.pages?.[0]?.schema).toBe(inline);
    expect(out?.pages?.[0]?.render).toBe('schema');
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

// ADR 0042: a page that declares `zveltio.view/2` is checked against the JSON
// Schema the SDK publishes, the same one `zveltio extension validate` and
// `pack` run; a view/1 schema (no `spec`) is served as before.
describe('embedPageSchemas — view/2', () => {
  const valid = {
    spec: 'zveltio.view/2',
    type: 'list',
    collection: 'invoices',
    fields: ['number', { field: 'status', display: 'badge', tones: { overdue: 'danger' } }],
    rowActions: [{ action: 'pay', input: { invoice_id: { $record: 'id' } } }],
  };
  // The broken fixture: a view/1 habit (an endpoint) inside a view/2.
  const broken = {
    spec: 'zveltio.view/2',
    type: 'list',
    collection: 'invoices',
    dataSource: '/api/data/invoices',
  };

  it('serves a valid view/2 file', async () => {
    const dir = tmpExt({ 'studio/views/invoices.json': JSON.stringify(valid) });
    const out = await embedPageSchemas(dir, {
      pages: [{ path: '/app/x', label: 'X', schema: 'views/invoices.json' }],
    });
    expect(out?.pages?.[0]?.schema).toEqual(valid);
    expect(out?.pages?.[0]?.render).toBe('schema');
  });

  it('does not serve a view/2 that fails the schema, and says why', async () => {
    const warn = spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const dir = tmpExt({ 'studio/views/bad.json': JSON.stringify(broken) });
      const out = await embedPageSchemas(dir, {
        pages: [
          { path: '/app/x/bad', label: 'Bad', schema: 'views/bad.json' },
          { path: '/app/x/inline', label: 'Inline', schema: { ...broken } },
        ],
      });
      for (const page of out?.pages ?? []) {
        expect(page.schema).toBeUndefined();
        expect(page.render).toBeUndefined();
      }
      expect(warn.mock.calls.some((c) => String(c[0]).includes('dataSource'))).toBe(true);
    } finally {
      warn.mockRestore();
    }
  });

  it('agrees with the SDK validator the CLI runs', async () => {
    const { validateView } = await import('@zveltio/sdk/view');
    const cases: unknown[] = [
      valid,
      broken,
      { ...valid, collection: '/api/data/invoices' },
      { spec: 'zveltio.view/2', type: 'form', collection: 'a', action: 'b' },
      { spec: 'zveltio.view/2', type: 'form', action: 'importCsv' },
      { spec: 'zveltio.view/2', type: 'split', panes: [valid, { ...valid, type: 'board' }] },
      {
        spec: 'zveltio.view/2',
        type: 'tabs',
        items: [{ type: 'map', collection: 'a', location: 'p' }],
      },
      { ...valid, filter: [{ field: 'a', op: 'eq', value: { $env: 'X' } }] },
    ];
    for (const c of cases) {
      expect(viewRefusal(c) === null).toBe(validateView(c).ok);
    }
  });

  it('leaves a view/1 schema alone', () => {
    expect(viewRefusal({ sduiSchema: 1, title: 't', resources: [] })).toBeNull();
  });
});
