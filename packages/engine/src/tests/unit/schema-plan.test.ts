/**
 * `planSchema`: the steps between two schema file sets (RFC schema-as-code §6).
 *
 * Each case edits a copy of one baseline and checks the exact steps, so a
 * missed change and a spurious one both fail.
 */

import { describe, expect, it } from 'bun:test';
import { serialize } from '../../lib/schema-artifact/export.js';
import { planSchema, SchemaFileError } from '../../lib/schema-artifact/plan.js';

type Obj = Record<string, unknown>;

const posts = (): Obj => ({
  $schema: 'https://zveltio.com/schema/v1/collection.json',
  name: 'posts',
  displayName: 'Posts',
  fields: [
    { name: 'title', type: 'text', required: true },
    { name: 'body', type: 'text' },
  ],
  rowRules: [{ role: 'editor', field: 'author', op: 'eq', value: 'user.id' }],
  columnPermissions: [{ role: 'viewer', column: 'body', read: true, write: false }],
});

const files = (cols: Obj[], roles: Obj[] = [{ name: 'editor', permissions: [] }]) => ({
  'zveltio-schema.json': serialize({ format: 1 }),
  'roles.json': serialize({ roles }),
  ...Object.fromEntries(cols.map((c) => [`collections/${c.name}.json`, serialize(c)])),
});

const plan = (desired: Record<string, string>) =>
  planSchema(files([posts()]), desired).map(
    (s) => `${s.change} ${s.target} ${s.action}${s.destructive ? ' !' : ''}`,
  );

describe('planSchema', () => {
  it('is empty for the same files, and for defaults written out', () => {
    expect(plan(files([posts()]))).toEqual([]);
    const explicit = posts();
    explicit.fields = [
      { name: 'title', type: 'text', required: true },
      { name: 'body', type: 'text', required: false, unique: false },
    ];
    (explicit.rowRules as Obj[])[0].enabled = true;
    expect(plan(files([explicit]))).toEqual([]);
  });

  it('adds, alters, reorders and drops fields', () => {
    const p = posts();
    p.fields = [
      { name: 'summary', type: 'text' },
      { name: 'body', type: 'text', indexed: true },
    ];
    expect(plan(files([p]))).toEqual([
      '- posts drop field title !',
      '+ posts add field summary (text)',
      '~ posts alter field body (indexed)',
    ]);
    p.fields = [
      { name: 'body', type: 'int' },
      { name: 'title', type: 'text', required: true },
    ];
    expect(plan(files([p]))).toEqual([
      '~ posts change field body type text → int !',
      '~ posts reorder fields (body, title)',
    ]);
  });

  it('diffs collection settings and keyed lists', () => {
    const p = posts();
    p.displayName = 'Articles';
    p.rowRules = [];
    p.columnPermissions = [{ role: 'viewer', column: 'body', read: false, write: false }];
    p.relations = [{ name: 'posts_author', type: 'm2o', field: 'author', target: 'users' }];
    expect(plan(files([p]))).toEqual([
      '~ posts set displayName "Posts" → "Articles"',
      '+ posts add relation posts_author',
      '- posts remove row rule editor: author eq user.id',
      '~ posts alter column permission viewer: body',
    ]);
  });

  it('creates and drops collections', () => {
    const comments = {
      name: 'comments',
      displayName: 'Comments',
      fields: [{ name: 'text', type: 'text', required: false }],
      rowRules: [{ role: 'editor', field: 'text', op: 'eq', value: 'user.id' }],
    };
    expect(plan(files([posts(), comments]))).toEqual([
      '+ comments create collection (1 fields)',
      '+ comments add row rule editor: text eq user.id',
    ]);
    expect(plan(files([]))).toEqual(['- posts drop collection !']);
  });

  it('diffs roles and their global grants', () => {
    expect(
      plan(
        files(
          [posts()],
          [{ name: 'author', permissions: [{ resource: 'posts', actions: ['create'] }] }],
        ),
      ),
    ).toEqual([
      '+ role author create role',
      '+ role author grant posts create',
      '- role editor remove role !',
    ]);
  });

  it('refuses malformed files instead of planning around them', () => {
    const bad = (f: Record<string, string>) => () => planSchema(files([posts()]), f);
    const base = files([posts()]);
    expect(bad({ ...base, 'collections/posts.json': '{' })).toThrow(SchemaFileError);
    expect(bad({ ...base, 'collections/other.json': serialize(posts()) })).toThrow(
      /does not match/,
    );
    expect(
      bad({ ...base, 'collections/posts.json': serialize({ ...posts(), tenantId: 'x' }) }),
    ).toThrow(/unknown key tenantId/);
    expect(bad({ ...base, 'settings.json': '{}' })).toThrow(/not a schema file/);
    expect(bad({ ...base, 'zveltio-schema.json': serialize({ format: 2 }) })).toThrow(/format 2/);
    const { 'roles.json': _, ...noRoles } = base;
    expect(bad(noRoles)).toThrow(/roles.json is missing/);
  });
});
