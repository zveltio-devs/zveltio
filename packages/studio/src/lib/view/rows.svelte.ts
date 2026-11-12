/**
 * The records a board, timeline, tree, matrix or map draws: the data API's
 * list as the signed-in user, as `ViewList` reads it, read again when the
 * source's `version` moves (`host.version`: an action ran). Call it while a
 * component initialises.
 */
import type { SchemaField } from '@zveltio/sdk/view';
import { m } from '#lib/i18n.svelte.js';
import { listRecords, schemaOf } from './engine.js';

export type Row = Record<string, unknown> & { id: string };

export interface Rows {
  schema: SchemaField[];
  rows: Row[];
  total: number;
  loading: boolean;
  /** A reference in the filter has no value yet (no row selected). */
  waiting: boolean;
  error: string | null;
}

export function readRows(
  source: () => {
    collection: string;
    params: Record<string, string | number> | null;
    version: number;
  },
): Rows {
  const s = $state<Rows>({
    schema: [],
    rows: [],
    total: 0,
    loading: true,
    waiting: false,
    error: null,
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

  let seq = 0;
  $effect(() => {
    const { collection, params } = source();
    s.waiting = params === null;
    if (!params) return;
    const mine = ++seq;
    s.loading = true;
    listRecords(collection, params)
      .then((res) => {
        if (mine !== seq) return;
        s.rows = res.records as Row[];
        s.total = res.pagination?.total ?? s.rows.length;
        s.error = null;
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
