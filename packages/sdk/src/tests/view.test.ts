// `zveltio.view/2` (ADR 0042): the validator the CLI runs at validate and pack,
// the builder, and what the schema cannot see (names, panes, keys).
// `fixtures/view-2.json` is shared with the engine's test, which runs the same
// documents through its own check of the published JSON Schema.
import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { $, isViewDocument, VIEW_SPEC, validateView, view, viewNameIssues } from '../view/index.js';
// Parsed, not imported: an import would turn the `__proto__` key into a prototype.
// Resolved through src/ so the copy tsc compiles into dist/tests finds it too.
// Parsed, not imported: an import would turn the `__proto__` key into a prototype.
const fixtures = JSON.parse(
  readFileSync(join(import.meta.dir, '../../src/tests/fixtures/view-2.json'), 'utf8'),
) as {
  valid: Record<string, unknown>;
  invalid: Record<string, unknown>;
};

const issues = (input: unknown) => {
  const r = validateView(input);
  return r.ok ? [] : r.issues;
};
const paths = (input: unknown) => issues(input).map((i) => i.path);

describe('validateView', () => {
  for (const [name, doc] of Object.entries(fixtures.valid)) {
    it(`accepts: ${name}`, () => expect(issues(doc)).toEqual([]));
  }
  for (const [name, doc] of Object.entries(fixtures.invalid)) {
    it(`refuses: ${name}`, () => expect(issues(doc)).not.toEqual([]));
  }

  // The broken fixture: a view/1 page written as if it were view/2. Without the
  // validation every key below would reach a renderer.
  it('names each key that is not part of the vocabulary', () => {
    expect(paths(fixtures.invalid['view/1 habits'])).toEqual([
      '/dataSource',
      '/fields/0/class',
      '/rowActions/0/icon',
    ]);
    expect(paths(fixtures.invalid['unknown key deep in a panel'])).toEqual([
      '/panes/1/panels/0/endpoint',
    ]);
  });

  it('refuses keys an object inherits', () => {
    for (const key of ['constructor', 'toString', '__proto__']) {
      expect(paths(fixtures.invalid[key])).toEqual([`/${key}`]);
    }
  });

  it('shapes a condition by its operator', () => {
    expect(paths(fixtures.invalid['in without a list'])).toEqual(['/filter/0/value']);
    expect(paths(fixtures.invalid['null with a value'])).toEqual(['/filter/0/value']);
    expect(paths(fixtures.invalid['eq without a value'])).toEqual(['/filter/0']);
  });

  it('names the kind the type names, and the missing key', () => {
    expect(issues(fixtures.invalid['detail without a record'])).toEqual([
      { path: '', message: 'needs "record"' },
    ]);
    expect(paths(fixtures.invalid['an unknown kind'])[0]).toBe('/type');
  });

  it('a view/1 schema is not a view/2 document', () => {
    const v1 = { sduiSchema: 1, title: 't', resources: [{ id: 'r', dataSource: '/ext/x/r' }] };
    expect(isViewDocument(v1)).toBe(false);
    expect(issues(v1)).toEqual([{ path: '/spec', message: `must be "${VIEW_SPEC}"` }]);
  });
});

describe('viewNameIssues', () => {
  const names = {
    collections: ['mail_accounts', 'mail_messages', 'mail_drafts'],
    actions: ['sync', 'setFlags', 'deleteMessages', 'send', 'pay'],
    dependencies: ['crm'],
  };

  it('passes a view that names only its own collections and actions', () => {
    expect(viewNameIssues(fixtures.valid.inbox, names)).toEqual([]);
  });

  it("refuses another extension's collection and an undeclared action; allows a dependency's action", () => {
    const v = view.document(
      view.list({
        collection: 'invoices',
        rowActions: [{ action: 'archive' }, { action: 'crm.link' }, { action: 'billing.pay' }],
      }),
    );
    expect(viewNameIssues(v, names).map((i) => i.path)).toEqual([
      '/collection',
      '/rowActions/0/action',
      '/rowActions/2/action',
    ]);
  });

  it("reads an action's input as values: a key named action or collection is not a reference", () => {
    const v = view.document(
      view.list({
        collection: 'mail_messages',
        rowActions: [{ action: 'pay', input: { action: 'refund', collection: 'x' } }],
      }),
    );
    expect(viewNameIssues(v, names)).toEqual([]);
  });

  it('a $selected names an earlier pane of an enclosing split; pane ids are unique', () => {
    const v = view.document(
      view.split({
        actions: [{ action: 'sync', input: { a: $.selected('second') } }],
        panes: [
          view.list({
            id: 'first',
            collection: 'mail_messages',
            filter: [$.where('a', 'eq', $.selected('second'))],
          }),
          view.list({
            id: 'second',
            collection: 'mail_messages',
            filter: [$.where('a', 'eq', $.selected('first'))],
          }),
          view.detail({ id: 'first', collection: 'mail_messages', record: $.selected('nowhere') }),
        ],
      }),
    );
    expect(viewNameIssues(v, names).map((i) => i.path)).toEqual([
      '/panes/0/filter/0/value/$selected',
      '/panes/2/id',
      '/panes/2/record/$selected',
    ]);
  });

  it('navigate and open name a view of the extension; a message key must be shipped', () => {
    const v = view.document(
      view.list({
        collection: 'mail_messages',
        title: 'mail.inbox',
        open: 'mail.thread',
        rowActions: [
          { navigate: 'mail.nowhere', label: 'mail.typo' },
          { action: 'send', label: 'Send' },
        ],
      }),
    );
    const found = viewNameIssues(v, {
      ...names,
      views: ['mail.thread'],
      messageKeys: ['mail.inbox'],
    });
    expect(found.map((i) => i.path)).toEqual(['/rowActions/0/navigate', '/rowActions/0/label']);
  });

  it('reports a field the bound collection does not declare, and only with fields given', () => {
    const v = {
      type: 'split',
      panes: [
        {
          type: 'list',
          collection: 'mail_messages',
          fields: [
            'subject',
            { field: 'sujbect', label: 'Subject' },
            { field: 'subject', fallback: 'sbj' },
          ],
          filter: [{ field: 'read', op: 'eq', value: false }],
          sort: ['-created_at', 'sent'],
          rowActions: [{ action: 'send', label: 'Send', input: { subject: 'x' } }],
        },
        { type: 'board', collection: 'mail_messages', groupBy: 'folder', card: ['subject'] },
        { type: 'stat', source: { collection: 'mail_messages', aggregate: 'sum', field: 'size' } },
        {
          type: 'detail',
          collection: 'mail_messages',
          record: { $param: 'id' },
          onOpen: { action: 'send', when: [{ field: 'unread', op: 'eq', value: true }] },
        },
      ],
    };
    const fields = new Map([['mail_messages', ['id', 'created_at', 'subject', 'folder']]]);
    expect(viewNameIssues(v, { ...names, fields }).map((i) => i.path)).toEqual([
      '/panes/0/fields/1/field',
      '/panes/0/fields/2/fallback',
      '/panes/0/filter/0/field',
      '/panes/0/sort/1',
      '/panes/2/source/field',
      '/panes/3/onOpen/when/0/field',
    ]);
    expect(viewNameIssues(v, names)).toEqual([]);
  });
});

describe('builder', () => {
  it('emits the JSON a hand-written file would hold, and it validates', () => {
    const built = view.document(
      view.split({
        panes: [
          view.list({ id: 'account', collection: 'mail_accounts', fields: ['email'] }),
          view.detail({
            collection: 'mail_messages',
            record: $.selected('account'),
            panels: [
              view.list({
                collection: 'mail_drafts',
                filter: [$.where('owner', 'eq', $.user()), $.where('sent_at', 'null')],
              }),
            ],
          }),
        ],
      }),
      'mail.drafts',
    );
    expect(built).toEqual({
      type: 'split',
      spec: VIEW_SPEC,
      id: 'mail.drafts',
      panes: [
        { type: 'list', id: 'account', collection: 'mail_accounts', fields: ['email'] },
        {
          type: 'detail',
          collection: 'mail_messages',
          record: { $selected: 'account' },
          panels: [
            {
              type: 'list',
              collection: 'mail_drafts',
              filter: [
                { field: 'owner', op: 'eq', value: { $user: 'id' } },
                { field: 'sent_at', op: 'null' },
              ],
            },
          ],
        },
      ],
    });
    expect(issues(built)).toEqual([]);
  });

  it('drops undefined keys, as a file would not hold them', () => {
    const sorted = false;
    const built = view.document(
      view.list({ collection: 'a', sort: sorted ? 'name' : undefined, rowActions: undefined }),
    );
    expect(Object.keys(built)).toEqual(['type', 'collection', 'spec']);
    expect(issues(built)).toEqual([]);
  });
});
