// What every `view/2` renderer shares (ADR 0042 decision 8): references, the
// data API filter, `when`, the generated defaults, the fallback, action results.
import { describe, expect, it } from 'bun:test';
import {
  $,
  actionPath,
  defaultView,
  fallbackFor,
  matches,
  readActionResult,
  resolveInput,
  toFilter,
  toSort,
  type View,
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
  });

  it('sorts by the first field, `-` descending', () => {
    expect(toSort('-issued_on')).toEqual({ sort: 'issued_on', order: 'desc' });
    expect(toSort(['name', '-x'])).toEqual({ sort: 'name', order: 'asc' });
    expect(toSort(undefined)).toBeNull();
  });
});
