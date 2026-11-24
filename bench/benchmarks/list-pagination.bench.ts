/**
 * List + pagination benchmark.
 *
 * Seeds N rows, then measures three list patterns:
 *   1) Plain `?limit=20&page=1` — offset-style, common for "show first page".
 *   2) Deep page `?limit=20&page=N/20` — exercises OFFSET cost.
 *   3) Cursor `?limit=20&cursor=...` — checks our cursor path stays flat.
 *
 * The interesting comparison is (1) vs (2): if offset pagination degrades
 * linearly with depth, our docs need to surface cursor as the default for
 * large tables. The numbers themselves go into the JSON output.
 */

import { timedGet, timedPost } from '../lib/http.js';
import type { BenchHttpClient } from '../lib/http.js';
import { summarize, type SampleStats } from '../lib/stats.js';
import { createCollection, dropCollection, randomSuffix } from '../lib/setup.js';

export interface ListResult {
  collection: string;
  seedRows: number;
  iterations: number;
  firstPage: SampleStats;
  deepPage: SampleStats;
  cursor: SampleStats;
  /** Page number used for "deep" measurement (rows / pageSize). */
  deepPageNumber: number;
}

interface RunOptions {
  client: BenchHttpClient;
  warmup: number;
  iterations: number;
  seedRows?: number;
  pageSize?: number;
}

export async function runListPagination(opts: RunOptions): Promise<ListResult> {
  const { client, warmup, iterations } = opts;
  const seedRows = opts.seedRows ?? 5000;
  const pageSize = opts.pageSize ?? 20;
  const name = `bench_list_${randomSuffix()}`;

  await createCollection(client, name, [
    { name: 'title', type: 'text', required: true },
    { name: 'bucket', type: 'integer' },
  ]);

  try {
    // Seed via bulk endpoint to keep setup fast — we're not measuring inserts here.
    // 201 is the only success (a batch is all or nothing); anything else is a
    // real failure: surface the body so CI logs show the actual engine error
    // instead of a bare status code.
    const BATCH = 200;
    for (let offset = 0; offset < seedRows; offset += BATCH) {
      const records = Array.from({ length: Math.min(BATCH, seedRows - offset) }, (_, i) => ({
        title: `row-${offset + i}`,
        bucket: (offset + i) % 100,
      }));
      const res = await timedPost(client, `/api/data/${name}/bulk`, { records });
      if (res.status !== 201) {
        const bodyStr = res.body ? JSON.stringify(res.body).slice(0, 500) : '(no body)';
        throw new Error(`bulk seed batch at offset=${offset} returned ${res.status} — ${bodyStr}`);
      }
    }

    // An empty table would let the pages below pass any budget: count the seed.
    const seeded = await timedGet(client, `/api/data/${name}?page=1&limit=1`);
    const total = (seeded.body as { pagination?: { total?: number } } | undefined)?.pagination
      ?.total;
    if (total !== seedRows) throw new Error(`seeded ${total} of ${seedRows} rows`);

    const deepPageNumber = Math.max(1, Math.floor(seedRows / pageSize));

    // The engine caches an offset list for 10 s, keyed on the request URL
    // (lib/data/query-cache.ts). Repeating one URL would time Valkey, not the
    // query: every request carries a fresh `sample`, which the list ignores.
    let sample = 0;
    const fresh = () => `&sample=${sample++}`;

    // ── Page 1 ─────────────────────────────────────────────────────
    for (let i = 0; i < warmup; i++) {
      await timedGet(client, `/api/data/${name}?page=1&limit=${pageSize}${fresh()}`);
    }
    const firstPageSamples: number[] = [];
    const firstPageDuration = await measure(async () => {
      for (let i = 0; i < iterations; i++) {
        const r = await timedGet(client, `/api/data/${name}?page=1&limit=${pageSize}${fresh()}`);
        if (r.status !== 200) throw new Error(`firstPage returned ${r.status}`);
        firstPageSamples.push(r.durationMs);
      }
    });

    // ── Deep page (offset) ─────────────────────────────────────────
    for (let i = 0; i < warmup; i++) {
      await timedGet(
        client,
        `/api/data/${name}?page=${deepPageNumber}&limit=${pageSize}${fresh()}`,
      );
    }
    const deepPageSamples: number[] = [];
    const deepPageDuration = await measure(async () => {
      for (let i = 0; i < iterations; i++) {
        const r = await timedGet(
          client,
          `/api/data/${name}?page=${deepPageNumber}&limit=${pageSize}${fresh()}`,
        );
        if (r.status !== 200) throw new Error(`deepPage returned ${r.status}`);
        deepPageSamples.push(r.durationMs);
      }
    });

    // ── Cursor pagination ──────────────────────────────────────────
    // Walk forward, capturing each next-cursor and timing the request.
    const cursorSamples: number[] = [];
    const cursorDuration = await measure(async () => {
      let cursor: string | null = null;
      let followed = 0;
      let pageOneFirst: string | undefined;
      for (let i = 0; i < iterations; i++) {
        const q = cursor
          ? `?limit=${pageSize}&cursor=${encodeURIComponent(cursor)}`
          : `?limit=${pageSize}${fresh()}`;
        const r = await timedGet(client, `/api/data/${name}${q}`);
        if (r.status !== 200) throw new Error(`cursor returned ${r.status}`);
        cursorSamples.push(r.durationMs);
        // `{ records, pagination, next_cursor }` (lib/data/handlers/list.ts). A
        // missing key is a renamed contract: the walk would time page 1 forever.
        const body = r.body as
          | { records?: Array<{ id?: string }>; next_cursor?: string | null }
          | undefined;
        if (!body || !('next_cursor' in body))
          throw new Error('cursor: the list response carries no next_cursor');
        const first = body.records?.[0]?.id;
        if (!cursor) pageOneFirst = first;
        else if (first === pageOneFirst) throw new Error('cursor: a cursor served page 1 again');
        else followed++;
        cursor = body.next_cursor ?? null; // null: the rows ran out, restart
      }
      if (followed === 0) throw new Error('cursor: no request followed a cursor');
    });

    return {
      collection: name,
      seedRows,
      iterations,
      deepPageNumber,
      firstPage: summarize(firstPageSamples, firstPageDuration),
      deepPage: summarize(deepPageSamples, deepPageDuration),
      cursor: summarize(cursorSamples, cursorDuration),
    };
  } finally {
    await dropCollection(client, name).catch(() => undefined);
  }
}

async function measure(fn: () => Promise<void>): Promise<number> {
  const t0 = performance.now();
  await fn();
  return performance.now() - t0;
}
