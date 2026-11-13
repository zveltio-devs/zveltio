/**
 * `planSchema`: the steps between two schema file sets (RFC schema-as-code §6).
 *
 * Each case edits a copy of one baseline and checks the exact steps, so a
 * missed change and a spurious one both fail.
 */

import { describe, expect, it } from 'bun:test';
import { SCHEMA_FORMAT, serialize } from '../../lib/schema-artifact/export.js';
import { planSchema, SchemaFileError } from '../../lib/schema-artifact/plan.js';
import { fieldTypeRegistry } from '../../lib/data/field-type-registry.js';
import { registerCoreFieldTypes } from '../../field-types/index.js';

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
  'zveltio-schema.json': serialize({ format: SCHEMA_FORMAT }),
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
    // A setting left out keeps the instance's value.
    const { displayName: _, ...minimal } = posts();
    expect(plan(files([minimal]))).toEqual([]);
  });

  it('ignores an upstream credential a file pulled before the export dropped it', () => {
    const virt = (virtualConfig: unknown): Obj => ({
      ...posts(),
      sourceType: 'virtual',
      virtualConfig,
    });
    const current = files([virt({ auth_type: 'bearer', id_field: 'id' })]);
    const steps = (vc: unknown) => planSchema(current, files([virt(vc)]));
    expect(steps({ auth_type: 'bearer', id_field: 'id', auth_value: 'secret' })).toEqual([]);
    // Stored as a jsonb string, pulled as one.
    expect(
      steps(JSON.stringify({ auth_type: 'bearer', id_field: 'id', auth_value: 'secret' })),
    ).toEqual([]);
    const changed = steps({ auth_type: 'basic', id_field: 'id', auth_value: 'secret' });
    expect(changed.map((s) => s.action)).toEqual([
      'set virtualConfig {"auth_type":"bearer","id_field":"id"} → {"auth_type":"basic","id_field":"id"}',
    ]);
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
      // New fields are appended, so one placed before a kept field is a reorder.
      '~ posts reorder fields (summary, body)',
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

  it('leaves out the grants the engine gives by itself', () => {
    const member = (actions: string[]) => [
      { name: 'tenant_member', permissions: [{ resource: 'posts', actions }] },
    ];
    // Present on one side and absent on the other, the defaults plan nothing;
    // a non-default action of the same role still does.
    expect(
      planSchema(files([posts()], member([])), files([posts()], member(['create', 'read']))),
    ).toEqual([]);
    expect(
      planSchema(files([posts()], member([])), files([posts()], member(['delete']))).map(
        (s) => s.action,
      ),
    ).toEqual(['grant posts delete']);
  });

  it('never creates or removes a role the engine seeds', () => {
    const roles = [
      { name: 'editor', permissions: [] },
      { name: 'tenant_owner', permissions: [{ resource: 'posts', actions: ['delete'] }] },
    ];
    // On one side only: the grant moves, the role stays the engine's.
    expect(plan(files([posts()], roles))).toEqual(['+ role tenant_owner grant posts delete']);
    expect(planSchema(files([posts()], roles), files([posts()])).map((s) => s.action)).toEqual([
      'revoke posts delete',
    ]);
  });

  it('plans a revoked default both ways, and never creates or removes its role', () => {
    const editor = { name: 'editor', permissions: [] };
    const revoking = (actions: string[]) =>
      files(
        [posts()],
        [editor, { name: 'tenant_member', revokedDefaults: [{ resource: 'posts', actions }] }],
      );
    // The role exists implicitly: no `create role`, and a file without it
    // restores what the instance had revoked instead of removing the role.
    expect(plan(revoking(['read']))).toEqual(['- role tenant_member revoke default posts read']);
    expect(
      planSchema(revoking(['create', 'read']), files([posts()])).map(
        (s) => `${s.change} ${s.action} ${s.op?.kind}`,
      ),
    ).toEqual(['+ restore default posts create grant', '+ restore default posts read grant']);
    expect(planSchema(revoking(['read']), revoking(['read']))).toEqual([]);
    // Only a default can be listed as revoked.
    expect(() => plan(revoking(['delete']))).toThrow(/not a default grant/);
    // A format-2 file has no revokedDefaults, so it would restore every one.
    expect(() =>
      plan({ ...files([posts()]), 'zveltio-schema.json': serialize({ format: 2 }) }),
    ).toThrow(/format 2 is not supported/);
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
    // Format 1 knows no validation groups: planned, it would remove every one.
    expect(bad({ ...base, 'zveltio-schema.json': serialize({ format: 1 }) })).toThrow(/format 1/);
    const { 'roles.json': _, ...noRoles } = base;
    expect(bad(noRoles)).toThrow(/roles.json is missing/);
  });

  it('plans validation groups by name, their members by rule key', () => {
    const grouped = (rules: Obj[], extra: Obj = {}): Obj => ({
      ...posts(),
      validation: [
        { field: 'title', rule: 'minLength', config: { value: 3 } },
        { field: 'title', rule: 'pattern', config: { pattern: '^A' } },
      ],
      validationGroups: [{ name: 'either', field: 'title', logic: 'OR', rules, ...extra }],
    });
    const both = [
      { rule: 'minLength', config: { value: 3 } },
      { rule: 'pattern', config: { pattern: '^A' } },
    ];
    const current = files([grouped(both)]);
    const steps = (d: Obj) => planSchema(current, files([d])).map((s) => s.action);
    // Member order is not a change.
    expect(steps(grouped([...both].reverse()))).toEqual([]);
    expect(steps(grouped([both[0]!]))).toEqual(['alter validation group either']);
    expect(() => steps(grouped([{ rule: 'maxLength', config: { value: 9 } }]))).toThrow(
      /validation group "either" names rule maxLength/,
    );
    expect(() => steps(grouped(both, { logic: 'XOR' }))).toThrow(/AND or OR/);
    const twice = grouped(both);
    twice.validationGroups = [
      ...(twice.validationGroups as Obj[]),
      { name: 'either', field: 'title' },
    ];
    expect(() => steps(twice)).toThrow(/either twice/);
  });

  describe('migrations', () => {
    const mig = (id: string, ops: Obj[]) => ({
      [`migrations/${id}.json`]: serialize({ id, ops }),
    });
    const renamed = () => {
      const p = posts();
      (p.fields as Obj[])[0].name = 'headline';
      return p;
    };
    const ID = '20261005T100000-headline';
    const rename = mig(ID, [
      { op: 'renameField', collection: 'posts', from: 'title', to: 'headline' },
    ]);

    it('plans the state diff against what the pending migrations leave', () => {
      expect(plan({ ...files([renamed()]), ...rename })).toEqual([
        `~ posts rename field title → headline (migration ${ID})`,
      ]);
      // Without it, the rename is a drop and an add.
      expect(plan(files([renamed()]))[0]).toBe('- posts drop field title !');
    });

    it('carries a unique index through a rename, and drops it with its field', () => {
      const indexed = (p: Obj, fields: string[]) => ({
        ...p,
        indexes: [{ fields, unique: true }],
      });
      const current = files([indexed(posts(), ['title', 'body'])]);
      // Postgres renames the index's column with the field, and drops the index with it.
      expect(
        planSchema(current, {
          ...files([indexed(renamed(), ['headline', 'body'])]),
          ...rename,
        }).map((s) => s.action),
      ).toEqual([`rename field title → headline (migration ${ID})`]);
      const noBody = posts();
      noBody.fields = [{ name: 'title', type: 'text', required: true }];
      expect(
        planSchema(current, {
          ...files([noBody]),
          ...mig('20261005T110000-x', [{ op: 'dropField', collection: 'posts', field: 'body' }]),
        }).map((s) => s.action),
      ).toEqual(['drop field body (migration 20261005T110000-x)']);
    });

    it('skips an applied migration, and refuses one whose file changed', () => {
      const desired = { ...files([renamed()]), ...rename };
      const once = planSchema(files([posts()]), desired);
      const op = once[0].op as { checksum: string };
      // Applied: the instance already has the rename, so nothing is left.
      expect(planSchema(files([renamed()]), desired, new Map([[ID, op.checksum]]))).toEqual([]);
      expect(() => planSchema(files([renamed()]), desired, new Map([[ID, 'other']]))).toThrow(
        /changed after it was applied/,
      );
    });

    it('marks drops, type changes and removed roles destructive', () => {
      const p = posts();
      p.fields = [{ name: 'title', type: 'int', required: true }];
      const steps = plan({
        ...files([p], []),
        ...mig('20261005T110000-x', [
          { op: 'dropField', collection: 'posts', field: 'body' },
          { op: 'changeFieldType', collection: 'posts', field: 'title', to: 'int' },
          { op: 'dropRole', role: 'editor' },
        ]),
      });
      expect(steps.filter((s) => s.endsWith('!'))).toHaveLength(3);
      expect(steps.filter((s) => !s.includes('migration'))).toEqual([]);
    });

    it('refuses a malformed migration', () => {
      const bad = (m: Record<string, string>) => () =>
        planSchema(files([posts()]), { ...files([posts()]), ...m });
      expect(bad(mig('yesterday', [{ op: 'dropRole', role: 'editor' }]))).toThrow(/timestamp/);
      expect(bad(mig(ID, []))).toThrow(/ops is empty/);
      expect(bad(mig(ID, [{ op: 'renameCollection', from: 'posts', to: 'p' }]))).toThrow(
        /not supported yet/,
      );
      expect(bad(mig(ID, [{ op: 'sql', query: 'DROP TABLE x' }]))).toThrow(/unknown op/);
      expect(bad(mig(ID, [{ op: 'dropRole' }]))).toThrow(/needs role/);
      expect(bad(mig(ID, [{ op: 'dropField', collection: 'nope', field: 'x' }]))).toThrow(
        /does not exist/,
      );
      expect(
        bad({
          [`migrations/${ID}.json`]: serialize({
            id: 'other',
            ops: [{ op: 'dropRole', role: 'editor' }],
          }),
        }),
      ).toThrow(/does not match/);
    });
  });

  it('alters a relation in place only where PATCH can', () => {
    const rel = { name: 'posts_author', type: 'm2o', field: 'author', target: 'users' };
    const p = (r: Obj) => ({ ...posts(), relations: [r] });
    const steps = (r: Obj) => planSchema(files([p(rel)]), files([p(r)]));
    expect(steps({ ...rel, onDelete: 'CASCADE' })[0].op?.kind).toBe('putRelation');
    expect(steps({ ...rel, target: 'people' })[0].op).toBeUndefined();
  });

  it('plans nothing for a relation that leaves out what the engine stores by default', () => {
    const p = (r: Obj) => ({ ...posts(), relations: [r] });
    const same = (left: Obj, stored: Obj) =>
      planSchema(files([p({ ...left, ...stored })]), files([p(left)]));
    const defaults = { onDelete: 'SET NULL', onUpdate: 'CASCADE', metadata: {} };
    const m2o = { name: 'posts_author', type: 'm2o', field: 'author', target: 'users' };
    expect(same(m2o, { ...defaults, targetField: 'id' })).toEqual([]);
    const o2m = { name: 'posts_comments', type: 'o2m', field: 'comments', target: 'comments' };
    expect(same(o2m, { ...defaults, targetField: 'posts_id' })).toEqual([]);
  });

  // ADR 0024 §6: an extension that turns its text field `secret` (auth/ldap
  // 2.0.0 → 2.1.0) had no op, so every install of 2.0.0 refused to load 2.1.0.
  describe('a text field turned secret', () => {
    const withField = (f: Obj): Obj => ({ ...posts(), fields: [(posts().fields as Obj[])[0], f] });
    const was = { name: 'body', type: 'text', required: true, encrypted: true, defaultValue: 'x' };
    const now = { name: 'body', type: 'secret', required: true };
    const steps = (from: Obj, to: Obj, intoSecret = true) =>
      planSchema(files([withField(from)]), files([withField(to)]), new Map(), { intoSecret });

    it("is one step in an extension's plan, not destructive, and leaves nothing owed", () => {
      const out = steps(was, now);
      expect(out).toEqual([
        {
          change: '~',
          target: 'posts',
          action: 'change field body type text → secret',
          op: { kind: 'intoSecret', collection: 'posts', field: 'body' },
        },
      ]);
      // A unique key and an index go with the retype too.
      expect(steps({ ...was, unique: true, indexed: true }, now)).toHaveLength(1);
      // From a textarea, as auth/saml's private_key.
      expect(
        steps({ name: 'body', type: 'textarea' }, { name: 'body', type: 'secret' }),
      ).toHaveLength(1);
    });

    it('plans what else the file changes against the field the retype leaves', () => {
      const out = steps(was, { ...now, required: false, label: 'Body' });
      expect(out.map((s) => s.op?.kind)).toEqual(['intoSecret', 'alterField']);
      expect(out[1].action).toBe('alter field body (label, required)');
    });

    it('stays refused outside an extension, and for any other type change', () => {
      const refused = (from: Obj, to: Obj, intoSecret = true) => {
        const [only] = steps(from, to, intoSecret);
        expect(only).toMatchObject({ destructive: true });
        expect(only.op).toBeUndefined();
      };
      refused(was, now, false);
      refused(was, { ...now, type: 'integer' });
      refused({ name: 'body', type: 'boolean' }, now);
      refused({ name: 'body', type: 'password' }, now);
    });
  });

  // ADR 0042 slice 5: mail's `body_html` (textarea) becomes `richtext` and its
  // draft `attachments` (json) become `file`. Same column, so the values stay.
  describe('a field retyped to a type with the same column', () => {
    registerCoreFieldTypes(fieldTypeRegistry);
    const withField = (f: Obj): Obj => ({ ...posts(), fields: [(posts().fields as Obj[])[0], f] });
    const steps = (from: string, to: string, extension = true, more: Obj = {}) =>
      planSchema(
        files([withField({ name: 'body', type: from })]),
        files([withField({ name: 'body', type: to, ...more })]),
        new Map(),
        { intoSecret: extension },
      );

    it("is one step in an extension's plan, keeping every value", () => {
      for (const [from, to] of [
        ['textarea', 'richtext'],
        ['json', 'file'],
        ['text', 'richtext'],
      ]) {
        expect(steps(from, to)).toEqual([
          {
            change: '~',
            target: 'posts',
            action: `change field body type ${from} → ${to}`,
            op: { kind: 'retype', collection: 'posts', field: 'body', to },
          },
        ]);
      }
      // What else the file changes is planned against the retyped field.
      expect(steps('textarea', 'richtext', true, { label: 'Body' }).map((s) => s.op?.kind)).toEqual(
        ['retype', 'alterField'],
      );
    });

    it('stays refused for another column, out of secret, outside an extension', () => {
      for (const [from, to, ext] of [
        ['text', 'integer', true],
        ['json', 'textarea', true],
        ['secret', 'text', true],
        ['textarea', 'richtext', false],
        // Same `text` column, different meaning: a hash shown, plaintext never
        // hashed, a computed field with no column.
        ['password', 'textarea', true],
        ['text', 'password', true],
        ['computed', 'text', true],
        ['richtext', 'computed', true],
        ['json', 'file', false],
      ] as const) {
        const [only] = steps(from, to, ext);
        expect(only).toMatchObject({ destructive: true });
        expect(only.op).toBeUndefined();
      }
    });
  });
});
