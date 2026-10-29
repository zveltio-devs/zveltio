// ADR 0012 amendment 2: a field named with the operator prefix is the
// operator's, so `zveltio extension validate` refuses a declared collection
// file that names one — before the engine refuses it at load.
import { afterAll, describe, expect, it } from 'bun:test';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { OPERATOR_FIELD_PREFIX } from '@zveltio/sdk/extension';
import { checkOperatorFieldNames } from './extension-validate.js';

const dir = mkdtempSync(join(tmpdir(), 'zv-opfield-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));
const ship = (name: string, file: unknown) => {
  mkdirSync(join(dir, 'schema/collections'), { recursive: true });
  writeFileSync(join(dir, `schema/collections/${name}.json`), JSON.stringify(file));
};

describe('checkOperatorFieldNames', () => {
  it('refuses a declared field or relation key with the operator prefix', () => {
    const bad = `${OPERATOR_FIELD_PREFIX}bad`;
    ship('tasks', { name: 'tasks', fields: [{ name: 'title', type: 'text' }, { name: bad }] });
    ship('notes', { name: 'notes', relations: [{ field: 'items', targetField: bad }] });
    const out = checkOperatorFieldNames(dir, { collections: ['tasks', 'notes', 'missing'] });
    expect(out.map((e) => [e.code, e.file])).toEqual([
      ['COLLECTION_OPERATOR_FIELD', 'schema/collections/tasks.json'],
      ['COLLECTION_OPERATOR_FIELD', 'schema/collections/notes.json'],
    ]);
  });

  it('passes the extension its own names', () => {
    ship('plain', { name: 'plain', fields: [{ name: 'my', type: 'text' }] });
    expect(checkOperatorFieldNames(dir, { collections: ['plain'] })).toEqual([]);
  });
});
