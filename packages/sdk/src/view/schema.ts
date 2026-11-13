/**
 * `zveltio.view/2` — the specification of an extension's views (ADR 0042).
 *
 * THE SINGLE SOURCE. `scripts/gen-view-spec.ts` derives from this object the
 * TypeScript types (`types.generated.ts`) and the published JSON Schema
 * (`packages/sdk/schemas/view-2.schema.json`); `bun run check:view-spec` fails
 * when either is stale. Edit here, then run `bun run scripts/gen-view-spec.ts`.
 *
 * A view is semantic: it names collections, fields and actions, never a URL,
 * an HTTP verb, a CSS class, an icon or an expression. Every object is closed
 * (`additionalProperties: false`), so a key the vocabulary does not have — a
 * `dataSource`, an `endpoint`, a `class` — is refused rather than ignored.
 * Additions inside `view/2` are new optional keys or view kinds; removing or
 * narrowing anything is `view/3`.
 */

import type { FilterOp } from '../extension/index.js';

export const VIEW_SPEC = 'zveltio.view/2';

/** The data API's filter operators: a view's conditions use exactly these. */
const FILTER_OPS = [
  'eq',
  'neq',
  'lt',
  'lte',
  'gt',
  'gte',
  'like',
  'ilike',
  'not_contains',
  'starts_with',
  'ends_with',
  'in',
  'not_in',
  'null',
  'not_null',
  'near',
  'within',
] as const satisfies readonly FilterOp[];
// A data API operator added to `FilterOp` and not here fails to compile.
type _AllFilterOps = Exclude<FilterOp, (typeof FILTER_OPS)[number]> extends never ? true : never;
const _allFilterOps: _AllFilterOps = true;
void _allFilterOps;

const LIST_OPS: readonly string[] = ['in', 'not_in'];
const NULL_OPS: readonly string[] = ['null', 'not_null'];

type Schema = Record<string, unknown>;

const ref = (name: string): Schema => ({ $ref: `#/$defs/${name}` });
const arrayOf = (items: Schema, minItems?: number): Schema =>
  minItems === undefined ? { type: 'array', items } : { type: 'array', items, minItems };
const closed = (description: string, properties: Schema, required: string[] = []): Schema => ({
  type: 'object',
  description,
  properties,
  ...(required.length > 0 ? { required } : {}),
  additionalProperties: false,
});

/** Keys every view kind accepts. */
const common: Schema = {
  id: ref('PaneId'),
  title: ref('Text'),
  actions: {
    ...ref('Buttons'),
    description: "Toolbar actions of this view; a detail's act on the record it shows (`$record`).",
  },
  fallback: {
    ...ref('View'),
    description: 'What a front end that does not know this view kind draws instead.',
  },
};

const kind = (type: string, description: string, properties: Schema, required: string[]) =>
  closed(description, { type: { const: type }, ...common, ...properties }, ['type', ...required]);

/** What both forms (collection-bound, action-bound) accept. */
const formProps: Schema = {
  fields: ref('Fields'),
  sections: arrayOf(
    closed('A titled group of fields.', { title: ref('Text'), fields: ref('Fields') }, ['fields']),
    1,
  ),
  lines: closed(
    'Line items: records of another collection pointing at this one.',
    { collection: ref('Name'), fk: ref('Name'), fields: ref('Fields'), order: ref('Name') },
    ['collection', 'fk'],
  ),
  submit: ref('Buttons'),
  recalc: { ...ref('ActionCall'), description: 'Recomputes values on the server.' },
  autosave: { type: 'boolean' },
};

const VIEW_KINDS = [
  'ListView',
  'FormView',
  'DetailView',
  'BoardView',
  'TimelineView',
  'TreeView',
  'MatrixView',
  'MapView',
  'StatView',
  'SplitView',
  'TabsView',
] as const;

const defs: Record<string, Schema> = {
  Name: {
    type: 'string',
    pattern: '^[a-z][a-z0-9_]*$',
    maxLength: 63,
    description: 'A collection or field name.',
  },
  ActionName: {
    type: 'string',
    pattern: '^([a-z][a-z0-9-]*(/[a-z][a-z0-9-]*)*\\.)?[a-z][a-zA-Z0-9]*$',
    description:
      "One of this extension's actions, or `<dependency>.<action>` for a dependency's (ADR 0014).",
  },
  ViewId: {
    type: 'string',
    pattern: '^[a-z][a-z0-9-]*(\\.[a-z][a-zA-Z0-9-]*)*$',
    description: 'The id of a view, e.g. `mail.compose`.',
  },
  PaneId: {
    type: 'string',
    pattern: '^[a-z][a-zA-Z0-9_]*$',
    description: 'The id of a view inside a container; `$selected` names it.',
  },
  Text: {
    type: 'string',
    minLength: 1,
    maxLength: 200,
    description: 'A message key of the extension, or literal text.',
  },
  Tone: {
    enum: ['neutral', 'info', 'success', 'warning', 'danger', 'muted'],
    description: 'A semantic tone; each front end picks its colours.',
  },
  Ref: {
    description: 'A value the front end fills in. Nothing else is computed in a view.',
    anyOf: [
      closed('A field of the current record.', { $record: ref('Name') }, ['$record']),
      closed('The id of the record selected in a pane.', { $selected: ref('PaneId') }, [
        '$selected',
      ]),
      closed('A field of every selected record (bulk actions).', { $selection: ref('Name') }, [
        '$selection',
      ]),
      closed('A parameter the view was opened with.', { $param: ref('Name') }, ['$param']),
      closed("The signed-in user's id.", { $user: { const: 'id' } }, ['$user']),
      closed("Today's date.", { $today: { const: true } }, ['$today']),
    ],
  },
  Literal: { type: ['string', 'number', 'boolean', 'null'] },
  Value: {
    anyOf: [ref('Literal'), ref('Ref'), arrayOf({ anyOf: [ref('Literal'), ref('Ref')] })],
  },
  Input: {
    type: 'object',
    description: "An action's input, or a view's parameters, by name.",
    additionalProperties: ref('Value'),
  },
  Condition: {
    description: 'A data API condition on one field; its value is shaped by the operator.',
    anyOf: [
      closed(
        'Compares the field with a value.',
        {
          field: ref('Name'),
          op: { enum: FILTER_OPS.filter((o) => !LIST_OPS.includes(o) && !NULL_OPS.includes(o)) },
          value: ref('Value'),
        },
        ['field', 'op', 'value'],
      ),
      closed(
        'The field is (not) one of a list.',
        {
          field: ref('Name'),
          op: { enum: [...LIST_OPS] },
          value: { anyOf: [arrayOf({ anyOf: [ref('Literal'), ref('Ref')] }), ref('Ref')] },
        },
        ['field', 'op', 'value'],
      ),
      closed('The field is (not) empty.', { field: ref('Name'), op: { enum: [...NULL_OPS] } }, [
        'field',
        'op',
      ]),
    ],
  },
  Conditions: { ...arrayOf(ref('Condition'), 1), description: 'All must hold.' },
  Sort: {
    description: 'A field, or several; `-field` sorts descending.',
    anyOf: [
      { type: 'string', pattern: '^-?[a-z][a-z0-9_]*$' },
      arrayOf({ type: 'string', pattern: '^-?[a-z][a-z0-9_]*$' }, 1),
    ],
  },
  Field: {
    description: 'A field by name; its type, label and editor come from the collection.',
    anyOf: [
      ref('Name'),
      closed(
        'A field with presentation hints.',
        {
          field: ref('Name'),
          label: ref('Text'),
          display: { enum: ['badge', 'flag', 'mono', 'elapsed'] },
          tones: {
            type: 'object',
            description: 'A tone per value (enum fields).',
            additionalProperties: ref('Tone'),
          },
          readOnly: { type: 'boolean' },
          fallback: {
            ...ref('Name'),
            description: 'The field shown instead while this one is empty.',
          },
        },
        ['field'],
      ),
    ],
  },
  Fields: arrayOf(ref('Field'), 1),
  ActionCall: closed('Runs an action.', { action: ref('ActionName'), input: ref('Input') }, [
    'action',
  ]),
  Change: {
    description: '`patch` writes the record through the data API; or an action does it.',
    anyOf: [{ const: 'patch' }, ref('ActionCall')],
  },
  Button: {
    anyOf: [
      closed(
        'Runs an action.',
        {
          action: ref('ActionName'),
          label: ref('Text'),
          tone: ref('Tone'),
          input: ref('Input'),
          prompt: { ...arrayOf(ref('Name'), 1), description: 'Input fields to ask for.' },
          confirm: ref('Text'),
          when: ref('Conditions'),
          busyWhen: {
            ...ref('Conditions'),
            description:
              'While the record meets these, the work the action started is under way: the button is busy, and the front end reads the record again until it no longer does.',
          },
          files: ref('FileHandoff'),
        },
        ['action'],
      ),
      closed(
        'Opens another view.',
        {
          navigate: ref('ViewId'),
          params: ref('Input'),
          label: ref('Text'),
          when: ref('Conditions'),
        },
        ['navigate'],
      ),
      closed('Saves the form.', { save: { const: true }, label: ref('Text') }, ['save']),
    ],
  },
  Buttons: arrayOf(ref('Button'), 1),
  FileHandoff: closed("Stored files the caller hands the action's job (`$files`, ADR 0032).", {
    read: {
      ...ref('Value'),
      description: "File ids the job may read, or a `file` field's value (its files' ids).",
    },
    write: closed(
      'The one file the job may store.',
      { name: ref('Value'), maxBytes: ref('Value') },
      ['name'],
    ),
  }),
  ListView: kind(
    'list',
    'Rows of a collection.',
    {
      collection: ref('Name'),
      fields: ref('Fields'),
      filter: ref('Conditions'),
      sort: ref('Sort'),
      search: { type: 'boolean' },
      present: { enum: ['table', 'cards', 'feed'] },
      pageSize: { type: 'integer', minimum: 1, maximum: 500 },
      emphasisWhen: ref('Conditions'),
      selectable: { type: 'boolean' },
      rowActions: ref('Buttons'),
      bulkActions: ref('Buttons'),
      open: { ...ref('ViewId'), description: 'The view a row opens.' },
      create: { type: 'boolean', description: 'Offer a form to add a record.' },
      edit: { type: 'boolean', description: "Offer each row's form, to change it." },
      delete: { type: 'boolean', description: 'Offer to delete each row, after a confirm.' },
      realtime: { type: 'boolean' },
    },
    ['collection'],
  ),
  FormView: {
    description: 'A form binds a collection or an action, never both.',
    anyOf: [
      kind(
        'form',
        'Create or edit a record of a collection.',
        {
          collection: ref('Name'),
          record: {
            description: 'The record to edit; `singleton` for a one-row collection.',
            anyOf: [ref('Ref'), { const: 'singleton' }],
          },
          ...formProps,
        },
        ['collection'],
      ),
      kind(
        'form',
        "Fill an action's input; submitting runs the action.",
        { action: ref('ActionName'), ...formProps },
        ['action'],
      ),
    ],
  },
  DetailView: kind(
    'detail',
    'One record, in panels.',
    {
      collection: ref('Name'),
      record: ref('Ref'),
      fields: ref('Fields'),
      panels: arrayOf(ref('View'), 1),
      onOpen: closed(
        'Runs the action when a record is shown and meets `when`, once per record; its result is not shown.',
        { action: ref('ActionName'), input: ref('Input'), when: ref('Conditions') },
        ['action'],
      ),
    },
    ['collection', 'record'],
  ),
  BoardView: kind(
    'board',
    'Records grouped by a field (kanban).',
    {
      collection: ref('Name'),
      groupBy: ref('Name'),
      card: ref('Fields'),
      filter: ref('Conditions'),
      move: ref('Change'),
    },
    ['collection', 'groupBy'],
  ),
  TimelineView: kind(
    'timeline',
    'Records on a time axis (calendar, Gantt).',
    {
      collection: ref('Name'),
      start: ref('Name'),
      end: ref('Name'),
      groupBy: ref('Name'),
      scale: { enum: ['day', 'week', 'month', 'gantt'] },
      filter: ref('Conditions'),
      move: ref('Change'),
    },
    ['collection', 'start'],
  ),
  TreeView: kind(
    'tree',
    'Records linked to a parent.',
    {
      collection: ref('Name'),
      parent: ref('Name'),
      label: ref('Name'),
      order: ref('Name'),
      move: ref('Change'),
    },
    ['collection', 'parent', 'label'],
  ),
  MatrixView: kind(
    'matrix',
    'Rows by columns of a relation (checklists, grants).',
    {
      collection: ref('Name'),
      row: ref('Name'),
      column: ref('Name'),
      value: ref('Name'),
      edit: ref('Change'),
    },
    ['collection', 'row', 'column', 'value'],
  ),
  MapView: kind(
    'map',
    'Records with a location.',
    {
      collection: ref('Name'),
      location: ref('Name'),
      label: ref('Name'),
      filter: ref('Conditions'),
    },
    ['collection', 'location'],
  ),
  StatView: kind(
    'stat',
    'A number.',
    {
      source: {
        anyOf: [
          closed(
            'An aggregate over a collection.',
            {
              collection: ref('Name'),
              aggregate: { enum: ['count', 'sum', 'avg', 'min', 'max'] },
              field: ref('Name'),
              filter: ref('Conditions'),
            },
            ['collection', 'aggregate'],
          ),
          ref('ActionCall'),
        ],
      },
      format: { enum: ['number', 'money', 'progress', 'elapsed'] },
      tone: ref('Tone'),
    },
    ['source'],
  ),
  SplitView: kind(
    'split',
    'Panes side by side; a later pane filters on `$selected` of an earlier one.',
    { panes: arrayOf(ref('View'), 2) },
    ['panes'],
  ),
  TabsView: kind('tabs', 'Views as tabs.', { items: arrayOf(ref('View'), 1) }, ['items']),
  View: { anyOf: VIEW_KINDS.map(ref) },
  ActionResult: {
    description:
      'What an action returns, as a front end reads it (ADR 0042 decision 4). An object with `view`, `file` or `reveal` is one of the closed forms; anything else is values.',
    anyOf: [
      closed(
        'Opens a view (a navigation).',
        {
          view: ref('ViewId'),
          params: {
            type: 'object',
            description: 'The parameters it is opened with (`$param`).',
            additionalProperties: ref('Literal'),
          },
        },
        ['view'],
      ),
      closed('Draws this view (wizards, computed screens).', { view: ref('View') }, ['view']),
      closed('Hands the caller a stored file.', { file: { type: 'string', minLength: 1 } }, [
        'file',
      ]),
      closed(
        'Shows a value once (a key, a secret).',
        { reveal: { type: 'string', minLength: 1 } },
        ['reveal'],
      ),
      ref('ActionValues'),
    ],
  },
  ActionValues: {
    description:
      'Values: a scalar, a list, or an object without `view`, `file` or `reveal` (a form `recalc` merges an object of them).',
    anyOf: [
      { type: ['string', 'number', 'boolean', 'null'] },
      { type: 'array', items: {} },
      {
        type: 'object',
        properties: { view: { not: {} }, file: { not: {} }, reveal: { not: {} } },
      },
    ],
  },
};

/**
 * The top of a file: a view kind with `spec` required and `id` a `ViewId`
 * (what `navigate` and `open` name). Nested views carry neither.
 */
const asDocument = (s: Schema): Schema =>
  Array.isArray(s.anyOf)
    ? { ...s, anyOf: (s.anyOf as Schema[]).map(asDocument) }
    : {
        ...s,
        properties: {
          spec: { const: VIEW_SPEC },
          ...(s.properties as Schema),
          id: { ...ref('ViewId'), description: 'Names this file for `navigate` and `open`.' },
        },
        required: ['spec', ...((s.required ?? []) as string[])],
      };

export const VIEW_SCHEMA: Schema = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  $id: 'https://zveltio.com/schemas/view-2.schema.json',
  title: VIEW_SPEC,
  description:
    "An extension's view (ADR 0042): what a screen shows, bound by name to the extension's collections and actions. Each front end draws it in its own way.",
  anyOf: VIEW_KINDS.map((k) => asDocument(defs[k] as Schema)),
  $defs: defs,
};
