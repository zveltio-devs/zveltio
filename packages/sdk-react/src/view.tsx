/**
 * A `view/2` renderer in React (ADR 0042 slice 6): the proof that a front end
 * written without Svelte, importing only the SDK, lists the extensions' pages
 * and draws their views.
 *
 * Two steps. `loadView` reads what a view shows (plain async TypeScript, so a
 * server renders the same HTML a browser does); `ViewRenderer` only draws what
 * was read. `ExtensionView` joins them for a browser: it reads again after a
 * selection or an action. Every call goes to the engine as the client's caller
 * (the data API, `POST /ext/<extension>/actions/<name>`); nothing an extension
 * wrote runs here and no URL comes from the view.
 *
 * Kinds drawn: list, detail, form, stat, split, tabs. Any other kind is drawn
 * through `fallbackFor` (its own `fallback`, else its collection's list), as
 * ADR 0042 decision 6 asks of a front end that does not know it. Not drawn yet,
 * as in Studio: a collection form's `lines`, `recalc` and `autosave`, a stat
 * other than `count`.
 */
import { type ReactNode, useEffect, useState } from 'react';
import type { ZveltioClient } from '@zveltio/sdk';
import {
  actionPath,
  type Button,
  type DetailView,
  type Fields,
  type FormView,
  fallbackFor,
  fieldName,
  isViewDocument,
  type ListView,
  matches,
  readActionResult,
  resolveFiles,
  resolveInput,
  resolveValue,
  type SchemaField,
  type StatView,
  toFilter,
  toSort,
  type View,
  type ViewScope,
  type ViewValidation,
  validateView,
  viewFields,
} from '@zveltio/sdk/view';
import { useZveltioClient } from './context.js';

type Row = Record<string, unknown>;

/** The kinds `ViewRenderer` draws itself. */
export const DRAWN: ReadonlySet<string> = new Set([
  'list',
  'detail',
  'form',
  'stat',
  'split',
  'tabs',
]);

export interface ExtensionPage {
  extension: string;
  path: string;
  label?: string;
  /** The page's view, checked against the specification; an invalid one is reported, not drawn. */
  view: ViewValidation;
}

interface ExtensionsAnswer {
  extensions?: string[];
  meta?: {
    name: string;
    studio?: {
      pages?: {
        path: string;
        label?: string;
        render?: string;
        surface?: string;
        schema?: unknown;
      }[];
    };
  }[];
}

/** The active extensions' `view/2` pages (`GET /api/extensions`), as Studio lists them. */
export async function extensionPages(client: ZveltioClient): Promise<ExtensionPage[]> {
  const r = await client.get<ExtensionsAnswer>('/api/extensions');
  const active = new Set(r.extensions ?? []);
  const out: ExtensionPage[] = [];
  for (const m of r.meta ?? []) {
    if (!active.has(m.name)) continue;
    for (const p of m.studio?.pages ?? []) {
      if (p.surface === 'app' || !isViewDocument(p.schema)) continue;
      out.push({ extension: m.name, path: p.path, label: p.label, view: validateView(p.schema) });
    }
  }
  return out;
}

export interface Column {
  name: string;
  label: string;
  type?: string;
}

/** What a view shows, read; the tree follows the view's. `from`: the kind it stands in for. */
export type Loaded = { from?: string } & (
  | { kind: 'list'; view: ListView; columns: Column[]; rows: Row[]; total?: number }
  | { kind: 'detail'; view: DetailView; columns: Column[]; record: Row | null; panels: Loaded[] }
  | { kind: 'form'; view: FormView; columns: Column[]; record: Row | null }
  | { kind: 'stat'; view: StatView; value: unknown }
  | { kind: 'split' | 'tabs'; view: View; children: Loaded[] }
  | { kind: 'notice'; view: View; text: string }
);

function columns(fields: Fields, schema: readonly SchemaField[]): Column[] {
  return fields.map((f) => {
    const name = fieldName(f);
    const label = (typeof f === 'object' && f.label) || name;
    return { name, label, type: schema.find((s) => s.name === name)?.type };
  });
}

/** JSON Schema `type` of an action input property, as a field type. */
const INPUT_TYPE: Record<string, string> = {
  number: 'number',
  integer: 'number',
  boolean: 'boolean',
};

/**
 * Reads what `view` shows, as the client's caller. A reference with no value
 * yet (no row selected in the pane it names) reads nothing; an engine refusal
 * throws `ZveltioApiError`.
 */
export async function loadView(
  client: ZveltioClient,
  extension: string,
  view: View,
  scope: ViewScope = {},
): Promise<Loaded> {
  let readable: Promise<Map<string, SchemaField[]>> | undefined;
  const schemaOf = async (c: string) => {
    readable ??= client
      .get<{ collections: { name: string; fields: SchemaField[] }[] }>('/api/data')
      .then((r) => new Map(r.collections.map((x) => [x.name, x.fields])));
    return (await readable).get(c) ?? [];
  };
  const run = async (action: string, input: Row) =>
    (await client.post<{ result?: unknown }>(actionPath(extension, action), input))?.result ?? null;

  const load = async (v: View, s: ViewScope): Promise<Loaded> => {
    if (!DRAWN.has(v.type)) {
      const f = fallbackFor(v, DRAWN);
      if (!f) return { kind: 'notice', view: v, text: `"${v.type}" is not drawn here` };
      return { ...(await load(f, s)), from: v.type };
    }
    switch (v.type) {
      case 'split':
        return {
          kind: 'split',
          view: v,
          children: await Promise.all(v.panes.map((p) => load(p, s))),
        };
      case 'tabs':
        return {
          kind: 'tabs',
          view: v,
          children: await Promise.all(v.items.map((p) => load(p, s))),
        };
      case 'list': {
        const schema = await schemaOf(v.collection);
        const cols = columns(viewFields(v.fields, schema, 'list'), schema);
        const filter = toFilter(v.filter, s);
        if (!filter) return { kind: 'list', view: v, columns: cols, rows: [] };
        const r = await client
          .collection(v.collection)
          .list({ limit: v.pageSize ?? 25, filter, ...toSort(v.sort) });
        return {
          kind: 'list',
          view: v,
          columns: cols,
          rows: r.records,
          total: r.pagination?.total,
        };
      }
      case 'detail': {
        const schema = await schemaOf(v.collection);
        const cols = columns(viewFields(v.fields, schema, 'detail'), schema);
        const id = resolveValue(v.record, s);
        const record = id == null ? null : await client.collection(v.collection).get(String(id));
        if (record && v.onOpen && matches(v.onOpen.when, record, s)) {
          const input = resolveInput(v.onOpen.input, { ...s, record });
          if (input) await run(v.onOpen.action, input);
        }
        const inner = { ...s, record: record ?? undefined };
        const panels = await Promise.all((v.panels ?? []).map((p) => load(p, inner)));
        return { kind: 'detail', view: v, columns: cols, record, panels };
      }
      case 'form': {
        if ('action' in v) {
          const { actions } = await client.actions.list();
          const dot = v.action.indexOf('.');
          const [ext, name] =
            dot < 0 ? [extension, v.action] : [v.action.slice(0, dot), v.action.slice(dot + 1)];
          const props = (actions.find((a) => a.extension === ext && a.name === name)?.input
            .properties ?? {}) as Record<string, { type?: string }>;
          const schema = Object.entries(props)
            .filter(([, p]) => p.type !== 'array' && p.type !== 'object')
            .map(([n, p]) => ({ name: n, type: INPUT_TYPE[p.type ?? ''] ?? 'text' }));
          const fields =
            v.fields ?? v.sections?.flatMap((x) => x.fields) ?? schema.map((f) => f.name);
          return { kind: 'form', view: v, columns: columns(fields, schema), record: null };
        }
        const schema = await schemaOf(v.collection);
        const fields = v.fields ?? v.sections?.flatMap((x) => x.fields);
        const cols = columns(viewFields(fields, schema, 'form'), schema);
        let record: Row | null = null;
        if (v.record === 'singleton') {
          record = (await client.collection(v.collection).list({ limit: 1 })).records[0] ?? null;
        } else if (v.record) {
          const id = resolveValue(v.record, s);
          if (id != null) record = await client.collection(v.collection).get(String(id));
        }
        return { kind: 'form', view: v, columns: cols, record };
      }
      case 'stat': {
        const src = v.source;
        if ('action' in src) {
          const input = resolveInput(src.input, s);
          return { kind: 'stat', view: v, value: input ? await run(src.action, input) : null };
        }
        if (src.aggregate !== 'count') {
          return { kind: 'notice', view: v, text: `"${src.aggregate}" has no data API route` };
        }
        const filter = toFilter(src.filter, s);
        if (!filter) return { kind: 'stat', view: v, value: null };
        const r = await client.collection(src.collection).list({ limit: 1, filter });
        return { kind: 'stat', view: v, value: r.pagination?.total ?? null };
      }
      default:
        return { kind: 'notice', view: v, text: `"${v.type}" is not drawn here` };
    }
  };
  return load(view, scope);
}

/** What `ViewRenderer` asks of the page it is drawn in. */
export interface ViewHost {
  /** A message key of the extension, or literal text. */
  t: (s?: string) => string;
  /** The scope references read (`$param`, `$selected`, `$user`). */
  scope: ViewScope;
  /** Runs a button with this scope (`$record`, `$selection` filled in). */
  press: (b: Button, scope: ViewScope) => void;
  /** A row was chosen in the pane `pane` (a split's `$selected`). */
  select: (pane: string, row: Row) => void;
  /**
   * A form was sent: the values typed in, and the `submit` button that sent it
   * (a collection form saves first, then runs the button's action).
   */
  save: (node: Extract<Loaded, { kind: 'form' }>, values: Row, button?: Button) => void;
}

const shown = (v: unknown) =>
  v === null || v === undefined ? '' : typeof v === 'object' ? JSON.stringify(v) : String(v);

function Buttons({
  buttons,
  host,
  scope,
}: {
  buttons?: Button[];
  host: ViewHost;
  scope: ViewScope;
}) {
  const live = (buttons ?? []).filter(
    (b) => !('when' in b) || matches(b.when, scope.record ?? {}, scope),
  );
  if (!live.length) return null;
  return (
    <span className="zv-actions">
      {live.map((b, i) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: a view's own list, fixed for the view's lifetime
        <button key={i} type="button" onClick={() => host.press(b, scope)}>
          {host.t(b.label) || ('action' in b ? b.action : 'navigate' in b ? b.navigate : 'Save')}
        </button>
      ))}
    </span>
  );
}

/** Draws what `loadView` read. Pure: everything it does goes through `host`. */
export function ViewRenderer({ node, host }: { node: Loaded; host: ViewHost }): ReactNode {
  const { t } = host;
  const title = 'title' in node.view && node.view.title ? <h2>{t(node.view.title)}</h2> : null;
  const toolbar = 'actions' in node.view && node.view.actions && node.kind !== 'detail' && (
    <Buttons buttons={node.view.actions} host={host} scope={host.scope} />
  );
  const body = (() => {
    switch (node.kind) {
      case 'notice':
        return <p role="note">{node.text}</p>;
      case 'split':
        return (
          <div className="zv-split">
            {node.children.map((c, i) => (
              // biome-ignore lint/suspicious/noArrayIndexKey: a view's own list, fixed for the view's lifetime
              <ViewRenderer key={i} node={c} host={host} />
            ))}
          </div>
        );
      case 'tabs':
        return <Tabs node={node} host={host} />;
      case 'stat':
        return <output className="zv-stat">{shown(node.value)}</output>;
      case 'list': {
        const pane = node.view.id;
        return (
          <table className="zv-list">
            <thead>
              <tr>
                {node.columns.map((c) => (
                  <th key={c.name}>{t(c.label)}</th>
                ))}
                {node.view.rowActions && <th />}
              </tr>
            </thead>
            <tbody>
              {node.rows.map((row, i) => (
                <tr
                  key={String(row.id ?? i)}
                  onClick={pane ? () => host.select(pane, row) : undefined}
                  aria-selected={pane ? host.scope.selected?.[pane] === row.id : undefined}
                >
                  {node.columns.map((c) => (
                    <td key={c.name}>{shown(row[c.name])}</td>
                  ))}
                  {node.view.rowActions && (
                    <td>
                      <Buttons
                        buttons={node.view.rowActions}
                        host={host}
                        scope={{ ...host.scope, record: row }}
                      />
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        );
      }
      case 'detail': {
        if (!node.record) return <p role="note">—</p>;
        const scope = { ...host.scope, record: node.record };
        return (
          <section className="zv-detail">
            <Buttons buttons={node.view.actions} host={host} scope={scope} />
            <dl>
              {node.columns.map((c) => [
                <dt key={`t${c.name}`}>{t(c.label)}</dt>,
                <dd key={`d${c.name}`}>{shown(node.record?.[c.name])}</dd>,
              ])}
            </dl>
            {node.panels.map((p, i) => (
              // biome-ignore lint/suspicious/noArrayIndexKey: a view's own list, fixed for the view's lifetime
              <ViewRenderer key={i} node={p} host={{ ...host, scope }} />
            ))}
          </section>
        );
      }
      case 'form': {
        const scope = { ...host.scope, record: node.record ?? undefined };
        return (
          <form
            key={String(node.record?.id ?? 'new')}
            className="zv-form"
            onSubmit={(e) => {
              e.preventDefault();
              const data = new FormData(e.currentTarget);
              const values: Row = {};
              for (const c of node.columns) {
                values[c.name] =
                  c.type === 'boolean'
                    ? data.has(c.name)
                    : c.type === 'number'
                      ? data.get(c.name) === ''
                        ? null
                        : Number(data.get(c.name))
                      : data.get(c.name);
              }
              const at = (e.nativeEvent as SubmitEvent).submitter?.getAttribute('data-at');
              host.save(node, values, at ? node.view.submit?.[Number(at)] : undefined);
            }}
          >
            {node.columns.map((c) => (
              // biome-ignore lint/a11y/noLabelWithoutControl: the input is inside the label in both branches
              <label key={c.name}>
                {t(c.label)}
                {c.type === 'boolean' ? (
                  <input
                    type="checkbox"
                    name={c.name}
                    defaultChecked={node.record?.[c.name] === true}
                  />
                ) : (
                  <input
                    name={c.name}
                    type={c.type === 'number' ? 'number' : 'text'}
                    defaultValue={shown(node.record?.[c.name])}
                  />
                )}
              </label>
            ))}
            {node.view.lines && <p role="note">lines are not drawn here</p>}
            {node.view.submit?.length ? (
              node.view.submit.map(
                (b, i) =>
                  (!('when' in b) || matches(b.when, scope.record ?? {}, scope)) && (
                    // biome-ignore lint/suspicious/noArrayIndexKey: a view's own list, fixed for the view's lifetime
                    <button key={i} type="submit" data-at={i}>
                      {t(b.label) || ('action' in b ? b.action : 'Save')}
                    </button>
                  ),
              )
            ) : (
              <button type="submit">Save</button>
            )}
          </form>
        );
      }
    }
  })();
  return (
    <div className={`zv-view zv-${node.kind}`} data-kind={node.from ?? node.kind}>
      {title}
      {toolbar}
      {body}
    </div>
  );
}

function Tabs({ node, host }: { node: Extract<Loaded, { children: Loaded[] }>; host: ViewHost }) {
  const [at, setAt] = useState(0);
  const tabs = node.view.type === 'tabs' ? node.view.items : [];
  return (
    <div className="zv-tabs">
      <div role="tablist">
        {tabs.map((v, i) => (
          <button
            // biome-ignore lint/suspicious/noArrayIndexKey: a view's own list, fixed for the view's lifetime
            key={i}
            type="button"
            role="tab"
            aria-selected={i === at}
            onClick={() => setAt(i)}
          >
            {host.t(v.title) || v.type}
          </button>
        ))}
      </div>
      {node.children[at] && <ViewRenderer node={node.children[at]} host={host} />}
    </div>
  );
}

export interface ExtensionViewProps {
  extension: string;
  view: View;
  /** `$param`. Read once: give the component a new `key` to open it with others. */
  params?: Row;
  /** `$user`. */
  user?: string;
  t?: (s?: string) => string;
  /** A `navigate` button or a `{ view: "<id>" }` result: the page that owns `id` opens it. */
  onNavigate?: (view: string, params: Row) => void;
}

const STALE = 'A value this action needs is not chosen yet.';

/** A view in a browser: read, drawn, and read again after a selection or an action. */
export function ExtensionView({
  extension,
  view,
  params = {},
  user,
  t,
  onNavigate,
}: ExtensionViewProps) {
  const client = useZveltioClient();
  const [scope, setScope] = useState<ViewScope>({ params, selected: {}, user });
  const [shownView, setShownView] = useState<View>(view);
  const [node, setNode] = useState<Loaded | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [version, setVersion] = useState(0);

  useEffect(() => {
    let live = true;
    // ponytail: the whole page reads again on any change; per-pane reads if pages grow large.
    loadView(client, extension, shownView, scope).then(
      (n) => live && setNode(n),
      (e: unknown) => live && setNote(e instanceof Error ? e.message : String(e)),
    );
    return () => {
      live = false;
    };
  }, [client, extension, shownView, scope, version]);

  const fail = (e: unknown) => setNote(e instanceof Error ? e.message : String(e));
  const act = async (result: unknown) => {
    const out = readActionResult(result);
    if (out.kind === 'navigate') onNavigate?.(out.view, out.params);
    else if (out.kind === 'view') setShownView(out.view);
    else if (out.kind === 'reveal') setNote(out.value);
    else if (out.kind === 'file') {
      const { url } = await client.get<{ url: string }>(
        `/api/storage/${encodeURIComponent(out.file)}/signed-url`,
      );
      window.open(url, '_blank', 'noopener');
    } else if (out.kind === 'invalid') setNote(out.issues.map((i) => i.message).join('; '));
    setVersion((n) => n + 1);
  };

  const host: ViewHost = {
    t: t ?? ((s) => s ?? ''),
    scope,
    select: (pane, row) => setScope((s) => ({ ...s, selected: { ...s.selected, [pane]: row.id } })),
    press: (b, s) => {
      setNote(null);
      if ('navigate' in b) {
        const p = resolveInput(b.params, s);
        if (p) onNavigate?.(b.navigate, p);
        return;
      }
      if ('save' in b) return;
      if (b.confirm && !window.confirm(host.t(b.confirm))) return;
      const input = resolveInput(b.input, s);
      const files = b.files ? resolveFiles(b.files, s) : undefined;
      if (!input || files === null) return setNote(STALE);
      for (const name of b.prompt ?? []) {
        const v = window.prompt(name);
        if (v === null) return;
        input[name] = v;
      }
      client
        .post<{ result?: unknown }>(
          actionPath(extension, b.action),
          files ? { ...input, $files: files } : input,
        )
        .then((r) => act(r?.result ?? null), fail);
    },
    save: (n, values, button) => {
      setNote(null);
      const v = n.view;
      if ('action' in v) {
        // An action form sends its values as the action's input.
        const name = button && 'action' in button ? button.action : v.action;
        client
          .post<{ result?: unknown }>(actionPath(extension, name), values)
          .then((r) => act(r?.result ?? null), fail);
        return;
      }
      const id = n.record?.id;
      const ref = client.collection(v.collection);
      (id != null ? ref.update(String(id), values) : ref.create(values)).then((saved: Row) => {
        setVersion((x) => x + 1);
        if (button && 'action' in button)
          host.press(button, { ...scope, record: { ...n.record, ...saved } });
      }, fail);
    },
  };

  return (
    <>
      {note && <p role="status">{note}</p>}
      {node ? <ViewRenderer node={node} host={host} /> : <p aria-busy="true" />}
    </>
  );
}
