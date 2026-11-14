// What every `view/2` renderer shares (ADR 0042 decision 8): references, the
// data API filter, `when`, the generated defaults, the fallback, action results.
import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  $,
  actionPath,
  defaultView,
  fallbackFor,
  isBound,
  isEditable,
  matches,
  fileIds,
  readActionResult,
  resolveFiles,
  resolveInput,
  toFilter,
  toSort,
  type View,
  validateView,
} from '../view/index.js';

const scope = {
  record: { id: 'r1', status: 'open', total: 5 },
  selected: { folders: 'f9' },
  selection: [{ id: 'a' }, { id: 'b' }],
  params: { id: 'p1' },
  user: 'u1',
  today: '2026-11-12',
};

describe('references', () => {
  it('fills every reference from the scope', () => {
    expect(
      resolveInput(
        {
          rec: $.record('id'),
          sel: $.selected('folders'),
          ids: $.selection('id'),
          p: $.param('id'),
          me: $.user(),
          d: $.today(),
          lit: 3,
        },
        scope,
      ),
    ).toEqual({
      rec: 'r1',
      sel: 'f9',
      ids: ['a', 'b'],
      p: 'p1',
      me: 'u1',
      d: '2026-11-12',
      lit: 3,
    });
  });

  it('is unresolved while a pane has no selection', () => {
    expect(resolveInput({ x: $.selected('other') }, scope)).toBeNull();
    expect(toFilter([$.where('folder_id', 'eq', $.selected('other'))], scope)).toBeNull();
  });
});

describe('a button whose reference has no value yet', () => {
  const none = { ...scope, selected: {} };
  it('is not bound while the pane it names has no selection, and is once it has', () => {
    const b = { action: 'dismissScan', input: { scan_id: $.selected('folders') } };
    expect(isBound(b, none)).toBe(false);
    expect(isBound(b, scope)).toBe(true);
    expect(isBound({ navigate: 'folder', params: { id: $.selected('folders') } }, none)).toBe(false);
    expect(isBound({ action: 'a', files: { read: $.selected('folders') } }, none)).toBe(false);
  });
  it('counts no prompt, no literal, and no save button', () => {
    expect(isBound({ action: 'scan', prompt: ['collection'] }, none)).toBe(true);
    expect(isBound({ action: 'a', input: { n: 1 } }, {})).toBe(true);
    expect(isBound({ save: true }, {})).toBe(true);
  });
});

describe('files a button hands its action ($files, ADR 0032)', () => {
  const file = (id: string) => ({ id, name: `${id}.pdf`, size: 1, type: 'application/pdf' });
  it("reads ids from an id, a file field's value, or a list of them", () => {
    expect(fileIds('f1')).toEqual(['f1']);
    expect(fileIds(file('f1'))).toEqual(['f1']);
    expect(fileIds([file('f1'), 'f2', file('f1'), { name: 'no id' }, null])).toEqual(['f1', 'f2']);
    expect(fileIds(null)).toEqual([]);
  });

  it('resolves read and write; hands nothing for an empty read; waits on an unresolved one', () => {
    const s = { record: { a: [file('f1')], none: [], filename: 'x.pdf', size: '2048' } };
    expect(resolveFiles({ read: $.record('a') }, s)).toEqual({ read: ['f1'] });
    expect(resolveFiles({ read: $.record('none') }, s)).toBeUndefined();
    expect(resolveFiles(undefined, s)).toBeUndefined();
    expect(
      resolveFiles({ write: { name: $.record('filename'), maxBytes: $.record('size') } }, s),
    ).toEqual({ write: { name: 'x.pdf', maxBytes: 2048 } });
    expect(resolveFiles({ read: $.selected('nope') }, s)).toBeNull();
  });
});

describe('toFilter', () => {
  it('builds the data API JSON filter, several operators on one field', () => {
    expect(
      toFilter(
        [
          $.where('total', 'gt', 1),
          $.where('total', 'lt', 9),
          $.where('owner', 'eq', $.user()),
          $.where('deleted_at', 'null'),
        ],
        scope,
      ),
    ).toEqual({ total: { gt: 1, lt: 9 }, owner: { eq: 'u1' }, deleted_at: { null: true } });
  });
});

describe('cross-key checks', () => {
  const doc = (v: object) => ({ spec: 'zveltio.view/2', type: 'list', collection: 'a', ...v });

  it('refuses the same field and operator twice in one condition list', () => {
    const r = validateView(doc({ filter: [$.where('total', 'gt', 1), $.where('total', 'gt', 5)] }));
    expect(r.ok ? [] : r.issues.map((i) => i.path)).toEqual(['/filter/1']);
    // Two operators on one field are one data API filter: allowed.
    expect(
      validateView(doc({ filter: [$.where('total', 'gt', 1), $.where('total', 'lt', 9)] })).ok,
    ).toBe(true);
    expect(() => toFilter([$.where('a', 'eq', 1), $.where('a', 'eq', 2)], scope)).toThrow();
  });

  it('refuses a prompt that names an input the button binds', () => {
    const r = validateView(
      doc({
        rowActions: [{ action: 'pay', input: { id: $.record('id') }, prompt: ['id', 'note'] }],
      }),
    );
    expect(r.ok ? [] : r.issues.map((i) => i.path)).toEqual(['/rowActions/0/prompt/0']);
  });
});

describe('matches', () => {
  it('checks a row against conditions', () => {
    const row = { status: 'open', total: 5, owner: 'u1', note: null };
    expect(matches(undefined, row, scope)).toBe(true);
    expect(matches([$.where('status', 'eq', 'open'), $.where('total', 'gte', 5)], row, scope)).toBe(
      true,
    );
    expect(matches([$.where('status', 'in', ['done', 'void'])], row, scope)).toBe(false);
    expect(matches([$.where('owner', 'neq', $.user())], row, scope)).toBe(false);
    expect(matches([$.where('note', 'null')], row, scope)).toBe(true);
    expect(matches([$.where('status', 'ilike', 'OP')], row, scope)).toBe(true);
    // An unresolved reference never holds.
    expect(matches([$.where('status', 'eq', $.selected('none'))], row, scope)).toBe(false);
  });
});

describe('generated defaults', () => {
  const fields = [
    { name: 'id', type: 'uuid', is_system: true },
    { name: 'title', type: 'text' },
    { name: 'score', type: 'computed' },
    { name: 'locked', type: 'text', readonly: true },
    ...Array.from({ length: 9 }, (_, i) => ({ name: `f${i}`, type: 'text' })),
  ];
  it('drops system and computed fields; a list stops at eight; a form drops read-only ones', () => {
    const list = defaultView('list', 'notes', fields) as Extract<View, { type: 'list' }>;
    expect(list.fields).toEqual(['title', 'locked', 'f0', 'f1', 'f2', 'f3', 'f4', 'f5']);
    const form = defaultView('form', 'notes', fields) as { fields: string[] };
    expect(form.fields).not.toContain('locked');
    expect(form.fields).toHaveLength(10);
    expect(defaultView('detail', 'notes', fields)).toMatchObject({ record: { $param: 'id' } });
  });

  it('never makes a system, computed or read-only field writable', () => {
    expect(isEditable({ name: 'title', type: 'text' })).toBe(true);
    expect(isEditable({ name: 'id', type: 'uuid', is_system: true })).toBe(false);
    expect(isEditable({ name: 'score', type: 'computed' })).toBe(false);
    expect(isEditable({ name: 'locked', type: 'text', readonly: true })).toBe(false);
  });

  it('falls back to the view’s own fallback, then to the list of its collection', () => {
    const drawn = new Set(['list', 'form']);
    const board: View = { type: 'board', collection: 'tasks', groupBy: 'status' };
    expect(fallbackFor(board, drawn)).toEqual({ type: 'list', collection: 'tasks' });
    const withOwn: View = { ...board, fallback: { type: 'form', collection: 'tasks' } };
    expect(fallbackFor(withOwn, drawn)).toEqual({ type: 'form', collection: 'tasks' });
    expect(fallbackFor({ type: 'tabs', items: [] }, drawn)).toBeNull();
  });
});

describe('actions', () => {
  it('names its own extension’s action or a dependency’s', () => {
    expect(actionPath('billing', 'pay')).toBe('/ext/billing/actions/pay');
    expect(actionPath('billing', 'mail.send')).toBe('/ext/mail/actions/send');
    // A dependency with a scoped name keeps its `/`, as its routes are mounted.
    expect(actionPath('x', 'finance/quotes.approve')).toBe('/ext/finance/quotes/actions/approve');
  });

  it('refuses a name that would leave the action route', () => {
    for (const [ext, action] of [
      ['billing', '..'],
      ['billing', '../admin.x'],
      ['billing', 'a/../b.pay'],
      ['..', 'pay'],
      ['billing', 'pay/../../x'],
      ['billing', 'mail.'],
    ]) {
      expect(() => actionPath(ext, action)).toThrow();
    }
  });

  it('reads a result as navigation, view, file, reveal or values', () => {
    expect(readActionResult({ view: 'mail.compose', params: { draft_id: 'd' } })).toEqual({
      kind: 'navigate',
      view: 'mail.compose',
      params: { draft_id: 'd' },
    });
    expect(readActionResult({ view: { type: 'list', collection: 'x' } }).kind).toBe('view');
    expect(readActionResult({ file: 'f1' })).toEqual({ kind: 'file', file: 'f1' });
    expect(readActionResult({ reveal: 'k' })).toEqual({ kind: 'reveal', value: 'k' });
    expect(readActionResult({ total: 3 })).toEqual({ kind: 'values', values: { total: 3 } });
    expect(readActionResult(null)).toEqual({ kind: 'values', values: null });
    // A tagged object that is none of the closed forms is not values: no guessing.
    const bad = readActionResult({ view: 'mail.compose', extra: 1 });
    expect(bad.kind).toBe('invalid');
  });

  // The shared corpus: the engine's test runs the same results through the
  // published JSON Schema.
  const corpus = JSON.parse(
    readFileSync(join(import.meta.dir, '../../src/tests/fixtures/view-2.json'), 'utf8'),
  ).actionResults as { valid: Record<string, unknown>; invalid: Record<string, unknown> };
  for (const [name, r] of Object.entries(corpus.valid)) {
    it(`reads: ${name}`, () => expect(readActionResult(r).kind).not.toBe('invalid'));
  }
  for (const [name, r] of Object.entries(corpus.invalid)) {
    it(`refuses: ${name}`, () => expect(readActionResult(r).kind).toBe('invalid'));
  }

  it('sorts by the first field, `-` descending', () => {
    expect(toSort('-issued_on')).toEqual({ sort: 'issued_on', order: 'desc' });
    expect(toSort(['name', '-x'])).toEqual({ sort: 'name', order: 'asc' });
    expect(toSort(undefined)).toBeNull();
  });
});
