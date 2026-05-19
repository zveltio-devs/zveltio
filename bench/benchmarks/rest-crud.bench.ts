/**
 * REST CRUD benchmark — single-record operations against a fresh collection.
 *
 * For each phase (CREATE, GET, PATCH, DELETE) we run `warmup` throwaway
 * requests, then `iterations` measured ones. Each request is timed
 * independently with `performance.now()` so we get per-request latency
 * percentiles, not just an aggregate.
 *
 * Concurrency: 1 by default. Set BENCH_CONCURRENCY to N to fan out.
 */

import { timedGet, timedPost, timedPatch, timedDelete } from '../lib/http.js';
import type { BenchHttpClient } from '../lib/http.js';
import { summarize, type SampleStats } from '../lib/stats.js';
import { createCollection, dropCollection, randomSuffix } from '../lib/setup.js';

export interface CrudResult {
  collection: string;
  iterations: number;
  concurrency: number;
  create: SampleStats;
  get: SampleStats;
  patch: SampleStats;
  delete: SampleStats;
}

interface RunOptions {
  client: BenchHttpClient;
  warmup: number;
  iterations: number;
  concurrency: number;
}

export async function runRestCrud(opts: RunOptions): Promise<CrudResult> {
  const { client, warmup, iterations, concurrency } = opts;
  const name = `bench_crud_${randomSuffix()}`;
  await createCollection(client, name, [
    { name: 'title', type: 'text', required: true },
    { name: 'count', type: 'integer' },
  ]);

  const createSamples: number[] = [];
  const getSamples: number[] = [];
  const patchSamples: number[] = [];
  const deleteSamples: number[] = [];
  const ids: string[] = [];

  try {
    // ── CREATE ────────────────────────────────────────────────────
    // Warmup: create+discard ids so the measured set is clean.
    await runParallel(warmup, concurrency, async (i) => {
      await timedPost(client, `/api/data/${name}`, { title: `warmup-${i}`, count: i });
    });
    const createDuration = await measureWallClock(async () => {
      await runParallel(iterations, concurrency, async (i) => {
        const r = await timedPost(client, `/api/data/${name}`, { title: `row-${i}`, count: i });
        if (r.status !== 201) throw new Error(`create returned ${r.status}`);
        const id = (r.body as { id?: string })?.id;
        if (!id) throw new Error('create response missing id');
        ids.push(id);
        createSamples.push(r.durationMs);
      });
    });

    // ── GET (single record) ───────────────────────────────────────
    for (let i = 0; i < warmup; i++) {
      await timedGet(client, `/api/data/${name}/${ids[i % ids.length]}`);
    }
    const getDuration = await measureWallClock(async () => {
      await runParallel(iterations, concurrency, async (i) => {
        const r = await timedGet(client, `/api/data/${name}/${ids[i % ids.length]}`);
        if (r.status !== 200) throw new Error(`get returned ${r.status}`);
        getSamples.push(r.durationMs);
      });
    });

    // ── PATCH ─────────────────────────────────────────────────────
    for (let i = 0; i < warmup; i++) {
      await timedPatch(client, `/api/data/${name}/${ids[i % ids.length]}`, { count: i });
    }
    const patchDuration = await measureWallClock(async () => {
      await runParallel(iterations, concurrency, async (i) => {
        const r = await timedPatch(client, `/api/data/${name}/${ids[i % ids.length]}`, { count: i + 1000 });
        if (r.status !== 200) throw new Error(`patch returned ${r.status}`);
        patchSamples.push(r.durationMs);
      });
    });

    // ── DELETE ────────────────────────────────────────────────────
    // Delete is destructive — can't replay warmups, so use the tail of `ids`.
    const deleteTargets = ids.slice(0, iterations);
    const deleteDuration = await measureWallClock(async () => {
      await runParallel(deleteTargets.length, concurrency, async (i) => {
        const r = await timedDelete(client, `/api/data/${name}/${deleteTargets[i]}`);
        if (r.status !== 200 && r.status !== 204) throw new Error(`delete returned ${r.status}`);
        deleteSamples.push(r.durationMs);
      });
    });

    return {
      collection: name,
      iterations,
      concurrency,
      create: summarize(createSamples, createDuration),
      get: summarize(getSamples, getDuration),
      patch: summarize(patchSamples, patchDuration),
      delete: summarize(deleteSamples, deleteDuration),
    };
  } finally {
    await dropCollection(client, name).catch(() => undefined);
  }
}

/**
 * Run `total` tasks with at most `concurrency` in flight. We use a simple
 * worker-pool pattern: each worker pulls the next index off a shared counter
 * until the counter exceeds `total`. Avoids the burst-pattern of Promise.all
 * over a pre-built array.
 */
async function runParallel(
  total: number,
  concurrency: number,
  task: (index: number) => Promise<void>,
): Promise<void> {
  let cursor = 0;
  async function worker() {
    while (true) {
      const i = cursor++;
      if (i >= total) return;
      await task(i);
    }
  }
  const workers = Array.from({ length: Math.max(1, concurrency) }, worker);
  await Promise.all(workers);
}

async function measureWallClock(fn: () => Promise<void>): Promise<number> {
  const t0 = performance.now();
  await fn();
  return performance.now() - t0;
}
