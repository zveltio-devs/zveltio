// `zveltio.view/2` (ADR 0042): the validator the CLI runs at validate and pack,
// the builder, and the rule that a view names only what its extension owns.
import { describe, expect, it } from 'bun:test';
import { $, isViewDocument, VIEW_SPEC, validateView, view, viewNameIssues } from '../view/index.js';

/** A mail-like inbox: every view kind a container holds, refs, conditions, buttons. */
const inbox = {
  spec: VIEW_SPEC,
  type: 'split',
  title: 'mail.inbox',
  actions: [
    { action: 'sync', input: { account_id: { $selected: 'account' } } },
    { navigate: 'mail.search', params: { account_id: { $selected: 'account' } } },
  ],
  panes: [
    { id: 'account', type: 'list', collection: 'mail_accounts', fields: ['email'], sort: 'email' },
    {
      id: 'messages',
      type: 'list',
      collection: 'mail_messages',
      filter: [{ field: 'account_id', op: 'eq', value: { $selected: 'account' } }],
      sort: '-received_at',
      search: true,
      fields: ['subject', { field: 'is_starred', display: 'flag' }],
      emphasisWhen: [{ field: 'is_read', op: 'eq', value: false }],
      selectable: true,
      bulkActions: [
        {
          action: 'setFlags',
          label: 'mail.markRead',
          input: { message_ids: { $selection: 'id' }, is_read: true },
        },
        {
          action: 'deleteMessages',
          input: { message_ids: { $selection: 'id' } },
          confirm: 'mail.confirm.delete',
          tone: 'danger',
        },
      ],
    },
    {
      id: 'reading',
      type: 'detail',
      collection: 'mail_messages',
      record: { $selected: 'messages' },
      fields: ['subject', 'body_html'],
      panels: [
        {
          type: 'form',
          collection: 'mail_drafts',
          record: { $param: 'draft_id' },
          autosave: true,
          submit: [{ save: true }, { action: 'send', input: { draft_id: { $record: 'id' } } }],
        },
      ],
    },
  ],
};

const issues = (input: unknown) => {
  const r = validateView(input);
  return r.ok ? [] : r.issues;
};

describe('validateView', () => {
  it('accepts a valid view', () => {
    expect(issues(inbox)).toEqual([]);
  });

  it('accepts every view kind', () => {
    const kinds = [
      { type: 'board', collection: 'tasks', groupBy: 'status', move: 'patch' },
      { type: 'timeline', collection: 'tasks', start: 'due_on', scale: 'gantt' },
      { type: 'tree', collection: 'pages', parent: 'parent_id', label: 'title' },
      {
        type: 'matrix',
        collection: 'grants',
        row: 'role',
        column: 'widget',
        value: 'enabled',
        edit: { action: 'setGrant' },
      },
      { type: 'map', collection: 'sites', location: 'position' },
      { type: 'stat', source: { collection: 'invoices', aggregate: 'count' }, format: 'number' },
      { type: 'form', action: 'importCsv', fields: ['file'] },
      { type: 'form', collection: 'settings', record: 'singleton' },
    ];
    expect(issues({ spec: VIEW_SPEC, type: 'tabs', items: kinds })).toEqual([]);
  });

  // The broken fixture: a view/1 page written as if it were view/2. Without the
  // validation every key below would reach a renderer.
  it('refuses URLs, CSS, icons and expressions: they are not part of the vocabulary', () => {
    const broken = {
      spec: VIEW_SPEC,
      type: 'list',
      collection: 'invoices',
      dataSource: '/api/data/invoices',
      fields: [{ field: 'total', class: 'text-error' }],
      rowActions: [{ action: 'pay', icon: 'credit-card' }],
      filter: [
        { field: 'total', op: 'eq', value: '{{ amount * 2 }}' },
        { field: 'x', op: '>' },
      ],
    };
    expect(issues(broken).map((i) => i.path)).toEqual([
      '/dataSource',
      '/fields/0/class',
      '/rowActions/0/icon',
      '/filter/1/op',
    ]);
  });

  it('names the kind the type names, and the missing key', () => {
    expect(issues({ spec: VIEW_SPEC, type: 'detail', collection: 'x' })).toEqual([
      { path: '', message: 'needs "record"' },
    ]);
    expect(issues({ spec: VIEW_SPEC, type: 'gallery', collection: 'x' })[0]?.path).toBe('/type');
  });

  it('refuses names that are not names', () => {
    expect(issues({ spec: VIEW_SPEC, type: 'list', collection: '/api/data/x' })[0]?.path).toBe(
      '/collection',
    );
    expect(
      issues({
        spec: VIEW_SPEC,
        type: 'list',
        collection: 'x',
        rowActions: [{ action: 'https://evil.example/pay' }],
      })[0]?.path,
    ).toBe('/rowActions/0/action');
  });

  it('a form binds a collection or an action, not both and not neither', () => {
    expect(issues({ spec: VIEW_SPEC, type: 'form', collection: 'a', action: 'b' })).not.toEqual([]);
    expect(issues({ spec: VIEW_SPEC, type: 'form', fields: ['a'] })).not.toEqual([]);
  });

  it('a reference is one of the closed set', () => {
    const v = (value: unknown) => ({
      spec: VIEW_SPEC,
      type: 'list',
      collection: 'x',
      filter: [{ field: 'owner', op: 'eq', value }],
    });
    expect(issues(v({ $user: 'id' }))).toEqual([]);
    expect(issues(v({ $today: true }))).toEqual([]);
    expect(issues(v({ $env: 'SECRET' }))).not.toEqual([]);
    expect(issues(v({ $user: 'email' }))).not.toEqual([]);
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
    actions: ['sync', 'setFlags', 'deleteMessages', 'send'],
    dependencies: ['crm'],
  };

  it('passes a view that names only its own collections and actions', () => {
    expect(viewNameIssues(inbox, names)).toEqual([]);
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
    );
    expect(JSON.parse(JSON.stringify(built))).toEqual({
      type: 'split',
      spec: VIEW_SPEC,
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
});
