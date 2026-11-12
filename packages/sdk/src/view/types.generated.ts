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

/** A data API condition on one field. */
export type Condition = {
  field: Name;
  op: 'eq' | 'neq' | 'lt' | 'lte' | 'gt' | 'gte' | 'like' | 'ilike' | 'not_contains' | 'starts_with' | 'ends_with' | 'in' | 'not_in' | 'null' | 'not_null' | 'near' | 'within';
  value?: Value;
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

/** Rows of a collection. */
export type ListView = {
  type: 'list';
  /** Set on the top-level view of a file. */
  spec?: 'zveltio.view/2';
  id?: PaneId;
  title?: Text;
  /** Toolbar actions of this view. */
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
  realtime?: boolean;
};

/** Create or edit a record of a collection, or fill an action's input. */
export type FormView = {
  type: 'form';
  /** Set on the top-level view of a file. */
  spec?: 'zveltio.view/2';
  id?: PaneId;
  title?: Text;
  /** Toolbar actions of this view. */
  actions?: Buttons;
  /** What a front end that does not know this view kind draws instead. */
  fallback?: View;
  collection?: Name;
  action?: ActionName;
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
};

/** One record, in panels. */
export type DetailView = {
  type: 'detail';
  /** Set on the top-level view of a file. */
  spec?: 'zveltio.view/2';
  id?: PaneId;
  title?: Text;
  /** Toolbar actions of this view. */
  actions?: Buttons;
  /** What a front end that does not know this view kind draws instead. */
  fallback?: View;
  collection: Name;
  record: Ref;
  fields?: Fields;
  panels?: View[];
};

/** Records grouped by a field (kanban). */
export type BoardView = {
  type: 'board';
  /** Set on the top-level view of a file. */
  spec?: 'zveltio.view/2';
  id?: PaneId;
  title?: Text;
  /** Toolbar actions of this view. */
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
  /** Set on the top-level view of a file. */
  spec?: 'zveltio.view/2';
  id?: PaneId;
  title?: Text;
  /** Toolbar actions of this view. */
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
  /** Set on the top-level view of a file. */
  spec?: 'zveltio.view/2';
  id?: PaneId;
  title?: Text;
  /** Toolbar actions of this view. */
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
  /** Set on the top-level view of a file. */
  spec?: 'zveltio.view/2';
  id?: PaneId;
  title?: Text;
  /** Toolbar actions of this view. */
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
  /** Set on the top-level view of a file. */
  spec?: 'zveltio.view/2';
  id?: PaneId;
  title?: Text;
  /** Toolbar actions of this view. */
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
  /** Set on the top-level view of a file. */
  spec?: 'zveltio.view/2';
  id?: PaneId;
  title?: Text;
  /** Toolbar actions of this view. */
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
  /** Set on the top-level view of a file. */
  spec?: 'zveltio.view/2';
  id?: PaneId;
  title?: Text;
  /** Toolbar actions of this view. */
  actions?: Buttons;
  /** What a front end that does not know this view kind draws instead. */
  fallback?: View;
  panes: View[];
};

/** Views as tabs. */
export type TabsView = {
  type: 'tabs';
  /** Set on the top-level view of a file. */
  spec?: 'zveltio.view/2';
  id?: PaneId;
  title?: Text;
  /** Toolbar actions of this view. */
  actions?: Buttons;
  /** What a front end that does not know this view kind draws instead. */
  fallback?: View;
  items: View[];
};

export type View = ListView | FormView | DetailView | BoardView | TimelineView | TreeView | MatrixView | MapView | StatView | SplitView | TabsView;
