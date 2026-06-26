/**
 * SDUI (Server-Driven UI) page-schema spec.
 *
 * A declarative description of an extension Studio page. The host renders it
 * with trusted generic components (no per-extension code, no build toolchain,
 * no third-party JS in the admin). The vocabulary was derived empirically from
 * the real extension pages (see SPIKE-FINDINGS.md) and reduces to two
 * archetypes: list+form (`PageSchema`) and settings (`SettingsSchema`).
 *
 * Strings are i18n message keys (e.g. "crm.tab.contacts") resolved against the
 * host `m` bundle, OR plain literals — the resolver tries `m[key]()` first and
 * falls back to the literal, so a schema is both readable and i18n-ready.
 */

export type Dotted = string; // dot-path into a row object, e.g. "meta.total"

/** Current SDUI schema major version. The host renders a friendly error for a
 * higher major it doesn't understand, instead of silently mis-rendering. */
export const SDUI_SCHEMA_VERSION = 1;

export interface PageSchema {
  /** Schema major version (defaults to 1). */
  sduiSchema?: number;
  title: string;
  subtitle?: string;
  /** One entry → single view. Many → rendered as tabs. */
  resources: ResourceView[];
  /** "New" button in the page header; opens the active resource's form. */
  newLabel?: string;
}

export interface ResourceView {
  id: string;
  /** Tab label — omit when there is a single resource. */
  label?: string;
  /** Lucide icon name for the tab. */
  icon?: string;
  /** GET endpoint that returns the list. */
  dataSource: string;
  /** Where the array lives in the response: "data" | "declarations" | "". */
  dataPath?: Dotted;
  /** Where the total count lives, for pagination: "meta.total". */
  totalPath?: Dotted;
  search?: SearchDef;
  pagination?: { limit: number };
  /** Enum filter bar (e.g. e-Transport status tabs). */
  filters?: FilterDef[];
  /** KPI tiles above the table (e.g. invoicing invoiced/collected/overdue). */
  stats?: StatsBlock;
  /** "table" (default) or "cards" (a responsive card grid, e.g. api-connector
   * connections). Card content is driven by `card`. */
  layout?: 'table' | 'cards';
  /** Card-grid mapping (used when layout:'cards'): which row keys are the
   * title / badge / sub-text. rowActions still render in the card footer. */
  card?: { title: Dotted; badge?: Dotted; subtitle?: Dotted };
  columns: ColumnDef[];
  rowActions?: ActionDef[];
  form?: FormDef;
}

export interface StatsBlock {
  /** GET endpoint returning the stat object. */
  dataSource: string;
  /** Where the stat object lives in the response: "stats". */
  dataPath?: Dotted;
  cards: { label: string; key: Dotted; format?: 'number' | 'currency'; color?: string }[];
}

export interface SearchDef {
  /** Query param sent to the server, e.g. "search". Omit for client-side. */
  param?: string;
  /** Client-side filter across these row fields (when no server param). */
  fields?: string[];
  placeholder?: string;
}

export interface FilterDef {
  /** Query param the selected value is sent as. */
  param: string;
  options: { value: string; label: string }[];
}

export interface ColumnDef {
  key: Dotted;
  label: string;
  type?: 'text' | 'mono' | 'date' | 'currency' | 'badge' | 'relation' | 'boolean';
  /** Two-line cell: render this row key as muted sub-text (e.g. client email). */
  secondary?: Dotted;
  /** badge: map an enum value → DaisyUI badge class, and optional label map. */
  badge?: { colors: Record<string, string>; labels?: Record<string, string> };
  /** currency: where to read the currency code (row key) or a fixed code. */
  currency?: { codeKey?: Dotted; code?: string };
  /** join two row keys with an arrow, e.g. route "from → to". */
  join?: { keys: Dotted[]; sep?: string };
  /** Computed cell text from a template with "{ENGINE_URL}" + "{field}" tokens
   * (e.g. a webhook URL "{ENGINE_URL}/api/webhook/{slug}"). */
  template?: string;
  /** type:'relation' — resolve this id column to a label from another endpoint. */
  relation?: {
    dataSource: string;
    dataPath?: Dotted;
    valueKey?: Dotted;
    labelKey: Dotted | Dotted[];
  };
  /** Conditional cell CSS class (e.g. overdue date → text-error). First match wins. */
  classWhen?: { field?: Dotted; equals?: string; in?: string[]; class: string }[];
  /** Inline-editable cell: renders a control that PATCHes the row on change (e.g.
   * an order status dropdown). With `options` it's a <select>, else a text input.
   * `endpoint` "{id}" is substituted; the body is `{ [field ?? key]: newValue }`. */
  editable?: {
    endpoint: string;
    field?: Dotted;
    method?: 'PATCH' | 'POST';
    options?: { value: string; label: string }[];
  };
}

export interface ActionDef {
  id: string;
  label?: string;
  icon?: string;
  /** DaisyUI text/btn modifier, e.g. "text-error". */
  variant?: string;
  /** "edit" opens the form pre-filled; "download" opens the (cookie-authed)
   * endpoint in a new tab so the browser saves it via Content-Disposition (e.g.
   * SAF-T XML); otherwise call the endpoint. */
  kind?: 'edit' | 'call' | 'download';
  method?: 'POST' | 'PATCH' | 'DELETE';
  /** Endpoint template; "{id}" (and any other "{field}") is substituted from the row. */
  endpoint?: string;
  /** Show the action only when this row condition holds. */
  visibleWhen?: { field: Dotted; equals?: string; in?: string[] };
  /** i18n key / literal for a confirm dialog before the call. */
  confirm?: string;
  /** Request body, with "{field}" tokens substituted from the row. A token may
   * carry an arithmetic op: "{total-amount_paid}" → subtract. e.g.
   * { amount: "{total-amount_paid}" } for invoicing markPaid. */
  body?: Record<string, string>;
}

export interface FormDef {
  /** POST endpoint for create; PATCH "{id}" used for edit. For a non-default
   * `submit`, this is a template that may carry "{field}" path tokens (e.g.
   * "/ext/data/export/{collection}"); the named fields fill the path, the rest
   * become the querystring (download) or multipart body (upload). */
  endpoint: string;
  /** Non-default submit. "download": open the GET endpoint in a new tab (fields
   * → querystring) so the browser saves the file; "upload": POST multipart (the
   * file field + the other fields). Omit for the default create/edit JSON call. */
  submit?: { kind: 'download' | 'upload' };
  /** Visual groupings; fields not in a section render first, ungrouped. */
  sections?: { title: string; fields: FieldDef[] }[];
  fields?: FieldDef[];
  /** ESCAPE HATCH 1: a repeatable line-item group (e.g. e-Transport goods). */
  repeatable?: RepeatableDef;
  /** ESCAPE HATCH 2: computed fields (e.g. total weight = sum of line weights). */
  computed?: { name: string; label: string; sumOf?: { group: string; field: string } }[];
}

export interface RepeatableDef {
  name: string;
  label: string;
  addLabel: string;
  columns: FieldDef[];
  min?: number;
}

/**
 * Second archetype: a singleton settings/config page (NOT a list). GET one
 * config object, render a sectioned form, POST to save, plus page-level action
 * buttons (e.g. "Test connection"). Covers auth/ldap, auth/saml,
 * integrations/api-connector, mail account setup.
 */
export interface SettingsSchema {
  kind: 'settings';
  /** Schema major version (defaults to 1). */
  sduiSchema?: number;
  title: string;
  subtitle?: string;
  /** GET endpoint returning the config object. */
  dataSource: string;
  dataPath?: Dotted;
  /** POST endpoint to persist the config. */
  saveEndpoint: string;
  /** Read-only info rows shown above the form, each with a copy button (e.g. SP
   * metadata / ACS callback URLs). `value` may contain the "{ENGINE_URL}" token. */
  info?: { label: string; value: string; hint?: string }[];
  sections?: { title: string; fields: FieldDef[] }[];
  fields?: FieldDef[];
  /** Extra page-level actions, e.g. Test connection (posts the current config). */
  actions?: {
    id: string;
    label: string;
    icon?: string;
    method?: 'POST';
    endpoint: string;
    variant?: string;
  }[];
}

export interface FieldDef {
  name: string;
  label: string;
  type?:
    | 'text'
    | 'email'
    | 'tel'
    | 'number'
    | 'date'
    | 'select'
    | 'relation'
    | 'boolean'
    | 'password'
    | 'textarea'
    | 'file'
    | 'json';
  /** type:'file' — accept attribute, e.g. ".csv,.json". */
  accept?: string;
  /** Show this field only when another form field matches (e.g. auth_token when
   * auth_type === 'bearer'). */
  visibleWhen?: { field: string; equals?: string; in?: string[] };
  /** textarea: number of rows (default 4). */
  rows?: number;
  options?: { value: string; label: string }[];
  /** type: 'relation' — load options from another endpoint (foreign key). */
  relation?: {
    dataSource: string;
    dataPath?: Dotted;
    valueKey?: Dotted;
    labelKey: Dotted | Dotted[];
  };
  required?: boolean;
  colSpan?: 1 | 2;
  default?: unknown;
  placeholder?: string;
  mono?: boolean;
}
