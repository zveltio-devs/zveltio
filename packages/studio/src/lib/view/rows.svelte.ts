/**
 * The records a board, timeline, tree, matrix or map draws: the data API's
 * list as the signed-in user, as `ViewList` reads it, read again when the
 * source's `version` moves (`host.version`: an action ran). Call it while a
 * component initialises.
 *
 * A source is one query or several whose records are merged by id (the data
 * API has no OR: a timeline asks twice). Each query is read a page at a time;
 * `loadMore` reads the next page of every query that has one, only when the
 * reader asks. A re-read after an action keeps the pages already shown.
 */
import type { SchemaField } from '@zveltio/sdk/view';
import { m } from '#lib/i18n.svelte.js';
import { listRecords, schemaOf } from './engine.js';

export type Row = Record<string, unknown> & { id: string };
type Query = Record<string, string | number>;

export interface Rows {
  schema: SchemaField[];
  rows: Row[];
  /** All the records the queries match; more than `rows.length` while `more`. */
  total: number;
  /** A query has a page not read yet. */
  more: boolean;
  loading: boolean;
  /** A reference in the filter has no value yet (no row selected). */
  waiting: boolean;
  error: string | null;
  /** Reads the next page of every query that has one, and appends it. */
  loadMore: () => Promise<void>;
}

/** Records merged by id, first seen first: two queries may both match one. */
function merge(lists: Row[][]): Row[] {
  const seen = new Set<string>();
  const out: Row[] = [];
  for (const r of lists.flat()) {
    if (seen.has(r.id)) continue;
    seen.add(r.id);
    out.push(r);
  }
  return out;
}

async function readPage(collection: string, q: Query, page: number) {
  const res = await listRecords(collection, { ...q, page });
  const records = res.records as Row[];
  return { records, total: Number(res.pagination?.total ?? records.length) };
}

export function readRows(
  source: () => {
    collection: string;
    params: Query | Query[] | null;
    version: number;
  },
): Rows {
  // Per query: pages read, records read, the query's total.
  let at = { key: '', collection: '', queries: [] as Query[], pages: [] as number[] };
  let read: Row[][] = [];
  let totals: number[] = [];
  let seq = 0;
  let asked = '';

  const settle = () => {
    s.rows = merge(read);
    s.total = totals.reduce((a, b) => a + b, 0);
    s.more = read.some((r, i) => r.length < totals[i]);
    s.error = null;
  };

  const s = $state<Rows>({
    schema: [],
    rows: [],
    total: 0,
    more: false,
    loading: true,
    waiting: false,
    error: null,
    loadMore: async () => {
      const mine = seq;
      const { collection, queries } = at;
      const next = queries.map((_, i) => (read[i].length < totals[i] ? at.pages[i] + 1 : 0));
      if (!next.some(Boolean) || s.loading) return;
      s.loading = true;
      try {
        const pages = await Promise.all(
          queries.map((q, i) => (next[i] ? readPage(collection, q, next[i]) : null)),
        );
        // A re-read began meanwhile: it already counts the page asked for.
        if (mine !== seq) return;
        pages.forEach((p, i) => {
          if (!p) return;
          at.pages[i] = next[i];
          read[i] = [...read[i], ...p.records];
          // An empty page ends the query even if the total said more.
          totals[i] = p.records.length ? p.total : read[i].length;
        });
        settle();
      } catch (e) {
        if (mine === seq) s.error = (e as Error).message || m['ext.loadFailed']();
      } finally {
        if (mine === seq) s.loading = false;
      }
    },
  });

  // Its own derived: the schema is read once per collection, not per filter or version.
  const collection = $derived(source().collection);
  $effect(() => {
    schemaOf(collection).then(
      (f) => {
        s.schema = f;
      },
      (e: Error) => (s.error = e.message || m['ext.loadFailed']()),
    );
  });

  $effect(() => {
    const { collection, params, version } = source();
    s.waiting = params === null;
    if (!params) return;
    const queries = Array.isArray(params) ? params : [params];
    const key = JSON.stringify([collection, queries]);
    // The same question at the same version (a scope object made anew): already asked.
    if (`${key}#${version}` === asked) return;
    asked = `${key}#${version}`;
    // Another question starts at page 1; the same one read again keeps its pages.
    if (key !== at.key) at = { key, collection, queries, pages: queries.map(() => 1) };
    const pages = at.pages;
    const mine = ++seq;
    s.loading = true;
    Promise.all(
      queries.map(async (q, i) => {
        let records: Row[] = [];
        let total = 0;
        for (let p = 1; p <= pages[i]; p++) {
          const page = await readPage(collection, q, p);
          records = [...records, ...page.records];
          total = page.total;
          if (records.length >= total || page.records.length === 0) break;
        }
        return { records, total: Math.max(total, records.length) };
      }),
    )
      .then((res) => {
        if (mine !== seq) return;
        read = res.map((r) => r.records);
        totals = res.map((r) => r.total);
        settle();
      })
      .catch((e: Error) => {
        if (mine === seq) s.error = e.message || m['ext.loadFailed']();
      })
      .finally(() => {
        if (mine === seq) s.loading = false;
      });
  });

  return s;
}
