// GENERATED from src/view/schema.ts by scripts/gen-view-spec.ts — do not edit.

/** A collection or field name. */
export type Name = string;

/** One of this extension's actions, or `<dependency>.<action>` for a dependency's (ADR 0014). */
export type ActionName = string;

/** The id of a view, e.g. `mail.compose`. */
export type ViewId = string;

/** The id of a view inside a container; `$selected` names it. */
export type PaneId = string;

/** A message key of the extension, or literal text. */
export type Text = string;

/** A semantic tone; each front end picks its colours. */
export type Tone = 'neutral' | 'info' | 'success' | 'warning' | 'danger' | 'muted';

/** A value the front end fills in. Nothing else is computed in a view. */
export type Ref = {
  $record: Name;
} | {
  $selected: PaneId;
} | {
  $selection: Name;
} | {
  $param: Name;
} | {
  $user: 'id';
} | {
  $today: true;
};

export type Literal = string | number | boolean | null;

export type Value = Literal | Ref | Array<Literal | Ref>;

/** An action's input, or a view's parameters, by name. */
export type Input = Record<string, Value>;

/** A data API condition on one field; its value is shaped by the operator. */
export type Condition = {
  field: Name;
  op: 'eq' | 'neq' | 'lt' | 'lte' | 'gt' | 'gte' | 'like' | 'ilike' | 'not_contains' | 'starts_with' | 'ends_with' | 'near' | 'within';
  value: Value;
} | {
  field: Name;
  op: 'in' | 'not_in';
  value: Array<Literal | Ref> | Ref;
} | {
  field: Name;
  op: 'null' | 'not_null';
};

/** All must hold. */
export type Conditions = Condition[];

/** A field, or several; `-field` sorts descending. */
export type Sort = string | string[];

/** A field by name; its type, label and editor come from the collection. */
export type Field = Name | {
  field: Name;
  label?: Text;
  display?: 'badge' | 'flag' | 'mono' | 'elapsed';
  /** A tone per value (enum fields). */
  tones?: Record<string, Tone>;
  readOnly?: boolean;
  /** The field shown instead while this one is empty. */
  fallback?: Name;
};

export type Fields = Field[];

/** Runs an action. */
export type ActionCall = {
  action: ActionName;
  input?: Input;
};

/** `patch` writes the record through the data API; or an action does it. */
export type Change = 'patch' | ActionCall;

export type Button = {
  action: ActionName;
  label?: Text;
  tone?: Tone;
  input?: Input;
  /** Input fields to ask for. */
  prompt?: Name[];
  confirm?: Text;
  when?: Conditions;
  /** While the record meets these, the work the action started is under way: the button is busy, and the front end reads the record again until it no longer does. */
  busyWhen?: Conditions;
  files?: FileHandoff;
} | {
  navigate: ViewId;
  params?: Input;
  label?: Text;
  when?: Conditions;
} | {
  save: true;
  label?: Text;
};

export type Buttons = Button[];

/** Stored files the caller hands the action's job (`$files`, ADR 0032). */
export type FileHandoff = {
  /** File ids the job may read, or a `file` field's value (its files' ids). */
  read?: Value;
  /** The one file the job may store. */
  write?: {
    name: Value;
    maxBytes?: Value;
  };
};

/** Rows of a collection. */
export type ListView = {
  type: 'list';
  id?: PaneId;
  title?: Text;
  /** Toolbar actions of this view; a detail's act on the record it shows (`$record`). */
  actions?: Buttons;
  /** What a front end that does not know this view kind draws instead. */
  fallback?: View;
  collection: Name;
  fields?: Fields;
  filter?: Conditions;
  sort?: Sort;
  search?: boolean;
  present?: 'table' | 'cards' | 'feed';
  pageSize?: number;
  emphasisWhen?: Conditions;
  selectable?: boolean;
  rowActions?: Buttons;
  bulkActions?: Buttons;
  /** The view a row opens. */
  open?: ViewId;
  /** Offer a form to add a record. */
  create?: boolean;
  /** Offer each row's form, to change it. */
  edit?: boolean;
  /** Offer to delete each row, after a confirm. */
  delete?: boolean;
  realtime?: boolean;
};

/** A form binds a collection or an action, never both. */
export type FormView = {
  type: 'form';
  id?: PaneId;
  title?: Text;
  /** Toolbar actions of this view; a detail's act on the record it shows (`$record`). */
  actions?: Buttons;
  /** What a front end that does not know this view kind draws instead. */
  fallback?: View;
  collection: Name;
  /** The record to edit; `singleton` for a one-row collection. */
  record?: Ref | 'singleton';
  fields?: Fields;
  sections?: Array<{
    title?: Text;
    fields: Fields;
  }>;
  /** Line items: records of another collection pointing at this one. */
  lines?: {
    collection: Name;
    fk: Name;
    fields?: Fields;
    order?: Name;
  };
  submit?: Buttons;
  /** Recomputes values on the server. */
  recalc?: ActionCall;
  autosave?: boolean;
} | {
  type: 'form';
  id?: PaneId;
  title?: Text;
  /** Toolbar actions of this view; a detail's act on the record it shows (`$record`). */
  actions?: Buttons;
  /** What a front end that does not know this view kind draws instead. */
  fallback?: View;
  action: ActionName;
  fields?: Fields;
  sections?: Array<{
    title?: Text;
    fields: Fields;
  }>;
  /** Line items: records of another collection pointing at this one. */
  lines?: {
    collection: Name;
    fk: Name;
    fields?: Fields;
    order?: Name;
  };
  submit?: Buttons;
  /** Recomputes values on the server. */
  recalc?: ActionCall;
  autosave?: boolean;
};

/** One record, in panels. */
export type DetailView = {
  type: 'detail';
  id?: PaneId;
  title?: Text;
  /** Toolbar actions of this view; a detail's act on the record it shows (`$record`). */
  actions?: Buttons;
  /** What a front end that does not know this view kind draws instead. */
  fallback?: View;
  collection: Name;
  record: Ref;
  fields?: Fields;
  panels?: View[];
  /** Runs the action when a record is shown and meets `when`, once per record; its result is not shown. */
  onOpen?: {
    action: ActionName;
    input?: Input;
    when?: Conditions;
  };
};

/** Records grouped by a field (kanban). */
export type BoardView = {
  type: 'board';
  id?: PaneId;
  title?: Text;
  /** Toolbar actions of this view; a detail's act on the record it shows (`$record`). */
  actions?: Buttons;
  /** What a front end that does not know this view kind draws instead. */
  fallback?: View;
  collection: Name;
  groupBy: Name;
  card?: Fields;
  filter?: Conditions;
  move?: Change;
};

/** Records on a time axis (calendar, Gantt). */
export type TimelineView = {
  type: 'timeline';
  id?: PaneId;
  title?: Text;
  /** Toolbar actions of this view; a detail's act on the record it shows (`$record`). */
  actions?: Buttons;
  /** What a front end that does not know this view kind draws instead. */
  fallback?: View;
  collection: Name;
  start: Name;
  end?: Name;
  groupBy?: Name;
  scale?: 'day' | 'week' | 'month' | 'gantt';
  filter?: Conditions;
  move?: Change;
};

/** Records linked to a parent. */
export type TreeView = {
  type: 'tree';
  id?: PaneId;
  title?: Text;
  /** Toolbar actions of this view; a detail's act on the record it shows (`$record`). */
  actions?: Buttons;
  /** What a front end that does not know this view kind draws instead. */
  fallback?: View;
  collection: Name;
  parent: Name;
  label: Name;
  order?: Name;
  move?: Change;
};

/** Rows by columns of a relation (checklists, grants). */
export type MatrixView = {
  type: 'matrix';
  id?: PaneId;
  title?: Text;
  /** Toolbar actions of this view; a detail's act on the record it shows (`$record`). */
  actions?: Buttons;
  /** What a front end that does not know this view kind draws instead. */
  fallback?: View;
  collection: Name;
  row: Name;
  column: Name;
  value: Name;
  edit?: Change;
};

/** Records with a location. */
export type MapView = {
  type: 'map';
  id?: PaneId;
  title?: Text;
  /** Toolbar actions of this view; a detail's act on the record it shows (`$record`). */
  actions?: Buttons;
  /** What a front end that does not know this view kind draws instead. */
  fallback?: View;
  collection: Name;
  location: Name;
  label?: Name;
  filter?: Conditions;
};

/** A number. */
export type StatView = {
  type: 'stat';
  id?: PaneId;
  title?: Text;
  /** Toolbar actions of this view; a detail's act on the record it shows (`$record`). */
  actions?: Buttons;
  /** What a front end that does not know this view kind draws instead. */
  fallback?: View;
  source: {
    collection: Name;
    aggregate: 'count' | 'sum' | 'avg' | 'min' | 'max';
    field?: Name;
    filter?: Conditions;
  } | ActionCall;
  format?: 'number' | 'money' | 'progress' | 'elapsed';
  tone?: Tone;
};

/** Panes side by side; a later pane filters on `$selected` of an earlier one. */
export type SplitView = {
  type: 'split';
  id?: PaneId;
  title?: Text;
  /** Toolbar actions of this view; a detail's act on the record it shows (`$record`). */
  actions?: Buttons;
  /** What a front end that does not know this view kind draws instead. */
  fallback?: View;
  panes: View[];
};

/** Views as tabs. */
export type TabsView = {
  type: 'tabs';
  id?: PaneId;
  title?: Text;
  /** Toolbar actions of this view; a detail's act on the record it shows (`$record`). */
  actions?: Buttons;
  /** What a front end that does not know this view kind draws instead. */
  fallback?: View;
  items: View[];
};

export type View = ListView | FormView | DetailView | BoardView | TimelineView | TreeView | MatrixView | MapView | StatView | SplitView | TabsView;

/** What an action returns, as a front end reads it (ADR 0042 decision 4). An object with `view`, `file` or `reveal` is one of the closed forms; anything else is values. */
export type ActionResult = {
  view: ViewId;
  /** The parameters it is opened with (`$param`). */
  params?: Record<string, Literal>;
} | {
  view: View;
} | {
  file: string;
} | {
  reveal: string;
} | ActionValues;

/** Values: a scalar, a list, or an object without `view`, `file` or `reveal` (a form `recalc` merges an object of them). */
export type ActionValues = string | number | boolean | null | unknown[] | {
  view?: never;
  file?: never;
  reveal?: never;
  [key: string]: unknown;
};
